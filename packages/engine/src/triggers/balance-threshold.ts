import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, type FieldSpec } from "@ignitra/core";
import { blockEvidence } from "../evidence";
import { formatDisplay, toBaseUnits, toDecimalUnits } from "../format";
import { addressParam, decimalParam } from "../params";
import type { PollTriggerModule, TriggerOutcome } from "../types";

/**
 * BALANCE_THRESHOLD — a wallet's balance (ETH or an ERC-20) crosses a value.
 *
 *   { "wallet": "0x…", "asset": "native", "threshold": "2", "direction": "below" }
 *
 * Native transfers emit no logs, so this samples the balance at the confirmed
 * head on an interval. It fires on a CROSSING (a change of side), once — not
 * on every sample while the balance stays below. The first sample after
 * activation only establishes the side.
 */
export const balanceThresholdParams = z
  .object({
    wallet: addressParam,
    asset: z.union([z.literal("native"), addressParam]).default("native"),
    threshold: decimalParam,
    direction: z.enum(["below", "above", "cross"]).default("below"),
  })
  .strict();

export type BalanceThresholdParams = z.output<typeof balanceThresholdParams>;

export interface BalanceState {
  readonly side: "above" | "below";
  readonly value: string;
  readonly block: number;
}

const FIELDS: readonly FieldSpec[] = [
  ...CHAIN_EVIDENCE_FIELDS,
  { path: "wallet", type: "address", description: "Watched wallet" },
  { path: "asset", type: "string", description: "`native` or the token address" },
  { path: "token.address", type: "address", description: "Token contract (null for native ETH)", nullable: true },
  { path: "token.symbol", type: "string", description: "ETH or the token symbol", nullable: true },
  { path: "token.decimals", type: "number", description: "Decimals used for the threshold", nullable: true },
  { path: "threshold", type: "decimal", description: "Threshold in token units" },
  { path: "direction", type: "string", description: "Crossing that happened: `below` or `above`" },
  { path: "balance_before", type: "uint", description: "Balance at the previous sample, base units" },
  { path: "balance_before_decimal", type: "decimal", description: "Previous balance, token units", nullable: true },
  { path: "balance_after", type: "uint", description: "Balance now, base units" },
  { path: "balance_after_decimal", type: "decimal", description: "Balance now, token units", nullable: true },
  { path: "balance_after_formatted", type: "string", description: "Balance now, for display", nullable: true },
  { path: "previous_block", type: "uint", description: "Block of the previous sample" },
];

export const balanceThresholdTrigger: PollTriggerModule<BalanceThresholdParams, BalanceState> = {
  type: "BALANCE_THRESHOLD",
  kind: "poll",
  label: "Balance threshold",
  description: "A wallet's ETH or token balance crosses a threshold.",
  source: "chain",
  supportsFast: false,
  paramsSchema: balanceThresholdParams,
  fields: () => FIELDS,

  async sample(p, rt, block) {
    const native = p.asset === "native";
    const meta = native ? null : await rt.tokens.meta(p.asset as Exclude<typeof p.asset, "native">);
    const decimals = native ? rt.chain.nativeCurrency.decimals : (meta?.decimals ?? null);
    const read = native ? await rt.tokens.nativeBalancesAt([p.wallet], block.number) : await rt.tokens.balancesAt(p.asset as Exclude<typeof p.asset, "native">, [p.wallet], block.number);
    const value = read.get(p.wallet);
    if (value === null || value === undefined) return null;
    const thresholdRaw = toBaseUnits(p.threshold, decimals);
    const side = thresholdRaw !== null && value < thresholdRaw ? "below" : "above";
    const decimal = toDecimalUnits(value, decimals);
    return {
      note: `current balance (${formatDisplay(decimal) ?? value.toString()}, ${side} ${p.threshold}): the flow runs when it crosses the threshold`,
      payload: {
        ...blockEvidence(block, rt.chain, p.wallet),
        wallet: p.wallet,
        asset: p.asset,
        token: { address: native ? null : p.asset, symbol: native ? rt.chain.nativeCurrency.symbol : (meta?.symbol ?? null), decimals },
        threshold: p.threshold,
        direction: side,
        balance_before: value.toString(),
        balance_before_decimal: decimal,
        balance_after: value.toString(),
        balance_after_decimal: decimal,
        balance_after_formatted: formatDisplay(decimal),
        previous_block: block.number,
      },
    };
  },

  async poll({ params: p, state, block }, rt) {
    if (state && block.number <= state.block) return { state: null, outcomes: [] };

    const native = p.asset === "native";
    const meta = native ? null : await rt.tokens.meta(p.asset as Exclude<typeof p.asset, "native">);
    const decimals = native ? rt.chain.nativeCurrency.decimals : (meta?.decimals ?? null);
    const symbol = native ? rt.chain.nativeCurrency.symbol : (meta?.symbol ?? null);
    const thresholdRaw = toBaseUnits(p.threshold, decimals);
    const undetermined = (reason: string): { state: null; outcomes: TriggerOutcome[] } => ({
      state: null,
      outcomes: [{ kind: "undetermined", key: `balance:${block.number}`, reason, payload: { ...blockEvidence(block, rt.chain, p.wallet), wallet: p.wallet, asset: p.asset } }],
    });
    if (thresholdRaw === null) return undetermined("token decimals unknown — cannot convert the threshold to base units");

    const read = native
      ? await rt.tokens.nativeBalancesAt([p.wallet], block.number)
      : await rt.tokens.balancesAt(p.asset as Exclude<typeof p.asset, "native">, [p.wallet], block.number);
    const value = read.get(p.wallet);
    if (value === null || value === undefined) return undetermined("balance read failed (call reverted)");

    const side = value < thresholdRaw ? "below" : "above";
    const next: BalanceState = { side, value: value.toString(), block: block.number };
    if (!state || side === state.side || (p.direction !== "cross" && p.direction !== side)) return { state: next, outcomes: [] };

    const before = BigInt(state.value);
    const afterDecimal = toDecimalUnits(value, decimals);
    return {
      state: next,
      outcomes: [
        {
          kind: "match",
          key: `balance:${block.number}`,
          payload: {
            ...blockEvidence(block, rt.chain, p.wallet),
            wallet: p.wallet,
            asset: p.asset,
            token: { address: native ? null : p.asset, symbol, decimals },
            threshold: p.threshold,
            direction: side,
            balance_before: before.toString(),
            balance_before_decimal: toDecimalUnits(before, decimals),
            balance_after: value.toString(),
            balance_after_decimal: afterDecimal,
            balance_after_formatted: formatDisplay(afterDecimal),
            previous_block: state.block,
          },
        },
      ],
    };
  },
};
