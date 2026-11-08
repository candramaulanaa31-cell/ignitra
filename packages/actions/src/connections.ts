import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { newId, type ActionConnection, type ConnectionType, type SafeHttpClient } from "@ignitra/core";
import { decryptJson, encryptJson, type Keyring } from "@ignitra/core/server";
import { connections, type Database } from "@ignitra/db";
import { telegramCall } from "./actions/telegram";
import { normalizeEmail, sendEmail, textToHtml, type EmailConfig } from "./email";
import { generateSigningSecret } from "./signing";
import { validateOutboundUrl } from "./http";

/**
 * Connections: credentials for external services (rule 9).
 * Secrets are encrypted with context `connection:<id>` (an envelope copied onto
 * another row cannot be decrypted) and are never part of a public view.
 */

export interface PublicConnection {
  readonly id: string;
  readonly ownerId: string;
  readonly type: string;
  readonly label: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

const context = (id: string) => `connection:${id}`;

const toPublic = (row: typeof connections.$inferSelect): PublicConnection => ({
  id: row.id,
  ownerId: row.ownerId,
  type: row.type,
  label: row.label,
  metadata: row.metadata,
  createdAt: row.createdAt,
});

/** A default label built from user data (chat titles, hosts, addresses) cut to the 120-character limit. */
export const fitLabel = (label: string): string => (label.length > 120 ? `${label.slice(0, 119)}…` : label);

export async function createConnection(
  db: Database,
  keyring: Keyring,
  input: { ownerId: string; type: ConnectionType; label: string; secret: Record<string, unknown>; metadata: Record<string, unknown>; id?: string },
): Promise<PublicConnection> {
  const label = input.label.trim();
  if (label.length < 1 || label.length > 120) throw new ConnectionError("label must be 1-120 characters");
  const id = input.id ?? newId("connection");
  const [row] = await db
    .insert(connections)
    .values({ id, ownerId: input.ownerId, type: input.type, label, secretEnc: encryptJson(keyring, input.secret, context(id)), metadata: input.metadata })
    .returning();
  if (!row) throw new ConnectionError("insert failed");
  return toPublic(row);
}

export async function listConnections(db: Database, ownerId?: string): Promise<PublicConnection[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(ownerId ? eq(connections.ownerId, ownerId) : undefined)
    .orderBy(desc(connections.createdAt));
  return rows.map(toPublic);
}

export async function getConnection(db: Database, id: string): Promise<PublicConnection | null> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id));
  return row ? toPublic(row) : null;
}

/** Decrypted, for execution only. */
export async function loadConnection(db: Database, keyring: Keyring, id: string): Promise<(ActionConnection & { ownerId: string }) | null> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id));
  if (!row) return null;
  const secret = decryptJson(keyring, row.secretEnc, context(row.id));
  if (secret === null || typeof secret !== "object") throw new ConnectionError(`connection ${id} secret is malformed`);
  return { id: row.id, ownerId: row.ownerId, type: row.type as ConnectionType, label: row.label, metadata: row.metadata, secret: secret as Record<string, unknown> };
}

/** Replaces metadata and (re-encrypted) secret of an owner's connection. */
async function updateConnection(db: Database, keyring: Keyring, id: string, values: { metadata: Record<string, unknown>; secret: Record<string, unknown> }): Promise<void> {
  await db
    .update(connections)
    .set({ metadata: values.metadata, secretEnc: encryptJson(keyring, values.secret, context(id)), updatedAt: sql`now()` })
    .where(eq(connections.id, id));
}

export async function deleteConnection(db: Database, id: string, ownerId: string): Promise<boolean> {
  const rows = await db.delete(connections).where(and(eq(connections.id, id), eq(connections.ownerId, ownerId))).returning({ id: connections.id });
  return rows.length > 0;
}

// ---- typed constructors -------------------------------------------------------

const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;

/**
 * Verifies a Telegram destination before it is saved: the token is a real bot
 * (getMe) and the bot can reach the chat (getChat). Returns what to store.
 */
