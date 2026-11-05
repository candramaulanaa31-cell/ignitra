import { explorerAddressUrl, explorerTxUrl, type ChainConfig } from "@ignitra/core";
import type { BlockHeader } from "@ignitra/chain";
import type { ChainEventView, Payload } from "./types";

/**
 * Evidence shared by every chain trigger, and WIB time fields derived from the
 * BLOCK timestamp (not processing time) so re-evaluating an event always
 * yields the same result.
 */

const WIB_OFFSET_MS = 7 * 3600_000; // Asia/Jakarta has been a fixed UTC+7 (no DST) since 1964.

export function timeFields(unixSeconds: number): Payload {
  const ms = unixSeconds * 1000;
  const wib = new Date(ms + WIB_OFFSET_MS);
  const hour = wib.getUTCHours();
  const minute = wib.getUTCMinutes();
  const weekday = wib.getUTCDay() === 0 ? 7 : wib.getUTCDay();
  return {
    iso: new Date(ms).toISOString(),
    date_wib: wib.toISOString().slice(0, 10),
    hour_wib: hour,
    minute_wib: minute,
    minutes_wib: hour * 60 + minute,
    weekday_wib: weekday,
  };
}

export function logEvidence(event: ChainEventView, chain: ChainConfig): Payload {
  const ts = event.blockTimestamp ?? Math.floor(Date.now() / 1000);
  return {
    chain_id: event.chainId,
    block_number: event.blockNumber,
    block_hash: event.blockHash,
    block_timestamp: event.blockTimestamp === null ? null : new Date(event.blockTimestamp * 1000).toISOString(),
    tx_hash: event.txHash,
    tx_index: event.txIndex,
    log_index: event.logIndex,
    contract: event.address,
    explorer_url: explorerTxUrl(chain, event.txHash),
    event_status: event.status,
    time: timeFields(ts),
  };
}

export function blockEvidence(block: BlockHeader, chain: ChainConfig, subject: string): Payload {
  return {
    chain_id: chain.id,
    block_number: block.number,
    block_hash: block.hash,
    block_timestamp: new Date(block.timestamp * 1000).toISOString(),
    explorer_url: explorerAddressUrl(chain, subject),
    time: timeFields(block.timestamp),
  };
}

/** `chain_id:<trigger key>:flow_id` — the spec's `chain_id:tx_hash:log_index:flow_id` for log triggers. */
export function idempotencyKey(chainId: number, triggerKey: string, flowId: string): string {
  return `${chainId}:${triggerKey}:${flowId}`;
}

export const logKey = (event: Pick<ChainEventView, "txHash" | "logIndex">): string => `${event.txHash}:${event.logIndex}`;
