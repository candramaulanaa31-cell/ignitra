"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { isValidAddress } from "@ignitra/core";
import { ApiError, api, errorText, useApi } from "@/lib/api";
import { defaultsFor, fromConditions, issuesUnder, newStepId, toConditions, toDefinition, variableGroups, type Draft, type DraftAction } from "@/lib/builder";
import { ACTION_FORMS, TRIGGER_FORMS, type FormField } from "@/lib/forms";
import { FINAL, label } from "@/lib/format";
import type { ActionCatalogItem, AddressInfo, CatalogFields, Connection, FlowDetail, Issue, RunDetail, Sample, TriggerCatalogItem } from "@/lib/types";
import { RunTrace } from "../run-trace";
import { useSession } from "../session";
import { CopyButton, Json, Notice, Spinner, useToast } from "../ui";
import { ConditionsEditor } from "./conditions";
import { ParamField, detectAddress, type FieldContext } from "./fields";
import { SamplePanel } from "./sample";

const PLAN_RANK = { free: 0, builder: 1, team: 2 } as const;
const SOURCES: Array<[string, string]> = [
  ["chain", "On Robinhood Chain"],
  ["schedule", "On a schedule"],
  ["inbound", "From your systems"],
];

function emptyDraft(): Draft {
  return {
    name: "",
    trigger: { type: "TOKEN_TRANSFER", params: defaultsFor(TRIGGER_FORMS.TOKEN_TRANSFER ?? []) },
    conditions: { mode: "all", rows: [] },
    actions: [],
    settings: { mode: "confirmed", max_runs_per_hour: 60 },
  };
}

function fromFlow(flow: FlowDetail): Draft {
  const d = flow.definition;
  return {
    name: flow.name,
    trigger: { type: d.trigger.type, params: { ...d.trigger.params } },
    conditions: fromConditions(d.conditions),
    actions: d.actions.map((a) => ({ step_id: a.step_id, type: a.type, params: structuredClone(a.params) })),
    settings: { ...d.settings },
  };
}

