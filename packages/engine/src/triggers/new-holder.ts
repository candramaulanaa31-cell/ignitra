import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, LOG_EVIDENCE_FIELDS, type FieldSpec, type NormalizedAddress } from "@ignitra/core";
import { StateUnavailableError } from "@ignitra/chain";
import { logEvidence, logKey } from "../evidence";
import { addressParam } from "../params";
import type { LogTriggerModule, TriggerOutcome } from "../types";
import { TRANSFER_TOPIC, amountFields, amountPayload, isZero, parseErc20Transfer, percentOf, tokenFields, tokenPayload, type Erc20Transfer } from "./erc20";

/**
 * NEW_HOLDER — an address starts holding the token: its balance is zero
 * before a transaction and non-zero after it. (An address that sold
 * everything and buys again becomes a holder again — the same definition
 * explorers use for "holders".)
 *
 * Decided PER TRANSACTION, not per log: routers and pool hops that receive
 * and pass tokens on inside one transaction never hold them. Measured on
 * USDG mainnet (2026-11-05): 37 of 40 per-log "new holders" were such
 * pass-throughs.
 *
 * How it stays exact without a full-history indexer:
 *   - untracked recipients are seeded with their balance at the block BEFORE
 *     the batch's first transfer — one Multicall3 read per batch. Valid because
 *     batches hold complete blocks and every Transfer of the token: an address
 *     untouched until its first appearance had the same balance at batch start.
 *   - from then on every Transfer of the token updates it, in chain order
 * The public RPC keeps ~10–20 min of state; when a seed falls outside it
 * (long downtime), the event is recorded as `undetermined`, never guessed.
 * Confirmed events only: running balances cannot be built on pending data.
 */
export const newHolderParams = z.object({ token: addressParam }).strict();
export type NewHolderParams = z.output<typeof newHolderParams>;

const FIELDS: readonly FieldSpec[] = [
  ...CHAIN_EVIDENCE_FIELDS,
  ...LOG_EVIDENCE_FIELDS,
  { path: "holder", type: "address", description: "The new holder" },
  { path: "from", type: "address", description: "Who sent the tokens (0x000… for mints)" },
  ...amountFields("amount", "Amount received in the transaction"),
  ...amountFields("balance_after", "Holder balance after the transaction"),
  { path: "percent_of_supply", type: "number", description: "Amount as % of total supply", nullable: true },
  ...tokenFields(),
];

/** Per-flow running balances; capped so a huge token cannot exhaust memory (re-seeding stays correct). */
const MAX_TRACKED = 250_000;

interface Tracker {
  generation: string;
  balances: Map<NormalizedAddress, bigint>;
}

