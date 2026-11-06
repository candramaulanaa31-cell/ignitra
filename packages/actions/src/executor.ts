import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import {
  TemplateError,
  formatInTimeZone,
  newId,
  renderTemplate,
  type ActionConnection,
  type ActionContext,
  type ActionRegistry,
  type ActionResult,
  type FlowDefinition,
  type RunFinalStatus,
  type SafeHttpClient,
} from "@ignitra/core";
import type { Keyring } from "@ignitra/core/server";
import { flowStats, flowVersions, flows, ownerNotifications, runSteps, type Database, type Run } from "@ignitra/db";
import { loadConnection } from "./connections";
import type { WebPushSender } from "./push";
import type { RunQueue } from "./queue";
import { deriveOwnerSigningSecret } from "./signing";

/**
 * Executes one claimed run, step by step (actions run in sequence; later
 * steps may use `{{steps.<id>.*}}` of earlier ones).
 *
 *  - Completed steps are never re-executed: a run that backed off resumes at
 *    the step that failed, with earlier outputs restored from run_steps.
 *  - Retryable failures back off exponentially (honouring Retry-After /
 *    Telegram retry_after) up to `maxAttempts`, then the step fails.
 *  - A permanently failed step does not stop the run: later steps still run
 *    (they are independent notifications) — the run ends `partial`.
 *  - Every attempt is recorded BEFORE the request goes out (at-least-once:
 *    a crash mid-request re-sends with the same idempotency key).
 */

export interface ExecutorOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive failed runs before the flow is auto-paused. */
  autoPauseAfter?: number;
}

export interface ExecutorDeps {
  db: Database;
  queue: RunQueue;
  actions: ActionRegistry;
  http: SafeHttpClient;
  keyring: Keyring | null;
  push: WebPushSender | null;
  /** WEBHOOK_SIGNING_SECRET — per-owner secrets are derived from it. */
  webhookMaster: string | null;
  logger: Logger;
  options?: ExecutorOptions;
}

export type ExecutionOutcome =
  | { readonly kind: "finished"; readonly status: RunFinalStatus }
  | { readonly kind: "requeued"; readonly delayMs: number }
  | { readonly kind: "lost" };

type StepRow = typeof runSteps.$inferSelect;
type StepFinal = "succeeded" | "failed" | "skipped";

export function backoffDelay(attempt: number, base: number, cap: number, retryAfterMs?: number, random = Math.random): number {
  const exponential = Math.min(cap, base * 3 ** Math.max(0, attempt - 1));
  const jittered = exponential * (0.8 + random() * 0.4);
  return Math.round(Math.min(3_600_000, Math.max(jittered, retryAfterMs ?? 0)));
}

export function finalRunStatus(steps: readonly StepFinal[]): RunFinalStatus {
  if (steps.some((s) => s === "failed")) return steps.some((s) => s === "succeeded") ? "partial" : "failed";
  if (steps.length > 0 && steps.every((s) => s === "skipped")) return "skipped";
  return "succeeded";
}

export class RunExecutor {
  readonly #d: ExecutorDeps;
  readonly #opts: Required<ExecutorOptions>;

  constructor(deps: ExecutorDeps) {
    this.#d = deps;
    this.#opts = { maxAttempts: 5, baseBackoffMs: 10_000, maxBackoffMs: 15 * 60_000, autoPauseAfter: 5, ...deps.options };
  }

  async execute(run: Run): Promise<ExecutionOutcome> {
    // Keep the lease alive during long steps (Web Push to many devices, slow receivers):
    // an expired lease would let another worker re-send the same step.
    const heartbeat = setInterval(() => void this.#d.queue.renew(run.id).catch(() => {}), Math.max(1000, Math.floor(this.#d.queue.leaseMs / 3)));
    try {
      return await this.#execute(run);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #execute(run: Run): Promise<ExecutionOutcome> {
    const { db, queue } = this.#d;
    const [row] = await db
      .select({ flow: flows, definition: flowVersions.definition })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, run.flowVersion)))
      .where(eq(flows.id, run.flowId));
    if (!row) return this.#finish(run, "skipped", "flow version no longer exists", null);
    const { flow, definition } = row;
    const existing = new Map<string, StepRow>((await db.select().from(runSteps).where(eq(runSteps.runId, run.id))).map((s) => [s.stepId, s]));

    // Reasons to send nothing further. Steps that already ran keep their real result, so a
    // run resumed after a backoff never misreports what was delivered.
    let stop = !run.isTest && flow.status !== "active" ? `flow is ${flow.status}` : run.revertedAt ? "event_reverted" : null;
    if (stop && existing.size === 0) return this.#finish(run, "skipped", stop, null);

    const outputs: Record<string, unknown> = {};
    const finals: StepFinal[] = [];
    let lastError: string | null = null;

