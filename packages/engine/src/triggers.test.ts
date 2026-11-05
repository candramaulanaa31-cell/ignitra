import { getContractAddress, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { normalizeAddress, normalizeHash, resolveChainConfig } from "@ignitra/core";
import { createLogger } from "@ignitra/core/server";
import { AbiRegistry, BUILTIN_ABIS, MemoryAbiStore } from "@ignitra/chain";
import { FakeChain, addr, encodeLog, erc721Transfer } from "@ignitra/chain/testing";
import { TokenInfo } from "./tokens";
import {
  MAX_NONCES_PER_POLL,
  balanceThresholdTrigger,
  contractDeployedTrigger,
  contractEventTrigger,
  createNewHolderTrigger,
  tokenTransferTrigger,
  type BalanceState,
  type DeployerState,
} from "./triggers/index";
import type { ChainEventView, FlowScope, TriggerRuntime } from "./types";

const chainConfig = resolveChainConfig({ chainId: 4663 });
const TOKEN = addr(0x70c);
const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const CAROL = addr(0xca201);
const DAVE = addr(0xda7e);
const ZERO = addr(0);
const scope: FlowScope = { flowId: "fl_test", generation: "g1" };

function runtime(chain: FakeChain): TriggerRuntime {
  return { chain: chainConfig, reader: chain, tokens: new TokenInfo(chain), logger: createLogger("test", "silent") };
}

/** chain_events-equivalent views of every log in the given blocks. */
function views(chain: FakeChain, from = 1, to = chain.head): ChainEventView[] {
  const out: ChainEventView[] = [];
  for (let n = from; n <= to; n++) {
    for (const log of chain.block(n)?.logs ?? []) {
      out.push({ id: out.length + 1, chainId: 4663, status: "confirmed", ...log });
    }
  }
  return out;
}

const parse = <T>(schema: { parse(v: unknown): T }, v: unknown): T => schema.parse(v);

describe("TOKEN_TRANSFER", () => {
  it("builds the payload: exact amounts, token metadata, supply share, evidence", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN, { symbol: "USDG", name: "Global Dollar", decimals: 6 });
    chain.mine([token.mint(ALICE, 1_000_000_000n)]); // 1,000 USDG supply
    chain.mine([token.transfer(ALICE, BOB, 1_234_500_000n / 1000n)]); // 1.2345 USDG
    const params = parse(tokenTransferTrigger.paramsSchema, { token: TOKEN.toUpperCase().replace("0X", "0x") });
    const [mint, transfer] = await tokenTransferTrigger.matchBatch(views(chain), params, runtime(chain), scope);

    expect(mint?.kind === "match" && mint.payload.is_mint).toBe(true);
    expect(transfer).toMatchObject({
      kind: "match",
      key: `${chain.block(2)?.logs[0]?.txHash}:0`,
      payload: {
        from: ALICE,
        to: BOB,
        amount: "1234500",
        amount_decimal: "1.2345",
        amount_formatted: "1.2345",
        percent_of_supply: 0.12345,
        is_mint: false,
        is_burn: false,
        token: { address: TOKEN, symbol: "USDG", name: "Global Dollar", decimals: 6, total_supply: "1000000000", total_supply_decimal: "1000" },
        block_number: 2,
        contract: TOKEN,
        event_status: "confirmed",
        explorer_url: `https://robinhoodchain.blockscout.com/tx/${chain.block(2)?.logs[0]?.txHash}`,
      },
    });
    const payload = transfer?.kind === "match" ? transfer.payload : {};
    expect(payload.time).toMatchObject({ iso: expect.any(String), hour_wib: expect.any(Number) });
  });

  it("filters by wallet and direction", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN);
    chain.mine([token.mint(ALICE, 10n), token.transfer(ALICE, BOB, 1n), token.transfer(BOB, CAROL, 1n), token.transfer(CAROL, DAVE, 1n)]);
    const rt = runtime(chain);
    const keysFor = async (p: unknown) =>
      (await tokenTransferTrigger.matchBatch(views(chain), parse(tokenTransferTrigger.paramsSchema, p), rt, scope)).map((o) =>
        o?.kind === "match" ? o.payload.direction : null,
      );
    expect(await keysFor({ token: TOKEN, wallet: BOB })).toEqual([null, "in", "out", null]);
    expect(await keysFor({ token: TOKEN, wallet: BOB, direction: "in" })).toEqual([null, "in", null, null]);
    expect(await keysFor({ token: TOKEN, wallet: BOB, direction: "out" })).toEqual([null, null, "out", null]);
    expect(() => parse(tokenTransferTrigger.paramsSchema, { token: TOKEN, direction: "in" })).toThrow(/needs a wallet/);
    expect(() => parse(tokenTransferTrigger.paramsSchema, { token: "0x123" })).toThrow(/valid address/);
  });

  it("ignores ERC-721 transfers (same topic0) and other contracts", async () => {
    const chain = new FakeChain();
    chain.token(TOKEN);
    chain.mine([erc721Transfer(TOKEN, ALICE, BOB, 1n)]);
    const out = await tokenTransferTrigger.matchBatch(views(chain), parse(tokenTransferTrigger.paramsSchema, { token: addr(0x999) }), runtime(chain), scope);
    expect(out).toEqual([null]);
    const own = await tokenTransferTrigger.matchBatch(views(chain), parse(tokenTransferTrigger.paramsSchema, { token: TOKEN }), runtime(chain), scope);
    expect(own).toEqual([null]);
  });

  it("degrades to null metadata instead of failing (non-standard tokens)", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN, { revertMetadata: true });
    chain.mine([token.mint(ALICE, 10n)]);
    const [out] = await tokenTransferTrigger.matchBatch(views(chain), parse(tokenTransferTrigger.paramsSchema, { token: TOKEN }), runtime(chain), scope);
    expect(out).toMatchObject({ payload: { amount: "10", amount_decimal: null, amount_formatted: null, token: { symbol: null, decimals: null } } });
  });

  it("reads bytes32 symbols (MKR-style tokens)", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN, { symbol: "MKR", symbolAsBytes32: true });
    chain.mine([token.mint(ALICE, 1n)]);
    const [out] = await tokenTransferTrigger.matchBatch(views(chain), parse(tokenTransferTrigger.paramsSchema, { token: TOKEN }), runtime(chain), scope);
    expect(out).toMatchObject({ payload: { token: { symbol: "MKR" } } });
  });
});

