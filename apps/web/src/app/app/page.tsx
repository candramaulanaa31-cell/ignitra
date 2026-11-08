"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/session";
import { useState } from "react";
import { Badge, Empty, Notice, Spinner, useToast } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { ago, label } from "@/lib/format";
import type { DeadLetter, FlowSummary } from "@/lib/types";

/** Runs whose steps failed for good, one row per flow: fix the destination, then retry only those steps. */
function NeedsAttention() {
  const { me } = useSession();
  const [toast, notify] = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const letters = useApi<{ data: DeadLetter[] }>("/v1/dead-letters?limit=50");
  const list = letters.data?.data ?? [];
  // Keep the toast mounted: retrying the last dead letter empties the list.
  if (list.length === 0) return toast ? <>{toast}</> : null;
  const byFlow = [...list.reduce((m, d) => m.set(d.flow_id, [...(m.get(d.flow_id) ?? []), d]), new Map<string, DeadLetter[]>()).values()];
  const retry = async (flowId: string, runs: DeadLetter[]) => {
    setBusy(flowId);
    let failed = 0;
    for (const d of runs) {
      try {
        await api(`/v1/runs/${d.run_id}/retry`, { method: "POST" });
      } catch (err) {
        failed++;
        if (failed === 1) notify(errorText(err), "error");
      }
    }
    if (failed === 0) notify(`Retrying ${runs.length === 1 ? "the run" : `${runs.length} runs`}. Steps that already delivered are not sent again.`);
    await letters.reload();
    setBusy(null);
  };
  return (
    <section className="card attention" style={{ marginBottom: 16 }}>
      {toast}
      <div className="card-head">
        <span className="label">Needs attention</span>
        <span className="small muted">steps that failed for good · fix the destination, then retry</span>
      </div>
      <table className="table responsive">
        <tbody>
          {byFlow.map((runs) => {
            const [latest] = runs as [DeadLetter, ...DeadLetter[]];
            const step = latest.steps[0];
            return (
              <tr key={latest.flow_id}>
                <td>
                  <Link href={`/app/flows/${latest.flow_id}`} className="strong-link">
                    {latest.flow_name}
                  </Link>
                  {step ? (
                    <div className="small failc ellipsis">
                      {step.step_id} ({label(step.action_type)}): {step.error ?? "failed"}
                    </div>
                  ) : null}
                </td>
                <td data-label="failed runs" className="mono small nowrap">
                  {runs.length} run{runs.length === 1 ? "" : "s"}
                </td>
                <td data-label="latest" className="small muted nowrap">
                  <Link href={`/app/runs/${latest.run_id}`}>{ago(latest.created_at, Date.now(), me.timezone)}</Link>
                </td>
                <td className="right">
                  <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void retry(latest.flow_id, runs)}>
                    {busy === latest.flow_id ? "Retrying…" : runs.length === 1 ? "Retry" : `Retry all ${runs.length}`}
                  </button>
                </td>
              </tr>
            );
          })}
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
