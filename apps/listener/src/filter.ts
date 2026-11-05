import type { NormalizedAddress, NormalizedHash } from "@ignitra/core";
import type { LogQuery, RawLog } from "@ignitra/chain";

export interface WatchKey {
  readonly address: NormalizedAddress;
  /** null = every event of the address. */
  readonly topic0: NormalizedHash | null;
}

interface Entry {
  all: boolean;
  topics: Set<NormalizedHash>;
}

/**
 * The set of (address, topic0) pairs the listener cares about.
 *
 * eth_getLogs can only express `address IN (…) AND topic0 IN (…)`, i.e. a
 * cross product. Queries therefore fetch a superset per address chunk and
 * `matches` applies the exact pairs client-side.
 */
export class WatchFilter {
  readonly #entries = new Map<NormalizedAddress, Entry>();

  static from(keys: Iterable<WatchKey>): WatchFilter {
    const filter = new WatchFilter();
    for (const key of keys) filter.add(key);
    return filter;
  }

  add({ address, topic0 }: WatchKey): void {
    const entry = this.#entries.get(address) ?? { all: false, topics: new Set<NormalizedHash>() };
    if (topic0 === null) entry.all = true;
    else entry.topics.add(topic0);
    this.#entries.set(address, entry);
  }

  union(other: WatchFilter): WatchFilter {
    const merged = new WatchFilter();
    for (const key of [...this.keys(), ...other.keys()]) merged.add(key);
    return merged;
  }

  get size(): number {
    return this.#entries.size;
  }

  get addresses(): NormalizedAddress[] {
    return [...this.#entries.keys()];
  }

  *keys(): Generator<WatchKey> {
    for (const [address, entry] of this.#entries) {
      if (entry.all) yield { address, topic0: null };
      for (const topic0 of entry.topics) yield { address, topic0 };
    }
  }

  matches(log: Pick<RawLog, "address" | "topics">): boolean {
    const entry = this.#entries.get(log.address);
    if (!entry) return false;
    if (entry.all) return true;
    const topic0 = log.topics[0];
    return topic0 !== undefined && entry.topics.has(topic0);
  }

  /** Query shapes for a block range: addresses chunked, topic0 OR-set per chunk (null if any wildcard). */
  queries(fromBlock: number, toBlock: number, chunkSize: number): LogQuery[] {
    const addresses = this.addresses.sort();
    const out: LogQuery[] = [];
    for (let i = 0; i < addresses.length; i += chunkSize) {
      const chunk = addresses.slice(i, i + chunkSize);
      let wildcard = false;
      const topics = new Set<NormalizedHash>();
      for (const a of chunk) {
        const entry = this.#entries.get(a);
        if (!entry || entry.all) wildcard = true;
        else for (const t of entry.topics) topics.add(t);
      }
      out.push({ fromBlock, toBlock, addresses: chunk, topic0s: wildcard ? null : [...topics].sort() });
    }
    return out;
  }
}
