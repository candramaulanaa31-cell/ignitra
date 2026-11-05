import { and, asc, desc, eq, gt, inArray, max, ne, sql } from "drizzle-orm";
import type { EvaluationOutcome, FlowDefinition } from "@ignitra/core";
import {
  Lease,
  chainCursors,
  chainEvents,
  consumerOffsets,
  flowEvaluations,
  flowStats,
  flowVersions,
  flows,
  runs,
  triggerState,
  type ChainEvent,
  type Database,
  type Tx,
} from "@ignitra/db";

/** Matcher persistence. Every write runs in one transaction with the matcher lease fence. */

export type MatcherStream = "confirmed" | "head" | "reverted";

export interface RunInsert {
  readonly id: string;
  readonly flowId: string;
  readonly flowVersion: number;
  readonly idempotencyKey: string;
  readonly triggerType: string;
  readonly triggerEvent: Record<string, unknown>;
  readonly conditionsResult: unknown[];
  readonly chainEventId: number | null;
}

export interface EvaluationInsert {
  readonly flowId: string;
  readonly flowVersion: number;
  readonly idempotencyKey: string;
  readonly outcome: EvaluationOutcome;
  readonly reason: string | null;
  readonly triggerEvent: Record<string, unknown>;
  readonly conditionsResult: unknown[];
}

export interface StatsDelta {
  matched: number;
  conditionsFailed: number;
  rateLimited: number;
  undetermined: number;
}

export interface BatchCommit {
  readonly runs: readonly RunInsert[];
  readonly evaluations: readonly EvaluationInsert[];
  readonly stats: ReadonlyMap<string, StatsDelta>;
  readonly pauses: ReadonlyArray<{ flowId: string; reason: string }>;
}

export interface CommitResult {
  /** New runs, per flow. */
  readonly inserted: ReadonlyMap<string, number>;
  /** Runs revived because their event came back after a reorg. */
  readonly restored: number;
}

export interface ActiveFlowRow {
  readonly id: string;
  readonly ownerId: string;
  readonly version: number;
  readonly activatedAt: Date | null;
  readonly definition: FlowDefinition;
}

const INSERT_CHUNK = 500;

export class MatcherStore {
  readonly #db: Database;
  readonly chainId: number;
  readonly lease: Lease;

  constructor(db: Database, opts: { chainId: number; owner: string; leaseMs?: number }) {
    this.#db = db;
    this.chainId = opts.chainId;
    this.lease = new Lease(db, `matcher:${opts.chainId}`, opts.owner, opts.leaseMs ?? 30_000);
  }

  offsetName(stream: MatcherStream): string {
    return `matcher:${this.chainId}:${stream}`;
  }

  // ---- offsets ---------------------------------------------------------------

  async offset(stream: MatcherStream): Promise<number | null> {
    const [row] = await this.#db.select().from(consumerOffsets).where(eq(consumerOffsets.name, this.offsetName(stream)));
    return row?.position ?? null;
  }

  /** Current end of a stream: a fresh matcher starts here instead of replaying history. */
  async streamHead(stream: MatcherStream): Promise<number> {
    const column = stream === "confirmed" ? chainEvents.confirmedSeq : stream === "reverted" ? chainEvents.revertedSeq : chainEvents.id;
    const [row] = await this.#db.select({ v: max(column) }).from(chainEvents).where(eq(chainEvents.chainId, this.chainId));
    return Number(row?.v ?? 0);
  }

