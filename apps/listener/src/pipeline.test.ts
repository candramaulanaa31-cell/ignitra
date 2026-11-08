import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChainConfig } from "@ignitra/core";
import { createLogger } from "@ignitra/core/server";
import { EventDecoder } from "@ignitra/chain";
import { FakeChain, addr, type FakeErc20 } from "@ignitra/chain/testing";
import {
  auditLog,
  chainCursors,
  chainEvents,
  chainSyncStatus,
  consumerOffsets,
  createDb,
  flowEvaluations,
  flowStats,
  flows,
  inboundEvents,
  leases,
  runs,
  users,
  watches,
  type DbHandle,
} from "@ignitra/db";
import { Matcher, TokenInfo, createFlow, createTriggerModules, ensureUser, setFlowStatus, type FlowServiceDeps, type TrustLookup } from "@ignitra/engine";
import { ListenerStore } from "./store";
import { ChainSync } from "./sync";

/**
 * End-to-end: FakeChain → ChainSync (real ingestion) → chain_events → Matcher → runs.
 * Block timestamps follow the wall clock so activation-time filtering is real.
 */

const silent = createLogger("test", "silent");
const chainConfig = resolveChainConfig({ chainId: 4663 });
const TOKEN = addr(0x70c);
const WHALE = addr(0x3a1e);
const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const CAROL = addr(0xca201);
const SUPPLY = 1_000_000_000_000n; // 1,000,000 tokens at 6 decimals

let h: DbHandle;
let owner: string;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  for (const t of [runs, flowEvaluations, flowStats, chainEvents, chainCursors, watches, leases, chainSyncStatus, consumerOffsets]) await h.db.delete(t);
  await h.db.delete(flows);
  await h.db.delete(users);
  owner = await ensureUser(h.db, ALICE);
});

interface Pipeline {
  chain: FakeChain;
  token: FakeErc20;
  sync: ChainSync;
  matcher: Matcher;
  deps: FlowServiceDeps;
  /** One listener tick, then one matcher tick. */
  step(): Promise<void>;
  /** Mine `n` empty blocks so earlier blocks reach confirmation depth, then step. */
  confirm(n?: number): Promise<void>;
}

async function pipeline(opts: { stateWindow?: number; trust?: TrustLookup; flowsCacheMs?: number } = {}): Promise<Pipeline> {
  let clockOffset = 0;
  // logTimestamps: false mirrors Robinhood Chain's RPC, whose logs carry blockTimestamp "0x0".
  const chain = new FakeChain({ logTimestamps: false, timestampOf: () => Math.floor(Date.now() / 1000) + clockOffset, ...(opts.stateWindow ? { stateWindow: opts.stateWindow } : {}) });
  const token = chain.token(TOKEN, { symbol: "USDG", decimals: 6 });
  token.seed(WHALE, SUPPLY);
  const triggers = createTriggerModules();
  const sync = new ChainSync({
    reader: chain,
    store: new ListenerStore(h.db, { chainId: 4663, owner: "listener-test" }),
    decoder: new EventDecoder(),
    abis: null,
    logger: silent,
    options: { strategy: "depth", depth: 3, maxRange: 100, addressChunk: 100, rewindBlocks: 50, startBlock: 0 },
  });
  const matcher = new Matcher({
    db: h.db,
    chain: chainConfig,
    reader: chain,
    tokens: new TokenInfo(chain),
    triggers,
    logger: silent,
    owner: "matcher-test",
    options: { pollIntervalMs: 0, flowsCacheMs: opts.flowsCacheMs ?? 0, evaluationsPerMinute: 10_000 },
    ...(opts.trust ? { trust: opts.trust } : {}),
  });
  const p: Pipeline = {
    chain,
    token,
    sync,
    matcher,
    deps: { db: h.db, chainId: 4663, triggers, prepare: { abis: null } },
    async step() {
      await sync.tick();
      await matcher.tick();
    },
    async confirm(n = 3) {
      chain.mineEmpty(n);
      await p.step();
    },
  };
  // Initialize listener cursors and matcher offsets before any test activity.
  await p.step();
  void clockOffset;
  return p;
}

// Runs of one batch share created_at (same transaction): order by the on-chain event, then id.
const allRuns = () => h.db.select().from(runs).orderBy(asc(runs.createdAt), asc(runs.chainEventId), asc(runs.id));

async function flow(p: Pipeline, definition: Record<string, unknown>, name = "test flow") {
  const created = await createFlow(p.deps, {
    ownerId: owner,
    name,
    activate: true,
    definition: { actions: [{ step_id: "notify", type: "WEBHOOK", params: { url: "https://example.com/hook" } }], ...definition },
  });
  return created.flowId;
}

