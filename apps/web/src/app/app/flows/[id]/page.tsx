"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { useSession } from "@/components/session";
import { Badge, CopyButton, Empty, Json, Notice, Spinner, TestBadge, useToast } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { ago, duration, label, shortHex, when } from "@/lib/format";
import type { Evaluation, FlowDetail, RunStatus, RunSummary } from "@/lib/types";

function triggerSummary(flow: FlowDetail): string {
  const p = flow.definition.trigger.params;
  const addr = (v: unknown) => (typeof v === "string" ? shortHex(v) : "");
  switch (flow.trigger_type) {
    case "TOKEN_TRANSFER":
      return `transfer of ${addr(p.token)}${p.wallet ? ` ${p.direction === "in" ? "into" : p.direction === "out" ? "out of" : "via"} ${addr(p.wallet)}` : ""}`;
    case "NEW_HOLDER":
      return `new holder of ${addr(p.token)}`;
    case "CONTRACT_EVENT":
      return `${String(p.event ?? "").replace(/^event /, "").split("(")[0]} on ${addr(p.address)}`;
    case "BALANCE_THRESHOLD":
      return `${addr(p.wallet)} ${String(p.asset) === "native" ? "ETH" : addr(p.asset)} ${String(p.direction)} ${String(p.threshold)}`;
    case "STATE_CHANGE":
      return `${String(p.function ?? "").replace(/^function /, "").split(" returns")[0]} on ${addr(p.address)} changes`;
    case "SCHEDULE":
      return `cron ${String(p.cron)} (${String(p.timezone ?? "Asia/Jakarta")})`;
    case "CONTRACT_DEPLOYED":
      return `contract deployed by ${addr(p.deployer)}`;
    default:
      return label(flow.trigger_type);
  }
}

function eventSummary(ev: Record<string, unknown>): string {
  if (typeof ev.amount_formatted === "string") return `${ev.amount_formatted} ${String((ev.token as { symbol?: unknown } | undefined)?.symbol ?? "")}`.trim();
  if (typeof ev.scheduled_at_local === "string") return ev.scheduled_at_local;
  if (ev.body !== undefined) return JSON.stringify(ev.body).slice(0, 60);
  if (ev.current !== undefined) return `→ ${JSON.stringify(ev.current).slice(0, 40)}`;
  if (typeof ev.balance_after_formatted === "string") return `balance ${ev.balance_after_formatted}`;
  if (typeof ev.tx_hash === "string") return shortHex(ev.tx_hash);
  return "";
}

const STATUSES: Array<RunStatus | ""> = ["", "succeeded", "partial", "failed", "skipped", "queued", "running"];

