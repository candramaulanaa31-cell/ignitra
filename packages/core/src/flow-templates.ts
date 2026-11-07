import { z } from "zod";
import { isValidAddress, normalizeAddress } from "./address";
import type { ConnectionType } from "./catalog";
import { isDecimalString } from "./decimal";

/**
 * Flow templates: a flow definition with placeholders ("a flow with
 * placeholders: token address, channel, thresholds"). A placeholder is a whole
 * JSON value written as `{ "$param": "<key>" }`; instantiating replaces each
 * with the user's (validated, normalized) value. Runtime variables such as
 * {{trigger.amount_formatted}} are untouched: they are resolved per run.
 *
 * Templates never contain secrets or private destinations: connections, URLs
 * and spreadsheets are always placeholders without defaults.
 */

export const TEMPLATE_CATEGORIES = ["trading", "community", "treasury", "security", "reporting", "developers"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const PLACEHOLDER_TYPES = ["address", "decimal", "number", "text", "connection", "cron", "url", "spreadsheet", "select"] as const;
export type PlaceholderType = (typeof PLACEHOLDER_TYPES)[number];

export interface TemplatePlaceholder {
  readonly key: string;
  readonly label: string;
  readonly type: PlaceholderType;
  readonly help?: string;
  /** Used when the user leaves the field empty. */
  readonly default?: string | number | boolean;
  /** Empty → the property holding the placeholder is left out of the flow. */
  readonly optional?: boolean;
  readonly connectionType?: ConnectionType;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** A realistic value for previews and tests (never a private destination). */
  readonly example?: string | number;
}

export interface FlowTemplate {
  readonly slug: string;
  readonly name: string;
  /** One line for cards. */
  readonly summary: string;
  /** A few sentences: what it does, when it fires, what you need. */
  readonly description: string;
  readonly category: TemplateCategory;
  readonly tags: readonly string[];
  readonly placeholders: readonly TemplatePlaceholder[];
  /** Flow definition; any value may be `{ "$param": key }`. */
  readonly definition: unknown;
  /** Post for the IGNITRA X account (the template URL is appended). */
  readonly shareText?: string;
}

export interface TemplateIssue {
  readonly path: string;
  readonly message: string;
}

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

export function isMarker(v: unknown): v is { $param: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $param?: unknown }).$param === "string";
}

/** Placeholder keys a definition references, in order of appearance. */
export function templateMarkers(def: unknown, out: string[] = []): string[] {
  if (isMarker(def)) {
    if (!out.includes(def.$param)) out.push(def.$param);
  } else if (Array.isArray(def)) {
    for (const v of def) templateMarkers(v, out);
  } else if (def && typeof def === "object") {
    for (const v of Object.values(def)) templateMarkers(v, out);
  }
  return out;
}

const OMIT = Symbol("omit");

function coerce(p: TemplatePlaceholder, raw: unknown): { value: unknown } | { error: string } {
  const empty = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
  if (empty) {
    if (p.default !== undefined) {
      const { default: fallback, ...rest } = p;
      return coerce(rest, fallback);
    }
    if (p.optional) return { value: OMIT };
    return { error: "required" };
  }
  const s = typeof raw === "string" ? raw.trim() : raw;
  switch (p.type) {
    case "address":
      return typeof s === "string" && isValidAddress(s) ? { value: normalizeAddress(s) } : { error: "must be an address (0x + 40 hex)" };
    case "decimal": {
      const v = typeof s === "number" ? String(s) : s;
      return typeof v === "string" && isDecimalString(v) && !v.startsWith("-") ? { value: v } : { error: 'must be a non-negative number like "0.5"' };
    }
    case "number": {
      const n = typeof s === "number" ? s : Number(s);
      return Number.isFinite(n) ? { value: n } : { error: "must be a number" };
    }
    case "connection":
      return typeof s === "string" && /^conn_[0-9a-z]{26}$/.test(s) ? { value: s } : { error: "pick a connection" };
    case "url": {
      if (typeof s !== "string") return { error: "must be a URL" };
      try {
        const u = new URL(s);
        return u.protocol === "https:" || u.protocol === "http:" ? { value: s } : { error: "must be an http(s) URL" };
      } catch {
        return { error: "must be a URL" };
      }
    }
    case "select":
      return typeof s === "string" && (p.options ?? []).some((o) => o.value === s) ? { value: s } : { error: "pick one of the options" };
    case "spreadsheet":
    case "cron":
    case "text":
      return typeof s === "string" && s.length <= 4000 ? { value: s } : { error: "must be text (at most 4000 characters)" };
  }
}

