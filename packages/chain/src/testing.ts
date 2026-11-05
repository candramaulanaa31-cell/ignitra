import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getContractAddress,
  keccak256,
  multicall3Abi,
  stringToHex,
  toHex,
  type Abi,
} from "viem";
import { ZERO_ADDRESS, normalizeAddress, normalizeHash, type NormalizedAddress, type NormalizedHash } from "@ignitra/core";
import { BUILTIN_ABIS } from "./abis";
import { MULTICALL3_ADDRESS } from "./multicall";
import {
  CallRevertedError,
  LogRangeTooLargeError,
  StateUnavailableError,
  type BlockHeader,
  type BlockTag,
  type CallRequest,
  type ChainReader,
  type LogQuery,
  type RawLog,
  type TxSummary,
} from "./types";

/**
 * Test doubles. FIXTURES ONLY — never import from production code.
 *
 * FakeChain is a deterministic in-memory chain with forks and state:
 * mine blocks with logs and transactions, reorg the tip, simulate ERC-20
 * balances per block, native balances, nonces and deployed code, Multicall3,
 * node-style getLogs limits and pruned historical state.
 */

export interface LogSpec {
  readonly address: string;
  readonly topics: readonly `0x${string}`[];
  readonly data?: `0x${string}`;
  /** Force the transaction hash (e.g. the same tx re-included in another block after a reorg). */
  readonly txHash?: string;
  /** Applied when the log is mined (state changes such as token balances). */
  readonly effect?: (block: number) => void;
}

export interface FakeTx {
  readonly from: string;
  /** Omit or null for a contract creation. */
  readonly to?: string | null;
  /** For creations: code placed at the CREATE address. Omit for a failed / codeless creation. */
  readonly code?: `0x${string}`;
}

interface FakeBlock extends BlockHeader {
  readonly logs: readonly RawLog[];
  readonly txs: readonly TxSummary[];
}

interface Stateful {
  /** Drop every state change after `lastKept` (reorg). */
  truncate(lastKept: number): void;
}

/** Value history: entries sorted by block; the value at block b is the last entry with block <= b. */
class History<T> implements Stateful {
  readonly #entries = new Map<string, Array<{ block: number; value: T }>>();

  set(key: string, block: number, value: T): void {
    const list = this.#entries.get(key) ?? [];
    list.push({ block, value });
    list.sort((a, b) => a.block - b.block);
    this.#entries.set(key, list);
  }

  at(key: string, block: number): T | undefined {
    let found: T | undefined;
    for (const e of this.#entries.get(key) ?? []) {
      if (e.block > block) break;
      found = e.value;
    }
    return found;
  }

  truncate(lastKept: number): void {
    for (const [key, list] of this.#entries) this.#entries.set(key, list.filter((e) => e.block <= lastKept));
  }
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
  /** Historical state older than head - stateWindow is pruned (null = archive). */
  stateWindow?: number | null;
  /** Deploy Multicall3 (true on Robinhood Chain). */
  multicall?: boolean;
  /** Block timestamp override (unix seconds), e.g. wall-clock time for activation tests. */
  timestampOf?: (blockNumber: number) => number;
}

type CallHandler = (data: `0x${string}`, block: number) => `0x${string}`;

export class FakeChain implements ChainReader {
  readonly id: number;
  readonly #opts: Required<Omit<FakeChainOptions, "chainId" | "stateWindow" | "timestampOf">> & { stateWindow: number | null };
  readonly #timestampOf: ((n: number) => number) | null;
  #blocks: FakeBlock[] = [];
  #fork = 0;
  readonly #stateful: Stateful[] = [];
  readonly #nonces = new History<number>();
  readonly #code = new History<`0x${string}`>();
  readonly #native = new History<bigint>();
  readonly #contracts = new Map<string, CallHandler>();
  /** Count of RPC-equivalent calls by method, for assertions. */
  readonly calls: Record<string, number> = {};
  readonly #failures = new Map<string, { remaining: number; error: Error }>();
  readonly storage = new Map<string, `0x${string}`>();

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
      stateWindow: opts.stateWindow ?? null,
      multicall: opts.multicall ?? true,
    };
    this.#timestampOf = opts.timestampOf ?? null;
    this.#stateful.push(this.#nonces, this.#code, this.#native);
    if (this.#opts.multicall) this.#code.set(MULTICALL3_ADDRESS, 0, "0x6080");
    this.#push([], []);
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

  #push(specs: readonly LogSpec[], txSpecs: readonly FakeTx[]): FakeBlock {
    const number = this.#blocks.length;
    const hash = this.#hashFor(number);
    const parent = this.#blocks[number - 1];
    const timestamp = this.#timestampOf ? this.#timestampOf(number) : this.#opts.genesisTimestamp + number * this.#opts.blockTime;

    const txs: TxSummary[] = txSpecs.map((tx, i) => {
      const from = normalizeAddress(tx.from);
      // Includes earlier transactions of the same sender in this block.
      const nonce = this.#nonces.at(from, number) ?? 0;
      this.#nonces.set(from, number, nonce + 1);
      const to = tx.to ? normalizeAddress(tx.to) : null;
      if (to === null && tx.code) {
        this.#code.set(normalizeAddress(getContractAddress({ from, nonce: BigInt(nonce), opcode: "CREATE" })), number, tx.code);
      }
      return { hash: normalizeHash(keccak256(toHex(`ctx:${this.#fork}:${number}:${i}`))), from, to, nonce };
    });

    const logs: RawLog[] = specs.map((spec, i) => ({
      address: normalizeAddress(spec.address),
      topics: spec.topics.map((t) => normalizeHash(t)),
      data: (spec.data ?? "0x").toLowerCase() as `0x${string}`,
      blockNumber: number,
      blockHash: hash,
      blockTimestamp: this.#opts.logTimestamps ? timestamp : null,
      txHash: normalizeHash(spec.txHash ?? keccak256(toHex(`tx:${this.#fork}:${number}:${i}`))),
      txIndex: i,
      logIndex: i,
    }));
    for (const spec of specs) spec.effect?.(number);

    const block: FakeBlock = {
      number,
      hash,
      parentHash: parent?.hash ?? normalizeHash(`0x${"0".repeat(64)}`),
      timestamp,
      logs,
      txs,
    };
    this.#blocks.push(block);
    return block;
  }

