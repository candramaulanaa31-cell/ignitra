import type { ActionType, Plan, TriggerType } from "./catalog";

/**
 * Plan limits (spec §10). Enforced server-side:
 *   activeFlows   — flows that may be active at once (paused drafts don't count)
 *   runsPerMonth  — runs created per calendar month (UTC); test runs don't count
 *   overage       — over the monthly limit: keep running and meter (paid) or stop (free)
 *   minScheduleMinutes — shortest interval a SCHEDULE trigger may fire at
 *   lockedTriggers / lockedActions — features of higher plans (spec §10: Builder adds
 *                  Sheets, email and schedule)
 */
export interface PlanLimits {
  readonly activeFlows: number | null;
  readonly runsPerMonth: number;
  readonly overage: boolean;
  readonly minScheduleMinutes: number;
  readonly lockedTriggers: readonly TriggerType[];
  readonly lockedActions: readonly ActionType[];
}

export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: { activeFlows: 3, runsPerMonth: 500, overage: false, minScheduleMinutes: 15, lockedTriggers: ["SCHEDULE"], lockedActions: ["EMAIL", "GOOGLE_SHEETS"] },
  builder: { activeFlows: 20, runsPerMonth: 10_000, overage: true, minScheduleMinutes: 1, lockedTriggers: [], lockedActions: [] },
  team: { activeFlows: null, runsPerMonth: 100_000, overage: true, minScheduleMinutes: 1, lockedTriggers: [], lockedActions: [] },
};

/** The cheapest plan that unlocks a trigger or action type (for upgrade hints). */
export function planFor(feature: TriggerType | ActionType): Plan {
  for (const plan of ["free", "builder", "team"] as const) {
    const l = PLAN_LIMITS[plan];
    if (!(l.lockedTriggers as readonly string[]).includes(feature) && !(l.lockedActions as readonly string[]).includes(feature)) return plan;
  }
  return "team";
}

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
