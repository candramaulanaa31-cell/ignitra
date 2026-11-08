import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createActionRegistry, newId, type ActionContext, type ActionDefinition, type ActionResult, type ActionType, type SafeHttpClient } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { auditLog, connections, createDb, flowStats, flowVersions, flows, ownerNotifications, runSteps, runs, users, type DbHandle, type Run } from "@ignitra/db";
import { createConnection } from "./connections";
import { RetryRefusedError, listDeadLetters, retryRun } from "./dead-letters";
import { RunExecutor, backoffDelay, finalRunStatus } from "./executor";
import { Notifier } from "./notices";
import { RunQueue } from "./queue";

const silent = createLogger("test", "silent");
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });
let h: DbHandle;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.db.delete(users); // cascades to flows, versions, runs, steps, stats, connections, notifications
});

/** Scriptable action: behaviour comes from params.script. */
const calls: Array<{ step: string; attempt: number; key: string }> = [];
const attemptsBy = new Map<string, number>();
function scripted(type: ActionType): ActionDefinition<Record<string, unknown>> {
  return {
    type,
    label: type,
    description: "test",
    connectionType: type === "TELEGRAM" ? "telegram" : null,
    paramsSchema: z.record(z.string(), z.unknown()),
    templates: () => [],
    outputFields: [],
    async execute(p, ctx: ActionContext): Promise<ActionResult> {
      calls.push({ step: ctx.stepId, attempt: ctx.attempt, key: ctx.idempotencyKey });
      const n = (attemptsBy.get(`${ctx.runId}:${ctx.stepId}`) ?? 0) + 1;
      attemptsBy.set(`${ctx.runId}:${ctx.stepId}`, n);
      switch (p.script) {
        case "ok":
          return { status: "succeeded", httpStatus: 200, output: { value: p.value ?? n } };
        case "render":
          return { status: "succeeded", output: { text: ctx.render(String(p.template)) } };
        case "flaky":
          return n <= Number(p.failures) ? { status: "failed", retryable: true, error: `boom ${n}`, retryAfterMs: Number(p.retryAfterMs ?? 0) } : { status: "succeeded", output: { recovered: n } };
        case "down":
          return { status: "failed", retryable: true, error: "receiver down" };
        case "permanent":
          return { status: "failed", retryable: false, httpStatus: 404, error: "not found" };
        case "skip":
          return { status: "skipped", reason: "nothing to do" };
        case "secret":
          return { status: "succeeded", output: { chat: String(ctx.connection?.metadata.chat_id), tokenLength: String(ctx.connection?.secret.bot_token ?? "").length } };
        case "throw":
          throw new Error("kaboom");
        case "slow":
          await new Promise((r) => setTimeout(r, Number(p.ms)));
          return { status: "succeeded", output: { slept: Number(p.ms) } };
        default:
          return { status: "failed", retryable: false, error: "unknown script" };
      }
    },
  };
}
const registry = createActionRegistry();
registry.register(scripted("WEBHOOK"));
registry.register(scripted("TELEGRAM"));
registry.register(scripted("WEB_PUSH"));

const fakeHttp: SafeHttpClient = { request: async () => ({ status: 200, headers: {}, body: "", durationMs: 1 }) };

function setup(opts: { owner?: string; maxAttempts?: number; autoPauseAfter?: number; leaseMs?: number } = {}) {
  const queue = new RunQueue(h.db, { owner: opts.owner ?? "worker-a", leaseMs: opts.leaseMs ?? 60_000 });
  const executor = new RunExecutor({
    db: h.db,
    queue,
    actions: registry,
    http: fakeHttp,
    keyring,
    push: null,
    webhookMaster: "master",
    logger: silent,
    options: { maxAttempts: opts.maxAttempts ?? 3, baseBackoffMs: 1000, autoPauseAfter: opts.autoPauseAfter ?? 3 },
  });
  return { queue, executor };
}

