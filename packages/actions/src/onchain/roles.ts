import { concat, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodePacked, getContractAddress, keccak256, numberToHex, pad, size, toHex, zeroAddress, type Hex } from "viem";
import type { ChainTxClient, NormalizedAddress } from "@ignitra/core";
import { MODULE_PROXY_FACTORY_ABI, MULTISEND_ABI, ONCHAIN, ROLES_ABI, SAFE_ABI, SESSION_BOUNDS_ADDRESS, SESSION_BOUNDS_INITCODE, SESSION_BOUNDS_SALT } from "./contracts";
import { isDynamicAbiType, type GrantScope, type ScopedFunction } from "./scope";

/**
 * Turning a grant into Zodiac Roles v2 permissions on the user's Safe.
 *
 * One Roles modifier per Safe (deterministic address), one role per grant. For each scoped
 * function the condition tree is
 *
 *   Matches(Calldata)                                   root: the function's calldata
 *   ├─ Pass(Static|Dynamic) …                           arguments before the amount (any value)
 *   ├─ And ── LessThan(max per tx + 1)                  the amount argument, when capped
 *   │     └─ WithinAllowance(<amount per day>)
 *   ├─ Custom(IgnitraSessionBounds, expiry ‖ ETH/tx)    expiry and the per-call ETH cap
 *   └─ EtherWithinAllowance(<ETH per day>)              when the grant allows ETH
 *
 * (Shapes checked against the verified Roles v2 source: allowance nodes must be children of
 * the Calldata node; None-typed children take no calldata, so argument positions stay put.)
 */

const PARAM = { None: 0, Static: 1, Dynamic: 2, Calldata: 5 } as const;
const OP = { Pass: 0, And: 1, Matches: 5, LessThan: 18, Custom: 22, WithinAllowance: 28, EtherWithinAllowance: 29 } as const;
const OPTIONS = { None: 0, Send: 1 } as const;
const DAY = 86_400n;

export interface ConditionFlat {
  readonly parent: number;
  readonly paramType: number;
  readonly operator: number;
  readonly compValue: Hex;
}

export const roleKeyFor = (grantId: string): Hex => keccak256(toHex(`ignitra:grant:${grantId}`));
export const ethPerDayKey = (grantId: string): Hex => keccak256(toHex(`ignitra:${grantId}:eth-per-day`));
export const amountPerDayKey = (grantId: string, target: string, selector: string): Hex => keccak256(toHex(`ignitra:${grantId}:amount-per-day:${target}:${selector}`));

/** expiry (uint32) ‖ max ETH per call in gwei (uint64): IgnitraSessionBounds' `extra`. */
export function boundsCompValue(expiresAtSeconds: number, maxValuePerTxWei: bigint): Hex {
  const extra = (BigInt(expiresAtSeconds) << 64n) | (maxValuePerTxWei / 1_000_000_000n);
  return concat([SESSION_BOUNDS_ADDRESS, pad(numberToHex(extra), { size: 12 })]);
}

export function functionConditions(grantId: string, target: NormalizedAddress, fn: ScopedFunction, scope: GrantScope): ConditionFlat[] {
  const out: ConditionFlat[] = [{ parent: 0, paramType: PARAM.Calldata, operator: OP.Matches, compValue: "0x" }];
  let amountNode = -1;
  if (fn.amount) {
    for (let i = 0; i < fn.amount.arg; i++) out.push({ parent: 0, paramType: isDynamicAbiType(fn.inputs[i] ?? "") ? PARAM.Dynamic : PARAM.Static, operator: OP.Pass, compValue: "0x" });
    amountNode = out.length;
    out.push({ parent: 0, paramType: PARAM.None, operator: OP.And, compValue: "0x" });
  }
  out.push({ parent: 0, paramType: PARAM.None, operator: OP.Custom, compValue: boundsCompValue(Math.floor(Date.parse(scope.expires_at) / 1000), BigInt(scope.max_value_per_tx_wei)) });
  if (BigInt(scope.max_value_per_day_wei) > 0n) out.push({ parent: 0, paramType: PARAM.None, operator: OP.EtherWithinAllowance, compValue: ethPerDayKey(grantId) });
  if (fn.amount) {
    out.push({ parent: amountNode, paramType: PARAM.Static, operator: OP.LessThan, compValue: pad(numberToHex(BigInt(fn.amount.max_per_tx) + 1n), { size: 32 }) });
    out.push({ parent: amountNode, paramType: PARAM.Static, operator: OP.WithinAllowance, compValue: amountPerDayKey(grantId, target, fn.selector) });
  }
  return out;
}

