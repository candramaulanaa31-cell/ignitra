import { IgnitraSignatureError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

/**
 * IGNITRA signs every webhook (and every signed HTTP request) Stripe-style:
 *
 *   X-Ignitra-Timestamp:        <unix seconds>
 *   X-Ignitra-Signature:        v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *                               (several, comma-separated, while a secret rotates)
 *   X-Ignitra-Idempotency-Key:  <run key>:<step id>, identical on every retry
 *
 * Verification uses WebCrypto (`crypto.subtle.verify`, constant-time), so it runs in
 * Node 20+, Deno, Bun, browsers and edge runtimes alike.
 */

export const SIGNATURE_HEADER = "x-ignitra-signature";
export const TIMESTAMP_HEADER = "x-ignitra-timestamp";
export const IDEMPOTENCY_HEADER = "x-ignitra-idempotency-key";
export const EVENT_HEADER = "x-ignitra-event";
export const DELIVERY_HEADER = "x-ignitra-delivery";

const DEFAULT_TOLERANCE_SECONDS = 300;

/** A fetch `Headers`, or a plain object such as Node's `req.headers`. */
export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export function readHeader(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

const encoder = new TextEncoder();

type Subtle = (typeof globalThis.crypto)["subtle"];

function subtle(): Subtle {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("@ignitra/sdk: WebCrypto (globalThis.crypto.subtle) is not available in this runtime");
  return s;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function signedPayload(timestamp: number, rawBody: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`${timestamp}.`);
  const body = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

/**
 * True when the request was signed by IGNITRA with `secret` and is recent. Pass the body
 * exactly as received, before any JSON parsing: re-serialising changes the signed bytes.
 */
export async function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  headers: HeadersLike,
  secret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  const signature = readHeader(headers, SIGNATURE_HEADER);
  const timestamp = Number(readHeader(headers, TIMESTAMP_HEADER));
  if (!signature || !Number.isInteger(timestamp)) return false;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;

  const key = await subtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = signedPayload(timestamp, rawBody);
  for (const candidate of signature.split(",")) {
    const m = /^v1=([0-9a-f]{64})$/.exec(candidate.trim());
    if (m?.[1] && (await subtle().verify("HMAC", key, hexToBytes(m[1]), data))) return true;
  }
  return false;
}

/** Verifies, then parses. Throws `IgnitraSignatureError` when the signature does not hold. */
export async function parseWebhook(rawBody: string | Uint8Array, headers: HeadersLike, secret: string, options: { toleranceSeconds?: number; now?: number } = {}): Promise<WebhookEvent> {
  if (!(await verifyWebhookSignature(rawBody, headers, secret, options))) throw new IgnitraSignatureError();
  return JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody)) as WebhookEvent;
}

/** Signs a body the way IGNITRA does: for tests of your own receiver. */
export async function signWebhookPayload(rawBody: string | Uint8Array, secret: string, timestampSeconds: number): Promise<string> {
  const key = await subtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await subtle().sign("HMAC", key, signedPayload(timestampSeconds, rawBody)));
  return `v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
