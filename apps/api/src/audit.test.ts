import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChainConfig } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { addr } from "@ignitra/chain/testing";
import { apiKeys, auditLog, connections, createDb, flows, sessions, users, type DbHandle } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import { createSession } from "./auth";
import { buildServer } from "./server";

/** Phase 9: the account's audit log — who changed what, from where, newest first. */

const chain = resolveChainConfig({ chainId: 4663 });
const logger = createLogger("api-test", "silent");
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });
const HOOK_FLOW = { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: [{ step_id: "hook", type: "WEBHOOK", params: { url: "https://example.com/hook" } }] };

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
  for (const t of [auditLog, apiKeys, sessions, connections, flows]) await h.db.delete(t);
  await h.db.delete(users);
  app = await buildServer({ db: h, chain, logger, version: "test", keyring, webhookMaster: "audit-test-master", sessionRatePerMinute: 10_000 });
});

async function user(plan: "free" | "builder" | "team" = "team") {
  const userId = await ensureUser(h.db, addr(Math.floor(Math.random() * 1e9)));
  await h.db.update(users).set({ plan }).where(eq(users.id, userId));
  const { token } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
  return { userId, session: { authorization: `Bearer ${token}` } };
}

describe("audit log", () => {
  it("records every change with who made it and from where, newest first", async () => {
    const me = await user();
    const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = me.session) =>
      app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

    const flowId = (await call("POST", "/v1/flows", { name: "Audit me", definition: HOOK_FLOW, activate: true })).json().data.id as string;
    await call("PATCH", `/v1/flows/${flowId}`, { name: "Audit me, renamed" });
    await call("POST", `/v1/flows/${flowId}/pause`);
    const conn = (await call("POST", "/v1/connections", { type: "webhook", url: "https://hooks.example.com/secret-path?token=s3cret" })).json();
    const key = (await call("POST", "/v1/api-keys", { name: "ci" })).json();
    // The same account through an API key: the log names the key.
    expect((await call("POST", `/v1/flows/${flowId}/resume`, undefined, { authorization: `Bearer ${key.key}` })).statusCode).toBe(200);
    expect((await call("DELETE", `/v1/connections/${conn.data.id}`)).statusCode).toBe(204);
    await call("GET", "/v1/me/webhook-secret");
    await call("DELETE", `/v1/api-keys/${key.data.id}`);
    await call("DELETE", `/v1/flows/${flowId}`);

    const res = await call("GET", "/v1/audit-log");
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as Array<{ action: string; actor: Record<string, unknown>; target: { type: string; id: string | null }; details: Record<string, unknown>; ip: string | null }>;
    expect(entries.map((e) => e.action)).toEqual([
      "flow.deleted",
      "api_key.revoked",
      "account.webhook_secret_viewed",
      "connection.deleted",
      "flow.resumed",
      "api_key.created",
      "connection.created",
      "flow.paused",
      "flow.updated",
      "flow.created",
    ]);
    const by = (action: string) => entries.find((e) => e.action === action);
    expect(by("flow.resumed")?.actor).toEqual({ kind: "api_key", api_key_id: key.data.id, api_key_prefix: key.data.prefix });
    expect(by("flow.paused")?.actor).toEqual({ kind: "session" });
    expect(by("flow.created")).toMatchObject({ target: { type: "flow", id: flowId }, details: { name: "Audit me", trigger: "INBOUND_WEBHOOK", actions: ["WEBHOOK"], status: "active" } });
    expect(by("flow.deleted")?.details).toEqual({ name: "Audit me, renamed" });
    expect(by("connection.created")?.details).toEqual({ type: "webhook", label: "Webhook hooks.example.com" });
    expect(entries.every((e) => typeof e.ip === "string" && e.ip.length > 0)).toBe(true);
    // Never a secret: not the webhook URL's path or token, nor a signing secret or a full API key.
    expect(res.body).not.toMatch(/s3cret|secret-path|whsec_|igk_[A-Za-z0-9_-]{20,}/);
  });

  it("pages backwards, and shows each owner only their own entries", async () => {
    const me = await user();
    for (let i = 0; i < 5; i++) await app.inject({ method: "PATCH", url: "/v1/me", headers: me.session, payload: { timezone: i % 2 ? "UTC" : "Asia/Jakarta" } });
    const first = (await app.inject({ method: "GET", url: "/v1/audit-log?limit=2", headers: me.session })).json();
    expect(first.data).toHaveLength(2);
    const second = (await app.inject({ method: "GET", url: `/v1/audit-log?limit=2&before=${first.next_before}`, headers: me.session })).json();
    const third = (await app.inject({ method: "GET", url: `/v1/audit-log?limit=2&before=${second.next_before}`, headers: me.session })).json();
    expect([...first.data, ...second.data, ...third.data].map((e: { action: string }) => e.action)).toEqual(Array(5).fill("account.updated"));
    expect(third.next_before).toBeNull();
    expect(new Set([...first.data, ...second.data, ...third.data].map((e: { id: string }) => e.id)).size).toBe(5);

    const stranger = await user("free");
    expect((await app.inject({ method: "GET", url: "/v1/audit-log", headers: stranger.session })).json().data).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/v1/audit-log" })).statusCode).toBe(401);
  });
});
