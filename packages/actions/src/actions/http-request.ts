import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseTemplate, type ActionContext, type ActionDefinition, type ActionResult, type SafeHttpClient, type SafeHttpResponse } from "@ignitra/core";
import { HttpTransportError, SsrfBlockedError, retryAfterMs, validateOutboundUrl } from "../http";
import { WEBHOOK_HEADERS, signWebhook } from "../signing";

/**
 * HTTP_REQUEST — any method, headers and body, for APIs that are not IGNITRA
 * webhook receivers.
 *
 *   {
 *     "method": "POST",
 *     "url": "https://api.example.com/orders/{{trigger.body.order}}",
 *     "headers": [{ "name": "X-Source", "value": "ignitra" }],
 *     "body_type": "json",
 *     "body": "{ \"wallet\": \"{{trigger.to}}\", \"amount\": {{trigger.amount_decimal}} }"
 *   }
 *
 *  - JSON bodies: substituted values are JSON-escaped, and the rendered body must parse.
 *  - Secret headers (API keys) live in an `http` connection, bound to ONE host: a
 *    templated URL can never carry them anywhere else.
 *  - Every request carries X-Ignitra-Idempotency-Key (same on retries) and, unless
 *    `sign: false`, an X-Ignitra-Signature like webhooks.
 *  - Redirects are never followed; private networks are blocked (SSRF guard).
 */

const isTemplate = (v: string) => v.includes("{{");

const template = (max: number) =>
  z
    .string()
    .max(max)
    .superRefine((t, ctx) => {
      try {
        parseTemplate(t);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
      }
    });

/** Headers the runner sets itself, or that would break the request. */
const RESERVED = /^(host|content-length|connection|transfer-encoding|keep-alive|upgrade|te|trailer|proxy-.*|x-ignitra-.*)$/i;
/**
 * Credentials never go in step params (flow definitions are not encrypted and are
 * shown to the owner): they belong in an `http` connection, stored encrypted.
 */
const SENSITIVE = /(authorization|cookie|secret|token|password|passwd|api[-_]?key|auth)/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

const headerSchema = z
  .object({ name: z.string().regex(HEADER_NAME, { message: "invalid header name" }), value: template(2000) })
  .strict()
  .refine((h) => !RESERVED.test(h.name), { message: "this header is set by IGNITRA or not allowed" })
  .refine((h) => !SENSITIVE.test(h.name), { message: "secret headers belong in an HTTP connection (stored encrypted), not in the flow" });

/** Header values from templates: control characters would make the request invalid. */
const headerValue = (v: string) => v.replace(/[\x00-\x08\x0a-\x1f\x7f]+/g, " ").trim();

export const httpRequestParams = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
    url: template(2048).refine(
      (u) => {
        if (isTemplate(u)) return /^https?:\/\//i.test(u); // the scheme must be literal
        try {
          validateOutboundUrl(u, { allowPrivate: true });
          return true;
        } catch {
          return false;
        }
      },
      { message: "must be an http(s) URL without credentials (templates allowed after the scheme)" },
    ),
    headers: z.array(headerSchema).max(20).default([]),
    body_type: z.enum(["json", "text", "form", "none"]).default("json"),
    body: template(20_000).optional(),
    form: z.array(z.object({ name: z.string().min(1).max(200), value: template(2000) }).strict()).max(50).optional(),
    /** Secret headers (connection type `http`), only sent to the connection's host. */
    connection_id: z.string().regex(/^conn_[0-9a-z]{26}$/).optional(),
    /** Add X-Ignitra-Signature / X-Ignitra-Timestamp (owner secret, or the connection's). */
    sign: z.boolean().default(true),
  })
  .strict()
  .superRefine((p, ctx) => {
    const bodyless = p.method === "GET" || p.method === "DELETE";
    if (bodyless && ((p.body !== undefined && p.body_type !== "none") || p.form)) {
      ctx.addIssue({ code: "custom", path: ["body"], message: `${p.method} requests carry no body (set body_type "none")` });
    }
    if (p.body_type === "form" && !p.form) ctx.addIssue({ code: "custom", path: ["form"], message: 'body_type "form" needs form fields' });
    if ((p.body_type === "json" || p.body_type === "text") && !bodyless && p.body === undefined) {
      ctx.addIssue({ code: "custom", path: ["body"], message: `body_type "${p.body_type}" needs a body (or use "none")` });
    }
  });

export type HttpRequestParams = z.output<typeof httpRequestParams>;

const MAX_OUTPUT = 4096;

/** Response → step output (bounded): parsed JSON when it fits, else text. */
export function responseOutput(res: SafeHttpResponse): Record<string, unknown> {
  let body: unknown = res.body.slice(0, 1000);
  try {
    const json: unknown = JSON.parse(res.body);
    if (JSON.stringify(json).length <= MAX_OUTPUT) body = json;
  } catch {
    // keep text
  }
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "location", "etag", "x-request-id"]) if (res.headers[name]) headers[name] = res.headers[name] as string;
  return { status: res.status, headers, body };
}

/** HTTP status → step result, shared by HTTP-based actions. */
export function classifyResponse(res: SafeHttpResponse, request: Record<string, unknown>, what: string): ActionResult {
  const response = { status: res.status, duration_ms: res.durationMs, body: res.body.slice(0, 500) };
  if (res.status >= 200 && res.status < 300) return { status: "succeeded", httpStatus: res.status, output: responseOutput(res), request, response };
  if (res.status >= 300 && res.status < 400) {
    return { status: "failed", httpStatus: res.status, retryable: false, error: `redirects are not followed (HTTP ${res.status}); use the final URL`, request, response };
  }
  const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
  const after = retryAfterMs(res.headers["retry-after"]);
  return { status: "failed", httpStatus: res.status, retryable, error: `${what} answered HTTP ${res.status}`, ...(after !== undefined ? { retryAfterMs: after } : {}), request, response };
}

