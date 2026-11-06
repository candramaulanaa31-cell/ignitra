import { and, eq, inArray, sql } from "drizzle-orm";
import type { RunFinalStatus } from "@ignitra/core";
import { runs, type Database, type Run } from "@ignitra/db";

/**
 * The runs table IS the job queue (Postgres, no Redis).
 *
 *  claim    queued runs that are due — and `running` runs whose lease expired
 *           (their worker crashed) — using FOR UPDATE SKIP LOCKED, so any
 *           number of workers/processes never take the same run twice
 *  renew    extend the lease while a run executes
 *  requeue  back off: queued again with next_attempt_at
 *  finish   final status
 * Every state change after the claim checks `locked_by = me` (fencing): a
 * worker that lost its lease cannot overwrite the new owner's progress.
 */
export class RunQueue {
  readonly #db: Database;
  readonly owner: string;
  readonly leaseMs: number;
  readonly #lease: string;

  constructor(db: Database, opts: { owner: string; leaseMs?: number }) {
    this.#db = db;
    this.owner = opts.owner;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.#lease = `${this.leaseMs} milliseconds`;
  }

  async claim(limit: number): Promise<Run[]> {
    if (limit <= 0) return [];
    const claimed = (await this.#db.execute(sql`
      update runs
      set status = 'running',
          started_at = coalesce(started_at, now()),
          attempts = attempts + 1,
          locked_by = ${this.owner},
          lease_until = now() + ${this.#lease}::interval,
          next_attempt_at = null
      where id in (
        select id from runs
        where (status = 'queued' and (next_attempt_at is null or next_attempt_at <= now()))
           or (status = 'running' and lease_until < now())
        order by coalesce(next_attempt_at, created_at), id
        limit ${limit}
        for update skip locked
      )
      returning id`)) as unknown as { rows: Array<{ id: string }> };
    const ids = (claimed.rows ?? []).map((r) => r.id);
    if (ids.length === 0) return [];
    const rows = await this.#db.select().from(runs).where(inArray(runs.id, ids));
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Extends the lease; also reports whether the run's event was reorged out meanwhile. */
  async renew(runId: string): Promise<{ held: boolean; reverted: boolean }> {
    const rows = await this.#db
      .update(runs)
      .set({ leaseUntil: sql`now() + ${this.#lease}::interval` })
      .where(and(eq(runs.id, runId), eq(runs.lockedBy, this.owner), eq(runs.status, "running")))
      .returning({ revertedAt: runs.revertedAt });
    return { held: rows.length > 0, reverted: rows[0]?.revertedAt != null };
  }

  async requeue(runId: string, delayMs: number, reason: string): Promise<boolean> {
    const rows = await this.#db
      .update(runs)
      .set({
        status: "queued",
        statusReason: reason,
        nextAttemptAt: sql`now() + ${`${Math.max(0, Math.round(delayMs))} milliseconds`}::interval`,
        lockedBy: null,
        leaseUntil: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.lockedBy, this.owner)))
      .returning({ id: runs.id });
    return rows.length > 0;
  }

  /** Statement only — callers run it inside their own transaction with the stats update. */
  finishStatement(tx: Pick<Database, "update">, runId: string, status: RunFinalStatus, reason: string | null) {
    return tx
      .update(runs)
      .set({ status, statusReason: reason, finishedAt: sql`now()`, lockedBy: null, leaseUntil: null, nextAttemptAt: null })
      .where(and(eq(runs.id, runId), eq(runs.lockedBy, this.owner)))
      .returning({ id: runs.id });
  }
}
