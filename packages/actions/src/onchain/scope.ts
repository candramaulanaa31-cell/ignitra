import { parseEther, toFunctionSelector, type AbiFunction } from "viem";
import { z } from "zod";
import { isValidAddress, normalizeAddress, type NormalizedAddress } from "@ignitra/core";
import { FunctionCallError, functionSignature, parseWriteFunction } from "@ignitra/chain";

/**
 * What a grant allows, checked before anything is put on chain. Everything here is ALSO
 * enforced on chain by Zodiac Roles v2 (targets, functions, daily ETH and token allowances,
 * per-transaction token caps) and IgnitraSessionBounds (expiry, per-transaction ETH cap).
 *
 * Safety rules that are not the user's choice:
 *   - never the Safe itself or its Roles modifier as a target: calls run AS the Safe, so they
 *     could add owners or widen the role;
 *   - functions that move tokens (transfer, transferFrom, approve, increaseAllowance) must cap
 *     their amount per transaction and per day;
 *   - no delegatecalls, ever; read-only functions need no grant (CHAIN_READ reads anything).
 */

export const MAX_GRANT_DAYS = 90;
export const MIN_GRANT_MINUTES = 10;
const DAY = 86_400;
const MAX_UINT128 = (1n << 128n) - 1n;
const TOKEN_MOVERS = new Set(["transfer", "transferFrom", "approve", "increaseAllowance"]);

const address = z.string().trim().refine(isValidAddress, { message: "must be an address (0x + 40 hex)" });
const raw = z.string().regex(/^[0-9]{1,39}$/, { message: "base units, as a whole number" });
const eth = (decimals: number) =>
  z.string().trim().regex(new RegExp(`^[0-9]{1,12}(\\.[0-9]{1,${decimals}})?$`), { message: `ETH, at most ${decimals} decimals` });

