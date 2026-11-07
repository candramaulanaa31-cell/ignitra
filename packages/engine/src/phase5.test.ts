import { and, eq } from "drizzle-orm";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, resolveChainConfig, usagePeriod } from "@ignitra/core";
import { createLogger } from "@ignitra/core/server";
import { CallRevertedError } from "@ignitra/chain";
import { FakeChain, addr } from "@ignitra/chain/testing";
import {
  consumerOffsets,
  createDb,
  flowEvaluations,
  flowStats,
  flowVersions,
  flows,
  inboundEvents,
  leases,
  ownerNotifications,
  runs,
  triggerState,
  usageMonthly,
  users,
  type DbHandle,
} from "@ignitra/db";
import { createActionModules } from "@ignitra/actions";
import { FlowValidationError, PlanLimitError, createFlow, enforcePlanFeatures, ensureUser, setFlowStatus, validateFlowDefinition, type FlowServiceDeps } from "./flows";
import { Matcher, type MatcherOptions } from "./matcher/matcher";
import { TokenInfo } from "./tokens";
import { createTriggerModules, inboundWebhookTrigger, scheduleTrigger, stateChangeTrigger, type StateChangeState } from "./triggers/index";
import type { FlowScope, InboundEventView, TriggerRuntime } from "./types";

const silent = createLogger("test", "silent");
const chainConfig = resolveChainConfig({ chainId: 4663 });
const scope: FlowScope = { flowId: "fl_test", generation: "g1" };
const hook = [{ step_id: "hook", type: "WEBHOOK", params: { url: "https://example.com/hook" } }];

/** Leaf paths of a payload: what a template or condition could reference. */
const leafPaths = (value: unknown, prefix = ""): string[] =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
    : [prefix];
const declared = (fields: ReadonlyArray<{ path: string; type: string }>, path: string) =>
  fields.some((f) => f.path === path || ((f.type === "object" || f.type === "array") && path.startsWith(`${f.path}.`)));

// ---------------------------------------------------------------------------
// SCHEDULE (module)
// ---------------------------------------------------------------------------

describe("SCHEDULE", () => {
  const params = (p: unknown) => scheduleTrigger.paramsSchema.parse(p);

  it("validates cron and timezone with readable messages", () => {
    const issues = (p: unknown) => scheduleTrigger.paramsSchema.safeParse(p).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ cron: "61 * * * *" })[0]).toMatch(/invalid cron expression: Invalid value for minute: 61/);
    expect(issues({ cron: "* * * * * *" })[0]).toMatch(/requires exactly 5 parts/); // no seconds field: minute resolution
    expect(issues({ cron: "0 9 * * *", timezone: "Mars/Olympus" })).toEqual(["must be an IANA timezone such as Asia/Jakarta or UTC"]);
    expect(issues({ cron: "0 0 30 2 *" })).toEqual(["this schedule never fires"]);
    expect(params({ cron: "0 9 * * 1-5" })).toEqual({ cron: "0 9 * * 1-5", timezone: "Asia/Jakarta" });
  });

  it("evaluates in the schedule's timezone (default WIB = UTC+7)", () => {
    const p = params({ cron: "0 9 * * *" });
    expect(scheduleTrigger.next(p, new Date("2026-11-07T01:00:00Z"))?.toISOString()).toBe("2026-11-07T02:00:00.000Z");
    expect(scheduleTrigger.latest(p, new Date("2026-11-07T02:00:00.400Z"))?.toISOString()).toBe("2026-11-07T02:00:00.000Z");
    expect(scheduleTrigger.latest(p, new Date("2026-11-07T01:59:59.999Z"))?.toISOString()).toBe("2026-11-06T02:00:00.000Z");
    const ny = params({ cron: "30 2 * * *", timezone: "America/New_York" });
    // 02:30 does not exist on 2027-03-14 (DST): it fires once, at the next valid time.
    expect(scheduleTrigger.next(ny, new Date("2027-03-14T05:00:00Z"))?.toISOString()).toBe("2027-03-14T07:30:00.000Z");
  });

  it("builds a payload with UTC, local and WIB times", () => {
    const p = params({ cron: "0 9 * * *" });
    const payload = scheduleTrigger.payload(p, new Date("2026-11-07T02:00:00Z"), new Date("2026-11-07T02:00:01.250Z"));
    expect(payload).toMatchObject({
      scheduled_at: "2026-11-07T02:00:00.000Z",
      scheduled_at_local: "2026-11-07 09:00:00 WIB",
      fired_at: "2026-11-07T02:00:01.250Z",
      delay_ms: 1250,
      next_at: "2026-11-08T02:00:00.000Z",
      time: { hour_wib: 9, minutes_wib: 540, weekday_wib: 6 },
    });
    expect(leafPaths(payload).filter((path) => !declared(scheduleTrigger.fields(p), path))).toEqual([]);
  });

  it("knows its shortest interval (plan limits)", () => {
    expect(scheduleTrigger.minIntervalMs?.(params({ cron: "*/5 * * * *" }))).toBe(300_000);
    expect(scheduleTrigger.minIntervalMs?.(params({ cron: "0,1 9 * * *" }))).toBe(60_000);
    expect(scheduleTrigger.minIntervalMs?.(params({ cron: "@daily" }))).toBe(86_400_000);
  });
});

