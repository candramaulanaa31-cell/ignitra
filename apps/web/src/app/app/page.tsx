"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/session";
import { useState } from "react";
import { Badge, Empty, Notice, Spinner, useToast } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { ago, label } from "@/lib/format";
import type { DeadLetter, FlowSummary } from "@/lib/types";

/** Runs whose steps failed for good: fix the destination, then retry only those steps. */
function NeedsAttention() {
  const { me } = useSession();
  const [toast, notify] = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const letters = useApi<{ data: DeadLetter[] }>("/v1/dead-letters?limit=5");
  const list = letters.data?.data ?? [];
  if (list.length === 0) return null;
  const retry = async (d: DeadLetter) => {
    setBusy(d.run_id);
    try {
      await api(`/v1/runs/${d.run_id}/retry`, { method: "POST" });
      notify("Retrying. Steps that already delivered are not sent again.");
      await letters.reload();
    } catch (err) {
      notify(errorText(err), "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      {toast}
      <div className="card-head">
        <span className="label">Needs attention</span>
        <span className="small muted">steps that failed for good</span>
      </div>
      <table className="table responsive">
        <tbody>
          {list.map((d) => (
            <tr key={d.run_id}>
              <td className="small">
                <Link href={`/app/runs/${d.run_id}`}>{d.flow_name}</Link>
                {d.steps.map((s) => (
                  <div key={s.step_id} className="failc ellipsis">
                    {s.step_id} ({label(s.action_type)}): {s.error ?? "failed"}
                  </div>
                ))}
              </td>
              <td data-label="when" className="small muted nowrap">
                {ago(d.created_at, Date.now(), me.timezone)}
              </td>
              <td className="right">
                <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void retry(d)}>
                  {busy === d.run_id ? "Retrying…" : "Retry"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function FlowsPage() {
  const { me } = useSession();
  const router = useRouter();
  const flows = useApi<{ data: FlowSummary[] }>("/v1/flows");
  const list = flows.data?.data ?? [];
  const active = list.filter((f) => f.status === "active").length;
  const limit = me.limits.active_flows;
  const used = me.usage.runs.used;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Flows</h1>
          <div className="sub">
            {active} active{limit !== null ? ` of ${limit}` : ""} · {used.toLocaleString("en-US")} / {me.usage.runs.included.toLocaleString("en-US")} runs this month
          </div>
        </div>
        <Link href="/app/flows/new" className="btn primary">
          New flow
        </Link>
      </div>

      {flows.error ? <Notice kind="error">{flows.error.message}</Notice> : null}
      <NeedsAttention />
      <div className="card">
        {flows.loading ? (
          <div className="card-body">
            <Spinner />
          </div>
        ) : list.length === 0 ? (
          <Empty>
            No flows yet. <Link href="/app/flows/new">Build your first one</Link>: a trigger on Robinhood Chain, optional conditions, then actions.
          </Empty>
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>Flow</th>
                <th>Status</th>
                <th>Trigger → actions</th>
                <th className="right">Runs</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {list.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => router.push(`/app/flows/${f.id}`)}>
                  <td>
                    <Link href={`/app/flows/${f.id}`} onClick={(e) => e.stopPropagation()}>
                      {f.name}
                    </Link>
                    {f.stats.last_error && f.stats.consecutive_failures > 0 ? <div className="small failc ellipsis">{f.stats.last_error}</div> : null}
                    {f.status_reason ? <div className="small muted ellipsis">{f.status_reason}</div> : null}
                  </td>
                  <td>
                    <Badge status={f.status} text={f.status} />
                  </td>
                  <td data-label="flow" className="small">
                    {label(f.trigger_type)} → {f.actions.map(label).join(", ")}
                  </td>
                  <td data-label="runs" className="right mono">
                    {f.stats.runs.toLocaleString("en-US")}
                    {f.stats.runs_failed > 0 ? <span className="failc"> · {f.stats.runs_failed} failed</span> : null}
                  </td>
                  <td data-label="last run" className="small muted nowrap">
                    {ago(f.stats.last_run_at, Date.now(), me.timezone)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