describe("CONTRACT_EVENT", () => {
  const launchAbi = parseAbi(["event Launched(address indexed token, string symbol, (address owner, uint64 cap) config)"]);

  it("normalizes a full signature and exposes typed argument fields", async () => {
    const p = await contractEventTrigger.prepare!(
      parse(contractEventTrigger.paramsSchema, { address: TOKEN, event: "Launched(address indexed token, string symbol, (address owner, uint64 cap) config)" }),
      { abis: null },
    );
    expect(p.event).toBe("event Launched(address indexed token, string symbol, (address owner, uint64 cap) config)");
    expect(contractEventTrigger.fields(p).filter((f) => f.path.startsWith("args."))).toEqual([
      expect.objectContaining({ path: "args.token", type: "address" }),
      expect.objectContaining({ path: "args.symbol", type: "string" }),
      expect.objectContaining({ path: "args.config", type: "object" }),
      expect.objectContaining({ path: "args.config.owner", type: "address" }),
      expect.objectContaining({ path: "args.config.cap", type: "uint" }),
    ]);
  });

  it("resolves a bare event name from the contract ABI or built-ins, refusing ambiguity", async () => {
    const store = new MemoryAbiStore();
    await store.put(TOKEN, { status: "verified", abi: launchAbi, implementation: null, source: "test", error: null, fetchedAt: new Date() });
    const abis = new AbiRegistry({ store, fetcher: null, reader: null });
    const viaAbi = await contractEventTrigger.prepare!({ address: TOKEN, event: "Launched" }, { abis });
    expect(viaAbi.event).toContain("event Launched(address indexed token");
    const builtin = await contractEventTrigger.prepare!({ address: TOKEN, event: "OwnershipTransferred" }, { abis: null });
    expect(builtin.event).toBe("event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)");
    await expect(contractEventTrigger.prepare!({ address: TOKEN, event: "Transfer" }, { abis: null })).rejects.toThrow(/ambiguous/);
    await expect(contractEventTrigger.prepare!({ address: TOKEN, event: "Nope" }, { abis: null })).rejects.toThrow(/not found/);
    await expect(contractEventTrigger.prepare!({ address: TOKEN, event: "event X(uint256) anonymous" }, { abis: null })).rejects.toThrow(/anonymous/);
  });

  it("decodes matching events with the pinned fragment", async () => {
    const chain = new FakeChain();
    chain.mine([
      encodeLog(launchAbi, "Launched", { token: BOB, symbol: "PONS", config: { owner: ALICE, cap: 21n } }, TOKEN),
      encodeLog(BUILTIN_ABIS.ownable, "OwnershipTransferred", { previousOwner: ALICE, newOwner: BOB }, TOKEN),
    ]);
    const p = { address: TOKEN, event: "event Launched(address indexed token, string symbol, (address owner, uint64 cap) config)" };
    const [launch, other] = await contractEventTrigger.matchBatch(views(chain), p, runtime(chain), scope);
    expect(launch).toMatchObject({
      kind: "match",
      payload: {
        event: { name: "Launched", signature: "Launched(address,string,(address,uint64))" },
        args: { token: BOB, symbol: "PONS", config: { owner: ALICE, cap: "21" } },
      },
    });
    expect(other).toBeNull();
    expect(contractEventTrigger.watches(p)).toEqual([{ address: TOKEN, topic0: expect.stringMatching(/^0x[0-9a-f]{64}$/) }]);
  });
});

