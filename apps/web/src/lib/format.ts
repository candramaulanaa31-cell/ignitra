import { DEFAULT_TIMEZONE, formatInTimeZone } from "@ignitra/core";
import type { RunStatus } from "./types";

/** Display helpers. Data stays UTC; it is shown in the user's timezone (default WIB). */

export function when(iso: string | null | undefined, tz: string = DEFAULT_TIMEZONE): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : formatInTimeZone(d, tz);
}

/** "12 s ago", "5 min ago", "3 h ago", else the date. */
export function ago(iso: string | null | undefined, now = Date.now(), tz: string = DEFAULT_TIMEZONE): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return when(iso, tz).slice(0, 16);
}

export function duration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return "—";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

export const shortHex = (v: string, head = 6, tail = 4): string => (/^0x[0-9a-fA-F]{12,}$/.test(v) && v.length > head + tail + 2 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v);

/** CSS class of a status: succeeded green · partial amber · failed red · skipped gray · queued/running blue. */
export function statusClass(status: string): string {
  switch (status) {
    case "succeeded":
    case "active":
    case "ok":
      return "s-ok";
    case "partial":
    case "paused":
    case "plan_limited":
    case "rate_limited":
      return "s-partial";
    case "failed":
    case "disabled":
    case "undetermined":
      return "s-fail";
    case "queued":
    case "running":
    case "pending":
      return "s-live";
    default:
      return "s-skip";
  }
}

export const FINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "partial", "failed", "skipped"]);

export const LABELS: Readonly<Record<string, string>> = {
  TOKEN_TRANSFER: "Token transfer",
  CONTRACT_EVENT: "Contract event",
  NEW_HOLDER: "New holder",
  BALANCE_THRESHOLD: "Balance threshold",
  CONTRACT_DEPLOYED: "Contract deployed",
  STATE_CHANGE: "State change",
  SCHEDULE: "Schedule",
  INBOUND_WEBHOOK: "Inbound webhook",
  WEBHOOK: "Webhook",
  TELEGRAM: "Telegram",
  WEB_PUSH: "Web Push",
  CHAIN_READ: "Read contract",
  HTTP_REQUEST: "HTTP request",
  EMAIL: "Email",
  GOOGLE_SHEETS: "Google Sheets",
  conditions_failed: "conditions failed",
  rate_limited: "hourly cap",
  plan_limited: "plan quota",
  undetermined: "undetermined",
  missed: "missed",
};

export const label = (type: string): string => LABELS[type] ?? type;