async function makeFlow(actions: Array<{ step_id: string; type: ActionType; params: Record<string, unknown> }>, status: "active" | "paused" = "active") {
  const userId = newId("user");
  const flowId = newId("flow");
  await h.db.insert(users).values({ id: userId, address: `0x${randomBytes(20).toString("hex")}` });
  await h.db.insert(flows).values({ id: flowId, ownerId: userId, name: "Big buys", status, currentVersion: 1 });
  await h.db.insert(flowVersions).values({
    flowId,
    version: 1,
    definition: { trigger: { type: "TOKEN_TRANSFER", params: {} }, actions, settings: { mode: "confirmed", max_runs_per_hour: 60, onchain: false } },
  });
  return { userId, flowId };
}

async function makeRun(flowId: string, extra: Partial<typeof runs.$inferInsert> = {}): Promise<string> {
  const id = newId("run");
  await h.db.insert(runs).values({
    id,
    flowId,
    flowVersion: 1,
    idempotencyKey: `4663:0x${randomBytes(32).toString("hex")}:0:${flowId}`,
    triggerType: "TOKEN_TRANSFER",
    triggerEvent: { amount_formatted: "1,234.5", token: { symbol: "USDG" } },
    ...extra,
  });
  return id;
}

const runRow = async (id: string): Promise<Run> => (await h.db.select().from(runs).where(eq(runs.id, id)))[0] as Run;
const stepRows = (id: string) => h.db.select().from(runSteps).where(eq(runSteps.runId, id)).orderBy(runSteps.position);
const makeDue = (id: string) => h.db.update(runs).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(runs.id, id));

describe("helpers", () => {
  it("computes final status and exponential backoff", () => {
    expect(finalRunStatus(["succeeded", "succeeded"])).toBe("succeeded");
    expect(finalRunStatus(["succeeded", "failed"])).toBe("partial");
    expect(finalRunStatus(["failed", "skipped"])).toBe("failed");
    expect(finalRunStatus(["skipped", "skipped"])).toBe("skipped");
    expect(finalRunStatus(["skipped", "succeeded"])).toBe("succeeded");
    const fixed = () => 0.5; // no jitter
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, 10_000, 900_000, undefined, fixed))).toEqual([10_000, 30_000, 90_000, 270_000]);
    expect(backoffDelay(9, 10_000, 900_000, undefined, fixed)).toBe(900_000);
    expect(backoffDelay(1, 10_000, 900_000, 60_000, fixed)).toBe(60_000); // Retry-After wins
  });
});

