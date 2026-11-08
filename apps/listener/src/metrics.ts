import { eq, sql } from "drizzle-orm";
import { chainSyncStatus, chainVerification, type Database } from "@ignitra/db";

/**
 * Operational metrics (Phase 9). Computed from the database, so every process and
 * `pnpm ops metrics` see the same numbers. Served as Prometheus text on the INTERNAL health port
 * (/metrics), never on the public API: they name flows.
 */

export interface Metrics {
  readonly at: string;
  readonly listener: { head: number | null; confirmedCursor: number | null; lagBlocks: number | null; lastTickAgeSeconds: number | null; watches: number | null; lastError: string | null };
  readonly gapDetector: { verifiedBlock: number; checkedBlocks: number; missingTotal: number; lastMissingAt: string | null } | null;
  readonly rpc: ReadonlyArray<{ endpoint: string; requests: number; failures: number; errorRate: number | null; coolingDown: boolean }>;
  /** Runs waiting: due now, backing off after a failed step, being executed; the oldest due one's age. */
  readonly queue: { due: number; backingOff: number; running: number; oldestDueSeconds: number | null };
  /** Chain event's block → run finished, over the last hour (non-TEST runs started by chain events). */
  readonly latency: { samples: number; p50Seconds: number | null; p95Seconds: number | null };
  readonly runsLastHour: Readonly<Record<string, number>>;
  readonly stepsLastHour: ReadonlyArray<{ actionType: string; succeeded: number; failed: number; successRate: number | null }>;
  readonly topFailingFlows: ReadonlyArray<{ flowId: string; name: string; failedRuns: number; lastError: string | null }>;
  /** Runs whose steps failed for good in the last 7 days, waiting for their owners. */
  readonly deadLetters: number;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round = (v: number | null, digits = 3): number | null => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(digits)));