function replace(node: unknown, values: ReadonlyMap<string, unknown>): unknown {
  if (isMarker(node)) return values.get(node.$param);
  if (Array.isArray(node)) return node.map((v) => replace(v, values)).filter((v) => v !== OMIT);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const r = replace(v, values);
      if (r !== OMIT) out[k] = r;
    }
    return out;
  }
  return node;
}

/** The user's values → a flow definition (still validated as a flow by the server). */
export function instantiateTemplate(t: Pick<FlowTemplate, "placeholders" | "definition">, values: Readonly<Record<string, unknown>>): { definition: Record<string, unknown> } | { issues: TemplateIssue[] } {
  const issues: TemplateIssue[] = [];
  const resolved = new Map<string, unknown>();
  for (const p of t.placeholders) {
    const r = coerce(p, values[p.key]);
    if ("error" in r) issues.push({ path: `values.${p.key}`, message: `${p.label}: ${r.error}` });
    else resolved.set(p.key, r.value);
  }
  for (const key of Object.keys(values)) if (!t.placeholders.some((p) => p.key === key)) issues.push({ path: `values.${key}`, message: "unknown placeholder" });
  if (issues.length > 0) return { issues };
  return { definition: replace(t.definition, resolved) as Record<string, unknown> };
}

/** Structural checks: every marker is declared, every placeholder is used, keys are unique and well-formed. */
export function checkTemplate(t: Pick<FlowTemplate, "placeholders" | "definition">): string[] {
  const issues: string[] = [];
  const used = templateMarkers(t.definition);
  const keys = t.placeholders.map((p) => p.key);
  for (const k of keys) {
    if (!KEY.test(k)) issues.push(`placeholder key "${k}" must be snake_case`);
    if (!used.includes(k)) issues.push(`placeholder "${k}" is not used in the definition`);
  }
  if (new Set(keys).size !== keys.length) issues.push("placeholder keys must be unique");
  for (const k of used) if (!keys.includes(k)) issues.push(`the definition uses "${k}" but no placeholder declares it`);
  for (const p of t.placeholders) {
    if (p.type === "connection" && !p.connectionType) issues.push(`placeholder "${p.key}" needs a connectionType`);
    if ((p.type === "connection" || p.type === "url" || p.type === "spreadsheet") && p.default !== undefined) {
      issues.push(`placeholder "${p.key}" is a private destination and cannot have a default`);
    }
  }
  return issues;
}

// ---- sharing a flow as a template -------------------------------------------------------

const CONNECTION_OF: Readonly<Record<string, ConnectionType>> = { TELEGRAM: "telegram", WEBHOOK: "webhook", EMAIL: "email", GOOGLE_SHEETS: "google", HTTP_REQUEST: "http", DISCORD: "discord" };
const CONNECTION_LABEL: Readonly<Record<ConnectionType, string>> = { telegram: "Telegram chat", webhook: "Webhook connection", email: "Email address", google: "Google account", http: "HTTP secret headers", discord: "Discord" };
const ADDRESS_LABEL: Readonly<Record<string, string>> = { token: "Token", address: "Contract", wallet: "Wallet", deployer: "Deployer", asset: "Token" };
/** How a numeric condition reads as a form field: `amount_decimal >= 5000` → "Minimum amount (token units)", key `amount_decimal_min`. */
const CONDITION_WORDS: Readonly<Record<string, { label: string; suffix: string }>> = {
  ">=": { label: "Minimum", suffix: "min" },
  ">": { label: "More than", suffix: "above" },
  "<=": { label: "Maximum", suffix: "max" },
  "<": { label: "Less than", suffix: "below" },
  "==": { label: "", suffix: "value" },
  "!=": { label: "Not", suffix: "not" },
};
const FIELD_LABEL: Readonly<Record<string, string>> = {
  amount: "amount (base units)",
  amount_decimal: "amount (token units)",
  percent_of_supply: "% of supply",
  balance: "balance (base units)",
  balance_decimal: "balance (token units)",
  delta: "change",
  "time.hour_wib": "hour (WIB)",
  "time.minutes_wib": "minutes after midnight (WIB)",
  "time.weekday_wib": "weekday (WIB, 1 = Monday)",
};
const HEX40 = /^0x[0-9a-fA-F]{40}$/;

