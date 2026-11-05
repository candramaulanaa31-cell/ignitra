import type { NormalizedAddress, NormalizedHash } from "@ignitra/core";

/**
 * Chain-facing types. Block numbers are JS numbers: Robinhood Chain heights
 * (~1e8) are far below 2^53, and numbers keep DB/JSON boundaries simple. The
 * RPC layer rejects anything that is not a safe integer.
 */

export interface BlockHeader {
  readonly number: number;
  readonly hash: NormalizedHash;
  readonly parentHash: NormalizedHash;
  /** Unix seconds. */
  readonly timestamp: number;
}

export interface RawLog {
  readonly address: NormalizedAddress;
  readonly topics: readonly NormalizedHash[];
  readonly data: `0x${string}`;
  readonly blockNumber: number;
  readonly blockHash: NormalizedHash;
  /** Unix seconds when the node includes it (Nitro does); otherwise null. */
  readonly blockTimestamp: number | null;
  readonly txHash: NormalizedHash;
  readonly txIndex: number;
  readonly logIndex: number;
}

export interface LogQuery {
  readonly fromBlock: number;
  readonly toBlock: number;
  /** Non-empty; callers chunk large address sets. */
  readonly addresses: readonly NormalizedAddress[];
  /** OR-set for topic0; null = any topic. */
  readonly topic0s: readonly NormalizedHash[] | null;
}

export type BlockTag = "safe" | "finalized";

export interface CallRequest {
  readonly to: NormalizedAddress;
  readonly data: `0x${string}`;
  /** Historical block; default "latest". Nodes prune old state (public RPC keeps ~10–20 min). */
  readonly blockNumber?: number;
}

export interface TxSummary {
  readonly hash: NormalizedHash;
  readonly from: NormalizedAddress;
  /** null for contract creation. */
  readonly to: NormalizedAddress | null;
  readonly nonce: number;
}

/** Everything the listener needs from a node. Implemented by RpcChainReader and FakeChain. */
export interface ChainReader {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  blockByNumber(number: number): Promise<BlockHeader | null>;
  blockByHash(hash: NormalizedHash): Promise<BlockHeader | null>;
  blockByTag(tag: BlockTag): Promise<BlockHeader | null>;
  getLogs(query: LogQuery): Promise<RawLog[]>;
  getStorageAt(address: NormalizedAddress, slot: `0x${string}`): Promise<`0x${string}`>;
  /** eth_call. Throws CallRevertedError / StateUnavailableError for query-level failures. */
  call(request: CallRequest): Promise<`0x${string}`>;
  getBalance(address: NormalizedAddress, blockNumber?: number): Promise<bigint>;
  getTransactionCount(address: NormalizedAddress, blockNumber?: number): Promise<number>;
  getCode(address: NormalizedAddress, blockNumber?: number): Promise<`0x${string}`>;
  /** Transactions of a block (hash/from/to/nonce only); null if the block does not exist. */
  blockTransactions(number: number): Promise<TxSummary[] | null>;
}

/**
 * A failure of the QUERY, not of the node: the endpoint stays healthy (no
 * cooldown). `retryElsewhere` says whether another endpoint could answer
 * differently (e.g. an archive node for pruned state).
 */
export class RpcQueryError extends Error {
  readonly retryElsewhere: boolean;

  constructor(message: string, retryElsewhere: boolean) {
    super(message);
    this.name = "RpcQueryError";
    this.retryElsewhere = retryElsewhere;
  }
}

/**
 * The node refused a log query because of its size (too many blocks or
 * results). The caller narrows the range. `maxBlocks` is set when the node
 * states its limit.
 */
export class LogRangeTooLargeError extends RpcQueryError {
  readonly maxBlocks: number | null;

  constructor(message: string, maxBlocks: number | null = null) {
    super(message, false);
    this.name = "LogRangeTooLargeError";
    this.maxBlocks = maxBlocks;
  }
}

/** eth_call reverted — deterministic, the same on every node. */
export class CallRevertedError extends RpcQueryError {
  readonly data: `0x${string}` | null;

  constructor(message: string, data: `0x${string}` | null = null) {
    super(message, false);
    this.name = "CallRevertedError";
    this.data = data;
  }
}

/** The node no longer has state for that block (pruned). An archive endpoint might. */
export class StateUnavailableError extends RpcQueryError {
  constructor(message: string) {
    super(message, true);
    this.name = "StateUnavailableError";
  }
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