// ---------------------------------------------------------------------------
// STATE_CHANGE (module)
// ---------------------------------------------------------------------------

describe("STATE_CHANGE", () => {
  const C = addr(0x5c);
  const abi = parseAbi(["function totalSupply() view returns (uint256)", "function boom() view returns (uint256)"]);
  const rt = (chain: FakeChain): TriggerRuntime => ({ chain: chainConfig, reader: chain, tokens: new TokenInfo(chain), logger: silent });

  function setup() {
    const chain = new FakeChain();
    chain.registerContract(C, (data, block) => {
      const call = decodeFunctionData({ abi, data });
      if (call.functionName === "boom") throw new CallRevertedError("eth_call: execution reverted");
      return encodeFunctionResult({ abi, functionName: "totalSupply", result: block >= 5 ? 1500n : 1000n });
    });
    chain.mineEmpty(2);
    return chain;
  }

  it("resolves a bare function name at save time and validates arguments", async () => {
    const p = await stateChangeTrigger.prepare?.(stateChangeTrigger.paramsSchema.parse({ address: C, function: "totalSupply" }), { abis: null });
    expect(p?.function).toBe("function totalSupply() view returns (uint256)");
    await expect(stateChangeTrigger.prepare?.(stateChangeTrigger.paramsSchema.parse({ address: C, function: "balanceOf", args: ["0x12"] }), { abis: null })).rejects.toThrow(
      /not a valid address/,
    );
  });

  it("samples a baseline, then fires once per change with previous / current / delta", async () => {
    const chain = setup();
    const p = stateChangeTrigger.paramsSchema.parse({ address: C, function: "function totalSupply() view returns (uint256)" });
    const at = async (n: number) => (await chain.blockByNumber(n))!;
    const first = await stateChangeTrigger.poll({ params: p, state: null, block: await at(2), scope }, rt(chain));
    expect(first).toEqual({ state: { value: "1000", block: 2, sampled: 2 }, outcomes: [] });

    chain.mineEmpty(1);
    const same = await stateChangeTrigger.poll({ params: p, state: first.state, block: await at(3), scope }, rt(chain));
    expect(same.outcomes).toEqual([]);
    expect(same.state).toEqual({ value: "1000", block: 2, sampled: 3 });
    expect((await stateChangeTrigger.poll({ params: p, state: same.state, block: await at(3), scope }, rt(chain))).state).toBeNull(); // never backwards

    chain.mineEmpty(2);
    const changed = await stateChangeTrigger.poll({ params: p, state: same.state as StateChangeState, block: await at(5), scope }, rt(chain));
    expect(changed.outcomes).toEqual([
      expect.objectContaining({
        kind: "match",
        key: "state:5",
        payload: expect.objectContaining({ previous: "1000", current: "1500", delta: "500", previous_block: 2, contract: C, function: { name: "totalSupply", signature: "totalSupply()" } }),
      }),
    ]);
    const outcome = changed.outcomes[0];
    const fields = stateChangeTrigger.fields(p);
    expect(fields.find((f) => f.path === "current")?.type).toBe("uint");
    expect(leafPaths(outcome?.kind === "match" ? outcome.payload : {}).filter((path) => !declared(fields, path))).toEqual([]);
  });

  it("records a reverting call as undetermined, never as a change", async () => {
    const chain = setup();
    const p = stateChangeTrigger.paramsSchema.parse({ address: C, function: "function boom() view returns (uint256)" });
    const r = await stateChangeTrigger.poll({ params: p, state: { value: "1", block: 1, sampled: 1 }, block: (await chain.blockByNumber(2))!, scope }, rt(chain));
    expect(r.state).toBeNull();
    expect(r.outcomes).toEqual([expect.objectContaining({ kind: "undetermined", key: "state:2", reason: "call reverted" })]);
  });
});