describe("executing runs", () => {
  it("runs steps in order and passes outputs to later steps", async () => {
    const { flowId } = await makeFlow([
      { step_id: "first", type: "WEBHOOK", params: { script: "ok", value: "abc" } },
      { step_id: "second", type: "WEB_PUSH", params: { script: "render", template: "{{trigger.amount_formatted}} {{trigger.token.symbol}} / {{steps.first.value}} / {{flow.name}}" } },
    ]);
    const runId = await makeRun(flowId);
    const { queue, executor } = setup();
    const [claimed] = await queue.claim(10);
    expect(await executor.execute(claimed as Run)).toEqual({ kind: "finished", status: "succeeded" });

    expect(await runRow(runId)).toMatchObject({ status: "succeeded", lockedBy: null, attempts: 1 });
    const steps = await stepRows(runId);
    expect(steps.map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ["first", "succeeded", 1],
      ["second", "succeeded", 1],
    ]);
    expect(steps[1]?.output).toEqual({ text: "1,234.5 USDG / abc / Big buys" });
    expect(steps[0]?.finishedAt).toBeInstanceOf(Date);
    const [stats] = await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId));
    expect(stats).toMatchObject({ runsSucceeded: 1, consecutiveFailures: 0 });
  });

  it("backs off on retryable failures and resumes at the failed step (earlier steps are not re-sent)", async () => {
    const { flowId } = await makeFlow([
      { step_id: "a", type: "WEBHOOK", params: { script: "ok" } },
      { step_id: "b", type: "WEB_PUSH", params: { script: "flaky", failures: 2, retryAfterMs: 5000 } },
    ]);
    const runId = await makeRun(flowId);
    const { queue, executor } = setup();
    calls.length = 0;

    let [claimed] = await queue.claim(10);
    expect(await executor.execute(claimed as Run)).toMatchObject({ kind: "requeued" });
    let run = await runRow(runId);
    expect(run.status).toBe("queued");
    expect(run.statusReason).toMatch(/retrying b \(attempt 2\/3\): boom 1/);
    expect(run.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 3000); // honoured retryAfterMs
    expect(await queue.claim(10)).toHaveLength(0); // not due yet

    await makeDue(runId);
    [claimed] = await queue.claim(10);
    expect(await executor.execute(claimed as Run)).toMatchObject({ kind: "requeued" });
    await makeDue(runId);
    [claimed] = await queue.claim(10);
    expect(await executor.execute(claimed as Run)).toEqual({ kind: "finished", status: "succeeded" });

    expect(calls.filter((c) => c.step === "a")).toHaveLength(1); // never re-sent
    expect(calls.filter((c) => c.step === "b").map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set([`${run.idempotencyKey}:a`, `${run.idempotencyKey}:b`])); // stable per step
    run = await runRow(runId);
    expect(run).toMatchObject({ status: "succeeded", attempts: 3 });
    expect((await stepRows(runId))[1]).toMatchObject({ status: "succeeded", attempts: 3, output: { recovered: 3 } });
  });

  it("gives up after max attempts; a failed step does not stop later steps (partial)", async () => {
    const { flowId } = await makeFlow([
      { step_id: "down", type: "WEBHOOK", params: { script: "down" } },
      { step_id: "push", type: "WEB_PUSH", params: { script: "ok" } },
    ]);
    const runId = await makeRun(flowId);
    const { queue, executor } = setup({ maxAttempts: 2 });
    let [claimed] = await queue.claim(10);
    await executor.execute(claimed as Run);
    await makeDue(runId);
    [claimed] = await queue.claim(10);
    expect(await executor.execute(claimed as Run)).toEqual({ kind: "finished", status: "partial" });
    const steps = await stepRows(runId);
    expect(steps[0]).toMatchObject({ status: "failed", attempts: 2, error: "receiver down (gave up after 2 attempts)" });
    expect(steps[1]).toMatchObject({ status: "succeeded" });
    expect(await runRow(runId)).toMatchObject({ status: "partial", statusReason: "down: receiver down (gave up after 2 attempts)" });
  });

  it("records permanent failures, skips and template errors without retrying", async () => {
    const { flowId } = await makeFlow([
      { step_id: "nope", type: "WEBHOOK", params: { script: "permanent" } },
      { step_id: "idle", type: "WEB_PUSH", params: { script: "skip" } },
      { step_id: "typo", type: "WEBHOOK", params: { script: "render", template: "{{trigger.amout}}" } },
    ]);
    const runId = await makeRun(flowId);
    const { queue, executor } = setup();
    const [claimed] = await queue.claim(10);
    expect(await executor.execute(claimed as Run)).toEqual({ kind: "finished", status: "failed" });
    expect((await stepRows(runId)).map((s) => [s.stepId, s.status, s.attempts, s.httpStatus, s.error])).toEqual([
      ["nope", "failed", 1, 404, "not found"],
      ["idle", "skipped", 1, null, "nothing to do"],
      ["typo", "failed", 1, null, 'template: unknown variable "trigger.amout"'],
    ]);
  });

  it("treats an unexpected exception as retryable, then gives up", async () => {
    const { flowId } = await makeFlow([{ step_id: "bug", type: "WEBHOOK", params: { script: "throw" } }]);
    const runId = await makeRun(flowId);
    const { queue, executor } = setup({ maxAttempts: 1 });
    const [claimed] = await queue.claim(10);
    expect(await executor.execute(claimed as Run)).toEqual({ kind: "finished", status: "failed" });
    expect((await stepRows(runId))[0]?.error).toBe("unexpected error: kaboom (gave up after 1 attempts)");
  });

  it("skips runs of paused flows and of reverted events without sending anything", async () => {
    const paused = await makeFlow([{ step_id: "a", type: "WEBHOOK", params: { script: "ok" } }], "paused");
    const pausedRun = await makeRun(paused.flowId);
    const active = await makeFlow([{ step_id: "a", type: "WEBHOOK", params: { script: "ok" } }]);
    const revertedRun = await makeRun(active.flowId, { revertedAt: new Date(), revertReason: "reorg" });
    const { queue, executor } = setup();
    calls.length = 0;
    for (const run of await queue.claim(10)) expect(await executor.execute(run)).toEqual({ kind: "finished", status: "skipped" });
    expect(calls).toHaveLength(0);
    expect(await runRow(pausedRun)).toMatchObject({ status: "skipped", statusReason: "flow is paused" });
    expect(await runRow(revertedRun)).toMatchObject({ status: "skipped", statusReason: "event_reverted" });
  });
});