interface DefinitionLike {
  trigger: { type: string; params: Record<string, unknown> };
  conditions?: unknown;
  actions: Array<{ step_id: string; type: string; params: Record<string, unknown> }>;
  settings?: unknown;
}

/**
 * Turns a saved flow into a shareable template:
 *   - connections, webhook / HTTP URLs, spreadsheets → placeholders WITHOUT defaults (private)
 *   - trigger and contract addresses, numeric thresholds, cron → placeholders WITH defaults (public)
 *   - message texts, functions, events, settings → kept as they are
 */
export function deriveTemplate(def: DefinitionLike): { placeholders: TemplatePlaceholder[]; definition: DefinitionLike } {
  const placeholders: TemplatePlaceholder[] = [];
  const key = (base: string) => {
    const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "value";
    const start = /^[a-z]/.test(clean) ? clean : `v_${clean}`;
    let k = start;
    for (let i = 2; placeholders.some((p) => p.key === k); i++) k = `${start}_${i}`;
    return k;
  };
  const add = (p: Omit<TemplatePlaceholder, "key"> & { base: string }) => {
    const { base, ...rest } = p;
    const k = key(base);
    placeholders.push({ key: k, ...rest });
    return { $param: k };
  };

  const trigger = { type: def.trigger.type, params: { ...def.trigger.params } };
  for (const [k, v] of Object.entries(trigger.params)) {
    if (typeof v === "string" && HEX40.test(v)) trigger.params[k] = add({ base: k, label: ADDRESS_LABEL[k] ?? k, type: "address", default: v, example: v });
    else if (k === "cron" && typeof v === "string") trigger.params[k] = add({ base: "schedule", label: "Schedule (cron)", type: "cron", default: v });
    else if (k === "threshold" && (typeof v === "string" || typeof v === "number")) trigger.params[k] = add({ base: "threshold", label: "Threshold", type: "decimal", default: String(v) });
  }

  const conditions = mapLeaves(def.conditions, (leaf) => {
    const v = leaf.value;
    if (typeof v === "number" || (typeof v === "string" && isDecimalString(v) && !HEX40.test(v))) {
      const field = String(leaf.field);
      const op = CONDITION_WORDS[String(leaf.op)] ?? { label: "", suffix: "value" };
      const what = FIELD_LABEL[field] ?? field;
      return {
        ...leaf,
        value: add({ base: `${field.split(".").pop()}_${op.suffix}`, label: op.label ? `${op.label} ${what}` : what.charAt(0).toUpperCase() + what.slice(1), type: typeof v === "number" ? "number" : "decimal", default: v }),
      };
    }
    return leaf;
  });

  const actions = def.actions.map((a) => {
    const params: Record<string, unknown> = { ...a.params };
    if (typeof params.connection_id === "string") {
      const type = CONNECTION_OF[a.type] ?? "webhook";
      params.connection_id = add({ base: type === "telegram" ? "telegram_chat" : `${type}_connection`, label: CONNECTION_LABEL[type], type: "connection", connectionType: type });
    }
    if (a.type === "WEBHOOK" && typeof params.url === "string") params.url = add({ base: "webhook_url", label: "Webhook URL", type: "url" });
    if (a.type === "HTTP_REQUEST" && typeof params.url === "string") params.url = add({ base: "api_url", label: "API URL", type: "text", help: "may use variables, e.g. …/orders/{{trigger.body.order}}" });
    if (a.type === "GOOGLE_SHEETS" && typeof params.spreadsheet === "string") params.spreadsheet = add({ base: "spreadsheet", label: "Spreadsheet", type: "spreadsheet" });
    if (a.type === "CHAIN_READ" && typeof params.address === "string" && HEX40.test(params.address)) params.address = add({ base: "read_contract", label: "Contract to read", type: "address", default: params.address });
    return { ...a, params };
  });

  return { placeholders, definition: { trigger, ...(conditions !== undefined ? { conditions } : {}), actions, ...(def.settings !== undefined ? { settings: def.settings } : {}) } };
}

function mapLeaves(node: unknown, fn: (leaf: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.all)) return { all: n.all.map((c) => mapLeaves(c, fn)) };
  if (Array.isArray(n.any)) return { any: n.any.map((c) => mapLeaves(c, fn)) };
  if (typeof n.field === "string") return fn(n);
  return node;
}

// ---- a readable outline ("WHEN … IF … THEN …") ---------------------------------------------

