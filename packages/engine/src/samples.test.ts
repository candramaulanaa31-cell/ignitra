import { decodeFunctionData, encodeFunctionResult, getContractAddress, parseAbi } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, normalizeAddress, resolveChainConfig } from "@ignitra/core";
import { createLogger } from "@ignitra/core/server";
import { FakeChain, addr } from "@ignitra/chain/testing";
import { createDb, inboundEvents, runs, type DbHandle } from "@ignitra/db";
import { TEST_RUNS_PER_HOUR, TestRunLimitError, createFlow, ensureUser, queueTestRun } from "./flows";
import { sampleTrigger } from "./samples";
import { TokenInfo } from "./tokens";
import { createTriggerModules } from "./triggers/index";
import type { TriggerRuntime } from "./types";

const chainConfig = resolveChainConfig({ chainId: 4663 });
const triggers = createTriggerModules();
const TOKEN = addr(0x70c);
const WHALE = addr(0x3a1e);
const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const rt = (chain: FakeChain): TriggerRuntime => ({ chain: chainConfig, reader: chain, tokens: new TokenInfo(chain), logger: createLogger("test", "silent") });
const params = (type: Parameters<typeof triggers.require>[0], p: unknown) => triggers.require(type).paramsSchema.parse(p);

describe("log trigger samples (latest REAL event)", () => {
  function setup() {
    // logTimestamps: false mirrors Robinhood Chain (logs carry blockTimestamp "0x0").
    const chain = new FakeChain({ logTimestamps: false });
    const token = chain.token(TOKEN, { symbol: "USDG", decimals: 6 });
    token.seed(WHALE, 1_000_000_000_000n);
    return { chain, token };
  }

  it("returns the newest matching event with its real block time", async () => {
    const { chain, token } = setup();
    chain.mine([token.transfer(WHALE, ALICE, 5_000_000n)]);
    chain.mineEmpty(3);
    const newest = chain.mine([token.transfer(WHALE, BOB, 7_000_000n)]);
    chain.mineEmpty(2);
    const sample = await sampleTrigger(triggers.require("TOKEN_TRANSFER"), params("TOKEN_TRANSFER", { token: TOKEN }), { rt: rt(chain), head: chain.head });
    expect(sample).toMatchObject({
      kind: "event",
      payload: { to: BOB, amount_decimal: "7", block_number: newest.number, block_timestamp: new Date(newest.timestamp * 1000).toISOString(), token: { symbol: "USDG" } },
      note: expect.stringMatching(new RegExp(`^latest real event \\(block ${newest.number}, tx 0x`)),
    });
  });

  it("prefers the newest event that passes the flow's conditions", async () => {
    const { chain, token } = setup();
    const big = chain.mine([token.transfer(WHALE, ALICE, 900_000_000n)]); // 900 USDG
    chain.mine([token.transfer(WHALE, BOB, 1_000_000n)]); // 1 USDG, newer
    const conditions = { all: [{ field: "amount_decimal", op: ">=" as const, value: "100" }] };
    const sample = await sampleTrigger(triggers.require("TOKEN_TRANSFER"), params("TOKEN_TRANSFER", { token: TOKEN }), { rt: rt(chain), head: chain.head, conditions });
    expect(sample?.payload).toMatchObject({ block_number: big.number, to: ALICE });
    expect(sample?.conditions?.passed).toBe(true);

    const none = await sampleTrigger(triggers.require("TOKEN_TRANSFER"), params("TOKEN_TRANSFER", { token: TOKEN }), { rt: rt(chain), head: chain.head, conditions: { all: [{ field: "amount_decimal", op: ">=", value: "1000000" }] } });
    expect(none?.payload).toMatchObject({ to: BOB }); // nothing passes: the newest, with the failing results
    expect(none?.conditions?.passed).toBe(false);
  });

  it("scans back in growing windows (and narrows ranges the node refuses)", async () => {
    const chain = new FakeChain({ logTimestamps: false, maxRange: 5_000 });
    const token = chain.token(TOKEN, { symbol: "USDG", decimals: 6 });
    token.seed(WHALE, 10n ** 12n);
    const old = chain.mine([token.transfer(WHALE, ALICE, 3n)]);
    chain.mineEmpty(4_000);
    const sample = await sampleTrigger(triggers.require("TOKEN_TRANSFER"), params("TOKEN_TRANSFER", { token: TOKEN }), { rt: rt(chain), head: chain.head });
    expect(sample?.payload.block_number).toBe(old.number);
    expect(sample?.scannedBlocks).toBeGreaterThan(2_000);
    expect(await sampleTrigger(triggers.require("TOKEN_TRANSFER"), params("TOKEN_TRANSFER", { token: addr(0xdead) }), { rt: rt(chain), head: chain.head })).toBeNull();
  });

  it("NEW_HOLDER samples a real first receipt", async () => {
    const { chain, token } = setup();
    chain.mine([token.transfer(WHALE, ALICE, 5n)]);
    chain.mine([token.transfer(WHALE, ALICE, 5n)]); // ALICE already holds: not new
    const sample = await sampleTrigger(triggers.require("NEW_HOLDER"), params("NEW_HOLDER", { token: TOKEN }), { rt: rt(chain), head: chain.head });
    expect(sample?.payload).toMatchObject({ holder: ALICE, block_number: 1 });
  });
});

