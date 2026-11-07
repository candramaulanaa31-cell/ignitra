/**
 * Template renderer — pure, safe, deterministic (rule 4).
 *
 *   🔥 New buy: {{trigger.amount_formatted}} {{trigger.token.symbol | default: "?"}}
 *   Tx: {{trigger.explorer_url}}     From: {{trigger.from | short}}
 *
 * Safety model:
 *   - No code execution: the only syntax is `{{ path | filter: arg | … }}`.
 *     Paths read OWN properties only (no prototype chain, no getters invoked
 *     on class instances), filters are a fixed allow-list.
 *   - Substituted values are escaped for the output context (`html` for
 *     Telegram HTML mode); literal template text is the user's own markup.
 *   - Bounded: template length, placeholder count and output length.
 *   - A variable that does not exist is an error (a typo must not send a
 *     half-empty alert); a variable that exists but is null renders "".
 *   - `\{{` renders a literal `{{`.
 */

/**
 * How substituted values are escaped (the template's literal text is never touched):
 *   html   — Telegram HTML mode: values cannot inject markup
 *   json   — inside a JSON document: values are JSON-string escaped (no quotes added)
 *   sheets — spreadsheet cells: values that would be read as a formula (=, +, -, @)
 *            get a leading apostrophe, so on-chain data cannot run IMPORTXML & co.
 */
export type TemplateEscape = "none" | "html" | "json" | "sheets";

export type TemplateErrorCode = "syntax" | "unknown_variable" | "unknown_filter" | "bad_argument" | "too_long";

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;

  constructor(code: TemplateErrorCode, message: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

export const TEMPLATE_LIMITS = {
  maxTemplateLength: 10_000,
  maxPlaceholders: 200,
  maxOutputLength: 20_000,
} as const;

export const TEMPLATE_FILTERS = ["default", "upper", "lower", "short", "json", "url", "truncate"] as const;
export type TemplateFilter = (typeof TEMPLATE_FILTERS)[number];

interface FilterCall {
  readonly name: TemplateFilter;
  readonly arg: string | number | null;
}

interface Placeholder {
  readonly path: readonly string[];
  readonly filters: readonly FilterCall[];
}

type Segment = { readonly text: string } | { readonly placeholder: Placeholder };

const PATH_RE = /^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/i;
const FILTER_RE = /^([a-z_]+)\s*(?::\s*(.+))?$/i;

function parseArg(raw: string | undefined, filter: string): string | number | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(v) ?? /^'((?:[^'\\]|\\.)*)'$/.exec(v);
  if (quoted) return (quoted[1] ?? "").replace(/\\(.)/g, "$1");
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  throw new TemplateError("bad_argument", `filter "${filter}": argument must be a quoted string or a number`);
}