    for (const [position, step] of (definition as FlowDefinition).actions.entries()) {
      const prior = existing.get(step.step_id);
      if (prior && (prior.status === "succeeded" || prior.status === "failed" || prior.status === "skipped")) {
        finals.push(prior.status);
        if (prior.status === "succeeded") outputs[step.step_id] = prior.output ?? {};
        if (prior.status === "failed") lastError = prior.error;
        continue;
      }
      if (!stop) {
        // Renewing the lease also tells us if the event was reorged out while we were running.
        const lease = await queue.renew(run.id);
        if (!lease.held) return { kind: "lost" };
        if (lease.reverted) stop = "event_reverted";
      }
      if (stop) {
        await db
          .insert(runSteps)
          .values({ runId: run.id, stepId: step.step_id, position, actionType: step.type, status: "skipped", attempts: prior?.attempts ?? 0, error: stop, finishedAt: sql`now()` })
          .onConflictDoUpdate({ target: [runSteps.runId, runSteps.stepId], set: { status: "skipped", error: stop, finishedAt: sql`now()` } });
        finals.push("skipped");
        continue;
      }
      const attempt = (prior?.attempts ?? 0) + 1;
      await db
        .insert(runSteps)
        .values({ runId: run.id, stepId: step.step_id, position, actionType: step.type, status: "running", attempts: attempt, startedAt: sql`now()` })
        .onConflictDoUpdate({
          target: [runSteps.runId, runSteps.stepId],
          set: { status: "running", attempts: attempt, startedAt: sql`coalesce(${runSteps.startedAt}, now())` },
        });

      const started = performance.now();
      const result = await this.#runStep(run, flow, step, attempt, outputs);
      const durationMs = Math.round(performance.now() - started);
      const base = {
        httpStatus: "httpStatus" in result && result.httpStatus !== undefined ? result.httpStatus : null,
        durationMs,
        request: result.request ?? null,
        response: result.response ?? null,
      };

      if (result.status === "succeeded") {
        outputs[step.step_id] = result.output ?? {};
        finals.push("succeeded");
        await this.#saveStep(run.id, step.step_id, { ...base, status: "succeeded", output: result.output ?? {}, error: null, finishedAt: sql`now()` });
        continue;
      }
      if (result.status === "skipped") {
        finals.push("skipped");
        await this.#saveStep(run.id, step.step_id, { ...base, status: "skipped", error: result.reason, finishedAt: sql`now()` });
        continue;
      }
      // failed
      if (result.retryable && attempt < this.#opts.maxAttempts) {
        const delayMs = backoffDelay(attempt, this.#opts.baseBackoffMs, this.#opts.maxBackoffMs, result.retryAfterMs);
        await this.#saveStep(run.id, step.step_id, { ...base, status: "pending", error: result.error, finishedAt: null });
        const ok = await queue.requeue(run.id, delayMs, `retrying ${step.step_id} (attempt ${attempt + 1}/${this.#opts.maxAttempts}): ${result.error}`);
        return ok ? { kind: "requeued", delayMs } : { kind: "lost" };
      }
      const error = result.retryable ? `${result.error} (gave up after ${attempt} attempts)` : result.error;
      lastError = `${step.step_id}: ${error}`;
      finals.push("failed");
      await this.#saveStep(run.id, step.step_id, { ...base, status: "failed", error, finishedAt: sql`now()` });
    }

    const status = finalRunStatus(finals);
    return this.#finish(run, status, stop ?? (status === "failed" || status === "partial" ? lastError : null), lastError);
  }

