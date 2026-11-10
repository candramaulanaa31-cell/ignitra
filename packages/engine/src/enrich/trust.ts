import { evaluateConditions, normalizeAddress, type ConditionNode, type FieldSpec, type FlowDefinition, type NormalizedAddress } from "@ignitra/core";
import type { Payload } from "../types";

/**
 * TRUST LAYER integration (Phase 8): `counterparty_trust_score >= X` and friends.
 *
 * Trust Layer is a reputation service for Robinhood Chain: `GET /v1/risk/:address` answers a
 * Trust Score 0–1000 (higher = more trustworthy), its band and risk level; `202` while the
 * address is still being indexed. It never invents a score, and neither does IGNITRA: every
 * case that is not a real score keeps `*_trust_score` null and says why in `*_trust_status`.
 *
 * Scores are fetched lazily: only for flows whose conditions or templates read them, and not
 * at all when the other conditions already fail. Results are cached per address.
 */

export type TrustStatus =
  | "scored"
  | "provisional"
  | "insufficient_data"
  /** Trust Layer is indexing the address (it answered 202); a later event may be scored. */
  | "pending"
  /** A system address Trust Layer does not score. */
  | "not_a_subject"
  /**
   * Not configured, unreachable, rate limited, or slower than the wait. A slow answer still lands
   * in the cache when it arrives, so the next event from that address is scored.
   */
  | "unavailable"
  /** Not looked up: the flow's other conditions failed anyway. */
  | "skipped"
  /** This event has no such party (e.g. no counterparty without a watched wallet). */
  | "not_applicable";

export interface TrustResult {
  readonly status: TrustStatus;
  readonly score: number | null;
  readonly band: string | null;
  readonly risk_level: string | null;
}

export interface TrustLookupOptions {
  /** How long this caller waits for an answer, in ms (the client's default otherwise). */
  readonly waitMs?: number;
}

export interface TrustLookup {
  /** Never throws: failures come back as `unavailable`. */
  score(address: NormalizedAddress, options?: TrustLookupOptions): Promise<TrustResult>;
}

/** Parties each trigger offers for scoring. `counterparty` is the side other than the watched one. */
export const TRUST_ROLES: Readonly<Record<string, readonly string[]>> = {
  TOKEN_TRANSFER: ["counterparty", "from", "to"],
  NEW_HOLDER: ["counterparty"],
  NEW_LAUNCH: ["counterparty"],
  VIGIL_ALERT: ["counterparty"],
};

const ROLE_TEXT: Readonly<Record<string, string>> = {
  counterparty: "the counterparty",
  from: "the sender",
  to: "the recipient",
};

/** Field specs for a trigger's scorable parties. */
export function trustFields(roles: readonly string[]): FieldSpec[] {
  return roles.flatMap((role): FieldSpec[] => [
    { path: `${role}_trust_score`, type: "number", description: `TRUST LAYER score of ${ROLE_TEXT[role] ?? role}, 0–1000 (higher = more trustworthy)`, nullable: true },
    { path: `${role}_trust_band`, type: "string", description: `TRUST LAYER band of ${ROLE_TEXT[role] ?? role}, e.g. strong or high_risk`, nullable: true },
    {
      path: `${role}_trust_status`,
      type: "string",
      description: "scored · provisional · insufficient_data · pending (still indexing) · not_a_subject · unavailable · skipped · not_applicable",
    },
  ]);
}

const USE_RE = /\b([a-z]+)_trust_(?:score|band|status)\b/g;
const rolesCache = new WeakMap<object, readonly string[]>();

/** The scored parties a flow reads in its conditions or templates. */
export function trustRolesUsed(def: FlowDefinition): readonly string[] {
  const cached = rolesCache.get(def);
  if (cached) return cached;
  const allowed = TRUST_ROLES[def.trigger.type] ?? [];
  const found = new Set<string>();
  for (const m of JSON.stringify({ c: def.conditions ?? null, a: def.actions }).matchAll(USE_RE)) if (m[1] && allowed.includes(m[1])) found.add(m[1]);
  const roles = [...found];
  rolesCache.set(def, roles);
  return roles;
}

const isTrustField = (field: string) => /^[a-z]+_trust_(?:score|band|status)$/.test(field);

/** Three-valued: false only when the conditions fail whatever the trust values turn out to be. */
function couldPass(node: ConditionNode, payload: Payload): boolean {
  if ("all" in node) return node.all.every((n) => couldPass(n, payload));
  if ("any" in node) return node.any.some((n) => couldPass(n, payload));
  if (isTrustField(node.field)) return true;
  return evaluateConditions({ all: [node] }, payload).passed;
}

const result = (status: TrustStatus): TrustResult => ({ status, score: null, band: null, risk_level: null });

