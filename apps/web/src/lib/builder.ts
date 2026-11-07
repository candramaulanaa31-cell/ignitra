import type { ConditionGroup, ConditionLeaf, ConditionOperator, FieldSpec } from "@ignitra/core";
import type { FormField } from "./forms";
import type { CatalogFields, Issue } from "./types";

/**
 * Pure builder logic (unit-tested): defaults, cleaning params before a save,
 * step ids, the flat conditions editor model, variable lists with sample
 * values, cursor insertion, and mapping server issues onto fields.
 */

export interface DraftAction {
  step_id: string;
  type: string;
  params: Record<string, unknown>;
}

export interface Draft {
  name: string;
  trigger: { type: string; params: Record<string, unknown> };
  conditions: ConditionsDraft;
  actions: DraftAction[];
  settings: { mode: "confirmed" | "fast"; max_runs_per_hour: number };
}

export interface ConditionRow {
  field: string;
  op: ConditionOperator;
  value: string;
}

/** A flat AND / OR list (the common case); nested groups stay as raw JSON. */
export type ConditionsDraft = { mode: "all" | "any"; rows: ConditionRow[] } | { mode: "json"; json: string };

export function defaultsFor(fields: readonly FormField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.defaultValue !== undefined) out[f.key] = structuredClone(f.defaultValue);
  return out;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Drops empty optional values and fields hidden by the current params (the server applies defaults). */
