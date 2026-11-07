import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { inboundHooks, type Database, type Tx } from "@ignitra/db";

/**
 * INBOUND_WEBHOOK URLs: `<API_PUBLIC_URL>/v1/hooks/<flow_id>/<token>`.
 *
 *   token = base64url(HMAC-SHA256(K, "<flow_id>:<salt>")),  K = HKDF(WEBHOOK_SIGNING_SECRET, "ignitra:inbound:v1")
 *
 * Nothing secret is stored (only the per-flow salt), so a database dump alone
 * cannot forge requests, the owner can see the URL again at any time, and
 * rotating the URL is just a new salt.
 */

function hookKey(master: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.from("ignitra:inbound:v1"), Buffer.alloc(0), 32));
}

export function inboundToken(master: string, flowId: string, salt: string): string {
  return createHmac("sha256", hookKey(master)).update(`${flowId}:${salt}`).digest("base64url");
}

export function verifyInboundToken(master: string, flowId: string, salt: string, token: string): boolean {
  const expected = Buffer.from(inboundToken(master, flowId, salt));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function inboundHookUrl(publicUrl: string, master: string, flowId: string, salt: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/v1/hooks/${flowId}/${inboundToken(master, flowId, salt)}`;
}

const newSalt = () => randomBytes(16).toString("base64url");

/** Creates the flow's hook salt if it has none (idempotent). */
export async function ensureInboundHook(db: Database | Tx, flowId: string): Promise<string> {
  await db.insert(inboundHooks).values({ flowId, salt: newSalt() }).onConflictDoNothing();
  const [row] = await db.select({ salt: inboundHooks.salt }).from(inboundHooks).where(eq(inboundHooks.flowId, flowId));
  if (!row) throw new Error(`inbound hook for ${flowId} could not be created`);
  return row.salt;
}

/** New salt: the old URL stops working immediately. */
export async function rotateInboundHook(db: Database, flowId: string): Promise<string> {
  const salt = newSalt();
  await db
    .insert(inboundHooks)
    .values({ flowId, salt })
    .onConflictDoUpdate({ target: inboundHooks.flowId, set: { salt, rotatedAt: sql`now()` } });
  return salt;
}

export async function inboundHookSalt(db: Database, flowId: string): Promise<string | null> {
  const [row] = await db.select({ salt: inboundHooks.salt }).from(inboundHooks).where(eq(inboundHooks.flowId, flowId));
  return row?.salt ?? null;
}