describe("NEW_HOLDER", () => {
  async function holders(chain: FakeChain, trigger = createNewHolderTrigger(), from = 1, to = chain.head, s = scope) {
    const out = await trigger.matchBatch(views(chain, from, to), { token: TOKEN }, runtime(chain), s);
    return out.map((o) => (o?.kind === "match" ? o.payload.holder : o?.kind === "undetermined" ? `?${o.payload.holder}` : null));
  }

  it("fires when a balance goes from zero to non-zero — including returning holders", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN, { decimals: 6 });
    token.seed(ALICE, 100n); // held since genesis: never "new"
    chain.mine([token.mint(BOB, 50n), token.transfer(ALICE, CAROL, 10n)]); // BOB, CAROL new
    chain.mine([token.transfer(ALICE, BOB, 5n), token.transfer(BOB, DAVE, 55n)]); // BOB tops up, then empties; DAVE new
    chain.mine([token.transfer(CAROL, BOB, 1n)]); // BOB is a holder again
    expect(await holders(chain)).toEqual([BOB, CAROL, null, DAVE, BOB]);
  });

  it("is exact within a block: two receipts, and an address that sends before it receives", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN);
    token.seed(ALICE, 10n);
    token.seed(CAROL, 5n);
    chain.mine([token.transfer(CAROL, DAVE, 1n), token.transfer(CAROL, DAVE, 1n)]); // DAVE new once
    chain.mine([token.transfer(ALICE, BOB, 10n), token.transfer(CAROL, ALICE, 3n)]); // ALICE empties then refills → new again
    expect(await holders(chain)).toEqual([DAVE, null, BOB, ALICE]);
  });

  it("decides per transaction: pass-through hops (routers, pools) are not holders", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN);
    token.seed(ALICE, 100n);
    const ROUTER = addr(0x7007e2);
    const tx1 = `0x${"a1".repeat(32)}`;
    const tx2 = `0x${"a2".repeat(32)}`;
    chain.mine([
      { ...token.transfer(ALICE, ROUTER, 10n), txHash: tx1 }, // router receives…
      { ...token.transfer(ROUTER, BOB, 10n), txHash: tx1 }, //  …and passes everything on
      { ...token.transfer(ALICE, ROUTER, 5n), txHash: tx2 },
      { ...token.transfer(ROUTER, CAROL, 4n), txHash: tx2 }, // keeps 1 → really holds now
    ]);
    const out = await createNewHolderTrigger().matchBatch(views(chain), { token: TOKEN }, runtime(chain), scope);
    const decided = out.map((o) => (o?.kind === "match" ? [o.payload.holder, o.payload.amount, o.payload.balance_after] : null));
    expect(decided).toEqual([null, [BOB, "10", "10"], [ROUTER, "5", "1"], [CAROL, "4", "4"]]);
  });

  it("ignores zero-value transfers, burns and self-transfers", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN);
    token.seed(ALICE, 10n);
    chain.mine([token.transfer(ALICE, BOB, 0n), token.burn(ALICE, 1n), token.transfer(ALICE, ALICE, 2n)]);
    expect(await holders(chain)).toEqual([null, null, null]);
  });

  it("keeps running balances across batches with one batched seed read per block", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN);
    token.seed(ALICE, 100n);
    chain.mine([token.transfer(ALICE, BOB, 1n), token.transfer(ALICE, CAROL, 1n), token.transfer(ALICE, DAVE, 1n)]);
    const trigger = createNewHolderTrigger();
    expect(await holders(chain, trigger, 1, 1)).toEqual([BOB, CAROL, DAVE]);
    const callsAfterFirst = chain.calls.call ?? 0;
    chain.mine([token.transfer(BOB, CAROL, 1n), token.transfer(ALICE, BOB, 1n)]); // BOB 0 → refilled; all tracked
    expect(await holders(chain, trigger, 2, 2)).toEqual([null, BOB]);
    // No balance seeding needed in batch 2 (only metadata/supply reads may happen).
    expect((chain.calls.call ?? 0) - callsAfterFirst).toBeLessThanOrEqual(2);
  });

  it("seeds a whole multi-block batch with ONE batched balance read", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN);
    token.seed(ALICE, 100n);
    for (let i = 1; i <= 5; i++) chain.mine([token.transfer(ALICE, addr(0x1000 + i), 1n)]);
    const out = await createNewHolderTrigger().matchBatch(views(chain), { token: TOKEN }, runtime(chain), scope);
    expect(out.filter((o) => o?.kind === "match")).toHaveLength(5);
    expect(chain.calls.call).toBe(3); // seed balances + token metadata + total supply — not one read per block
  });

  it("reports undetermined when historical state was pruned — never guesses", async () => {
    const chain = new FakeChain({ stateWindow: 5 });
    const token = chain.token(TOKEN);
    token.seed(ALICE, 10n);
    chain.mine([token.transfer(ALICE, BOB, 1n)]);
    chain.mineEmpty(20); // the matcher fell far behind
    const out = await createNewHolderTrigger().matchBatch(views(chain, 1, 1), { token: TOKEN }, runtime(chain), scope);
    expect(out[0]).toMatchObject({ kind: "undetermined", reason: expect.stringContaining("pruned") });
  });

  it("starts over when the flow is re-activated (new generation) or reset", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN);
    chain.mine([token.mint(BOB, 1n)]);
    const trigger = createNewHolderTrigger();
    expect(await holders(chain, trigger)).toEqual([BOB]);
    expect(await holders(chain, trigger, 1, 1, { flowId: scope.flowId, generation: "g2" })).toEqual([BOB]);
    trigger.reset?.();
    expect(await holders(chain, trigger, 1, 1, { flowId: scope.flowId, generation: "g2" })).toEqual([BOB]);
  });
});