describe("stopping mid-run (audit regressions)", () => {
  async function resumedAfter(change: (flowId: string, runId: string) => Promise<unknown>) {
    const { flowId } = await makeFlow([
      { step_id: "sent", type: "WEBHOOK", params: { script: "ok" } },
      { step_id: "later", type: "WEB_PUSH", params: { script: "flaky", failures: 1 } },
    ]);
    const runId = await makeRun(flowId);
    const { queue, executor } = setup();
    await executor.execute((await queue.claim(1))[0] as Run); // "sent" delivered, "later" backs off
    await change(flowId, runId);
    await makeDue(runId);
    const outcome = await executor.execute((await queue.claim(1))[0] as Run);
    return { outcome, run: await runRow(runId), steps: await stepRows(runId) };
  }

  it("a flow paused during a backoff keeps the delivered step and skips the rest", async () => {
    const { outcome, run, steps } = await resumedAfter((flowId) => h.db.update(flows).set({ status: "paused" }).where(eq(flows.id, flowId)));
    expect(outcome).toEqual({ kind: "finished", status: "succeeded" });
    expect(run.statusReason).toBe("flow is paused");
    expect(steps.map((s) => [s.stepId, s.status, s.error])).toEqual([
      ["sent", "succeeded", null],
      ["later", "skipped", "flow is paused"],
    ]);
  });

  it("an event reverted during a backoff sends nothing more", async () => {
    const { steps } = await resumedAfter((_f, runId) => h.db.update(runs).set({ revertedAt: new Date(), revertReason: "reorg" }).where(eq(runs.id, runId)));
    expect(steps.map((s) => [s.stepId, s.status, s.error])).toEqual([
      ["sent", "succeeded", null],
      ["later", "skipped", "event_reverted"],
    ]);
  });

  it("stops between steps when the event is reverted while the run is executing", async () => {
    const { flowId } = await makeFlow([
      { step_id: "first", type: "WEBHOOK", params: { script: "slow", ms: 300 } },
      { step_id: "second", type: "WEB_PUSH", params: { script: "ok" } },
    ]);
    const runId = await makeRun(flowId);
    const { queue, executor } = setup();
    const running = executor.execute((await queue.claim(1))[0] as Run);
    await new Promise((r) => setTimeout(r, 100));
    await h.db.update(runs).set({ revertedAt: new Date(), revertReason: "reorg" }).where(eq(runs.id, runId)); // matcher saw the reorg
    expect(await running).toEqual({ kind: "finished", status: "succeeded" });
    expect((await stepRows(runId)).map((s) => [s.stepId, s.status, s.error])).toEqual([
      ["first", "succeeded", null],
      ["second", "skipped", "event_reverted"],
    ]);
  });

  it("keeps the lease alive during a step longer than the lease (no duplicate execution)", async () => {
    const { flowId } = await makeFlow([{ step_id: "slow", type: "WEB_PUSH", params: { script: "slow", ms: 2500 } }]);
    const runId = await makeRun(flowId);
    const a = setup({ owner: "worker-a", leaseMs: 1500 });
    const b = setup({ owner: "worker-b", leaseMs: 1500 });
    const running = a.executor.execute((await a.queue.claim(1))[0] as Run);
    await new Promise((r) => setTimeout(r, 2000)); // past the original lease
    expect(await b.queue.claim(1)).toHaveLength(0); // heartbeat renewed it
    expect(await running).toEqual({ kind: "finished", status: "succeeded" });
    expect((await stepRows(runId))[0]).toMatchObject({ status: "succeeded", attempts: 1 });
  });
});

