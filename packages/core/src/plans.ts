import type { Plan } from "./catalog";

/**
 * Plan limits (spec §10). Enforced server-side:
 *   activeFlows   — flows that may be active at once (paused drafts don't count)
 *   runsPerMonth  — runs created per calendar month (UTC); test runs don't count
 *   overage       — over the monthly limit: keep running and meter (paid) or stop (free)
 *   minScheduleMinutes — shortest interval a SCHEDULE trigger may fire at
 */
export interface PlanLimits {
  readonly activeFlows: number | null;
  readonly runsPerMonth: number;
  readonly overage: boolean;
  readonly minScheduleMinutes: number;
}

export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: { activeFlows: 3, runsPerMonth: 500, overage: false, minScheduleMinutes: 15 },
  builder: { activeFlows: 20, runsPerMonth: 10_000, overage: true, minScheduleMinutes: 1 },
  team: { activeFlows: null, runsPerMonth: 100_000, overage: true, minScheduleMinutes: 1 },
};

export function planLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.free;
}

/** Usage period key: calendar month in UTC, e.g. "2026-11". */
export function usagePeriod(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/** First instant of the next usage period (when quotas reset). */
export function nextPeriodStart(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}
