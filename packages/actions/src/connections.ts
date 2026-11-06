import { and, desc, eq } from "drizzle-orm";
import { newId, type ActionConnection, type ConnectionType, type SafeHttpClient } from "@ignitra/core";
import { decryptJson, encryptJson, type Keyring } from "@ignitra/core/server";
import { connections, type Database } from "@ignitra/db";
import { telegramCall } from "./actions/telegram";
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

export async function createConnection(
  db: Database,
  keyring: Keyring,
  input: { ownerId: string; type: ConnectionType; label: string; secret: Record<string, unknown>; metadata: Record<string, unknown> },
): Promise<PublicConnection> {
  const label = input.label.trim();
  if (label.length < 1 || label.length > 120) throw new ConnectionError("label must be 1-120 characters");
  const id = newId("connection");
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