export function createNewHolderTrigger(): LogTriggerModule<NewHolderParams> {
  const trackers = new Map<string, Tracker>();

  return {
    type: "NEW_HOLDER",
    kind: "log",
    label: "New holder",
    description: "An address starts holding a token (balance goes from zero to non-zero).",
    source: "chain",
    supportsFast: false,
    paramsSchema: newHolderParams,
    fields: () => FIELDS,
    watches: (p) => [{ address: p.token, topic0: TRANSFER_TOPIC }],
    reset: () => trackers.clear(),

    async matchBatch(events, p, rt, scope) {
      let tracker = trackers.get(scope.flowId);
      if (!tracker || tracker.generation !== scope.generation || tracker.balances.size > MAX_TRACKED) {
        tracker = { generation: scope.generation, balances: new Map() };
        trackers.set(scope.flowId, tracker);
      }
      const balances = tracker.balances;
      const parsed: Array<Erc20Transfer | null> = events.map((e) => (e.address === p.token && e.status === "confirmed" ? parseErc20Transfer(e) : null));

      // 1. Seed untracked recipients at the block before the batch's first transfer (one batched read).
      const needSeed = new Set<NormalizedAddress>();
      let firstBlock: number | null = null;
      parsed.forEach((t, i) => {
        if (!t) return;
        firstBlock ??= events[i]?.blockNumber ?? 0;
        if (t.value > 0n && !isZero(t.to) && !balances.has(t.to)) needSeed.add(t.to);
      });
      const byBlock = new Map<number, NormalizedAddress[]>();
      if (needSeed.size > 0 && firstBlock !== null) byBlock.set(firstBlock - 1, [...needSeed]);
      const unknown = new Map<NormalizedAddress, string>();
      for (const [block, holders] of byBlock) {
        if (block < 0) {
          for (const h of holders) balances.set(h, 0n);
          continue;
        }
        try {
          const read = await rt.tokens.balancesAt(p.token, holders, block);
          for (const h of holders) {
            const v = read.get(h);
            if (v === null || v === undefined) unknown.set(h, "balanceOf reverted or returned invalid data");
            else balances.set(h, v);
          }
        } catch (err) {
          if (!(err instanceof StateUnavailableError)) throw err;
          for (const h of holders) unknown.set(h, `balance at block ${block} is no longer available on the node (historical state pruned)`);
        }
      }

      // 2. Walk transfers in chain order, one transaction at a time, with exact running balances.
      let enrichment: Promise<[Awaited<ReturnType<typeof rt.tokens.meta>>, bigint | null]> | null = null;
      const enrich = () => (enrichment ??= Promise.all([rt.tokens.meta(p.token), rt.tokens.totalSupply(p.token)]));
      const out: Array<TriggerOutcome | null> = events.map(() => null);
      const apply = ({ from, to, value }: Erc20Transfer) => {
        if (from === to) return;
        if (!isZero(from) && balances.has(from)) {
          const next = (balances.get(from) ?? 0n) - value;
          // Negative means we missed a transfer: forget the address, it is re-seeded next time.
          if (next < 0n) balances.delete(from);
          else balances.set(from, next);
        }
        const before = balances.get(to);
        if (before !== undefined) balances.set(to, before + value);
      };

      for (let i = 0; i < events.length; ) {
        const tx = events[i]?.txHash;
        let j = i;
        while (j < events.length && events[j]?.txHash === tx) j++;
        const group: number[] = [];
        for (let k = i; k < j; k++) if (parsed[k]) group.push(k);
        i = j;
        if (group.length === 0) continue;

        // Recipients of this transaction: balance before it, first incoming log, total received.
        const recipients = new Map<NormalizedAddress, { before: bigint | undefined; first: number; received: bigint; from: NormalizedAddress }>();
        for (const k of group) {
          const t = parsed[k] as Erc20Transfer;
          if (t.value === 0n || isZero(t.to) || t.from === t.to) continue;
          const r = recipients.get(t.to);
          if (r) r.received += t.value;
          else recipients.set(t.to, { before: balances.get(t.to), first: k, received: t.value, from: t.from });
        }
        for (const k of group) apply(parsed[k] as Erc20Transfer);

        for (const [holder, r] of recipients) {
          const event = events[r.first];
          if (!event) continue;
          if (r.before === undefined) {
            const reason = unknown.get(holder);
            if (reason) {
              out[r.first] = { kind: "undetermined", key: logKey(event), chainEventId: event.id, reason, payload: { ...logEvidence(event, rt.chain), holder, from: r.from, amount: r.received.toString() } };
            }
            continue;
          }
          const after = balances.get(holder) ?? 0n;
          if (r.before !== 0n || after <= 0n) continue; // already a holder, or a pass-through hop
          const [meta, supply] = await enrich();
          out[r.first] = {
            kind: "match",
            key: logKey(event),
            chainEventId: event.id,
            payload: {
              ...logEvidence(event, rt.chain),
              holder,
              from: r.from,
              ...amountPayload("amount", r.received, meta.decimals),
              ...amountPayload("balance_after", after, meta.decimals),
              percent_of_supply: percentOf(after, supply),
              token: tokenPayload(meta, supply),
            },
          };
        }
      }
      return out;
    },
  };
}
