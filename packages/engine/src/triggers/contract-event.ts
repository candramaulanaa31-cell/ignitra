import { parseAbiItem, toEventSelector, type Abi, type AbiEvent, type AbiParameter } from "viem";
import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, LOG_EVIDENCE_FIELDS, normalizeHash } from "@ignitra/core";
import { BUILTIN_ABIS, abiParamFields, decodeWithEvent, formatEventFragment } from "@ignitra/chain";
import { logEvidence, logKey } from "../evidence";
import { addressParam } from "../params";
import type { LogTriggerModule, TriggerOutcome } from "../types";

/**
 * CONTRACT_EVENT — any decoded event of one contract.
 *
 *   { "address": "0x…", "event": "event Launched(address indexed token, string symbol)" }
 *   { "address": "0x…", "event": "Launched" }     → resolved from the contract's verified ABI at save time
 *
 * The resolved full fragment is stored in the flow version, so matching never
 * depends on an explorer and never changes meaning when an ABI is re-fetched.
 */
export const contractEventParams = z
  .object({
    address: addressParam,
    event: z.string().trim().min(1).max(2000),
  })
  .strict();

export type ContractEventParams = z.output<typeof contractEventParams>;

export class EventResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventResolutionError";
  }
}

const fragments = new Map<string, AbiEvent>();

/** Parses a stored fragment (memoized). Throws EventResolutionError on anything but a non-anonymous event. */
export function parseEventFragment(fragment: string): AbiEvent {
  const hit = fragments.get(fragment);
  if (hit) return hit;
  // viem's parser rejects the `anonymous` keyword outright; give the real reason instead of "unknown signature".
  if (/\banonymous\s*$/.test(fragment)) throw new EventResolutionError("anonymous events have no topic0 and cannot be watched");
  let item;
  try {
    item = parseAbiItem(fragment.startsWith("event ") ? fragment : `event ${fragment}`);
  } catch (err) {
    throw new EventResolutionError(`cannot parse event signature: ${(err as Error).message.split("\n")[0]}`);
  }
  if (item.type !== "event") throw new EventResolutionError("not an event signature");
  if (item.anonymous) throw new EventResolutionError("anonymous events have no topic0 and cannot be watched");
  fragments.set(fragment, item);
  return item;
}

export const contractEventTrigger: LogTriggerModule<ContractEventParams> = {
  type: "CONTRACT_EVENT",
  kind: "log",
  label: "Contract event",
  description: "A specific event emitted by a contract, decoded with its ABI.",
  source: "chain",
  supportsFast: true,
  paramsSchema: contractEventParams,

  async prepare(p, ctx) {
    if (p.event.includes("(")) return { ...p, event: formatEventFragment(parseEventFragment(p.event)) };

    // A bare name: look it up in the contract's ABI (explorer) and the built-ins.
    const stored = ctx.abis ? await ctx.abis.refresh(p.address) : null;
    const pool: Abi = [...(stored?.abi ?? []), ...(Object.values(BUILTIN_ABIS).flat() as Abi)];
    const matches = new Map<string, AbiEvent>();
    for (const item of pool) {
      if (item.type === "event" && item.name === p.event && !item.anonymous) matches.set(formatEventFragment(item), item);
    }
    if (matches.size === 0) {
      throw new EventResolutionError(
        `event "${p.event}" not found${stored?.status === "verified" ? " in the contract's verified ABI" : " (contract ABI unavailable)"}; pass the full signature, e.g. "event ${p.event}(address indexed from, uint256 value)"`,
      );
    }
    if (matches.size > 1) {
      throw new EventResolutionError(`event "${p.event}" is ambiguous; use one of: ${[...matches.keys()].join(" | ")}`);
    }
    return { ...p, event: [...matches.keys()][0] ?? p.event };
  },

  fields(p) {
    let inputs: readonly AbiParameter[] = [];
    try {
      inputs = parseEventFragment(p.event).inputs;
    } catch {
      // unresolved name before prepare(): only the generic fields are known
    }
    return [
      ...CHAIN_EVIDENCE_FIELDS,
      ...LOG_EVIDENCE_FIELDS,
      { path: "event.name", type: "string", description: "Event name" },
      { path: "event.signature", type: "string", description: "Canonical signature, e.g. Transfer(address,address,uint256)" },
      ...abiParamFields(inputs, "args", (p) => `Event argument \`${p.type}${p.name ? ` ${p.name}` : ""}\``),
    ];
  },

  watches(p) {
    return [{ address: p.address, topic0: normalizeHash(toEventSelector(parseEventFragment(p.event))) }];
  },

  async matchBatch(events, p, rt) {
    const fragment = parseEventFragment(p.event);
    return events.map((event): TriggerOutcome | null => {
      if (event.address !== p.address) return null;
      const decoded = decodeWithEvent(fragment, event);
      if (!decoded) return null;
      return {
        kind: "match",
        key: logKey(event),
        chainEventId: event.id,
        payload: {
          ...logEvidence(event, rt.chain),
          event: { name: decoded.name, signature: decoded.signature },
          args: decoded.args,
        },
      };
    });
  },
};
