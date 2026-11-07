import { getContractAddress } from "viem";
import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, explorerTxUrl, normalizeAddress, type FieldSpec, type NormalizedAddress } from "@ignitra/core";
import { StateUnavailableError, type ChainReader } from "@ignitra/chain";
import { blockEvidence } from "../evidence";
import { addressParam } from "../params";
import type { PollTriggerModule, TriggerOutcome } from "../types";

/**
 * CONTRACT_DEPLOYED — a watched deployer creates a contract.
 *
 * Robinhood Chain's RPC has no trace API, and scanning every block's
 * transactions would cost ~10 requests/s. Instead: CREATE addresses are
 * determined by (deployer, nonce). Each poll reads the deployer's nonce; for
 * every nonce used since the last poll, the would-be contract address is
 * derived and checked for code. Cost: one request per poll plus one per
 * transaction the deployer sent. Works for EOAs and for factory contracts
 * using CREATE. CREATE2 factories: use CONTRACT_EVENT on the factory's
 * creation event instead.
 */
export const contractDeployedParams = z.object({ deployer: addressParam }).strict();
export type ContractDeployedParams = z.output<typeof contractDeployedParams>;

export interface DeployerState {
  /** Next nonce to examine. */
  readonly nonce: number;
  /** Block of the last complete scan (lower bound for locating creation blocks). */
  readonly block: number;
}

/** Bounds work per poll for busy deployers; the rest continues next poll. */
export const MAX_NONCES_PER_POLL = 25;

const FIELDS: readonly FieldSpec[] = [
  ...CHAIN_EVIDENCE_FIELDS,
  { path: "deployer", type: "address", description: "Watched deployer" },
  { path: "contract", type: "address", description: "The new contract" },
  { path: "nonce", type: "uint", description: "Deployer nonce used for the creation" },
  { path: "creation_block", type: "uint", description: "Block the contract was created in", nullable: true },
  { path: "creation_tx", type: "hash", description: "Creating transaction (EOA deployers)", nullable: true },
  { path: "creation_tx_url", type: "string", description: "Explorer link to the creating transaction", nullable: true },
];

/** Smallest block in (lo, hi] where `address` has code; null when that history is pruned. */
async function findCreationBlock(reader: ChainReader, address: NormalizedAddress, lo: number, hi: number): Promise<number | null> {
  try {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await reader.getCode(address, mid)) !== "0x") hi = mid;
      else lo = mid;
    }
    return hi;
  } catch (err) {
    if (err instanceof StateUnavailableError) return null;
    throw err;
  }
}

export const contractDeployedTrigger: PollTriggerModule<ContractDeployedParams, DeployerState> = {
  type: "CONTRACT_DEPLOYED",
  kind: "poll",
  label: "Contract deployed",
  description: "A watched deployer (wallet or CREATE factory) deploys a new contract.",
  source: "chain",
  supportsFast: false,
  paramsSchema: contractDeployedParams,
  fields: () => FIELDS,

  async sample(p, rt, block) {
    const nonce = await rt.reader.getTransactionCount(p.deployer, block.number);
    for (let n = nonce - 1; n >= Math.max(0, nonce - MAX_NONCES_PER_POLL); n--) {
      const contract = normalizeAddress(getContractAddress({ from: p.deployer, nonce: BigInt(n), opcode: "CREATE" }));
      if ((await rt.reader.getCode(contract, block.number)) === "0x") continue;
      return {
        note: `the latest contract this deployer created (nonce ${n}); creation block not looked up for samples`,
        payload: { ...blockEvidence(block, rt.chain, contract), deployer: p.deployer, contract, nonce: n, creation_block: null, creation_tx: null, creation_tx_url: null },
      };
    }
    return null;
  },

  async poll({ params: p, state, block }, rt) {
    const nonce = await rt.reader.getTransactionCount(p.deployer, block.number);
    if (!state) return { state: { nonce, block: block.number }, outcomes: [] };
    if (block.number <= state.block) return { state: null, outcomes: [] };
    if (nonce <= state.nonce) return { state: { nonce: state.nonce, block: block.number }, outcomes: [] };

    const end = Math.min(nonce, state.nonce + MAX_NONCES_PER_POLL);
    const outcomes: TriggerOutcome[] = [];
    for (let n = state.nonce; n < end; n++) {
      const contract = normalizeAddress(getContractAddress({ from: p.deployer, nonce: BigInt(n), opcode: "CREATE" }));
      if ((await rt.reader.getCode(contract, block.number)) === "0x") continue; // a plain transaction, or a failed creation

      const creationBlock = await findCreationBlock(rt.reader, contract, state.block, block.number);
      const tx =
        creationBlock === null
          ? null
          : ((await rt.reader.blockTransactions(creationBlock))?.find((t) => t.from === p.deployer && t.nonce === n && t.to === null) ?? null);
      outcomes.push({
        kind: "match",
        key: `deploy:${contract}`,
        payload: {
          ...blockEvidence(block, rt.chain, contract),
          deployer: p.deployer,
          contract,
          nonce: n,
          creation_block: creationBlock,
          creation_tx: tx?.hash ?? null,
          creation_tx_url: tx ? explorerTxUrl(rt.chain, tx.hash) : null,
        },
      });
    }
    // Partially scanned: keep the old lower bound so creation blocks of the remaining nonces stay findable.
    const next: DeployerState = end === nonce ? { nonce, block: block.number } : { nonce: end, block: state.block };
    return { state: next, outcomes };
  },
};
