import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, normalizeHash, type NormalizedAddress } from "@ignitra/core";
import { createLogger } from "@ignitra/core/server";
import { EventDecoder, type ChainReader, type LogQuery, type RawLog } from "@ignitra/chain";
import { FakeChain, addr, encodeLog, erc20Transfer, type FakeChainOptions } from "@ignitra/chain/testing";
import { BUILTIN_ABIS } from "@ignitra/chain";
import { chainCursors, chainEvents, chainSyncStatus, createDb, flows, leases, users, watches, type DbHandle } from "@ignitra/db";
import { LeaseLostError, ListenerStore, addWatch } from "./store";
import { ChainSync, LogTooDenseError, type SyncOptions } from "./sync";

const CHAIN_ID = 4663;
const TOKEN = addr(0x70c);
const OTHER = addr(0x0de);
const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const CAROL = addr(0xca201);
const TRANSFER = normalizeHash(EventDecoder.selector("Transfer(address,address,uint256)"));
const silent = createLogger("test", "silent");

let h: DbHandle;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  for (const t of [chainEvents, chainCursors, watches, leases, chainSyncStatus]) await h.db.delete(t);
});

function setup(opts: { chain?: FakeChainOptions; sync?: Partial<SyncOptions>; owner?: string; reader?: ChainReader } = {}) {
  const chain = new FakeChain(opts.chain);
  const store = new ListenerStore(h.db, { chainId: CHAIN_ID, owner: opts.owner ?? "test-a" });
  const make = (owner = opts.owner ?? "test-a") =>
    new ChainSync({
      reader: opts.reader ?? chain,
      store: owner === store.owner ? store : new ListenerStore(h.db, { chainId: CHAIN_ID, owner }),
      decoder: new EventDecoder(),
      abis: null,
      logger: silent,
      options: { strategy: "depth", depth: 3, maxRange: 100, addressChunk: 100, rewindBlocks: 50, startBlock: 0, ...opts.sync },
    });
  return { chain, store, sync: make(), make };
}

const watch = (address: NormalizedAddress, opts: { topic0?: typeof TRANSFER | null; fast?: boolean } = {}) =>
  addWatch(h.db, { chainId: CHAIN_ID, address, topic0: opts.topic0 === undefined ? TRANSFER : opts.topic0, fast: opts.fast ?? false, note: null });

const events = () => h.db.select().from(chainEvents).orderBy(asc(chainEvents.blockNumber), asc(chainEvents.id));

