import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, resolveChainConfig } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { addr } from "@ignitra/chain/testing";
import { createConnection } from "@ignitra/actions";
import { connections, createDb, flowVersions, flows, runs, sessions, templateStats, templates, users, type DbHandle } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import { createSession } from "./auth";
import { buildServer } from "./server";

/** Phase 7: template gallery, instantiate, publish / share links, moderation, the landing demo. */

const chain = resolveChainConfig({ chainId: 4663 });
const logger = createLogger("api-test", "silent");
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

let h: DbHandle;
type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
}, 30_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  for (const t of [runs, sessions, templates, templateStats, connections]) await h.db.delete(t);
  await h.db.delete(flows);
  await h.db.delete(users);
  app = await buildServer({ db: h, chain, logger, version: "test", keyring, webhookMaster: "templates-test-master", webUrl: "https://app.ignitra.example", publicUrl: "https://app.ignitra.example/api" });
});

async function user(plan: "free" | "builder" = "free") {
  const userId = await ensureUser(h.db, addr(Math.floor(Math.random() * 1e9)));
  await h.db.update(users).set({ plan }).where(eq(users.id, userId));
  const { token } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
  const telegram = await createConnection(h.db, keyring, { ownerId: userId, type: "telegram", label: "Ops chat", secret: { bot_token: "1:x" }, metadata: { chat_id: "-1" } });
  return { userId, auth: { authorization: `Bearer ${token}` }, telegram: telegram.id };
}

describe("gallery", () => {
  it("lists the official templates publicly, with the plan each needs", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/templates" });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ slug: string; official: boolean; min_plan: string; trigger_type: string; action_types: string[]; uses: number }>;
    expect(data.length).toBeGreaterThanOrEqual(10);
    expect(data.every((t) => t.official && t.uses === 0)).toBe(true);
    expect(data.find((t) => t.slug === "big-buy-telegram")).toMatchObject({ min_plan: "free", trigger_type: "TOKEN_TRANSFER", action_types: ["TELEGRAM"] });
    expect(data.find((t) => t.slug === "daily-supply-sheets")?.min_plan).toBe("builder");
    const security = (await app.inject({ method: "GET", url: "/v1/templates?category=security" })).json().data as Array<{ slug: string }>;
    expect(security.map((t) => t.slug)).toEqual(["proxy-upgraded-webhook", "ownership-transferred-telegram", "paused-telegram", "vigil-upgrade-webhook", "vigil-critical-telegram", "risky-buyer-telegram", "mint-burn-telegram"]);
  });

  it("shows one template with its placeholders, outline and share text", async () => {
    const t = (await app.inject({ method: "GET", url: "/v1/templates/big-buy-telegram" })).json().data;
    expect(t).toMatchObject({ name: "Big buy alert → Telegram", url: "https://app.ignitra.example/templates/big-buy-telegram", share_text: expect.stringContaining("Telegram") });
    expect(t.placeholders.map((p: { key: string }) => p.key)).toEqual(["token", "threshold", "chat"]);
    expect(t.outline[0]).toEqual({ kind: "WHEN", text: "Token transfer · token ‹Token›" });
    expect((await app.inject({ method: "GET", url: "/v1/templates/nope" })).statusCode).toBe(404);
  });
});