/** Splits on `|` outside quotes. */
function splitPipes(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i] ?? "";
    if (quote) {
      if (c === "\\") {
        current += c + (expr[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (quote) throw new TemplateError("syntax", "unterminated string in template expression");
  parts.push(current);
  return parts;
}

function parsePlaceholder(expr: string): Placeholder {
  const [rawPath = "", ...rawFilters] = splitPipes(expr);
  const path = rawPath.trim();
  if (!PATH_RE.test(path)) throw new TemplateError("syntax", `invalid variable "${path || expr.trim()}" — use a dotted path like trigger.amount_formatted`);
  const filters = rawFilters.map((f): FilterCall => {
    const m = FILTER_RE.exec(f.trim());
    const name = (m?.[1] ?? "").toLowerCase();
    if (!m || !(TEMPLATE_FILTERS as readonly string[]).includes(name)) {
      throw new TemplateError("unknown_filter", `unknown filter "${f.trim()}" (available: ${TEMPLATE_FILTERS.join(", ")})`);
    }
    const arg = parseArg(m[2], name);
    if (name === "truncate" && (typeof arg !== "number" || arg < 1 || !Number.isInteger(arg))) {
      throw new TemplateError("bad_argument", "truncate needs a positive whole number, e.g. truncate: 80");
    }
    if (name === "default" && arg === null) throw new TemplateError("bad_argument", 'default needs a value, e.g. default: "n/a"');
    return { name: name as TemplateFilter, arg };
  });
  return { path: path.split("."), filters };
}

const cache = new Map<string, readonly Segment[]>();

export function parseTemplate(template: string): readonly Segment[] {
  const hit = cache.get(template);
  if (hit) return hit;
  if (template.length > TEMPLATE_LIMITS.maxTemplateLength) {
    throw new TemplateError("too_long", `template exceeds ${TEMPLATE_LIMITS.maxTemplateLength} characters`);
  }
  const segments: Segment[] = [];
  let text = "";
  let placeholders = 0;
  for (let i = 0; i < template.length; ) {
    if (template.startsWith("\\{{", i)) {
      text += "{{";
      i += 3;
      continue;
    }
    if (template.startsWith("{{", i)) {
      const end = template.indexOf("}}", i + 2);
      if (end < 0) throw new TemplateError("syntax", `unclosed "{{" at position ${i}`);
      if (text) segments.push({ text });
      text = "";
      segments.push({ placeholder: parsePlaceholder(template.slice(i + 2, end)) });
      if (++placeholders > TEMPLATE_LIMITS.maxPlaceholders) throw new TemplateError("too_long", `more than ${TEMPLATE_LIMITS.maxPlaceholders} variables`);
      i = end + 2;
      continue;
    }
    text += template[i];
    i++;
  }
  if (text) segments.push({ text });
  if (cache.size > 500) cache.clear();
  cache.set(template, segments);
  return segments;
}

/** Variable paths a template references (for save-time validation). */
export function templateVariables(template: string): string[] {
  return parseTemplate(template).flatMap((s) => ("placeholder" in s ? [s.placeholder.path.join(".")] : []));
}

const MISSING = Symbol("missing");

/** Own-property lookup on plain data; arrays accept numeric segments. */
function resolve(scope: unknown, path: readonly string[]): unknown {
  let current: unknown = scope;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return MISSING;
      const index = Number(segment);
      if (index >= current.length) return MISSING;
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object") return MISSING;
    const proto = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) return MISSING; // only plain data objects
    if (!Object.hasOwn(current, segment)) return MISSING;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ?? "";
  } catch {
    return "";
  }
}

function applyFilter(value: unknown, f: FilterCall): unknown {
  switch (f.name) {
    case "default":
      return value === null || value === undefined || value === "" ? f.arg : value;
    case "upper":
      return toText(value).toUpperCase();
    case "lower":
      return toText(value).toLowerCase();
    case "short": {
      const s = toText(value);
      return /^0x[0-9a-f]{12,}$/i.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
    }
    case "json":
      return JSON.stringify(value === undefined ? null : value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ?? "null";
    case "url":
      return encodeURIComponent(toText(value));
    case "truncate": {
      const s = toText(value);
      const n = typeof f.arg === "number" ? f.arg : s.length;
      return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
    }
  }
}

const escapeJson = (s: string): string => JSON.stringify(s).slice(1, -1);

/** Numbers stay numbers; anything else a spreadsheet would evaluate becomes literal text. */
const escapeSheets = (s: string): string => (/^[-+]?\d+(\.\d+)?$/.test(s) || !/^[=+\-@\t\r]/.test(s) ? s : `'${s}`);

function escapeValue(text: string, mode: TemplateEscape | undefined): string {
  switch (mode) {
    case "html":
      return escapeHtml(text);
    case "json":
      return escapeJson(text);
    case "sheets":
      return escapeSheets(text);
    default:
      return text;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderTemplate(template: string, scope: Record<string, unknown>, opts: { escape?: TemplateEscape } = {}): string {
  let out = "";
  for (const segment of parseTemplate(template)) {
    if ("text" in segment) {
      out += segment.text;
    } else {
      const { path, filters } = segment.placeholder;
      let value: unknown = resolve(scope, path);
      if (value === MISSING) {
        if (!filters.some((f) => f.name === "default")) {
          throw new TemplateError("unknown_variable", `unknown variable "${path.join(".")}"`);
        }
        value = undefined;
      }
      for (const f of filters) value = applyFilter(value, f);
      const text = toText(value);
      out += escapeValue(text, opts.escape);
    }
    if (out.length > TEMPLATE_LIMITS.maxOutputLength) {
      throw new TemplateError("too_long", `rendered output exceeds ${TEMPLATE_LIMITS.maxOutputLength} characters`);
    }
  }
  return out;
}
