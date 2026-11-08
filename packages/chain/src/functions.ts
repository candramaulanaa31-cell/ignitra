import { AbiDecodingZeroDataError, decodeFunctionResult, encodeFunctionData, parseAbiItem, toFunctionSignature, type Abi, type AbiFunction, type AbiParameter } from "viem";
import { isValidAddress, normalizeAddress, type FieldSpec, type FieldType } from "@ignitra/core";
import { BUILTIN_ABIS } from "./abis";
import { normalizeAbiTuple, normalizeAbiValue } from "./decoder";
import { formatParam } from "./multicall";
import type { JsonValue } from "./types";

/**
 * Contract reads shared by STATE_CHANGE (trigger) and CHAIN_READ (action).
 *
 *   fragment  "function balanceOf(address account) view returns (uint256)"
 *   args      JSON scalars, static primitives only: addresses, (u)ints as decimal
 *             strings or safe integers, bools, strings, hex bytes
 *   result    normalized like event args: (u)int → decimal string, address/bytes →
 *             lowercase hex; one return value → that value, several → an object
 */

export class FunctionCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunctionCallError";
  }
}

export type CallArg = string | number | boolean;

const fragments = new Map<string, AbiFunction>();

const isPrimitive = (type: string) => !type.endsWith("]") && !type.startsWith("tuple");

/** Parses a function signature (memoized). Inputs must be primitives; at least one return value is required. */
export function parseFunctionFragment(fragment: string): AbiFunction {
  const hit = fragments.get(fragment);
  if (hit) return hit;
  const text = fragment.trim();
  let item;
  try {
    item = parseAbiItem(text.startsWith("function ") ? text : `function ${text}`);
  } catch (err) {
    throw new FunctionCallError(`cannot parse function signature: ${(err as Error).message.split("\n")[0]}`);
  }
  if (item.type !== "function") throw new FunctionCallError("not a function signature");
  if (item.outputs.length === 0) {
    throw new FunctionCallError(`${item.name}() declares no return values; add them, e.g. "function ${item.name}(…) view returns (uint256)"`);
  }
  const complex = item.inputs.find((p) => !isPrimitive(p.type));
  if (complex) throw new FunctionCallError(`argument type ${complex.type} is not supported (arrays and tuples are not)`);
  fragments.set(fragment, item);
  return item;
}

const writeFragments = new Map<string, AbiFunction>();

/**
 * Parses a function signature for a WRITE (ONCHAIN_TX): like parseFunctionFragment, but return
 * values are optional (`ping()`, `transfer(address to, uint256 amount)`). Inputs must be primitives.
 */
export function parseWriteFunction(fragment: string): AbiFunction {
  const hit = writeFragments.get(fragment);
  if (hit) return hit;
  const text = fragment.trim();
  let item;
  try {
    item = parseAbiItem(text.startsWith("function ") ? text : `function ${text}`);
  } catch (err) {
    throw new FunctionCallError(`cannot parse function signature: ${(err as Error).message.split("\n")[0]}`);
  }
  if (item.type !== "function") throw new FunctionCallError("not a function signature");
  const complex = item.inputs.find((p) => !isPrimitive(p.type));
  if (complex) throw new FunctionCallError(`argument type ${complex.type} is not supported (arrays and tuples are not)`);
  writeFragments.set(fragment, item);
  return item;
}

/** Canonical fragment: `function balanceOf(address account) view returns (uint256)`. */
export function formatFunctionFragment(fn: AbiFunction): string {
  const inputs = fn.inputs.map((p) => formatParam(p, true, false)).join(", ");
  const outputs = fn.outputs.map((p) => formatParam(p, true, false)).join(", ");
  const mutability = fn.stateMutability === "nonpayable" ? "" : ` ${fn.stateMutability}`;
  return `function ${fn.name}(${inputs})${mutability} returns (${outputs})`;
}

/** `balanceOf(address)` */
export function functionSignature(fn: AbiFunction): string {
  return toFunctionSignature(fn);
}

/**
 * Resolves a bare function name against a contract ABI plus the built-ins (ERC-20
 * views, owner(), paused(), …), picking the overload with `argCount` inputs.
 */
export function resolveFunctionByName(name: string, argCount: number, abi: Abi | null): AbiFunction {
  const pool: Abi = [...(abi ?? []), ...(Object.values(BUILTIN_ABIS).flat() as Abi)];
  const matches = new Map<string, AbiFunction>();
  for (const item of pool) {
    if (item.type === "function" && item.name === name && item.inputs.length === argCount && item.outputs.length > 0) {
      matches.set(formatFunctionFragment(item), item);
    }
  }
  if (matches.size === 0) {
    throw new FunctionCallError(
      `function "${name}" with ${argCount} argument(s) not found${abi ? " in the contract's ABI" : " (contract ABI unavailable)"}; pass the full signature, e.g. "function ${name}(address account) view returns (uint256)"`,
    );
  }
  if (matches.size > 1) throw new FunctionCallError(`function "${name}" is ambiguous; use one of: ${[...matches.keys()].join(" | ")}`);
  const [only] = matches.values();
  return only as AbiFunction;
}

const UINT = /^uint(\d*)$/;
const INT = /^int(\d*)$/;

