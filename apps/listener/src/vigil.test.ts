import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChainConfig } from "@ignitra/core";
import { createKeyring, createLogger, decryptJson } from "@ignitra/core/server";
import { FakeChain, addr } from "@ignitra/chain/testing";
import { createRunner, createSafeHttp } from "@ignitra/actions";
import { buildServer, createSession } from "@ignitra/api";
import { connections, createDb, inboundEvents, runs, type DbHandle } from "@ignitra/db";
import { Matcher, TokenInfo, createTriggerModules, ensureUser } from "@ignitra/engine";

/**
 * Phase 8 end-to-end: VIGIL → IGNITRA. A stub of VIGIL's API registers IGNITRA's receiver and
 * hands back the signing secret; deliveries are signed exactly as VIGIL signs them
 * (x-vigil-signature: sha256=HMAC(secret, "<ts>.<raw body>")) and go receiver → matcher →
 * runner → Telegram. The alert bodies follow VIGIL's published AlertEvent shape.
 */

const silent = createLogger("test", "silent");
const chainConfig = resolveChainConfig({ chainId: 4663 });
const BOT_TOKEN = "1234567890:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const VIGIL_KEY = "vgl_live_testkey_0123456789";
const VIGIL_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const PROXY = "0x1111111111111111111111111111111111111111";
const ACTOR = "0x2222222222222222222222222222222222222222";
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });

let stub: Server;
let base: string;
const registered: Array<{ auth: string | undefined; body: { url: string } }> = [];
const telegram: string[] = [];
let h: DbHandle;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/webhooks" && req.method === "POST") {
        registered.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        if (req.headers.authorization !== `Bearer ${VIGIL_KEY}`) res.writeHead(401).end(JSON.stringify({ error: "unauthorized", message: "bad key" }));
        else res.writeHead(201).end(JSON.stringify({ webhook_id: "wh_01", url: JSON.parse(body).url, description: null, enabled: true, disabled_reason: null, consecutive_failures: 0, created_at: new Date().toISOString(), secret: VIGIL_SECRET }));
        return;
      }
      if (req.url?.endsWith("/sendMessage")) telegram.push(JSON.parse(body).text);
      res.end(JSON.stringify({ ok: true, result: { message_id: telegram.length, title: "Ops", type: "group", chat: { id: -1001 } } }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  h = await createDb("pglite://memory");
  await h.migrate();
}, 30_000);

afterAll(async () => {
  stub.closeAllConnections();
  stub.close();
  await h.close();
});

function alert(type: "alert.created" | "alert.confirmed" | "alert.retracted", over: Record<string, unknown> = {}) {
  const status = type === "alert.created" ? "pending" : type === "alert.confirmed" ? "confirmed" : "retracted";
  return {
    type,
    delivery_id: `dlv_${type}_${String(over.alert_id ?? "alt_1")}`,
    sent_at: new Date().toISOString(),
    alert: {
      alert_id: "alt_1",
      watch_id: "wat_1",
      finding_id: "fnd_1",
      chain_id: 4663,
      rule_id: "PROXY_UPGRADE_V1",
      rule_version: 1,
      severity: "critical",
      status,
      title: "Proxy implementation changed",
      summary: "The proxy now delegates to 0x3333…3333",
      contract: PROXY,
      subject: PROXY,
      label: "Treasury proxy",
      block_timestamp: new Date().toISOString(),
      block_hash: `0x${"ab".repeat(32)}`,
      evidence: { tx_hash: `0x${"cd".repeat(32)}`, block_number: 108_000_000, actor: ACTOR, before: "0x4444444444444444444444444444444444444444", after: "0x3333333333333333333333333333333333333333" },
      dedupe_key: "proxy:1",
      created_at: new Date().toISOString(),
      read_at: null,
      acknowledged_at: null,
      ...over,
    },
  };
}

