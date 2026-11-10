import { describe, expect, it } from "vitest";
import { flowDefinitionSchema, normalizeAddress } from "@ignitra/core";
import { createTrustLayerClient, enrichWithTrust, retryAfterMs, trustRolesUsed, type TrustLookup } from "./enrich/trust";

/** TRUST LAYER (Phase 8): lazy lookups, honest statuses, a cached and bounded client. */

const A = normalizeAddress("0x00000000000000000000000000000000000000a1");
const B = normalizeAddress("0x00000000000000000000000000000000000000b2");

const def = (extra: Record<string, unknown>) =>
  flowDefinitionSchema.parse({ trigger: { type: "TOKEN_TRANSFER", params: { token: A } }, actions: [{ step_id: "p", type: "WEB_PUSH", params: { title: "t", body: "b" } }], ...extra });

describe("which scores a flow reads", () => {
  it("finds roles in conditions and templates, only those the trigger offers", () => {
    expect(trustRolesUsed(def({}))).toEqual([]);
    expect(trustRolesUsed(def({ conditions: { all: [{ field: "counterparty_trust_score", op: ">=", value: 600 }] } }))).toEqual(["counterparty"]);
    expect([...trustRolesUsed(def({ actions: [{ step_id: "p", type: "WEB_PUSH", params: { title: "{{trigger.to_trust_band}}", body: "{{trigger.from_trust_score}}" } }] }))].sort()).toEqual(["from", "to"]);
    const holder = flowDefinitionSchema.parse({ trigger: { type: "SCHEDULE", params: { cron: "0 8 * * *" } }, conditions: { all: [{ field: "to_trust_score", op: ">", value: 1 }] }, actions: [{ step_id: "p", type: "WEB_PUSH", params: { title: "t", body: "b" } }] });
    expect(trustRolesUsed(holder)).toEqual([]); // SCHEDULE has no parties
  });
});

describe("enrichWithTrust", () => {
  const calls: string[] = [];
  const lookup: TrustLookup = {
    async score(address) {
      calls.push(address);
      return { status: "scored", score: 700, band: "strong", risk_level: "low" };
    },
  };

  it("adds score, band and status for the parties read; null parties are not applicable", async () => {
    calls.length = 0;
    const d = def({ conditions: { all: [{ field: "counterparty_trust_score", op: ">=", value: 600 }, { field: "to_trust_band", op: "EXISTS" }] } });
    const withWallet = await enrichWithTrust(d, { from: A, to: B, counterparty: B }, lookup);
    expect(withWallet).toMatchObject({ counterparty_trust_score: 700, counterparty_trust_band: "strong", counterparty_trust_status: "scored", to_trust_score: 700 });
    const noWallet = await enrichWithTrust(d, { from: A, to: B, counterparty: null }, lookup);
    expect(noWallet).toMatchObject({ counterparty_trust_score: null, counterparty_trust_status: "not_applicable" });
    expect(await enrichWithTrust(d, { counterparty: B }, null)).toMatchObject({ counterparty_trust_status: "unavailable", counterparty_trust_score: null });
  });

  it("does not look up when the other conditions fail anyway (any-groups may still pass)", async () => {
    calls.length = 0;
    const all = def({ conditions: { all: [{ field: "amount_decimal", op: ">=", value: "100" }, { field: "counterparty_trust_score", op: "<", value: 300 }] } });
    expect(await enrichWithTrust(all, { amount_decimal: "5", counterparty: B }, lookup)).toMatchObject({ counterparty_trust_status: "skipped" });
    expect(calls).toEqual([]);
    const any = def({ conditions: { any: [{ field: "amount_decimal", op: ">=", value: "100" }, { field: "counterparty_trust_score", op: "<", value: 300 }] } });
    expect(await enrichWithTrust(any, { amount_decimal: "5", counterparty: B }, lookup)).toMatchObject({ counterparty_trust_status: "scored" });
    expect(calls).toEqual([B]);
  });

  it("leaves payloads untouched for flows that read no score", async () => {
    const payload = { counterparty: B };
    expect(await enrichWithTrust(def({}), payload, lookup)).toBe(payload);
  });
});