describe("BALANCE_THRESHOLD", () => {
  const W = addr(0x7a11e7);

  it("fires once per crossing, establishing the side on the first sample", async () => {
    const chain = new FakeChain();
    const rt = runtime(chain);
    const p = parse(balanceThresholdTrigger.paramsSchema, { wallet: W, asset: "native", threshold: "2", direction: "below" });
    let state: BalanceState | null = null;
    const sample = async () => {
      const header = (await chain.blockByNumber(chain.head))!;
      const { state: next, outcomes } = await balanceThresholdTrigger.poll({ params: p, state, block: header, scope }, rt);
      if (next) state = next;
      return outcomes.map((o) => (o.kind === "match" ? o.payload.direction : o.kind));
    };
    chain.setNativeBalance(W, 3n * 10n ** 18n);
    chain.mine();
    expect(await sample()).toEqual([]); // establishes "above"
    chain.setNativeBalance(W, 15n * 10n ** 17n);
    chain.mine();
    expect(await sample()).toEqual(["below"]);
    chain.mine();
    expect(await sample()).toEqual([]); // still below: no repeat
    chain.setNativeBalance(W, 25n * 10n ** 17n);
    chain.mine();
    expect(await sample()).toEqual([]); // back above: direction is "below" only
    chain.setNativeBalance(W, 1n * 10n ** 18n);
    chain.mine();
    expect(await sample()).toEqual(["below"]);
    expect(await sample()).toEqual([]); // same block: nothing new
  });

  it("supports tokens with their decimals and `cross` in both directions", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN, { decimals: 6, symbol: "USDG" });
    const rt = runtime(chain);
    const p = parse(balanceThresholdTrigger.paramsSchema, { wallet: W, asset: TOKEN, threshold: "2.5", direction: "cross" });
    let state: BalanceState | null = null;
    const sample = async () => {
      const { state: next, outcomes } = await balanceThresholdTrigger.poll({ params: p, state, block: (await chain.blockByNumber(chain.head))!, scope }, rt);
      if (next) state = next;
      return outcomes;
    };
    chain.mine([token.mint(W, 3_000_000n)]);
    await sample();
    chain.mine([token.burn(W, 1_000_000n)]); // 2.0 < 2.5
    const [down] = await sample();
    expect(down).toMatchObject({
      kind: "match",
      key: `balance:${chain.head}`,
      payload: { direction: "below", threshold: "2.5", balance_before: "3000000", balance_after: "2000000", balance_after_decimal: "2", token: { symbol: "USDG", decimals: 6 } },
    });
    chain.mine([token.mint(W, 1_000_000n)]);
    expect((await sample())[0]).toMatchObject({ payload: { direction: "above" } });
  });

  it("is undetermined (not silently wrong) when token decimals are unknown", async () => {
    const chain = new FakeChain();
    chain.token(TOKEN, { revertMetadata: true });
    const p = parse(balanceThresholdTrigger.paramsSchema, { wallet: W, asset: TOKEN, threshold: "1" });
    const { state, outcomes } = await balanceThresholdTrigger.poll({ params: p, state: null, block: (await chain.blockByNumber(0))!, scope }, runtime(chain));
    expect(state).toBeNull();
    expect(outcomes[0]).toMatchObject({ kind: "undetermined", reason: expect.stringContaining("decimals") });
  });
});

