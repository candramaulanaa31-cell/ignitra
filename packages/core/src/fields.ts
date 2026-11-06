import type { ConditionOperator } from "./catalog";
import { isConditionGroup, type ConditionGroup, type ConditionNode } from "./flow";

/**
 * Field catalog: what a trigger puts into its payload. Conditions reference
 * these paths (`percent_of_supply`, `token.symbol`); templates reference them
 * as `{{trigger.<path>}}`. Validating against the catalog at save time turns
 * "my flow silently never runs" into an error the user sees immediately.
 */

export const FIELD_TYPES = [
  "address",
  "hash",
  "uint",
  "int",
  "decimal",
  "number",
  "string",
  "boolean",
  "timestamp",
  "array",
  "object",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldSpec {
  readonly path: string;
  readonly type: FieldType;
  readonly description: string;
  /** May be null at runtime (e.g. token metadata the contract does not expose). */
  readonly nullable?: boolean;
}

const NUMERIC: ReadonlySet<FieldType> = new Set(["uint", "int", "decimal", "number", "timestamp"]);
const ORDERING: ReadonlySet<ConditionOperator> = new Set([">", ">=", "<", "<="]);

export function isNumericField(type: FieldType): boolean {
  return NUMERIC.has(type);
}

/** Fields every chain-sourced trigger provides (evidence + block time in WIB). */
export const CHAIN_EVIDENCE_FIELDS: readonly FieldSpec[] = [
  { path: "chain_id", type: "number", description: "Chain id (4663 = Robinhood Chain)" },
  { path: "block_number", type: "uint", description: "Block of the event" },
  { path: "block_hash", type: "hash", description: "Hash of that block" },
  { path: "block_timestamp", type: "timestamp", description: "Block time, ISO-8601 UTC", nullable: true },
  { path: "explorer_url", type: "string", description: "Explorer link for the event" },
  { path: "time.iso", type: "string", description: "Event time, ISO-8601 UTC" },
  { path: "time.date_wib", type: "string", description: "Event date in WIB, YYYY-MM-DD" },
  { path: "time.hour_wib", type: "number", description: "Hour of day in WIB, 0-23" },
  { path: "time.minute_wib", type: "number", description: "Minute of the hour in WIB, 0-59" },
  { path: "time.minutes_wib", type: "number", description: "Minutes since midnight WIB, 0-1439 (08:00 = 480)" },
  { path: "time.weekday_wib", type: "number", description: "ISO weekday in WIB, 1 = Monday … 7 = Sunday" },
];

/** Additional evidence for log-based triggers. */
export const LOG_EVIDENCE_FIELDS: readonly FieldSpec[] = [
  { path: "tx_hash", type: "hash", description: "Transaction hash" },
  { path: "tx_index", type: "uint", description: "Transaction position in the block" },
  { path: "log_index", type: "uint", description: "Log position in the block" },
  { path: "contract", type: "address", description: "Contract that emitted the event" },
  { path: "event_status", type: "string", description: "`confirmed`, or `pending` for fast-mode runs" },
];

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

function walk(node: ConditionNode, path: string, fields: ReadonlyMap<string, FieldSpec>, issues: FieldIssue[]): void {
  if (isConditionGroup(node)) {
    const kind = "all" in node ? "all" : "any";
    const children = "all" in node ? node.all : node.any;
    children.forEach((child, i) => walk(child, `${path ? `${path}.` : ""}${kind}.${i}`, fields, issues));
    return;
  }
  const spec = fields.get(node.field);
  if (!spec) {
    const near = [...fields.keys()].filter((k) => k.split(".").pop() === node.field.split(".").pop() || k.startsWith(node.field.split(".")[0] ?? ""));
    issues.push({
      path,
      message: `unknown field "${node.field}"${near.length > 0 ? ` (did you mean ${near.slice(0, 3).map((n) => `"${n}"`).join(", ")}?)` : ""}`,
    });
    return;
  }
  if (ORDERING.has(node.op) && !NUMERIC.has(spec.type)) {
    issues.push({ path, message: `"${node.op}" needs a numeric field; "${node.field}" is ${spec.type}` });
  }
  if (node.op === "CONTAINS" && spec.type !== "string" && spec.type !== "array") {
    issues.push({ path, message: `CONTAINS needs a string or array field; "${node.field}" is ${spec.type}` });
  }
}

/** Static checks of conditions against a trigger's field catalog. */
export function validateConditionFields(conditions: ConditionGroup | undefined, fields: readonly FieldSpec[]): FieldIssue[] {
  if (!conditions) return [];
  const issues: FieldIssue[] = [];
  walk(conditions, "", new Map(fields.map((f) => [f.path, f])), issues);
  return issues;
}