function Runs({ flowId, tz }: { flowId: string; tz: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<RunStatus | "">("");
  const [pages, setPages] = useState<RunSummary[][]>([]);
  const [next, setNext] = useState<string | null>(null);
  const first = useApi<{ data: RunSummary[]; next_before: string | null }>(`/v1/flows/${flowId}/runs?limit=50${status ? `&status=${status}` : ""}`, { pollMs: 5000, poll: () => pages.length === 0 });
  const rows = [...(first.data?.data ?? []), ...pages.flat()];
  const more = pages.length ? next : (first.data?.next_before ?? null);
  const loadMore = async () => {
    if (!more) return;
    const res = await api<{ data: RunSummary[]; next_before: string | null }>(`/v1/flows/${flowId}/runs?limit=50&before=${more}${status ? `&status=${status}` : ""}`);
    setPages((p) => [...p, res.data]);
    setNext(res.next_before);
  };
  return (
    <div className="card">
      <div className="card-head">
        <span className="label">Runs</span>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as RunStatus | "");
            setPages([]);
          }}
          style={{ width: "auto" }}
          aria-label="Filter by status"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || "all statuses"}
            </option>
          ))}
        </select>
      </div>
      {first.loading ? (
        <div className="card-body">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <Empty>No runs yet. Runs appear when the trigger fires and the conditions pass — or use “Test flow”.</Empty>
      ) : (
        <table className="table responsive">
          <thead>
            <tr>
              <th>When ({tz === "Asia/Jakarta" ? "WIB" : tz})</th>
              <th>Status</th>
              <th>Event</th>
              <th className="right">Took</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => router.push(`/app/runs/${r.id}`)}>
                <td className="nowrap">
                  <Link href={`/app/runs/${r.id}`} onClick={(e) => e.stopPropagation()} className="mono small">
                    {when(r.created_at, tz).slice(0, 19)}
                  </Link>
                </td>
                <td>
                  <span className="row">
                    <Badge status={r.status} text={r.status} />
                    {r.test ? <TestBadge /> : null}
                    {r.reverted_at ? <span className="badge plain s-partial">reorged</span> : null}
                  </span>
                  {r.status_reason && r.status !== "succeeded" ? <div className="small muted ellipsis" style={{ maxWidth: 360 }}>{r.status_reason}</div> : null}
                </td>
                <td data-label="event" className="small mono ellipsis" style={{ maxWidth: 420 }}>
                  {r.summary ?? <span className="muted">{label(r.trigger_type)}</span>}
                </td>
                <td data-label="took" className="right small muted nowrap">
                  {duration(r.started_at, r.finished_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {more ? (
        <div className="card-body">
          <button type="button" className="btn sm" onClick={() => void loadMore()}>
            Load older runs
          </button>
        </div>
      ) : null}
    </div>
  );
}

function WhyNot({ flowId, tz }: { flowId: string; tz: string }) {
  const evals = useApi<{ data: Evaluation[] }>(`/v1/flows/${flowId}/evaluations?limit=50`);
  const rows = evals.data?.data ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <span className="label">Why it did not run</span>
        <span className="small muted">recent matches that created no run (sampled)</span>
      </div>
      {rows.length === 0 ? (
        <Empty>Nothing yet: every match so far became a run (or nothing matched).</Empty>
      ) : (
        <table className="table responsive">
          <thead>
            <tr>
              <th>When</th>
              <th>Outcome</th>
              <th>Why</th>
              <th>Event</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const failed = e.conditions_result.filter((c) => !c.passed);
              return (
                <tr key={e.id}>
                  <td className="mono small nowrap">{when(e.created_at, tz).slice(0, 19)}</td>
                  <td>
                    <Badge status={e.outcome} />
                  </td>
                  <td data-label="why" className="small">
                    {e.reason ??
                      failed.map((c) => (
                        <div key={c.field} className="mono">
                          {c.field} {c.op} {JSON.stringify(c.expected)} — actual {JSON.stringify(c.actual) ?? "missing"}
                        </div>
                      ))}
                  </td>
                  <td data-label="event" className="small muted">
                    {eventSummary(e.trigger_event)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function FlowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { me, refresh } = useSession();
  const [toast, notify] = useToast();
  const flow = useApi<{ data: FlowDetail }>(`/v1/flows/${id}`, { pollMs: 10_000, poll: () => true });
  const [tab, setTab] = useState<"runs" | "why" | "definition">("runs");
  const [busy, setBusy] = useState(false);

  if (flow.error) return <Notice kind="error">{flow.error.message}</Notice>;
  if (!flow.data) return <Spinner />;
  const f = flow.data.data;
  const s = f.stats;

  const act = async (path: string, done: string) => {
    setBusy(true);
    try {
      const res = await api<{ data: FlowDetail }>(`/v1/flows/${id}/${path}`, { method: "POST" });
      flow.setData({ data: res.data });
      notify(done);
      void refresh();
    } catch (err) {
      notify(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const res = await api<{ data: { run: { id: string } } }>(`/v1/flows/${id}/test`, { body: {} });
      router.push(`/app/runs/${res.data.run.id}`);
    } catch (err) {
      notify(errorText(err), "error");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${f.name}" with all its runs? This cannot be undone.`)) return;
    await api(`/v1/flows/${id}`, { method: "DELETE" });
    router.push("/app");
  };

  const rotate = async () => {
    if (!window.confirm("Rotate the URL? The current one stops working immediately.")) return;
    const res = await api<{ data: { hook_url: string } }>(`/v1/flows/${id}/hook/rotate`, { method: "POST" });
    flow.setData({ data: { ...f, hook_url: res.data.hook_url } });
    notify("New URL ready; update your sender.");
  };

  return (
    <main className="stack">
      {toast}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="row">
            <h1>{f.name}</h1>
            <Badge status={f.status} text={f.status} />
          </div>
          <div className="sub">
            {label(f.trigger_type)}: {triggerSummary(f)} → {f.actions.map(label).join(", ")} · v{f.version} · {f.mode}
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn" disabled={busy} onClick={() => void test()}>
            Test flow
          </button>
          <Link href={`/app/flows/${id}/edit`} className="btn">
            Edit
          </Link>
          {f.status === "active" ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void act("pause", "Paused.")}>
              Pause
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void act("resume", "Active.")}>
              Activate
            </button>
          )}
          <button type="button" className="btn ghost danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>

      {f.status_reason ? <Notice kind="warn">{f.status_reason}</Notice> : null}
      {f.hook_url !== undefined ? (
        <div className="card">
          <div className="card-head">
            <span className="label">Inbound URL</span>
            <span className="row">
              {f.hook_url ? <CopyButton value={f.hook_url} /> : null}
              <button type="button" className="btn sm ghost" onClick={() => void rotate()}>
                Rotate
              </button>
            </span>
          </div>
          <div className="card-body stack" style={{ gap: 6 }}>
            {f.hook_url ? <code style={{ overflowWrap: "anywhere" }}>{f.hook_url}</code> : <span className="muted">Inbound webhooks are not configured on this server.</span>}
            <span className="small muted">
              POST JSON, form or text (64 KB max). Send an <span className="mono">Idempotency-Key</span> header to make retries safe. Answers 202 when stored.
            </span>
          </div>
        </div>
      ) : null}

      <div className="card stats">
        {[
          ["runs", s.runs],
          ["succeeded", s.runs_succeeded],
          ["partial", s.runs_partial],
          ["failed", s.runs_failed],
          ["matched", s.matched],
          ["conditions failed", s.conditions_failed],
          ["hourly cap", s.rate_limited],
          ["plan quota", s.plan_limited],
          ["missed", s.missed],
        ].map(([l, n]) => (
          <div key={l as string} className="stat">
            <div className="n">{(n as number).toLocaleString("en-US")}</div>
            <div className="l">{l}</div>
          </div>
        ))}
        <div className="stat">
          <div className="n small">{ago(s.last_run_at, Date.now(), me.timezone)}</div>
          <div className="l">last run</div>
        </div>
      </div>
      {s.last_error && s.consecutive_failures > 0 ? (
        <Notice kind="error">
          {s.consecutive_failures} failed run{s.consecutive_failures === 1 ? "" : "s"} in a row. Last error: {s.last_error}
        </Notice>
      ) : null}

      <div>
        <div className="tabs" role="tablist">
          {(
            [
              ["runs", "Run history"],
              ["why", "Why it did not run"],
              ["definition", "Definition"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        {tab === "runs" ? <Runs flowId={id} tz={me.timezone} /> : null}
        {tab === "why" ? <WhyNot flowId={id} tz={me.timezone} /> : null}
        {tab === "definition" ? <Json value={f.definition} /> : null}
      </div>
    </main>
  );
}
