import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi } from "viem";
import { normalizeAddress, normalizeHash, type NormalizedAddress, type NormalizedHash } from "@ignitra/core";
import { BUILTIN_ABIS } from "./abis";
import {
  LogRangeTooLargeError,
  type BlockHeader,
  type BlockTag,
  type ChainReader,
  type LogQuery,
  type RawLog,
} from "./types";

/**
 * Test doubles. FIXTURES ONLY — never import from production code.
 *
 * FakeChain is a deterministic in-memory chain with forks: mine blocks with
 * logs, reorg the tip, and enforce node-style getLogs limits.
 */

export interface LogSpec {
  readonly address: string;
  readonly topics: readonly `0x${string}`[];
  readonly data?: `0x${string}`;
}

interface FakeBlock extends BlockHeader {
  readonly logs: readonly RawLog[];
}

export interface FakeChainOptions {
  chainId?: number;
  /** getLogs refuses ranges wider than this (like real nodes). */
  maxRange?: number;
  /** getLogs refuses queries matching more logs than this. */
  maxLogs?: number;
  /** Depths behind head reported for the `safe` / `finalized` tags. */
  safeDepth?: number;
  finalizedDepth?: number;
  /** Block time in seconds. */
  blockTime?: number;
  genesisTimestamp?: number;
  /** Include `blockTimestamp` in logs (Nitro does). */
  logTimestamps?: boolean;
}

export class FakeChain implements ChainReader {
  readonly id: number;
  readonly #opts: Required<Omit<FakeChainOptions, "chainId">>;
  #blocks: FakeBlock[] = [];
  #fork = 0;
  /** Count of RPC-equivalent calls by method, for assertions. */
  readonly calls: Record<string, number> = {};
  /** Inject failures: next N calls of a method throw this error. */
  readonly #failures = new Map<string, { remaining: number; error: Error }>();