export async function inspectTelegramDestination(
  http: SafeHttpClient,
  input: { token: string; chatId: string; threadId?: number; apiBase?: string },
): Promise<{ secret: Record<string, unknown>; metadata: Record<string, unknown> }> {
  const apiBase = input.apiBase ?? "https://api.telegram.org";
  if (!BOT_TOKEN.test(input.token)) throw new ConnectionError("that does not look like a bot token (expected 123456789:AA…) — get one from @BotFather");
  if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(input.chatId)) throw new ConnectionError("chat id must be numeric (e.g. -1001234567890) or a public @channelname");
  const me = await telegramCall(http, apiBase, input.token, "getMe", {});
  if (!me.json.ok) throw new ConnectionError(`Telegram rejected the token: ${me.json.description ?? `HTTP ${me.status}`}`);
  const chat = await telegramCall(http, apiBase, input.token, "getChat", { chat_id: input.chatId });
  if (!chat.json.ok) {
    throw new ConnectionError(`the bot cannot reach chat ${input.chatId}: ${chat.json.description ?? `HTTP ${chat.status}`} — add the bot to the group/channel (as admin for channels) and send it one message first`);
  }
  return {
    secret: { bot_token: input.token },
    metadata: {
      chat_id: input.chatId,
      chat_title: chat.json.result?.title ?? chat.json.result?.username ?? null,
      chat_type: chat.json.result?.type ?? null,
      bot_username: me.json.result?.username ?? null,
      ...(input.threadId !== undefined ? { thread_id: input.threadId } : {}),
    },
  };
}

/** A webhook connection gets its own signing secret — returned ONCE so the user can configure the receiver. */
export function webhookDestination(url: string, opts: { allowPrivate?: boolean } = {}): { secret: Record<string, unknown>; metadata: Record<string, unknown>; signingSecret: string } {
  const parsed = validateOutboundUrl(url, { allowPrivate: opts.allowPrivate ?? false });
  const signingSecret = generateSigningSecret();
  return { secret: { url: parsed.toString(), signing_secret: signingSecret }, metadata: { host: parsed.host }, signingSecret };
}

// ---- email: a recipient that confirmed a code ---------------------------------------

const CODE_TTL_MS = 30 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_AFTER_MS = 60_000;

const codeHash = (connectionId: string, code: string) => createHash("sha256").update(`${connectionId}:${code}`).digest("hex");

async function mailCode(http: SafeHttpClient, cfg: EmailConfig, connectionId: string, to: string, code: string): Promise<void> {
  const text = `Your IGNITRA verification code is ${code}\n\nEnter it in IGNITRA to receive flow emails at this address. It expires in 30 minutes.\nIf you did not ask for this, ignore this email: nothing will be sent to you.`;
  const { res } = await sendEmail(http, cfg, { to, subject: `IGNITRA verification code: ${code}`, text, html: textToHtml(text, "IGNITRA · onchain automation"), idempotencyKey: `verify:${connectionId}:${code}` });
  if (res.status < 200 || res.status >= 300) throw new ConnectionError(`could not send the verification email (provider answered HTTP ${res.status})`);
}

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Creates an UNVERIFIED email connection and mails it a 6-digit code. Flows can use it once verified. */
export async function startEmailConnection(
  db: Database,
  keyring: Keyring,
  http: SafeHttpClient,
  cfg: EmailConfig,
  input: { ownerId: string; address: string; label?: string; now?: number },
): Promise<PublicConnection> {
  const address = normalizeEmail(input.address);
  if (!address) throw new ConnectionError("that is not a valid email address");
  const now = input.now ?? Date.now();
  const code = newCode();
  const conn = await createConnection(db, keyring, {
    ownerId: input.ownerId,
    type: "email",
    label: input.label ?? fitLabel(`Email ${address}`),
    secret: {},
    metadata: { address, verified: false, code_sent_at: new Date(now).toISOString() },
  });
  await updateConnection(db, keyring, conn.id, {
    metadata: conn.metadata,
    secret: { code_hash: codeHash(conn.id, code), expires_at: now + CODE_TTL_MS, attempts: 0, sends: 1 },
  });
  try {
    await mailCode(http, cfg, conn.id, address, code);
  } catch (err) {
    await deleteConnection(db, conn.id, input.ownerId);
    throw err instanceof ConnectionError ? err : new ConnectionError(`could not send the verification email: ${(err as Error).message}`);
  }
  return conn;
}

export async function verifyEmailConnection(db: Database, keyring: Keyring, input: { id: string; ownerId: string; code: string; now?: number }): Promise<PublicConnection> {
  const now = input.now ?? Date.now();
  const conn = await loadConnection(db, keyring, input.id);
  if (!conn || conn.ownerId !== input.ownerId || conn.type !== "email") throw new ConnectionError("connection not found");
  if (conn.metadata.verified === true) return (await getConnection(db, input.id)) as PublicConnection;
  const s = conn.secret as { code_hash?: string; expires_at?: number; attempts?: number; sends?: number };
  if (typeof s.code_hash !== "string" || typeof s.expires_at !== "number") throw new ConnectionError("no code pending: request a new one");
  if (s.expires_at < now) throw new ConnectionError("the code expired: request a new one");
  if ((s.attempts ?? 0) >= MAX_CODE_ATTEMPTS) throw new ConnectionError("too many wrong codes: request a new one");
  const given = Buffer.from(codeHash(input.id, input.code.trim()));
  const expected = Buffer.from(s.code_hash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    await updateConnection(db, keyring, input.id, { metadata: { ...conn.metadata }, secret: { ...s, attempts: (s.attempts ?? 0) + 1 } });
    throw new ConnectionError(`wrong code (${MAX_CODE_ATTEMPTS - (s.attempts ?? 0) - 1} attempts left)`);
  }
  await updateConnection(db, keyring, input.id, {
    metadata: { address: conn.metadata.address, verified: true, verified_at: new Date(now).toISOString() },
    secret: {},
  });
  return (await getConnection(db, input.id)) as PublicConnection;
}

