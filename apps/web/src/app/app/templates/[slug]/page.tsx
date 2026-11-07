"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState, type FormEvent } from "react";
import { useAddressInfo } from "@/components/builder/fields";
import { useSession } from "@/components/session";
import { Field, Notice, Spinner } from "@/components/ui";
import { ApiError, api, errorText, useApi } from "@/lib/api";
import { CONNECTION_LABELS } from "@/lib/forms";
import type { Connection } from "@/lib/types";
import type { TemplateDetail } from "@/lib/template-types";
import type { TemplatePlaceholder } from "@ignitra/core";

const RANK = { free: 0, builder: 1, team: 2 } as const;

function AddressInput({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid: boolean }) {
  const info = useAddressInfo(value);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <input className="mono" value={value} placeholder="0x…" aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value.trim())} spellCheck={false} />
      {info === "loading" ? <span className="chip faint">detecting…</span> : null}
      {info && info !== "loading" ? (
        <span className={`chip ${info.kind === "wallet" ? "" : "pass"}`}>
          {info.kind === "token" && info.token ? `token · ${info.token.symbol ?? "?"} · ${info.token.name ?? ""}` : info.kind === "contract" ? "contract" : "wallet"}
        </span>
      ) : null}
    </div>
  );
}

function PlaceholderField({ p, value, set, connections, errors, reload }: { p: TemplatePlaceholder; value: string; set: (v: string) => void; connections: Connection[]; errors: string[]; reload: () => void }) {
  const invalid = errors.length > 0;
  let input;
  switch (p.type) {
    case "address":
      input = <AddressInput value={value} onChange={set} invalid={invalid} />;
      break;
    case "connection": {
      const options = connections.filter((c) => c.type === p.connectionType && c.metadata.verified !== false);
      input = (
        <div className="stack" style={{ gap: 4 }}>
          <select value={value} onChange={(e) => set(e.target.value)} aria-invalid={invalid || undefined}>
            <option value="">{options.length ? "Choose…" : `No ${CONNECTION_LABELS[p.connectionType ?? ""] ?? p.connectionType} yet`}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="small">
            <a href="/app/connections" target="_blank" rel="noreferrer">
              Add one
            </a>{" "}
            ·{" "}
            <button type="button" className="linkish small" onClick={reload}>
              refresh
            </button>
          </span>
        </div>
      );
      break;
    }
    case "select":
      input = (
        <select value={value} onChange={(e) => set(e.target.value)}>
          {p.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    default:
      input = (
        <input
          className={p.type === "text" ? undefined : "mono"}
          inputMode={p.type === "decimal" || p.type === "number" ? "decimal" : undefined}
          value={value}
          placeholder={p.type === "url" ? "https://…" : p.type === "spreadsheet" ? "https://docs.google.com/spreadsheets/d/…" : String(p.default ?? "")}
          aria-invalid={invalid || undefined}
          onChange={(e) => set(e.target.value)}
        />
      );
  }
  return (
    <Field name={`${p.label}${p.optional ? " (optional)" : ""}`} help={p.help} error={errors.length ? errors : undefined}>
      {input}
    </Field>
  );
}

export default function UseTemplatePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const { me } = useSession();
  const t = useApi<{ data: TemplateDetail }>(`/v1/templates/${slug}`);
  const conns = useApi<{ data: Connection[] }>("/v1/connections");
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  if (t.error) return <Notice kind="error">{t.error.message}</Notice>;
  if (!t.data) return <Spinner />;
  const tpl = t.data.data;
  const current = values ?? Object.fromEntries(tpl.placeholders.map((p) => [p.key, p.default === undefined ? "" : String(p.default)]));
  const locked = RANK[tpl.min_plan] > RANK[me.plan];
  const issues = error instanceof ApiError ? error.issues : [];
  const fieldErrors = (key: string) => issues.filter((i) => i.path === `values.${key}`).map((i) => i.message.replace(/^[^:]+: /, ""));
  const other = issues.filter((i) => !i.path.startsWith("values."));

  const submit = async (e: FormEvent, activate: boolean) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ data: { flow_id: string } }>(`/v1/templates/${slug}/instantiate`, { body: { values: current, name: (name ?? tpl.name).trim() || tpl.name, activate } });
      router.push(`/app/flows/${res.data.flow_id}`);
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  };

  return (
    <main className="stack" style={{ maxWidth: 720 }}>
      <div className="small muted">
        <Link href={`/templates/${slug}`}>← {tpl.name}</Link>
      </div>
      <h1>Use “{tpl.name}”</h1>
      <p className="muted">{tpl.summary}</p>
      {locked ? <Notice kind="warn">This template needs the {tpl.min_plan} plan; you are on {me.plan}.</Notice> : null}
      <form className="card" onSubmit={(e) => void submit(e, true)}>
        <div className="card-body stack">
          {tpl.placeholders.map((p) => (
            <PlaceholderField
              key={p.key}
              p={p}
              value={current[p.key] ?? ""}
              set={(v) => setValues({ ...current, [p.key]: v })}
              connections={conns.data?.data ?? []}
              errors={fieldErrors(p.key)}
              reload={() => void conns.reload()}
            />
          ))}
          <Field name="Flow name">
            <input value={name ?? tpl.name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {error && !(error instanceof ApiError && error.code === "invalid_values") ? (
            <Notice kind="error">
              {other.length ? (
                <ul>
                  {other.map((i) => (
                    <li key={i.path + i.message}>
                      <span className="mono">{i.path}</span>: {i.message}
                    </li>
                  ))}
                </ul>
              ) : (
                errorText(error)
              )}
            </Notice>
          ) : null}
          <div className="row">
            <button type="submit" className="btn primary" disabled={busy || locked}>
              {busy ? "Creating…" : "Create & activate"}
            </button>
            <button type="button" className="btn" disabled={busy || locked} onClick={(e) => void submit(e, false)}>
              Create as a draft
            </button>
            <span className="small faint">A draft lets you run “Test flow” before activating.</span>
          </div>
        </div>
      </form>
    </main>
  );
}