// ---------------------------------------------------------------------------
// INBOUND_WEBHOOK (module)
// ---------------------------------------------------------------------------

describe("INBOUND_WEBHOOK", () => {
  it("turns a stored request into a payload keyed by its idempotency key", () => {
    const event: InboundEventView = {
      id: 1,
      requestId: "req_01",
      flowId: "fl_1",
      dedupeKey: "order-42",
      idempotencyKey: "order-42",
      contentType: "application/json",
      body: { amount: 12.5, customer: { tier: "gold" } },
      query: { source: "shop" },
      headers: { user_agent: "curl/8" },
      bytes: 40,
      receivedAt: new Date("2026-11-07T02:00:00Z"),
    };
    const outcome = inboundWebhookTrigger.match(event, {});
    expect(outcome).toMatchObject({ kind: "match", key: "inbound:order-42", payload: { request_id: "req_01", body: { amount: 12.5 }, time: { hour_wib: 9 } } });
    const fields = inboundWebhookTrigger.fields({});
    expect(leafPaths(outcome?.kind === "match" ? outcome.payload : {}).filter((path) => !declared(fields, path))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Matcher + flow service on Postgres (PGlite)
// ---------------------------------------------------------------------------

let h: DbHandle;
let deps: FlowServiceDeps;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
  deps = { db: h.db, chainId: 4663, triggers: createTriggerModules(), prepare: { abis: null } };
}, 30_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  for (const t of [runs, flowEvaluations, flowStats, triggerState, inboundEvents, consumerOffsets, leases, ownerNotifications, usageMonthly]) await h.db.delete(t);
  await h.db.delete(flows);
  await h.db.delete(users);
});

function matcher(options: MatcherOptions = {}): Matcher {
  const chain = new FakeChain();
  return new Matcher({
    db: h.db,
    chain: chainConfig,
    reader: chain,
    tokens: new TokenInfo(chain),
    triggers: deps.triggers,
    logger: silent,
    owner: `m-${Math.random()}`,
    options: { flowsCacheMs: 0, evaluationsPerMinute: 10_000, ...options },
  });
}

const flowRuns = (flowId: string) => h.db.select().from(runs).where(eq(runs.flowId, flowId));
const evaluations = (flowId: string) => h.db.select().from(flowEvaluations).where(eq(flowEvaluations.flowId, flowId));

/** SCHEDULE is a Builder feature (spec §10). */
async function builder(address: string): Promise<string> {
  const id = await ensureUser(h.db, address);
  await h.db.update(users).set({ plan: "builder" }).where(eq(users.id, id));
  return id;
}

/** Pins activation and version time, so schedule eligibility is deterministic. */
async function pinTimes(flowId: string, at: number): Promise<void> {
  await h.db.update(flows).set({ activatedAt: new Date(at) }).where(eq(flows.id, flowId));
  await h.db.update(flowVersions).set({ createdAt: new Date(at) }).where(eq(flowVersions.flowId, flowId));
}

describe("matcher: schedules", () => {
  const T0 = Date.UTC(2026, 10, 7, 0, 5, 0); // 00:05 UTC
  const quarterHourly = { trigger: { type: "SCHEDULE", params: { cron: "*/15 * * * *", timezone: "UTC" } }, actions: hook };

  it("fires each scheduled time once; after downtime only the latest fires and the rest are recorded as missed", async () => {
    const owner = await builder(addr(0xa1));
    const { flowId } = await createFlow(deps, { ownerId: owner, name: "Quarter-hourly", definition: quarterHourly, activate: true });
    await pinTimes(flowId, T0);
    let clock = T0 + 60_000;
    const m = matcher({ now: () => clock });

    await m.tick();
    expect(await flowRuns(flowId)).toHaveLength(0); // 00:00 was before activation

    clock = Date.UTC(2026, 10, 7, 0, 15, 1);
    expect((await m.tick()).scheduled).toEqual({ flows: 1, runs: 1, errors: 0 });
    await m.tick();
    const [first] = await flowRuns(flowId);
    expect(first?.idempotencyKey).toBe(`4663:schedule:2026-11-07T00:15:00.000Z:${flowId}`);
    expect(first?.triggerEvent).toMatchObject({ scheduled_at: "2026-11-07T00:15:00.000Z", delay_ms: 1000 });
    expect(await flowRuns(flowId)).toHaveLength(1);

    clock = Date.UTC(2026, 10, 7, 2, 20, 0); // down from 00:15 to 02:20
    await m.tick();
    const keys = (await flowRuns(flowId)).map((r) => r.idempotencyKey).sort();
    expect(keys).toEqual([`4663:schedule:2026-11-07T00:15:00.000Z:${flowId}`, `4663:schedule:2026-11-07T02:15:00.000Z:${flowId}`]);
    const [missed] = await evaluations(flowId);
    expect(missed).toMatchObject({ outcome: "missed", reason: expect.stringMatching(/^7 scheduled time\(s\) from 2026-11-07T00:30:00.000Z passed/) });
    const [stats] = await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId));
    expect(stats).toMatchObject({ runs: 2, missed: 1 });

    // A restarted matcher (empty caches) resumes from the stored last time: nothing fires twice.
    await matcher({ now: () => clock }).tick().catch(() => null);
    await h.db.delete(leases);
    await matcher({ now: () => clock }).tick();
    expect(await flowRuns(flowId)).toHaveLength(2);
  });

  it("does not fire a time that is older than the grace window", async () => {
    const owner = await builder(addr(0xa2));
    const { flowId } = await createFlow(deps, { ownerId: owner, name: "Late", definition: quarterHourly, activate: true });
    await pinTimes(flowId, T0);
    const m = matcher({ now: () => Date.UTC(2026, 10, 7, 0, 21, 0), scheduleGraceMs: 60_000 });
    await m.tick();
    expect(await flowRuns(flowId)).toHaveLength(0);
    expect((await evaluations(flowId))[0]).toMatchObject({ outcome: "missed", reason: expect.stringMatching(/beyond the 1m grace window/) });
  });

  it("skips times that passed while the flow was paused (eligibility starts at re-activation)", async () => {
    const owner = await builder(addr(0xa3));
    const { flowId } = await createFlow(deps, { ownerId: owner, name: "Paused", definition: quarterHourly, activate: true });
    await pinTimes(flowId, T0);
    await h.db.update(flows).set({ activatedAt: new Date(Date.UTC(2026, 10, 7, 1, 7, 0)) }).where(eq(flows.id, flowId)); // resumed 01:07
    const m = matcher({ now: () => Date.UTC(2026, 10, 7, 1, 10, 0) });
    await m.tick();
    expect(await flowRuns(flowId)).toHaveLength(0);
    expect(await evaluations(flowId)).toHaveLength(0);
  });
});

