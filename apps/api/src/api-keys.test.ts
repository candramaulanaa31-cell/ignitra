import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChainConfig } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { addr } from "@ignitra/chain/testing";
import { apiKeys, createDb, flows, sessions, users, type DbHandle } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import { createSession } from "./auth";
import { buildServer } from "./server";

/** Phase 8: public API keys (Team plan) and per-caller rate limits. */

const chain = resolveChainConfig({ chainId: 4663 });
const logger = createLogger("api-test", "silent");
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });

let h: DbHandle;
type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let clock = Date.now();

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
}, 30_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  for (const t of [apiKeys, sessions, flows]) await h.db.delete(t);
  await h.db.delete(users);
  clock = Date.now();
  app = await buildServer({ db: h, chain, logger, version: "test", keyring, now: () => clock, publicRatePerMinute: 5, sessionRatePerMinute: 1000 });
});

async function user(plan: "free" | "builder" | "team") {
  const userId = await ensureUser(h.db, addr(Math.floor(Math.random() * 1e9)));
  await h.db.update(users).set({ plan }).where(eq(users.id, userId));
  const { token } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
  return { userId, session: { authorization: `Bearer ${token}` } };
}

async function newKey(session: Record<string, string>, name = "CI") {
  const res = await app.inject({ method: "POST", url: "/v1/api-keys", headers: session, payload: { name } });
  return { res, key: res.json().key as string, id: res.json().data?.id as string };
}

describe("API keys", () => {
  it("a team account creates a key, sees it once, and uses it as a bearer credential", async () => {
    const me = await user("team");
    const { res, key, id } = await newKey(me.session);
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(key).toMatch(/^igk_[A-Za-z0-9_-]{43}$/);
    expect(res.json().data).toMatchObject({ name: "CI", prefix: key.slice(0, 12), rate_per_minute: 600, last_used_at: null, revoked_at: null });

    const [row] = await h.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(JSON.stringify(row)).not.toContain(key); // only the hash is stored

    const me2 = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } });
    expect(me2.statusCode).toBe(200);
    expect(me2.json().data.id).toBe(me.userId);
    expect(me2.headers["ratelimit-limit"]).toBe("600");
    expect(me2.headers["ratelimit-remaining"]).toBe("599");
    // Writes need no Origin with a key (it is not a cookie a browser sends on its own).
    const flow = await app.inject({ method: "POST", url: "/v1/flows/validate", headers: { authorization: `Bearer ${key}` }, payload: { definition: { trigger: { type: "SCHEDULE", params: { cron: "0 8 * * *" } }, actions: [{ step_id: "p", type: "WEB_PUSH", params: { title: "t", body: "b" } }] } } });
    expect(flow.statusCode).toBe(200);

    const list = (await app.inject({ method: "GET", url: "/v1/api-keys", headers: me.session })).json().data;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(key);
    expect(list[0].last_used_at).not.toBeNull();
  });

  it("keys cannot manage keys or sign out; revoking works at once", async () => {
    const me = await user("team");
    const { key, id } = await newKey(me.session);
    const bearer = { authorization: `Bearer ${key}` };
    expect((await app.inject({ method: "POST", url: "/v1/api-keys", headers: bearer, payload: { name: "more" } })).json().error.code).toBe("session_required");
    expect((await app.inject({ method: "GET", url: "/v1/api-keys", headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/v1/api-keys/${id}`, headers: me.session })).statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/v1/me", headers: bearer });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("invalid_api_key");
    expect((await app.inject({ method: "DELETE", url: `/v1/api-keys/${id}`, headers: me.session })).statusCode).toBe(404);
  });

  it("is a Team feature: other plans cannot create keys, and a downgrade stops existing ones", async () => {
    const free = await user("free");
    const refused = await newKey(free.session);
    expect(refused.res.statusCode).toBe(402);
    expect(refused.res.json().error).toMatchObject({ code: "plan_limit_reached", limit: "api_keys", plan: "free" });

    const team = await user("team");
    const { key } = await newKey(team.session);
    await h.db.update(users).set({ plan: "builder" }).where(eq(users.id, team.userId));
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: "plan_required", required: "team" });
    // The wallet session still works on any plan.
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: team.session })).statusCode).toBe(200);
  });

  it("another user's key id cannot be revoked; unknown keys are 401", async () => {
    const a = await user("team");
    const b = await user("team");
    const { id } = await newKey(a.session);
    expect((await app.inject({ method: "DELETE", url: `/v1/api-keys/${id}`, headers: b.session })).statusCode).toBe(404);
    const unknown = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer igk_${"x".repeat(43)}` } });
    expect(unknown.statusCode).toBe(401);
  });
});

describe("rate limits", () => {
  it("limits each key with a token bucket and says when to come back", async () => {
    const me = await user("team");
    const { id, key } = await newKey(me.session);
    await h.db.update(apiKeys).set({ ratePerMinute: 3 }).where(eq(apiKeys.id, id));
    const bearer = { authorization: `Bearer ${key}` };
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: "/v1/me", headers: bearer })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/v1/me", headers: bearer });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
    expect(limited.headers["retry-after"]).toBe("20");
    expect(limited.headers["ratelimit-remaining"]).toBe("0");
    clock += 20_000; // one token back
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: bearer })).statusCode).toBe(200);
    // Another caller has its own bucket.
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: me.session })).statusCode).toBe(200);
  });

  it("limits anonymous public requests per client address", async () => {
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "GET", url: "/v1/triggers" })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/v1/actions" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    // Health checks are never limited.
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).not.toBe(429);
  });

  it("gives the landing page's live demo its own per-address budget", async () => {
    const visitor = { remoteAddress: "203.0.113.5" };
    for (let i = 0; i < 20; i++) expect((await app.inject({ method: "GET", url: "/v1/demo", ...visitor })).statusCode).not.toBe(429); // 4 × the public rate
    expect((await app.inject({ method: "GET", url: "/v1/demo", ...visitor })).statusCode).toBe(429);
    // Polling the demo never starves sign-in or the catalogs for the same address.
    expect((await app.inject({ method: "GET", url: "/v1/triggers", ...visitor })).statusCode).toBe(200);
  });
});
