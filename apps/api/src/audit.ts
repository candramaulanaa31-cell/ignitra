import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { apiKeys, auditLog, recordAudit, type AuditLogRow } from "@ignitra/db";
import { caller } from "./auth";
import type { ApiContext } from "./context";
import { clampLimit, iso, parse } from "./http";

/**
 * The account's audit log (Phase 9). Every change made through the API is recorded right after it
 * succeeds, with who made it (the wallet session or which API key) and from where. A failed write
 * is logged and never surfaced: the change itself already happened, and a retry would repeat it.
 *
 *   GET /v1/audit-log?limit=&before=    newest first; pass next_before as before for older entries
 */

export async function audit(ctx: ApiContext, req: FastifyRequest, action: string, target: { type: string; id?: string | null }, details: Record<string, unknown> = {}): Promise<void> {
  const me = caller(req);
  try {
    await recordAudit(ctx.db, {
      ownerId: me.userId,
      actor: me.via === "api_key" ? "api_key" : "session",
      actorId: me.via === "api_key" ? me.apiKeyId : null,
      action,
      targetType: target.type,
      targetId: target.id ?? null,
      details,
      ip: req.ip,
    });
  } catch (err) {
    ctx.logger.error({ err, action, targetId: target.id ?? null }, "audit log write failed");
  }
}

function entryView(row: AuditLogRow, keyPrefixes: ReadonlyMap<string, string>) {
  return {
    id: row.id,
    at: iso(row.createdAt),
    actor: row.actor === "api_key" && row.actorId ? { kind: row.actor, api_key_id: row.actorId, api_key_prefix: keyPrefixes.get(row.actorId) ?? null } : { kind: row.actor },
    action: row.action,
    target: { type: row.targetType, id: row.targetId },
    details: row.details,
    ip: row.ip,
  };
}

export function registerAuditRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/audit-log", async (req) => {
    const me = caller(req);
    const q = parse(z.object({ limit: z.string().optional(), before: z.string().regex(/^aud_[0-9a-z]{26}$/).optional() }), req.query);
    const limit = clampLimit(q.limit, 50, 200);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, me.userId), q.before ? lt(auditLog.id, q.before) : undefined))
      .orderBy(desc(auditLog.id))
      .limit(limit);
    const keyIds = [...new Set(rows.flatMap((r) => (r.actor === "api_key" && r.actorId ? [r.actorId] : [])))];
    const keys = keyIds.length > 0 ? await ctx.db.select({ id: apiKeys.id, prefix: apiKeys.prefix }).from(apiKeys).where(inArray(apiKeys.id, keyIds)) : [];
    const prefixes = new Map(keys.map((k) => [k.id, k.prefix]));
    return { data: rows.map((r) => entryView(r, prefixes)), next_before: rows.length === limit ? (rows.at(-1)?.id ?? null) : null };
  });
}
