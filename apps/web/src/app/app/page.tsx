"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/session";
import { Badge, Empty, Notice, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";
import { ago, label } from "@/lib/format";
import type { FlowSummary } from "@/lib/types";

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
