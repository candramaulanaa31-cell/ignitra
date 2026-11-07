import type { SafeHttpClient, SafeHttpResponse } from "@ignitra/core";

/**
 * Transactional email through Resend or Brevo (free tiers), sent from the
 * platform's address (EMAIL_FROM). Recipients must be VERIFIED email
 * connections (a code sent to the address), so IGNITRA can never be used to
 * mail arbitrary people.
 */

export interface EmailConfig {
  readonly provider: "resend" | "brevo";
  readonly apiKey: string;
  /** "IGNITRA <alerts@your-domain>" — a sender verified with the provider. */
  readonly from: string;
  /** Provider API base override (tests / stubs). */
  readonly apiBase?: string;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Same on every retry; Resend deduplicates on it for 24 h. */
  readonly idempotencyKey: string;
}

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

/** Normalized address (domain lowercased), or null when it is not a plain address. */
export function normalizeEmail(raw: string): string | null {
  const v = raw.trim();
  if (v.length > 254 || !ADDRESS.test(v)) return null;
  const at = v.lastIndexOf("@");
  return `${v.slice(0, at)}@${v.slice(at + 1).toLowerCase()}`;
}

function parseFrom(from: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (m?.[2]) return { ...(m[1] ? { name: m[1].replace(/^"|"$/g, "") } : {}), email: m[2] };
  return { email: from.trim() };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain-text body → minimal, safe HTML (escaped, line breaks kept, links not auto-generated). */
export function textToHtml(text: string, footer: string): string {
  const body = escapeHtml(text).replace(/\r?\n/g, "<br>");
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#18181b">${body}<hr style="border:0;border-top:1px solid #e4e4e1;margin:24px 0 8px"><p style="font-size:12px;color:#6b6b70">${escapeHtml(footer)}</p></body></html>`;
}

export async function sendEmail(http: SafeHttpClient, cfg: EmailConfig, msg: EmailMessage): Promise<{ res: SafeHttpResponse; messageId: string | null }> {
  let res: SafeHttpResponse;
  if (cfg.provider === "resend") {
    res = await http.request({
      url: `${(cfg.apiBase ?? "https://api.resend.com").replace(/\/+$/, "")}/emails`,
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", "idempotency-key": msg.idempotencyKey.slice(0, 256) },
      body: JSON.stringify({ from: cfg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
  } else {
    res = await http.request({
      url: `${(cfg.apiBase ?? "https://api.brevo.com").replace(/\/+$/, "")}/v3/smtp/email`,
      method: "POST",
      headers: { "api-key": cfg.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: parseFrom(cfg.from),
        to: [{ email: msg.to }],
        subject: msg.subject,
        textContent: msg.text,
        htmlContent: msg.html,
        headers: { "X-Ignitra-Idempotency-Key": msg.idempotencyKey },
      }),
    });
  }
  let messageId: string | null = null;
  try {
    const json = JSON.parse(res.body) as { id?: unknown; messageId?: unknown };
    const id = json.id ?? json.messageId;
    if (typeof id === "string") messageId = id;
  } catch {
    // not JSON
  }
  return { res, messageId };
}