/** The Safe's Roles modifier: deterministic, so a batch can configure it in the same transaction that deploys it. */
export function rolesInitializer(safe: NormalizedAddress): Hex {
  return encodeFunctionData({ abi: ROLES_ABI, functionName: "setUp", args: [encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [safe, safe, safe])] });
}
export const rolesSaltNonce = (safe: NormalizedAddress): bigint => BigInt(keccak256(toHex(`ignitra:roles:${safe}`)));

export function rolesAddressFor(safe: NormalizedAddress): NormalizedAddress {
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(rolesInitializer(safe)), rolesSaltNonce(safe)]));
  const bytecode = concat(["0x602d8060093d393df3363d3d373d3d3d363d73", ONCHAIN.rolesMastercopy, "0x5af43d82803e903d91602b57fd5bf3"]);
  return getContractAddress({ opcode: "CREATE2", from: ONCHAIN.moduleProxyFactory, salt, bytecode }).toLowerCase() as NormalizedAddress;
}

export interface PlannedCall {
  readonly to: NormalizedAddress;
  readonly value: bigint;
  readonly data: Hex;
  /** What it does, for the person approving it. */
  readonly description: string;
}

export interface AllowanceSpec {
  readonly key: Hex;
  readonly amount: bigint;
  readonly what: string;
}

export function allowancesFor(grantId: string, scope: GrantScope): AllowanceSpec[] {
  const out: AllowanceSpec[] = [];
  const ethDay = BigInt(scope.max_value_per_day_wei);
  if (ethDay > 0n) out.push({ key: ethPerDayKey(grantId), amount: ethDay, what: "ETH per day" });
  for (const t of scope.targets) {
    for (const f of t.functions) {
      if (f.amount) out.push({ key: amountPerDayKey(grantId, t.address, f.selector), amount: BigInt(f.amount.max_per_day), what: `${f.signature} amount per day on ${t.address}` });
    }
  }
  return out;
}

/** The calls the Safe makes to give the grant: deploying what is missing, then the role. */
export async function planGrant(
  chain: Pick<ChainTxClient, "getCode" | "call">,
  grant: { readonly id: string; readonly safe: NormalizedAddress; readonly sessionKey: NormalizedAddress; readonly scope: GrantScope },
): Promise<{ roles: NormalizedAddress; roleKey: Hex; calls: PlannedCall[] }> {
  const roles = rolesAddressFor(grant.safe);
  const roleKey = roleKeyFor(grant.id);
  const calls: PlannedCall[] = [];
  if ((await chain.getCode(SESSION_BOUNDS_ADDRESS)) === "0x") {
    calls.push({ to: ONCHAIN.create2Deployer, value: 0n, data: concat([SESSION_BOUNDS_SALT, SESSION_BOUNDS_INITCODE]), description: "Deploy IgnitraSessionBounds (expiry and per-call ETH cap), stateless" });
  }
  const rolesDeployed = (await chain.getCode(roles)) !== "0x";
  if (!rolesDeployed) {
    calls.push({
      to: ONCHAIN.moduleProxyFactory,
      value: 0n,
      data: encodeFunctionData({ abi: MODULE_PROXY_FACTORY_ABI, functionName: "deployModule", args: [ONCHAIN.rolesMastercopy, rolesInitializer(grant.safe), rolesSaltNonce(grant.safe)] }),
      description: `Deploy this Safe's Zodiac Roles v2 modifier at ${roles} (owned by the Safe)`,
    });
  }
  const enabled = rolesDeployed ? await isModuleEnabled(chain, grant.safe, roles) : false;
  if (!enabled) calls.push({ to: grant.safe, value: 0n, data: encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [roles] }), description: "Enable the Roles modifier on the Safe" });
  calls.push({
    to: roles,
    value: 0n,
    data: encodeFunctionData({ abi: ROLES_ABI, functionName: "assignRoles", args: [grant.sessionKey, [roleKey], [true]] }),
    description: `Give IGNITRA's session key ${grant.sessionKey} this grant's role`,
  });
  for (const t of grant.scope.targets) {
    calls.push({ to: roles, value: 0n, data: encodeFunctionData({ abi: ROLES_ABI, functionName: "scopeTarget", args: [roleKey, t.address] }), description: `Allow only scoped functions on ${t.address}` });
    for (const f of t.functions) {
      const options = BigInt(grant.scope.max_value_per_tx_wei) > 0n ? OPTIONS.Send : OPTIONS.None;
      calls.push({
        to: roles,
        value: 0n,
        data: encodeFunctionData({ abi: ROLES_ABI, functionName: "scopeFunction", args: [roleKey, t.address, f.selector, functionConditions(grant.id, t.address, f, grant.scope), options] }),
        description: `Allow ${f.signature} on ${t.address}${f.amount ? ` (amount ≤ ${f.amount.max_per_tx} per call, ${f.amount.max_per_day} per day)` : ""}`,
      });
    }
  }
  for (const a of allowancesFor(grant.id, grant.scope)) {
    calls.push({
      to: roles,
      value: 0n,
      data: encodeFunctionData({ abi: ROLES_ABI, functionName: "setAllowance", args: [a.key, a.amount, a.amount, a.amount, DAY, 0n] }),
      description: `Limit: ${a.amount} ${a.what} (refills daily)`,
    });
  }
  return { roles, roleKey, calls };
}