/**
 * Completes (or re-keys) a manual VIGIL connection: the user registered its receiver URL in VIGIL
 * themselves, and pastes the signing secret VIGIL showed them once. Until then, deliveries are
 * refused. (VIGIL makes the secret when the URL is registered, and that URL names this
 * connection: so the connection comes first, the secret second.)
 */
export async function setVigilSecret(db: Database, keyring: Keyring, input: { id: string; ownerId: string; secret: string; now?: number }): Promise<PublicConnection> {
  const conn = await loadConnection(db, keyring, input.id);
  if (!conn || conn.ownerId !== input.ownerId || conn.type !== "vigil") throw new ConnectionError("connection not found");
  if (conn.metadata.mode !== "manual") throw new ConnectionError("IGNITRA registered this receiver in VIGIL itself: its secret is already in place");
  const secret = input.secret.trim();
  if (secret.length < 16 || secret.length > 300) throw new ConnectionError("that does not look like VIGIL's signing secret");
  await updateConnection(db, keyring, input.id, {
    metadata: { ...conn.metadata, verified: true, verified_at: new Date(input.now ?? Date.now()).toISOString() },
    secret: { webhook_secret: secret },
  });
  return (await getConnection(db, input.id)) as PublicConnection;
}

export async function resendEmailCode(db: Database, keyring: Keyring, http: SafeHttpClient, cfg: EmailConfig, input: { id: string; ownerId: string; now?: number }): Promise<void> {
  const now = input.now ?? Date.now();
  const conn = await loadConnection(db, keyring, input.id);
  if (!conn || conn.ownerId !== input.ownerId || conn.type !== "email") throw new ConnectionError("connection not found");
  if (conn.metadata.verified === true) throw new ConnectionError("already verified");
  const sentAt = Date.parse(String(conn.metadata.code_sent_at ?? 0));
  const s = conn.secret as { sends?: number };
  if (Number.isFinite(sentAt) && now - sentAt < RESEND_AFTER_MS) throw new ConnectionError("wait a minute before requesting another code");
  if ((s.sends ?? 0) >= 5) throw new ConnectionError("too many codes sent to this address: delete the connection and start again later");
  const code = newCode();
  await updateConnection(db, keyring, input.id, {
    metadata: { ...conn.metadata, code_sent_at: new Date(now).toISOString() },
    secret: { code_hash: codeHash(input.id, code), expires_at: now + CODE_TTL_MS, attempts: 0, sends: (s.sends ?? 0) + 1 },
  });
  await mailCode(http, cfg, input.id, String(conn.metadata.address), code);
}

// ---- http: secret headers, only ever sent to one host -----------------------------------

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

export function httpDestination(input: { host: string; headers: ReadonlyArray<{ name: string; value: string }>; sign?: boolean }): { secret: Record<string, unknown>; metadata: Record<string, unknown>; signingSecret: string | null } {
  let host: string;
  try {
    host = new URL(input.host.includes("://") ? input.host : `https://${input.host}`).host;
  } catch {
    throw new ConnectionError("host must be a hostname like api.example.com");
  }
  if (!host || host.includes("@")) throw new ConnectionError("host must be a hostname like api.example.com");
  if (input.headers.length === 0 || input.headers.length > 10) throw new ConnectionError("add 1 to 10 headers");
  for (const h of input.headers) {
    if (!HEADER_NAME.test(h.name) || /^(host|content-length|x-ignitra-.*)$/i.test(h.name)) throw new ConnectionError(`header name "${h.name}" is not allowed`);
    if (h.value.length < 1 || h.value.length > 4000 || /[\r\n]/.test(h.value)) throw new ConnectionError(`header "${h.name}" needs a single-line value`);
  }
  const signingSecret = input.sign ? generateSigningSecret() : null;
  return {
    secret: { headers: input.headers.map((h) => ({ name: h.name, value: h.value })), ...(signingSecret ? { signing_secret: signingSecret } : {}) },
    metadata: { host, header_names: input.headers.map((h) => h.name) },
    signingSecret,
  };
}