describe("matcher: inbound webhooks", () => {
  async function inboundFlow(conditions?: unknown) {
    const owner = await ensureUser(h.db, addr(0xb1));
    const definition = { trigger: { type: "INBOUND_WEBHOOK", params: {} }, ...(conditions ? { conditions } : {}), actions: hook };
    const { flowId } = await createFlow(deps, { ownerId: owner, name: "Inbound", definition, activate: true });
    return { owner, flowId };
  }
  const receive = (flowId: string, body: unknown, opts: { key?: string; receivedAt?: Date } = {}) => {
    const requestId = newId("inboundRequest");
    return h.db.insert(inboundEvents).values({ requestId, flowId, dedupeKey: opts.key ?? requestId, contentType: "application/json", body, bytes: 10, ...(opts.receivedAt ? { receivedAt: opts.receivedAt } : {}) });
  };

  it("turns stored requests into runs, conditions on body paths included", async () => {
    const { flowId } = await inboundFlow({ all: [{ field: "body.amount", op: ">", value: 10 }] });
    await receive(flowId, { amount: 5 });
    await receive(flowId, { amount: 50, order: "A-1" }, { key: "order-A-1" });
    const report = await matcher().tick();
    expect(report.inbound).toMatchObject({ processed: 2, runs: 1 });
    const [run] = await flowRuns(flowId);
    expect(run).toMatchObject({ idempotencyKey: `4663:inbound:order-A-1:${flowId}`, triggerType: "INBOUND_WEBHOOK", triggerEvent: { body: { amount: 50 }, idempotency_key: "order-A-1" } });
    expect((await evaluations(flowId))[0]).toMatchObject({ outcome: "conditions_failed" });
  });

  it("ignores requests received before the flow was (re)activated", async () => {
    const { flowId } = await inboundFlow();
    await receive(flowId, { early: true }, { receivedAt: new Date(Date.now() - 3_600_000) });
    await matcher().tick();
    expect(await flowRuns(flowId)).toHaveLength(0);
  });
});