describe("crash safety", () => {
  it("reclaims a run whose worker died, and fences the dead worker out", async () => {
    const { flowId } = await makeFlow([{ step_id: "a", type: "WEBHOOK", params: { script: "ok" } }]);
    const runId = await makeRun(flowId);
    const a = setup({ owner: "worker-a" });
    const b = setup({ owner: "worker-b" });
    const [claimedByA] = await a.queue.claim(10);
    expect(await b.queue.claim(10)).toHaveLength(0); // lease held

    await h.db.update(runs).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(runs.id, runId)); // A crashed long ago
    const [claimedByB] = await b.queue.claim(10);
    expect(claimedByB).toMatchObject({ id: runId, lockedBy: "worker-b", attempts: 2 });

    expect(await a.executor.execute(claimedByA as Run)).toEqual({ kind: "lost" }); // A woke up: cannot finish
    expect(await b.executor.execute(claimedByB as Run)).toEqual({ kind: "finished", status: "succeeded" });
  });

  it("claims each run once across concurrent workers (SKIP LOCKED)", async () => {
    const { flowId } = await makeFlow([{ step_id: "a", type: "WEBHOOK", params: { script: "ok" } }]);
    for (let i = 0; i < 6; i++) await makeRun(flowId);
    const workers = ["w1", "w2", "w3"].map((owner) => setup({ owner }).queue);
    const claimed = (await Promise.all(workers.map((q) => q.claim(4)))).flat();
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed.map((r) => r.id)).size).toBe(6);
  });
});

describe("auto-pause", () => {
  it("pauses a flow after N consecutive failed runs and notifies the owner; a success resets the count", async () => {
    const { flowId, userId } = await makeFlow([{ step_id: "a", type: "WEBHOOK", params: { script: "permanent" } }]);
    const { queue, executor } = setup({ autoPauseAfter: 3 });
    for (let i = 0; i < 2; i++) {
      await makeRun(flowId);
      await executor.execute((await queue.claim(1))[0] as Run);
    }
    expect((await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId)))[0]?.consecutiveFailures).toBe(2);
    await makeRun(flowId);
    await executor.execute((await queue.claim(1))[0] as Run);

    const [flow] = await h.db.select().from(flows).where(eq(flows.id, flowId));
    expect(flow?.status).toBe("paused");
    expect(flow?.statusReason).toMatch(/^auto-paused: 3 consecutive failed runs — a: not found/);
    const [notice] = await h.db.select().from(ownerNotifications).where(eq(ownerNotifications.userId, userId));
    expect(notice).toMatchObject({ kind: "flow_auto_paused", flowId });
    // The owner's audit log says the system did it, and why.
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.targetId, flowId));
    expect(entry).toMatchObject({ ownerId: userId, actor: "system", action: "flow.auto_paused", details: { reason: "consecutive_failures", consecutive: 3 } });

    await h.db.update(flows).set({ status: "active" }).where(eq(flows.id, flowId));
    await h.db.update(flowVersions).set({ definition: sql`jsonb_set(definition, '{actions,0,params,script}', '"ok"')` }).where(eq(flowVersions.flowId, flowId));
    await makeRun(flowId);
    await executor.execute((await queue.claim(1))[0] as Run);
    expect((await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId)))[0]).toMatchObject({ consecutiveFailures: 0, runsFailed: 3, runsSucceeded: 1 });
  });
});