export async function collectMetrics(db: Database, chainId: number): Promise<Metrics> {
  const [status] = await db.select().from(chainSyncStatus).where(eq(chainSyncStatus.chainId, chainId));
  const [verification] = await db.select().from(chainVerification).where(eq(chainVerification.chainId, chainId));

  const rows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> => {
    const result = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(result) ? result : (result.rows ?? []);
  };

  const [queue] = await rows<{ due: unknown; backing_off: unknown; running: unknown; oldest_due: unknown }>(sql`
    select
      count(*) filter (where status = 'queued' and (next_attempt_at is null or next_attempt_at <= now())) as due,
      count(*) filter (where status = 'queued' and next_attempt_at > now()) as backing_off,
      count(*) filter (where status = 'running') as running,
      extract(epoch from now() - min(created_at) filter (where status = 'queued' and (next_attempt_at is null or next_attempt_at <= now()))) as oldest_due
    from runs where status in ('queued', 'running')`);

  const [latency] = await rows<{ samples: unknown; p50: unknown; p95: unknown }>(sql`
    select count(*) as samples,
      percentile_cont(0.5) within group (order by extract(epoch from r.finished_at - e.block_timestamp)) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from r.finished_at - e.block_timestamp)) as p95
    from runs r join chain_events e on e.id = r.chain_event_id
    where r.is_test = false and r.finished_at >= now() - interval '1 hour' and e.block_timestamp is not null`);

  const runsByStatus = await rows<{ status: string; n: unknown }>(sql`
    select status, count(*) as n from runs where is_test = false and finished_at >= now() - interval '1 hour' group by status`);

  const steps = await rows<{ action_type: string; succeeded: unknown; failed: unknown }>(sql`
    select s.action_type,
      count(*) filter (where s.status = 'succeeded') as succeeded,
      count(*) filter (where s.status = 'failed') as failed
    from run_steps s join runs r on r.id = s.run_id
    where r.is_test = false and s.finished_at >= now() - interval '1 hour'
    group by s.action_type order by s.action_type`);

  const failing = await rows<{ flow_id: string; name: string; failed: unknown; last_error: string | null }>(sql`
    select f.id as flow_id, f.name, count(*) as failed, max(fs.last_error) as last_error
    from runs r join flows f on f.id = r.flow_id left join flow_stats fs on fs.flow_id = f.id
    where r.is_test = false and r.status in ('failed', 'partial') and r.finished_at >= now() - interval '1 day'
    group by f.id, f.name order by failed desc limit 5`);

  const [dead] = await rows<{ n: unknown }>(sql`
    select count(*) as n from runs r
    where r.is_test = false and r.status in ('failed', 'partial') and r.created_at >= now() - interval '7 days'
      and exists (select 1 from run_steps s where s.run_id = r.id and s.status = 'failed')`);

  const endpoints = ((status?.rpc as { endpoints?: Array<{ label?: string; name?: string; requests?: number; failures?: number; coolingDown?: boolean }> } | undefined)?.endpoints ?? []).map((e) => ({
    endpoint: String(e.label ?? e.name ?? "rpc"),
    requests: num(e.requests),
    failures: num(e.failures),
    errorRate: num(e.requests) > 0 ? round(num(e.failures) / num(e.requests)) : null,
    coolingDown: Boolean(e.coolingDown),
  }));

  return {
    at: new Date().toISOString(),
    listener: {
      head: status?.headBlock ?? null,
      confirmedCursor: status?.confirmedCursor ?? null,
      lagBlocks: status ? status.confirmedHead - status.confirmedCursor : null,
      lastTickAgeSeconds: status ? round((Date.now() - status.lastTickAt.getTime()) / 1000, 1) : null,
      watches: status?.watchCount ?? null,
      lastError: status?.lastError ?? null,
    },
    gapDetector: verification
      ? { verifiedBlock: verification.verifiedBlock, checkedBlocks: verification.checkedBlocks, missingTotal: verification.missingTotal, lastMissingAt: verification.lastMissingAt?.toISOString() ?? null }
      : null,
    rpc: endpoints,
    queue: { due: num(queue?.due), backingOff: num(queue?.backing_off), running: num(queue?.running), oldestDueSeconds: round(numOrNull(queue?.oldest_due), 1) },
    latency: { samples: num(latency?.samples), p50Seconds: round(numOrNull(latency?.p50), 2), p95Seconds: round(numOrNull(latency?.p95), 2) },
    runsLastHour: Object.fromEntries(runsByStatus.map((r) => [r.status, num(r.n)])),
    stepsLastHour: steps.map((s) => {
      const ok = num(s.succeeded);
      const bad = num(s.failed);
      return { actionType: s.action_type, succeeded: ok, failed: bad, successRate: ok + bad > 0 ? round(ok / (ok + bad)) : null };
    }),
    topFailingFlows: failing.map((f) => ({ flowId: f.flow_id, name: f.name, failedRuns: num(f.failed), lastError: f.last_error })),
    deadLetters: num(dead?.n),
  };
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

/** Prometheus text exposition (version 0.0.4). */
export function toPrometheus(m: Metrics, chainId: number): string {
  const out: string[] = [];
  const metric = (name: string, help: string, type: "gauge" | "counter", samples: ReadonlyArray<[Record<string, string>, number | null]>) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      if (value === null) continue;
      const l = Object.entries({ chain: String(chainId), ...labels })
        .map(([k, v]) => `${k}="${esc(v)}"`)
        .join(",");
      out.push(`${name}{${l}} ${value}`);
    }
  };
  metric("ignitra_listener_head_block", "Newest block the listener saw", "gauge", [[{}, m.listener.head]]);
  metric("ignitra_listener_lag_blocks", "Confirmed blocks not ingested yet", "gauge", [[{}, m.listener.lagBlocks]]);
  metric("ignitra_listener_last_tick_age_seconds", "Seconds since the listener last finished a tick", "gauge", [[{}, m.listener.lastTickAgeSeconds]]);
  metric("ignitra_listener_watches", "Active (address, event) watches", "gauge", [[{}, m.listener.watches]]);
  if (m.gapDetector) {
    metric("ignitra_gap_detector_verified_block", "Every confirmed block up to here was re-read and compared", "gauge", [[{}, m.gapDetector.verifiedBlock]]);
    metric("ignitra_gap_detector_checked_blocks_total", "Confirmed blocks re-read by the gap detector", "counter", [[{}, m.gapDetector.checkedBlocks]]);
    metric("ignitra_gap_detector_missing_total", "Watched events the node had left out, found and inserted by the gap detector", "counter", [[{}, m.gapDetector.missingTotal]]);
  }
  metric("ignitra_rpc_requests_total", "RPC requests per endpoint (since the listener started)", "counter", m.rpc.map((e) => [{ endpoint: e.endpoint }, e.requests]));
  metric("ignitra_rpc_failures_total", "Failed RPC requests per endpoint", "counter", m.rpc.map((e) => [{ endpoint: e.endpoint }, e.failures]));
  metric("ignitra_rpc_error_rate", "Failed / all RPC requests per endpoint", "gauge", m.rpc.map((e) => [{ endpoint: e.endpoint }, e.errorRate]));
  metric("ignitra_queue_runs", "Runs waiting for or in execution", "gauge", [
    [{ state: "due" }, m.queue.due],
    [{ state: "backing_off" }, m.queue.backingOff],
    [{ state: "running" }, m.queue.running],
  ]);
  metric("ignitra_queue_oldest_due_seconds", "Age of the oldest run that is due", "gauge", [[{}, m.queue.oldestDueSeconds]]);
  metric("ignitra_event_to_run_seconds", "Chain event's block to run finished, last hour", "gauge", [
    [{ quantile: "0.5" }, m.latency.p50Seconds],
    [{ quantile: "0.95" }, m.latency.p95Seconds],
  ]);
  metric("ignitra_runs_last_hour", "Runs finished in the last hour, by status", "gauge", Object.entries(m.runsLastHour).map(([status, n]) => [{ status }, n]));
  metric("ignitra_step_success_rate", "Succeeded / finished steps in the last hour, by action type", "gauge", m.stepsLastHour.map((s) => [{ action_type: s.actionType }, s.successRate]));
  metric("ignitra_steps_failed_last_hour", "Steps that failed in the last hour, by action type", "gauge", m.stepsLastHour.map((s) => [{ action_type: s.actionType }, s.failed]));
  metric("ignitra_flow_failed_runs_last_day", "Failed or partial runs in the last day, top flows", "gauge", m.topFailingFlows.map((f) => [{ flow_id: f.flowId }, f.failedRuns]));
  metric("ignitra_dead_letters", "Runs whose steps failed for good in the last 7 days", "gauge", [[{}, m.deadLetters]]);
  return `${out.join("\n")}\n`;
}
