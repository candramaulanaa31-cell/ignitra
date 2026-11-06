import { z } from "zod";
import { TemplateError, parseTemplate, type ActionDefinition, type SafeHttpClient } from "@ignitra/core";
import { HttpTransportError, SsrfBlockedError } from "../http";

/**
 * TELEGRAM — send a message with a bot to a chat (user, group, supergroup topic or channel).
 *
 *   { "connection_id": "conn_…", "text": "🔥 <b>New buy</b> {{trigger.amount_formatted}} {{trigger.token.symbol}}" }
 *
 * The connection holds the bot token (encrypted) and the chat id. In HTML mode
 * the template's own markup is kept and every substituted value is escaped, so
 * on-chain data (token names!) can never inject markup.
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "tg-spoiler", "span", "blockquote", "tg-emoji"]);

/** Static check of the template's literal markup against Telegram's HTML subset. */
export function checkTelegramHtml(template: string): string[] {
  let literal = "";
  try {
    for (const s of parseTemplate(template)) literal += "text" in s ? s.text : "x";
  } catch (err) {
    return [(err as TemplateError).message];
  }
  const issues: string[] = [];
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>|&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);|[<>&]/g;
  for (const m of literal.matchAll(re)) {
    if (m[2]) {
      const tag = m[2].toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        issues.push(`<${tag}> is not supported by Telegram (use b, i, u, s, a, code, pre, blockquote, tg-spoiler)`);
      } else if (m[1]) {
        if (stack.pop() !== tag) issues.push(`unexpected </${tag}>`);
      } else {
        stack.push(tag);
      }
    } else if (m[4]) {
      if (!/^(lt|gt|amp|quot|#\d+|#x[0-9a-fA-F]+)$/.test(m[4])) issues.push(`entity &${m[4]}; is not supported (use &lt; &gt; &amp; &quot;)`);
    } else {
      issues.push(`write "${m[0]}" as ${m[0] === "<" ? "&lt;" : m[0] === ">" ? "&gt;" : "&amp;"} in HTML mode (or use parse_mode "plain")`);
    }
  }
  for (const open of stack) issues.push(`<${open}> is never closed`);
  return [...new Set(issues)];
}

export const telegramParams = z
  .object({
    connection_id: z.string().regex(/^conn_[0-9a-z]{26}$/),
    text: z.string().min(1).max(4000),
    parse_mode: z.enum(["html", "plain"]).default("html"),
    disable_link_preview: z.boolean().default(true),
    silent: z.boolean().default(false),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.parse_mode === "html") {
      for (const issue of checkTelegramHtml(p.text)) ctx.addIssue({ code: "custom", path: ["text"], message: issue });
    } else {
      try {
        parseTemplate(p.text);
      } catch (err) {
        ctx.addIssue({ code: "custom", path: ["text"], message: (err as Error).message });
      }
    }
  });

export type TelegramParams = z.output<typeof telegramParams>;

const stripHtml = (s: string): string =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface TelegramResponse {
  ok?: boolean;
  result?: { message_id?: number; chat?: { id?: number | string }; username?: string; title?: string; type?: string };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export async function telegramCall(http: SafeHttpClient, apiBase: string, token: string, method: string, body: Record<string, unknown>) {
  const res = await http.request({
    url: `${apiBase.replace(/\/+$/, "")}/bot${token}/${method}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: TelegramResponse = {};
  try {
    json = JSON.parse(res.body) as TelegramResponse;
  } catch {
    // non-JSON (proxy error page)
  }
  return { status: res.status, json, durationMs: res.durationMs };
}

export function createTelegramAction(opts: { apiBase?: string } = {}): ActionDefinition<TelegramParams> {
  const apiBase = opts.apiBase ?? "https://api.telegram.org";
  return {
    type: "TELEGRAM",
    label: "Telegram",
    description: "Send a message with your Telegram bot to a chat, group, topic or channel.",
    connectionType: "telegram",
    paramsSchema: telegramParams,
    templates: (p) => [{ name: "text", template: p.text }],
    outputFields: [
      { path: "message_id", type: "number", description: "Telegram message id" },
      { path: "chat_id", type: "string", description: "Chat the message went to" },
    ],

    async execute(p, ctx) {
      const token = ctx.connection?.secret.bot_token;
      const chatId = ctx.connection?.metadata.chat_id;
      if (typeof token !== "string" || (typeof chatId !== "string" && typeof chatId !== "number")) {
        return { status: "failed", retryable: false, error: "telegram connection is missing its bot token or chat id" };
      }
      const html = p.parse_mode === "html";
      let text = ctx.render(p.text, html ? "html" : "none");
      let mode: "HTML" | undefined = html ? "HTML" : undefined;
      if (text.length > TELEGRAM_TEXT_LIMIT) {
        // Cutting HTML could break a tag; long messages go out as plain text instead.
        text = truncate(html ? stripHtml(text) : text, TELEGRAM_TEXT_LIMIT);
        mode = undefined;
      }
      const threadId = ctx.connection?.metadata.thread_id;
      const request = { method: "sendMessage", chat_id: String(chatId), chars: text.length, parse_mode: mode ?? "plain", text_preview: text.slice(0, 500) };
      try {
        const { status, json, durationMs } = await telegramCall(ctx.http, apiBase, token, "sendMessage", {
          chat_id: chatId,
          text,
          ...(mode ? { parse_mode: mode } : {}),
          link_preview_options: { is_disabled: p.disable_link_preview },
          disable_notification: p.silent,
          ...(typeof threadId === "number" ? { message_thread_id: threadId } : {}),
        });
        const response = { status, ok: json.ok ?? false, error_code: json.error_code ?? null, description: json.description ?? null, duration_ms: durationMs };
        if (json.ok && json.result?.message_id !== undefined) {
          return {
            status: "succeeded",
            httpStatus: status,
            output: { message_id: json.result.message_id, chat_id: String(json.result.chat?.id ?? chatId) },
            request,
            response,
          };
        }
        const description = json.description ?? `HTTP ${status}`;
        if (status === 429 || json.error_code === 429) {
          const after = json.parameters?.retry_after;
          return { status: "failed", httpStatus: status, retryable: true, error: `Telegram rate limit: ${description}`, ...(after ? { retryAfterMs: after * 1000 } : {}), request, response };
        }
        if (json.parameters?.migrate_to_chat_id) {
          return { status: "failed", httpStatus: status, retryable: false, error: `the group became a supergroup; update the connection's chat id to ${json.parameters.migrate_to_chat_id}`, request, response };
        }
        return { status: "failed", httpStatus: status, retryable: status >= 500 || status === 0, error: `Telegram: ${description}`, request, response };
      } catch (err) {
        if (err instanceof SsrfBlockedError) return { status: "failed", retryable: false, error: `blocked: ${err.message}`, request };
        if (err instanceof HttpTransportError) return { status: "failed", retryable: true, error: err.message, request };
        throw err;
      }
    },
  };
}
