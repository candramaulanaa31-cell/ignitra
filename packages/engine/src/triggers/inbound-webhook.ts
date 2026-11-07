import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, type FieldSpec } from "@ignitra/core";
import type { JsonValue } from "@ignitra/chain";
import { timeFields } from "../evidence";
import type { InboundTriggerModule } from "../types";

/**
 * INBOUND_WEBHOOK — an HTTP POST to the flow's own signed URL
 * (`/v1/hooks/<flow_id>/<token>`, shown in the flow).
 *
 * The API accepts the request (JSON, form or text body, 64 KB max), stores it
 * in inbound_events and answers 202; the matcher turns it into a run like any
 * other trigger (conditions, hourly cap, plan limits). Senders may set an
 * `Idempotency-Key` header: a repeated key is accepted again but never runs twice.
 */
export const inboundWebhookParams = z.object({}).strict();
export type InboundWebhookParams = z.output<typeof inboundWebhookParams>;

const FIELDS: readonly FieldSpec[] = [
  { path: "request_id", type: "string", description: "Id of the accepted request (req_…)" },
  { path: "received_at", type: "timestamp", description: "When the API accepted it, ISO-8601 UTC" },
  { path: "idempotency_key", type: "string", description: "The sender's Idempotency-Key header", nullable: true },
  { path: "content_type", type: "string", description: "Request content type", nullable: true },
  { path: "bytes", type: "number", description: "Body size in bytes" },
  { path: "body", type: "object", description: "Parsed body: JSON, form fields, or { text } (any path below it, e.g. body.amount)" },
  { path: "query", type: "object", description: "Query-string parameters" },
  { path: "headers", type: "object", description: "Non-sensitive request headers (content-type, user-agent, x-*)" },
  ...CHAIN_EVIDENCE_FIELDS.filter((f) => f.path.startsWith("time.")),
];

export const inboundWebhookTrigger: InboundTriggerModule<InboundWebhookParams> = {
  type: "INBOUND_WEBHOOK",
  kind: "inbound",
  label: "Inbound webhook",
  description: "Your own URL: any service that can send an HTTP POST can start this flow.",
  source: "inbound",
  supportsFast: false,
  paramsSchema: inboundWebhookParams,
  fields: () => FIELDS,

  match(event) {
    return {
      kind: "match",
      key: `inbound:${event.dedupeKey}`,
      payload: {
        request_id: event.requestId,
        received_at: event.receivedAt.toISOString(),
        idempotency_key: event.idempotencyKey,
        content_type: event.contentType,
        bytes: event.bytes,
        body: event.body as JsonValue,
        query: { ...event.query },
        headers: { ...event.headers },
        time: timeFields(Math.floor(event.receivedAt.getTime() / 1000)),
      },
    };
  },
};
