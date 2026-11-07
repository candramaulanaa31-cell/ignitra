import { z } from "zod";
import { parseTemplate, type ActionDefinition } from "@ignitra/core";
import { sendEmail, textToHtml, type EmailConfig } from "../email";
import { classifyResponse, transportFailure } from "./http-request";

/**
 * EMAIL — a plain-text email (with a safe HTML twin) to a verified address.
 *
 *   { "connection_id": "conn_…", "subject": "Treasury below {{trigger.threshold}} ETH", "body": "Balance: {{trigger.balance_after_formatted}}" }
 *
 * The connection is an email address that confirmed a verification code, so
 * flows can only mail people who agreed to it. TEST runs prefix the subject.
 */

const template = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .superRefine((t, ctx) => {
      try {
        parseTemplate(t);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
      }
    });

export const emailParams = z
  .object({
    connection_id: z.string().regex(/^conn_[0-9a-z]{26}$/),
    subject: template(300),
    body: template(10_000),
  })
  .strict();

export type EmailParams = z.output<typeof emailParams>;

export function createEmailAction(cfg: EmailConfig | null): ActionDefinition<EmailParams> {
  return {
    type: "EMAIL",
    label: "Email",
    description: "Send an email to a verified address (yours or your team's).",
    connectionType: "email",
    paramsSchema: emailParams,
    templates: (p) => [
      { name: "subject", template: p.subject },
      { name: "body", template: p.body },
    ],
    outputFields: [
      { path: "message_id", type: "string", description: "Provider message id", nullable: true },
      { path: "to", type: "string", description: "Recipient address" },
    ],

    async execute(p, ctx) {
      if (!cfg) return { status: "failed", retryable: false, error: "email is not configured on this runner (EMAIL_PROVIDER / EMAIL_API_KEY / EMAIL_FROM)" };
      const to = ctx.connection?.metadata.address;
      if (typeof to !== "string") return { status: "failed", retryable: false, error: "email connection has no address" };
      if (ctx.connection?.metadata.verified !== true) return { status: "failed", retryable: false, error: `${to} is not verified yet` };
      const subject = `${ctx.isTest ? "[TEST] " : ""}${ctx.render(p.subject).replace(/[\r\n]+/g, " ").slice(0, 300)}`;
      const text = ctx.render(p.body);
      const footer = `Sent by IGNITRA · flow "${ctx.flowName}" · run ${ctx.runId}${ctx.isTest ? " · TEST run with sample data" : ""}`;
      const request = { provider: cfg.provider, to, subject, chars: text.length, text_preview: text.slice(0, 500) };
      try {
        const { res, messageId } = await sendEmail(ctx.http, cfg, { to, subject, text: `${text}\n\n--\n${footer}`, html: textToHtml(text, footer), idempotencyKey: ctx.idempotencyKey });
        const result = classifyResponse(res, request, `${cfg.provider}`);
        return result.status === "succeeded" ? { ...result, output: { message_id: messageId, to } } : result;
      } catch (err) {
        return transportFailure(err, request);
      }
    },
  };
}
