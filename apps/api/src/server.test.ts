import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChainConfig } from "@ignitra/core";
import { createLogger } from "@ignitra/core/server";
import { chainSyncStatus, createDb, type DbHandle } from "@ignitra/db";
import { buildServer } from "./server";

const chain = resolveChainConfig({ chainId: 4663 });
const logger = createLogger("api-test", "silent");

let db: DbHandle;

beforeAll(async () => {
  db = await createDb("pglite://memory");
  await db.migrate();
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe("GET /health", () => {
  it("reports ok with chain and db status", async () => {
    const app = await buildServer({ db, chain, logger, version: "0.1.0" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      service: "api",
      version: "0.1.0",
      chain: { id: 4663, name: "Robinhood Chain" },
      db: { driver: "pglite", status: "ok" },
    });
    await app.close();
  });

  it("returns 503 and hides driver errors when the database is down", async () => {
    const broken: DbHandle = {
      ...db,
      ping: () => Promise.reject(new Error("connect ECONNREFUSED postgres://admin:hunter2@db:5432")),
    };
    const app = await buildServer({ db: broken, chain, logger, version: "0.1.0" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded", db: { status: "error", error: "database unreachable" } });
    expect(res.body).not.toContain("hunter2");
    await app.close();
  });

  it("times out a hanging database ping", async () => {
    const hanging: DbHandle = { ...db, ping: () => new Promise<number>(() => {}) };
    const app = await buildServer({ db: hanging, chain, logger, version: "0.1.0", healthTimeoutMs: 50 });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("GET /health — listener heartbeat", () => {
  const status = (lastTickAt: Date) => ({
    chainId: 4663,
    owner: "node-a",
    headBlock: 1000,
    confirmedHead: 980,
    confirmedCursor: 975,
    pendingCursor: null,
    watchCount: 2,
    rpc: {},
    lastError: null,
    lastTickAt,
  });

  it("reports unknown before any listener ran, then ok, then stale", async () => {
    const app = await buildServer({ db, chain, logger, version: "0.1.0", listenerStaleMs: 60_000 });
    expect((await app.inject({ method: "GET", url: "/health" })).json().listener).toEqual({ status: "unknown" });

    await db.db.insert(chainSyncStatus).values(status(new Date()));
    const fresh = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(fresh.listener).toMatchObject({ status: "ok", head: 1000, confirmed_cursor: 975, lag_blocks: 5, watches: 2 });

    await db.db.delete(chainSyncStatus);
    await db.db.insert(chainSyncStatus).values(status(new Date(Date.now() - 120_000)));
    const stale = await app.inject({ method: "GET", url: "/health" });
    expect(stale.statusCode).toBe(200); // the API itself is fine
    expect(stale.json().listener.status).toBe("stale");
    await db.db.delete(chainSyncStatus);
    await app.close();
  });
});

describe("GET /v1/triggers", () => {
  it("lists every implemented trigger with params schema and payload fields", async () => {
    const app = await buildServer({ db, chain, logger, version: "0.1.0" });
    const res = await app.inject({ method: "GET", url: "/v1/triggers" });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ type: string; kind: string; supports_fast: boolean; params_schema: { properties: Record<string, unknown> }; fields: Array<{ path: string }> }>;
    expect(data.map((t) => t.type)).toEqual(["TOKEN_TRANSFER", "CONTRACT_EVENT", "NEW_HOLDER", "BALANCE_THRESHOLD", "CONTRACT_DEPLOYED", "STATE_CHANGE", "SCHEDULE", "INBOUND_WEBHOOK", "NEW_LAUNCH", "VIGIL_ALERT"]);
    const transfer = data.find((t) => t.type === "TOKEN_TRANSFER");
    expect(transfer).toMatchObject({ kind: "log", supports_fast: true });
    expect(Object.keys(transfer?.params_schema.properties ?? {})).toEqual(["token", "wallet", "direction"]);
    expect(transfer?.fields.map((f) => f.path)).toContain("percent_of_supply");
    expect(data.find((t) => t.type === "BALANCE_THRESHOLD")).toMatchObject({ kind: "poll", supports_fast: false });
    expect(data.find((t) => t.type === "SCHEDULE")).toMatchObject({ kind: "schedule", source: "schedule" });
    expect(Object.keys(data.find((t) => t.type === "SCHEDULE")?.params_schema.properties ?? {})).toEqual(["cron", "timezone"]);
    expect(data.find((t) => t.type === "INBOUND_WEBHOOK")?.fields.map((f) => f.path)).toContain("body");
    await app.close();
  });
});

describe("GET /v1/actions and push key", () => {
  it("lists the MVP actions (Telegram, not Discord) with schemas and output fields", async () => {
    const app = await buildServer({ db, chain, logger, version: "0.1.0", vapidPublicKey: "BPub" });
    const data = (await app.inject({ method: "GET", url: "/v1/actions" })).json().data as Array<{ type: string; connection_type: string | null; params_schema: { properties: Record<string, unknown> }; output_fields: Array<{ path: string }> }>;
    expect(data.map((a) => a.type)).toEqual(["WEBHOOK", "TELEGRAM", "WEB_PUSH", "CHAIN_READ", "HTTP_REQUEST", "EMAIL", "GOOGLE_SHEETS", "ONCHAIN_TX"]);
    expect(data.filter((a) => (a as { min_plan?: string }).min_plan === "builder").map((a) => a.type)).toEqual(["EMAIL", "GOOGLE_SHEETS"]);
    expect(data.find((a) => a.type === "ONCHAIN_TX")).toMatchObject({ min_plan: "team" });
    expect(Object.keys(data.find((a) => a.type === "CHAIN_READ")?.params_schema.properties ?? {})).toEqual(["address", "function", "args", "block"]);
    const telegram = data.find((a) => a.type === "TELEGRAM");
    expect(telegram?.connection_type).toBe("telegram");
    expect(Object.keys(telegram?.params_schema.properties ?? {})).toEqual(["connection_id", "text", "parse_mode", "disable_link_preview", "silent"]);
    expect(telegram?.output_fields.map((f) => f.path)).toEqual(["message_id", "chat_id"]);
    expect((await app.inject({ method: "GET", url: "/v1/push/vapid-public-key" })).json()).toEqual({ public_key: "BPub" });
    await app.close();
  });
});

describe("errors", () => {
  it("returns a JSON 404 for unknown routes", async () => {
    const app = await buildServer({ db, chain, logger, version: "0.1.0" });
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "GET /v1/nope not found" } });
    await app.close();
  });

  it("never leaks internal error messages", async () => {
    const app = await buildServer({ db, chain, logger, version: "0.1.0" });
    app.get("/boom", async () => {
      throw new Error("secret internals");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    await app.close();
  });
});