describe("the Trust Layer client", () => {
  type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "hang" | "throw";
  function fake(answers: Answer[]) {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      const a = answers.shift() ?? { status: 500 };
      if (a === "throw") throw new Error("ECONNREFUSED");
      if (a === "hang") return new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, ...(a.headers ? { headers: a.headers } : {}) });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  }

  it("reads /v1/risk with the key, maps statuses and caches by outcome", async () => {
    let now = 0;
    const { fetch, seen } = fake([
      { status: 200, body: { status: "scored", trust_score: 812, band: "strong", risk_level: "low", confidence: 0.9 } },
      { status: 202, body: { subject: B, indexing: { status: "queued" } } },
      { status: 202, body: {} },
    ]);
    const client = createTrustLayerClient({ baseUrl: "http://trust.test/", apiKey: "tl_live_x", fetch, now: () => now });
    expect(await client.score(A)).toEqual({ status: "scored", score: 812, band: "strong", risk_level: "low" });
    expect(await client.score(A)).toMatchObject({ score: 812 }); // cached
    expect(await client.score(B)).toEqual({ status: "pending", score: null, band: null, risk_level: null });
    now += 3 * 60_000; // pending is cached briefly, scores longer
    expect((await client.score(B)).status).toBe("pending");
    expect((await client.score(A)).score).toBe(812);
    expect(seen.map((s) => s.url)).toEqual([`http://trust.test/v1/risk/${A}`, `http://trust.test/v1/risk/${B}`, `http://trust.test/v1/risk/${B}`]);
    expect(seen[0]?.auth).toBe("Bearer tl_live_x");
  });

  it("treats system addresses, errors and timeouts honestly, and backs off after repeated failures", async () => {
    let now = 0;
    const { fetch, seen } = fake([{ status: 422, body: { error: { code: "NOT_A_SUBJECT" } } }, "hang", "throw", { status: 500 }, { status: 503 }, "throw"]);
    const client = createTrustLayerClient({ baseUrl: "http://trust.test", fetch, timeoutMs: 20, now: () => now });
    expect((await client.score(A)).status).toBe("not_a_subject");
    for (const n of [1, 2, 3, 4, 5]) {
      expect((await client.score(normalizeAddress(`0x${n.toString(16).padStart(40, "0")}`))).status).toBe("unavailable");
    }
    // Five failures in a row: the breaker opens and nobody is called for 30 s.
    const before = seen.length;
    expect((await client.score(B)).status).toBe("unavailable");
    expect(seen.length).toBe(before);
  });

  it("stops asking about every address while Trust Layer rate-limits, for as long as Retry-After says", async () => {
    let now = 0;
    const { fetch, seen } = fake([{ status: 429, headers: { "retry-after": "60" } }, { status: 202, body: {} }]);
    const client = createTrustLayerClient({ baseUrl: "http://trust.test", fetch, now: () => now });
    expect((await client.score(A)).status).toBe("unavailable");
    expect((await client.score(B)).status).toBe("unavailable"); // not even asked
    expect(seen).toHaveLength(1);
    now += 61_000;
    expect((await client.score(B)).status).toBe("pending");
    expect(seen).toHaveLength(2);
    expect([retryAfterMs("5", 0), retryAfterMs(new Date(90_000).toUTCString(), 0), retryAfterMs(null, 0), retryAfterMs("soon", 0), retryAfterMs("86400", 0)]).toEqual([5000, 90_000, 30_000, 30_000, 600_000]);
  });

  it("waits a bounded time, then lets the late answer land in the cache for the next event", async () => {
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      await gate; // a cold Trust Layer computing the score
      return new Response(JSON.stringify({ status: "scored", trust_score: 677, band: "moderate", risk_level: "medium" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = createTrustLayerClient({ baseUrl: "http://trust.test", fetch, waitMs: 15 });
    const started = Date.now();
    expect((await client.score(A)).status).toBe("unavailable"); // this event goes on
    expect(Date.now() - started).toBeLessThan(1000);
    answer();
    await new Promise((r) => setTimeout(r, 20));
    expect(await client.score(A)).toEqual({ status: "scored", score: 677, band: "moderate", risk_level: "medium" });
    expect(seen).toHaveLength(1); // the one request, answered late, then reused
  });

  it("lets a caller wait longer (a TEST run someone is watching), and slow answers are not failures", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      await new Promise((r) => setTimeout(r, 40));
      return new Response(JSON.stringify({ status: "scored", trust_score: 700, band: "strong", risk_level: "low" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = createTrustLayerClient({ baseUrl: "http://trust.test", fetch, waitMs: 5 });
    expect((await client.score(B, { waitMs: 2000 })).score).toBe(700);
    // Six slow lookups in a row: each caller gave up, every request succeeded, the breaker stays shut.
    for (const n of [1, 2, 3, 4, 5, 6]) expect((await client.score(normalizeAddress(`0x${n.toString(16).padStart(40, "0")}`))).status).toBe("unavailable");
    await new Promise((r) => setTimeout(r, 250)); // all six requests have answered by now
    const before = seen.length;
    expect(before).toBe(7);
    expect((await client.score(normalizeAddress(`0x${"7".padStart(40, "0")}`), { waitMs: 2000 })).status).toBe("scored");
    expect(seen.length).toBe(before + 1);
  });

  it("shares one request between concurrent lookups of an address", async () => {
    const { fetch, seen } = fake([{ status: 200, body: { status: "provisional", trust_score: 450, band: "moderate" } }]);
    const client = createTrustLayerClient({ baseUrl: "http://trust.test", fetch });
    const [x, y] = await Promise.all([client.score(A), client.score(A)]);
    expect(x).toEqual(y);
    expect(x.status).toBe("provisional");
    expect(seen).toHaveLength(1);
  });
});