  async setOffset(stream: MatcherStream, position: number, tx?: Tx): Promise<void> {
    const run = async (t: Tx) => {
      await t
        .insert(consumerOffsets)
        .values({ name: this.offsetName(stream), position })
        .onConflictDoUpdate({ target: consumerOffsets.name, set: { position, updatedAt: sql`now()` } });
    };
    if (tx) await run(tx);
    else
      await this.#db.transaction(async (t) => {
        await this.lease.fence(t);
        await run(t);
      });
  }

  // ---- streams ---------------------------------------------------------------

  /** Events in confirmation order (each (re)entry into `confirmed` gets a new position). */
  fetchConfirmed(after: number, limit: number): Promise<ChainEvent[]> {
    return this.#db
      .select()
      .from(chainEvents)
      .where(and(eq(chainEvents.chainId, this.chainId), gt(chainEvents.confirmedSeq, after)))
      .orderBy(asc(chainEvents.confirmedSeq))
      .limit(limit);
  }

  /** Events in ingestion order (fast-mode flows act on them at head). Reverted rows are skipped. */
  fetchHead(after: number, limit: number): Promise<ChainEvent[]> {
    return this.#db
      .select()
      .from(chainEvents)
      .where(and(eq(chainEvents.chainId, this.chainId), gt(chainEvents.id, after)))
      .orderBy(asc(chainEvents.id))
      .limit(limit);
  }

  fetchReverted(after: number, limit: number): Promise<ChainEvent[]> {
    return this.#db
      .select()
      .from(chainEvents)
      .where(and(eq(chainEvents.chainId, this.chainId), gt(chainEvents.revertedSeq, after)))
      .orderBy(asc(chainEvents.revertedSeq))
      .limit(limit);
  }

  // ---- flows -----------------------------------------------------------------

  async loadActiveFlows(): Promise<ActiveFlowRow[]> {
    return this.#db
      .select({
        id: flows.id,
        ownerId: flows.ownerId,
        version: flows.currentVersion,
        activatedAt: flows.activatedAt,
        definition: flowVersions.definition,
      })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
      .where(eq(flows.status, "active"));
  }

  /** Non-test runs created in the trailing hour, per flow (the hourly cap is enforced from the DB). */
  async runsLastHour(flowIds: readonly string[]): Promise<Map<string, number>> {
    if (flowIds.length === 0) return new Map();
    const rows = await this.#db
      .select({ flowId: runs.flowId, n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(inArray(runs.flowId, [...flowIds]), eq(runs.isTest, false), sql`${runs.createdAt} > now() - interval '1 hour'`))
      .groupBy(runs.flowId);
    return new Map(rows.map((r) => [r.flowId, Number(r.n)]));
  }

  /** Block the listener has confirmed up to (poll triggers sample here). */
  async confirmedCursor(): Promise<number | null> {
    const [row] = await this.#db
      .select({ block: chainCursors.blockNumber })
      .from(chainCursors)
      .where(and(eq(chainCursors.chainId, this.chainId), eq(chainCursors.stream, "confirmed")));
    return row?.block ?? null;
  }

  async loadTriggerState(flowId: string, version: number): Promise<Record<string, unknown> | null> {
    const [row] = await this.#db.select().from(triggerState).where(eq(triggerState.flowId, flowId));
    return row && row.flowVersion === version ? row.state : null;
  }

  // ---- commits ---------------------------------------------------------------

  async #write(tx: Tx, batch: BatchCommit): Promise<CommitResult> {
    const inserted = new Map<string, number>();
    let restored = 0;
    for (let i = 0; i < batch.runs.length; i += INSERT_CHUNK) {
      const chunk = batch.runs.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, status: "queued" as const }));
      const revived = sql`${runs.status} = 'skipped' and ${runs.statusReason} = 'event_reverted'`;
      const rows = await tx
        .insert(runs)
        .values(chunk)
        .onConflictDoUpdate({
          // Same occurrence again: a no-op — unless its event had been reorged out and is canonical again.
          target: runs.idempotencyKey,
          set: {
            revertedAt: sql`null`,
            revertReason: sql`null`,
            chainEventId: sql`excluded.chain_event_id`,
            status: sql`case when ${revived} then 'queued' else ${runs.status} end`,
            statusReason: sql`case when ${revived} then null else ${runs.statusReason} end`,
            finishedAt: sql`case when ${revived} then null else ${runs.finishedAt} end`,
          },
          setWhere: sql`${runs.revertedAt} is not null`,
        })
        .returning({ flowId: runs.flowId, inserted: sql<boolean>`(xmax = 0)` });
      for (const r of rows) {
        if (r.inserted) inserted.set(r.flowId, (inserted.get(r.flowId) ?? 0) + 1);
        else restored++;
      }
    }
    for (let i = 0; i < batch.evaluations.length; i += INSERT_CHUNK) {
      await tx
        .insert(flowEvaluations)
        .values(batch.evaluations.slice(i, i + INSERT_CHUNK).map((e) => ({ ...e })))
        .onConflictDoNothing({ target: flowEvaluations.idempotencyKey });
    }
    const flowIds = new Set([...batch.stats.keys(), ...inserted.keys()]);
    for (const flowId of flowIds) {
      const d = batch.stats.get(flowId) ?? { matched: 0, conditionsFailed: 0, rateLimited: 0, undetermined: 0 };
      const n = inserted.get(flowId) ?? 0;
      const values = {
        flowId,
        matched: d.matched,
        runs: n,
        conditionsFailed: d.conditionsFailed,
        rateLimited: d.rateLimited,
        undetermined: d.undetermined,
        lastMatchedAt: d.matched > 0 ? sql`now()` : null,
        lastRunAt: n > 0 ? sql`now()` : null,
      };
      await tx
        .insert(flowStats)
        .values(values)
        .onConflictDoUpdate({
          target: flowStats.flowId,
          set: {
            matched: sql`${flowStats.matched} + excluded.matched`,
            runs: sql`${flowStats.runs} + excluded.runs`,
            conditionsFailed: sql`${flowStats.conditionsFailed} + excluded.conditions_failed`,
            rateLimited: sql`${flowStats.rateLimited} + excluded.rate_limited`,
            undetermined: sql`${flowStats.undetermined} + excluded.undetermined`,
            lastMatchedAt: sql`coalesce(excluded.last_matched_at, ${flowStats.lastMatchedAt})`,
            lastRunAt: sql`coalesce(excluded.last_run_at, ${flowStats.lastRunAt})`,
            updatedAt: sql`now()`,
          },
        });
    }
    for (const p of batch.pauses) {
      await tx
        .update(flows)
        .set({ status: "paused", statusReason: p.reason, updatedAt: sql`now()` })
        .where(and(eq(flows.id, p.flowId), eq(flows.status, "active")));
    }
    return { inserted, restored };
  }

  /** Stream batch: runs + evaluations + stats + pauses + offset, atomically. */
  async commitBatch(stream: MatcherStream, position: number, batch: BatchCommit): Promise<CommitResult> {
    return this.#db.transaction(async (tx) => {
      await this.lease.fence(tx);
      const result = await this.#write(tx, batch);
      await this.setOffset(stream, position, tx);
      return result;
    });
  }

  /** Poll trigger: runs + evaluations + stats + new state (null = unchanged), atomically. */
  async commitPoll(flowId: string, version: number, state: Record<string, unknown> | null, batch: BatchCommit): Promise<CommitResult> {
    return this.#db.transaction(async (tx) => {
      await this.lease.fence(tx);
      const result = await this.#write(tx, batch);
      if (state) {
        await tx
          .insert(triggerState)
          .values({ flowId, flowVersion: version, state })
          .onConflictDoUpdate({ target: triggerState.flowId, set: { flowVersion: version, state, updatedAt: sql`now()` } });
      }
      return result;
    });
  }

  /**
   * Runs whose triggering event was reorged out:
   *   - the same (tx, log index) is canonical in another block → re-point the run (it happened)
   *   - otherwise → mark reverted; a still-queued run is cancelled (skipped, `event_reverted`)
   */
  async applyReverts(events: readonly ChainEvent[], position: number): Promise<{ moved: number; reverted: number; cancelled: number }> {
    return this.#db.transaction(async (tx) => {
      await this.lease.fence(tx);
      let moved = 0;
      let reverted = 0;
      let cancelled = 0;
      for (const e of events) {
        const [sibling] = await tx
          .select({ id: chainEvents.id })
          .from(chainEvents)
          .where(
            and(
              eq(chainEvents.chainId, this.chainId),
              eq(chainEvents.txHash, e.txHash),
              eq(chainEvents.logIndex, e.logIndex),
              ne(chainEvents.status, "reverted"),
            ),
          )
          .orderBy(desc(chainEvents.id))
          .limit(1);
        if (sibling) {
          const rows = await tx.update(runs).set({ chainEventId: sibling.id }).where(eq(runs.chainEventId, e.id)).returning({ id: runs.id });
          moved += rows.length;
          continue;
        }
        const wasQueued = sql`${runs.status} = 'queued'`;
        const rows = await tx
          .update(runs)
          .set({
            revertedAt: sql`now()`,
            revertReason: e.revertReason ?? "reorg",
            status: sql`case when ${wasQueued} then 'skipped' else ${runs.status} end`,
            statusReason: sql`case when ${wasQueued} then 'event_reverted' else ${runs.statusReason} end`,
            finishedAt: sql`case when ${wasQueued} then now() else ${runs.finishedAt} end`,
          })
          .where(and(eq(runs.chainEventId, e.id), sql`${runs.revertedAt} is null`))
          .returning({ reason: runs.statusReason });
        reverted += rows.length;
        cancelled += rows.filter((r) => r.reason === "event_reverted").length;
      }
      await this.setOffset("reverted", position, tx);
      return { moved, reverted, cancelled };
    });
  }

  /** Keep the newest `keep` evaluations per flow, none older than `maxAgeDays`. */
  async pruneEvaluations(keep: number, maxAgeDays: number): Promise<number> {
    const rows = await this.#db.execute<{ id: number }>(sql`
      delete from flow_evaluations e
      using (
        select id from (
          select id, row_number() over (partition by flow_id order by id desc) as rn, created_at
          from flow_evaluations
        ) ranked
        where ranked.rn > ${keep} or ranked.created_at < now() - make_interval(days => ${maxAgeDays})
      ) doomed
      where e.id = doomed.id
      returning e.id`);
    const result = rows as unknown as { rows?: unknown[]; length?: number };
    return Array.isArray(result) ? result.length : (result.rows?.length ?? 0);
  }

  /** For tests and the CLI. */
  async evaluationCount(flowId: string): Promise<number> {
    const [row] = await this.#db.select({ n: sql<number>`count(*)::int` }).from(flowEvaluations).where(eq(flowEvaluations.flowId, flowId));
    return Number(row?.n ?? 0);
  }

}
