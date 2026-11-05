import type { Logger } from "pino";
import type { ConfirmationStrategy, NormalizedHash } from "@ignitra/core";
import { LogRangeTooLargeError, type AbiRegistry, type ChainReader, type EventDecoder, type RawLog } from "@ignitra/chain";
import type { NewChainEvent } from "@ignitra/db";
import { WatchFilter } from "./filter";
import type { ActiveWatch, Cursor, ListenerStore } from "./store";

/**
 * ChainSync — reorg-safe, resumable log ingestion.
 *
 * Each tick:
 *   1. hold the lease (one active listener per chain)
 *   2. deep-reorg check: is the confirmed cursor's block hash still canonical?
 *      if not, re-verify the last REORG_REWIND_BLOCKS blocks
 *   3. confirmed pass: (cursor, confirmedHead] — re-query canonical logs and
 *      reconcile: insert/promote → confirmed, vanished → reverted
 *   4. pending pass (only for fast watches, only when caught up):
 *      (max(pendingCursor, confirmedHead), head] → pending
 *
 * Confirmation is decided by RE-QUERYING at depth, not by trusting what was
 * seen at head, so any reorg shallower than the confirmation depth is
 * absorbed without special cases.
 */

export interface SyncOptions {
  strategy: ConfirmationStrategy;
  depth: number;
  maxRange: number;
  addressChunk: number;
  rewindBlocks: number;
  /** Fresh database start block; default = current confirmed head. */
  startBlock?: number | undefined;
}

export interface TickReport {
  readonly role: "leader" | "standby";
  readonly head?: number;
  readonly confirmedHead?: number;
  readonly confirmedCursor?: number;
  readonly pendingCursor?: number | null;
  readonly confirmed?: { from: number; to: number; upserted: number; inserted: number; reverted: number };
  readonly pending?: { from: number; to: number; inserted: number };
  readonly deepReorg?: { at: number; rewoundTo: number; deepReverted: number };
  readonly watchCount?: number;
}

export class LogTooDenseError extends Error {
  constructor(block: number) {
    super(`block ${block} alone exceeds the node's log limit for the watched set; split watches across listeners`);
    this.name = "LogTooDenseError";
  }
}

const identity = (l: Pick<RawLog, "blockHash" | "logIndex">): string => `${l.blockHash}:${l.logIndex}`;
/** Consecutive successful fetches before the range doubles again (density is usually local). */
const GROW_AFTER = 5;

export class ChainSync {
  readonly #reader: ChainReader;
  readonly #store: ListenerStore;
  readonly #decoder: EventDecoder;
  readonly #abis: AbiRegistry | null;
  readonly #opts: SyncOptions;
  readonly #log: Logger;
  #range: number;
  /** Hard cap stated by the node (e.g. "only 30000 blocks are allowed"). */
  #nodeCap = Number.POSITIVE_INFINITY;
  #rangeSuccesses = 0;
  #knownAbiAddresses = new Set<string>();
  readonly #timestampCache = new Map<string, number>();

  constructor(deps: {
    reader: ChainReader;
    store: ListenerStore;
    decoder: EventDecoder;
    abis: AbiRegistry | null;
    options: SyncOptions;
    logger: Logger;
  }) {
    this.#reader = deps.reader;
    this.#store = deps.store;
    this.#decoder = deps.decoder;
    this.#abis = deps.abis;
    this.#opts = deps.options;
    this.#log = deps.logger;
    this.#range = deps.options.maxRange;
  }

  /** Current adaptive getLogs range (shrinks on node refusals, regrows slowly). */
  get range(): number {
    return this.#range;
  }