const MODULES_SENTINEL = "0x0000000000000000000000000000000000000001";

/**
 * The Safe's enabled modules. None of them may be a grant target: calls run AS the Safe, which
 * owns its modules, so a call to one could widen permissions (e.g. another Roles modifier).
 */
export async function safeModules(chain: Pick<ChainTxClient, "call">, safe: NormalizedAddress): Promise<NormalizedAddress[]> {
  const out = await chain.call({ from: safe, to: safe, data: encodeFunctionData({ abi: SAFE_ABI, functionName: "getModulesPaginated", args: [MODULES_SENTINEL, 100n] }) });
  const [modules] = decodeFunctionResult({ abi: SAFE_ABI, functionName: "getModulesPaginated", data: out });
  return modules.map((m) => m.toLowerCase() as NormalizedAddress);
}

async function isModuleEnabled(chain: Pick<ChainTxClient, "call">, safe: NormalizedAddress, module: NormalizedAddress): Promise<boolean> {
  const out = await chain.call({ from: safe, to: safe, data: encodeFunctionData({ abi: SAFE_ABI, functionName: "isModuleEnabled", args: [module] }) });
  return BigInt(out) === 1n;
}

/** Safe MultiSend payload: operation (0 = call) ‖ to ‖ value ‖ data length ‖ data, per call. */
export function encodeMultiSend(calls: readonly PlannedCall[]): Hex {
  const packed = concat(calls.map((c) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value, BigInt(size(c.data)), c.data])));
  return encodeFunctionData({ abi: MULTISEND_ABI, functionName: "multiSend", args: [packed] });
}

export interface SafeTransaction {
  readonly to: NormalizedAddress;
  readonly value: bigint;
  readonly data: Hex;
  /** 0 = call, 1 = delegatecall (only ever to MultiSendCallOnly, which itself makes calls only). */
  readonly operation: 0 | 1;
}

/** One Safe transaction for the plan: the calls batched through MultiSendCallOnly (or the single call). */
export function safeTransactionFor(calls: readonly PlannedCall[]): SafeTransaction {
  const only = calls[0];
  if (calls.length === 1 && only) return { to: only.to, value: only.value, data: only.data, operation: 0 };
  return { to: ONCHAIN.multiSendCallOnly, value: 0n, data: encodeMultiSend(calls), operation: 1 };
}

/**
 * `Safe.execTransaction` calldata an owner can send themselves on a 1-of-N Safe: the
 * signature is the "pre-validated" kind (v = 1), valid because the sender IS that owner.
 */
export function execTransactionByOwner(tx: SafeTransaction, owner: NormalizedAddress): Hex {
  const signature = concat([pad(owner, { size: 32 }), pad("0x", { size: 32 }), "0x01"]);
  return encodeFunctionData({ abi: SAFE_ABI, functionName: "execTransaction", args: [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signature] });
}

/** Removes the session key from the role (the user can do this at any time, without IGNITRA). */
export function revokeCall(grant: { readonly roles: NormalizedAddress; readonly sessionKey: NormalizedAddress; readonly roleKey: Hex }): PlannedCall {
  return {
    to: grant.roles,
    value: 0n,
    data: encodeFunctionData({ abi: ROLES_ABI, functionName: "assignRoles", args: [grant.sessionKey, [grant.roleKey], [false]] }),
    description: `Remove IGNITRA's session key ${grant.sessionKey} from the role`,
  };
}

/** The same calls as a Safe{Wallet} Transaction Builder batch, for Safes with more than one signer. */
export function txBuilderJson(chainId: number, safe: NormalizedAddress, name: string, calls: readonly PlannedCall[]) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description: "Created by IGNITRA: scoped, revocable permissions for an IGNITRA session key (Zodiac Roles v2).", txBuilderVersion: "1.16.5", createdFromSafeAddress: safe },
    transactions: calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data, contractMethod: null, contractInputsValues: null })),
  };
}
