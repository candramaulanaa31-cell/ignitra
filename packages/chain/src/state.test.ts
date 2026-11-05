import { decodeFunctionResult, encodeFunctionData, getContractAddress, parseAbiItem } from "viem";
import { describe, expect, it } from "vitest";
import { BUILTIN_ABIS } from "./abis";
import { decodeEthBalance, ethBalanceCall, formatEventFragment, multicall } from "./multicall";
import { RpcPool, asQueryError, type RpcEndpoint } from "./rpc";
import { FakeChain, addr } from "./testing";
import { CallRevertedError, LogRangeTooLargeError, StateUnavailableError } from "./types";

const ALICE = addr(0xa1);
const BOB = addr(0xb0);

describe("query-level RPC errors", () => {
  it("classifies reverts, pruned state and oversized log queries", () => {
    expect(asQueryError("eth_call", 3, "execution reverted", "0x800ab12c")).toBeInstanceOf(CallRevertedError);
    expect((asQueryError("eth_call", 3, "execution reverted", "0x800AB12C") as CallRevertedError).data).toBe("0x800ab12c");
    expect(asQueryError("eth_call", -32000, "historical state 9413043e is not available", null)).toBeInstanceOf(StateUnavailableError);
    expect(asQueryError("eth_getCode", -32000, "missing trie node abc", null)).toBeInstanceOf(StateUnavailableError);
    expect(asQueryError("eth_getLogs", -32000, "logs matched by query exceeds limit of 10000", null)).toBeInstanceOf(LogRangeTooLargeError);
    expect(asQueryError("eth_call", -32000, "Too Many Requests", null)).toBeNull();
    expect(asQueryError("eth_blockNumber", -32000, "execution reverted", null)).toBeNull();
  });

  it("keeps the endpoint healthy on a revert, and tries another node for pruned state", async () => {
    const calls: string[] = [];
    const ep = (name: string, error: Error | null): RpcEndpoint => ({
      name,
      label: name,
      async request() {
        calls.push(name);
        if (error) throw error;
        return "0x01";
      },
    });
    const reverting = new RpcPool([ep("primary", new CallRevertedError("reverted")), ep("archive", null)]);
    await expect(reverting.request("eth_call")).rejects.toBeInstanceOf(CallRevertedError);
    expect(calls).toEqual(["primary"]);
    expect(reverting.stats()[0]).toMatchObject({ failures: 0, coolingDown: false });

    calls.length = 0;
    const pruned = new RpcPool([ep("primary", new StateUnavailableError("pruned")), ep("archive", null)]);
    expect(await pruned.request("eth_call")).toBe("0x01");
    expect(calls).toEqual(["primary", "archive"]);
    expect(pruned.stats()[0]).toMatchObject({ failures: 0, coolingDown: false });
  });
});

describe("FakeChain state simulation", () => {
  it("tracks ERC-20 balances and supply per block, and rolls them back on reorg", async () => {
    const chain = new FakeChain();
    const token = chain.token(addr(0x70c), { symbol: "USDG", decimals: 6 });
    chain.mine([token.mint(ALICE, 100n)]); // block 1
    chain.mine([token.transfer(ALICE, BOB, 40n)]); // block 2
    expect(token.balanceOf(ALICE, 1)).toBe(100n);
    expect(token.balanceOf(ALICE, 2)).toBe(60n);
    expect(token.totalSupply(2)).toBe(100n);

    chain.reorg(1, [[]]);
    expect(token.balanceOf(BOB, chain.head)).toBe(0n);
  });

  it("answers balanceOf / metadata and native balances through Multicall3 at historical blocks", async () => {
    const chain = new FakeChain();
    const token = chain.token(addr(0x70c), { symbol: "USDG", decimals: 6 });
    chain.mine([token.mint(ALICE, 5n)]);
    chain.setNativeBalance(BOB, 10n ** 18n);
    chain.mine();
    const balanceOf = (who: string) =>
      ({ target: token.address, callData: encodeFunctionData({ abi: BUILTIN_ABIS.erc20, functionName: "balanceOf", args: [who as `0x${string}`] }) }) as const;
    const results = await multicall(chain, [balanceOf(ALICE), balanceOf(BOB), ethBalanceCall(BOB), { target: token.address, callData: "0xdeadbeef" }], { blockNumber: 1 });
    expect(results.map((r) => r.success)).toEqual([true, true, true, false]);
    expect(decodeFunctionResult({ abi: BUILTIN_ABIS.erc20, functionName: "balanceOf", data: results[0]!.returnData })).toBe(5n);
    expect(decodeEthBalance(results[2]!)).toBe(10n ** 18n);
    expect(chain.calls.call).toBe(1); // one RPC request for four reads
  });

  it("models nonces, CREATE addresses and deployed code", async () => {
    const chain = new FakeChain();
    chain.mine([], { txs: [{ from: ALICE, to: BOB }] }); // nonce 0: plain tx
    chain.mine([], { txs: [{ from: ALICE, code: "0x6001" }] }); // nonce 1: deployment
    const created = getContractAddress({ from: ALICE, nonce: 1n, opcode: "CREATE" }).toLowerCase() as `0x${string}`;
    expect(await chain.getTransactionCount(ALICE)).toBe(2);
    expect(await chain.getCode(created as never)).toBe("0x6001");
    expect(await chain.getCode(created as never, 1)).toBe("0x");
    expect((await chain.blockTransactions(2))?.[0]).toMatchObject({ from: ALICE, to: null, nonce: 1 });
  });

  it("prunes historical state like a full node", async () => {
    const chain = new FakeChain({ stateWindow: 5 });
    chain.mineEmpty(10);
    await expect(chain.getBalance(ALICE, 2)).rejects.toBeInstanceOf(StateUnavailableError);
    await expect(chain.getBalance(ALICE, 6)).resolves.toBe(0n);
  });
});

describe("formatEventFragment", () => {
  it("round-trips through viem's parser", () => {
    for (const fragment of [
      "event Transfer(address indexed from, address indexed to, uint256 value)",
      "event Launched(address indexed token, string symbol, uint256[] tiers, (address owner, uint64 cap) config)",
    ]) {
      const parsed = parseAbiItem(fragment) as Parameters<typeof formatEventFragment>[0];
      expect(formatEventFragment(parsed)).toBe(fragment);
    }
  });
});
