"use client";

import { useMemo } from "react";
import { CONDITION_OPERATORS, evaluateConditions, type ConditionGroup, type ConditionOperator, type FieldSpec } from "@ignitra/core";
import { fromConditions, toConditions, type ConditionsDraft } from "@/lib/builder";

const OP_LABELS: Record<ConditionOperator, string> = {
  "==": "equals",
  "!=": "is not",
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  IN: "is one of",
  NOT_IN: "is none of",
  CONTAINS: "contains",
  EXISTS: "exists",
};

/**
 * Flat AND / OR list of conditions; each row shows the sample's actual value
 * and whether it passes (evaluated in the browser with the same pure evaluator
 * the matcher uses). Nested groups are edited as JSON.
 */
export function ConditionsEditor({
  draft,
  onChange,
  fields,
  sample,
  errors,
}: {
  draft: ConditionsDraft;
  onChange: (d: ConditionsDraft) => void;
  fields: readonly FieldSpec[];
  sample: Record<string, unknown> | null;
  errors: ReadonlyMap<string, string[]>;
}) {
  const listId = "condition-fields";
  const leafFields = useMemo(() => fields.filter((f) => f.type !== "object" || !fields.some((c) => c.path.startsWith(`${f.path}.`))), [fields]);
  const evaluation = useMemo(() => {
    if (!sample) return null;
    const group = toConditions(draft, fields);
    if (!group || "error" in group) return null;
    try {
      return evaluateConditions(group as ConditionGroup, sample);
    } catch {
      return null;
    }
  }, [draft, fields, sample]);

  if (draft.mode === "json") {
    return (
      <div className="stack">
        <p className="small muted">Nested groups are edited as JSON: {"{ \"all\": [ … , { \"any\": [ … ] } ] }"}.</p>
        <textarea className="mono" rows={8} value={draft.json} onChange={(e) => onChange({ mode: "json", json: e.target.value })} />
        <div>
          <button type="button" className="btn sm" onClick={() => onChange(fromConditions(safeParse(draft.json)))}>
            Back to the simple editor
          </button>
        </div>
      </div>
    );
  }

  const rows = draft.rows;
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) => onChange({ ...draft, rows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const general = [...(errors.get("") ?? []), ...(errors.get("all") ?? []), ...(errors.get("any") ?? [])];

  return (
    <div className="stack">
      {rows.length > 1 ? (
        <div className="row small">
          Run when
          <select value={draft.mode} onChange={(e) => onChange({ ...draft, mode: e.target.value as "all" | "any" })} style={{ width: "auto" }}>
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          of these hold:
        </div>
      ) : null}
      {rows.length === 0 ? <p className="small muted">No conditions: every trigger occurrence runs the actions.</p> : null}
      {rows.map((r, i) => {
        const result = evaluation?.results[i];
        const spec = fields.find((f) => f.path === r.field);
        return (
          <div key={i} className="stack" style={{ gap: 4 }}>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <input className="mono grow" style={{ minWidth: 180 }} list={listId} placeholder="field, e.g. amount_decimal" value={r.field} onChange={(e) => setRow(i, { field: e.target.value.trim() })} />
              <select value={r.op} onChange={(e) => setRow(i, { op: e.target.value as ConditionOperator })} style={{ width: "auto" }}>
                {CONDITION_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </select>
              {r.op === "EXISTS" ? null : (
                <input className="mono grow" style={{ minWidth: 140 }} placeholder={r.op === "IN" || r.op === "NOT_IN" ? "a, b, c" : "value"} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
              )}
              <button type="button" className="btn sm ghost" onClick={() => onChange({ ...draft, rows: rows.filter((_, j) => j !== i) })} aria-label="Remove condition">
                ×
              </button>
            </div>
            <div className="small row" style={{ gap: 12 }}>
              {spec ? <span className="faint">{spec.type} · {spec.description}</span> : r.field ? <span className="faint">custom path</span> : null}
              {result ? (
                <span className={result.passed ? "pass" : "failc"}>
                  {result.passed ? "✓ passes" : `✗ fails${result.error ? ` (${result.error.replace("_", " ")})` : ""}`} with the sample: {JSON.stringify(result.actual) ?? "missing"}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      <datalist id={listId}>
        {leafFields.map((f) => (
          <option key={f.path} value={f.path}>
            {f.description}
          </option>
        ))}
      </datalist>
      {general.map((e) => (
        <span key={e} className="small failc">
          {e}
        </span>
      ))}
      <div className="row">
        <button type="button" className="btn sm" onClick={() => onChange({ ...draft, rows: [...rows, { field: "", op: ">=", value: "" }] })}>
          + Add condition
        </button>
        <button type="button" className="linkish small" onClick={() => onChange({ mode: "json", json: JSON.stringify(toConditions(draft, fields) ?? { all: [] }, null, 2) })}>
          edit as JSON (nested AND / OR)
        </button>
        {evaluation ? <span className={`small ${evaluation.passed ? "pass" : "failc"}`}>{evaluation.passed ? "The sample would run." : "The sample would NOT run."}</span> : null}
      </div>
    </div>
  );
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
