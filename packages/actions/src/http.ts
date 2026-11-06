import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { SafeHttpClient, SafeHttpRequest, SafeHttpResponse } from "@ignitra/core";

/**
 * Outbound HTTP with SSRF protection (rule 10). Every request from an action
 * goes through here.
 *
 *  - only http(s), no credentials in URLs, no `localhost`-style names
 *  - every address a hostname resolves to must be public; the connection is
 *    then PINNED to the validated address (DNS rebinding cannot swap it)
 *  - IP literals are checked directly (the URL parser canonicalizes tricks
 *    like http://2130706433/ → 127.0.0.1)
 *  - redirects are never followed (a 3xx could point inside the network)
 *  - bounded: timeout, response bytes read
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Network-level failure (timeout, reset, DNS). Usually worth a retry. */
export class HttpTransportError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "HttpTransportError";
    this.code = code;
  }
}

// Separate lists per family: Node matches IPv4 addresses against IPv6 rules in
// their IPv4-mapped form, so a single list with ::ffff:0:0/96 would block ALL IPv4.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped (never legitimately in public DNS)
  ["64:ff9b::", 96], // NAT64 — could wrap a private IPv4
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (incl. Teredo)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 — embeds IPv4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked6.addSubnet(net, prefix, "ipv6");
}

/** True for loopback, private, link-local, metadata, multicast, reserved and documentation ranges. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4 ? blocked4.check(address, "ipv4") : blocked6.check(address, "ipv6");
}

const BLOCKED_NAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.(localhost|local|internal|home\.arpa)$/i;

export interface OutboundUrlOptions {
  allowHttp?: boolean;
  allowPrivate?: boolean;
}

/** Static checks (no DNS). Use at save time and before every request. */
export function validateOutboundUrl(raw: string, opts: OutboundUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError("invalid URL");
  }
  const allowHttp = opts.allowHttp ?? true;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new SsrfBlockedError(`scheme ${url.protocol} is not allowed (use https)`);
  }
  if (url.username || url.password) throw new SsrfBlockedError("credentials in URLs are not allowed");
  if (url.port === "0") throw new SsrfBlockedError("port 0 is not allowed");
  if (!opts.allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) {
      if (isBlockedAddress(host)) throw new SsrfBlockedError(`${host} is a private or reserved address`);
    } else if (BLOCKED_NAMES.test(host)) {
      throw new SsrfBlockedError(`${host} is an internal hostname`);
    }
  }
  return url;
}

type Resolver = (hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (hostname, cb) => dnsLookup(hostname, { all: true, verbatim: true }, cb);

export interface SafeHttpOptions extends OutboundUrlOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  userAgent?: string;
  /** DNS resolver override (tests). */
  resolver?: Resolver;
}

export function createSafeHttp(opts: SafeHttpOptions = {}): SafeHttpClient {
  const allowPrivate = opts.allowPrivate ?? false;
  const resolver = opts.resolver ?? systemResolver;
  const maxBytes = opts.maxResponseBytes ?? 64 * 1024;
  const userAgent = opts.userAgent ?? "Ignitra-Runner/0.1";

  /** Resolves, validates EVERY address, then pins the connection to the first one. */
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    resolver(hostname, (err, addresses) => {
      if (err) return callback(err);
      if (addresses.length === 0) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }));
      if (!allowPrivate) {
        const bad = addresses.find((a) => isBlockedAddress(a.address));
        if (bad) return callback(new SsrfBlockedError(`${hostname} resolves to a private or reserved address (${bad.address})`));
      }
      const pinned = addresses[0] as LookupAddress;
      if (options.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    });
  };

  return {
    request(req: SafeHttpRequest): Promise<SafeHttpResponse> {
      let url: URL;
      try {
        url = validateOutboundUrl(req.url, { allowHttp: opts.allowHttp ?? true, allowPrivate });
      } catch (err) {
        return Promise.reject(err);
      }
      const timeoutMs = req.timeoutMs ?? opts.timeoutMs ?? 10_000;
      const lib = url.protocol === "https:" ? https : http;
      const started = performance.now();
      const body = req.body === undefined ? undefined : typeof req.body === "string" ? Buffer.from(req.body) : Buffer.from(req.body);
      const headers: Record<string, string> = { "user-agent": userAgent, ...req.headers };
      if (body) headers["content-length"] = String(body.length);

      return new Promise<SafeHttpResponse>((resolve, reject) => {
        const request = lib.request(
          url,
          { method: req.method ?? "POST", headers, lookup: lookup as never, signal: AbortSignal.timeout(timeoutMs), agent: false },
          (res) => {
            const chunks: Buffer[] = [];
            let received = 0;
            res.on("data", (chunk: Buffer) => {
              if (received >= maxBytes) return;
              chunks.push(chunk.subarray(0, maxBytes - received));
              received += chunk.length;
              if (received >= maxBytes) res.destroy(); // enough for a trace; never buffer unbounded bodies
            });
            const done = () => {
              const flat: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
              resolve({
                status: res.statusCode ?? 0,
                headers: flat,
                body: Buffer.concat(chunks).toString("utf8"),
                durationMs: Math.round(performance.now() - started),
              });
            };
            res.on("end", done);
            res.on("close", done); // destroyed early after maxBytes
            res.on("error", () => done());
          },
        );
        request.on("error", (err: NodeJS.ErrnoException) => {
          if (err instanceof SsrfBlockedError) return reject(err);
          if (err.name === "AbortError" || err.name === "TimeoutError") return reject(new HttpTransportError(`timeout after ${timeoutMs}ms`, "ETIMEDOUT"));
          reject(new HttpTransportError(`${err.code ?? "ERR"}: ${err.message}`, err.code ?? "ERR"));
        });
        if (body) request.write(body);
        request.end();
      });
    },
  };
}

/** Retry-After header (seconds or HTTP date) → ms, bounded to 1 h. */
export function retryAfterMs(header: string | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3_600_000) : undefined;
}