describe("events → queued runs", () => {
  it("creates a run with evidence and a per-condition trace; failing events are counted and sampled", async () => {
    const p = await pipeline();
    const flowId = await flow(p, {
      trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
      conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 0.5 }] },
    });
    p.chain.mine([p.token.transfer(WHALE, BOB, SUPPLY / 100n), p.token.transfer(WHALE, CAROL, SUPPLY / 1000n)]); // 1% and 0.1%
    await p.confirm();

    const [run, ...rest] = await allRuns();
    expect(rest).toHaveLength(0);
    const log = p.chain.block(1)?.logs[0];
    expect(run).toMatchObject({
      flowId,
      flowVersion: 1,
      status: "queued",
      isTest: false,
      triggerType: "TOKEN_TRANSFER",
      idempotencyKey: `4663:${log?.txHash}:0:${flowId}`,
      conditionsResult: [{ path: "all.0", field: "percent_of_supply", op: ">=", expected: 0.5, actual: 1, passed: true }],
      triggerEvent: expect.objectContaining({ to: BOB, amount_decimal: "10000", amount_formatted: "10,000", percent_of_supply: 1, token: expect.objectContaining({ symbol: "USDG" }) }),
    });
    expect(run?.chainEventId).toEqual(expect.any(Number));

    const [evaluation] = await h.db.select().from(flowEvaluations);
    expect(evaluation).toMatchObject({ outcome: "conditions_failed", conditionsResult: [expect.objectContaining({ actual: 0.1, passed: false })] });
    const [stats] = await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId));
    expect(stats).toMatchObject({ matched: 2, runs: 1, conditionsFailed: 1, rateLimited: 0 });
  });

  it("never creates a second run for the same event — even when a stream is replayed", async () => {
    const p = await pipeline();
    await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } } });
    p.chain.mine([p.token.transfer(WHALE, BOB, 1n)]);
    await p.confirm();
    expect(await allRuns()).toHaveLength(1);
    await h.db.update(consumerOffsets).set({ position: 0 }).where(sql`${consumerOffsets.name} like 'matcher:4663:confirmed'`);
    await p.matcher.tick();
    expect(await allRuns()).toHaveLength(1); // DB unique key on chain_id:tx_hash:log_index:flow_id
  });

  it("ignores events from before activation and from paused flows", async () => {
    const p = await pipeline();
    const flowId = await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } } });
    await setFlowStatus(p.deps, flowId, "paused");
    p.chain.mine([p.token.transfer(WHALE, BOB, 1n)]);
    await p.confirm();
    expect(await allRuns()).toHaveLength(0);

    // Re-activate one second later: an event mined BEFORE activation (old timestamp) must not count.
    await new Promise((r) => setTimeout(r, 1100));
    await setFlowStatus(p.deps, flowId, "active");
    p.chain.mine([p.token.transfer(WHALE, CAROL, 2n)]);
    await p.confirm();
    expect((await allRuns()).map((r) => (r.triggerEvent as { to: string }).to)).toEqual([CAROL]);
  });
});

describe("flows activated a moment ago", () => {
  it("never loses an event or request that arrives while the matcher's flow index is cached", async () => {
    // The index was loaded (empty) during setup and stays cached for the whole test.
    const p = await pipeline({ flowsCacheMs: 60_000 });
    const confirmed = await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } } }, "confirmed");
    const fast = await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } }, settings: { mode: "fast" } }, "fast");
    p.chain.mine([p.token.transfer(WHALE, BOB, 5n)]);
    await p.confirm();
    const byFlow = async (id: string) => (await allRuns()).filter((r) => r.flowId === id);
    expect(await byFlow(fast)).toHaveLength(1);
    expect(await byFlow(confirmed)).toHaveLength(1);

    // A request sent right after its flow was created (an SDK client does exactly this).
    const hook = await flow(p, { trigger: { type: "INBOUND_WEBHOOK", params: {} } }, "hook");
    await h.db.insert(inboundEvents).values({ requestId: "req_fresh", flowId: hook, dedupeKey: "k-fresh", body: { order: "A-1" }, bytes: 15 });
    await p.matcher.tick();
    expect(await byFlow(hook)).toHaveLength(1);
  });
});