function coerce(param: AbiParameter, value: CallArg, index: number): unknown {
  const at = `argument ${index + 1} (${param.type}${param.name ? ` ${param.name}` : ""})`;
  const type = param.type;
  if (type === "address") {
    if (typeof value !== "string" || !isValidAddress(value.trim())) throw new FunctionCallError(`${at}: "${String(value)}" is not a valid address`);
    return normalizeAddress(value.trim());
  }
  if (type === "bool") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "false") return value === "true";
    throw new FunctionCallError(`${at}: expected true or false`);
  }
  const uint = UINT.exec(type);
  const int = INT.exec(type);
  if (uint || int) {
    let n: bigint;
    if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
    else if (typeof value === "string" && /^-?\d{1,78}$/.test(value.trim())) n = BigInt(value.trim());
    else throw new FunctionCallError(`${at}: expected an integer (decimal string for large values), got "${String(value)}"`);
    const bits = BigInt((uint ?? int)?.[1] || "256");
    const [min, max] = uint ? [0n, 2n ** bits - 1n] : [-(2n ** (bits - 1n)), 2n ** (bits - 1n) - 1n];
    if (n < min || n > max) throw new FunctionCallError(`${at}: ${n} is out of range for ${type}`);
    return n;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new FunctionCallError(`${at}: expected a string`);
    return value;
  }
  if (type.startsWith("bytes")) {
    if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value.trim())) throw new FunctionCallError(`${at}: expected 0x-prefixed hex bytes`);
    const hex = value.trim().toLowerCase() as `0x${string}`;
    const size = type === "bytes" ? null : Number(type.slice(5));
    if (size !== null && (hex.length - 2) / 2 !== size) throw new FunctionCallError(`${at}: expected exactly ${size} bytes`);
    return hex;
  }
  throw new FunctionCallError(`${at}: unsupported type`);
}

/** Calldata for `fn(args)`. Throws FunctionCallError with a user-facing message. */
export function encodeFunctionCall(fn: AbiFunction, args: readonly CallArg[]): `0x${string}` {
  if (args.length !== fn.inputs.length) {
    throw new FunctionCallError(`${fn.name} expects ${fn.inputs.length} argument(s), got ${args.length}`);
  }
  const values = fn.inputs.map((p, i) => coerce(p, args[i] as CallArg, i));
  try {
    return encodeFunctionData({ abi: [fn], functionName: fn.name, args: values });
  } catch (err) {
    throw new FunctionCallError(`cannot encode arguments: ${(err as Error).message.split("\n")[0]}`);
  }
}

/** Normalized arguments as they appear in payloads (big integers as strings). */
export function normalizeCallArgs(fn: AbiFunction, args: readonly CallArg[]): JsonValue[] {
  return fn.inputs.map((p, i) => normalizeAbiValue(p, coerce(p, args[i] as CallArg, i)));
}

/** Decodes return data: one output → its value, several → an object keyed by output name. */
export function decodeFunctionReturn(fn: AbiFunction, data: `0x${string}`): JsonValue {
  let decoded: unknown;
  try {
    decoded = decodeFunctionResult({ abi: [fn], functionName: fn.name, data });
  } catch (err) {
    if (err instanceof AbiDecodingZeroDataError) {
      throw new FunctionCallError("the call returned no data: is a contract deployed at this address, and does it have this function?");
    }
    throw new FunctionCallError(`cannot decode the return value: ${(err as Error).message.split("\n")[0]}`);
  }
  const [only] = fn.outputs;
  if (fn.outputs.length === 1 && only) return normalizeAbiValue(only, decoded);
  return normalizeAbiTuple(fn.outputs, decoded);
}

/** Field type of an ABI parameter as conditions / templates see it. */
export function abiFieldType(param: AbiParameter): FieldType {
  const t = param.type;
  if (t.endsWith("]")) return "array";
  if (t === "tuple") return "object";
  if (t === "address") return "address";
  if (t === "bool") return "boolean";
  if (t === "string") return "string";
  if (t.startsWith("uint")) return "uint";
  if (t.startsWith("int")) return "int";
  if (t === "bytes32") return "hash";
  return "string"; // bytes / bytesN as lowercase hex
}

/** Field specs for ABI parameters under `prefix` (tuples expanded up to 3 levels). */
export function abiParamFields(params: readonly AbiParameter[], prefix: string, describe: (p: AbiParameter) => string, depth = 0): FieldSpec[] {
  const out: FieldSpec[] = [];
  params.forEach((p, i) => {
    const name = p.name && p.name.length > 0 ? p.name : `arg${i}`;
    const path = `${prefix}.${name}`;
    out.push({ path, type: abiFieldType(p), description: describe(p) });
    if (p.type === "tuple" && "components" in p && depth < 3) out.push(...abiParamFields(p.components, path, describe, depth + 1));
  });
  return out;
}

/**
 * Fields of a function's return value at `path`: one output → `path` itself
 * typed by that output; several → `path.<name>` each.
 */
export function returnFields(fn: AbiFunction, path: string, label: string): FieldSpec[] {
  const [only] = fn.outputs;
  const describe = (p: AbiParameter) => `${label} \`${p.type}${p.name ? ` ${p.name}` : ""}\``;
  if (fn.outputs.length === 1 && only) {
    const fields: FieldSpec[] = [{ path, type: abiFieldType(only), description: describe(only) }];
    if (only.type === "tuple" && "components" in only) fields.push(...abiParamFields(only.components, path, describe));
    return fields;
  }
  // No container entry: an "object" field would make every path below it valid; the named outputs are exact
  // (`{{…path}}` still renders the whole object).
  return abiParamFields(fn.outputs, path, describe);
}