describe("confirmation", () => {
  it("ingests an event only once it is CONFIRMATION_DEPTH blocks deep, fully decoded", async () => {
    const { chain, sync } = setup();
    await watch(TOKEN);
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 10n ** 24n)]);

    expect((await sync.tick()).confirmed).toBeUndefined(); // head 1, confirmed head 0
    expect(await events()).toHaveLength(0);

    chain.mineEmpty(3);
    const report = await sync.tick();
    expect(report).toMatchObject({ role: "leader", head: 4, confirmedHead: 1, confirmedCursor: 1 });

    const [row] = await events();
    expect(row).toMatchObject({
      status: "confirmed",
      blockNumber: 1,
      address: TOKEN,
      topic0: TRANSFER,
      eventName: "Transfer",
      eventSignature: "Transfer(address,address,uint256)",
      abiSource: "builtin:erc20",
      args: { from: ALICE, to: BOB, value: (10n ** 24n).toString() },
    });
    expect(row?.blockTimestamp).toBeInstanceOf(Date);
    expect(row?.confirmedAt).toBeInstanceOf(Date);
  });

  it("keeps only exact (address, topic0) pairs", async () => {
    const { chain, sync } = setup();
    await watch(TOKEN);
    chain.mine([
      erc20Transfer(OTHER, ALICE, BOB, 1n),
      encodeLog(BUILTIN_ABIS.erc20, "Approval", { owner: ALICE, spender: BOB, value: 1n }, TOKEN),
      erc20Transfer(TOKEN, ALICE, BOB, 2n),
    ]);
    chain.mineEmpty(3);
    await sync.tick();
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.args).toMatchObject({ value: "2" });
  });

  it("supports wildcard watches (every event of an address)", async () => {
    const { chain, sync } = setup();
    await watch(TOKEN, { topic0: null });
    chain.mine([
      erc20Transfer(TOKEN, ALICE, BOB, 1n),
      encodeLog(BUILTIN_ABIS.erc20, "Approval", { owner: ALICE, spender: BOB, value: 1n }, TOKEN),
      erc20Transfer(OTHER, ALICE, BOB, 1n),
    ]);
    chain.mineEmpty(3);
    await sync.tick();
    expect((await events()).map((e) => e.eventName)).toEqual(["Transfer", "Approval"]);
  });

  it("uses the node's safe / finalized tags when configured", async () => {
    const { chain, sync } = setup({ chain: { safeDepth: 10 }, sync: { strategy: "safe" } });
    chain.mineEmpty(15);
    expect((await sync.tick()).confirmedHead).toBe(5);
  });

  it("starts at the confirmed head on a fresh database (no history replay)", async () => {
    const { chain, sync } = setup({ sync: { startBlock: undefined } });
    await watch(TOKEN);
    for (let i = 0; i < 5; i++) chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 1n)]);
    chain.mineEmpty(5);
    expect(await sync.tick()).toMatchObject({ confirmedHead: 7, confirmedCursor: 7 });
    expect(await events()).toHaveLength(0);
  });

  it("derives block timestamps from anchor headers when the node omits them (Robinhood RPC sends 0x0)", async () => {
    // ~10 blocks per second with 1 s timestamps, like mainnet.
    const { chain, sync } = setup({ chain: { logTimestamps: false, timestampOf: (n) => 1_790_000_000 + Math.floor(n / 10) }, sync: { maxRange: 1000 } });
    await watch(TOKEN);
    for (let i = 0; i < 300; i++) chain.mine(i % 7 === 0 ? [erc20Transfer(TOKEN, ALICE, BOB, BigInt(i))] : []);
    chain.mineEmpty(3);
    await sync.tick();
    const rows = await events();
    expect(rows.length).toBe(43);
    for (const row of rows) {
      const exact = chain.block(row.blockNumber)?.timestamp ?? 0;
      const derived = (row.blockTimestamp?.getTime() ?? 0) / 1000;
      expect(Math.abs(derived - exact)).toBeLessThanOrEqual(1);
    }
    // Anchors: range ends + one per 64 blocks — not one header per block.
    expect(chain.calls.blockByNumber).toBeLessThanOrEqual(8);
    expect(chain.calls.blockByHash ?? 0).toBe(0);
  });
});

describe("fast mode (pending → confirmed)", () => {
  it("records at head as pending, then promotes the same row", async () => {
    const { chain, sync } = setup();
    await watch(TOKEN, { fast: true });
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 5n)]);

    expect((await sync.tick()).pending).toMatchObject({ from: 1, to: 1, inserted: 1 });
    const [pending] = await events();
    expect(pending).toMatchObject({ status: "pending", confirmedAt: null });

    chain.mineEmpty(3);
    await sync.tick();
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pending?.id, status: "confirmed" });
  });
});

