import { Cron } from "croner";
import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, DEFAULT_TIMEZONE, formatInTimeZone, isValidTimeZone, type FieldSpec } from "@ignitra/core";
import { timeFields } from "../evidence";
import type { ScheduleTriggerModule } from "../types";

/**
 * SCHEDULE — fires on a cron schedule, in a timezone (default Asia/Jakarta = WIB).
 *
 *   { "cron": "0 9 * * 1-5" }                          09:00 WIB, Monday to Friday
 *   { "cron": "0,30 * * * *", "timezone": "UTC" }      every half hour
 *
 * Standard 5-field cron (minute resolution) plus nicknames (@hourly, @daily,
 * @weekly, @monthly, @yearly) and L / W / # (last day, nearest weekday, nth
 * weekday). Day-of-month and day-of-week combine with OR, as in classic cron.
 * A local time skipped by a DST jump fires once, at the next valid time.
 *
 * Reliability: the matcher stores the last fired time. After downtime only the
 * latest due time fires (within the grace window); earlier ones are recorded as
 * `missed`. Each time fires at most once per flow (run key `schedule:<iso>`).
 */

const compiled = new Map<string, Cron>();

function compile(cron: string, timezone: string): Cron {
  const key = `${timezone}|${cron}`;
  let c = compiled.get(key);
  if (!c) {
    c = new Cron(cron, { timezone, mode: "5-part", paused: true });
    if (compiled.size > 5000) compiled.clear();
    compiled.set(key, c);
  }
  return c;
}

const cronMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Cron\w*:\s*/, "");

/** Smallest gap between the next `samples` occurrences after `from`. */
export function shortestInterval(cron: string, timezone: string, from: Date = new Date(), samples = 200): number | null {
  const runs = compile(cron, timezone).nextRuns(samples, from);
  let min: number | null = null;
  for (let i = 1; i < runs.length; i++) {
    const gap = (runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime();
    if (min === null || gap < min) min = gap;
  }
  return min;
}

export const scheduleParams = z
  .object({
    cron: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .superRefine((cron, ctx) => {
        try {
          compile(cron, "UTC");
        } catch (err) {
          ctx.addIssue({ code: "custom", message: `invalid cron expression: ${cronMessage(err)} (5 fields: minute hour day-of-month month day-of-week)` });
        }
      }),
    timezone: z
      .string()
      .trim()
      .default(DEFAULT_TIMEZONE)
      .refine(isValidTimeZone, { message: "must be an IANA timezone such as Asia/Jakarta or UTC" }),
  })
  .strict()
  .superRefine((p, ctx) => {
    try {
      if (compile(p.cron, p.timezone).nextRun(new Date()) === null) ctx.addIssue({ code: "custom", path: ["cron"], message: "this schedule never fires" });
    } catch {
      // reported by the field refinement
    }
  });

export type ScheduleParams = z.output<typeof scheduleParams>;

const TIME_FIELDS = CHAIN_EVIDENCE_FIELDS.filter((f) => f.path.startsWith("time."));

const FIELDS: readonly FieldSpec[] = [
  { path: "scheduled_at", type: "timestamp", description: "Scheduled time of this occurrence, ISO-8601 UTC" },
  { path: "scheduled_at_local", type: "string", description: "Scheduled time in the schedule's timezone, e.g. 2026-11-07 09:00:00 WIB" },
  { path: "fired_at", type: "timestamp", description: "When the scheduler fired it, ISO-8601 UTC" },
  { path: "delay_ms", type: "number", description: "fired_at minus scheduled_at, in milliseconds" },
  { path: "next_at", type: "timestamp", description: "Next scheduled time, ISO-8601 UTC", nullable: true },
  { path: "cron", type: "string", description: "The cron expression" },
  { path: "timezone", type: "string", description: "The schedule's timezone" },
  ...TIME_FIELDS,
];

export const scheduleTrigger: ScheduleTriggerModule<ScheduleParams> = {
  type: "SCHEDULE",
  kind: "schedule",
  label: "Schedule",
  description: "Runs on a cron schedule in your timezone (default WIB), e.g. every weekday at 09:00.",
  source: "schedule",
  supportsFast: false,
  paramsSchema: scheduleParams,
  fields: () => FIELDS,

  next: (p, after) => compile(p.cron, p.timezone).nextRun(after),

  latest(p, at) {
    // previousRuns() is strictly-before with second resolution: look one second past `at`.
    const [slot] = compile(p.cron, p.timezone).previousRuns(1, new Date(at.getTime() + 1000));
    return slot && slot.getTime() <= at.getTime() ? slot : null;
  },

  minIntervalMs: (p) => shortestInterval(p.cron, p.timezone),

  payload(p, slot, firedAt) {
    const next = compile(p.cron, p.timezone).nextRun(slot);
    return {
      scheduled_at: slot.toISOString(),
      scheduled_at_local: formatInTimeZone(slot, p.timezone),
      fired_at: firedAt.toISOString(),
      delay_ms: Math.max(0, firedAt.getTime() - slot.getTime()),
      next_at: next ? next.toISOString() : null,
      cron: p.cron,
      timezone: p.timezone,
      time: timeFields(Math.floor(slot.getTime() / 1000)),
    };
  },
};
