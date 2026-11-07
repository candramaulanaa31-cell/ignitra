import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionContext, ActionDefinition, ActionResult, SafeHttpClient } from "@ignitra/core";
import { HttpTransportError, SsrfBlockedError, retryAfterMs, validateOutboundUrl } from "../http";
import { WEBHOOK_HEADERS, signWebhook } from "../signing";

/**
 * WEBHOOK — POST a signed JSON envelope.
 *
 *   { "url": "https://myapp.com/hook" }        signed with the owner's derived secret
 *   { "connection_id": "conn_…" }              URL + secret stored encrypted in a connection
 *
 * The body is a fixed, documented envelope (custom bodies: HTTP_REQUEST, Phase 6).
 */
export const webhookParams = z
  .object({
    url: z
      .string()
      .max(2048)
      .refine((u) => {
        // Syntax only at save time; private-network blocking is enforced at request
        // time, where the runner configuration (OUTBOUND_ALLOW_PRIVATE) applies.
        try {
          validateOutboundUrl(u, { allowPrivate: true });
          return true;
        } catch {
          return false;
        }
      }, { message: "must be an http(s) URL without credentials" })
      .optional(),
    connection_id: z.string().regex(/^conn_[0-9a-z]{26}$/).optional(),
  })
  .strict()
  .refine((p) => (p.url === undefined) !== (p.connection_id === undefined), { message: "set exactly one of url or connection_id" });

export type WebhookParams = z.output<typeof webhookParams>;

export interface WebhookTarget {
  readonly url: string;
  readonly secret: string;
  /** Safe to store in traces (the URL of a connection may embed a token). */
  readonly label: string;
}

export function resolveWebhookTarget(p: WebhookParams, ctx: Pick<ActionContext, "connection" | "ownerSigningSecret">): WebhookTarget | string {
  if (p.connection_id) {
    const url = ctx.connection?.secret.url;
    const secret = ctx.connection?.secret.signing_secret;
    if (typeof url !== "string" || typeof secret !== "string") return "webhook connection is missing its url or signing secret";
    return { url, secret, label: `connection ${ctx.connection?.label ?? ""} (${new URL(url).host})` };
  }
  if (!ctx.ownerSigningSecret) return "WEBHOOK_SIGNING_SECRET is not configured on the runner";
  const url = new URL(p.url as string);
  return { url: url.toString(), secret: ctx.ownerSigningSecret, label: `${url.origin}${url.pathname}` };
}

/** Delivers one signed envelope and maps the outcome (shared by actions and run.reverted notices). */
export async function deliverWebhook(http: SafeHttpClient, target: WebhookTarget, event: string, idempotencyKey: string, envelope: Record<string, unknown>, opts: { test?: boolean } = {}): Promise<ActionResult> {
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const delivery = randomUUID();
  const request = { target: target.label, event, delivery, bytes: Buffer.byteLength(body) };
  try {
    const res = await http.request({
      url: target.url,
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.signature]: signWebhook(target.secret, timestamp, body),
        [WEBHOOK_HEADERS.idempotencyKey]: idempotencyKey,
        [WEBHOOK_HEADERS.delivery]: delivery,
        [WEBHOOK_HEADERS.event]: event,
        ...(opts.test ? { "x-ignitra-test": "true" } : {}),
      },
      body,
    });
    const response = { status: res.status, duration_ms: res.durationMs, body: res.body.slice(0, 500) };
    if (res.status >= 200 && res.status < 300) {
      // Exposed to later steps and stored in run_steps: keep it small.
      let parsed: unknown = res.body.slice(0, 1000);
      try {
        const json: unknown = JSON.parse(res.body);
        if (JSON.stringify(json).length <= 4096) parsed = json;
      } catch {
        // keep text
      }
      return { status: "succeeded", httpStatus: res.status, output: { status: res.status, body: parsed }, request, response };
    }
    if (res.status >= 300 && res.status < 400) {
      return { status: "failed", httpStatus: res.status, retryable: false, error: `redirects are not followed (HTTP ${res.status}); point the webhook at the final URL`, request, response };
    }
    const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
    const after = retryAfterMs(res.headers["retry-after"]);
    return {
      status: "failed",
      httpStatus: res.status,
      retryable,
      error: `receiver answered HTTP ${res.status}`,
      ...(after !== undefined ? { retryAfterMs: after } : {}),
      request,
      response,
    };
  } catch (err) {
    if (err instanceof SsrfBlockedError) return { status: "failed", retryable: false, error: `blocked: ${err.message}`, request };
    if (err instanceof HttpTransportError) return { status: "failed", retryable: true, error: err.message, request };
    throw err;
  }
}

export const webhookAction: ActionDefinition<WebhookParams> = {
  type: "WEBHOOK",
  label: "Webhook",
  description: "POST a signed JSON envelope (HMAC-SHA256) with the run's trigger data to your server.",
  connectionType: "webhook",
  connectionOptional: true,
  paramsSchema: webhookParams,
  templates: () => [],
  outputFields: [
    { path: "status", type: "number", description: "HTTP status returned by the receiver" },
    { path: "body", type: "object", description: "Response body (parsed JSON, or text)" },
  ],

  async execute(p, ctx) {
    const target = resolveWebhookTarget(p, ctx);
    if (typeof target === "string") return { status: "failed", retryable: false, error: target };
    return deliverWebhook(ctx.http, target, "run.action", ctx.idempotencyKey, {
      type: "run.action",
      run_id: ctx.runId,
      flow_id: ctx.flowId,
      flow: { id: ctx.flowId, name: ctx.flowName, version: ctx.flowVersion },
      step_id: ctx.stepId,
      idempotency_key: ctx.idempotencyKey,
      run_idempotency_key: ctx.runIdempotencyKey,
      test: ctx.isTest,
      attempt: ctx.attempt,
      trigger: ctx.trigger,
      sent_at: new Date().toISOString(),
    }, { test: ctx.isTest });
  },
};
