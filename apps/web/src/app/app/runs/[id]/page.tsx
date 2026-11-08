"use client";

import Link from "next/link";
import { use, useState } from "react";
import { RunTrace } from "@/components/run-trace";
import { useSession } from "@/components/session";
import { Badge, Notice, Spinner, TestBadge, useToast } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { FINAL, label, when } from "@/lib/format";
import type { RunDetail } from "@/lib/types";

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me } = useSession();
  // Live while the run is queued / running / backing off.
  const run = useApi<{ data: RunDetail }>(`/v1/runs/${id}`, { pollMs: 1500, poll: (r) => !FINAL.has(r.data.status) });
  const [toast, notify] = useToast();
  const [retrying, setRetrying] = useState(false);
  if (run.error) return <Notice kind="error">{run.error.message}</Notice>;
  if (!run.data) return <Spinner />;
  const r = run.data.data;
  const retriable = (r.status === "failed" || r.status === "partial") && !r.test && !r.reverted_at;
  const retry = async () => {
    setRetrying(true);
    try {
      await api(`/v1/runs/${r.id}/retry`, { method: "POST" });
      notify("Retrying the failed steps. Steps that already delivered are not sent again.");
      await run.reload();
    } catch (err) {
      notify(errorText(err), "error");
    } finally {
      setRetrying(false);
    }
  };
  return (
    <main className="stack">
      {toast}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="row">
            <h1 className="mono" style={{ fontSize: 16 }}>
              {r.id}
            </h1>
            <Badge status={r.status} text={r.status} />
            {r.test ? <TestBadge /> : null}
          </div>
          <div className="sub">
            <Link href={`/app/flows/${r.flow_id}`}>flow {r.flow_id}</Link> · v{r.flow_version} · {label(r.trigger_type)} · {when(r.created_at, me.timezone)}
            {r.next_attempt_at && !FINAL.has(r.status) ? ` · retrying at ${when(r.next_attempt_at, me.timezone)}` : ""}
          </div>
        </div>
        {retriable ? (
          <button type="button" className="btn" disabled={retrying} onClick={() => void retry()} title="Runs the failed steps again with the same idempotency keys; delivered steps are not repeated">
            {retrying ? "Retrying…" : "Retry failed steps"}
          </button>
        ) : null}
      </div>
      <RunTrace run={r} tz={me.timezone} />
    </main>
  );
}
