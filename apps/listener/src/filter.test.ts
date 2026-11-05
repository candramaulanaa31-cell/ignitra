import { describe, expect, it } from "vitest";
import { normalizeHash } from "@ignitra/core";
import { addr } from "@ignitra/chain/testing";
import { WatchFilter } from "./filter";

const T1 = normalizeHash(`0x${"01".repeat(32)}`);
const T2 = normalizeHash(`0x${"02".repeat(32)}`);
const A = addr(1);
const B = addr(2);
const C = addr(3);

describe("WatchFilter", () => {
  it("matches exact (address, topic0) pairs, not the query cross product", () => {
    const f = WatchFilter.from([
      { address: A, topic0: T1 },
      { address: B, topic0: T2 },
    ]);
    expect(f.matches({ address: A, topics: [T1] })).toBe(true);
    expect(f.matches({ address: A, topics: [T2] })).toBe(false); // in the superset query, not watched
    expect(f.matches({ address: B, topics: [T2] })).toBe(true);
    expect(f.matches({ address: C, topics: [T1] })).toBe(false);
    expect(f.matches({ address: A, topics: [] })).toBe(false);
  });

  it("wildcards match every event, including anonymous logs", () => {
    const f = WatchFilter.from([{ address: A, topic0: null }]);
    expect(f.matches({ address: A, topics: [] })).toBe(true);
    expect(f.matches({ address: A, topics: [T2] })).toBe(true);
  });

  it("builds chunked queries with a topic0 OR-set, dropping it when a chunk has a wildcard", () => {
    const f = WatchFilter.from([
      { address: A, topic0: T1 },
      { address: B, topic0: T2 },
      { address: C, topic0: null },
    ]);
    expect(f.queries(10, 20, 2)).toEqual([
      { fromBlock: 10, toBlock: 20, addresses: [A, B], topic0s: [T1, T2] },
      { fromBlock: 10, toBlock: 20, addresses: [C], topic0s: null },
    ]);
  });

  it("unions without duplicates", () => {
    const merged = WatchFilter.from([{ address: A, topic0: T1 }]).union(
      WatchFilter.from([
        { address: A, topic0: T1 },
        { address: A, topic0: T2 },
      ]),
    );
    expect([...merged.keys()]).toEqual([
      { address: A, topic0: T1 },
      { address: A, topic0: T2 },
    ]);
  });
});
