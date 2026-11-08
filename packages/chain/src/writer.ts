import { keccak256 } from "viem";
import { normalizeAddress, type ChainTxClient, type NormalizedAddress, type TxReceiptSummary } from "@ignitra/core";
import { RpcResponseError } from "./rpc";

/**
 * Chain writes for ONCHAIN_TX over any JSON-RPC requester (the runner's RpcPool). Reverts of
 * eth_call / eth_estimateGas surface as CallRevertedError and refused transactions as
 * TransactionRejectedError: both are answers of a healthy node, never endpoint failures.
 */

interface Requester {
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

function quantity(v: unknown, what: string): bigint {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new RpcResponseError(`${what}: expected a hex quantity`);
  return BigInt(v);
}

export function createChainWriter(rpc: Requester): ChainTxClient {
  return {
    async nonce(address: NormalizedAddress) {
      return Number(quantity(await rpc.request("eth_getTransactionCount", [address, "pending"]), "nonce"));
    },
    async balance(address: NormalizedAddress) {
      return quantity(await rpc.request("eth_getBalance", [address, "latest"]), "balance");
    },
    async call(tx) {
      const out = await rpc.request<unknown>("eth_call", [{ from: tx.from, to: tx.to, data: tx.data, ...(tx.value ? { value: hex(tx.value) } : {}) }, "latest"]);
      if (typeof out !== "string" || !/^0x[0-9a-fA-F]*$/.test(out)) throw new RpcResponseError("eth_call: expected hex");
      return out.toLowerCase() as `0x${string}`;
    },
    async getCode(address: NormalizedAddress) {
      const out = await rpc.request<unknown>("eth_getCode", [address, "latest"]);
      if (typeof out !== "string") throw new RpcResponseError("eth_getCode: expected hex");
      return out.toLowerCase() as `0x${string}`;
    },
    async estimateGas(tx) {
      return quantity(await rpc.request("eth_estimateGas", [{ from: tx.from, to: tx.to, data: tx.data, value: hex(tx.value) }]), "gas");
    },
    async fees() {
      const block = (await rpc.request<{ baseFeePerGas?: string } | null>("eth_getBlockByNumber", ["latest", false])) ?? {};
      const base = block.baseFeePerGas ? quantity(block.baseFeePerGas, "baseFee") : 0n;
      let tip = 0n;
      try {
        tip = quantity(await rpc.request("eth_maxPriorityFeePerGas", []), "tip");
      } catch {
        tip = 0n; // Arbitrum-style chains ignore the tip anyway
      }
      return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip + 1n };
    },
    async sendRawTransaction(raw) {
      try {
        const hash = await rpc.request<unknown>("eth_sendRawTransaction", [raw]);
        if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new RpcResponseError("eth_sendRawTransaction: expected a hash");
        return hash.toLowerCase() as `0x${string}`;
      } catch (err) {
        // Re-sending the same signed transaction is idempotent.
        if (/already known|known transaction|already imported/i.test((err as Error).message)) return keccak256(raw);
        throw err;
      }
    },
    async receipt(hash) {
      const r = await rpc.request<{
        status?: string;
        blockNumber?: string;
        gasUsed?: string;
        logs?: Array<{ address: string; topics: string[]; data: string; logIndex: string }>;
      } | null>("eth_getTransactionReceipt", [hash]);
      if (!r || !r.blockNumber) return null;
      const summary: TxReceiptSummary = {
        status: r.status === "0x1" ? "success" : "reverted",
        blockNumber: Number(quantity(r.blockNumber, "blockNumber")),
        gasUsed: r.gasUsed ? quantity(r.gasUsed, "gasUsed") : 0n,
        logs: (r.logs ?? []).map((l) => ({
          address: normalizeAddress(l.address),
          topics: l.topics.map((t) => t.toLowerCase() as `0x${string}`),
          data: l.data.toLowerCase() as `0x${string}`,
          logIndex: Number(quantity(l.logIndex, "logIndex")),
        })),
      };
      return summary;
    },
  };
}
