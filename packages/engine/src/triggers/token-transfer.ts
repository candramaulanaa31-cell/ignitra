import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, LOG_EVIDENCE_FIELDS, type FieldSpec } from "@ignitra/core";
import { logEvidence, logKey } from "../evidence";
import { addressParam } from "../params";
import type { LogTriggerModule, TriggerOutcome } from "../types";
import { TRUST_ROLES, trustFields } from "../enrich/trust";
import { TRANSFER_TOPIC, amountFields, amountPayload, isZero, parseErc20Transfer, percentOf, tokenFields, tokenPayload } from "./erc20";

/**
 * TOKEN_TRANSFER — every ERC-20 transfer of a token, optionally only those
 * into / out of one wallet.
 *
 *   { "token": "0x…" }                                       all transfers
 *   { "token": "0x…", "wallet": "0x…", "direction": "in" }   transfers into a wallet
 */
export const tokenTransferParams = z
  .object({
    token: addressParam,
    wallet: addressParam.optional(),
    direction: z.enum(["any", "in", "out"]).default("any"),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.direction !== "any" && !p.wallet) {
      ctx.addIssue({ code: "custom", path: ["wallet"], message: `direction "${p.direction}" needs a wallet` });
    }
  });

export type TokenTransferParams = z.output<typeof tokenTransferParams>;

const FIELDS: readonly FieldSpec[] = [
  ...CHAIN_EVIDENCE_FIELDS,
  ...LOG_EVIDENCE_FIELDS,
  { path: "from", type: "address", description: "Sender (0x000… for mints)" },
  { path: "to", type: "address", description: "Recipient (0x000… for burns)" },
  ...amountFields("amount", "Amount transferred"),
  ...tokenFields(),
  { path: "percent_of_supply", type: "number", description: "Amount as % of total supply (0.82 = 0.82%)", nullable: true },
  { path: "is_mint", type: "boolean", description: "Sent from the zero address" },
  { path: "is_burn", type: "boolean", description: "Sent to the zero address" },
  { path: "wallet", type: "address", description: "The watched wallet, if any", nullable: true },
  { path: "direction", type: "string", description: "`in` / `out` relative to the watched wallet", nullable: true },
  { path: "counterparty", type: "address", description: "The other side of the watched wallet (null without a wallet)", nullable: true },
  ...trustFields(TRUST_ROLES.TOKEN_TRANSFER ?? []),
];

export const tokenTransferTrigger: LogTriggerModule<TokenTransferParams> = {
  type: "TOKEN_TRANSFER",
  kind: "log",
  label: "Token transfer",
  description: "An ERC-20 transfer of a token, optionally into or out of a specific wallet.",
  source: "chain",
  supportsFast: true,
  paramsSchema: tokenTransferParams,
  fields: () => FIELDS,
  watches: (p) => [{ address: p.token, topic0: TRANSFER_TOPIC }],

  async matchBatch(events, p, rt) {
    const out: Array<TriggerOutcome | null> = [];
    for (const event of events) {
      const transfer = event.address === p.token ? parseErc20Transfer(event) : null;
      if (!transfer) {
        out.push(null);
        continue;
      }
      let direction: "in" | "out" | null = null;
      if (p.wallet) {
        const isIn = transfer.to === p.wallet;
        const isOut = transfer.from === p.wallet;
        if ((p.direction === "in" && !isIn) || (p.direction === "out" && !isOut) || (!isIn && !isOut)) {
          out.push(null);
          continue;
        }
        direction = isIn ? "in" : "out";
      }
      const [meta, supply] = await Promise.all([rt.tokens.meta(p.token), rt.tokens.totalSupply(p.token)]);
      out.push({
        kind: "match",
        key: logKey(event),
        chainEventId: event.id,
        payload: {
          ...logEvidence(event, rt.chain),
          from: transfer.from,
          to: transfer.to,
          ...amountPayload("amount", transfer.value, meta.decimals),
          token: tokenPayload(meta, supply),
          percent_of_supply: percentOf(transfer.value, supply),
          is_mint: isZero(transfer.from),
          is_burn: isZero(transfer.to),
          wallet: p.wallet ?? null,
          direction,
          counterparty: direction === "in" ? transfer.from : direction === "out" ? transfer.to : null,
        },
      });
    }
    return out;
  },
};
