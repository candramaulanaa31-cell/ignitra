/**
 * Time rules: store and transmit UTC (ISO-8601 / timestamptz). Convert to a
 * user timezone only at the display edge. Default display zone is WIB.
 */

export const DEFAULT_TIMEZONE = "Asia/Jakarta";

/** Indonesian zone abbreviations; Intl renders these as "GMT+7" etc. in most locales. */
const ZONE_LABELS: Readonly<Record<string, string>> = {
  "Asia/Jakarta": "WIB",
  "Asia/Pontianak": "WIB",
  "Asia/Makassar": "WITA",
  "Asia/Jayapura": "WIT",
  UTC: "UTC",
  "Etc/UTC": "UTC",
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function zoneLabel(date: Date, timeZone: string): string {
  const known = ZONE_LABELS[timeZone];
  if (known) return known;
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/** `2026-11-05 08:00:00 WIB` */
export function formatInTimeZone(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${zoneLabel(date, timeZone)}`;
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}
