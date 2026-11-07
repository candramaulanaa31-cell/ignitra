import { planLimits, type FlowDefinition } from "@ignitra/core";
import type { Flow, FlowEvaluation, FlowStats, OwnerNotification, Run, RunStep, User } from "@ignitra/db";
import type { PublicConnection } from "@ignitra/actions";
import { iso } from "./http";

/** Public JSON shapes (snake_case, ISO-8601 UTC timestamps). Secrets never appear here. */

export function userView(u: Pick<User, "id" | "address" | "plan" | "timezone" | "createdAt">) {
  const limits = planLimits(u.plan);
  return {
    id: u.id,
    address: u.address,
    plan: u.plan,
    timezone: u.timezone,
    created_at: iso(u.createdAt),
    limits: {
      active_flows: limits.activeFlows,
      runs_per_month: limits.runsPerMonth,
      overage: limits.overage,
      min_schedule_minutes: limits.minScheduleMinutes,
    },
  };
}

export function statsView(s: FlowStats | null | undefined) {
  return {
    matched: s?.matched ?? 0,
    runs: s?.runs ?? 0,
    runs_succeeded: s?.runsSucceeded ?? 0,
    runs_partial: s?.runsPartial ?? 0,
    runs_failed: s?.runsFailed ?? 0,
    runs_skipped: s?.runsSkipped ?? 0,
    conditions_failed: s?.conditionsFailed ?? 0,
    rate_limited: s?.rateLimited ?? 0,
    plan_limited: s?.planLimited ?? 0,
    undetermined: s?.undetermined ?? 0,
    missed: s?.missed ?? 0,
    consecutive_failures: s?.consecutiveFailures ?? 0,
    last_matched_at: iso(s?.lastMatchedAt),
    last_run_at: iso(s?.lastRunAt),
    last_finished_at: iso(s?.lastFinishedAt),
    last_error: s?.lastError ?? null,
  };
}

export function flowView(f: Flow, definition: FlowDefinition, stats: FlowStats | null | undefined, extra: { hookUrl?: string | null | undefined; full?: boolean } = {}) {
  return {
    id: f.id,
    name: f.name,
    status: f.status,
    status_reason: f.statusReason,
    version: f.currentVersion,
    trigger_type: definition.trigger.type,
    mode: definition.settings.mode,
    actions: definition.actions.map((a) => a.type),
    activated_at: iso(f.activatedAt),
    created_at: iso(f.createdAt),
    updated_at: iso(f.updatedAt),
    stats: statsView(stats),
    ...(extra.hookUrl !== undefined ? { hook_url: extra.hookUrl } : {}),
    ...(extra.full ? { definition } : {}),
  };
}

const short = (v: string) => (/^0x[0-9a-f]{12,}$/i.test(v) ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

/** One line describing the occurrence, for run lists (the full payload is in the trace). */
export function eventSummary(ev: Record<string, unknown>): string | null {
  const token = (ev.token ?? null) as { symbol?: unknown } | null;
  const symbol = typeof token?.symbol === "string" ? ` ${token.symbol}` : "";
  if (typeof ev.holder === "string") return `new holder ${short(ev.holder)}${typeof ev.amount_formatted === "string" ? ` · ${ev.amount_formatted}${symbol}` : ""}`;
  if (typeof ev.amount_formatted === "string") return `${ev.amount_formatted}${symbol}${typeof ev.from === "string" && typeof ev.to === "string" ? ` · ${short(ev.from)} → ${short(ev.to)}` : ""}`;
  if (typeof ev.scheduled_at_local === "string") return ev.scheduled_at_local;
  if (ev.body !== undefined) return JSON.stringify(ev.body).slice(0, 80);
  if (ev.current !== undefined) return `${JSON.stringify(ev.previous ?? null).slice(0, 30)} → ${JSON.stringify(ev.current).slice(0, 30)}`;
  if (typeof ev.balance_after_formatted === "string") return `balance ${ev.balance_after_formatted}${symbol} (${String(ev.direction ?? "")})`;
  if (typeof ev.contract === "string" && typeof ev.deployer === "string") return `deployed ${short(ev.contract)}`;
  const e = ev.event as { name?: unknown } | undefined;
  if (typeof e?.name === "string") return `${e.name}${typeof ev.tx_hash === "string" ? ` · ${short(ev.tx_hash)}` : ""}`;
  return typeof ev.tx_hash === "string" ? short(ev.tx_hash) : null;
}

export function runView(r: Run, steps?: readonly RunStep[]) {
  return {
    id: r.id,
    flow_id: r.flowId,
    flow_version: r.flowVersion,
    status: r.status,
    status_reason: r.statusReason,
    test: r.isTest,
    trigger_type: r.triggerType,
    attempts: r.attempts,
    created_at: iso(r.createdAt),
    started_at: iso(r.startedAt),
    finished_at: iso(r.finishedAt),
    next_attempt_at: iso(r.nextAttemptAt),
    reverted_at: iso(r.revertedAt),
    revert_reason: r.revertReason,
    summary: eventSummary(r.triggerEvent),
    tx_hash: typeof r.triggerEvent.tx_hash === "string" ? r.triggerEvent.tx_hash : null,
    ...(steps
      ? {
          trigger_event: r.triggerEvent,
          conditions_result: r.conditionsResult,
          revert_notice: r.revertNotice,
          steps: [...steps]
            .sort((a, b) => a.position - b.position)
            .map((s) => ({
              step_id: s.stepId,
              position: s.position,
              action_type: s.actionType,
              status: s.status,
              attempts: s.attempts,
              http_status: s.httpStatus,
              duration_ms: s.durationMs,
              request: s.request,
              response: s.response,
              output: s.output,
              error: s.error,
              started_at: iso(s.startedAt),
              finished_at: iso(s.finishedAt),
            })),
        }
      : {}),
  };
}

export function evaluationView(e: FlowEvaluation) {
  return {
    id: e.id,
    flow_version: e.flowVersion,
    outcome: e.outcome,
    reason: e.reason,
    trigger_event: e.triggerEvent,
    conditions_result: e.conditionsResult,
    created_at: iso(e.createdAt),
  };
}

export function connectionView(c: PublicConnection) {
  return { id: c.id, type: c.type, label: c.label, metadata: c.metadata, created_at: iso(c.createdAt) };
}

export function notificationView(n: OwnerNotification) {
  return { id: n.id, kind: n.kind, flow_id: n.flowId, message: n.message, created_at: iso(n.createdAt) };
}