describe("VIGIL → IGNITRA", () => {
  it("registers the receiver with a one-time key, verifies deliveries and runs once per confirmed alert", async () => {
    const chain = new FakeChain();
    chain.mineEmpty(3);
    let wakeups = 0;
    const app = await buildServer({ db: h, chain: chainConfig, logger: silent, version: "test", publicUrl: "http://api.test", reader: chain, keyring, webhookMaster: "vigil-e2e", allowPrivateOutbound: true, telegramApiBase: `${base}/tg`, onInboundEvent: () => wakeups++ });
    const userId = await ensureUser(h.db, addr(0xa11ce));
    const { token } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
    const auth = { authorization: `Bearer ${token}` };

    // Connect VIGIL with an API key: IGNITRA registers its receiver and keeps only the secret.
    const bad = await app.inject({ method: "POST", url: "/v1/connections", headers: auth, payload: { type: "vigil", api_url: `${base}/api/v1`, api_key: "vgl_wrong_key_123" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/refused the API key/);
    const created = await app.inject({ method: "POST", url: "/v1/connections", headers: auth, payload: { type: "vigil", api_url: `${base}/api/v1`, api_key: VIGIL_KEY } });
    expect(created.statusCode).toBe(201);
    const vigil = created.json().data;
    expect(created.json().receiver_url).toBe(`http://api.test/v1/integrations/vigil/${vigil.id}`);
    expect(registered.at(-1)).toMatchObject({ auth: `Bearer ${VIGIL_KEY}`, body: { url: `http://api.test/v1/integrations/vigil/${vigil.id}` } });
    expect(vigil.metadata).toMatchObject({ mode: "auto", vigil_webhook_id: "wh_01" });
    const [row] = await h.db.select().from(connections).where(eq(connections.id, vigil.id));
    const stored = decryptJson(keyring, row?.secretEnc as never, `connection:${vigil.id}`) as Record<string, unknown>;
    expect(stored).toEqual({ webhook_secret: VIGIL_SECRET }); // the API key is not kept
    expect(JSON.stringify(created.json())).not.toContain(VIGIL_SECRET);

    const tg = (await app.inject({ method: "POST", url: "/v1/connections", headers: auth, payload: { type: "telegram", bot_token: BOT_TOKEN, chat_id: "-1001" } })).json().data;
    const definition = {
      trigger: { type: "VIGIL_ALERT", params: { connection_id: vigil.id, rules: ["PROXY_UPGRADE_V1"], min_severity: "high" } },
      actions: [{ step_id: "tell", type: "TELEGRAM", params: { connection_id: tg.id, text: "🚨 {{trigger.title}} on {{trigger.label}} ({{trigger.contract | short}}) by {{trigger.actor | short}}" } }],
    };
    const flow = await app.inject({ method: "POST", url: "/v1/flows", headers: auth, payload: { name: "Upgrades", activate: true, definition } });
    expect(flow.statusCode).toBe(201);
    // Someone else cannot listen to this VIGIL connection, and a wrong connection type is refused.
    const strangerId = await ensureUser(h.db, addr(0xbad));
    const stranger = { authorization: `Bearer ${(await createSession(h.db, { userId: strangerId, chainId: 4663, userAgent: "t", ttlMs: 3_600_000, now: Date.now() })).token}` };
    const stolen = await app.inject({ method: "POST", url: "/v1/flows", headers: stranger, payload: { name: "x", definition } });
    expect(stolen.json().error.issues).toContainEqual({ path: "trigger.params.connection_id", message: `connection ${vigil.id} not found` });
    const wrongType = await app.inject({ method: "POST", url: "/v1/flows", headers: auth, payload: { name: "x", definition: { ...definition, trigger: { type: "VIGIL_ALERT", params: { connection_id: tg.id } } } } });
    expect(wrongType.json().error.issues[0].message).toMatch(/is telegram; VIGIL_ALERT needs vigil/);

    const receiver = `/v1/integrations/vigil/${vigil.id}`;
    const deliver = (body: unknown, secret = VIGIL_SECRET, ts = Math.floor(Date.now() / 1000)) => {
      const raw = JSON.stringify(body);
      return app.inject({ method: "POST", url: receiver, headers: { "content-type": "application/json", "x-vigil-timestamp": String(ts), "x-vigil-signature": `sha256=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`, "x-vigil-delivery": "dlv" }, payload: raw });
    };
    expect((await deliver({ type: "ping", delivery_id: "dlv_ping", webhook_id: "wh_01", sent_at: new Date().toISOString() })).json()).toEqual({ ok: true, type: "ping" });
    expect((await deliver(alert("alert.confirmed"), "whsec_not_the_secret_at_all")).statusCode).toBe(401);
    expect((await deliver(alert("alert.confirmed"), VIGIL_SECRET, Math.floor(Date.now() / 1000) - 600)).statusCode).toBe(401); // replayed
    expect((await app.inject({ method: "POST", url: `/v1/integrations/vigil/conn_${"0".repeat(26)}`, headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(404);

    expect((await deliver(alert("alert.created"))).json()).toEqual({ ok: true, flows: 1, stored: 1 }); // pending: stored, no run
    expect((await deliver(alert("alert.confirmed"))).json()).toEqual({ ok: true, flows: 1, stored: 1 });
    expect((await deliver(alert("alert.confirmed"))).json()).toEqual({ ok: true, flows: 1, stored: 0 }); // VIGIL retried
    await deliver(alert("alert.confirmed", { alert_id: "alt_2", rule_id: "OWNERSHIP_TRANSFER_V1" })); // other rule
    await deliver(alert("alert.confirmed", { alert_id: "alt_3", severity: "medium" })); // below min_severity
    await deliver({ type: "alert.unknown_future_type", delivery_id: "x" });
    expect(await h.db.select().from(inboundEvents)).toHaveLength(4);
    expect(wakeups).toBe(4);

    const matcher = new Matcher({ db: h.db, chain: chainConfig, reader: chain, tokens: new TokenInfo(chain), triggers: createTriggerModules(), logger: silent, owner: "m", options: { flowsCacheMs: 0 } });
    expect((await matcher.tick()).inbound).toMatchObject({ processed: 4, runs: 1 });
    const runner = createRunner({ db: h.db, owner: "r", logger: silent, keyring, webhookMaster: "vigil-e2e", vapid: null, http: createSafeHttp({ allowPrivate: true }), telegramApiBase: `${base}/tg`, chain });
    await runner.pass();
    await runner.drain();

    const [run] = await h.db.select().from(runs);
    expect(run).toMatchObject({ status: "succeeded", triggerType: "VIGIL_ALERT", idempotencyKey: expect.stringContaining("vigil:alt_1:confirmed") });
    expect(run?.triggerEvent).toMatchObject({ event: "alert.confirmed", rule_id: "PROXY_UPGRADE_V1", severity: "critical", counterparty: ACTOR, explorer_url: `https://robinhoodchain.blockscout.com/tx/0x${"cd".repeat(32)}` });
    expect(telegram).toEqual(["🚨 Proxy implementation changed on Treasury proxy (0x1111…1111) by 0x2222…2222"]);
  });
});
