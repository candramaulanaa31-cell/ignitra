import { createHmac, timingSafeEqual } from "node:crypto";
import type { SafeHttpClient } from "@ignitra/core";
import { ConnectionError } from "./connections";

/**
 * VIGIL (contract monitoring for Robinhood Chain) → IGNITRA, Phase 8.
 *
 * VIGIL signs every webhook:
 *   x-vigil-timestamp: <unix seconds>
 *   x-vigil-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *   x-vigil-delivery:  <delivery id> (at-least-once: the same id on a retry)
 * The secret is shown once, when the webhook is registered in VIGIL.
 */

const TOLERANCE_SECONDS = 300;

function header(headers: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? String(v[0]) : typeof v === "string" ? v : undefined;
}

/** True when VIGIL signed this raw body with `secret` within the last five minutes. */
export function verifyVigilSignature(rawBody: string, headers: Readonly<Record<string, unknown>>, secret: string, nowMs = Date.now()): boolean {
  const signature = header(headers, "x-vigil-signature");
  const timestamp = Number(header(headers, "x-vigil-timestamp"));
  if (!signature || !Number.isInteger(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`);
  const given = Buffer.from(signature.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** VIGIL's API base as its SDK takes it: the site followed by /api/v1, or the API itself followed by /v1. */
export function vigilApiBase(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  return /\/v1$/.test(u) ? u : `${u}/v1`;
}

/**
 * Registers IGNITRA's receiver URL as a webhook in the user's VIGIL account, with their API
 * key. The key is used for this one call and not stored; only the webhook's signing secret is.
 */
export async function registerVigilWebhook(http: SafeHttpClient, input: { apiUrl: string; apiKey: string; receiverUrl: string }): Promise<{ webhookId: string; secret: string }> {
  const base = vigilApiBase(input.apiUrl);
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    throw new ConnectionError("the VIGIL API URL is not a URL (e.g. https://vigil.example/api/v1)");
  }
  let res;
  try {
    res = await http.request({
      url: `${base}/webhooks`,
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url: input.receiverUrl, description: "IGNITRA: flows started by VIGIL alerts" }),
      timeoutMs: 15_000,
    });
  } catch (err) {
    throw new ConnectionError(`could not reach VIGIL at ${host}: ${(err as Error).message}`);
  }
  type VigilAnswer = { webhook_id?: unknown; secret?: unknown; message?: unknown; error?: unknown };
  let json: VigilAnswer | null = null;
  try {
    json = JSON.parse(res.body) as VigilAnswer;
  } catch {
    json = null;
  }
  if (res.status === 401 || res.status === 403) throw new ConnectionError("VIGIL refused the API key: create one in VIGIL under Settings → API keys");
  if (res.status >= 300) {
    const reason = typeof json?.message === "string" ? json.message : typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new ConnectionError(`VIGIL did not register the webhook: ${reason}`);
  }
  if (typeof json?.webhook_id !== "string" || typeof json.secret !== "string" || json.secret.length < 16) throw new ConnectionError("VIGIL answered without a webhook secret");
  return { webhookId: json.webhook_id, secret: json.secret };
}