describe("fast mode and reorgs", () => {
  it("runs at head; a reorg cancels the queued run", async () => {
    const p = await pipeline();
    await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } }, settings: { mode: "fast" } });
    p.chain.mine([p.token.transfer(WHALE, BOB, 5n)]);
    await p.step();
    const [atHead] = await allRuns();
    expect(atHead).toMatchObject({ status: "queued", triggerEvent: expect.objectContaining({ event_status: "pending" }) });

    p.chain.reorg(1, [[]]);
    await p.confirm();
    const [after] = await allRuns();
    expect(after).toMatchObject({ id: atHead?.id, status: "skipped", statusReason: "event_reverted", revertReason: "reorg" });
    expect(after?.revertedAt).toBeInstanceOf(Date);
    expect(after?.finishedAt).toBeInstanceOf(Date);
  });

  it("keeps the run when the same transaction lands in another block (moved, not reverted)", async () => {
    const p = await pipeline();
    await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } }, settings: { mode: "fast" } });
    const spec = p.token.transfer(WHALE, BOB, 7n);
    p.chain.mine([spec]);
    await p.step();
    const txHash = p.chain.block(1)?.logs[0]?.txHash;
    const [atHead] = await allRuns();

    const { effect, ...log } = spec; // the balance effect already happened on the first fork
    void effect;
    p.chain.reorg(1, [[], [{ ...log, ...(txHash ? { txHash } : {}) }]]); // same tx, one block later, same log index
    await p.confirm();
    const rows = await allRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: atHead?.id, status: "queued", revertedAt: null });
    const [canonical] = await h.db.select().from(chainEvents).where(eq(chainEvents.status, "confirmed"));
    expect(rows[0]?.chainEventId).toBe(canonical?.id);
  });

  it("marks runs of a confirmed event that a deep reorg removed", async () => {
    const p = await pipeline();
    await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } } });
    p.chain.mine([p.token.transfer(WHALE, BOB, 9n)]);
    await p.confirm();
    expect(await allRuns()).toMatchObject([{ status: "queued" }]);

    p.chain.reorg(4, [[], [], [], []]);
    await p.step();
    expect(await allRuns()).toMatchObject([{ status: "skipped", statusReason: "event_reverted", revertReason: "deep_reorg" }]);
  });
});

describe("batching", () => {
  it("never splits a block across matcher batches (NEW_HOLDER stays exact)", async () => {
    const p = await pipeline();
    const X = addr(0xee);
    const A = addr(0xaa);
    p.token.seed(X, 5n);
    p.token.seed(A, 5n);
    const small = new Matcher({
      db: h.db,
      chain: chainConfig,
      reader: p.chain,
      tokens: new TokenInfo(p.chain),
      triggers: createTriggerModules(),
      logger: silent,
      owner: "matcher-test", // same lease owner as the pipeline's matcher
      options: { batchSize: 2, pollIntervalMs: 0, flowsCacheMs: 0 },
    });
    await flow(p, { trigger: { type: "NEW_HOLDER", params: { token: TOKEN } } });
    // X empties, then (same block) receives again → X is a new holder. A batch boundary
    // between the two would seed X after its outflow and miss it.
    p.chain.mine([p.token.transfer(X, BOB, 5n), p.token.transfer(WHALE, CAROL, 1n), p.token.transfer(A, X, 2n)]);
    p.chain.mineEmpty(3);
    await p.sync.tick();
    const report = await small.tick();
    expect(report.confirmed?.processed).toBe(3); // whole block in one batch despite batchSize 2
    expect((await allRuns()).map((r) => (r.triggerEvent as { holder: string }).holder)).toEqual([BOB, CAROL, X]);
  });
});

describe("runaway protection", () => {
  it("enforces max_runs_per_hour and auto-pauses a flow far above its cap", async () => {
    const p = await pipeline();
    const flowId = await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } }, settings: { max_runs_per_hour: 2 } });
    p.chain.mine(Array.from({ length: 8 }, (_, i) => p.token.transfer(WHALE, BOB, BigInt(i + 1))));
    await p.confirm();

    expect(await allRuns()).toHaveLength(2);
    const [stats] = await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId));
    expect(stats).toMatchObject({ matched: 8, runs: 2, rateLimited: 6 });
    expect(await h.db.select().from(flowEvaluations).where(eq(flowEvaluations.outcome, "rate_limited"))).toHaveLength(6);
    const [paused] = await h.db.select().from(flows).where(eq(flows.id, flowId));
    expect(paused?.status).toBe("paused");
    expect(paused?.statusReason).toMatch(/auto-paused: 6 matching events dropped .* max_runs_per_hour=2/);
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.targetId, flowId));
    expect(entry).toMatchObject({ actor: "system", action: "flow.auto_paused", details: { reason: "runaway" } });

    p.chain.mine([p.token.transfer(WHALE, BOB, 100n)]);
    await p.confirm();
    expect(await allRuns()).toHaveLength(2);
  });
});