describe("reorgs", () => {
  it("reverts a pending event that was reorged out and confirms its replacement", async () => {
    const { chain, sync } = setup();
    await watch(TOKEN, { fast: true });
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 100n)]);
    await sync.tick();

    chain.reorg(1, [[erc20Transfer(TOKEN, ALICE, CAROL, 200n)]]);
    chain.mineEmpty(3);
    const report = await sync.tick();
    expect(report.confirmed).toMatchObject({ inserted: 1, reverted: 1 });

    const rows = await events();
    expect(rows.map((r) => [r.status, r.revertReason, (r.args as { value: string }).value])).toEqual([
      ["reverted", "reorg", "100"],
      ["confirmed", null, "200"],
    ]);
  });

  it("never surfaces an orphaned event in the default (confirmed) mode", async () => {
    const { chain, sync } = setup();
    await watch(TOKEN);
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 100n)]);
    await sync.tick();
    chain.reorg(1, [[]]);
    chain.mineEmpty(3);
    await sync.tick();
    expect(await events()).toHaveLength(0);
  });

  it("detects a reorg below the confirmed cursor and re-verifies the window", async () => {
    const { chain, sync } = setup();
    await watch(TOKEN);
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 1n)]);
    chain.mineEmpty(3);
    await sync.tick(); // block 1 confirmed, cursor anchored to its hash

    chain.reorg(4, [[erc20Transfer(TOKEN, ALICE, CAROL, 2n)], [], [], []]);
    const report = await sync.tick();
    expect(report.deepReorg).toMatchObject({ at: 1, rewoundTo: 0, deepReverted: 1 });

    const rows = await events();
    expect(rows.map((r) => [r.status, r.revertReason])).toEqual([
      ["reverted", "deep_reorg"],
      ["confirmed", null],
    ]);
    const cursor = await h.db.select().from(chainCursors).where(eq(chainCursors.stream, "confirmed"));
    expect(cursor[0]?.blockHash).toBe(chain.block(1)?.hash);
  });

  it("resurrects an event when the chain reorgs back to the original fork", async () => {
    const { chain, store, sync } = setup();
    await watch(TOKEN, { fast: true });
    const log = erc20Transfer(TOKEN, ALICE, BOB, 1n);
    chain.mine([log]);
    await sync.tick(); // pending on fork 0
    // Simulate A → B → A by confirming directly against a row identical to the original
    const [original] = await events();
    await store.commitConfirmed({
      from: 1,
      to: 1,
      rows: [{ ...original!, id: undefined, status: "pending" } as never],
      cursor: { blockNumber: 1, blockHash: original!.blockHash as never },
    });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: original?.id, status: "confirmed" });
  });
});

describe("checkpoints", () => {
  it("resumes from the cursor after a restart without duplicates", async () => {
    const { chain, sync, make } = setup();
    await watch(TOKEN);
    for (let i = 1n; i <= 5n; i++) chain.mine([erc20Transfer(TOKEN, ALICE, BOB, i)]);
    chain.mineEmpty(3);
    await sync.tick();
    expect(await events()).toHaveLength(5);

    const restarted = make(); // fresh process, same database and owner
    await restarted.tick();
    expect(await events()).toHaveLength(5);

    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 6n)]);
    chain.mineEmpty(3);
    await restarted.tick();
    const values = (await events()).map((e) => (e.args as { value: string }).value);
    expect(values).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("does not advance the cursor when a tick fails, so the retry ingests exactly once", async () => {
    const { chain, sync } = setup();
    await watch(TOKEN);
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 1n)]);
    chain.mineEmpty(3);
    chain.failNext("getLogs", new Error("node hiccup"));
    await expect(sync.tick()).rejects.toThrow("node hiccup");
    const [cursor] = await h.db.select().from(chainCursors).where(eq(chainCursors.stream, "confirmed"));
    expect(cursor?.blockNumber).toBe(0);
    await sync.tick();
    await sync.tick();
    expect(await events()).toHaveLength(1);
  });
});