const OPS: Readonly<Record<string, string>> = { "==": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤", IN: "in", NOT_IN: "not in", CONTAINS: "contains", EXISTS: "exists" };
const TYPE_LABEL: Readonly<Record<string, string>> = {
  TOKEN_TRANSFER: "Token transfer",
  CONTRACT_EVENT: "Contract event",
  NEW_HOLDER: "New holder",
  BALANCE_THRESHOLD: "Balance crosses a threshold",
  CONTRACT_DEPLOYED: "Contract deployed",
  STATE_CHANGE: "Contract state changes",
  SCHEDULE: "Schedule",
  INBOUND_WEBHOOK: "Inbound webhook",
  WEBHOOK: "Webhook",
  TELEGRAM: "Telegram",
  WEB_PUSH: "Web Push",
  CHAIN_READ: "Read contract",
  HTTP_REQUEST: "HTTP request",
  EMAIL: "Email",
  GOOGLE_SHEETS: "Google Sheets",
};

/**
 * Short, human outline of a definition; placeholders show as ‹label›.
 * `hideTargets`: for real flows shown publicly — connections, URLs and spreadsheets are left out.
 */
export function outlineDefinition(
  def: unknown,
  placeholders: readonly TemplatePlaceholder[] = [],
  opts: { hideTargets?: boolean } = {},
): Array<{ kind: "WHEN" | "IF" | "AND" | "OR" | "THEN"; text: string }> {
  const d = (def ?? {}) as DefinitionLike;
  const show = (v: unknown): string => {
    if (isMarker(v)) return `‹${placeholders.find((p) => p.key === v.$param)?.label ?? v.$param}›`;
    if (typeof v === "string") return HEX40.test(v) ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
    return JSON.stringify(v);
  };
  /** `function balanceOf(address account) view returns (uint256)` → `balanceOf(address account)` */
  const sig = (v: unknown): string => {
    if (typeof v !== "string") return show(v);
    const body = v.replace(/^(event|function)\s+/, "").split(/\s+returns\b/)[0] ?? v;
    const close = body.lastIndexOf(")");
    return /^\w+\s*\(/.test(body) && close > 0 ? body.slice(0, close + 1) : body;
  };
  const lines: Array<{ kind: "WHEN" | "IF" | "AND" | "OR" | "THEN"; text: string }> = [];
  const tp = d.trigger?.params ?? {};
  const subject = ["token", "address", "wallet", "deployer", "cron"].filter((k) => tp[k] !== undefined).map((k) => `${k === "cron" ? "" : `${k} `}${show(tp[k])}`);
  lines.push({ kind: "WHEN", text: `${TYPE_LABEL[d.trigger?.type ?? ""] ?? d.trigger?.type ?? "?"}${subject.length ? ` · ${subject.join(" · ")}` : ""}${tp.event ? ` · ${sig(tp.event)}` : ""}${tp.function ? ` · ${sig(tp.function)}` : ""}` });
  const c = d.conditions as { all?: unknown[]; any?: unknown[] } | undefined;
  const leaves = (c?.all ?? c?.any ?? []) as Array<{ field?: string; op?: string; value?: unknown }>;
  leaves.forEach((l, i) => {
    if (!l || typeof l.field !== "string") return;
    lines.push({ kind: i === 0 ? "IF" : c?.any ? "OR" : "AND", text: `${l.field} ${OPS[l.op ?? ""] ?? l.op ?? ""}${l.value === undefined ? "" : ` ${show(l.value)}`}` });
  });
  for (const a of d.actions ?? []) {
    const fn = a.params?.function;
    const target = opts.hideTargets ? fn : (a.params?.connection_id ?? a.params?.url ?? a.params?.spreadsheet ?? fn);
    lines.push({ kind: "THEN", text: `${TYPE_LABEL[a.type] ?? a.type}${target !== undefined ? ` → ${target === fn ? sig(target) : show(target)}` : ""}` });
  }
  return lines;
}

// ---- user-published templates (API input) ----------------------------------------------

export const publishTemplateSchema = z
  .object({
    flow_id: z.string().regex(/^fl_[0-9a-z]{26}$/),
    name: z.string().trim().min(3).max(80),
    summary: z.string().trim().min(10).max(160),
    description: z.string().trim().max(2000).default(""),
    category: z.enum(TEMPLATE_CATEGORIES),
    tags: z.array(z.string().trim().min(1).max(24).regex(/^[a-z0-9-]+$/)).max(6).default([]),
    visibility: z.enum(["unlisted", "public"]).default("unlisted"),
  })
  .strict();