/** Detection for every address-looking value of a card (one hook for a variable set of fields). */
function useDetections(values: Record<string, unknown>): Record<string, AddressInfo | null | "loading"> {
  const [out, setOut] = useState<Record<string, AddressInfo | null | "loading">>({});
  const key = JSON.stringify(values);
  useEffect(() => {
    let live = true;
    const entries = Object.entries(JSON.parse(key) as Record<string, unknown>);
    const next: Record<string, AddressInfo | null | "loading"> = {};
    const pending: Array<[string, string]> = [];
    for (const [k, v] of entries) {
      if (typeof v === "string" && isValidAddress(v.trim())) {
        next[k] = "loading";
        pending.push([k, v.trim()]);
      } else next[k] = null;
    }
    setOut(next);
    const t = setTimeout(() => {
      for (const [k, address] of pending) void detectAddress(address).then((info) => live && setOut((o) => ({ ...o, [k]: info })));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  return out;
}

function addressValues(fields: readonly FormField[] | undefined, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) if (f.widget === "address" || f.widget === "address-or-template") out[f.key] = params[f.key];
  return out;
}

function TriggerFields({ type, params, set, ctx }: { type: string; params: Record<string, unknown>; set: (k: string, v: unknown) => void; ctx: Omit<FieldContext, "params" | "set" | "detected"> }) {
  const form = TRIGGER_FORMS[type];
  const detected = useDetections(addressValues(form, params));
  if (!form) return <RawParams params={params} onChange={(p) => Object.entries(p).forEach(([k, v]) => set(k, v))} />;
  return (
    <div className="grid2">
      {form.map((f) => (
        <div key={f.key} style={f.widget === "event" || f.widget === "function" || f.widget === "args" ? { gridColumn: "1 / -1" } : undefined}>
          <ParamField field={f} ctx={{ ...ctx, params, set, detected }} />
        </div>
      ))}
    </div>
  );
}

function ActionFields({ action, set, ctx }: { action: DraftAction; set: (k: string, v: unknown) => void; ctx: Omit<FieldContext, "params" | "set" | "detected"> }) {
  const form = ACTION_FORMS[action.type];
  const detected = useDetections(addressValues(form, action.params));
  if (!form) return <RawParams params={action.params} onChange={(p) => Object.entries(p).forEach(([k, v]) => set(k, v))} />;
  return (
    <div className="stack">
      {form.map((f) => (
        <ParamField key={f.key} field={f} ctx={{ ...ctx, params: action.params, set, detected }} />
      ))}
    </div>
  );
}

function RawParams({ params, onChange }: { params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const [text, setText] = useState(JSON.stringify(params, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <label className="field">
      <span className="name">Params (JSON)</span>
      <textarea
        className="mono"
        rows={6}
        value={text}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value) as Record<string, unknown>);
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
    </label>
  );
}

function TestRunPanel({ runId, tz }: { runId: string; tz: string }) {
  const run = useApi<{ data: RunDetail }>(`/v1/runs/${runId}`, { pollMs: 1000, poll: (r) => !FINAL.has(r.data.status) });
  if (!run.data) return <Spinner label="Starting the test run…" />;
  return <RunTrace run={run.data.data} tz={tz} compact />;
}

export function Builder({ initial }: { initial?: FlowDetail }) {
  const router = useRouter();
  const { me } = useSession();
  const [toast, notify] = useToast();
  const triggers = useApi<{ data: TriggerCatalogItem[] }>("/v1/triggers");
  const actions = useApi<{ data: ActionCatalogItem[] }>("/v1/actions");
  const connections = useApi<{ data: Connection[] }>("/v1/connections");

  const [flowId, setFlowId] = useState<string | null>(initial?.id ?? null);
  const [status, setStatus] = useState(initial?.status ?? "paused");
  const [hookUrl, setHookUrl] = useState<string | null>(initial?.hook_url ?? null);
  const [draft, setDraft] = useState<Draft>(() => (initial ? fromFlow(initial) : emptyDraft()));
  const [dirty, setDirty] = useState(!initial);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "draft" | "activate" | "test">(null);
  const [sample, setSample] = useState<Sample | null>(null);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [fields, setFields] = useState<CatalogFields | undefined>(undefined);

  const triggerItem = triggers.data?.data.find((t) => t.type === draft.trigger.type);
  const locked = (minPlan: keyof typeof PLAN_RANK) => PLAN_RANK[minPlan] > PLAN_RANK[me.plan];

  // Variables for the picker: trigger fields + each step's outputs (debounced).
  const fieldsKey = JSON.stringify({ trigger: draft.trigger, actions: draft.actions.map((a) => ({ step_id: a.step_id, type: a.type, params: a.params })) });
  useEffect(() => {
    const t = setTimeout(() => {
      void api<{ data: CatalogFields }>("/v1/catalog/fields", { body: JSON.parse(fieldsKey) as unknown })
        .then((r) => setFields(r.data))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [fieldsKey]);

  const update = (fn: (d: Draft) => Draft) => {
    setDraft(fn);
    setDirty(true);
    setIssues([]);
    setError(null);
  };
  const setTriggerParam = (k: string, v: unknown) => update((d) => ({ ...d, trigger: { ...d.trigger, params: { ...d.trigger.params, [k]: v } } }));
  const setActionParam = (i: number) => (k: string, v: unknown) => update((d) => ({ ...d, actions: d.actions.map((a, j) => (j === i ? { ...a, params: { ...a.params, [k]: v } } : a)) }));
  const moveAction = (i: number, delta: number) =>
    update((d) => {
      const next = [...d.actions];
      const [item] = next.splice(i, 1);
      if (item) next.splice(Math.max(0, Math.min(next.length, i + delta)), 0, item);
      return { ...d, actions: next };
    });
  const addAction = (type: string) => update((d) => ({ ...d, actions: [...d.actions, { step_id: newStepId(type, d.actions.map((a) => a.step_id)), type, params: defaultsFor(ACTION_FORMS[type] ?? []) }] }));

  const triggerFields = fields?.trigger ?? triggerItem?.fields ?? [];
  const definitionConditions = useMemo(() => {
    const c = toConditions(draft.conditions, triggerFields);
    return c && !("error" in c) ? c : undefined;
  }, [draft.conditions, triggerFields]);

  const forms = { trigger: TRIGGER_FORMS[draft.trigger.type], action: (type: string) => ACTION_FORMS[type] };

  async function save(mode: "draft" | "activate" | "test"): Promise<string | null> {
    const built = toDefinition(draft, forms, triggerFields);
    if ("error" in built) {
      setError(built.error);
      return null;
    }
    if (draft.actions.length === 0) {
      setError("add at least one action");
      return null;
    }
    setBusy(mode);
    setError(null);
    try {
      let id = flowId;
      if (!id) {
        const res = await api<{ data: FlowDetail }>("/v1/flows", { body: { name: draft.name.trim() || "Untitled flow", definition: built.definition, activate: mode === "activate" } });
        id = res.data.id;
        setFlowId(id);
        setHookUrl(res.data.hook_url ?? null);
        setStatus(res.data.status);
        window.history.replaceState(null, "", `/app/flows/${id}/edit`);
      } else {
        if (dirty) {
          const res = await api<{ data: FlowDetail }>(`/v1/flows/${id}`, { method: "PATCH", body: { name: draft.name.trim() || "Untitled flow", definition: built.definition } });
          setHookUrl(res.data.hook_url ?? null);
        }
        if (mode === "activate" && status !== "active") {
          const res = await api<{ data: FlowDetail }>(`/v1/flows/${id}/resume`, { method: "POST" });
          setStatus(res.data.status);
        }
      }
      setDirty(false);
      setIssues([]);
      return id;
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) setIssues(err.issues);
      setError(errorText(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    const id = await save("test");
    if (!id) return;
    setBusy("test");
    try {
      const res = await api<{ data: { run: { id: string }; conditions_passed: boolean; sample: { kind: string; note: string } } }>(`/v1/flows/${id}/test`, { body: sample ? { sample: sample.payload } : {} });
      setTestRunId(res.data.run.id);
      notify(res.data.conditions_passed ? "Test run started." : "Test run started. Note: the conditions FAIL for this sample, so a real event like it would not run.", res.data.conditions_passed ? "ok" : "info");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const triggerIssues = issuesUnder(issues, "trigger.params");
  const ctxBase = (stepIndex: number) => ({
    groups: variableGroups(fields, draft.actions, stepIndex, sample?.payload ?? null),
    connections: connections.data?.data ?? [],
    errors: new Map<string, string[]>(),
  });

  if (triggers.loading || actions.loading) return <Spinner />;

  return (
    <div className="stack" style={{ gap: 0 }}>
      {toast}
      <div className="page-head">
        <div className="grow" style={{ maxWidth: 560 }}>
          <input aria-label="Flow name" placeholder="Name this flow, e.g. Big USDG buys → Telegram" value={draft.name} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} style={{ fontSize: 16, fontWeight: 600 }} />
          <div className="sub small">
            {flowId ? (
              <>
                {status} · {dirty ? "unsaved changes" : "saved"} ·{" "}
                <a href={`/app/flows/${flowId}`} className="faint">
                  open flow
                </a>
              </>
            ) : (
              "new flow · nothing saved yet"
            )}
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={() => void test()} disabled={busy !== null} title="Save as a draft and run the actions once with the sample (marked TEST)">
            {busy === "test" ? "Testing…" : "Test flow"}
          </button>
          <button type="button" className="btn" onClick={() => void save("draft").then((id) => id && notify("Saved."))} disabled={busy !== null}>
            {busy === "draft" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null}
            onClick={() =>
              void save("activate").then((id) => {
                if (id) router.push(`/app/flows/${id}`);
              })
            }
          >
            {busy === "activate" ? "Activating…" : status === "active" ? "Save" : "Save & activate"}
          </button>
        </div>
      </div>

      {error ? (
        <Notice kind="error">
          {error}
          {issues.length > 1 ? (
            <ul>
              {issues.map((i) => (
                <li key={`${i.path}:${i.message}`}>
                  <span className="mono">{i.path || "flow"}</span>: {i.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}

      {/* ---- trigger ---- */}
      <section className="card" style={{ marginTop: 12 }}>
        <div className="card-head">
          <span className="label">Trigger</span>
          <span className="small muted">{triggerItem?.description}</span>
        </div>
        <div className="card-body stack">
          <label className="field">
            <span className="name">When</span>
            <select
              value={draft.trigger.type}
              onChange={(e) => {
                const type = e.target.value;
                setSample(null);
                update((d) => ({ ...d, trigger: { type, params: defaultsFor(TRIGGER_FORMS[type] ?? []) }, conditions: { mode: "all", rows: [] } }));
              }}
            >
              {SOURCES.map(([source, name]) => (
                <optgroup key={source} label={name}>
                  {triggers.data?.data
                    .filter((t) => t.source === source)
                    .map((t) => (
                      <option key={t.type} value={t.type} disabled={locked(t.min_plan)}>
                        {t.label}
                        {locked(t.min_plan) ? ` (${t.min_plan} plan)` : ""}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            {issuesUnder(issues, "trigger.type").get("")?.map((m) => (
              <span key={m} className="err small">
                {m}
              </span>
            ))}
          </label>
          <TriggerFields key={draft.trigger.type} type={draft.trigger.type} params={draft.trigger.params} set={setTriggerParam} ctx={{ ...ctxBase(0), errors: triggerIssues }} />
          {draft.trigger.type === "INBOUND_WEBHOOK" ? (
            hookUrl ? (
              <div className="stack" style={{ gap: 4 }}>
                <span className="small muted">POST to this URL to run the flow (keep it secret; rotate it from the flow page):</span>
                <div className="row">
                  <code className="grow ellipsis">{hookUrl}</code>
                  <CopyButton value={hookUrl} />
                </div>
              </div>
            ) : (
              <Notice>Save the flow to get its own signed URL.</Notice>
            )
          ) : null}
          <SamplePanel trigger={draft.trigger} kind={triggerItem?.kind} conditions={definitionConditions} flowId={flowId} sample={sample} onSample={setSample} />
        </div>
      </section>
      <div className="connector" />

      {/* ---- conditions ---- */}
      <section className="card">
        <div className="card-head">
          <span className="label">Conditions</span>
          <span className="small muted">optional filters on the trigger data</span>
        </div>
        <div className="card-body">
          <ConditionsEditor draft={draft.conditions} onChange={(c) => update((d) => ({ ...d, conditions: c }))} fields={triggerFields} sample={sample?.payload ?? null} errors={issuesUnder(issues, "conditions")} />
        </div>
      </section>

      {/* ---- actions ---- */}
      {draft.actions.map((a, i) => {
        const item = actions.data?.data.find((x) => x.type === a.type);
        const errs = issuesUnder(issues, `actions.${i}.params`);
        const typeErrs = [...(issuesUnder(issues, `actions.${i}.type`).get("") ?? []), ...(errs.get("") ?? [])];
        return (
          <div key={`${a.step_id}-${i}`}>
            <div className="connector" />
            <section className="card">
              <div className="card-head">
                <span className="row">
                  <span className="step-num">{i + 1}</span>
                  <span className="label">{label(a.type)}</span>
                  <span className="mono small faint" title="Later steps use its output as {{steps.<id>.…}}">
                    {a.step_id}
                  </span>
                </span>
                <span className="row">
                  <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => moveAction(i, -1)} aria-label="Move up">
                    ↑
                  </button>
                  <button type="button" className="btn sm ghost" disabled={i === draft.actions.length - 1} onClick={() => moveAction(i, 1)} aria-label="Move down">
                    ↓
                  </button>
                  <button type="button" className="btn sm ghost danger" onClick={() => update((d) => ({ ...d, actions: d.actions.filter((_, j) => j !== i) }))}>
                    Remove
                  </button>
                </span>
              </div>
              <div className="card-body stack">
                {item ? <p className="small muted">{item.description}</p> : null}
                {typeErrs.map((m) => (
                  <Notice key={m} kind="error">
                    {m}
                  </Notice>
                ))}
                <ActionFields action={a} set={setActionParam(i)} ctx={{ ...ctxBase(i), errors: errs }} />
              </div>
            </section>
          </div>
        );
      })}
      <div className="connector" />
      <section className="card">
        <div className="card-head">
          <span className="label">Add an action</span>
          <span className="small muted">actions run in order; later ones can use earlier outputs</span>
        </div>
        <div className="card-body row">
          {actions.data?.data.map((a) => (
            <button key={a.type} type="button" className="btn sm" onClick={() => addAction(a.type)} disabled={locked(a.min_plan)} title={a.description}>
              + {label(a.type)}
              {locked(a.min_plan) ? ` (${a.min_plan})` : ""}
            </button>
          ))}
        </div>
      </section>

      {/* ---- settings ---- */}
      <div className="connector" />
      <section className="card">
        <div className="card-head">
          <span className="label">Settings</span>
        </div>
        <div className="card-body grid2">
          <label className="field">
            <span className="name">Mode</span>
            <select value={draft.settings.mode} onChange={(e) => update((d) => ({ ...d, settings: { ...d.settings, mode: e.target.value as "confirmed" | "fast" } }))}>
              <option value="confirmed">Confirmed events (reorg-safe, ~2 s later)</option>
              <option value="fast" disabled={!triggerItem?.supports_fast}>
                Fast: at chain head{triggerItem?.supports_fast ? " (reorgs recorded)" : " (not for this trigger)"}
              </option>
            </select>
          </label>
          <label className="field">
            <span className="name">Max runs per hour</span>
            <input type="number" min={1} max={3600} value={draft.settings.max_runs_per_hour} onChange={(e) => update((d) => ({ ...d, settings: { ...d.settings, max_runs_per_hour: Math.max(1, Number(e.target.value) || 1) } }))} />
            <span className="help">Runaway protection: far above this, the flow pauses itself.</span>
          </label>
        </div>
      </section>

      {testRunId ? (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <span className="label">Test run</span>
            <span className="small muted mono">{testRunId}</span>
          </div>
          <div className="card-body">
            <TestRunPanel key={testRunId} runId={testRunId} tz={me.timezone} />
          </div>
        </section>
      ) : null}
      {sample && !testRunId ? (
        <p className="small faint" style={{ marginTop: 12 }}>
          “Test flow” sends the actions once with this sample, labelled TEST.
        </p>
      ) : null}
      {process.env.NODE_ENV === "development" ? <Json value={toDefinition(draft, forms, triggerFields)} collapsed summary="Definition (dev)" /> : null}
    </div>
  );
}
