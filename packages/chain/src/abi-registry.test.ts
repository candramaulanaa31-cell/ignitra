import { describe, expect, it, vi } from "vitest";
import type { Abi } from "viem";
import { AbiRegistry, BlockscoutAbiFetcher, MemoryAbiStore, type AbiFetcher, type AbiFetchResult } from "./abi-registry";
import { EIP1967_IMPLEMENTATION_SLOT } from "./abis";
import { FakeChain, addr } from "./testing";

const PROXY = addr(0x1);
const IMPL = addr(0x2);
const proxyAbi = [{ type: "event", name: "Upgraded", inputs: [{ type: "address", name: "implementation", indexed: true }] }] as Abi;
const implAbi = [{ type: "function", name: "mint", inputs: [], outputs: [], stateMutability: "nonpayable" }] as Abi;

function fakeFetcher(map: Record<string, AbiFetchResult | Error>): AbiFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    source: "fake",
    calls,
    async fetch(address) {
      calls.push(address);
      const r = map[address] ?? { status: "unverified" };
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe("AbiRegistry", () => {
  it("merges an EIP-1967 proxy with its implementation (slot read over RPC)", async () => {
    const chain = new FakeChain();
    chain.storage.set(`${PROXY}:${EIP1967_IMPLEMENTATION_SLOT}`, `0x${"0".repeat(24)}${IMPL.slice(2)}`);
    const fetcher = fakeFetcher({
      [PROXY]: { status: "verified", abi: proxyAbi, implementations: [] },
      [IMPL]: { status: "verified", abi: implAbi, implementations: [] },
    });
    const registry = new AbiRegistry({ store: new MemoryAbiStore(), fetcher, reader: chain });
    const entry = await registry.refresh(PROXY);
    expect(entry).toMatchObject({ status: "verified", implementation: IMPL, source: "fake" });
    expect(entry?.abi).toHaveLength(2);
    expect(registry.cached(PROXY)).toHaveLength(2);
  });

  it("caches results and negative results with TTLs", async () => {
    let now = 1_000_000;
    const fetcher = fakeFetcher({});
    const registry = new AbiRegistry({
      store: new MemoryAbiStore(),
      fetcher,
      reader: null,
      now: () => now,
      ttlMs: { unverified: 1000 },
    });
    expect((await registry.refresh(PROXY))?.status).toBe("unverified");
    await registry.refresh(PROXY);
    expect(fetcher.calls).toHaveLength(1);
    now += 1000;
    await registry.refresh(PROXY);
    expect(fetcher.calls).toHaveLength(2);
  });

  it("never downgrades a verified ABI on a transient explorer failure", async () => {
    let now = 0;
    let result: AbiFetchResult | Error = { status: "verified", abi: implAbi, implementations: [] };
    const fetcher: AbiFetcher = { source: "fake", fetch: async () => { if (result instanceof Error) throw result; return result; } };
    const onError = vi.fn();
    const registry = new AbiRegistry({ store: new MemoryAbiStore(), fetcher, reader: null, now: () => now, onError, ttlMs: { verified: 100, error: 10 } });
    await registry.refresh(IMPL);
    now = 200;
    result = new Error("explorer down");
    const entry = await registry.refresh(IMPL);
    expect(entry).toMatchObject({ status: "verified", error: "explorer down" });
    expect(entry?.abi).toEqual(implAbi);
    expect(onError).toHaveBeenCalledOnce();
    // retried after the short error TTL, not the long verified TTL
    now = 211;
    expect(registry.isStale(entry)).toBe(true);
  });

  it("records an error entry when nothing was known", async () => {
    const registry = new AbiRegistry({ store: new MemoryAbiStore(), fetcher: fakeFetcher({ [IMPL]: new Error("boom") }), reader: null });
    expect(await registry.refresh(IMPL)).toMatchObject({ status: "error", abi: null, error: "boom" });
  });

  it("loads from the persistent store without fetching", async () => {
    const store = new MemoryAbiStore();
    await store.put(IMPL, { status: "verified", abi: implAbi, implementation: null, source: "x", error: null, fetchedAt: new Date() });
    const fetcher = fakeFetcher({});
    const registry = new AbiRegistry({ store, fetcher, reader: null });
    expect(registry.cached(IMPL)).toBeNull();
    await registry.refresh(IMPL);
    expect(fetcher.calls).toHaveLength(0);
    expect(registry.cached(IMPL)).toEqual(implAbi);
  });

  it("prefetches in the background, de-duplicated, and invalidates on demand", async () => {
    const fetcher = fakeFetcher({ [IMPL]: { status: "verified", abi: implAbi, implementations: [] } });
    const registry = new AbiRegistry({ store: new MemoryAbiStore(), fetcher, reader: null });
    registry.prefetch([IMPL, IMPL]);
    registry.prefetch([IMPL]);
    await registry.idle();
    expect(fetcher.calls).toEqual([IMPL]);
    registry.invalidate(IMPL);
    await registry.idle();
    expect(fetcher.calls).toEqual([IMPL, IMPL]);
  });

  it("is a no-op without a fetcher (no API key configured)", async () => {
    const registry = new AbiRegistry({ store: new MemoryAbiStore(), fetcher: null, reader: null });
    expect(registry.fetchEnabled).toBe(false);
    registry.prefetch([IMPL]);
    await registry.idle();
    expect(await registry.refresh(IMPL)).toBeNull();
  });
});

describe("BlockscoutAbiFetcher", () => {
  const make = (handler: (url: string, init: RequestInit) => Response) => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = new BlockscoutAbiFetcher({
      baseUrl: "https://api.blockscout.com/4663/",
      apiKey: "proapi_test",
      minIntervalMs: 0,
      fetch: async (url, init) => {
        seen.push({ url, init });
        return handler(url, init);
      },
    });
    return { fetcher, seen };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads abi + implementations and sends the key as a bearer header", async () => {
    const { fetcher, seen } = make(() =>
      json({ abi: implAbi, implementations: [{ address_hash: "0x00000000000000000000000000000000000000AA", name: "Impl" }] }),
    );
    const result = await fetcher.fetch(PROXY);
    expect(result).toEqual({ status: "verified", abi: implAbi, implementations: [addr(0xaa)] });
    expect(seen[0]?.url).toBe(`https://api.blockscout.com/4663/api/v2/smart-contracts/${PROXY}`);
    expect(seen[0]?.url).not.toContain("proapi_test");
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer proapi_test");
  });

  it("maps 404 / missing abi to unverified", async () => {
    expect(await make(() => json({ message: "Not found" }, 404)).fetcher.fetch(PROXY)).toEqual({ status: "unverified" });
    expect(await make(() => json({ abi: null })).fetcher.fetch(PROXY)).toEqual({ status: "unverified" });
  });

  it("treats challenge pages, auth errors and 5xx as transient failures", async () => {
    const html = () => new Response("<!DOCTYPE html>Just a moment...", { status: 200, headers: { "content-type": "text/html" } });
    await expect(make(html).fetcher.fetch(PROXY)).rejects.toThrow(/non-JSON/);
    await expect(make(() => json({}, 401)).fetcher.fetch(PROXY)).rejects.toThrow(/API key/);
    await expect(make(() => json({}, 502)).fetcher.fetch(PROXY)).rejects.toThrow(/HTTP 502/);
  });
});