describe("connections", () => {
  it("decrypts the step's connection for the action — and refuses another owner's connection", async () => {
    const { flowId, userId } = await makeFlow([{ step_id: "tg", type: "TELEGRAM", params: { script: "secret", connection_id: "PLACEHOLDER" } }]);
    const conn = await createConnection(h.db, keyring, { ownerId: userId, type: "telegram", label: "alerts", secret: { bot_token: "123456:secret-token-value" }, metadata: { chat_id: "-100777" } });
    await h.db.update(flowVersions).set({ definition: sql`jsonb_set(definition, '{actions,0,params,connection_id}', ${JSON.stringify(conn.id)}::jsonb)` }).where(eq(flowVersions.flowId, flowId));
    const [stored] = await h.db.select().from(connections).where(eq(connections.id, conn.id));
    expect(JSON.stringify(stored?.secretEnc)).not.toContain("secret-token-value"); // encrypted at rest

    const runId = await makeRun(flowId);
    const { queue, executor } = setup();
    await executor.execute((await queue.claim(1))[0] as Run);
    expect((await stepRows(runId))[0]).toMatchObject({ status: "succeeded", output: { chat: "-100777", tokenLength: 25 } });

    const other = await makeFlow([{ step_id: "tg", type: "TELEGRAM", params: { script: "secret", connection_id: conn.id } }]);
    const stolen = await makeRun(other.flowId);
    await executor.execute((await queue.claim(1))[0] as Run);
    expect((await stepRows(stolen))[0]).toMatchObject({ status: "failed", error: `connection ${conn.id} not found` });
  });
});

describe("run.reverted notices", () => {
  it("tells each delivered webhook that the run's event was reorged out", async () => {
    const { flowId } = await makeFlow([{ step_id: "hook", type: "WEBHOOK", params: { url: "https://receiver.example/hook" } }]);
    const runId = await makeRun(flowId, { status: "succeeded", finishedAt: new Date(), revertedAt: new Date(), revertReason: "reorg" });
    await h.db.insert(runSteps).values({ runId, stepId: "hook", position: 0, actionType: "WEBHOOK", status: "succeeded", attempts: 1, finishedAt: new Date() });
    const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const http: SafeHttpClient = { request: async (req) => (sent.push({ url: req.url, body: String(req.body), headers: { ...req.headers } }), { status: 200, headers: {}, body: "", durationMs: 1 }) };
    const notifier = new Notifier({ db: h.db, keyring, http, push: null, webhookMaster: "master", actions: registry, logger: silent });

    expect(await notifier.revertNotices()).toBe(1);
    expect(sent[0]?.url).toBe("https://receiver.example/hook");
    expect(sent[0]?.headers["x-ignitra-event"]).toBe("run.reverted");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ type: "run.reverted", run_id: runId, step_id: "hook", reason: "reorg" });
    expect((await runRow(runId)).revertNotice).toMatchObject({ deliveries: [{ step_id: "hook", status: "succeeded", http_status: 200 }] });
    expect(await notifier.revertNotices()).toBe(0); // once
  });
});

