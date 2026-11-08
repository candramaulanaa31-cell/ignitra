import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@ignitra/core";
import { addr } from "@ignitra/chain/testing";
import { chainEvents, chainSyncStatus, chainVerification, createDb, flowStats, flowVersions, flows, runSteps, runs, users, type DbHandle } from "@ignitra/db";
import { collectMetrics, toPrometheus } from "./metrics";

/** Phase 9: operational metrics, from the database (what /metrics and `pnpm ops metrics` show). */

const CHAIN = 4663;
let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
}, 30_000);
afterAll(async () => {
  await h.close();
});

const ago = (ms: number) => new Date(Date.now() - ms);
const hex = (n: number, len = 64) => `0x${n.toString(16).padStart(len, "0")}`;

describe("metrics", () => {
  it("measures the listener, the gap detector, RPC errors, the queue, latency and outcomes", async () => {
    await h.db.insert(chainSyncStatus).values({
      chainId: CHAIN,
      owner: "test",
      headBlock: 1000,
      confirmedHead: 990,
      confirmedCursor: 980,
      watchCount: 3,
      rpc: { endpoints: [{ name: "primary", label: "rpc.mainnet", requests: 200, failures: 10, coolingDown: false }] },
      lastTickAt: ago(5_000),
    });
    await h.db.insert(chainVerification).values({ chainId: CHAIN, verifiedBlock: 970, checkedBlocks: 500, missingTotal: 2, lastMissingAt: ago(60_000) });

    const userId = newId("user");
    await h.db.insert(users).values({ id: userId, address: addr(0x123) });
    const flow = async (name: string) => {
      const id = newId("flow");
      await h.db.insert(flows).values({ id, ownerId: userId, name, status: "active", currentVersion: 1 });
      await h.db.insert(flowVersions).values({ flowId: id, version: 1, definition: { trigger: { type: "TOKEN_TRANSFER", params: {} }, actions: [], settings: { mode: "confirmed", max_runs_per_hour: 60, onchain: false } } });
      return id;
    };
    const good = await flow("Big buys");
    const bad = await flow("Broken hook");
    await h.db.insert(flowStats).values({ flowId: bad, lastError: "hook: HTTP 500" });

    let n = 0;
    const event = async (blockSecondsAgo: number) => {
      n++;
      const [row] = await h.db
        .insert(chainEvents)
        .values({ chainId: CHAIN, blockNumber: 900 + n, blockHash: hex(n), blockTimestamp: ago(blockSecondsAgo * 1000), txHash: hex(1000 + n), txIndex: 0, logIndex: 0, address: addr(0x70c), topics: [], data: "0x", status: "confirmed", confirmedAt: new Date() })
        .returning({ id: chainEvents.id });
      return row?.id as number;
    };
    const run = async (flowId: string, values: Partial<typeof runs.$inferInsert>) => {
      const id = newId("run");
      await h.db.insert(runs).values({ id, flowId, flowVersion: 1, idempotencyKey: id, triggerType: "TOKEN_TRANSFER", triggerEvent: {}, ...values });
      return id;
    };
    // Finished runs: block → finished in 4 s and 10 s.
    const r1 = await run(good, { status: "succeeded", chainEventId: await event(4), finishedAt: new Date() });
    const r2 = await run(good, { status: "succeeded", chainEventId: await event(10), finishedAt: new Date() });
    const r3 = await run(bad, { status: "failed", finishedAt: new Date() });
    await run(good, { status: "succeeded", isTest: true, finishedAt: new Date() }); // TEST runs never count
    // Waiting: one due (for a minute), one backing off, one running.
    await run(good, { status: "queued", createdAt: ago(60_000) });
    await run(good, { status: "queued", nextAttemptAt: new Date(Date.now() + 60_000) });
    await run(good, { status: "running", lockedBy: "w1", leaseUntil: new Date(Date.now() + 60_000), startedAt: new Date() });
    await h.db.insert(runSteps).values([
      { runId: r1, stepId: "a", position: 0, actionType: "WEBHOOK", status: "succeeded", attempts: 1, finishedAt: new Date() },
      { runId: r2, stepId: "a", position: 0, actionType: "WEBHOOK", status: "succeeded", attempts: 1, finishedAt: new Date() },
      { runId: r2, stepId: "b", position: 1, actionType: "TELEGRAM", status: "succeeded", attempts: 1, finishedAt: new Date() },
      { runId: r3, stepId: "a", position: 0, actionType: "WEBHOOK", status: "failed", attempts: 5, error: "HTTP 500", finishedAt: new Date() },
    ]);

    const m = await collectMetrics(h.db, CHAIN);
    expect(m.listener).toMatchObject({ head: 1000, confirmedCursor: 980, lagBlocks: 10, watches: 3 });
    expect(m.listener.lastTickAgeSeconds).toBeGreaterThanOrEqual(4);
    expect(m.gapDetector).toMatchObject({ verifiedBlock: 970, checkedBlocks: 500, missingTotal: 2 });
    expect(m.rpc).toEqual([{ endpoint: "rpc.mainnet", requests: 200, failures: 10, errorRate: 0.05, coolingDown: false }]);
    expect(m.queue).toMatchObject({ due: 1, backingOff: 1, running: 1 });
    expect(m.queue.oldestDueSeconds).toBeGreaterThanOrEqual(59);
    expect(m.latency.samples).toBe(2);
    expect(m.latency.p50Seconds).toBeGreaterThanOrEqual(6.5);
    expect(m.latency.p50Seconds).toBeLessThanOrEqual(7.5);
    expect(m.runsLastHour).toEqual({ succeeded: 2, failed: 1 });
    expect(m.stepsLastHour).toEqual([
      { actionType: "TELEGRAM", succeeded: 1, failed: 0, successRate: 1 },
      { actionType: "WEBHOOK", succeeded: 2, failed: 1, successRate: 0.667 },
    ]);
    expect(m.topFailingFlows).toEqual([{ flowId: bad, name: "Broken hook", failedRuns: 1, lastError: "hook: HTTP 500" }]);
    expect(m.deadLetters).toBe(1);

    const text = toPrometheus(m, CHAIN);
    for (const line of [
      'ignitra_listener_lag_blocks{chain="4663"} 10',
      'ignitra_gap_detector_missing_total{chain="4663"} 2',
      'ignitra_rpc_error_rate{chain="4663",endpoint="rpc.mainnet"} 0.05',
      'ignitra_queue_runs{chain="4663",state="due"} 1',
      'ignitra_step_success_rate{chain="4663",action_type="WEBHOOK"} 0.667',
      `ignitra_flow_failed_runs_last_day{chain="4663",flow_id="${bad}"} 1`,
      'ignitra_dead_letters{chain="4663"} 1',
      "# TYPE ignitra_rpc_requests_total counter",
    ]) {
      expect(text).toContain(line);
    }
  });
});