export const grantInputSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    safe: address,
    targets: z
      .array(
        z
          .object({
            address,
            functions: z
              .array(
                z
                  .object({
                    signature: z.string().trim().min(3).max(500),
                    /** Index of the uint argument holding the amount (e.g. 1 for transfer(address,uint256)). */
                    amount_arg: z.number().int().min(0).max(15).optional(),
                    max_amount_per_tx: raw.optional(),
                    max_amount_per_day: raw.optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(20),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    /** ETH per call (gwei precision: the onchain bound counts gwei). */
    max_value_per_tx: eth(9).default("0"),
    max_value_per_day: eth(18).default("0"),
    expires_at: z.string().datetime({ offset: true }),
    mandate_connection_id: z.string().regex(/^conn_[0-9a-z]{26}$/).optional(),
  })
  .strict();
export type GrantInput = z.input<typeof grantInputSchema>;

export interface ScopedFunction {
  readonly signature: string;
  readonly selector: `0x${string}`;
  /** ABI parameter types, for encoding conditions and checking arguments. */
  readonly inputs: readonly string[];
  readonly payable: boolean;
  readonly amount: { readonly arg: number; readonly max_per_tx: string; readonly max_per_day: string } | null;
}

export interface GrantScope {
  readonly targets: ReadonlyArray<{ readonly address: NormalizedAddress; readonly functions: readonly ScopedFunction[] }>;
  readonly max_value_per_tx_wei: string;
  readonly max_value_per_day_wei: string;
  readonly expires_at: string;
}

export interface ScopeIssue {
  readonly path: string;
  readonly message: string;
}

const isSimpleStatic = (t: string) => /^(address|bool|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|bytes([1-9]|[12][0-9]|3[0-2]))$/.test(t);
const isDynamic = (t: string) => t === "bytes" || t === "string";

/** Parses and checks a grant request. `forbidden` lists addresses that may never be targets. */
export function normalizeGrantScope(
  input: z.output<typeof grantInputSchema>,
  opts: { now: number; forbidden: ReadonlyArray<{ address: NormalizedAddress; why: string }> },
): { scope: GrantScope; issues: ScopeIssue[] } {
  const issues: ScopeIssue[] = [];
  const seenTargets = new Set<string>();
  const targets = input.targets.map((t, ti) => {
    const target = normalizeAddress(t.address);
    if (seenTargets.has(target)) issues.push({ path: `targets.${ti}.address`, message: "listed twice" });
    seenTargets.add(target);
    if (/^0x0{40}$/.test(target)) issues.push({ path: `targets.${ti}.address`, message: "the zero address is not a contract" });
    const bad = opts.forbidden.find((f) => f.address === target);
    if (bad) issues.push({ path: `targets.${ti}.address`, message: `not allowed: ${bad.why}` });
    const seenSelectors = new Set<string>();
    const functions = t.functions.map((f, fi): ScopedFunction => {
      const at = `targets.${ti}.functions.${fi}`;
      let fn: AbiFunction;
      try {
        fn = parseWriteFunction(f.signature);
      } catch (err) {
        issues.push({ path: `${at}.signature`, message: err instanceof FunctionCallError ? err.message : "not a function signature" });
        return { signature: f.signature, selector: "0x00000000", inputs: [], payable: false, amount: null };
      }
      const selector = toFunctionSelector(fn);
      const inputs = fn.inputs.map((i) => i.type);
      if (fn.stateMutability === "view" || fn.stateMutability === "pure") issues.push({ path: `${at}.signature`, message: "read-only functions need no grant: CHAIN_READ reads them" });
      if (seenSelectors.has(selector)) issues.push({ path: `${at}.signature`, message: "listed twice" });
      seenSelectors.add(selector);

      let amount: ScopedFunction["amount"] = null;
      const movesTokens = TOKEN_MOVERS.has(fn.name) && inputs.some((i) => /^uint/.test(i));
      if (f.amount_arg === undefined) {
        if (movesTokens) issues.push({ path: `${at}.amount_arg`, message: `${fn.name} moves tokens: set which argument is the amount and its limits` });
        if (f.max_amount_per_tx !== undefined || f.max_amount_per_day !== undefined) issues.push({ path: `${at}.amount_arg`, message: "amount limits need amount_arg" });
      } else {
        const type = inputs[f.amount_arg];
        if (!type || !/^uint(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/.test(type)) {
          issues.push({ path: `${at}.amount_arg`, message: `argument ${f.amount_arg} is not an unsigned integer` });
        } else if (!inputs.slice(0, f.amount_arg).every((i) => isSimpleStatic(i) || isDynamic(i))) {
          issues.push({ path: `${at}.amount_arg`, message: "amount limits support functions whose earlier arguments are plain values (no arrays or tuples)" });
        } else if (f.max_amount_per_tx === undefined || f.max_amount_per_day === undefined) {
          issues.push({ path: `${at}.max_amount_per_tx`, message: "set both max_amount_per_tx and max_amount_per_day (base units)" });
        } else {
          const perTx = BigInt(f.max_amount_per_tx);
          const perDay = BigInt(f.max_amount_per_day);
          if (perTx === 0n || perDay === 0n) issues.push({ path: `${at}.max_amount_per_tx`, message: "limits must be above 0" });
          if (perTx > MAX_UINT128 - 1n || perDay > MAX_UINT128) issues.push({ path: `${at}.max_amount_per_day`, message: "too large" });
          if (perTx > perDay) issues.push({ path: `${at}.max_amount_per_tx`, message: "the per-transaction limit is above the daily one" });
          amount = { arg: f.amount_arg, max_per_tx: perTx.toString(), max_per_day: perDay.toString() };
        }
      }
      return { signature: functionSignature(fn), selector, inputs, payable: fn.stateMutability === "payable", amount };
    });
    return { address: target, functions };
  });

  const perTx = parseEther(input.max_value_per_tx);
  const perDay = parseEther(input.max_value_per_day);
  if (perTx > 0n && perDay < perTx) issues.push({ path: "max_value_per_day", message: "set a daily ETH limit at least as large as the per-transaction one" });
  if (perDay > MAX_UINT128) issues.push({ path: "max_value_per_day", message: "too large" });
  if (perTx / 1_000_000_000n > (1n << 64n) - 1n) issues.push({ path: "max_value_per_tx", message: "too large" });

  const expires = Date.parse(input.expires_at);
  if (!(expires > opts.now + MIN_GRANT_MINUTES * 60_000)) issues.push({ path: "expires_at", message: `must be at least ${MIN_GRANT_MINUTES} minutes from now` });
  if (expires > opts.now + MAX_GRANT_DAYS * DAY * 1000) issues.push({ path: "expires_at", message: `at most ${MAX_GRANT_DAYS} days from now` });

  return {
    scope: { targets, max_value_per_tx_wei: perTx.toString(), max_value_per_day_wei: perDay.toString(), expires_at: new Date(expires).toISOString() },
    issues,
  };
}

/** The scoped function a call would use, if the grant allows it at all. */
export function findScopedFunction(scope: GrantScope, to: NormalizedAddress, selector: string): ScopedFunction | null {
  return scope.targets.find((t) => t.address === to)?.functions.find((f) => f.selector === selector.toLowerCase()) ?? null;
}

export { isDynamic as isDynamicAbiType };
