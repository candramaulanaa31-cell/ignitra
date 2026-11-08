import { decodeEventLog, encodeFunctionData, type Hex } from "viem";
import { normalizeAddress, type ChainTxClient, type NormalizedAddress } from "@ignitra/core";
import { ROLES_ABI, SAFE_ABI, SESSION_BOUNDS_ADDRESS } from "./contracts";
import { allowancesFor, functionConditions, type ConditionFlat } from "./roles";
import type { GrantScope } from "./scope";

/**
 * A grant becomes active only when its transaction is proven to leave EXACTLY what was asked:
 * the role for IGNITRA's session key, each scoped target and function with the expected
 * condition tree, each daily allowance, and nothing broader. Roles v2 keeps scopes in packed
 * storage but announces every change as an event, so the mined transaction's Roles events are
 * replayed IN LOG ORDER into the state they leave (a later event overrides an earlier one: a
 * function scoped as expected and then re-scoped wider is caught). Then the Safe's live state.
 */

export interface GrantToVerify {
  readonly id: string;
  readonly safe: NormalizedAddress;
  readonly roles: NormalizedAddress;
  readonly roleKey: Hex;
  readonly sessionKey: NormalizedAddress;
  readonly scope: GrantScope;
}

type FunctionState = { kind: "scoped"; conditions: readonly ConditionFlat[]; options: number } | { kind: "allowed" } | { kind: "revoked" };
type AllowanceState = { balance: bigint; maxRefill: bigint; refill: bigint; period: bigint };

const lc = (v: string) => v.toLowerCase();
const sameConditions = (got: readonly ConditionFlat[], want: readonly ConditionFlat[]) =>
  got.length === want.length &&
  got.every((g, i) => {
    const w = want[i] as ConditionFlat;
    return g.parent === w.parent && g.paramType === w.paramType && g.operator === w.operator && lc(g.compValue) === lc(w.compValue);
  });

