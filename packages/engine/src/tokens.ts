import { decodeFunctionResult, encodeFunctionData, hexToString, type Hex } from "viem";
import type { NormalizedAddress } from "@ignitra/core";
import {
  BUILTIN_ABIS,
  CallRevertedError,
  MULTICALL3_ADDRESS,
  decodeEthBalance,
  ethBalanceCall,
  multicall,
  type ChainReader,
  type MulticallCall,
  type MulticallResult,
} from "@ignitra/chain";

/**
 * Token enrichment with batching and caching. The public RPC rate-limits
 * aggressively, so every read path here is either cached or batched through
 * Multicall3 (one request for many reads).
 *
 * Failure policy: a contract that reverts or returns garbage yields `null`
 * fields (the run still records what is known); transport failures and
 * pruned state propagate to the caller, which retries or reports.
 */

const erc20 = BUILTIN_ABIS.erc20;

export interface TokenMeta {
  readonly address: NormalizedAddress;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
}

export interface TokenInfoOptions {
  metaTtlMs?: number;
  supplyTtlMs?: number;
  now?: () => number;
}

const call = (token: NormalizedAddress, functionName: "name" | "symbol" | "decimals" | "totalSupply"): MulticallCall => ({
  target: token,
  callData: encodeFunctionData({ abi: erc20, functionName }),
});

function decodeString(result: MulticallResult | undefined): string | null {
  if (!result?.success || result.returnData === "0x") return null;
  try {
    return decodeFunctionResult({ abi: erc20, functionName: "symbol", data: result.returnData });
  } catch {
    // Legacy tokens (MKR-style) return bytes32.
    if (result.returnData.length === 66) {
      const text = hexToString(result.returnData as Hex, { size: 32 }).replace(/\0+$/, "");
      return /^[\x20-\x7e]+$/.test(text) ? text : null;
    }
    return null;
  }
}

function decodeUint(result: MulticallResult | undefined): bigint | null {
  if (!result?.success || result.returnData.length !== 66) return null;
  return BigInt(result.returnData);
}

export class TokenInfo {
  readonly #reader: ChainReader;
  readonly #metaTtl: number;
  readonly #supplyTtl: number;
  readonly #now: () => number;
  readonly #meta = new Map<string, { value: TokenMeta; at: number }>();
  readonly #supply = new Map<string, { value: bigint | null; at: number }>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  #multicall: boolean | null = null;

  constructor(reader: ChainReader, opts: TokenInfoOptions = {}) {
    this.#reader = reader;
    this.#metaTtl = opts.metaTtlMs ?? 6 * 3600_000;
    this.#supplyTtl = opts.supplyTtlMs ?? 30_000;
    this.#now = opts.now ?? Date.now;
  }

  async #once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.#inflight.get(key);
    if (running) return running as Promise<T>;
    const task = run().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, task);
    return task;
  }

  /** Multicall3 when deployed (Robinhood Chain), otherwise one eth_call per read. */
  async #batch(calls: readonly MulticallCall[], blockNumber?: number): Promise<MulticallResult[]> {
    if (this.#multicall === null) this.#multicall = (await this.#reader.getCode(MULTICALL3_ADDRESS)) !== "0x";
    if (this.#multicall) return multicall(this.#reader, calls, { blockNumber });
    const out: MulticallResult[] = [];
    for (const c of calls) {
      try {
        out.push({ success: true, returnData: await this.#reader.call({ to: c.target, data: c.callData, ...(blockNumber !== undefined ? { blockNumber } : {}) }) });
      } catch (err) {
        if (!(err instanceof CallRevertedError)) throw err;
        out.push({ success: false, returnData: "0x" });
      }
    }
    return out;
  }

  async meta(token: NormalizedAddress): Promise<TokenMeta> {
    const hit = this.#meta.get(token);
    if (hit && this.#now() - hit.at < this.#metaTtl) return hit.value;
    return this.#once(`meta:${token}`, async () => {
      const [name, symbol, decimals] = await this.#batch([call(token, "name"), call(token, "symbol"), call(token, "decimals")]);
      const d = decodeUint(decimals);
      const value: TokenMeta = {
        address: token,
        name: decodeString(name),
        symbol: decodeString(symbol),
        decimals: d !== null && d <= 255n ? Number(d) : null,
      };
      this.#meta.set(token, { value, at: this.#now() });
      return value;
    });
  }

  /** Current total supply (cached briefly). Approximate for tokens that mint/burn every block. */
  async totalSupply(token: NormalizedAddress): Promise<bigint | null> {
    const hit = this.#supply.get(token);
    if (hit && this.#now() - hit.at < this.#supplyTtl) return hit.value;
    return this.#once(`supply:${token}`, async () => {
      const [result] = await this.#batch([call(token, "totalSupply")]);
      const value = decodeUint(result);
      this.#supply.set(token, { value, at: this.#now() });
      return value;
    });
  }

  /** balanceOf for many holders at one block, in as few requests as possible. Throws StateUnavailableError when pruned. */
  async balancesAt(token: NormalizedAddress, holders: readonly NormalizedAddress[], blockNumber: number): Promise<Map<NormalizedAddress, bigint | null>> {
    const unique = [...new Set(holders)];
    const results = await this.#batch(
      unique.map((h) => ({ target: token, callData: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [h] }) })),
      blockNumber,
    );
    return new Map(unique.map((h, i) => [h, decodeUint(results[i])]));
  }

  /** Native (ETH) balances at one block. */
  async nativeBalancesAt(wallets: readonly NormalizedAddress[], blockNumber: number): Promise<Map<NormalizedAddress, bigint | null>> {
    const unique = [...new Set(wallets)];
    if (this.#multicall === null) this.#multicall = (await this.#reader.getCode(MULTICALL3_ADDRESS)) !== "0x";
    if (!this.#multicall) {
      const out = new Map<NormalizedAddress, bigint | null>();
      for (const w of unique) out.set(w, await this.#reader.getBalance(w, blockNumber));
      return out;
    }
    const results = await multicall(this.#reader, unique.map(ethBalanceCall), { blockNumber });
    return new Map(unique.map((w, i) => [w, results[i] ? decodeEthBalance(results[i]) : null]));
  }
}
