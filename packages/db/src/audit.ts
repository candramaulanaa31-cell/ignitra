import { newId } from "@ignitra/core";
import type { Database } from "./client";
import { AUDIT_ACTORS, auditLog } from "./schema";

/**
 * One line of an account's audit log (Phase 9). Written right after the change it describes,
 * by the API (the owner's session or API key), the operator CLI, or the system (auto-pause).
 * `details` must never hold secrets: names, types, ids and which settings changed.
 */
export interface AuditEntry {
  readonly ownerId: string;
  readonly actor: (typeof AUDIT_ACTORS)[number];
  readonly actorId?: string | null;
  /** <target>.<verb>, e.g. flow.paused. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly details?: Record<string, unknown>;
  readonly ip?: string | null;
}

export async function recordAudit(db: Database, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    id: newId("audit"),
    ownerId: e.ownerId,
    actor: e.actor,
    actorId: e.actorId ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    details: e.details ?? {},
    ip: e.ip ?? null,
  });
}
