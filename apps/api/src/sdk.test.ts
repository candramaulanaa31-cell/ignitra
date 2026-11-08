import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChainConfig } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { addr } from "@ignitra/chain/testing";
import { createConnection, signWebhook } from "@ignitra/actions";
import { apiKeys, connections, createDb, flows, runs, sessions, users, type DbHandle } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import { Ignitra, IgnitraApiError, parseWebhook } from "@ignitra/sdk";
import { createSession } from "./auth";
import { buildServer } from "./server";

/**
 * Phase 8: @ignitra/sdk against the real server (in process). The SDK's hand-written types
 * and paths are exercised end to end, so they cannot drift from what the API answers.
 */

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
  for (const t of [runs, apiKeys, sessions, connections]) await h.db.delete(t);
  await h.db.delete(flows);
  await h.db.delete(users);
  app = await buildServer({ db: h, chain, logger, version: "test", keyring, webhookMaster: "sdk-test-master", webUrl: "https://app.example", publicUrl: "https://app.example/api" });
});

/** fetch → Fastify inject, so the SDK talks to the real routes without a socket. */
const injectFetch = (base: string) =>
  (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const res = await app.inject({
      method: (init.method ?? "GET") as "GET",
      url: url.pathname.slice(new URL(base).pathname.length) + url.search,
      headers: init.headers as Record<string, string>,
      ...(init.body !== undefined ? { payload: String(init.body) } : {}),
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, String(v));
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers });
  }) as typeof globalThis.fetch;

async function teamClient() {
  const userId = await ensureUser(h.db, addr(Math.floor(Math.random() * 1e9)));
  await h.db.update(users).set({ plan: "team" }).where(eq(users.id, userId));
  const { token } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
  const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { authorization: `Bearer ${token}` }, payload: { name: "sdk" } });
  const base = "https://app.example/api";
  return { userId, ignitra: new Ignitra({ apiKey: created.json().key, baseUrl: base, fetch: injectFetch(base) }) };
}

describe("@ignitra/sdk against the API", () => {
  it("runs the spec's example and manages the flow", async () => {
    const { ignitra, userId } = await teamClient();
    expect((await ignitra.account.me()).id).toBe(userId);
    expect((await ignitra.account.usage()).plan).toBe("team");

    const flow = await ignitra.flows.create({
      name: "Big buys → my server",
      trigger: { type: "TOKEN_TRANSFER", params: { token: USDG } },
      conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 1 }] },
      actions: [{ type: "WEBHOOK", params: { url: "https://myapp.com/hook" } }],
    });
    expect(flow).toMatchObject({ name: "Big buys → my server", status: "paused", trigger_type: "TOKEN_TRANSFER", actions: ["WEBHOOK"] });
    expect(flow.definition.actions[0]?.step_id).toBe("webhook");
    expect(flow.definition.settings).toEqual({ mode: "confirmed", max_runs_per_hour: 60, onchain: false });

    expect((await ignitra.flows.list()).map((f) => f.id)).toEqual([flow.id]);
    expect((await ignitra.flows.update(flow.id, { name: "Renamed" })).name).toBe("Renamed");
    expect((await ignitra.flows.resume(flow.id)).status).toBe("active");
    expect((await ignitra.flows.pause(flow.id)).status).toBe("paused");
    expect(await ignitra.flows.runs(flow.id)).toEqual({ data: [], next_before: null });
    const all = [];
    for await (const run of ignitra.flows.iterateRuns(flow.id)) all.push(run);
    expect(all).toEqual([]);
    expect(await ignitra.flows.evaluations(flow.id)).toEqual([]);
    const validated = await ignitra.flows.validate({ trigger: { type: "TOKEN_TRANSFER", params: { token: USDG } }, actions: [{ type: "WEB_PUSH", params: { title: "t", body: "{{trigger.amount_formatted}}" } }] });
    expect(validated.trigger_fields.some((f) => f.path === "amount_formatted")).toBe(true);

    await ignitra.flows.delete(flow.id);
    const gone = await ignitra.flows.get(flow.id).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(IgnitraApiError);
    expect(gone).toMatchObject({ status: 404, code: "not_found" });

    // Everything above is in the audit log, done by this API key.
    const page = await ignitra.account.auditLog({ limit: 2 });
    expect(page.data.map((e) => e.action)).toEqual(["flow.deleted", "flow.paused"]);
    expect(page.data[0]?.actor).toMatchObject({ kind: "api_key" });
    const actions: string[] = [];
    for await (const entry of ignitra.account.iterateAuditLog({ pageSize: 2 })) actions.push(entry.action);
    expect(actions.slice(0, 5)).toEqual(["flow.deleted", "flow.paused", "flow.resumed", "flow.updated", "flow.created"]);
  });

  it("surfaces validation issues as IgnitraApiError", async () => {
    const { ignitra } = await teamClient();
    const badTrigger = (await ignitra.flows.create({ name: "bad", trigger: { type: "TOKEN_TRANSFER", params: { token: "0x1" } }, actions: [{ type: "WEB_PUSH", params: { title: "t", body: "b" } }] }).catch((e: unknown) => e)) as IgnitraApiError;
    expect(badTrigger).toMatchObject({ status: 422, code: "invalid_flow" });
    expect(badTrigger.issues.map((i) => i.path)).toContain("trigger.params.token");
    const badAction = (await ignitra.flows.create({ name: "bad", trigger: { type: "TOKEN_TRANSFER", params: { token: USDG } }, actions: [{ type: "WEBHOOK", params: { url: "not a url" } }] }).catch((e: unknown) => e)) as IgnitraApiError;
    expect(badAction.issues.map((i) => i.path)).toContain("actions.0.params.url");
  });

  it("templates, catalogs and connections", async () => {
    const { ignitra, userId } = await teamClient();
    const chat = await createConnection(h.db, keyring, { ownerId: userId, type: "telegram", label: "Ops", secret: { bot_token: "1:x" }, metadata: { chat_id: "-1" } });
    expect((await ignitra.connections.list()).map((c) => c.id)).toEqual([chat.id]);
    expect((await ignitra.catalog.triggers()).some((t) => t.type === "TOKEN_TRANSFER")).toBe(true);
    expect((await ignitra.catalog.actions()).some((a) => a.type === "WEBHOOK")).toBe(true);
    const cards = await ignitra.templates.list({ category: "trading" });
    expect(cards.every((c) => c.category === "trading")).toBe(true);
    const detail = await ignitra.templates.get("big-buy-telegram");
    expect(detail.placeholders.map((p) => p.key)).toEqual(["token", "threshold", "chat"]);
    const used = await ignitra.templates.use("big-buy-telegram", { values: { token: USDG, chat: chat.id } });
    expect(used.status).toBe("active");
    expect((await ignitra.flows.get(used.flow_id)).definition.actions[0]?.params.connection_id).toBe(chat.id);
  });

  it("verifies a webhook signed by IGNITRA's own signer with the account's secret", async () => {
    const { ignitra } = await teamClient();
    const secret = await ignitra.account.webhookSecret();
    const body = JSON.stringify({ type: "run.action", run_id: "run_1", flow_id: "fl_1", step_id: "hook", idempotency_key: "k:hook", test: false });
    const ts = Math.floor(Date.now() / 1000);
    const headers = { "x-ignitra-signature": signWebhook(secret, ts, body), "x-ignitra-timestamp": String(ts) };
    expect(await parseWebhook(body, headers, secret)).toMatchObject({ type: "run.action", step_id: "hook" });
  });
});
