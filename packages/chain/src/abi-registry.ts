import type { Abi } from "viem";
import { normalizeAddress, tryNormalizeAddress, type AbiStatus, type NormalizedAddress } from "@ignitra/core";
import { EIP1967_IMPLEMENTATION_SLOT } from "./abis";
import type { ChainReader } from "./types";

/**
 * Contract ABI registry: memory → persistent store → explorer.
 *
 * The ingestion hot path only reads caches (`cached`) and never waits on the
 * network. Explorer fetches run in a background queue, throttled, with
 * negative caching, so an unverified contract or a flaky explorer cannot slow
 * the listener or burn the API quota.
 */

export interface StoredAbi {
  readonly status: AbiStatus;
  readonly abi: Abi | null;
  readonly implementation: NormalizedAddress | null;
  readonly source: string;
  readonly error: string | null;
  readonly fetchedAt: Date;
}

export interface AbiStore {
  get(address: NormalizedAddress): Promise<StoredAbi | null>;
  put(address: NormalizedAddress, value: StoredAbi): Promise<void>;
}

export class MemoryAbiStore implements AbiStore {
  readonly rows = new Map<string, StoredAbi>();
  async get(address: NormalizedAddress): Promise<StoredAbi | null> {
    return this.rows.get(address) ?? null;
  }
  async put(address: NormalizedAddress, value: StoredAbi): Promise<void> {
    this.rows.set(address, value);
  }
}

export type AbiFetchResult =
  | { readonly status: "verified"; readonly abi: Abi; readonly implementations: readonly NormalizedAddress[] }
  | { readonly status: "unverified" };

export interface AbiFetcher {
  readonly source: string;
  /** Throws on transient failures (network, 5xx, blocked); returns `unverified` on a definitive miss. */
  fetch(address: NormalizedAddress): Promise<AbiFetchResult>;
}

export class AbiFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbiFetchError";
  }
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Blockscout PRO API (`https://api.blockscout.com/<chain_id>`), REST v2
 * `/api/v2/smart-contracts/<address>`. A free API key is required; it is sent
 * as a bearer header so it never appears in URLs or logs.
 */
export class BlockscoutAbiFetcher implements AbiFetcher {
  readonly source = "blockscout";
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchFn;
  readonly #timeoutMs: number;
  readonly #minIntervalMs: number;
  readonly #maxBytes: number;
  #nextSlot = 0;

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    fetch?: FetchFn;
    timeoutMs?: number;
    /** Free tier allows 5 RPS; stay well below it. */
    minIntervalMs?: number;
    maxBytes?: number;
  }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? 8_000;
    this.#minIntervalMs = opts.minIntervalMs ?? 500;
    this.#maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  }

  async #throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.#nextSlot - now;
    this.#nextSlot = Math.max(now, this.#nextSlot) + this.#minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async fetch(address: NormalizedAddress): Promise<AbiFetchResult> {
    await this.#throttle();
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/api/v2/smart-contracts/${address}`, {
        headers: { accept: "application/json", authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw new AbiFetchError(err instanceof Error && err.name === "TimeoutError" ? "explorer timeout" : "explorer unreachable");
    }
    if (res.status === 404) return { status: "unverified" };
    if (res.status === 401 || res.status === 403) throw new AbiFetchError(`explorer rejected the API key (HTTP ${res.status})`);
    if (!res.ok) throw new AbiFetchError(`explorer HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) throw new AbiFetchError("explorer returned non-JSON (blocked or down)");
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > this.#maxBytes) throw new AbiFetchError("explorer response too large");
    const text = await res.text();
    if (text.length > this.#maxBytes) throw new AbiFetchError("explorer response too large");

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AbiFetchError("explorer returned invalid JSON");
    }
    const record = (body ?? {}) as Record<string, unknown>;
    const abi = record.abi;
    if (!Array.isArray(abi) || abi.length === 0) return { status: "unverified" };
    const items = abi.filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null && typeof (i as { type?: unknown }).type === "string");

    const implementations: NormalizedAddress[] = [];
    if (Array.isArray(record.implementations)) {
      for (const impl of record.implementations) {
        const raw = (impl as Record<string, unknown> | null)?.address_hash ?? (impl as Record<string, unknown> | null)?.address;
        const normalized = typeof raw === "string" ? tryNormalizeAddress(raw) : null;
        if (normalized) implementations.push(normalized);
      }
    }
    return { status: "verified", abi: items as unknown as Abi, implementations };
  }
}

export interface AbiRegistryOptions {
  store: AbiStore;
  fetcher: AbiFetcher | null;
  /** Used to read the EIP-1967 implementation slot. */
  reader: Pick<ChainReader, "getStorageAt"> | null;
  now?: () => number;
  ttlMs?: { verified?: number; unverified?: number; error?: number };
  onError?: (address: NormalizedAddress, err: unknown) => void;
}

const DAY = 86_400_000;

function mergeAbis(...abis: Array<Abi | null>): Abi {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const abi of abis) {
    for (const item of abi ?? []) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out as Abi;
}