describe("dynamic watch set", () => {
  it("applies new watches from the next range on (no backfill)", async () => {
    const { chain, sync } = setup();
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 1n)]);
    chain.mineEmpty(3);
    expect(await sync.tick()).toMatchObject({ confirmedCursor: 1, watchCount: 0 });

    await watch(TOKEN);
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 2n)]);
    chain.mineEmpty(3);
    await sync.tick();
    expect((await events()).map((e) => (e.args as { value: string }).value)).toEqual(["2"]);
  });

  it("does not falsely revert pending rows when their watch is removed", async () => {
    const { chain, sync } = setup();
    const id = await watch(TOKEN, { fast: true });
    chain.mine([erc20Transfer(TOKEN, ALICE, BOB, 1n)]);
    await sync.tick();
    await h.db.delete(watches).where(eq(watches.id, id));
    chain.mineEmpty(3);
    await sync.tick();
    expect((await events()).map((e) => e.status)).toEqual(["confirmed"]);
  });

  it("ignores watches of flows that are not active", async () => {
    const { store } = setup();
    await watch(TOKEN);
    expect(await store.loadWatches()).toHaveLength(1);
    // A flow-derived watch whose flow is paused is excluded (flow rows are created in Phase 3).
    await h.db.execute(sql`insert into users (id, address) values ('usr_x', ${ALICE})`);
    await h.db.execute(sql`insert into flows (id, owner_id, name, current_version, status) values ('fl_x', 'usr_x', 'f', 1, 'paused')`);
    await h.db.insert(watches).values({ id: "wat_x", chainId: CHAIN_ID, address: OTHER, topic0: TRANSFER, source: "flow", flowId: "fl_x" });
    expect((await store.loadWatches()).map((w) => w.address)).toEqual([TOKEN]);
    await h.db.execute(sql`update flows set status = 'active' where id = 'fl_x'`);
    expect(await store.loadWatches()).toHaveLength(2);
    await h.db.execute(sql`delete from users where id = 'usr_x'`);
  });
});

describe("node limits", () => {
  it("splits ranges the node refuses and remembers the narrower range", async () => {
    const { chain, sync } = setup({ chain: { maxRange: 10 } });
    await watch(TOKEN);
    for (let i = 0; i < 40; i++) chain.mine([erc20Transfer(TOKEN, ALICE, BOB, BigInt(i))]);
    await sync.tick();
    expect(await events()).toHaveLength(37);
    expect(sync.range).toBeLessThanOrEqual(10);
  });

  it("regrows the range after consecutive successes, never past the node's stated cap", async () => {
    const { chain, sync } = setup({ chain: { maxRange: 64 }, sync: { maxRange: 1000 } });
    await watch(TOKEN);
    chain.mineEmpty(300);
    await sync.tick();
    expect(sync.range).toBeLessThanOrEqual(64);
    chain.mineEmpty(3000);
    for (let i = 0; i < 40; i++) await sync.tick();
    expect(sync.range).toBe(64);
  });

  it("splits on too many results, and fails loudly when a single block is too dense", async () => {
    const dense = setup({ chain: { maxLogs: 5 } });
    await watch(TOKEN);
    for (let i = 0; i < 10; i++) dense.chain.mine([1n, 2n, 3n].map((v) => erc20Transfer(TOKEN, ALICE, BOB, v)));
    dense.chain.mineEmpty(3);
    await dense.sync.tick();
    expect(await events()).toHaveLength(30);

    dense.chain.mine(Array.from({ length: 6 }, (_, i) => erc20Transfer(TOKEN, ALICE, BOB, BigInt(i))));
    dense.chain.mineEmpty(3);
    // The range narrowed while splitting; it takes a few ticks to reach the dense block.
    let failure: unknown;
    for (let i = 0; i < 20 && !failure; i++) await dense.sync.tick().catch((err: unknown) => (failure = err));
    expect(failure).toBeInstanceOf(LogTooDenseError);
  });
});

describe("single active listener (lease + fencing)", () => {
  it("lets one instance lead; the other stands by until the lease expires", async () => {
    const { chain, make } = setup();
    chain.mineEmpty(5);
    const a = make("node-a");
    const b = make("node-b");
    expect((await a.tick()).role).toBe("leader");
    expect((await b.tick()).role).toBe("standby");
    await h.db.update(leases).set({ expiresAt: sql`now() - interval '1 second'` });
    expect((await b.tick()).role).toBe("leader");
    expect((await a.tick()).role).toBe("standby");
  });

  it("refuses to commit progress after the lease was taken over", async () => {
    const a = new ListenerStore(h.db, { chainId: CHAIN_ID, owner: "node-a" });
    const b = new ListenerStore(h.db, { chainId: CHAIN_ID, owner: "node-b" });
    expect(await a.acquireLease()).toBe(true);
    await h.db.update(leases).set({ expiresAt: sql`now() - interval '1 second'` });
    expect(await b.acquireLease()).toBe(true);
    await expect(a.commitConfirmed({ from: 1, to: 1, rows: [], cursor: { blockNumber: 1, blockHash: null } })).rejects.toBeInstanceOf(
      LeaseLostError,
    );
  });
});