describe("use a template", () => {
  it("fills the placeholders and creates an active flow in one call", async () => {
    const me = await user();
    const res = await app.inject({ method: "POST", url: "/v1/templates/big-buy-telegram/instantiate", headers: me.auth, payload: { values: { token: USDG, chat: me.telegram, threshold: "1" } } });
    expect(res.statusCode).toBe(201);
    const { flow_id, status } = res.json().data;
    expect(status).toBe("active");
    const [version] = await h.db.select().from(flowVersions).where(eq(flowVersions.flowId, flow_id));
    expect(version?.definition).toMatchObject({
      trigger: { type: "TOKEN_TRANSFER", params: { token: USDG } },
      conditions: { all: [{ field: "percent_of_supply", value: "1" }, { field: "is_mint", value: false }] },
      actions: [{ type: "TELEGRAM", params: { connection_id: me.telegram } }],
    });
    const listed = (await app.inject({ method: "GET", url: "/v1/templates" })).json().data as Array<{ slug: string; uses: number }>;
    expect(listed.find((t) => t.slug === "big-buy-telegram")?.uses).toBe(1);
  });

  it("explains missing values, refuses other people's connections and Builder features on Free", async () => {
    const me = await user();
    const missing = await app.inject({ method: "POST", url: "/v1/templates/big-buy-telegram/instantiate", headers: me.auth, payload: { values: { token: "0x12" } } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.issues.map((i: { path: string }) => i.path)).toEqual(["values.token", "values.chat"]);
    const other = await user();
    const stolen = await app.inject({ method: "POST", url: "/v1/templates/big-buy-telegram/instantiate", headers: me.auth, payload: { values: { token: USDG, chat: other.telegram } } });
    expect(stolen.json().error.issues[0]).toMatchObject({ path: "actions.0.params.connection_id", message: expect.stringMatching(/not found/) });
    const locked = await app.inject({ method: "POST", url: "/v1/templates/treasury-low-email/instantiate", headers: me.auth, payload: { values: { wallet: USDG, email: me.telegram } } });
    expect(locked.json().error.issues.map((i: { message: string }) => i.message)).toContain("EMAIL needs the builder plan (you are on free)");
    expect((await app.inject({ method: "POST", url: "/v1/templates/big-buy-telegram/instantiate", payload: {} })).statusCode).toBe(401);
  });
});

describe("share your own flow", () => {
  async function flowOf(me: Awaited<ReturnType<typeof user>>) {
    const definition = {
      trigger: { type: "TOKEN_TRANSFER", params: { token: USDG } },
      conditions: { all: [{ field: "amount_decimal", op: ">=", value: "5000" }] },
      actions: [
        { step_id: "notify", type: "TELEGRAM", params: { connection_id: me.telegram, text: "🐳 {{trigger.amount_formatted}} {{trigger.token.symbol}}" } },
        { step_id: "hook", type: "WEBHOOK", params: { url: "https://private.example/hook?token=s3cret" } },
      ],
    };
    return (await app.inject({ method: "POST", url: "/v1/flows", headers: me.auth, payload: { name: "Whale watch", definition } })).json().data.id as string;
  }

  it("publishes a template without the author's private destinations; the link works for anyone", async () => {
    const me = await user();
    const flowId = await flowOf(me);
    const res = await app.inject({ method: "POST", url: "/v1/templates", headers: me.auth, payload: { flow_id: flowId, name: "USDG whale watch", summary: "Whale transfers of USDG to Telegram and your server.", category: "trading" } });
    expect(res.statusCode).toBe(201);
    const { data, url } = res.json();
    expect(url).toBe(`https://app.ignitra.example/templates/${data.slug}`);
    expect(data.slug).toMatch(/^usdg-whale-watch-[0-9a-f]{6}$/);

    const shared = await app.inject({ method: "GET", url: `/v1/templates/${data.slug}` });
    expect(shared.statusCode).toBe(200);
    expect(shared.body).not.toContain(me.telegram);
    expect(shared.body).not.toContain("s3cret");
    expect(shared.json().data).toMatchObject({ official: false, visibility: "unlisted", author: expect.stringMatching(/^0x/) });
    expect((await app.inject({ method: "GET", url: "/v1/templates" })).json().data.some((t: { slug: string }) => t.slug === data.slug)).toBe(false); // unlisted

    const friend = await user();
    const used = await app.inject({
      method: "POST",
      url: `/v1/templates/${data.slug}/instantiate`,
      headers: friend.auth,
      payload: { values: { telegram_chat: friend.telegram, webhook_url: "https://friend.example/hook" }, activate: false },
    });
    expect(used.statusCode).toBe(201);
    expect(used.json().data.status).toBe("paused");
  });

  it("lists public templates as Community; owners delete, operators hide, strangers cannot publish your flow", async () => {
    const me = await user();
    const flowId = await flowOf(me);
    const pub = (await app.inject({ method: "POST", url: "/v1/templates", headers: me.auth, payload: { flow_id: flowId, name: "Public whale watch", summary: "Whale transfers of USDG to Telegram.", category: "trading", visibility: "public" } })).json().data;
    const listed = (await app.inject({ method: "GET", url: "/v1/templates" })).json().data as Array<{ slug: string; official: boolean }>;
    expect(listed.find((t) => t.slug === pub.slug)).toMatchObject({ official: false });
    expect((await app.inject({ method: "GET", url: "/v1/me/templates", headers: me.auth })).json().data.map((t: { slug: string }) => t.slug)).toEqual([pub.slug]);

    const stranger = await user();
    expect((await app.inject({ method: "POST", url: "/v1/templates", headers: stranger.auth, payload: { flow_id: flowId, name: "Mine now", summary: "Taking someone else's flow.", category: "trading" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/templates/${pub.slug}`, headers: stranger.auth })).statusCode).toBe(404);

    await h.db.update(templates).set({ hiddenAt: new Date() }).where(eq(templates.slug, pub.slug));
    expect((await app.inject({ method: "GET", url: `/v1/templates/${pub.slug}` })).statusCode).toBe(404);
    await h.db.update(templates).set({ hiddenAt: null }).where(eq(templates.slug, pub.slug));
    expect((await app.inject({ method: "DELETE", url: `/v1/templates/${pub.slug}`, headers: me.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/v1/templates/${pub.slug}` })).statusCode).toBe(404);
  });
});

describe("landing demo", () => {
  it("is off until the operator designates a flow, then shows its recent runs with timings", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/demo" })).json().error.code).toBe("not_configured");
    const me = await user();
    const flowId = (await app.inject({ method: "POST", url: "/v1/templates/big-buy-telegram/instantiate", headers: me.auth, payload: { values: { token: USDG, chat: me.telegram } } })).json().data.flow_id as string;
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 3; i++) {
      await h.db.insert(runs).values({
        id: newId("run", t0 + i),
        flowId,
        flowVersion: 1,
        idempotencyKey: `demo-${i}`,
        triggerType: "TOKEN_TRANSFER",
        triggerEvent: { amount_formatted: `${1000 + i}`, token: { symbol: "USDG" }, from: addr(1), to: addr(2), tx_hash: `0x${String(i).repeat(64)}`, block_number: 100 + i, block_timestamp: new Date(t0 + i * 1000).toISOString() },
        status: "succeeded",
        startedAt: new Date(t0 + i * 1000 + 2_000),
        finishedAt: new Date(t0 + i * 1000 + 3_000 + i * 1000),
      });
    }
    const demo = await buildServer({ db: h, chain, logger, version: "test", demoFlowId: flowId });
    const res = await demo.inject({ method: "GET", url: "/v1/demo" });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.outline[0].kind).toBe("WHEN");
    expect(data.runs.map((r: { summary: string }) => r.summary)).toEqual([`1002 USDG · ${addr(1).slice(0, 6)}…${addr(1).slice(-4)} → ${addr(2).slice(0, 6)}…${addr(2).slice(-4)}`, expect.any(String), expect.any(String)]);
    expect(data.latency_ms).toEqual({ p50: 4000, p90: 5000, samples: 3 });
    expect(res.body).not.toContain(me.telegram); // only public chain data
    await demo.close();
  });
});
