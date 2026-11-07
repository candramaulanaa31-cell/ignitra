import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, type FieldSpec } from "@ignitra/core";
import {
  CallRevertedError,
  FunctionCallError,
  decodeFunctionReturn,
  encodeFunctionCall,
  formatFunctionFragment,
  functionSignature,
  normalizeCallArgs,
  parseFunctionFragment,
  resolveFunctionByName,
  returnFields,
  type JsonValue,
} from "@ignitra/chain";
import { blockEvidence } from "../evidence";
import { addressParam } from "../params";
import type { PollTriggerModule, TriggerOutcome } from "../types";

/**
 * STATE_CHANGE — the return value of a contract read changes.
 *
 *   { "address": "0x…", "function": "function totalSupply() view returns (uint256)" }
 *   { "address": "0x…", "function": "balanceOf", "args": ["0x…"] }   → resolved from the ABI at save time
 *
 * Sampled at the confirmed head every poll interval (no history needed: Robinhood
 * Chain's RPC keeps only minutes of state). The first sample is the baseline;
 * every later sample that differs fires once, with previous and current values.
 * Changes that revert between two samples are not seen (the sample is the truth).
 * A reverting call is recorded as `undetermined`, never treated as a change.
 */

const argSchema = z.union([z.string().max(1000), z.number(), z.boolean()]);

export const stateChangeParams = z
  .object({
    address: addressParam,
    function: z.string().trim().min(1).max(2000),
    args: z.array(argSchema).max(10).default([]),
  })
  .strict();

export type StateChangeParams = z.output<typeof stateChangeParams>;

export interface StateChangeState {
  readonly value: JsonValue;
  /** Block where `value` was first observed. */
  readonly block: number;
  /** Last block sampled (polls never go backwards). */
  readonly sampled: number;
}

const isInteger = (type: string) => type.startsWith("uint") || type.startsWith("int");

export const stateChangeTrigger: PollTriggerModule<StateChangeParams, StateChangeState> = {
  type: "STATE_CHANGE",
  kind: "poll",
  label: "Contract state change",
  description: "A contract read (e.g. totalSupply(), owner(), paused()) returns a different value.",
  source: "chain",
  supportsFast: false,
  paramsSchema: stateChangeParams,

  async prepare(p, ctx) {
    let fragment: string;
    if (p.function.includes("(")) {
      fragment = formatFunctionFragment(parseFunctionFragment(p.function));
    } else {
      const stored = ctx.abis ? await ctx.abis.refresh(p.address) : null;
      fragment = formatFunctionFragment(resolveFunctionByName(p.function, p.args.length, stored?.abi ?? null));
    }
    encodeFunctionCall(parseFunctionFragment(fragment), p.args); // argument count and types, at save time
    return { ...p, function: fragment };
  },

  fields(p) {
    let fn;
    try {
      fn = parseFunctionFragment(p.function);
    } catch {
      fn = null; // unresolved name before prepare(): only the generic fields are known
    }
    const valueFields = fn
      ? [...returnFields(fn, "current", "Return value now"), ...returnFields(fn, "previous", "Return value at the previous sample")]
      : [
          { path: "current", type: "object", description: "Return value now" } as const,
          { path: "previous", type: "object", description: "Return value at the previous sample" } as const,
        ];
    const [only] = fn?.outputs ?? [];
    const delta: FieldSpec[] =
      fn && fn.outputs.length === 1 && only && isInteger(only.type)
        ? [{ path: "delta", type: "int", description: "current minus previous (negative when it decreased)" }]
        : [];
    return [
      ...CHAIN_EVIDENCE_FIELDS,
      { path: "contract", type: "address", description: "Contract that was read" },
      { path: "function.name", type: "string", description: "Function name" },
      { path: "function.signature", type: "string", description: "Canonical signature, e.g. balanceOf(address)" },
      { path: "args", type: "array", description: "Call arguments (normalized)" },
      ...valueFields,
      ...delta,
      { path: "previous_block", type: "uint", description: "Block where the previous value was first observed" },
    ];
  },

  async sample(p, rt, block) {
    const fn = parseFunctionFragment(p.function);
    let value: JsonValue;
    try {
      value = decodeFunctionReturn(fn, await rt.reader.call({ to: p.address, data: encodeFunctionCall(fn, p.args), blockNumber: block.number }));
    } catch (err) {
      if (err instanceof CallRevertedError || err instanceof FunctionCallError) return null;
      throw err;
    }
    const [only] = fn.outputs;
    return {
      note: "current value (previous = current): the flow runs when it changes",
      payload: {
        ...blockEvidence(block, rt.chain, p.address),
        contract: p.address,
        function: { name: fn.name, signature: functionSignature(fn) },
        args: normalizeCallArgs(fn, p.args),
        previous: value,
        current: value,
        ...(fn.outputs.length === 1 && only && isInteger(only.type) ? { delta: "0" } : {}),
        previous_block: block.number,
      },
    };
  },

  async poll({ params: p, state, block }, rt) {
    if (state && block.number <= state.sampled) return { state: null, outcomes: [] };
    const fn = parseFunctionFragment(p.function);
    const evidence = { ...blockEvidence(block, rt.chain, p.address), contract: p.address, function: { name: fn.name, signature: functionSignature(fn) }, args: normalizeCallArgs(fn, p.args) };
    const undetermined = (reason: string): { state: null; outcomes: TriggerOutcome[] } => ({
      state: null,
      outcomes: [{ kind: "undetermined", key: `state:${block.number}`, reason, payload: evidence }],
    });

    let value: JsonValue;
    try {
      const raw = await rt.reader.call({ to: p.address, data: encodeFunctionCall(fn, p.args), blockNumber: block.number });
      value = decodeFunctionReturn(fn, raw);
    } catch (err) {
      if (err instanceof CallRevertedError) return undetermined(`call reverted${err.data && err.data !== "0x" ? ` (data ${err.data.slice(0, 74)})` : ""}`);
      if (err instanceof FunctionCallError) return undetermined(err.message);
      throw err; // RPC trouble: retried next interval
    }

    if (!state) return { state: { value, block: block.number, sampled: block.number }, outcomes: [] };
    if (JSON.stringify(value) === JSON.stringify(state.value)) return { state: { ...state, sampled: block.number }, outcomes: [] };

    const [only] = fn.outputs;
    const delta =
      fn.outputs.length === 1 && only && isInteger(only.type) && typeof value === "string" && typeof state.value === "string"
        ? { delta: (BigInt(value) - BigInt(state.value)).toString() }
        : {};
    return {
      state: { value, block: block.number, sampled: block.number },
      outcomes: [
        {
          kind: "match",
          key: `state:${block.number}`,
          payload: { ...evidence, previous: state.value, current: value, ...delta, previous_block: state.block },
        },
      ],
    };
  },
};