describe("gap detector", () => {
  /** A node that can leave out one block's logs, like an endpoint answering short. */
  class LossyChain extends FakeChain {
    hide: number | null = null;
    override async getLogs(q: LogQuery): Promise<RawLog[]> {
      const logs = await super.getLogs(q);
      return this.hide === null ? logs : logs.filter((l) => l.blockNumber !== this.hide);
    }
  }
  const wallClock = { timestampOf: () => Math.floor(Date.now() / 1000) };
  const HOUR = 3_600_000;
  const ageWatches = () => h.db.update(watches).set({ createdAt: new Date(Date.now() - HOUR) });
  async function catchUp(sync: ChainSync): Promise<number> {
    for (;;) {
      const r = await sync.tick();
      if (r.confirmedCursor !== undefined && r.confirmedCursor >= (r.confirmedHead ?? 0)) return r.confirmedCursor;
    }
  }

  it("re-reads confirmed blocks, finds what the node left out and inserts it as confirmed", async () => {
    const chain = new LossyChain(wallClock);
    const { sync } = setup({ reader: chain });
    const token = chain.token(TOKEN);
    await watch(TOKEN);
    await ageWatches();
    chain.mine([token.transfer(ALICE, BOB, 1n)]);
    const hidden = chain.mine([token.transfer(ALICE, CAROL, 2n)]).number;
    chain.mine([token.transfer(BOB, CAROL, 3n)]);
    chain.mineEmpty(5);

    chain.hide = hidden; // the endpoint answers short while the window is ingested
    const cursor = await catchUp(sync);
    expect((await events()).map((e) => e.blockNumber)).not.toContain(hidden);

    chain.hide = null;
    const report = await sync.verify(1, cursor, 600_000);
    expect(report).toMatchObject({ watches: 1, onChain: 3, missing: 1, repaired: 1 });
    const repaired = (await events()).find((e) => e.blockNumber === hidden);
    expect(repaired).toMatchObject({ status: "confirmed", address: TOKEN });
    expect(repaired?.confirmedSeq).not.toBeNull(); // the matcher picks it up from its stream
    // A second pass finds nothing: repairs are idempotent.
    expect(await sync.verify(1, cursor, 600_000)).toMatchObject({ missing: 0, repaired: 0 });
  });

  it("never counts events from before a watch existed, or while its flow was paused", async () => {
    const chain = new LossyChain(wallClock);
    const { sync } = setup({ reader: chain });
    const token = chain.token(TOKEN);
    const other = chain.token(OTHER);
    // A brand-new operator watch: its window predates it (no backfill by design).
    await watch(TOKEN);
    // A flow watch whose flow was resumed just now: events while it was paused are not owed.
    const userId = newId("user");
    const flowId = newId("flow");
    await h.db.insert(users).values({ id: userId, address: addr(0xf10) });
    await h.db.insert(flows).values({ id: flowId, ownerId: userId, name: "resumed", status: "active", currentVersion: 1, activatedAt: new Date() });
    await h.db.insert(watches).values({ id: newId("watch"), chainId: CHAIN_ID, address: OTHER, topic0: TRANSFER, fast: false, source: "flow", flowId, createdAt: new Date(Date.now() - HOUR) });

    chain.hide = chain.mine([token.transfer(ALICE, BOB, 1n), other.transfer(ALICE, BOB, 1n)]).number;
    chain.mineEmpty(5);
    const cursor = await catchUp(sync);
    chain.hide = null;
    expect(await sync.verify(1, cursor, 600_000)).toMatchObject({ watches: 0, missing: 0, repaired: 0 });
  });
});
