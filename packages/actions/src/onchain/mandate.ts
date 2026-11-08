import { randomUUID } from "node:crypto";
import type { SafeHttpClient } from "@ignitra/core";
import { WEBHOOK_HEADERS, signWebhook } from "../signing";

/**
 * MANDATE: the policy engine an onchain action must pass before IGNITRA signs it (spec, Phase 8).
 * Fail-closed: only an explicit "allow" lets the transaction through.
 *
 * Request: POST <the mandate connection's URL>, signed like IGNITRA webhooks with the
 * connection's own secret (X-Ignitra-Signature: v1=HMAC-SHA256(secret, "<timestamp>.<raw body>")):
 *   {
 *     "type": "onchain.intent", "intent_id", "chain_id", "grant_id", "safe", "session_key",
 *     "to", "function", "selector", "args", "value_wei",
 *     "flow_id", "run_id", "step_id", "idempotency_key", "test", "sent_at"
 *   }
 * Answer: 200 { "decision": "allow" | "deny", "reason"?: string, "policy_id"?: string }
 *   allow       → IGNITRA signs and sends the transaction
 *   deny        → never sent; the step fails with MANDATE's reason and is not retried
 *   anything else (timeout, non-200, malformed JSON) → not sent; the step retries later
 * The idempotency key is the step's: MANDATE sees the same key when a step is retried.
 */

export interface MandateIntent {
  readonly chain_id: number;
  readonly grant_id: string;
  readonly safe: string;
  readonly session_key: string;
  readonly to: string;
  readonly function: string;
  readonly selector: string;
  readonly args: unknown[];
  readonly value_wei: string;
  readonly flow_id: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly idempotency_key: string;
  readonly test: boolean;
}

export type MandateDecision =
  | { readonly decision: "allow"; readonly reason: string | null; readonly policy_id: string | null; readonly status: number }
  | { readonly decision: "deny"; readonly reason: string; readonly policy_id: string | null; readonly status: number }
  | { readonly decision: "unavailable"; readonly reason: string; readonly status: number | null };

export async function askMandate(http: SafeHttpClient, target: { readonly url: string; readonly secret: string }, intent: MandateIntent, timeoutMs = 5000): Promise<MandateDecision> {
  const body = JSON.stringify({ type: "onchain.intent", intent_id: randomUUID(), ...intent, sent_at: new Date().toISOString() });
  const timestamp = Math.floor(Date.now() / 1000);
  let res;
  try {
    res = await http.request({
      url: target.url,
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.signature]: signWebhook(target.secret, timestamp, body),
        [WEBHOOK_HEADERS.idempotencyKey]: intent.idempotency_key,
        [WEBHOOK_HEADERS.event]: "onchain.intent",
        ...(intent.test ? { "x-ignitra-test": "true" } : {}),
      },
      body,
      timeoutMs,
    });
  } catch (err) {
    return { decision: "unavailable", reason: `MANDATE did not answer: ${(err as Error).message}`, status: null };
  }
  if (res.status !== 200) return { decision: "unavailable", reason: `MANDATE answered HTTP ${res.status}`, status: res.status };
  let answer: { decision?: unknown; reason?: unknown; policy_id?: unknown };
  try {
    answer = JSON.parse(res.body) as typeof answer;
  } catch {
    return { decision: "unavailable", reason: "MANDATE's answer is not JSON", status: res.status };
  }
  const reason = typeof answer.reason === "string" ? answer.reason.slice(0, 500) : null;
  const policy = typeof answer.policy_id === "string" ? answer.policy_id.slice(0, 200) : null;
  if (answer.decision === "allow") return { decision: "allow", reason, policy_id: policy, status: res.status };
  if (answer.decision === "deny") return { decision: "deny", reason: reason ?? "denied by policy", policy_id: policy, status: res.status };
  return { decision: "unavailable", reason: 'MANDATE\'s answer has no "decision" of "allow" or "deny"', status: res.status };
}