describe("dead letters", () => {
  it("retries only the failed steps, with the same idempotency keys, and keeps what succeeded", async () => {
    const { flowId, userId } = await makeFlow([
      { step_id: "a", type: "WEBHOOK", params: { script: "ok" } },
      { step_id: "b", type: "WEB_PUSH", params: { script: "permanent" } },
    ]);
    const runId = await makeRun(flowId);
    const { queue, executor } = setup();
    expect(await executor.execute((await queue.claim(1))[0] as Run)).toEqual({ kind: "finished", status: "partial" });
    expect((await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId)))[0]?.runsPartial).toBe(1);

    const letters = await listDeadLetters(h.db, userId, { limit: 10 });
    expect(letters).toEqual([expect.objectContaining({ runId, flowId, flowName: "Big buys", runStatus: "partial", steps: [expect.objectContaining({ stepId: "b", actionType: "WEB_PUSH", error: "not found", attempts: 1 })] })]);
    expect(await listDeadLetters(h.db, newId("user"), { limit: 10 })).toEqual([]);

    // The owner fixes the destination, then retries.
    await h.db.update(flowVersions).set({ definition: sql`jsonb_set(definition, '{actions,1,params,script}', '"ok"')` }).where(eq(flowVersions.flowId, flowId));
    const firstKeys = calls.filter((c) => c.key.startsWith(`4663:`) && c.key.includes(flowId)).map((c) => `${c.step}=${c.key}`);
    expect(await retryRun(h.db, { runId, ownerId: userId })).toEqual({ flowId, steps: ["b"] });
    expect(await runRow(runId)).toMatchObject({ status: "queued", statusReason: "retrying b" });
    expect((await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId)))[0]?.runsPartial).toBe(0);

    const before = calls.length;
    expect(await executor.execute((await queue.claim(1))[0] as Run)).toEqual({ kind: "finished", status: "succeeded" });
    const again = calls.slice(before);
    expect(again.map((c) => c.step)).toEqual(["b"]); // "a" already succeeded: never sent twice
    expect(firstKeys).toContain(`b=${again[0]?.key}`); // the same idempotency key as the failed attempt
    expect((await stepRows(runId)).map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ["a", "succeeded", 1],
      ["b", "succeeded", 1],
    ]);
    expect((await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId)))[0]).toMatchObject({ runsPartial: 0, runsSucceeded: 1 });
    expect(await listDeadLetters(h.db, userId, { limit: 10 })).toEqual([]);
  });

  it("refuses what cannot or should not be retried", async () => {
    const { flowId, userId } = await makeFlow([{ step_id: "a", type: "WEBHOOK", params: { script: "permanent" } }]);
    const { queue, executor } = setup();
    const failed = await makeRun(flowId);
    await executor.execute((await queue.claim(1))[0] as Run);
    const code = (p: Promise<unknown>) => p.then(() => "retried", (e: unknown) => (e instanceof RetryRefusedError ? e.code : String(e)));

    expect(await code(retryRun(h.db, { runId: failed, ownerId: newId("user") }))).toBe("not_found");
    const queued = await makeRun(flowId);
    expect(await code(retryRun(h.db, { runId: queued, ownerId: userId }))).toBe("not_failed");
    const test = await makeRun(flowId, { isTest: true, status: "failed", finishedAt: new Date() });
    expect(await code(retryRun(h.db, { runId: test, ownerId: userId }))).toBe("test_run");
    const reverted = await makeRun(flowId, { status: "failed", finishedAt: new Date(), revertedAt: new Date(), revertReason: "reorg" });
    expect(await code(retryRun(h.db, { runId: reverted, ownerId: userId }))).toBe("event_reverted");
    await h.db.update(flows).set({ status: "paused" }).where(eq(flows.id, flowId));
    expect(await code(retryRun(h.db, { runId: failed, ownerId: userId }))).toBe("flow_inactive");
    await h.db.update(flows).set({ status: "active" }).where(eq(flows.id, flowId));
    expect(await code(retryRun(h.db, { runId: failed, ownerId: userId }))).toBe("retried");
    expect(await code(retryRun(h.db, { runId: failed, ownerId: userId }))).toBe("not_failed"); // already queued again
  });
});
