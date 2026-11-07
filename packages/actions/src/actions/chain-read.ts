import { z } from "zod";
import { isValidAddress, normalizeAddress, type ActionDefinition, type FieldSpec } from "@ignitra/core";
import {
  CallRevertedError,
  FunctionCallError,
  StateUnavailableError,
  decodeFunctionReturn,
  encodeFunctionCall,
  formatFunctionFragment,
  functionSignature,
  normalizeCallArgs,
  parseFunctionFragment,
  returnFields,
  type CallArg,
} from "@ignitra/chain";

/**
 * CHAIN_READ — read a contract (eth_call) and pass the result to later steps.
 *
 *   {
 *     "address": "{{trigger.token.address}}",                 an address or a template
 *     "function": "function balanceOf(address account) view returns (uint256)",
 *     "args": ["{{trigger.to}}"],
 *     "block": "latest"                                       or "trigger": the event's block
 *   }
 *
 * Output: `{{steps.<id>.result}}` (one return value; several → `result.<name>`)
 * and `{{steps.<id>.block_number}}`. Read-only: nothing is signed or sent.
 * Robinhood Chain's public RPC keeps only minutes of history, so `block: "trigger"`
 * suits runs that execute promptly; "latest" always works.
 */

const isTemplate = (v: unknown) => typeof v === "string" && v.includes("{{");

const fragment = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .transform((v, ctx) => {
    try {
      return formatFunctionFragment(parseFunctionFragment(v));
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  });

export const chainReadParams = z
  .object({
    address: z
      .string()
      .trim()
      .max(500)
      .refine((v) => isTemplate(v) || isValidAddress(v), { message: "must be an address or a template such as {{trigger.token.address}}" })
      .transform((v) => (isTemplate(v) ? v : normalizeAddress(v))),
    function: fragment,
    args: z.array(z.union([z.string().max(1000), z.number(), z.boolean()])).max(10).default([]),
    block: z.enum(["latest", "trigger"]).default("latest"),
  })
  .strict()
  .superRefine((p, ctx) => {
    // Literal arguments are checked now; templated ones once they are rendered.
    let fn;
    try {
      fn = parseFunctionFragment(p.function);
    } catch {
      return;
    }
    if (p.args.length !== fn.inputs.length) {
      ctx.addIssue({ code: "custom", path: ["args"], message: `${fn.name} expects ${fn.inputs.length} argument(s), got ${p.args.length}` });
      return;
    }
    const probe = p.args.map((a, i) => (isTemplate(a) ? sampleFor(fn.inputs[i]?.type ?? "") : a));
    try {
      encodeFunctionCall(fn, probe);
    } catch (err) {
      ctx.addIssue({ code: "custom", path: ["args"], message: (err as Error).message });
    }
  });

export type ChainReadParams = z.output<typeof chainReadParams>;

/** A valid placeholder for a templated argument of `type` (save-time encoding check). */
function sampleFor(type: string): CallArg {
  if (type === "address") return "0x0000000000000000000000000000000000000000";
  if (type === "bool") return false;
  if (type.startsWith("uint") || type.startsWith("int")) return "0";
  if (type === "bytes") return "0x";
  if (type.startsWith("bytes")) return `0x${"00".repeat(Number(type.slice(5)) || 32)}`;
  return "";
}

const BASE_OUTPUTS: readonly FieldSpec[] = [
  { path: "result", type: "object", description: "Decoded return value (one value, or an object of named values)" },
  { path: "block_number", type: "uint", description: "Block the read was made at" },
];

export const chainReadAction: ActionDefinition<ChainReadParams> = {
  type: "CHAIN_READ",
  label: "Read contract",
  description: "Call a view function (eth_call) and use the result in later steps, e.g. a balance or a price.",
  connectionType: null,
  paramsSchema: chainReadParams,
  templates: (p) => [
    ...(isTemplate(p.address) ? [{ name: "address", template: p.address }] : []),
    ...p.args.flatMap((a, i) => (typeof a === "string" && isTemplate(a) ? [{ name: `args.${i}`, template: a }] : [])),
  ],
  outputFields: BASE_OUTPUTS,
  outputFieldsFor(p) {
    try {
      return [...returnFields(parseFunctionFragment(p.function), "result", "Return value"), { path: "block_number", type: "uint", description: "Block the read was made at" }];
    } catch {
      return BASE_OUTPUTS;
    }
  },
  validate(p, ctx) {
    if (p.block === "trigger" && !ctx.triggerFields.some((f) => f.path === "block_number")) {
      return ['block "trigger" needs a chain trigger (this trigger has no block_number); use "latest"'];
    }
    return [];
  },

  async execute(p, ctx) {
    if (!ctx.chain) return { status: "failed", retryable: false, error: "this runner has no chain RPC configured" };
    const fn = parseFunctionFragment(p.function);
    const rendered = isTemplate(p.address) ? ctx.render(p.address).trim() : p.address;
    if (!isValidAddress(rendered)) return { status: "failed", retryable: false, error: `address "${rendered.slice(0, 80)}" is not a valid address` };
    const address = normalizeAddress(rendered);
    const args = p.args.map((a) => (typeof a === "string" && isTemplate(a) ? ctx.render(a) : a));

    let data: `0x${string}`;
    let shownArgs: unknown[];
    try {
      data = encodeFunctionCall(fn, args);
      shownArgs = normalizeCallArgs(fn, args);
    } catch (err) {
      if (err instanceof FunctionCallError) return { status: "failed", retryable: false, error: err.message };
      throw err;
    }

    let blockNumber: number;
    if (p.block === "trigger") {
      const b = ctx.trigger.block_number;
      if (typeof b !== "number") return { status: "failed", retryable: false, error: 'block "trigger": the trigger has no block_number' };
      blockNumber = b;
    } else {
      try {
        blockNumber = await ctx.chain.blockNumber();
      } catch (err) {
        return { status: "failed", retryable: true, error: `RPC unavailable: ${(err as Error).message}` };
      }
    }
    const request = { contract: address, function: functionSignature(fn), args: shownArgs, block: blockNumber };

    let raw: `0x${string}`;
    try {
      raw = await ctx.chain.call({ to: address, data, blockNumber });
    } catch (err) {
      if (err instanceof CallRevertedError) {
        return { status: "failed", retryable: false, error: `call reverted${err.data && err.data !== "0x" ? ` (data ${err.data.slice(0, 74)})` : ""}`, request };
      }
      if (err instanceof StateUnavailableError) {
        return { status: "failed", retryable: false, error: `the node no longer has state for block ${blockNumber} (pruned); use block "latest"`, request };
      }
      return { status: "failed", retryable: true, error: `RPC error: ${(err as Error).message}`, request };
    }
    let result;
    try {
      result = decodeFunctionReturn(fn, raw);
    } catch (err) {
      if (err instanceof FunctionCallError) return { status: "failed", retryable: false, error: err.message, request };
      throw err;
    }
    const preview = JSON.stringify(result);
    return {
      status: "succeeded",
      output: { result, block_number: blockNumber },
      request,
      response: { result: preview.length > 500 ? `${preview.slice(0, 500)}…` : result },
    };
  },
};