/** Network errors → step result (SSRF blocks are permanent, transport errors retryable). */
export function transportFailure(err: unknown, request: Record<string, unknown>): ActionResult {
  if (err instanceof SsrfBlockedError) return { status: "failed", retryable: false, error: `blocked: ${err.message}`, request };
  if (err instanceof HttpTransportError) return { status: "failed", retryable: true, error: err.message, request };
  throw err;
}

interface Secrets {
  readonly headers: ReadonlyArray<{ name: string; value: string }>;
  readonly host: string | null;
  readonly signingSecret: string | null;
}

function connectionSecrets(ctx: Pick<ActionContext, "connection">): Secrets | string {
  const c = ctx.connection;
  if (!c) return { headers: [], host: null, signingSecret: null };
  const headers = c.secret.headers;
  const host = c.metadata.host;
  if (!Array.isArray(headers) || typeof host !== "string") return "http connection is missing its headers or host";
  return {
    headers: headers.filter((h): h is { name: string; value: string } => typeof h?.name === "string" && typeof h?.value === "string"),
    host,
    signingSecret: typeof c.secret.signing_secret === "string" ? c.secret.signing_secret : null,
  };
}

export async function sendHttpRequest(http: SafeHttpClient, p: HttpRequestParams, ctx: ActionContext): Promise<ActionResult> {
  const secrets = connectionSecrets(ctx);
  if (typeof secrets === "string") return { status: "failed", retryable: false, error: secrets };

  const rawUrl = isTemplate(p.url) ? ctx.render(p.url) : p.url;
  let url: URL;
  try {
    url = validateOutboundUrl(rawUrl, { allowPrivate: true }); // private networks are re-checked (with DNS) by the client
  } catch (err) {
    return { status: "failed", retryable: false, error: `url: ${(err as Error).message}` };
  }
  if (secrets.host && url.host !== secrets.host) {
    return { status: "failed", retryable: false, error: `the connection's headers are only sent to ${secrets.host}, not ${url.host}` };
  }

  const headers: Record<string, string> = {};
  for (const h of p.headers) headers[h.name.toLowerCase()] = headerValue(ctx.render(h.value));
  for (const h of secrets.headers) headers[h.name.toLowerCase()] = h.value;

  let body: string | undefined;
  if (p.method !== "GET" && p.method !== "DELETE") {
    if (p.body_type === "json") {
      body = ctx.render(p.body ?? "", "json");
      try {
        JSON.parse(body);
      } catch {
        return { status: "failed", retryable: false, error: "the rendered body is not valid JSON (quote string values: \"{{trigger.from}}\")" };
      }
      headers["content-type"] ??= "application/json";
    } else if (p.body_type === "text") {
      body = ctx.render(p.body ?? "");
      headers["content-type"] ??= "text/plain; charset=utf-8";
    } else if (p.body_type === "form") {
      body = new URLSearchParams((p.form ?? []).map((f): [string, string] => [f.name, ctx.render(f.value)])).toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  headers[WEBHOOK_HEADERS.idempotencyKey] = ctx.idempotencyKey;
  headers[WEBHOOK_HEADERS.delivery] = randomUUID();
  if (ctx.isTest) headers["x-ignitra-test"] = "true";
  const secret = secrets.signingSecret ?? ctx.ownerSigningSecret;
  if (p.sign) {
    if (!secret) return { status: "failed", retryable: false, error: "sign: true needs WEBHOOK_SIGNING_SECRET on the runner (or sign: false)" };
    headers[WEBHOOK_HEADERS.timestamp] = String(timestamp);
    headers[WEBHOOK_HEADERS.signature] = signWebhook(secret, timestamp, body ?? "");
  }

  // Traces never include header values (they may be secrets) nor the full URL query.
  const request = {
    method: p.method,
    target: `${url.origin}${url.pathname}`,
    headers: Object.keys(headers).sort(),
    bytes: body ? Buffer.byteLength(body) : 0,
    ...(body ? { body_preview: body.slice(0, 500) } : {}),
  };
  try {
    const res = await http.request({ url: url.toString(), method: p.method, headers, ...(body !== undefined ? { body } : {}) });
    return classifyResponse(res, request, "the server");
  } catch (err) {
    return transportFailure(err, request);
  }
}

export const httpRequestAction: ActionDefinition<HttpRequestParams> = {
  type: "HTTP_REQUEST",
  label: "HTTP request",
  description: "Call any HTTP API: method, headers and a JSON, text or form body built from templates.",
  connectionType: "http",
  connectionOptional: true,
  paramsSchema: httpRequestParams,
  templates: (p) => [
    { name: "url", template: p.url },
    ...p.headers.map((h, i) => ({ name: `headers.${i}.value`, template: h.value })),
    ...(p.body !== undefined ? [{ name: "body", template: p.body }] : []),
    ...(p.form ?? []).map((f, i) => ({ name: `form.${i}.value`, template: f.value })),
  ],
  outputFields: [
    { path: "status", type: "number", description: "HTTP status of the response" },
    { path: "headers", type: "object", description: "Selected response headers (content-type, location, etag, x-request-id)" },
    { path: "body", type: "object", description: "Response body: parsed JSON (any path below it), or text" },
  ],
  execute: (p, ctx) => sendHttpRequest(ctx.http, p, ctx),
};