describe("state, time and request samples", () => {
  it("BALANCE_THRESHOLD, STATE_CHANGE and CONTRACT_DEPLOYED sample the current chain state", async () => {
    const chain = new FakeChain();
    const W = addr(0x7a11e7);
    chain.setNativeBalance(W, 1_500_000_000_000_000_000n);
    const D = addr(0xde9107e2);
    chain.mine([], { txs: [{ from: D, code: "0x60" }] });
    chain.mine([], { txs: [{ from: D, to: ALICE }] }); // a plain transaction after the deployment
    const abi = parseAbi(["function paused() view returns (bool)"]);
    const C = addr(0xc0);
    chain.registerContract(C, (data) => (decodeFunctionData({ abi, data }).functionName === "paused" ? encodeFunctionResult({ abi, functionName: "paused", result: true }) : "0x"));

    const balance = await sampleTrigger(triggers.require("BALANCE_THRESHOLD"), params("BALANCE_THRESHOLD", { wallet: W, threshold: "2" }), { rt: rt(chain), head: chain.head });
    expect(balance).toMatchObject({ kind: "state", payload: { direction: "below", balance_after_decimal: "1.5", balance_before_decimal: "1.5" }, note: expect.stringMatching(/^current balance \(1\.5, below 2\)/) });

    const state = await sampleTrigger(triggers.require("STATE_CHANGE"), params("STATE_CHANGE", { address: C, function: "function paused() view returns (bool)" }), { rt: rt(chain), head: chain.head });
    expect(state).toMatchObject({ kind: "state", payload: { previous: true, current: true, function: { signature: "paused()" } } });

    const deployed = await sampleTrigger(triggers.require("CONTRACT_DEPLOYED"), params("CONTRACT_DEPLOYED", { deployer: D }), { rt: rt(chain), head: chain.head });
    expect(deployed?.payload).toMatchObject({ nonce: 0, contract: normalizeAddress(getContractAddress({ from: D, nonce: 0n, opcode: "CREATE" })) });
  });

  it("SCHEDULE samples its latest time; conditions are evaluated on it", async () => {
    const conditions = { all: [{ field: "time.weekday_wib", op: "<=" as const, value: 5 }] };
    const sample = await sampleTrigger(triggers.require("SCHEDULE"), params("SCHEDULE", { cron: "0 9 * * *" }), { rt: null, head: 0, conditions });
    expect(sample).toMatchObject({ kind: "time", payload: { scheduled_at_local: expect.stringMatching(/ 09:00:00 WIB$/) }, conditions: { passed: expect.any(Boolean) } });
  });
});

describe("INBOUND_WEBHOOK samples and TEST runs (database)", () => {
  let h: DbHandle;
  let owner: string;
  let flowId: string;

  beforeAll(async () => {
    h = await createDb("pglite://memory");
    await h.migrate();
    owner = await ensureUser(h.db, addr(0xa1));
    const deps = { db: h.db, chainId: 4663, triggers, prepare: { abis: null } };
    flowId = (
      await createFlow(deps, {
        ownerId: owner,
        name: "Orders",
        definition: {
          trigger: { type: "INBOUND_WEBHOOK", params: {} },
          conditions: { all: [{ field: "body.total", op: ">=", value: 100 }] },
          actions: [{ step_id: "hook", type: "WEBHOOK", params: { url: "https://example.com/hook" } }],
        },
      })
    ).flowId; // a paused draft: tests run on drafts too
  }, 30_000);

  afterAll(async () => {
    await h.close();
  });

  it("uses a pasted body, else the flow's latest request", async () => {
    const module = triggers.require("INBOUND_WEBHOOK");
    const pasted = await sampleTrigger(module, {}, { rt: null, head: 0, db: h.db, flowId, body: { order: "X", total: 5 }, conditions: { all: [{ field: "body.total", op: ">=", value: 100 }] } });
    expect(pasted).toMatchObject({ kind: "request", note: "the sample body you pasted", payload: { body: { order: "X" } }, conditions: { passed: false } });
    expect(await sampleTrigger(module, {}, { rt: null, head: 0, db: h.db, flowId })).toBeNull();
    await h.db.insert(inboundEvents).values({ requestId: newId("inboundRequest"), flowId, dedupeKey: "k1", body: { order: "Y", total: 150 }, bytes: 20 });
    const latest = await sampleTrigger(module, {}, { rt: null, head: 0, db: h.db, flowId });
    expect(latest).toMatchObject({ kind: "request", payload: { body: { order: "Y" }, idempotency_key: "k1" } });
  });

  it("queues TEST runs with their condition results, bounded per hour", async () => {
    const { run, conditionsPassed } = await queueTestRun(h.db, { flowId, ownerId: owner, payload: { body: { total: 5 } } });
    expect(run).toMatchObject({ isTest: true, status: "queued", idempotencyKey: `test:${run.id}`, flowVersion: 1 });
    expect(conditionsPassed).toBe(false); // recorded, and the actions still run: that is the point of a test
    await expect(queueTestRun(h.db, { flowId, ownerId: await ensureUser(h.db, addr(0xb2)), payload: {} })).rejects.toThrow(/not found/);
    for (let i = 1; i < TEST_RUNS_PER_HOUR; i++) await queueTestRun(h.db, { flowId, ownerId: owner, payload: {} });
    await expect(queueTestRun(h.db, { flowId, ownerId: owner, payload: {} })).rejects.toThrow(TestRunLimitError);
    expect((await h.db.select().from(runs)).every((r) => r.isTest)).toBe(true);
  });
});
