import { CONDITION_OPERATORS, type ConditionOperator } from "./catalog";
import { compareDecimal, toDecimal } from "./decimal";
import { isConditionGroup, type ConditionGroup, type ConditionLeaf, type ConditionNode } from "./flow";
import {
  createConditionOperatorRegistry,
  type ConditionError,
  type ConditionOperatorDefinition,
  type ConditionOperatorRegistry,
  type OperatorOutcome,
} from "./registry/modules";

/**
 * Condition evaluator — pure, total, deterministic.
 *
 * Semantics (documented for users in /docs):
 *  - Numbers and numeric strings compare EXACTLY as decimals ("1000000000000000000000" vs 1e21).
 *  - 0x-hex strings (addresses, hashes) compare case-insensitively.
 *  - Other strings compare exactly (case-sensitive). Booleans compare strictly.
 *  - A missing (or null) field fails every operator except EXISTS — a flow never
 *    runs on data it does not have. Comparing incompatible types fails with
 *    `type_mismatch` instead of guessing.
 *  - Every leaf is evaluated (no short-circuit) so the run trace shows them all.
 */

export interface ConditionLeafResult {
  /** Position in the tree, e.g. `all.1.any.0`. */
  readonly path: string;
  readonly field: string;
  readonly op: ConditionOperator;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly passed: boolean;
  readonly error?: ConditionError;
}

export interface ConditionEvaluation {
  readonly passed: boolean;
  readonly results: ConditionLeafResult[];
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

type Equality = { readonly equal: boolean } | { readonly mismatch: true };

/** Shared equality used by ==, !=, IN, NOT_IN and array CONTAINS. */
export function conditionEquals(actual: unknown, expected: unknown): Equality {
  const da = toDecimal(actual);
  const de = toDecimal(expected);
  if (da !== null && de !== null) return { equal: compareDecimal(da, de) === 0 };
  if (typeof actual === "string" && typeof expected === "string") {
    if (HEX_RE.test(actual) && HEX_RE.test(expected)) return { equal: actual.toLowerCase() === expected.toLowerCase() };
    return { equal: actual === expected };
  }
  if (typeof actual === "boolean" && typeof expected === "boolean") return { equal: actual === expected };
  return { mismatch: true };
}

const mismatch: OperatorOutcome = { passed: false, error: "type_mismatch" };

function ordering(type: ConditionOperator, label: string, accept: (cmp: -1 | 0 | 1) => boolean): ConditionOperatorDefinition {
  return {
    type,
    label,
    evaluate(actual, expected) {
      const a = toDecimal(actual);
      const e = toDecimal(expected);
      if (a === null || e === null) return mismatch;
      return { passed: accept(compareDecimal(a, e)) };
    },
  };
}

function inList(actual: unknown, expected: unknown): boolean | null {
  if (!Array.isArray(expected)) return null;
  return expected.some((item) => {
    const r = conditionEquals(actual, item);
    return "equal" in r && r.equal;
  });
}

export const BUILTIN_OPERATORS: readonly ConditionOperatorDefinition[] = [
  {
    type: "==",
    label: "equals",
    evaluate(actual, expected) {
      const r = conditionEquals(actual, expected);
      return "mismatch" in r ? mismatch : { passed: r.equal };
    },
  },
  {
    type: "!=",
    label: "does not equal",
    evaluate(actual, expected) {
      const r = conditionEquals(actual, expected);
      return "mismatch" in r ? mismatch : { passed: !r.equal };
    },
  },
  ordering(">", "greater than", (c) => c > 0),
  ordering(">=", "at least", (c) => c >= 0),
  ordering("<", "less than", (c) => c < 0),
  ordering("<=", "at most", (c) => c <= 0),
  {
    type: "IN",
    label: "is one of",
    evaluate(actual, expected) {
      const r = inList(actual, expected);
      return r === null ? mismatch : { passed: r };
    },
  },
  {
    type: "NOT_IN",
    label: "is none of",
    evaluate(actual, expected) {
      const r = inList(actual, expected);
      return r === null ? mismatch : { passed: !r };
    },
  },
  {
    type: "CONTAINS",
    label: "contains",
    evaluate(actual, expected) {
      if (Array.isArray(actual)) {
        return {
          passed: actual.some((item) => {
            const r = conditionEquals(item, expected);
            return "equal" in r && r.equal;
          }),
        };
      }
      if (typeof actual === "string" && typeof expected === "string") {
        const hex = HEX_RE.test(actual) && HEX_RE.test(expected);
        return { passed: hex ? actual.toLowerCase().includes(expected.toLowerCase()) : actual.includes(expected) };
      }
      return mismatch;
    },
  },
  {
    type: "EXISTS",
    label: "exists",
    evaluate(actual, expected) {
      const present = actual !== undefined && actual !== null;
      return { passed: present === (expected === undefined ? true : expected === true) };
    },
  },
];

export function createDefaultConditionOperators(): ConditionOperatorRegistry {
  const registry = createConditionOperatorRegistry();
  for (const op of BUILTIN_OPERATORS) registry.register(op);
  return registry;
}

const defaultOperators = createDefaultConditionOperators();
if (defaultOperators.size !== CONDITION_OPERATORS.length) {
  throw new Error("every catalog operator must have an implementation");
}

/** Dotted-path lookup over own properties only (no prototype access). */
export function resolveField(context: unknown, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Keeps traces small: long strings and big arrays/objects are summarized. */
function summarize(value: unknown): unknown {
  // Traces are stored as JSON: anything JSON cannot represent becomes a string.
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.length > 256 ? `${value.slice(0, 256)}…` : value;
  if (Array.isArray(value)) return value.length > 20 ? [...value.slice(0, 20).map(summarize), `…(${value.length - 20} more)`] : value.map(summarize);
  if (value !== null && typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > 1000 ? `[object, ${json.length} chars]` : value;
  }
  return value === undefined ? null : value;
}

function evaluateLeaf(leaf: ConditionLeaf, path: string, context: unknown, operators: ConditionOperatorRegistry): ConditionLeafResult {
  const actual = resolveField(context, leaf.field);
  const base = { path, field: leaf.field, op: leaf.op, expected: leaf.value ?? null, actual: summarize(actual) };
  if (leaf.op !== "EXISTS" && (actual === undefined || actual === null)) {
    return { ...base, passed: false, error: "missing_field" };
  }
  const outcome = operators.require(leaf.op).evaluate(actual, leaf.value);
  return outcome.error ? { ...base, passed: outcome.passed, error: outcome.error } : { ...base, passed: outcome.passed };
}

function walk(node: ConditionNode, path: string, context: unknown, operators: ConditionOperatorRegistry, out: ConditionLeafResult[]): boolean {
  if (!isConditionGroup(node)) {
    const result = evaluateLeaf(node, path, context, operators);
    out.push(result);
    return result.passed;
  }
  const kind = "all" in node ? "all" : "any";
  const children = "all" in node ? node.all : node.any;
  const passed = children.map((child, i) => walk(child, `${path ? `${path}.` : ""}${kind}.${i}`, context, operators, out));
  return kind === "all" ? passed.every(Boolean) : passed.some(Boolean);
}

export function evaluateConditions(
  conditions: ConditionGroup | undefined,
  context: unknown,
  operators: ConditionOperatorRegistry = defaultOperators,
): ConditionEvaluation {
  if (!conditions) return { passed: true, results: [] };
  const results: ConditionLeafResult[] = [];
  const passed = walk(conditions, "", context, operators, results);
  return { passed, results };
}
