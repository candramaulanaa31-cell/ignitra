"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isValidAddress } from "@ignitra/core";
import { api } from "@/lib/api";
import { insertAtCursor, type VariableGroup } from "@/lib/builder";
import type { FormField } from "@/lib/forms";
import type { AddressInfo, Connection, Grant } from "@/lib/types";
import { Field } from "../ui";

// ---- address detection (cached per address) -------------------------------------------

const detections = new Map<string, Promise<AddressInfo | null>>();

export function detectAddress(address: string): Promise<AddressInfo | null> {
  const key = address.toLowerCase();
  let hit = detections.get(key);
  if (!hit) {
    hit = api<{ data: AddressInfo }>(`/v1/chain/addresses/${address}`)
      .then((r) => r.data)
      .catch(() => {
        detections.delete(key); // retry next time
        return null;
      });
    detections.set(key, hit);
  }
  return hit;
}

export function useAddressInfo(value: unknown): AddressInfo | null | "loading" {
  const [info, setInfo] = useState<AddressInfo | null | "loading">(null);
  useEffect(() => {
    if (typeof value !== "string" || !isValidAddress(value.trim())) {
      setInfo(null);
      return;
    }
    let live = true;
    setInfo("loading");
    const t = setTimeout(() => {
      void detectAddress(value.trim()).then((r) => live && setInfo(r));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value]);
  return info;
}

function DetectionChip({ info }: { info: AddressInfo | null | "loading" }) {
  if (info === null) return null;
  if (info === "loading") return <span className="chip faint">detecting…</span>;
  const text =
    info.kind === "token" && info.token
      ? `token · ${info.token.symbol ?? "?"}${info.token.name ? ` · ${info.token.name}` : ""} · ${info.token.decimals} decimals`
      : info.kind === "contract"
        ? `contract · ABI ${info.abi?.status ?? "unknown"}${info.abi?.events.length ? ` · ${info.abi.events.length} events` : ""}`
        : "wallet (no contract code)";
  return (
    <span className={`chip ${info.kind === "wallet" ? "" : "pass"}`}>
      {text}
      <a href={info.explorer_url} target="_blank" rel="noreferrer" className="faint">
        explorer
      </a>
    </span>
  );
}

// ---- variable picker + template inputs ----------------------------------------------------

export function VariablePicker({ groups, onPick }: { groups: readonly VariableGroup[]; onPick: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const needle = q.trim().toLowerCase();
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="btn sm" onClick={() => setOpen((o) => !o)} title="Insert a variable">
        {"{x}"} Variable
      </button>
      {open ? (
        <div className="picker" role="dialog" aria-label="Variables">
          <input placeholder="Filter variables…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus className="mono" />
          {groups.length === 0 ? <div className="faint small" style={{ padding: 8 }}>Pick a trigger first.</div> : null}
          {groups.map((g) => {
            const items = g.items.filter((i) => !needle || i.path.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle));
            if (items.length === 0) return null;
            return (
              <div key={g.title}>
                <div className="group">{g.title}</div>
                <div className="stack" style={{ gap: 3 }}>
                  {items.map((i) => (
                    <button
                      key={i.path}
                      type="button"
                      className="var-btn"
                      title={i.description}
                      onClick={() => {
                        onPick(i.path);
                        setOpen(false);
                      }}
                    >
                      <span>{i.path}</span>
                      <span className="val">{i.sample ?? i.type}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function TemplateInput({
  value,
  onChange,
  groups,
  multiline = false,
  placeholder,
  invalid,
  rows,
}: {
  value: string;
  onChange: (v: string) => void;
  groups: readonly VariableGroup[];
  multiline?: boolean;
  placeholder?: string | undefined;
  invalid?: boolean | undefined;
  rows?: number;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const pick = (path: string) => {
    const el = ref.current;
    const { text, caret } = insertAtCursor(value, el?.selectionStart ?? null, el?.selectionEnd ?? null, `{{${path}}}`);
    onChange(text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };
  const common = { ref, value, placeholder, "aria-invalid": invalid ? true : undefined, onChange: (e: { target: { value: string } }) => onChange(e.target.value), className: "mono" } as const;
  return (
    <div className="tpl stack" style={{ gap: 4 }}>
      {multiline ? <textarea {...common} rows={rows ?? 4} /> : <input {...common} />}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <VariablePicker groups={groups} onPick={pick} />
      </div>
    </div>
  );
}

// ---- generic param field --------------------------------------------------------------------

const TIMEZONES = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "Asia/Tokyo", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "UTC"];

export interface FieldContext {
  readonly params: Record<string, unknown>;
  readonly set: (key: string, value: unknown) => void;
  readonly groups: readonly VariableGroup[];
  readonly connections: readonly Connection[];
  /** The user's onchain grants (ONCHAIN_TX steps pick one). */
  readonly grants: readonly Grant[];
  readonly errors: ReadonlyMap<string, string[]>;
  /** Detection results of address fields in this card, by key. */
  readonly detected: Readonly<Record<string, AddressInfo | null | "loading">>;
}

function PairsEditor({ value, onChange, groups }: { value: unknown; onChange: (v: Array<{ name: string; value: string }>) => void; groups: readonly VariableGroup[] }) {
  const rows = Array.isArray(value) ? (value as Array<{ name: string; value: string }>) : [];
  const update = (i: number, patch: Partial<{ name: string; value: string }>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ alignItems: "flex-start" }}>
          <input className="mono" style={{ width: 180 }} placeholder="Name" value={r.name} onChange={(e) => update(i, { name: e.target.value })} />
          <div className="grow">
            <TemplateInput value={r.value} onChange={(v) => update(i, { value: v })} groups={groups} placeholder="Value" />
          </div>
          <button type="button" className="btn sm ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove">
            ×
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn sm" onClick={() => onChange([...rows, { name: "", value: "" }])}>
          + Add
        </button>
      </div>
    </div>
  );
}

function ListEditor({ value, onChange, groups, placeholder }: { value: unknown; onChange: (v: string[]) => void; groups: readonly VariableGroup[]; placeholder: string }) {
  const rows = Array.isArray(value) ? (value as unknown[]).map((v) => (typeof v === "string" ? v : String(v))) : [];
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ alignItems: "flex-start" }}>
          <span className="step-num" style={{ paddingTop: 6, width: 22 }}>
            {placeholder === "Column" ? String.fromCharCode(65 + (i % 26)) : i + 1}
          </span>
          <div className="grow">
            <TemplateInput value={r} onChange={(v) => onChange(rows.map((x, j) => (j === i ? v : x)))} groups={groups} placeholder={placeholder} />
          </div>
          <button type="button" className="btn sm ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove">
            ×
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn sm" onClick={() => onChange([...rows, ""])}>
          + Add {placeholder.toLowerCase()}
        </button>
      </div>
    </div>
  );
}

/** Plain values, one per row (no variables): rule ids, contract addresses. */
function StringsEditor({ value, onChange, placeholder }: { value: unknown; onChange: (v: string[] | undefined) => void; placeholder: string | undefined }) {
  const rows = Array.isArray(value) ? (value as unknown[]).map(String) : [];
  // An empty list means "no filter": the key is left out rather than sent empty.
  const commit = (next: string[]) => onChange(next.length > 0 ? next : undefined);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} className="row">
          <input className="mono grow" value={r} placeholder={placeholder} onChange={(e) => commit(rows.map((x, j) => (j === i ? e.target.value.trim() : x)))} spellCheck={false} />
          <button type="button" className="btn sm ghost" onClick={() => commit(rows.filter((_, j) => j !== i))} aria-label="Remove">
            ×
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn sm" onClick={() => onChange([...rows, ""])}>
          + Add
        </button>
      </div>
    </div>
  );
}

const GRANT_STATUS_NOTE: Readonly<Record<string, string>> = { pending: " (approve it on the Safe first)", revoked: " (revoked)", expired: " (expired)" };

/** Event / function signature: a select from the detected ABI, or free text. */
function SignaturePicker({ value, onChange, options, placeholder, invalid }: { value: string; onChange: (v: string) => void; options: readonly string[]; placeholder: string | undefined; invalid: boolean }) {
  const listId = useRef(`sig-${Math.random().toString(36).slice(2)}`).current;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {options.length > 0 ? (
        <select value={options.includes(value) ? value : ""} onChange={(e) => onChange(e.target.value)} className="mono">
          <option value="">{`Pick one of ${options.length} from the ABI…`}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : null}
      <input className="mono" list={listId} value={value} placeholder={placeholder} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}

export function ParamField({ field, ctx }: { field: FormField; ctx: FieldContext }) {
  if (field.visible && !field.visible(ctx.params)) return null;
  const value = ctx.params[field.key];
  const errors = ctx.errors.get(field.key);
  const invalid = Boolean(errors?.length);
  const set = (v: unknown) => ctx.set(field.key, v);
  const str = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  let input: ReactNode;

  switch (field.widget) {
    case "address":
      input = (
        <div className="stack" style={{ gap: 4 }}>
          <input className="mono" value={str} placeholder={field.placeholder} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value.trim())} spellCheck={false} />
          <DetectionChip info={ctx.detected[field.key] ?? null} />
        </div>
      );
      break;
    case "address-or-template":
      input = (
        <div className="stack" style={{ gap: 4 }}>
          <TemplateInput value={str} onChange={(v) => set(v.trim())} groups={ctx.groups} placeholder={field.placeholder} invalid={invalid} />
          <DetectionChip info={ctx.detected[field.key] ?? null} />
        </div>
      );
      break;
    case "select":
      input = (
        <select value={str || String(field.defaultValue ?? "")} onChange={(e) => set(e.target.value)} aria-invalid={invalid || undefined}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case "bool":
      return (
        <label className="check">
          <input type="checkbox" checked={value === undefined ? Boolean(field.defaultValue) : Boolean(value)} onChange={(e) => set(e.target.checked)} />
          {field.label}
        </label>
      );
    case "template":
      input = <TemplateInput value={str} onChange={set} groups={ctx.groups} placeholder={field.placeholder} invalid={invalid} />;
      break;
    case "template-area":
    case "json-template":
      input = <TemplateInput value={str} onChange={set} groups={ctx.groups} placeholder={field.placeholder} invalid={invalid} multiline rows={field.widget === "json-template" ? 6 : 4} />;
      break;
    case "timezone":
      input = (
        <>
          <input list="tz-list" value={str || String(field.defaultValue ?? "")} onChange={(e) => set(e.target.value)} aria-invalid={invalid || undefined} />
          <datalist id="tz-list">
            {TIMEZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </>
      );
      break;
    case "connection": {
      const options = ctx.connections.filter((c) => c.type === field.connectionType);
      input = (
        <div className="stack" style={{ gap: 4 }}>
          <select value={str} onChange={(e) => set(e.target.value)} aria-invalid={invalid || undefined}>
            <option value="">{options.length === 0 ? `No ${field.connectionType} connection yet` : field.optional ? "None" : "Choose…"}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id} disabled={c.metadata.verified === false}>
                {c.label}
                {c.metadata.verified === false ? " (not verified)" : ""}
              </option>
            ))}
          </select>
          {options.length === 0 ? (
            <a href="/app/connections" target="_blank" rel="noreferrer" className="small">
              Add one in Connections ↗
            </a>
          ) : null}
        </div>
      );
      break;
    }
    case "event":
    case "function": {
      const source = field.source ? ctx.detected[field.source] : null;
      const abi = source && source !== "loading" ? source.abi : null;
      input = <SignaturePicker value={str} onChange={set} options={field.widget === "event" ? (abi?.events ?? []) : (abi?.functions ?? [])} placeholder={field.placeholder} invalid={invalid} />;
      break;
    }
    case "args":
      input = <ListEditor value={value} onChange={set} groups={ctx.groups} placeholder="Argument" />;
      break;
    case "strings":
      input = <StringsEditor value={value} onChange={set} placeholder={field.placeholder} />;
      break;
    case "grant": {
      const usable = ctx.grants.filter((g) => g.status !== "revoked" && g.status !== "expired");
      input = (
        <div className="stack" style={{ gap: 4 }}>
          <select
            value={str}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              const next = ctx.grants.find((g) => g.id === e.target.value);
              set(e.target.value);
              // A contract the new grant does not cover cannot stay picked.
              if (!next?.scope.targets.some((t) => t.address === ctx.params.to)) {
                ctx.set("to", "");
                ctx.set("function", "");
              }
            }}
          >
            <option value="">{usable.length === 0 ? "No grant yet" : "Choose…"}</option>
            {ctx.grants.map((g) => (
              <option key={g.id} value={g.id} disabled={g.status === "revoked" || g.status === "expired"}>
                {g.label} · Safe {g.safe.slice(0, 8)}…{GRANT_STATUS_NOTE[g.status] ?? ""}
              </option>
            ))}
          </select>
          <a href="/app/onchain" target="_blank" rel="noreferrer" className="small">
            {usable.length === 0 ? "Create one in Onchain ↗" : "Manage grants ↗"}
          </a>
        </div>
      );
      break;
    }
    case "grant-target": {
      const grant = ctx.grants.find((g) => g.id === ctx.params.grant_id);
      input = (
        <select
          className="mono"
          value={str}
          aria-invalid={invalid || undefined}
          disabled={!grant}
          onChange={(e) => {
            set(e.target.value);
            ctx.set("function", "");
          }}
        >
          <option value="">{grant ? "Choose a contract in the grant…" : "Choose a grant first"}</option>
          {grant?.scope.targets.map((t) => (
            <option key={t.address} value={t.address}>
              {t.address} ({t.functions.length} function{t.functions.length === 1 ? "" : "s"})
            </option>
          ))}
        </select>
      );
      break;
    }
    case "grant-function": {
      const grant = ctx.grants.find((g) => g.id === ctx.params.grant_id);
      const target = grant?.scope.targets.find((t) => t.address === ctx.params.to);
      const picked = target?.functions.find((f) => f.signature === str);
      input = (
        <div className="stack" style={{ gap: 4 }}>
          <select
            className="mono"
            value={str}
            aria-invalid={invalid || undefined}
            disabled={!target}
            onChange={(e) => {
              set(e.target.value);
              const fn = target?.functions.find((f) => f.signature === e.target.value);
              if (!fn) return;
              // One argument per parameter, keeping what was typed.
              const args = Array.isArray(ctx.params.args) ? (ctx.params.args as unknown[]).map(String) : [];
              ctx.set("args", fn.inputs.map((_, i) => args[i] ?? ""));
            }}
          >
            <option value="">{target ? "Choose a function…" : "Choose a contract first"}</option>
            {target?.functions.map((f) => (
              <option key={f.selector} value={f.signature}>
                {f.signature}
              </option>
            ))}
          </select>
          {picked ? (
            <span className="small muted">
              {picked.inputs.length === 0 ? "No arguments." : `Arguments: ${picked.inputs.map((t, i) => `${i + 1}. ${t}`).join(" · ")}.`}
              {picked.amount ? ` Argument ${picked.amount.arg + 1} is capped at ${picked.amount.max_per_tx} per call and ${picked.amount.max_per_day} per day (base units).` : ""}
              {picked.payable ? "" : " Sends no ETH."}
            </span>
          ) : null}
        </div>
      );
      break;
    }
    case "list":
      input = <ListEditor value={value} onChange={set} groups={ctx.groups} placeholder="Column" />;
      break;
    case "pairs":
      input = <PairsEditor value={value} onChange={set} groups={ctx.groups} />;
      break;
    case "decimal":
    case "number":
      input = <input className="mono" inputMode="decimal" value={str} placeholder={field.placeholder} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value.trim())} />;
      break;
    default:
      input = <input className={field.widget === "cron" ? "mono" : undefined} value={str} placeholder={field.placeholder} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value)} spellCheck={false} />;
  }

  return (
    <Field name={`${field.label}${field.optional ? " (optional)" : ""}`} help={field.help} error={errors}>
      {input}
    </Field>
  );
}
