import { describe, expect, it } from "vitest";
import {
  ChainIdMismatchError,
  HttpJsonRpcEndpoint,
  RpcChainReader,
  RpcError,
  RpcPool,
  asRangeTooLarge,
  parseLog,
  parseQuantity,
  type RpcEndpoint,
} from "./rpc";
import { LogRangeTooLargeError } from "./types";

function endpoint(name: string, handler: (method: string, params: readonly unknown[]) => unknown): RpcEndpoint & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    label: name,
    calls,
    async request(method, params) {
      calls.push(method);
      return handler(method, params);
    },
  };
}

const fail = (message: string) => () => {
  throw new RpcError("x", message);
};

describe("asRangeTooLarge", () => {
  it.each([
    ["logs matched by query exceeds limit of 10000", null],
    ["query spans 49994 blocks (1 to 2), but only 30000 are allowed for this request; narrow the block range", 30000],
    ["query returned more than 10000 results", null],
    ["block range is too wide", null],
    ["maximum block range is 2000", 2000],
  ])("recognizes %j", (message, maxBlocks) => {
    const err = asRangeTooLarge(message);
    expect(err).toBeInstanceOf(LogRangeTooLargeError);
    expect(err?.maxBlocks).toBe(maxBlocks);
  });

  it.each(["daily request count exceeded, request rate limited", "Too Many Requests", "header not found", "execution reverted"])(
    "does not treat %j as a range problem",
    (message) => {
      expect(asRangeTooLarge(message)).toBeNull();
    },
  );
});

describe("RpcPool", () => {
  it("fails over to the next endpoint and cools the broken one down", async () => {
    let now = 0;
    const primary = endpoint("primary", fail("network error"));
    const fallback = endpoint("fallback", () => "0x10");
    const pool = new RpcPool([primary, fallback], { cooldownMs: 1000, now: () => now });

    expect(await pool.request("eth_blockNumber")).toBe("0x10");
    expect(await pool.request("eth_blockNumber")).toBe("0x10");
    expect(primary.calls).toHaveLength(1); // second call skipped primary (cooling down)

    now = 1001;
    await pool.request("eth_blockNumber");
    expect(primary.calls).toHaveLength(2); // retried after cooldown

    const [p, f] = pool.stats();
    expect(p).toMatchObject({ name: "primary", failures: 2, consecutiveFailures: 2, lastError: "network error" });
    expect(f).toMatchObject({ name: "fallback", failures: 0 });
  });

  it("does not fail over on range-too-large (the node is healthy)", async () => {
    const primary = endpoint("primary", () => {
      throw new LogRangeTooLargeError("too big");
    });
    const fallback = endpoint("fallback", () => []);
    const pool = new RpcPool([primary, fallback]);
    await expect(pool.request("eth_getLogs")).rejects.toBeInstanceOf(LogRangeTooLargeError);
    expect(fallback.calls).toHaveLength(0);
    expect(pool.stats()[0]?.failures).toBe(0);
  });

  it("throws the last error when every endpoint fails, and still tries when all are cooling", async () => {
    const pool = new RpcPool([endpoint("a", fail("a down")), endpoint("b", fail("b down"))]);
    await expect(pool.request("eth_chainId")).rejects.toThrow("b down");
    await expect(pool.request("eth_chainId")).rejects.toThrow("b down");
  });

  it("verifies chain id: drops a wrong fallback, refuses a wrong primary", async () => {
    const good = endpoint("primary", () => "0x1237");
    const wrong = endpoint("fallback", () => "0x1");
    const pool = new RpcPool([good, wrong]);
    const { dropped } = await pool.verifyChainId(4663);
    expect(dropped).toEqual([{ name: "fallback", reason: expect.stringContaining("serves chain 1") }]);
    expect(pool.endpoints.map((e) => e.name)).toEqual(["primary"]);

    await expect(new RpcPool([wrong]).verifyChainId(4663)).rejects.toBeInstanceOf(ChainIdMismatchError);
  });
});

