import { and, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
import { flowStats, flows, runSteps, runs, type Database } from "@ignitra/db";

/**
 * Dead letters (Phase 9): steps that failed for good — a permanent error, or every retry used up.
 * Their runs end `failed` or `partial` and stay there until the owner retries them.
 *
 * A retry re-runs only those steps (and the ones a paused flow stopped), with the SAME
 * idempotency keys: steps that succeeded are never sent again, receivers can deduplicate, and an
 * onchain step answers from its record instead of signing a second transaction. Each retried step
 * gets a fresh retry budget.
 */

/** A run with steps that failed for good. A retry is per run, so dead letters are listed per run. */
export interface DeadLetter {
  readonly runId: string;
  readonly flowId: string;
  readonly flowName: string;
  readonly runStatus: string;
  readonly runCreatedAt: Date;
  readonly steps: ReadonlyArray<{ readonly stepId: string; readonly actionType: string; readonly error: string | null; readonly attempts: number; readonly failedAt: Date | null }>;
}

/** The owner's dead letters, newest run first; `before` is a run id. */
export async function listDeadLetters(db: Database, ownerId: string, opts: { limit: number; before?: string | undefined }): Promise<DeadLetter[]> {
  const page = await db
    .select({ runId: runs.id, flowId: runs.flowId, flowName: flows.name, runStatus: runs.status, runCreatedAt: runs.createdAt })
    .from(runs)
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .where(
      and(
        eq(flows.ownerId, ownerId),
        eq(runs.isTest, false),
        inArray(runs.status, ["failed", "partial"]),
        opts.before ? lt(runs.id, opts.before) : undefined,
        sql`exists (select 1 from run_steps s where s.run_id = ${runs.id} and s.status = 'failed')`,
      ),
    )
    .orderBy(desc(runs.id))
    .limit(opts.limit);
  if (page.length === 0) return [];
  const steps = await db
    .select({ runId: runSteps.runId, stepId: runSteps.stepId, actionType: runSteps.actionType, error: runSteps.error, attempts: runSteps.attempts, failedAt: runSteps.finishedAt })
    .from(runSteps)
    .where(and(inArray(runSteps.runId, page.map((p) => p.runId)), eq(runSteps.status, "failed")))
    .orderBy(runSteps.position);
  return page.map((p) => ({ ...p, steps: steps.filter((s) => s.runId === p.runId).map(({ runId: _run, ...s }) => s) }));
}

export type RetryRefusal = "not_found" | "test_run" | "event_reverted" | "not_failed" | "flow_inactive" | "nothing_to_retry";

export class RetryRefusedError extends Error {
  readonly code: RetryRefusal;

  constructor(code: RetryRefusal, message: string) {
    super(message);
    this.name = "RetryRefusedError";
    this.code = code;
  }
}

/** Steps a retry runs again: the failed ones, and those skipped only because the flow was not active. */
const retriable = or(eq(runSteps.status, "failed"), and(eq(runSteps.status, "skipped"), like(runSteps.error, "flow is %")));

/** Puts a failed or partial run back in the queue for its failed steps. Returns those steps. */
export async function retryRun(db: Database, input: { runId: string; ownerId: string }): Promise<{ flowId: string; steps: string[] }> {
  return db.transaction(async (t) => {
    const tx = t as unknown as Database;
    const [row] = await tx
      .select({ run: runs, flowStatus: flows.status, ownerId: flows.ownerId })
      .from(runs)
      .innerJoin(flows, eq(flows.id, runs.flowId))
      .where(eq(runs.id, input.runId))
      .for("update", { of: runs });
    if (!row || row.ownerId !== input.ownerId) throw new RetryRefusedError("not_found", "run not found");
    const { run } = row;
    if (run.isTest) throw new RetryRefusedError("test_run", "TEST runs are not retried: test the flow again");
    if (run.revertedAt) throw new RetryRefusedError("event_reverted", "the event that started this run was reorganised away: nothing to retry");
    if (run.status !== "failed" && run.status !== "partial") throw new RetryRefusedError("not_failed", `the run is ${run.status}: only failed or partial runs are retried`);
    if (row.flowStatus !== "active") throw new RetryRefusedError("flow_inactive", `the flow is ${row.flowStatus}: resume it first, then retry`);

    const steps = await tx.select({ stepId: runSteps.stepId }).from(runSteps).where(and(eq(runSteps.runId, run.id), retriable));
    if (steps.length === 0) throw new RetryRefusedError("nothing_to_retry", "no failed step to retry");
    await tx
      .update(runSteps)
      .set({ status: "pending", attempts: 0, error: null, finishedAt: null })
      .where(and(eq(runSteps.runId, run.id), retriable));
    await tx
      .update(runs)
      .set({ status: "queued", statusReason: `retrying ${steps.map((s) => s.stepId).join(", ")}`, nextAttemptAt: null, finishedAt: null, lockedBy: null, leaseUntil: null })
      .where(eq(runs.id, run.id));
    // The run finishes again: take its first outcome out of the flow's counters.
    await tx
      .update(flowStats)
      .set(run.status === "failed" ? { runsFailed: sql`greatest(${flowStats.runsFailed} - 1, 0)` } : { runsPartial: sql`greatest(${flowStats.runsPartial} - 1, 0)` })
      .where(eq(flowStats.flowId, run.flowId));
    return { flowId: run.flowId, steps: steps.map((s) => s.stepId) };
  });
}
