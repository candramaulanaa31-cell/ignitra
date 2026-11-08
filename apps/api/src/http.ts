import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

/** Errors with a stable machine code; the error handler renders them as `{ error: { code, message, … } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

/** Validates a request body / query with zod; 400 with every issue on failure. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new ApiError(400, "invalid_request", "request is invalid", {
    issues: result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

// ---- cookies -------------------------------------------------------------------

export function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
}

export function setCookie(reply: FastifyReply, name: string, value: string, opts: CookieOptions): void {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`, "HttpOnly", "SameSite=Lax"];
  if (opts.secure) attrs.push("Secure");
  reply.header("set-cookie", attrs.join("; "));
}

// ---- rate limiting ---------------------------------------------------------------

/**
 * Fixed-window counter per key (in memory, per process). Protects the public,
 * unauthenticated endpoints (nonce, verify, inbound hooks) from floods; it is
 * not an accounting mechanism (plan quotas are enforced from the database).
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Counts one hit; returns seconds to wait when over the limit, else 0. */
  take(key: string): number {
    const now = this.#now();
    if (this.#hits.size > 50_000) for (const [k, v] of this.#hits) if (v.resetAt <= now) this.#hits.delete(k);
    let entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.#windowMs };
      this.#hits.set(key, entry);
    }
    entry.count++;
    return entry.count > this.#limit ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }
}

/**
 * Token buckets per caller (API key, signed-in user, or client address for public routes),
 * refilled continuously, with `RateLimit-Limit / -Remaining / -Reset` on every answer and
 * `Retry-After` on a 429. In memory, per API process: N processes allow up to N× the rate.
 */
/** Failed deliveries (unknown hook or connection, bad token or signature) per sender address. */
export const RECEIVER_MISSES_PER_MINUTE = 120;

export class CallerLimiter {
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; at: number; rate: number }>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #bucket(key: string, perMinute: number): { tokens: number; at: number; rate: number } {
    const now = this.#now();
    if (this.#buckets.size > 100_000) {
      // Drop buckets that have refilled completely: they carry no state.
      for (const [k, b] of this.#buckets) if (b.tokens + ((now - b.at) / 60_000) * b.rate >= b.rate) this.#buckets.delete(k);
    }
    const b = this.#buckets.get(key) ?? { tokens: perMinute, at: now, rate: perMinute };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    b.rate = perMinute;
    this.#buckets.set(key, b);
    return b;
  }

  /**
   * A failure budget: `ensure` refuses (429) once `key` has spent it, and only `spend` uses it up.
   * Receivers charge unknown ids and bad signatures this way, so scanners are bounded while
   * genuine deliveries (one sender IP may serve many users) never are.
   */
  ensure(key: string, perMinute: number, reply: FastifyReply): void {
    const b = this.#bucket(key, perMinute);
    if (b.tokens >= 1) return;
    const wait = Math.max(1, Math.ceil(((1 - b.tokens) / perMinute) * 60));
    reply.header("retry-after", String(wait));
    throw new ApiError(429, "rate_limited", `too many failed requests from this address; retry in ${wait} s`);
  }

  spend(key: string, perMinute: number): void {
    const b = this.#bucket(key, perMinute);
    b.tokens = Math.max(0, b.tokens - 1);
  }

  enforce(key: string, perMinute: number, reply: FastifyReply): void {
    const b = this.#bucket(key, perMinute);
    reply.header("ratelimit-limit", String(perMinute));
    if (b.tokens < 1) {
      const wait = Math.max(1, Math.ceil(((1 - b.tokens) / perMinute) * 60));
      reply.header("ratelimit-remaining", "0");
      reply.header("ratelimit-reset", String(wait));
      reply.header("retry-after", String(wait));
      throw new ApiError(429, "rate_limited", `rate limit of ${perMinute} requests per minute reached; retry in ${wait} s`);
    }
    b.tokens -= 1;
    reply.header("ratelimit-remaining", String(Math.floor(b.tokens)));
    reply.header("ratelimit-reset", String(Math.ceil(((perMinute - b.tokens) / perMinute) * 60)));
  }
}

export function enforceRate(limiter: RateLimiter, key: string, reply: FastifyReply, what: string): void {
  const wait = limiter.take(key);
  if (wait > 0) {
    reply.header("retry-after", String(wait));
    throw new ApiError(429, "rate_limited", `too many ${what}; retry in ${wait} s`);
  }
}

// ---- pagination --------------------------------------------------------------------

export function clampLimit(raw: unknown, fallback = 50, max = 200): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : fallback;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