describe("HttpJsonRpcEndpoint", () => {
  const respond = (status: number, body: string, type = "application/json") =>
    (async () => new Response(body, { status, headers: { "content-type": type } })) as never;

  it("returns results and maps errors", async () => {
    expect(await new HttpJsonRpcEndpoint("p", "https://rpc.example/key", { fetch: respond(200, '{"result":"0x1"}') }).request("eth_chainId", [])).toBe("0x1");

    const rpcErr = new HttpJsonRpcEndpoint("p", "https://rpc.example", { fetch: respond(200, '{"error":{"code":-32000,"message":"header not found"}}') });
    await expect(rpcErr.request("eth_getBlockByNumber", [])).rejects.toMatchObject({ name: "RpcError", code: -32000 });

    const range = new HttpJsonRpcEndpoint("p", "https://rpc.example", {
      fetch: respond(200, '{"error":{"code":-32000,"message":"logs matched by query exceeds limit of 10000"}}'),
    });
    await expect(range.request("eth_getLogs", [])).rejects.toBeInstanceOf(LogRangeTooLargeError);

    const html = new HttpJsonRpcEndpoint("p", "https://rpc.example", { fetch: respond(503, "<html>", "text/html") });
    await expect(html.request("eth_chainId", [])).rejects.toMatchObject({ httpStatus: 503 });
  });

  it("never exposes the URL (API keys live in RPC URLs)", () => {
    expect(new HttpJsonRpcEndpoint("p", "https://rpc.example/v2/SECRET").label).toBe("https://rpc.example/***");
  });
});

describe("parsing", () => {
  it("rejects malformed or unsafe quantities", () => {
    expect(parseQuantity("0x65c314d", "n")).toBe(106_705_229);
    expect(() => parseQuantity("123", "n")).toThrow();
    expect(() => parseQuantity("0x20000000000000", "n")).toThrow(/safe integer/);
  });

  const log = {
    address: "0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168",
    topics: [`0x${"DD".repeat(32)}`],
    data: "0xABCD",
    blockNumber: "0x10",
    blockHash: `0x${"11".repeat(32)}`,
    blockTimestamp: "0x6a0b1c2d",
    transactionHash: `0x${"22".repeat(32)}`,
    transactionIndex: "0x1",
    logIndex: "0x2",
    removed: false,
  };

  it("normalizes logs and keeps Nitro's blockTimestamp", () => {
    expect(parseLog(log)).toEqual({
      address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      topics: [`0x${"dd".repeat(32)}`],
      data: "0xabcd",
      blockNumber: 16,
      blockHash: `0x${"11".repeat(32)}`,
      blockTimestamp: 0x6a0b1c2d,
      txHash: `0x${"22".repeat(32)}`,
      txIndex: 1,
      logIndex: 2,
    });
    expect(parseLog({ ...log, blockTimestamp: undefined })?.blockTimestamp).toBeNull();
    expect(parseLog({ ...log, removed: true })).toBeNull();
    expect(() => parseLog({ ...log, data: "0xabc" })).toThrow();
  });

  it("builds eth_getLogs params with an OR-set on topic0", async () => {
    let seen: unknown;
    const ep = endpoint("p", (_m, params) => {
      seen = params[0];
      return [log];
    });
    const reader = new RpcChainReader(new RpcPool([ep]));
    const a = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as never;
    const logs = await reader.getLogs({ fromBlock: 16, toBlock: 31, addresses: [a], topic0s: [`0x${"dd".repeat(32)}` as never] });
    expect(logs).toHaveLength(1);
    expect(seen).toEqual({ fromBlock: "0x10", toBlock: "0x1f", address: a, topics: [[`0x${"dd".repeat(32)}`]] });
    expect(await reader.getLogs({ fromBlock: 1, toBlock: 2, addresses: [], topic0s: null })).toEqual([]);
  });
});