/** Adds `<role>_trust_*` fields the flow reads. Returns a new payload; never throws. */
export async function enrichWithTrust(def: FlowDefinition, payload: Payload, lookup: TrustLookup | null, options?: TrustLookupOptions): Promise<Payload> {
  const roles = trustRolesUsed(def);
  if (roles.length === 0) return payload;
  const skip = def.conditions !== undefined && !couldPass(def.conditions, payload);
  const out: Payload = { ...payload };
  await Promise.all(
    roles.map(async (role) => {
      const raw = role === "counterparty" ? payload.counterparty : payload[role];
      let r: TrustResult;
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) r = result("not_applicable");
      else if (skip) r = result("skipped");
      else if (!lookup) r = result("unavailable");
      else r = await lookup.score(normalizeAddress(raw), options);
      out[`${role}_trust_score`] = r.score;
      out[`${role}_trust_band`] = r.band;
      out[`${role}_trust_status`] = r.status;
    }),
  );
  return out;
}

// ---- the Trust Layer client -------------------------------------------------------

export interface TrustLayerOptions {
  /** e.g. https://trust.example or http://127.0.0.1:4000 (operator configuration). */
  readonly baseUrl: string;
  /** `tl_live_…`, optional unless the Trust Layer instance requires keys. */
  readonly apiKey?: string | null;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * How long a lookup waits for an answer by default (8 s). Past it the caller gets `unavailable`
   * and moves on, so a slow Trust Layer never holds the matcher longer than this.
   */
  readonly waitMs?: number;
  /**
   * How long the request itself may run (20 s). It outlives the wait on purpose: Trust Layer
   * computes a stale score on request (seconds when cold, milliseconds once warm), and an answer
   * that arrives late is cached for the next event from that address.
   */
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly now?: () => number;
}

const TTL_MS: Readonly<Record<TrustStatus, number>> = {
  scored: 10 * 60_000,
  provisional: 5 * 60_000,
  insufficient_data: 10 * 60_000,
  pending: 2 * 60_000,
  not_a_subject: 60 * 60_000,
  unavailable: 30_000,
  skipped: 0,
  not_applicable: 0,
};
const SCORE_STATUSES = new Set(["scored", "provisional", "insufficient_data"]);
const MAX_CACHED = 20_000;

/** How long a 429 asks us to wait: Retry-After in seconds or as a date; 30 s if absent, 10 min at most. */
export function retryAfterMs(header: string | null, nowMs: number): number {
  let ms = 30_000;
  if (header && /^\d+$/.test(header.trim())) ms = Number(header.trim()) * 1000;
  else if (header && Number.isFinite(Date.parse(header))) ms = Date.parse(header) - nowMs;
  return Math.min(10 * 60_000, Math.max(1000, ms));
}

export function createTrustLayerClient(opts: TrustLayerOptions): TrustLookup {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? 8000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxConcurrent = opts.maxConcurrent ?? 4;
  const cache = new Map<string, { value: TrustResult; until: number }>();
  const inflight = new Map<string, Promise<TrustResult>>();
  let active = 0;
  const queue: Array<() => void> = [];
  // Circuit breaker: after repeated failures, answer `unavailable` without calling for a while.
  let failures = 0;
  let downUntil = 0;

  const slot = async () => {
    if (active < maxConcurrent) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    active++;
  };
  const release = () => {
    active--;
    queue.shift()?.();
  };

  async function fetchScore(address: NormalizedAddress): Promise<TrustResult> {
    if (now() < downUntil) return result("unavailable");
    await slot();
    try {
      const res = await fetchFn(`${base}/v1/risk/${address}`, {
        headers: { accept: "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 202 || res.status === 422) {
        failures = 0;
        await res.body?.cancel();
        return result(res.status === 202 ? "pending" : "not_a_subject");
      }
      if (res.status === 429) {
        // Rate limited: stop asking about ANY address for as long as Trust Layer says.
        downUntil = now() + retryAfterMs(res.headers.get("retry-after"), now());
        failures = 0;
        await res.body?.cancel();
        return result("unavailable");
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status?: unknown; trust_score?: unknown; band?: unknown; risk_level?: unknown };
      failures = 0;
      const status = typeof body.status === "string" && SCORE_STATUSES.has(body.status) ? (body.status as TrustStatus) : "insufficient_data";
      return {
        status,
        score: typeof body.trust_score === "number" && Number.isFinite(body.trust_score) ? body.trust_score : null,
        band: typeof body.band === "string" ? body.band : null,
        risk_level: typeof body.risk_level === "string" ? body.risk_level : null,
      };
    } catch {
      if (++failures >= 5) {
        downUntil = now() + 30_000;
        failures = 0;
      }
      return result("unavailable");
    } finally {
      release();
    }
  }

  /** The answer if it comes within `ms`; otherwise `unavailable` now, while the request goes on and fills the cache. */
  const within = (p: Promise<TrustResult>, ms: number): Promise<TrustResult> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(result("unavailable")), Math.max(0, ms));
      (timer as { unref?: () => void }).unref?.();
      void p.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

  return {
    async score(address, options) {
      const hit = cache.get(address);
      if (hit && hit.until > now()) return hit.value;
      let p = inflight.get(address);
      if (!p) {
        p = fetchScore(address).then((value) => {
          inflight.delete(address);
          if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
          cache.set(address, { value, until: now() + TTL_MS[value.status] });
          return value;
        });
        inflight.set(address, p);
      }
      return within(p, options?.waitMs ?? waitMs);
    },
  };
}
