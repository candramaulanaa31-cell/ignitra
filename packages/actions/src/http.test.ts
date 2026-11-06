import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpTransportError, SsrfBlockedError, createSafeHttp, isBlockedAddress, retryAfterMs, validateOutboundUrl } from "./http";
import { deriveOwnerSigningSecret, generateSigningSecret, signWebhook, verifyWebhookSignature } from "./signing";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8", // mapped — never legitimate in public DNS
    "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
    "2002:7f00:1::", // 6to4 wrapping 127.0.0.1
    "ff02::1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "149.154.167.220" /* api.telegram.org */, "2606:4700:4700::1111", "2a00:1450:4001:81c::200e"])("allows public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("validateOutboundUrl", () => {
  it.each([
    ["ftp://example.com/x", /scheme/],
    ["file:///etc/passwd", /scheme/],
    ["javascript:alert(1)", /scheme/],
    ["https://user:pass@example.com/", /credentials/],
    ["http://localhost:8080/", /internal hostname/],
    ["http://api.localhost/", /internal hostname/],
    ["http://metadata.google.internal/", /internal hostname/],
    ["http://127.0.0.1/", /private/],
    ["http://2130706433/", /private/], // decimal 127.0.0.1
    ["http://0x7f000001/", /private/], // hex 127.0.0.1
    ["http://017700000001/", /private/], // octal 127.0.0.1
    ["http://[::1]/", /private/],
    ["http://[::ffff:127.0.0.1]/", /private/],
    ["http://169.254.169.254/latest/meta-data/", /private/],
    ["not a url", /invalid URL/],
  ])("rejects %s", (url, reason) => {
    expect(() => validateOutboundUrl(url)).toThrow(SsrfBlockedError);
    expect(() => validateOutboundUrl(url)).toThrow(reason);
  });

  it("accepts public URLs, and http only when allowed", () => {
    expect(validateOutboundUrl("https://myapp.com/hook?x=1").host).toBe("myapp.com");
    expect(() => validateOutboundUrl("http://myapp.com/", { allowHttp: false })).toThrow(/scheme/);
    expect(validateOutboundUrl("http://127.0.0.1:3000/", { allowPrivate: true }).port).toBe("3000");
  });
});

describe("createSafeHttp", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest" });
        res.end();
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200);
        res.end("x".repeat(1_000_000));
        return;
      }
      if (req.url === "/hang") return; // never answers
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "x-multi": ["a", "b"] });
        res.end(JSON.stringify({ method: req.method, ua: req.headers["user-agent"], body }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("blocks private targets by default, before connecting", async () => {
    await expect(createSafeHttp().request({ url: `${base}/` })).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks hostnames that resolve to a private address — any of them", async () => {
    const http = createSafeHttp({ resolver: (_h, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]) });
    await expect(http.request({ url: "http://rebind.example/" })).rejects.toThrow(/resolves to a private or reserved address \(10\.0\.0\.7\)/);
  });

  it("pins the connection to the address it validated (DNS rebinding)", async () => {
    const port = (server.address() as AddressInfo).port;
    let lookups = 0;
    // First answer is what we validate AND connect to; a second resolution never happens.
    const http = createSafeHttp({
      allowPrivate: true,
      resolver: (_h, cb) => {
        lookups++;
        cb(null, [{ address: lookups === 1 ? "127.0.0.1" : "10.9.9.9", family: 4 }]);
      },
    });
    const res = await http.request({ url: `http://pinned.example:${port}/`, method: "POST", body: "hi" });
    expect(res.status).toBe(200);
    expect(lookups).toBe(1);
  });

  it("sends the request, flattens headers, never follows redirects", async () => {
    const http = createSafeHttp({ allowPrivate: true });
    const res = await http.request({ url: `${base}/echo`, method: "POST", body: "payload" });
    expect(JSON.parse(res.body)).toEqual({ method: "POST", ua: "Ignitra-Runner/0.1", body: "payload" });
    expect(res.headers["x-multi"]).toBe("a, b");
    const redirect = await http.request({ url: `${base}/redirect`, method: "GET" });
    expect(redirect.status).toBe(302);
  });

  it("bounds response size and time", async () => {
    const http = createSafeHttp({ allowPrivate: true, maxResponseBytes: 1024 });
    expect((await http.request({ url: `${base}/big`, method: "GET" })).body.length).toBe(1024);
    await expect(http.request({ url: `${base}/hang`, method: "GET", timeoutMs: 200 })).rejects.toBeInstanceOf(HttpTransportError);
  });

  it("parses Retry-After", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
    expect(retryAfterMs("garbage")).toBeUndefined();
    expect(retryAfterMs("999999")).toBe(3_600_000);
  });
});

describe("webhook signatures", () => {
  const secret = generateSigningSecret();
  const body = JSON.stringify({ type: "run.action", run_id: "run_1" });
  const now = Date.now();
  const ts = Math.floor(now / 1000);

  it("verifies a genuine delivery", () => {
    expect(verifyWebhookSignature({ secret, body, signature: signWebhook(secret, ts, body), timestamp: ts, now })).toBe(true);
  });

  it("rejects tampering, wrong secrets and replays", () => {
    const sig = signWebhook(secret, ts, body);
    expect(verifyWebhookSignature({ secret, body: body.replace("run_1", "run_2"), signature: sig, timestamp: ts, now })).toBe(false);
    expect(verifyWebhookSignature({ secret: generateSigningSecret(), body, signature: sig, timestamp: ts, now })).toBe(false);
    expect(verifyWebhookSignature({ secret, body, signature: sig, timestamp: ts, now: now + 10 * 60_000 })).toBe(false);
    expect(verifyWebhookSignature({ secret, body, signature: sig, timestamp: ts + 1, now })).toBe(false);
    expect(verifyWebhookSignature({ secret, body, signature: null, timestamp: ts, now })).toBe(false);
  });

  it("accepts any of several signatures (secret rotation)", () => {
    const old = generateSigningSecret();
    const header = `${signWebhook(old, ts, body)}, ${signWebhook(secret, ts, body)}`;
    expect(verifyWebhookSignature({ secret, body, signature: header, timestamp: ts, now })).toBe(true);
  });

  it("derives a stable, distinct secret per owner", () => {
    const master = "master-secret";
    expect(deriveOwnerSigningSecret(master, "usr_a")).toBe(deriveOwnerSigningSecret(master, "usr_a"));
    expect(deriveOwnerSigningSecret(master, "usr_a")).not.toBe(deriveOwnerSigningSecret(master, "usr_b"));
    expect(deriveOwnerSigningSecret("other", "usr_a")).not.toBe(deriveOwnerSigningSecret(master, "usr_a"));
    expect(deriveOwnerSigningSecret(master, "usr_a")).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  });
});