export function cleanParams(fields: readonly FormField[] | undefined, params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!fields) return { ...params };
  const known = new Map(fields.map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const f = known.get(key);
    if (f?.visible && !f.visible(params)) continue;
    if (isEmpty(value)) continue;
    if (Array.isArray(value)) {
      let items: unknown[];
      if (f?.widget === "list") {
        // Columns keep their positions: only trailing empty ones are dropped.
        items = [...value];
        while (items.length > 0 && isEmpty(items[items.length - 1])) items.pop();
      } else {
        items = value.filter((v) => !isEmpty(v) && !(typeof v === "object" && v !== null && "name" in v && isEmpty((v as { name: unknown }).name)));
      }
      if (items.length === 0) continue;
      out[key] = items;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function newStepId(type: string, existing: readonly string[]): string {
  const base = type.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "step";
  const start = /^[a-z]/.test(base) ? base : `s_${base}`;
  if (!existing.includes(start)) return start;
  for (let i = 2; ; i++) if (!existing.includes(`${start}_${i}`)) return `${start}_${i}`;
}

// ---- conditions ------------------------------------------------------------------

const NUMERIC = new Set(["uint", "int", "decimal", "number", "timestamp"]);

function parseScalar(raw: string, type: string | undefined): string | number | boolean {
  const v = raw.trim();
  if (type === "boolean" && (v === "true" || v === "false")) return v === "true";
  if (type && NUMERIC.has(type) && /^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return type === "number" && Number.isSafeInteger(Math.trunc(n)) && String(n) === v ? n : v; // exact decimals stay strings
  }
  return raw;
}

export function toConditions(draft: ConditionsDraft, fields: readonly FieldSpec[]): ConditionGroup | undefined | { error: string } {
  if (draft.mode === "json") {
    if (!draft.json.trim()) return undefined;
    try {
      return JSON.parse(draft.json) as ConditionGroup;
    } catch {
      return { error: "conditions JSON is not valid" };
    }
  }
  const types = new Map(fields.map((f) => [f.path, f.type]));
  const leaves: ConditionLeaf[] = draft.rows
    .filter((r) => r.field.trim() !== "")
    .map((r): ConditionLeaf => {
      const type = types.get(r.field);
      if (r.op === "EXISTS") return { field: r.field, op: r.op };
      if (r.op === "IN" || r.op === "NOT_IN") {
        return { field: r.field, op: r.op, value: r.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((s) => parseScalar(s, type)) };
      }
      return { field: r.field, op: r.op, value: parseScalar(r.value, type) };
    });
  if (leaves.length === 0) return undefined;
  return draft.mode === "all" ? { all: leaves } : { any: leaves };
}

export function fromConditions(group: unknown): ConditionsDraft {
  if (!group || typeof group !== "object") return { mode: "all", rows: [] };
  const g = group as { all?: unknown[]; any?: unknown[] };
  const list = g.all ?? g.any;
  const flat = Array.isArray(list) && list.every((n) => n && typeof n === "object" && "field" in (n as object) && "op" in (n as object));
  if (!flat) return { mode: "json", json: JSON.stringify(group, null, 2) };
  return {
    mode: g.all ? "all" : "any",
    rows: (list as ConditionLeaf[]).map((l) => ({ field: l.field, op: l.op, value: Array.isArray(l.value) ? l.value.join(", ") : l.value === undefined ? "" : String(l.value) })),
  };
}

// ---- variables ----------------------------------------------------------------------

export interface VariableItem {
  readonly path: string;
  readonly type: string;
  readonly description: string;
  readonly sample: string | null;
}

export interface VariableGroup {
  readonly title: string;
  readonly items: readonly VariableItem[];
}

export function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const preview = (v: unknown): string | null => {
  if (v === undefined) return null;
  if (v === null) return "null";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

/** Variables a template in step `stepIndex` may use: trigger fields, EARLIER steps' outputs, built-ins. */
export function variableGroups(fields: CatalogFields | undefined, actions: readonly DraftAction[], stepIndex: number, sample: Record<string, unknown> | null): VariableGroup[] {
  if (!fields) return [];
  const groups: VariableGroup[] = [
    {
      title: "Trigger",
      items: fields.trigger.filter((f) => f.type !== "object" || !fields.trigger.some((c) => c.path.startsWith(`${f.path}.`))).map((f) => ({ path: `trigger.${f.path}`, type: f.type, description: f.description, sample: sample ? preview(resolvePath(sample, f.path)) : null })),
    },
  ];
  actions.slice(0, Math.max(0, stepIndex)).forEach((a) => {
    const outputs = fields.steps[a.step_id];
    if (outputs?.length) groups.push({ title: `Step ${a.step_id}`, items: outputs.map((f) => ({ path: `steps.${a.step_id}.${f.path}`, type: f.type, description: f.description, sample: null })) });
  });
  groups.push({ title: "Built-in", items: fields.builtins.map((b) => ({ path: b, type: "string", description: builtinHelp(b), sample: null })) });
  return groups;
}

function builtinHelp(path: string): string {
  return (
    {
      "flow.id": "Flow id",
      "flow.name": "Flow name",
      "flow.version": "Flow version",
      "run.id": "Run id",
      "run.idempotency_key": "Unique key of this run (dedupe downstream)",
      "run.test": "true for TEST runs",
      now_utc: "Send time, ISO-8601 UTC",
      now_wib: "Send time in WIB",
    }[path] ?? path
  );
}

/** Inserts `snippet` over the selection; returns the new text and caret position. */
export function insertAtCursor(text: string, start: number | null, end: number | null, snippet: string): { text: string; caret: number } {
  const s = start ?? text.length;
  const e = end ?? s;
  return { text: text.slice(0, s) + snippet + text.slice(e), caret: s + snippet.length };
}

// ---- server issues ----------------------------------------------------------------------

/** Issues under `prefix` (e.g. "actions.1.params"), keyed by their first path segment after it. */
export function issuesUnder(issues: readonly Issue[], prefix: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const issue of issues) {
    if (issue.path !== prefix && !issue.path.startsWith(`${prefix}.`)) continue;
    const key = issue.path === prefix ? "" : (issue.path.slice(prefix.length + 1).split(".")[0] ?? "");
    out.set(key, [...(out.get(key) ?? []), issue.message]);
  }
  return out;
}

/** Definition the API accepts, from the draft (forms clean their params). */
export function toDefinition(
  draft: Draft,
  forms: { trigger?: readonly FormField[] | undefined; action: (type: string) => readonly FormField[] | undefined },
  triggerFields: readonly FieldSpec[],
): { definition: Record<string, unknown> } | { error: string } {
  const conditions = toConditions(draft.conditions, triggerFields);
  if (conditions && "error" in conditions) return { error: conditions.error as string };
  return {
    definition: {
      trigger: { type: draft.trigger.type, params: cleanParams(forms.trigger, draft.trigger.params) },
      ...(conditions ? { conditions } : {}),
      actions: draft.actions.map((a) => ({ step_id: a.step_id, type: a.type, params: cleanParams(forms.action(a.type), a.params) })),
      settings: draft.settings,
    },
  };
}