  /** Mine one block containing `logs` (and optional transactions). */
  mine(logs: readonly LogSpec[] = [], opts: { txs?: readonly FakeTx[] } = {}): FakeBlock {
    return this.#push(logs, opts.txs ?? []);
  }

  /** Mine `n` empty blocks. */
  mineEmpty(n: number): void {
    for (let i = 0; i < n; i++) this.#push([], []);
  }

  /** Drop the top `depth` blocks (and their state changes) and mine `replacement` blocks on a new fork. */
  reorg(depth: number, replacement: ReadonlyArray<readonly LogSpec[]>): void {
    if (depth >= this.#blocks.length) throw new Error("cannot reorg genesis");
    this.#blocks = this.#blocks.slice(0, this.#blocks.length - depth);
    for (const s of this.#stateful) s.truncate(this.head);
    this.#fork++;
    for (const logs of replacement) this.#push(logs, []);
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

  /** Resolves a block tag the way a node does, enforcing pruned state. */
  #stateBlock(blockNumber: number | undefined, method: string): number {
    const block = blockNumber ?? this.head;
    if (block > this.head) throw new Error(`${method}: header not found`);
    const window = this.#opts.stateWindow;
    if (window !== null && block < this.head - window) {
      throw new StateUnavailableError(`${method}: historical state for block ${block} is not available`);
    }
    return block;
  }

  // ---- state setup ----------------------------------------------------------

  /** Native balance from the current head onward. */
  setNativeBalance(address: string, value: bigint): void {
    this.#native.set(normalizeAddress(address), this.head, value);
  }

  registerContract(address: string, handler: CallHandler): void {
    const a = normalizeAddress(address);
    this.#contracts.set(a, handler);
    if (this.#code.at(a, this.head) === undefined) this.#code.set(a, 0, "0x6080");
  }

  /** Simulated ERC-20 at `address`. */
  token(address: string, opts: { symbol?: string; name?: string; decimals?: number; symbolAsBytes32?: boolean; revertMetadata?: boolean } = {}): FakeErc20 {
    const token = new FakeErc20(normalizeAddress(address), opts);
    this.#stateful.push(token);
    this.registerContract(address, (data, block) => token.handle(data, block));
    return token;
  }

  // ---- ChainReader ----------------------------------------------------------

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

  async getStorageAt(address: NormalizedAddress, slot: `0x${string}`): Promise<`0x${string}`> {
    this.#call("getStorageAt");
    return this.storage.get(`${address}:${slot}`) ?? `0x${"0".repeat(64)}`;
  }

  #invoke(to: NormalizedAddress, data: `0x${string}`, block: number): `0x${string}` {
    if (to === MULTICALL3_ADDRESS && this.#opts.multicall) return this.#multicall(data, block);
    const handler = this.#contracts.get(to);
    return handler ? handler(data, block) : "0x"; // calls to code-less addresses return empty data
  }

  #multicall(data: `0x${string}`, block: number): `0x${string}` {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    if (decoded.functionName === "getEthBalance") {
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "getEthBalance", result: this.#native.at(normalizeAddress(decoded.args[0]), block) ?? 0n });
    }
    if (decoded.functionName !== "aggregate3") throw new CallRevertedError("eth_call: execution reverted");
    const results = decoded.args[0].map((c) => {
      try {
        return { success: true, returnData: this.#invoke(normalizeAddress(c.target), c.callData, block) };
      } catch (err) {
        if (err instanceof CallRevertedError && c.allowFailure) return { success: false, returnData: "0x" as const };
        throw err;
      }
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
  }

  async call(request: CallRequest): Promise<`0x${string}`> {
    this.#call("call");
    const block = this.#stateBlock(request.blockNumber, "eth_call");
    return this.#invoke(request.to, request.data, block);
  }

  async getBalance(address: NormalizedAddress, blockNumber?: number): Promise<bigint> {
    this.#call("getBalance");
    return this.#native.at(address, this.#stateBlock(blockNumber, "eth_getBalance")) ?? 0n;
  }

  async getTransactionCount(address: NormalizedAddress, blockNumber?: number): Promise<number> {
    this.#call("getTransactionCount");
    return this.#nonces.at(address, this.#stateBlock(blockNumber, "eth_getTransactionCount")) ?? 0;
  }

  async getCode(address: NormalizedAddress, blockNumber?: number): Promise<`0x${string}`> {
    this.#call("getCode");
    return this.#code.at(address, this.#stateBlock(blockNumber, "eth_getCode")) ?? "0x";
  }

  async blockTransactions(number: number): Promise<TxSummary[] | null> {
    this.#call("blockTransactions");
    return this.#blocks[number] ? [...(this.#blocks[number]?.txs ?? [])] : null;
  }
}

/** ERC-20 with a per-block ledger: balanceOf(holder, block) is exact at every height. */
export class FakeErc20 implements Stateful {
  readonly address: NormalizedAddress;
  readonly #opts: { symbol: string; name: string; decimals: number; symbolAsBytes32: boolean; revertMetadata: boolean };
  #ledger: Array<{ block: number; from: NormalizedAddress; to: NormalizedAddress; value: bigint }> = [];

  constructor(address: NormalizedAddress, opts: { symbol?: string; name?: string; decimals?: number; symbolAsBytes32?: boolean; revertMetadata?: boolean }) {
    this.address = address;
    this.#opts = {
      symbol: opts.symbol ?? "TKN",
      name: opts.name ?? "Token",
      decimals: opts.decimals ?? 18,
      symbolAsBytes32: opts.symbolAsBytes32 ?? false,
      revertMetadata: opts.revertMetadata ?? false,
    };
  }

  /** Balance present from genesis (block 0). */
  seed(holder: string, value: bigint): void {
    this.#ledger.push({ block: 0, from: ZERO_ADDRESS, to: normalizeAddress(holder), value });
  }

  /** A Transfer log whose balance effect applies at the block it is mined in. */
  transfer(from: string, to: string, value: bigint): LogSpec {
    const spec = erc20Transfer(this.address, from, to, value);
    return {
      ...spec,
      effect: (block) => this.#ledger.push({ block, from: normalizeAddress(from), to: normalizeAddress(to), value }),
    };
  }

  mint(to: string, value: bigint): LogSpec {
    return this.transfer(ZERO_ADDRESS, to, value);
  }

  burn(from: string, value: bigint): LogSpec {
    return this.transfer(from, ZERO_ADDRESS, value);
  }

  balanceOf(holder: string, block: number): bigint {
    const h = normalizeAddress(holder);
    let balance = 0n;
    for (const e of this.#ledger) {
      if (e.block > block) continue;
      if (e.to === h) balance += e.value;
      if (e.from === h) balance -= e.value;
    }
    return balance;
  }

  totalSupply(block: number): bigint {
    let supply = 0n;
    for (const e of this.#ledger) {
      if (e.block > block) continue;
      if (e.from === ZERO_ADDRESS) supply += e.value;
      if (e.to === ZERO_ADDRESS) supply -= e.value;
    }
    return supply;
  }

  truncate(lastKept: number): void {
    this.#ledger = this.#ledger.filter((e) => e.block <= lastKept);
  }

  handle(data: `0x${string}`, block: number): `0x${string}` {
    const abi = BUILTIN_ABIS.erc20;
    let call;
    try {
      call = decodeFunctionData({ abi, data });
    } catch {
      throw new CallRevertedError("eth_call: execution reverted");
    }
    const metadata = call.functionName === "name" || call.functionName === "symbol" || call.functionName === "decimals";
    if (metadata && this.#opts.revertMetadata) throw new CallRevertedError("eth_call: execution reverted");
    switch (call.functionName) {
      case "name":
        return encodeFunctionResult({ abi, functionName: "name", result: this.#opts.name });
      case "symbol":
        return this.#opts.symbolAsBytes32
          ? stringToHex(this.#opts.symbol, { size: 32 })
          : encodeFunctionResult({ abi, functionName: "symbol", result: this.#opts.symbol });
      case "decimals":
        return encodeFunctionResult({ abi, functionName: "decimals", result: this.#opts.decimals });
      case "totalSupply":
        return encodeFunctionResult({ abi, functionName: "totalSupply", result: this.totalSupply(block) });
      case "balanceOf":
        return encodeFunctionResult({ abi, functionName: "balanceOf", result: this.balanceOf(call.args[0], block) });
      default:
        throw new CallRevertedError("eth_call: execution reverted");
    }
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