  async #saveStep(runId: string, stepId: string, values: PgUpdateSetSource<typeof runSteps>): Promise<void> {
    await this.#d.db.update(runSteps).set(values).where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, stepId)));
  }

  async #runStep(
    run: Run,
    flow: typeof flows.$inferSelect,
    step: FlowDefinition["actions"][number],
    attempt: number,
    outputs: Record<string, unknown>,
  ): Promise<ActionResult> {
    const { actions, keyring, db, http, push, webhookMaster, logger } = this.#d;
    const module = actions.has(step.type) ? actions.get(step.type) : undefined;
    if (!module) return { status: "failed", retryable: false, error: `${step.type} is not available on this runner` };
    const parsed = module.paramsSchema.safeParse(step.params);
    if (!parsed.success) return { status: "failed", retryable: false, error: `invalid params: ${parsed.error.issues.map((i) => i.message).join("; ")}` };

    let connection: ActionConnection | null = null;
    const connectionId = (step.params as { connection_id?: unknown }).connection_id;
    if (typeof connectionId === "string") {
      if (!keyring) return { status: "failed", retryable: false, error: "ENCRYPTION_KEY is not configured on the runner" };
      const loaded = await loadConnection(db, keyring, connectionId);
      if (!loaded || loaded.ownerId !== flow.ownerId) return { status: "failed", retryable: false, error: `connection ${connectionId} not found` };
      if (module.connectionType && loaded.type !== module.connectionType) {
        return { status: "failed", retryable: false, error: `connection ${connectionId} is a ${loaded.type} connection, ${step.type} needs ${module.connectionType}` };
      }
      connection = loaded;
    } else if (module.connectionType && !module.connectionOptional) {
      return { status: "failed", retryable: false, error: `${step.type} needs a connection_id` };
    }

    const scope = () => ({
      trigger: run.triggerEvent,
      steps: outputs,
      flow: { id: flow.id, name: flow.name, version: run.flowVersion },
      run: { id: run.id, idempotency_key: run.idempotencyKey, test: run.isTest },
      now_utc: new Date().toISOString(),
      now_wib: formatInTimeZone(new Date()),
    });
    const controller = new AbortController();
    const ctx: ActionContext = {
      runId: run.id,
      flowId: flow.id,
      flowName: flow.name,
      flowVersion: run.flowVersion,
      stepId: step.step_id,
      idempotencyKey: `${run.idempotencyKey}:${step.step_id}`,
      runIdempotencyKey: run.idempotencyKey,
      attempt,
      isTest: run.isTest,
      signal: controller.signal,
      trigger: run.triggerEvent,
      render: (template, escape) => renderTemplate(template, scope(), { escape: escape ?? "none" }),
      connection,
      http,
      push: push ? { send: (message) => push.sendToUser(flow.ownerId, message) } : null,
      ownerSigningSecret: webhookMaster ? deriveOwnerSigningSecret(webhookMaster, flow.ownerId) : null,
    };
    try {
      return await module.execute(parsed.data, ctx);
    } catch (err) {
      if (err instanceof TemplateError) return { status: "failed", retryable: false, error: `template: ${err.message}` };
      logger.error({ err, runId: run.id, stepId: step.step_id }, "action threw unexpectedly");
      return { status: "failed", retryable: true, error: `unexpected error: ${(err as Error).message}` };
    }
  }

  /** Final status + flow stats + (maybe) auto-pause with an owner notification — one transaction. */
  async #finish(run: Run, status: RunFinalStatus, reason: string | null, lastError: string | null): Promise<ExecutionOutcome> {
    const { db, queue, logger } = this.#d;
    const paused = await db.transaction(async (tx) => {
      const done = await queue.finishStatement(tx, run.id, status, reason);
      if (done.length === 0) return null;
      if (run.isTest) return false;
      const failed = status === "failed";
      const [stats] = await tx
        .insert(flowStats)
        .values({
          flowId: run.flowId,
          runsSucceeded: status === "succeeded" ? 1 : 0,
          runsPartial: status === "partial" ? 1 : 0,
          runsFailed: failed ? 1 : 0,
          runsSkipped: status === "skipped" ? 1 : 0,
          consecutiveFailures: failed ? 1 : 0,
          lastError: failed ? lastError : null,
          lastFinishedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: flowStats.flowId,
          set: {
            runsSucceeded: sql`${flowStats.runsSucceeded} + excluded.runs_succeeded`,
            runsPartial: sql`${flowStats.runsPartial} + excluded.runs_partial`,
            runsFailed: sql`${flowStats.runsFailed} + excluded.runs_failed`,
            runsSkipped: sql`${flowStats.runsSkipped} + excluded.runs_skipped`,
            // Delivered anything → the flow works; skipped runs say nothing about health.
            consecutiveFailures: sql`case when ${status} = 'failed' then ${flowStats.consecutiveFailures} + 1 when ${status} in ('succeeded', 'partial') then 0 else ${flowStats.consecutiveFailures} end`,
            lastError: sql`case when ${status} = 'failed' then excluded.last_error else ${flowStats.lastError} end`,
            lastFinishedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ consecutive: flowStats.consecutiveFailures });
      const consecutive = stats?.consecutive ?? 0;
      if (!failed || consecutive < this.#opts.autoPauseAfter) return false;
      const message = `Flow auto-paused after ${consecutive} consecutive failed runs. Last error: ${lastError ?? "unknown"}. Fix the destination, then resume the flow.`;
      const updated = await tx
        .update(flows)
        .set({ status: "paused", statusReason: `auto-paused: ${consecutive} consecutive failed runs — ${lastError ?? "unknown error"}`, updatedAt: sql`now()` })
        .where(and(eq(flows.id, run.flowId), eq(flows.status, "active")))
        .returning({ ownerId: flows.ownerId });
      const owner = updated[0]?.ownerId;
      if (!owner) return false;
      await tx.insert(ownerNotifications).values({ id: newId("notification"), userId: owner, flowId: run.flowId, kind: "flow_auto_paused", message });
      return true;
    });
    if (paused === null) return { kind: "lost" };
    if (paused) logger.warn({ flowId: run.flowId, runId: run.id }, "flow auto-paused after repeated failures");
    return { kind: "finished", status };
  }
}