describe("other triggers end-to-end", () => {
  it("NEW_HOLDER fires once per new holder from real ingestion", async () => {
    const p = await pipeline();
    await flow(p, { trigger: { type: "NEW_HOLDER", params: { token: TOKEN } } });
    p.chain.mine([p.token.transfer(WHALE, BOB, 10n), p.token.transfer(WHALE, BOB, 10n), p.token.transfer(BOB, CAROL, 5n)]);
    await p.confirm();
    expect((await allRuns()).map((r) => (r.triggerEvent as { holder: string }).holder)).toEqual([BOB, CAROL]);
  });

  it("BALANCE_THRESHOLD samples at the confirmed cursor and fires on the crossing", async () => {
    const p = await pipeline();
    const wallet = addr(0x7ea5);
    p.chain.setNativeBalance(wallet, 3n * 10n ** 18n);
    const flowId = await flow(p, { trigger: { type: "BALANCE_THRESHOLD", params: { wallet, asset: "native", threshold: "2" } } });
    await p.confirm(); // first sample: establishes "above"
    expect(await allRuns()).toHaveLength(0);

    p.chain.setNativeBalance(wallet, 15n * 10n ** 17n);
    await p.confirm(4);
    const [run] = await allRuns();
    const cursor = (await h.db.select().from(chainCursors).where(eq(chainCursors.stream, "confirmed")))[0]?.blockNumber;
    expect(run).toMatchObject({
      triggerType: "BALANCE_THRESHOLD",
      idempotencyKey: `4663:balance:${cursor}:${flowId}`,
      triggerEvent: expect.objectContaining({ direction: "below", balance_after_decimal: "1.5", threshold: "2", token: expect.objectContaining({ symbol: "ETH" }) }),
    });
    await p.confirm();
    expect(await allRuns()).toHaveLength(1); // still below: no repeat
  });
});

describe("TRUST LAYER conditions", () => {
  it("runs only for counterparties scored at or above the bar; pending and failing ones are traced, never guessed", async () => {
    const asked: string[] = [];
    const scores: Record<string, { status: "scored" | "pending"; score: number | null; band: string | null }> = {
      [ALICE]: { status: "scored", score: 812, band: "strong" },
      [BOB]: { status: "scored", score: 190, band: "severe_risk" },
      [CAROL]: { status: "pending", score: null, band: null },
    };
    const trust: TrustLookup = {
      async score(address) {
        asked.push(address);
        const r = scores[address];
        return r ? { ...r, risk_level: null } : { status: "unavailable", score: null, band: null, risk_level: null };
      },
    };
    const p = await pipeline({ trust });
    const gated = await flow(p, {
      trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN, wallet: WHALE, direction: "out" } },
      conditions: { all: [{ field: "amount_decimal", op: ">=", value: "1" }, { field: "counterparty_trust_score", op: ">=", value: 600 }] },
    });
    // A flow that never reads a score must never cause a lookup.
    const plain = await flow(p, { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } } }, "plain");
    p.chain.mine([p.token.transfer(WHALE, ALICE, 5_000_000n), p.token.transfer(WHALE, BOB, 5_000_000n), p.token.transfer(WHALE, CAROL, 5_000_000n), p.token.transfer(WHALE, ALICE, 1n)]);
    await p.confirm();

    const gatedRuns = (await allRuns()).filter((r) => r.flowId === gated);
    expect(gatedRuns).toHaveLength(1);
    expect(gatedRuns[0]?.triggerEvent).toMatchObject({ to: ALICE, counterparty: ALICE, counterparty_trust_score: 812, counterparty_trust_band: "strong", counterparty_trust_status: "scored" });
    expect((await allRuns()).filter((r) => r.flowId === plain)).toHaveLength(4);
    expect((await allRuns()).find((r) => r.flowId === plain)?.triggerEvent).not.toHaveProperty("counterparty_trust_score");

    const evaluations = await h.db.select().from(flowEvaluations).where(eq(flowEvaluations.flowId, gated));
    const byTo = Object.fromEntries(evaluations.map((e) => [(e.triggerEvent as { to: string }).to + ":" + (e.triggerEvent as { amount: string }).amount, e.triggerEvent as Record<string, unknown>]));
    expect(byTo[`${BOB}:5000000`]).toMatchObject({ counterparty_trust_score: 190, counterparty_trust_status: "scored" });
    expect(byTo[`${CAROL}:5000000`]).toMatchObject({ counterparty_trust_score: null, counterparty_trust_status: "pending" });
    // The 0.000001 transfer fails the amount condition: no lookup at all.
    expect(byTo[`${ALICE}:1`]).toMatchObject({ counterparty_trust_status: "skipped", counterparty_trust_score: null });
    expect(asked.sort()).toEqual([ALICE, BOB, CAROL].sort());
  });
});
