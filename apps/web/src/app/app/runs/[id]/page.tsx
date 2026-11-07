"use client";

import Link from "next/link";
import { use } from "react";
import { RunTrace } from "@/components/run-trace";
import { useSession } from "@/components/session";
import { Badge, Notice, Spinner, TestBadge } from "@/components/ui";
import { useApi } from "@/lib/api";
import { FINAL, label, when } from "@/lib/format";
import type { RunDetail } from "@/lib/types";

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me } = useSession();
  // Live while the run is queued / running / backing off.
  const run = useApi<{ data: RunDetail }>(`/v1/runs/${id}`, { pollMs: 1500, poll: (r) => !FINAL.has(r.data.status) });
  if (run.error) return <Notice kind="error">{run.error.message}</Notice>;
  if (!run.data) return <Spinner />;
  const r = run.data.data;
  return (
    <main className="stack">
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
      </div>
      <RunTrace run={r} tz={me.timezone} />
    </main>
  );
}