describe("plan limits", () => {
  const period = usagePeriod(new Date());

  it("free plan: stops creating runs at the monthly quota, records plan_limited and tells the owner once", async () => {
    const owner = await ensureUser(h.db, addr(0xc1));
    const { flowId } = await createFlow(deps, { ownerId: owner, name: "Quota", definition: { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: hook }, activate: true });
    await h.db.insert(usageMonthly).values({ userId: owner, period, runs: 499 });
    for (let i = 0; i < 3; i++) await h.db.insert(inboundEvents).values({ requestId: newId("inboundRequest"), flowId, dedupeKey: `k${i}`, body: { i }, bytes: 1 });
    const m = matcher();
    await m.tick();

    expect(await flowRuns(flowId)).toHaveLength(1);
    const [usage] = await h.db.select().from(usageMonthly).where(and(eq(usageMonthly.userId, owner), eq(usageMonthly.period, period)));
    expect(usage).toMatchObject({ runs: 500, planLimited: 2 });
    expect((await evaluations(flowId)).map((e) => e.outcome)).toEqual(["plan_limited", "plan_limited"]);
    expect((await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId)))[0]).toMatchObject({ runs: 1, planLimited: 2 });

    await h.db.insert(inboundEvents).values({ requestId: newId("inboundRequest"), flowId, dedupeKey: "k3", body: {}, bytes: 1 });
    await m.tick();
    const notices = await h.db.select().from(ownerNotifications).where(eq(ownerNotifications.userId, owner));
    expect(notices.map((n) => n.kind)).toEqual(["plan_runs_exhausted"]);
    expect(notices[0]?.message).toMatch(/All 500 runs of the free plan are used/);

    // Replaying the stream (lost offset) creates nothing and meters nothing.
    await h.db.delete(consumerOffsets);
    await m.tick();
    expect(await flowRuns(flowId)).toHaveLength(1);
    expect((await h.db.select().from(usageMonthly).where(eq(usageMonthly.userId, owner)))[0]?.runs).toBe(500);
  });

  it("paid plans keep running past the quota and meter the overage", async () => {
    const owner = await ensureUser(h.db, addr(0xc2));
    await h.db.update(users).set({ plan: "builder" }).where(eq(users.id, owner));
    const { flowId } = await createFlow(deps, { ownerId: owner, name: "Overage", definition: { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: hook }, activate: true });
    await h.db.insert(usageMonthly).values({ userId: owner, period, runs: 10_000 });
    for (let i = 0; i < 2; i++) await h.db.insert(inboundEvents).values({ requestId: newId("inboundRequest"), flowId, dedupeKey: `p${i}`, body: {}, bytes: 1 });
    await matcher().tick();
    expect(await flowRuns(flowId)).toHaveLength(2);
    expect((await h.db.select().from(usageMonthly).where(eq(usageMonthly.userId, owner)))[0]?.runs).toBe(10_002);
  });

  it("caps active flows per plan, on create and on resume", async () => {
    const owner = await ensureUser(h.db, addr(0xc3));
    const def = { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: hook };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createFlow(deps, { ownerId: owner, name: `F${i}`, definition: def, activate: true })).flowId);
    await expect(createFlow(deps, { ownerId: owner, name: "F3", definition: def, activate: true })).rejects.toThrow(PlanLimitError);
    const paused = await createFlow(deps, { ownerId: owner, name: "F3", definition: def });
    await expect(setFlowStatus(deps, paused.flowId, "active")).rejects.toThrow(/free plan allows 3 active flows \(you have 3\)/);
    await setFlowStatus(deps, ids[0] as string, "paused");
    await setFlowStatus(deps, paused.flowId, "active");
    await setFlowStatus(deps, paused.flowId, "active"); // already active: no double counting
    await h.db.update(users).set({ plan: "team" }).where(eq(users.id, owner));
    await setFlowStatus(deps, ids[0] as string, "active");
  });

  it("pauses flows that use features a downgraded plan does not include", async () => {
    const owner = await builder(addr(0xc5));
    const scheduled = await createFlow(deps, { ownerId: owner, name: "Daily", definition: { trigger: { type: "SCHEDULE", params: { cron: "0 9 * * *" } }, actions: hook }, activate: true });
    const hooked = await createFlow(deps, { ownerId: owner, name: "Hook", definition: { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: hook }, activate: true });
    expect(await enforcePlanFeatures(h.db, owner)).toEqual([]); // still on builder
    await h.db.update(users).set({ plan: "free" }).where(eq(users.id, owner));
    expect(await enforcePlanFeatures(h.db, owner)).toEqual([scheduled.flowId]);
    const rows = await h.db.select().from(flows).where(eq(flows.ownerId, owner));
    expect(rows.find((f) => f.id === scheduled.flowId)).toMatchObject({ status: "paused", statusReason: "paused: the free plan does not include SCHEDULE" });
    expect(rows.find((f) => f.id === hooked.flowId)?.status).toBe("active");
    expect((await h.db.select().from(ownerNotifications).where(eq(ownerNotifications.userId, owner))).map((n) => n.kind)).toEqual(["flow_plan_paused"]);
  });

  it("keeps Builder features (schedule, email, Sheets) off the free plan", async () => {
    const owner = await ensureUser(h.db, addr(0xc4));
    const schedule = (cron: string) => ({ trigger: { type: "SCHEDULE", params: { cron } }, actions: hook });
    const issues = async (def: unknown) =>
      ((await validateFlowDefinition(def, deps, owner).catch((e: unknown) => e)) as FlowValidationError).issues?.map((i) => `${i.path}: ${i.message}`) ?? [];
    expect(await issues(schedule("0 9 * * *"))).toEqual(["trigger.type: SCHEDULE needs the builder plan (you are on free)"]);
    const withActions = { db: h.db, chainId: 4663, triggers: deps.triggers, prepare: deps.prepare, actions: createActionModules() };
    const def = { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: [{ step_id: "mail", type: "EMAIL", params: { connection_id: `conn_${"0".repeat(26)}`, subject: "s", body: "b" } }] };
    const error = (await validateFlowDefinition(def, withActions, owner).catch((e: unknown) => e)) as FlowValidationError;
    expect(error.issues.map((i) => i.message)).toContain("EMAIL needs the builder plan (you are on free)");
    await h.db.update(users).set({ plan: "builder" }).where(eq(users.id, owner));
    await validateFlowDefinition(schedule("* * * * *"), deps, owner); // minute resolution on paid plans
  });
});