export class AbiRegistry {
  readonly #store: AbiStore;
  readonly #fetcher: AbiFetcher | null;
  readonly #reader: Pick<ChainReader, "getStorageAt"> | null;
  readonly #now: () => number;
  readonly #ttl: { verified: number; unverified: number; error: number };
  readonly #onError: (address: NormalizedAddress, err: unknown) => void;
  readonly #memory = new Map<string, StoredAbi>();
  readonly #inflight = new Map<string, Promise<StoredAbi | null>>();
  readonly #queue = new Set<NormalizedAddress>();
  #draining: Promise<void> | null = null;

  constructor(opts: AbiRegistryOptions) {
    this.#store = opts.store;
    this.#fetcher = opts.fetcher;
    this.#reader = opts.reader;
    this.#now = opts.now ?? Date.now;
    this.#ttl = {
      verified: opts.ttlMs?.verified ?? 7 * DAY,
      unverified: opts.ttlMs?.unverified ?? DAY,
      error: opts.ttlMs?.error ?? 10 * 60_000,
    };
    this.#onError = opts.onError ?? (() => {});
  }

  get fetchEnabled(): boolean {
    return this.#fetcher !== null;
  }

  /** Synchronous, memory only — safe on the hot path. */
  cached(address: NormalizedAddress): Abi | null {
    return this.#memory.get(address)?.abi ?? null;
  }

  /** Memory → store. Never touches the network. */
  async load(address: NormalizedAddress): Promise<StoredAbi | null> {
    const hit = this.#memory.get(address);
    if (hit) return hit;
    const stored = await this.#store.get(address);
    if (stored) this.#memory.set(address, stored);
    return stored;
  }

  isStale(entry: StoredAbi | null): boolean {
    if (!entry) return true;
    const ttl = this.#ttl[entry.status];
    return this.#now() - entry.fetchedAt.getTime() >= ttl;
  }

  /** Re-fetch from the explorer if stale (or forced). De-duplicates concurrent calls. */
  async refresh(address: NormalizedAddress, opts: { force?: boolean } = {}): Promise<StoredAbi | null> {
    const current = await this.load(address);
    if (!this.#fetcher || (!opts.force && !this.isStale(current))) return current;
    const running = this.#inflight.get(address);
    if (running) return running;
    const task = this.#fetchAndStore(address, current).finally(() => this.#inflight.delete(address));
    this.#inflight.set(address, task);
    return task;
  }

  /** Forget the cached ABI freshness, e.g. after an `Upgraded` event, and queue a refetch. */
  invalidate(address: NormalizedAddress): void {
    const hit = this.#memory.get(address);
    if (hit) this.#memory.set(address, { ...hit, fetchedAt: new Date(0) });
    this.prefetch([address]);
  }

  /** Queue background refreshes; returns immediately. */
  prefetch(addresses: Iterable<NormalizedAddress>): void {
    if (!this.#fetcher) return;
    for (const a of addresses) this.#queue.add(a);
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = null;
    });
  }

  /** Resolves once the background queue is empty (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.#draining) await this.#draining;
  }

  async #drain(): Promise<void> {
    while (this.#queue.size > 0) {
      const [next] = this.#queue;
      if (!next) break;
      this.#queue.delete(next);
      try {
        await this.refresh(next);
      } catch (err) {
        this.#onError(next, err);
      }
    }
  }

  async #implementationOf(address: NormalizedAddress, hinted: readonly NormalizedAddress[]): Promise<NormalizedAddress | null> {
    if (this.#reader) {
      try {
        const slot = await this.#reader.getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT);
        const impl = slot.length >= 42 ? `0x${slot.slice(-40)}` : null;
        if (impl && !/^0x0{40}$/.test(impl)) return normalizeAddress(impl);
      } catch {
        // fall through to the explorer hint
      }
    }
    return hinted.find((h) => h !== address) ?? null;
  }

  async #fetchAndStore(address: NormalizedAddress, previous: StoredAbi | null): Promise<StoredAbi | null> {
    const fetcher = this.#fetcher;
    if (!fetcher) return previous;
    let entry: StoredAbi;
    try {
      const own = await fetcher.fetch(address);
      const implementation = await this.#implementationOf(address, own.status === "verified" ? own.implementations : []);
      let implAbi: Abi | null = null;
      if (implementation) {
        const impl = await fetcher.fetch(implementation);
        if (impl.status === "verified") implAbi = impl.abi;
      }
      const ownAbi = own.status === "verified" ? own.abi : null;
      const merged = ownAbi || implAbi ? mergeAbis(ownAbi, implAbi) : null;
      entry = {
        status: merged ? "verified" : "unverified",
        abi: merged,
        implementation,
        source: fetcher.source,
        error: null,
        fetchedAt: new Date(this.#now()),
      };
    } catch (err) {
      this.#onError(address, err);
      const message = err instanceof Error ? err.message : String(err);
      // Never downgrade a known-good ABI because the explorer had a bad moment.
      entry = previous?.status === "verified"
        ? { ...previous, error: message, fetchedAt: new Date(this.#now() - this.#ttl.verified + this.#ttl.error) }
        : { status: "error", abi: null, implementation: null, source: fetcher.source, error: message, fetchedAt: new Date(this.#now()) };
    }
    await this.#store.put(address, entry);
    this.#memory.set(address, entry);
    return entry;
  }
}
