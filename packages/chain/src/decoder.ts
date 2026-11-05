import { decodeEventLog, toEventSelector, toEventSignature, type Abi, type AbiEvent, type AbiParameter } from "viem";
import { BUILTIN_ABIS } from "./abis";
import type { JsonValue, RawLog } from "./types";

/**
 * Event decoding. Pure: never throws on bad input, never does I/O.
 *
 * Normalization rules (so conditions and templates see stable values):
 *   uint/int  → decimal string (no precision loss)
 *   address   → lowercase 0x…
 *   bytes/N   → lowercase 0x…
 *   bool/string unchanged; arrays and tuples recursively; unnamed params → arg<i>
 */

export interface DecodedEvent {
  readonly name: string;
  /** Canonical signature, e.g. `Transfer(address,address,uint256)`. */
  readonly signature: string;
  /** Where the ABI came from: `contract` or `builtin:<name>`. */
  readonly source: string;
  readonly args: Record<string, JsonValue>;
}

interface Candidate {
  readonly item: AbiEvent;
  readonly source: string;
}

function indexAbi(abi: Abi, source: string, into: Map<string, Candidate[]> = new Map()): Map<string, Candidate[]> {
  for (const item of abi) {
    if (item.type !== "event" || item.anonymous) continue;
    let selector: string;
    try {
      selector = toEventSelector(item).toLowerCase();
    } catch {
      continue; // malformed ABI item from an explorer — skip, don't fail the whole ABI
    }
    const list = into.get(selector) ?? [];
    list.push({ item, source });
    into.set(selector, list);
  }
  return into;
}

function normalizeValue(param: AbiParameter, value: unknown): JsonValue {
  const type = param.type;
  if (type.endsWith("]")) {
    const inner = { ...param, type: type.slice(0, type.lastIndexOf("[")) } as AbiParameter;
    return Array.isArray(value) ? value.map((v) => normalizeValue(inner, v)) : null;
  }
  if (type === "tuple") {
    const components = "components" in param ? param.components : [];
    return normalizeTuple(components, value);
  }
  if (typeof value === "bigint") return value.toString(10);
  if (type === "address" || type.startsWith("bytes")) return typeof value === "string" ? value.toLowerCase() : null;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  return null;
}

function normalizeTuple(params: readonly AbiParameter[], value: unknown): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  params.forEach((param, i) => {
    const key = param.name && param.name.length > 0 ? param.name : `arg${i}`;
    let raw: unknown;
    if (Array.isArray(value)) raw = value[i];
    else if (value && typeof value === "object") raw = (value as Record<string, unknown>)[key] ?? (value as Record<string, unknown>)[String(i)];
    out[key] = normalizeValue(param, raw);
  });
  return out;
}

function tryDecode(candidate: Candidate, log: Pick<RawLog, "topics" | "data">): DecodedEvent | null {
  const [first, ...rest] = log.topics;
  if (!first) return null;
  try {
    const decoded = decodeEventLog({
      abi: [candidate.item],
      topics: [first, ...rest],
      data: log.data,
      strict: true,
    });
    return {
      name: candidate.item.name,
      signature: toEventSignature(candidate.item),
      source: candidate.source,
      args: normalizeTuple(candidate.item.inputs, decoded.args),
    };
  } catch {
    return null;
  }
}

/** Strict decode against one specific event fragment (flows pin their fragment; no ABI guessing). */
export function decodeWithEvent(event: AbiEvent, log: Pick<RawLog, "topics" | "data">, source = "flow"): DecodedEvent | null {
  if (event.anonymous) return null;
  const selector = toEventSelector(event).toLowerCase();
  if (log.topics[0] !== selector) return null;
  return tryDecode({ item: event, source }, log);
}

export class EventDecoder {
  readonly #builtins: Map<string, Candidate[]>;
  readonly #contractIndex = new WeakMap<Abi, Map<string, Candidate[]>>();

  constructor(builtins: Record<string, Abi> = BUILTIN_ABIS) {
    this.#builtins = new Map();
    for (const [name, abi] of Object.entries(builtins)) indexAbi(abi, `builtin:${name}`, this.#builtins);
  }

  /** Contract ABI candidates win over built-ins; first strict decode wins. */
  decode(log: RawLog, contractAbi?: Abi | null): DecodedEvent | null {
    const topic0 = log.topics[0];
    if (!topic0) return null;
    const candidates: Candidate[] = [];
    if (contractAbi) {
      let index = this.#contractIndex.get(contractAbi);
      if (!index) {
        index = indexAbi(contractAbi, "contract");
        this.#contractIndex.set(contractAbi, index);
      }
      candidates.push(...(index.get(topic0) ?? []));
    }
    candidates.push(...(this.#builtins.get(topic0) ?? []));
    for (const candidate of candidates) {
      const decoded = tryDecode(candidate, log);
      if (decoded) return decoded;
    }
    return null;
  }

  /** topic0 for an event signature like `Transfer(address,address,uint256)` or a full `event …` fragment. */
  static selector(signatureOrFragment: string): `0x${string}` {
    return toEventSelector(signatureOrFragment).toLowerCase() as `0x${string}`;
  }
}
