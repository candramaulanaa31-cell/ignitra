import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures (Stripe-style, replay-resistant):
 *
 *   X-Ignitra-Timestamp: <unix seconds>
 *   X-Ignitra-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *   X-Ignitra-Idempotency-Key: <run key>:<step id>   (identical on every retry)
 *
 * Receivers verify with `verifyWebhookSignature` (also shipped in @ignitra/sdk, Phase 8).
 */

export const WEBHOOK_HEADERS = {
  signature: "x-ignitra-signature",
  timestamp: "x-ignitra-timestamp",
  idempotencyKey: "x-ignitra-idempotency-key",
  delivery: "x-ignitra-delivery",
  event: "x-ignitra-event",
} as const;

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface VerifyInput {
  secret: string;
  body: string;
  signature: string | undefined | null;
  timestamp: string | number | undefined | null;
  /** Reject deliveries older/newer than this (replay protection). */
  toleranceSeconds?: number;
  now?: number;
}

export function verifyWebhookSignature(input: VerifyInput): boolean {
  if (!input.signature || input.timestamp === undefined || input.timestamp === null) return false;
  const ts = Number(input.timestamp);
  if (!Number.isInteger(ts)) return false;
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signWebhook(input.secret, ts, input.body));
  // Several comma-separated signatures may be sent during secret rotation.
  return input.signature.split(",").some((candidate) => {
    const given = Buffer.from(candidate.trim());
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Random secret for a webhook connection — shown to the user once, stored encrypted. */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/**
 * Per-owner secret for inline-URL webhooks, derived from WEBHOOK_SIGNING_SECRET
 * (HKDF) — nothing to store, different for every user, rotates with the master.
 */
export function deriveOwnerSigningSecret(master: string, ownerId: string): string {
  const key = hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.from("ignitra:webhook:v1"), Buffer.from(ownerId, "utf8"), 32);
  return `whsec_${Buffer.from(key).toString("base64url")}`;
}