  async confirmedHead(head: number): Promise<number> {
    if (this.#opts.strategy === "depth") return Math.max(0, head - this.#opts.depth);
    const tagged = await this.#reader.blockByTag(this.#opts.strategy);
    if (!tagged) throw new Error(`node returned no "${this.#opts.strategy}" block`);
    return Math.min(tagged.number, head);
  }

  async tick(): Promise<TickReport> {
    if (!(await this.#store.acquireLease())) return { role: "standby" };

    const head = await this.#reader.blockNumber();
    const confirmedHead = await this.confirmedHead(head);
    const active = await this.#store.loadWatches();
    const filter = WatchFilter.from(active);
    const fast = WatchFilter.from(active.filter((w) => w.fast));
    await this.#loadAbis(filter);

    let cursor = await this.#store.getCursor("confirmed");
    if (!cursor) {
      const start = this.#opts.startBlock ?? confirmedHead;
      await this.#store.initCursors(start);
      this.#log.info({ start }, "fresh start: cursors initialized");
      cursor = { blockNumber: start, blockHash: null };
    }

    let deepReorg: TickReport["deepReorg"];
    if (cursor.blockHash) {
      const header = await this.#reader.blockByNumber(cursor.blockNumber);
      if (!header || header.hash !== cursor.blockHash) {
        const rewoundTo = Math.max(0, cursor.blockNumber - this.#opts.rewindBlocks);
        this.#log.error(
          { block: cursor.blockNumber, stored: cursor.blockHash, canonical: header?.hash ?? null, rewoundTo },
          "reorg below the confirmed cursor — re-verifying window",
        );
        const result = await this.#reconcile(rewoundTo + 1, cursor.blockNumber, filter);
        deepReorg = { at: cursor.blockNumber, rewoundTo, deepReverted: result.deepReverted };
        cursor = result.cursor;
      }
    }

    let confirmed: TickReport["confirmed"];
    if (confirmedHead > cursor.blockNumber) {
      const from = cursor.blockNumber + 1;
      const to = Math.min(confirmedHead, cursor.blockNumber + this.#range);
      const result = await this.#reconcile(from, to, filter);
      confirmed = { from, to, upserted: result.upserted, inserted: result.inserted, reverted: result.reverted };
      cursor = result.cursor;
    }

    let pending: TickReport["pending"];
    let pendingCursor = (await this.#store.getCursor("pending"))?.blockNumber ?? null;
    const caughtUp = cursor.blockNumber >= confirmedHead;
    if (fast.size > 0 && caughtUp && head > confirmedHead) {
      const from = Math.max(pendingCursor ?? 0, confirmedHead) + 1;
      const to = Math.min(head, from + this.#range - 1);
      if (to >= from) {
        const logs = await this.#fetch(from, to, fast);
        await this.#fillTimestamps(logs);
        const inserted = await this.#store.commitPending({
          rows: logs.map((l) => this.#row(l)),
          cursor: { blockNumber: to, blockHash: null },
        });
        pending = { from, to, inserted };
        pendingCursor = to;
      }
    }

    return {
      role: "leader",
      head,
      confirmedHead,
      confirmedCursor: cursor.blockNumber,
      pendingCursor,
      watchCount: active.length,
      ...(confirmed ? { confirmed } : {}),
      ...(pending ? { pending } : {}),
      ...(deepReorg ? { deepReorg } : {}),
    };
  }

  async #reconcile(from: number, to: number, filter: WatchFilter) {
    const live = await this.#store.liveEvents(from, to);
    let logs: RawLog[] = [];
    let toHash: NormalizedHash | null = null;

    if (filter.size > 0 || live.keys.length > 0) {
      const requery = filter.union(WatchFilter.from(live.keys));
      const fetched = await this.#fetch(from, to, requery);
      // Keep what is watched now, plus anything we already stored (so removing
      // a watch never turns its pending rows into false reverts).
      logs = fetched.filter((l) => filter.matches(l) || live.identities.has(identity(l)));
      await this.#fillTimestamps(logs);
      // Hash of `to` anchors the next deep-reorg check. Only needed while something is watched.
      toHash = logs.findLast((l) => l.blockNumber === to)?.blockHash ?? (await this.#reader.blockByNumber(to))?.hash ?? null;
    }

    const cursor: Cursor = { blockNumber: to, blockHash: toHash };
    const result = await this.#store.commitConfirmed({ from, to, rows: logs.map((l) => this.#row(l)), cursor });
    if (result.reverted > 0) this.#log.warn({ from, to, ...result }, "reorg: events reverted");
    return { ...result, cursor };
  }

  /** getLogs over every address chunk, splitting ranges the node refuses. Sorted, de-duplicated. */
  async #fetch(from: number, to: number, filter: WatchFilter): Promise<RawLog[]> {
    const seen = new Map<string, RawLog>();
    for (const q of filter.queries(from, to, this.#opts.addressChunk)) {
      for (const log of await this.#fetchSplit(q.fromBlock, q.toBlock, q.addresses, q.topic0s)) {
        if (filter.matches(log)) seen.set(identity(log), log);
      }
    }
    this.#rangeSuccesses++;
    const ceiling = Math.min(this.#opts.maxRange, this.#nodeCap);
    if (this.#rangeSuccesses >= GROW_AFTER && this.#range < ceiling) {
      this.#range = Math.min(ceiling, this.#range * 2);
      this.#rangeSuccesses = 0;
    }
    return [...seen.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }

  async #fetchSplit(
    from: number,
    to: number,
    addresses: Parameters<ChainReader["getLogs"]>[0]["addresses"],
    topic0s: Parameters<ChainReader["getLogs"]>[0]["topic0s"],
  ): Promise<RawLog[]> {
    try {
      return await this.#reader.getLogs({ fromBlock: from, toBlock: to, addresses, topic0s });
    } catch (err) {
      if (!(err instanceof LogRangeTooLargeError)) throw err;
      if (from === to) throw new LogTooDenseError(from);
      const span = to - from + 1;
      if (err.maxBlocks) this.#nodeCap = Math.min(this.#nodeCap, err.maxBlocks);
      const next = Math.max(1, Math.min(err.maxBlocks ?? Math.floor(span / 2), Math.floor(span / 2)));
      if (next < this.#range) {
        this.#log.debug({ from: span, to: next }, "narrowing getLogs range");
        this.#range = next;
      }
      this.#rangeSuccesses = 0;
      const mid = from + Math.floor(span / 2) - 1;
      return [
        ...(await this.#fetchSplit(from, mid, addresses, topic0s)),
        ...(await this.#fetchSplit(mid + 1, to, addresses, topic0s)),
      ];
    }
  }

  /** Nitro includes blockTimestamp in logs; other nodes need one header per block. */
  async #fillTimestamps(logs: RawLog[]): Promise<void> {
    const missing = [...new Set(logs.filter((l) => l.blockTimestamp === null && !this.#timestampCache.has(l.blockHash)).map((l) => l.blockHash))];
    for (const hash of missing) {
      const header = await this.#reader.blockByHash(hash);
      if (header) this.#timestampCache.set(hash, header.timestamp);
    }
    if (this.#timestampCache.size > 10_000) this.#timestampCache.clear();
  }

  #row(log: RawLog): NewChainEvent {
    const abi = this.#abis?.cached(log.address) ?? null;
    const decoded = this.#decoder.decode(log, abi);
    if (decoded?.name === "Upgraded" && this.#abis) this.#abis.invalidate(log.address);
    const ts = log.blockTimestamp ?? this.#timestampCache.get(log.blockHash) ?? null;
    return {
      chainId: this.#store.chainId,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      blockTimestamp: ts === null ? null : new Date(ts * 1000),
      txHash: log.txHash,
      txIndex: log.txIndex,
      logIndex: log.logIndex,
      address: log.address,
      topic0: log.topics[0] ?? null,
      topics: [...log.topics],
      data: log.data,
      eventName: decoded?.name ?? null,
      eventSignature: decoded?.signature ?? null,
      args: decoded?.args ?? null,
      abiSource: decoded?.source ?? null,
      status: "pending",
    };
  }

  /** New addresses: load stored ABIs (DB read) now; refresh from the explorer in the background. */
  async #loadAbis(filter: WatchFilter): Promise<void> {
    if (!this.#abis) return;
    const fresh = filter.addresses.filter((a) => !this.#knownAbiAddresses.has(a));
    if (fresh.length === 0) return;
    for (const a of fresh) this.#knownAbiAddresses.add(a);
    await Promise.all(fresh.map((a) => this.#abis?.load(a)));
    this.#abis.prefetch(fresh);
  }
}

export type { ActiveWatch };
