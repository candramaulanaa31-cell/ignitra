"use client";

import Link from "next/link";
import { duration, label, when } from "@/lib/format";
import type { RunDetail } from "@/lib/types";
import { Badge, Hex, Json, Notice, TestBadge } from "./ui";

/** Why it ran (or not), what was sent, what came back — step by step. */
export function RunTrace({ run, tz, compact = false }: { run: RunDetail; tz: string; compact?: boolean }) {
  const ev = run.trigger_event;
  const evidence: Array<[string, React.ReactNode]> = [];
  if (typeof ev.tx_hash === "string") evidence.push(["Transaction", <Hex key="tx" value={ev.tx_hash} kind="tx" />]);
  if (typeof ev.block_number === "number") evidence.push(["Block", <span key="b" className="mono">{ev.block_number.toLocaleString("en-US")}</span>]);
  if (typeof ev.log_index === "number") evidence.push(["Log index", <span key="l" className="mono">{ev.log_index}</span>]);
  if (typeof ev.scheduled_at === "string") evidence.push(["Scheduled", <span key="s">{when(ev.scheduled_at, tz)}</span>]);
  if (typeof ev.request_id === "string") evidence.push(["Request", <span key="r" className="mono">{ev.request_id}</span>]);
  if (typeof ev.contract === "string") evidence.push(["Contract", <Hex key="c" value={ev.contract} kind="address" />]);
  if (typeof ev.block_timestamp === "string") evidence.push(["Block time", <span key="t">{when(ev.block_timestamp, tz)}</span>]);

  return (
    <div className="stack">
      {run.test ? (
        <Notice kind="info">
          TEST run: the actions ran with sample data and said so (a “TEST” label in messages, <span className="mono">test: true</span> in webhooks). Not metered.
        </Notice>
      ) : null}
      {run.reverted_at ? (
        <Notice kind="warn">
          The triggering event was reorged out ({run.revert_reason ?? "reorg"}) at {when(run.reverted_at, tz)}.{run.revert_notice ? " Webhook receivers got a run.reverted notice." : ""}
        </Notice>
      ) : null}
      {run.status_reason && run.status !== "succeeded" ? <Notice kind={run.status === "failed" ? "error" : "warn"}>{run.status_reason}</Notice> : null}

      <div className="pipeline">
      <div className="card stage" data-stage="WHEN">
        <div className="card-head">
          <span className="label">Trigger · {label(run.trigger_type)}</span>
          {run.test ? <TestBadge /> : null}
        </div>
        {evidence.length ? (
          <dl className="kv">
            {evidence.map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>])}
          </dl>
        ) : null}
        <div className="card-body">
          <Json value={ev} collapsed={!compact} summary="Trigger data (everything templates can use as {{trigger.…}})" />
        </div>
      </div>

      <div className="connector" />
      <div className={`card stage ${run.conditions_result.some((c) => !c.passed) ? "stage-fail" : ""}`} data-stage="IF">
        <div className="card-head">
          <span className="label">Conditions</span>
          <span className="small muted">{run.conditions_result.length === 0 ? "none" : `${run.conditions_result.filter((c) => c.passed).length} of ${run.conditions_result.length} passed`}</span>
        </div>
        {run.conditions_result.length > 0 ? (
          <table className="table responsive">
            <thead>
              <tr>
                <th>Field</th>
                <th>Check</th>
                <th>Actual</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {run.conditions_result.map((c, i) => (
                <tr key={i}>
                  <td className="mono">{c.field}</td>
                  <td className="mono small">
                    {c.op} {c.expected === undefined ? "" : JSON.stringify(c.expected)}
                  </td>
                  <td className="mono small">{JSON.stringify(c.actual) ?? "missing"}</td>
                  <td className={c.passed ? "pass" : "failc"}>{c.passed ? "✓ pass" : `✗ ${c.error ? c.error.replace("_", " ") : "fail"}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {run.steps.length === 0 && (run.status === "queued" || run.status === "running") ? <p className="muted small">Waiting for a runner…</p> : null}
      {run.steps.map((s) => (
        <div key={s.step_id}>
        <div className="connector" />
        <div className={`card stage ${s.status === "failed" ? "stage-fail" : s.status === "succeeded" ? "stage-ok" : ""}`} data-stage="THEN">
          <div className="card-head">
            <span className="row">
              <span className="step-num">{s.position + 1}</span>
              <strong>{label(s.action_type)}</strong>
              <span className="mono small faint">{s.step_id}</span>
            </span>
            <span className="row small">
              <Badge status={s.status} text={s.status} />
              {s.http_status ? <span className="mono">HTTP {s.http_status}</span> : null}
              {s.duration_ms !== null ? <span className="muted">{s.duration_ms} ms</span> : null}
              <span className="muted">
                {s.attempts} attempt{s.attempts === 1 ? "" : "s"}
              </span>
            </span>
          </div>
          <div className="card-body stack">
            {s.error ? <Notice kind={s.status === "skipped" ? "info" : "error"}>{s.error}</Notice> : null}
            <div className="grid2">
              {s.request ? <Json value={s.request} collapsed={compact} summary="Request" /> : null}
              {s.response ? <Json value={s.response} collapsed={compact} summary="Response" /> : null}
            </div>
            {s.output !== null && s.output !== undefined ? <Json value={s.output} collapsed summary={`Output → {{steps.${s.step_id}.…}}`} /> : null}
          </div>
        </div>
        </div>
      ))}
      </div>
      {compact ? (
        <Link href={`/app/runs/${run.id}`} className="small">
          Open the full trace ↗
        </Link>
      ) : (
        <p className="small faint">
          Created {when(run.created_at, tz)} · started {when(run.started_at, tz)} · finished {when(run.finished_at, tz)} · took {duration(run.started_at, run.finished_at)}
        </p>
      )}
    </div>
  );
}
