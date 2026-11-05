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

/** Everything the listener needs from a node. Implemented by RpcChainReader and FakeChain. */
export interface ChainReader {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  blockByNumber(number: number): Promise<BlockHeader | null>;
  blockByHash(hash: NormalizedHash): Promise<BlockHeader | null>;
  blockByTag(tag: BlockTag): Promise<BlockHeader | null>;
  getLogs(query: LogQuery): Promise<RawLog[]>;
  getStorageAt(address: NormalizedAddress, slot: `0x${string}`): Promise<`0x${string}`>;
}

/**
 * Thrown when a node refuses a log query because of its size (too many blocks
 * or results). Not a node failure: the caller narrows the range instead of
 * failing over. `maxBlocks` is set when the node states its limit.
 */
export class LogRangeTooLargeError extends Error {
  readonly maxBlocks: number | null;

  constructor(message: string, maxBlocks: number | null = null) {
    super(message);
    this.name = "LogRangeTooLargeError";
    this.maxBlocks = maxBlocks;
  }
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
