import { z } from "zod";
import { parseTemplate, type ActionDefinition } from "@ignitra/core";

/**
 * WEB_PUSH — browser / installed-PWA notification to the flow owner's devices.
 *
 *   { "title": "Whale sell", "body": "{{trigger.amount_formatted}} {{trigger.token.symbol}}", "url": "{{trigger.explorer_url}}" }
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

export const webPushParams = z
  .object({
    title: template(200),
    body: template(1000),
    url: template(1000).optional(),
    /** Notifications with the same tag replace each other on the device. */
    tag: z.string().max(64).optional(),
  })
  .strict();

export type WebPushParams = z.output<typeof webPushParams>;

export const webPushAction: ActionDefinition<WebPushParams> = {
  type: "WEB_PUSH",
  label: "Web Push",
  description: "Push notification to the flow owner's browsers and installed app.",
  connectionType: null,
  paramsSchema: webPushParams,
  templates: (p) => [
    { name: "title", template: p.title },
    { name: "body", template: p.body },
    ...(p.url ? [{ name: "url", template: p.url }] : []),
  ],
  outputFields: [
    { path: "delivered", type: "number", description: "Devices the notification reached" },
    { path: "subscriptions", type: "number", description: "Active subscriptions of the owner" },
  ],

  async execute(p, ctx) {
    if (!ctx.push) return { status: "failed", retryable: false, error: "Web Push is not configured on the runner (VAPID keys missing)" };
    const url = p.url ? ctx.render(p.url) : undefined;
    const message = {
      title: ctx.render(p.title),
      body: ctx.render(p.body),
      ...(url && /^https:\/\//.test(url) ? { url } : {}),
      tag: p.tag ?? ctx.flowId,
    };
    const result = await ctx.push.send(message);
    const output = { delivered: result.delivered, subscriptions: result.subscriptions, expired: result.expired, failed: result.failed };
    const trace = { request: { title: message.title.slice(0, 200), body_preview: message.body.slice(0, 500), ...(message.url ? { url: message.url } : {}) }, response: { ...output, errors: result.errors } };
    if (result.subscriptions === 0) return { status: "skipped", reason: "the flow owner has no active push subscriptions", ...trace };
    if (result.delivered > 0) return { status: "succeeded", output, ...trace };
    if (result.expired === result.subscriptions) return { status: "skipped", reason: "all of the owner's push subscriptions have expired", ...trace };
    return { status: "failed", retryable: result.retryable, error: result.errors.join("; ") || "push delivery failed", ...trace };
  },
};
