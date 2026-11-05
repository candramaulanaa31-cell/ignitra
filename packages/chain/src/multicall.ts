import { decodeFunctionResult, encodeFunctionData, multicall3Abi, type AbiEvent, type AbiParameter } from "viem";
import { normalizeAddress, type NormalizedAddress } from "@ignitra/core";
import type { ChainReader } from "./types";

/**
 * Multicall3 (deployed at the canonical address on Robinhood Chain, verified
 * 2026-11-05). Batching reads matters: the public RPC rate-limits at a few
 * requests per second, so 150 balanceOf calls must be one request, not 150.
 */
export const MULTICALL3_ADDRESS = normalizeAddress("0xcA11bde05977b3631167028862bE2a173976CA11");

export interface MulticallCall {
  readonly target: NormalizedAddress;
  readonly callData: `0x${string}`;
}

export interface MulticallResult {
  readonly success: boolean;
  readonly returnData: `0x${string}`;
}

/** aggregate3 with allowFailure=true: one reverting call never sinks the batch. */
export async function multicall(
  reader: Pick<ChainReader, "call">,
  calls: readonly MulticallCall[],
  opts: { blockNumber?: number | undefined; batchSize?: number } = {},
): Promise<MulticallResult[]> {
  const size = opts.batchSize ?? 150;
  const out: MulticallResult[] = [];
  for (let i = 0; i < calls.length; i += size) {
    const chunk = calls.slice(i, i + size);
    const data = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
    });
    const raw = await reader.call({
      to: MULTICALL3_ADDRESS,
      data,
      ...(opts.blockNumber !== undefined ? { blockNumber: opts.blockNumber } : {}),
    });
    const decoded = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: raw });
    for (const r of decoded) out.push({ success: r.success, returnData: r.returnData.toLowerCase() as `0x${string}` });
  }
  return out;
}

/** Native balance through Multicall3, so it batches with token reads. */
export function ethBalanceCall(address: NormalizedAddress): MulticallCall {
  return {
    target: MULTICALL3_ADDRESS,
    callData: encodeFunctionData({ abi: multicall3Abi, functionName: "getEthBalance", args: [address] }),
  };
}

export function decodeEthBalance(result: MulticallResult): bigint | null {
  if (!result.success) return null;
  return decodeFunctionResult({ abi: multicall3Abi, functionName: "getEthBalance", data: result.returnData });
}

function formatParam(p: AbiParameter, withNames: boolean, indexed: boolean): string {
  let type = p.type;
  if (type.startsWith("tuple")) {
    const components = "components" in p ? p.components : [];
    type = `(${components.map((c) => formatParam(c, withNames, false)).join(", ")})${type.slice("tuple".length)}`;
  }
  return [type, indexed ? "indexed" : null, withNames && p.name ? p.name : null].filter(Boolean).join(" ");
}

/** Canonical human-readable fragment: `event Transfer(address indexed from, address indexed to, uint256 value)`. */
export function formatEventFragment(event: AbiEvent): string {
  const inputs = event.inputs.map((p) => formatParam(p, true, "indexed" in p && p.indexed === true));
  return `event ${event.name}(${inputs.join(", ")})${event.anonymous ? " anonymous" : ""}`;
}