export async function verifyGrantTransaction(chain: Pick<ChainTxClient, "receipt" | "call" | "getCode">, grant: GrantToVerify, txHash: `0x${string}`): Promise<{ ok: boolean; problems: string[]; blockNumber: number | null }> {
  const problems: string[] = [];
  const receipt = await chain.receipt(txHash);
  if (!receipt) return { ok: false, problems: ["the transaction is not mined (yet): wait a moment and verify again"], blockNumber: null };
  if (receipt.status !== "success") return { ok: false, problems: ["the transaction reverted: nothing was granted"], blockNumber: receipt.blockNumber };

  const role = lc(grant.roleKey);
  const membership = new Map<string, boolean>(); // `${module}|${roleKey}`
  const targets = new Map<string, "scoped" | "allowed" | "revoked">(); // target, for this role
  const functions = new Map<string, FunctionState>(); // `${target}|${selector}`, for this role
  const allowances = new Map<string, AllowanceState>();

  const logs = [...receipt.logs].filter((l) => l.address === grant.roles).sort((a, b) => a.logIndex - b.logIndex);
  for (const log of logs) {
    let e;
    try {
      e = decodeEventLog({ abi: ROLES_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    switch (e.eventName) {
      case "AssignRoles":
        e.args.roleKeys.forEach((k, i) => membership.set(`${lc(e.args.module)}|${lc(k)}`, e.args.memberOf[i] === true));
        break;
      case "SetDefaultRole":
        if (lc(e.args.defaultRoleKey) === role || lc(e.args.module) === grant.sessionKey) problems.push("the transaction sets a default role involving this grant");
        break;
      case "ScopeTarget":
      case "AllowTarget":
      case "RevokeTarget":
        if (lc(e.args.roleKey) === role) targets.set(lc(e.args.targetAddress), e.eventName === "ScopeTarget" ? "scoped" : e.eventName === "AllowTarget" ? "allowed" : "revoked");
        break;
      case "ScopeFunction":
        if (lc(e.args.roleKey) === role) functions.set(`${lc(e.args.targetAddress)}|${lc(e.args.selector)}`, { kind: "scoped", conditions: e.args.conditions as readonly ConditionFlat[], options: e.args.options });
        break;
      case "AllowFunction":
      case "RevokeFunction":
        if (lc(e.args.roleKey) === role) functions.set(`${lc(e.args.targetAddress)}|${lc(e.args.selector)}`, { kind: e.eventName === "AllowFunction" ? "allowed" : "revoked" });
        break;
      case "SetAllowance":
        allowances.set(lc(e.args.allowanceKey), { balance: e.args.balance, maxRefill: e.args.maxRefill, refill: e.args.refill, period: e.args.period });
        break;
      default:
        break;
    }
  }

  // Membership: our role, and no other role for the session key.
  if (membership.get(`${grant.sessionKey}|${role}`) !== true) problems.push("the session key does not end up holding the role");
  for (const [key, member] of membership) {
    const [module, k] = key.split("|");
    if (member && module === grant.sessionKey && k !== role) problems.push("the session key also receives another role");
  }

  // Targets and functions: exactly the expected ones, as their final state.
  const expectedTargets = new Set(grant.scope.targets.map((t) => t.address as string));
  for (const [target, state] of targets) {
    if (!expectedTargets.has(target)) problems.push(`the transaction also gives the role ${target}`);
    else if (state !== "scoped") problems.push(`${target} ends up ${state === "allowed" ? "allowed without conditions" : "revoked"}`);
  }
  const expectedFunctions = new Set<string>();
  const options = BigInt(grant.scope.max_value_per_tx_wei) > 0n ? 1 : 0;
  for (const t of grant.scope.targets) {
    if (targets.get(t.address) !== "scoped") problems.push(`${t.address} was not scoped`);
    for (const f of t.functions) {
      const key = `${t.address}|${lc(f.selector)}`;
      expectedFunctions.add(key);
      const state = functions.get(key);
      const want = functionConditions(grant.id, t.address, f, grant.scope);
      if (!state || state.kind !== "scoped" || state.options !== options || !sameConditions(state.conditions, want)) {
        problems.push(`${f.signature} on ${t.address} does not end up scoped with the expected conditions`);
      }
    }
  }
  for (const [key, state] of functions) {
    if (!expectedFunctions.has(key) && state.kind !== "revoked") problems.push(`the transaction also gives the role ${key.replace("|", " ")}`);
  }

  // Daily allowances: their final values.
  for (const a of allowancesFor(grant.id, grant.scope)) {
    const s = allowances.get(lc(a.key));
    if (!s || s.balance !== a.amount || s.maxRefill !== a.amount || s.refill !== a.amount || s.period !== 86_400n) problems.push(`the ${a.what} limit does not end up as granted`);
  }

  // Live state: the module is on, owned by and acting for this Safe; the bounds contract exists.
  const call = (to: NormalizedAddress, data: Hex) => chain.call({ from: grant.safe, to, data });
  try {
    const enabled = BigInt(await call(grant.safe, encodeFunctionData({ abi: SAFE_ABI, functionName: "isModuleEnabled", args: [grant.roles] }))) === 1n;
    if (!enabled) problems.push("the Roles modifier is not enabled on the Safe");
    for (const fn of ["owner", "avatar", "target"] as const) {
      const out = await call(grant.roles, encodeFunctionData({ abi: ROLES_ABI, functionName: fn }));
      if (normalizeAddress(`0x${out.slice(-40)}`) !== grant.safe) problems.push(`the Roles modifier's ${fn} is not the Safe`);
    }
  } catch (err) {
    problems.push(`could not read the Safe's state: ${(err as Error).message}`);
  }
  if ((await chain.getCode(SESSION_BOUNDS_ADDRESS)) === "0x") problems.push("IgnitraSessionBounds is not deployed");
  return { ok: problems.length === 0, problems, blockNumber: receipt.blockNumber };
}