  constructor(opts: FakeChainOptions = {}) {
    this.id = opts.chainId ?? 4663;
    this.#opts = {
      maxRange: opts.maxRange ?? 30_000,
      maxLogs: opts.maxLogs ?? 10_000,
      safeDepth: opts.safeDepth ?? 100,
      finalizedDepth: opts.finalizedDepth ?? 200,
      blockTime: opts.blockTime ?? 1,
      genesisTimestamp: opts.genesisTimestamp ?? 1_790_000_000,
      logTimestamps: opts.logTimestamps ?? true,
    };
    this.#push([]);
  }

  get head(): number {
    return this.#blocks.length - 1;
  }

  block(number: number): FakeBlock | undefined {
    return this.#blocks[number];
  }

  #hashFor(number: number): NormalizedHash {
    return normalizeHash(keccak256(toHex(`fake:${this.id}:${this.#fork}:${number}`)));
  }

  #push(specs: readonly LogSpec[], txOffset = 0): FakeBlock {
    const number = this.#blocks.length;
    const hash = this.#hashFor(number);
    const parent = this.#blocks[number - 1];
    const timestamp = this.#opts.genesisTimestamp + number * this.#opts.blockTime;
    const logs: RawLog[] = specs.map((spec, i) => ({
      address: normalizeAddress(spec.address),
      topics: spec.topics.map((t) => normalizeHash(t)),
      data: (spec.data ?? "0x").toLowerCase() as `0x${string}`,
      blockNumber: number,
      blockHash: hash,
      blockTimestamp: this.#opts.logTimestamps ? timestamp : null,
      txHash: normalizeHash(keccak256(toHex(`tx:${this.#fork}:${number}:${i + txOffset}`))),
      txIndex: i,
      logIndex: i,
    }));
    const block: FakeBlock = {
      number,
      hash,
      parentHash: parent?.hash ?? normalizeHash(`0x${"0".repeat(64)}`),
      timestamp,
      logs,
    };
    this.#blocks.push(block);
    return block;
  }

  /** Mine one block containing `logs`. */
  mine(logs: readonly LogSpec[] = []): FakeBlock {
    return this.#push(logs);
  }

  /** Mine `n` empty blocks. */
  mineEmpty(n: number): void {
    for (let i = 0; i < n; i++) this.#push([]);
  }

  /** Drop the top `depth` blocks and mine `replacement` blocks on a new fork (different hashes). */
  reorg(depth: number, replacement: ReadonlyArray<readonly LogSpec[]>): void {
    if (depth >= this.#blocks.length) throw new Error("cannot reorg genesis");
    this.#blocks = this.#blocks.slice(0, this.#blocks.length - depth);
    this.#fork++;
    for (const logs of replacement) this.#push(logs, 1000 * this.#fork);
  }

  failNext(method: string, error: Error, times = 1): void {
    this.#failures.set(method, { remaining: times, error });
  }

  #call(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    const failure = this.#failures.get(method);
    if (failure && failure.remaining > 0) {
      failure.remaining--;
      throw failure.error;
    }
  }

  async chainId(): Promise<number> {
    this.#call("chainId");
    return this.id;
  }

  async blockNumber(): Promise<number> {
    this.#call("blockNumber");
    return this.head;
  }

  async blockByNumber(number: number): Promise<BlockHeader | null> {
    this.#call("blockByNumber");
    const b = this.#blocks[number];
    return b ? { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp } : null;
  }

  async blockByHash(hash: NormalizedHash): Promise<BlockHeader | null> {
    this.#call("blockByHash");
    const b = this.#blocks.find((x) => x.hash === hash);
    return b ? { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp } : null;
  }

  async blockByTag(tag: BlockTag): Promise<BlockHeader | null> {
    this.#call("blockByTag");
    const depth = tag === "safe" ? this.#opts.safeDepth : this.#opts.finalizedDepth;
    return this.blockByNumber(Math.max(0, this.head - depth));
  }

  async getLogs(q: LogQuery): Promise<RawLog[]> {
    this.#call("getLogs");
    if (q.toBlock < q.fromBlock) return [];
    const span = q.toBlock - q.fromBlock + 1;
    if (span > this.#opts.maxRange) {
      throw new LogRangeTooLargeError(`query spans ${span} blocks, but only ${this.#opts.maxRange} are allowed`, this.#opts.maxRange);
    }
    const addresses = new Set(q.addresses);
    const topics = q.topic0s ? new Set(q.topic0s) : null;
    const out: RawLog[] = [];
    for (let n = q.fromBlock; n <= Math.min(q.toBlock, this.head); n++) {
      for (const log of this.#blocks[n]?.logs ?? []) {
        if (!addresses.has(log.address)) continue;
        if (topics && (!log.topics[0] || !topics.has(log.topics[0]))) continue;
        out.push(log);
      }
    }
    if (out.length > this.#opts.maxLogs) {
      throw new LogRangeTooLargeError(`logs matched by query exceeds limit of ${this.#opts.maxLogs}`);
    }
    return out;
  }

  readonly storage = new Map<string, `0x${string}`>();

  async getStorageAt(address: NormalizedAddress, slot: `0x${string}`): Promise<`0x${string}`> {
    this.#call("getStorageAt");
    return this.storage.get(`${address}:${slot}`) ?? `0x${"0".repeat(64)}`;
  }
}

// ---------------------------------------------------------------------------
// Log builders (encode real ABI layouts so the decoder is exercised for real)
// ---------------------------------------------------------------------------

export function encodeLog(abi: Abi, eventName: string, args: Record<string, unknown>, address: string): LogSpec {
  const event = abi.find((i) => i.type === "event" && i.name === eventName);
  if (!event || event.type !== "event") throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [event], eventName, args: args as never }) as `0x${string}`[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = nonIndexed.length > 0 ? encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name ?? ""])) : "0x";
  return { address, topics, data };
}

export function erc20Transfer(token: string, from: string, to: string, value: bigint): LogSpec {
  return encodeLog(BUILTIN_ABIS.erc20, "Transfer", { from, to, value }, token);
}

export function erc721Transfer(token: string, from: string, to: string, tokenId: bigint): LogSpec {
  return encodeLog(BUILTIN_ABIS.erc721, "Transfer", { from, to, tokenId }, token);
}

export const addr = (n: number): NormalizedAddress => normalizeAddress(`0x${n.toString(16).padStart(40, "0")}`);