describe("CONTRACT_DEPLOYED", () => {
  const D = addr(0xde9107e2);
  const created = (nonce: number) => normalizeAddress(getContractAddress({ from: D, nonce: BigInt(nonce), opcode: "CREATE" }));

  async function poll(chain: FakeChain, state: DeployerState | null) {
    return contractDeployedTrigger.poll({ params: { deployer: D }, state, block: (await chain.blockByNumber(chain.head))!, scope }, runtime(chain));
  }

  it("finds CREATE deployments from the deployer's nonce, with creation block and tx", async () => {
    const chain = new FakeChain();
    chain.mine([], { txs: [{ from: D, to: BOB }] }); // nonce 0: plain tx
    const first = await poll(chain, null);
    expect(first).toEqual({ state: { nonce: 1, block: 1 }, outcomes: [] });

    chain.mine([], { txs: [{ from: D, code: "0x6001" }] }); // nonce 1: deploy (block 2)
    chain.mine([], { txs: [{ from: D, to: BOB }] }); // nonce 2: plain
    chain.mine([], { txs: [{ from: D, code: "0x6002" }] }); // nonce 3: deploy (block 4)
    chain.mine([], { txs: [{ from: D }] }); // nonce 4: failed creation (no code)
    const second = await poll(chain, first.state);
    expect(second.state).toEqual({ nonce: 5, block: 5 });
    expect(second.outcomes.map((o) => o.kind === "match" && [o.key, o.payload.nonce, o.payload.creation_block])).toEqual([
      [`deploy:${created(1)}`, 1, 2],
      [`deploy:${created(3)}`, 3, 4],
    ]);
    const tx = chain.block(2)?.txs[0]?.hash;
    expect(second.outcomes[0]).toMatchObject({ payload: { contract: created(1), deployer: D, creation_tx: tx, creation_tx_url: `https://robinhoodchain.blockscout.com/tx/${tx}` } });
  });

  it("bounds work per poll for busy deployers and resumes without losing the creation block", async () => {
    const chain = new FakeChain();
    const first = await poll(chain, null);
    chain.mine([], { txs: Array.from({ length: MAX_NONCES_PER_POLL + 2 }, () => ({ from: D, to: BOB })) });
    chain.mine([], { txs: [{ from: D, code: "0x60" }] }); // nonce MAX+2
    const a = await poll(chain, first.state);
    expect(a.outcomes).toEqual([]);
    expect(a.state).toEqual({ nonce: MAX_NONCES_PER_POLL, block: 0 });
    const b = await poll(chain, a.state);
    expect(b.outcomes).toMatchObject([{ payload: { nonce: MAX_NONCES_PER_POLL + 2, creation_block: 2 } }]);
    expect(b.state).toEqual({ nonce: MAX_NONCES_PER_POLL + 3, block: 2 });
  });

  it("still fires when the creation block is beyond pruned history", async () => {
    const chain = new FakeChain({ stateWindow: 3 });
    const first = await poll(chain, null);
    chain.mine([], { txs: [{ from: D, code: "0x6001" }] });
    chain.mineEmpty(10);
    const { outcomes } = await poll(chain, first.state);
    expect(outcomes).toMatchObject([{ kind: "match", payload: { contract: created(0), creation_block: null, creation_tx: null } }]);
  });
});

describe("watches", () => {
  it("log triggers watch exactly (token|address, topic0)", () => {
    const transfer = normalizeHash("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(tokenTransferTrigger.watches({ token: TOKEN, direction: "any" })).toEqual([{ address: TOKEN, topic0: transfer }]);
    expect(createNewHolderTrigger().watches({ token: TOKEN })).toEqual([{ address: TOKEN, topic0: transfer }]);
    expect(ZERO).toBe("0x0000000000000000000000000000000000000000");
  });
});
