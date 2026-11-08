import { createECDH, createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, resolveChainConfig, usagePeriod } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { FakeChain, addr } from "@ignitra/chain/testing";
import { deriveOwnerSigningSecret } from "@ignitra/actions";
import { authNonces, connections, createDb, flows, inboundEvents, runSteps, runs, sessions, usageMonthly, users, type DbHandle } from "@ignitra/db";
import { buildServer } from "./server";

/**
 * Phase 5 API: SIWE sign-in (EOA + ERC-1271), sessions, CSRF / CORS, owner
 * scoping, connections, flows, plan limits, runs, usage and inbound webhooks.
 * Test wallets are generated per run (fixtures only — the product never sees a private key).
 */

const chain = resolveChainConfig({ chainId: 4663 });
const logger = createLogger("api-test", "silent");
const ORIGIN = "http://localhost:3000";
const MASTER = "api-test-webhook-master-secret";
const BOT_TOKEN = "1234567890:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const SMART_WALLET = addr(0x5afe);
const ERC1271 = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

let h: DbHandle;
let fake: FakeChain;
let tg: Server;
let tgBase: string;
let walletApproves = true;

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

async function server(opts: Partial<Parameters<typeof buildServer>[0]> = {}): Promise<App> {
  return buildServer({
    db: h,
    chain,
    logger,
    version: "0.1.0",
    corsOrigins: [ORIGIN],
    publicUrl: "http://api.test",
    reader: fake,
    keyring: createKeyring({ kid: "k1", key: randomBytes(32) }),
    webhookMaster: MASTER,
    allowPrivateOutbound: true,
    telegramApiBase: `${tgBase}/tg`,
    ...opts,
  });
}

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
  fake = new FakeChain();
  // A smart-contract wallet that approves signature 0x1234 (when told to).
  fake.registerContract(SMART_WALLET, (data) => {
    const call = decodeFunctionData({ abi: ERC1271, data });
    const ok = walletApproves && call.args[1] === "0x1234";
    return encodeFunctionResult({ abi: ERC1271, functionName: "isValidSignature", result: ok ? "0x1626ba7e" : "0xffffffff" });
  });
  tg = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const ok = req.url?.includes(BOT_TOKEN) ?? false;
    res.end(JSON.stringify(ok ? { ok: true, result: { username: "ignitra_bot", title: "Test Group", type: "supergroup" } } : { ok: false, description: "Unauthorized" }));
  });
  await new Promise<void>((r) => tg.listen(0, "127.0.0.1", r));
  tgBase = `http://127.0.0.1:${(tg.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  tg.closeAllConnections();
  tg.close();
  await h.close();
});

beforeEach(async () => {
  for (const t of [inboundEvents, runs, sessions, authNonces, usageMonthly, connections]) await h.db.delete(t);
  await h.db.delete(flows);
  await h.db.delete(users);
  walletApproves = true;
  app = await server();
});

// ---- helpers -------------------------------------------------------------------

async function siwe(address: `0x${string}`, overrides: Record<string, unknown> = {}): Promise<string> {
  const { nonce } = (await app.inject({ method: "GET", url: "/v1/auth/nonce" })).json() as { nonce: string };
  return createSiweMessage({
    address,
    chainId: 4663,
    domain: "localhost:3000",
    nonce,
    uri: ORIGIN,
    version: "1",
    issuedAt: new Date(),
    statement: "Sign in to IGNITRA",
    ...overrides,
  });
}

async function signIn(account: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey())) {
  const message = await siwe(account.address);
  const res = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message, signature: await account.signMessage({ message }), return_token: true } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id, account, cookie: res.headers["set-cookie"] as string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const hookFlow = { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: [{ step_id: "hook", type: "WEBHOOK", params: { url: "https://example.com/hook" } }] };

async function createFlowVia(token: string, definition: unknown = hookFlow, activate = true) {
  return app.inject({ method: "POST", url: "/v1/flows", headers: bearer(token), payload: { name: "My flow", definition, activate } });
}

// ---- sign-in -------------------------------------------------------------------

describe("Sign-In with Ethereum", () => {
  it("signs in an EOA: HttpOnly cookie for browsers, a bearer token only on request", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const browser = await siwe(account.address);
    const plain = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message: browser, signature: await account.signMessage({ message: browser }) } });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).not.toHaveProperty("token");
    expect(plain.headers["set-cookie"]).toMatch(/^ignitra_session=igs_/);

    const message = await siwe(account.address);
    const res = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message, signature: await account.signMessage({ message }), return_token: true } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^igs_[A-Za-z0-9_-]{43}$/);
    expect(body.user).toMatchObject({ address: account.address.toLowerCase(), plan: "free", timezone: "Asia/Jakarta", limits: { active_flows: 3, runs_per_month: 500 } });
    const cookie = res.headers["set-cookie"] as string;
    expect(cookie).toMatch(/^ignitra_session=igs_.+; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax$/);

    const viaBearer = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(body.token) });
    expect(viaBearer.json().data).toMatchObject({ address: account.address.toLowerCase(), usage: { runs: { used: 0, included: 500 } } });
    const viaCookie = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: cookie.split(";")[0] as string } });
    expect(viaCookie.statusCode).toBe(200);

    // Only a hash of the token is stored.
    const [row] = await h.db.select().from(sessions);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(body.token);
  });

  it("redeems a signed message exactly once", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = await siwe(account.address);
    const payload = { message, signature: await account.signMessage({ message }) };
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", payload })).statusCode).toBe(200);
    const replay = await app.inject({ method: "POST", url: "/v1/auth/verify", payload });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("invalid_nonce");
  });

  it("rejects wrong domain, wrong chain, expired messages, foreign signatures and garbage", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const attempt = async (overrides: Record<string, unknown>, signer = account) => {
      const message = await siwe(account.address, overrides);
      const res = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message, signature: await signer.signMessage({ message }) } });
      return [res.statusCode, res.json().error?.code];
    };
    expect(await attempt({ domain: "evil.example", uri: "https://evil.example" })).toEqual([401, "domain_mismatch"]);
    expect(await attempt({ uri: "https://evil.example/login" })).toEqual([401, "domain_mismatch"]);
    expect(await attempt({ chainId: 1 })).toEqual([401, "wrong_chain"]);
    expect(await attempt({ expirationTime: new Date(Date.now() - 1000) })).toEqual([401, "message_expired"]);
    expect(await attempt({ issuedAt: new Date(Date.now() + 3_600_000) })).toEqual([401, "invalid_message"]);
    expect(await attempt({ nonce: "0123456789abcdef0123456789abcdef" })).toEqual([401, "invalid_nonce"]);
    expect(await attempt({}, other)).toEqual([401, "invalid_signature"]);
    const garbage = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message: "hello", signature: "0x00" } });
    expect([garbage.statusCode, garbage.json().error.code]).toEqual([401, "invalid_message"]);
    const malformed = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message: "x" } });
    expect([malformed.statusCode, malformed.json().error.code]).toEqual([400, "invalid_request"]);
  });

  it("verifies smart-contract wallets on-chain (ERC-1271)", async () => {
    const message = await siwe(getAddress(SMART_WALLET));
    const ok = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message, signature: "0x1234" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.address).toBe(SMART_WALLET);

    walletApproves = false;
    const message2 = await siwe(getAddress(SMART_WALLET));
    const refused = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message: message2, signature: "0x1234" } });
    expect([refused.statusCode, refused.json().error.code]).toEqual([401, "invalid_signature"]);

    // Node unreachable: fail closed, reported as an outage (not as a bad signature).
    walletApproves = true;
    fake.failNext("getCode", new Error("primary: eth_getCode: network error"));
    const message3 = await siwe(getAddress(SMART_WALLET));
    const outage = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { message: message3, signature: "0x1234" } });
    expect([outage.statusCode, outage.json().error.code]).toEqual([503, "chain_unavailable"]);
  });

  it("signs out (the token stops working) and rate-limits nonce requests", async () => {
    const { token } = await signIn();
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: bearer(token) })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) })).statusCode).toBe(401);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await app.inject({ method: "GET", url: "/v1/auth/nonce" })).statusCode;
    expect(last).toBe(429);
  });
});

// ---- browser safety --------------------------------------------------------------

describe("CORS and CSRF", () => {
  it("answers preflights for the web app only", async () => {
    const pre = await app.inject({ method: "OPTIONS", url: "/v1/flows", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(pre.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await app.inject({ method: "OPTIONS", url: "/v1/flows", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses cookie-authenticated writes from other origins", async () => {
    const { cookie } = await signIn();
    const session = cookie.split(";")[0] as string;
    const payload = { name: "x", definition: hookFlow };
    expect((await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: session }, payload })).json().error.code).toBe("bad_origin");
    expect((await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: session, origin: "https://evil.example" }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: session, origin: ORIGIN }, payload })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/v1/flows", headers: { cookie: session } })).statusCode).toBe(200); // reads are fine
  });

  it("requires a session everywhere except sign-in, catalogs, health and hooks", async () => {
    for (const url of ["/v1/me", "/v1/flows", "/v1/connections", "/v1/me/usage", "/v1/runs/run_01"]) {
      const res = await app.inject({ method: "GET", url });
      expect([url, res.statusCode, res.json().error.code]).toEqual([url, 401, "unauthenticated"]);
    }
    expect((await app.inject({ method: "GET", url: "/v1/triggers" })).statusCode).toBe(200);
  });
});

// ---- connections -------------------------------------------------------------------

describe("connections", () => {
  it("creates a webhook connection and shows its signing secret exactly once", async () => {
    const { token } = await signIn();
    const res = await app.inject({ method: "POST", url: "/v1/connections", headers: bearer(token), payload: { type: "webhook", url: "https://hooks.example.com/ignitra?k=1" } });
    expect(res.statusCode).toBe(201);
    const { data, signing_secret } = res.json();
    expect(signing_secret).toMatch(/^whsec_/);
    expect(data).toMatchObject({ type: "webhook", label: "Webhook hooks.example.com", metadata: { host: "hooks.example.com" } });
    const list = await app.inject({ method: "GET", url: "/v1/connections", headers: bearer(token) });
    expect(list.json().data).toHaveLength(1);
    expect(list.body).not.toContain(signing_secret);
    expect(list.body).not.toContain("k=1");
  });

  it("verifies Telegram destinations before saving them; the token never comes back", async () => {
    const { token } = await signIn();
    const res = await app.inject({ method: "POST", url: "/v1/connections", headers: bearer(token), payload: { type: "telegram", bot_token: BOT_TOKEN, chat_id: -1001234567890 } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ type: "telegram", label: "Telegram: Test Group", metadata: { chat_id: "-1001234567890", bot_username: "ignitra_bot" } });
    expect(res.body).not.toContain(BOT_TOKEN);
    const bad = await app.inject({ method: "POST", url: "/v1/connections", headers: bearer(token), payload: { type: "telegram", bot_token: "not-a-token", chat_id: "1" } });
    expect([bad.statusCode, bad.json().error.code]).toEqual([422, "invalid_connection"]);
  });

  it("refuses to delete a connection a flow still uses; other owners get 404", async () => {
    const me = await signIn();
    const conn = (await app.inject({ method: "POST", url: "/v1/connections", headers: bearer(me.token), payload: { type: "webhook", url: "https://hooks.example.com/x" } })).json().data;
    const def = { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: [{ step_id: "hook", type: "WEBHOOK", params: { connection_id: conn.id } }] };
    const flow = (await createFlowVia(me.token, def, false)).json().data;
    const inUse = await app.inject({ method: "DELETE", url: `/v1/connections/${conn.id}`, headers: bearer(me.token) });
    expect([inUse.statusCode, inUse.json().error.code, inUse.json().error.flows]).toEqual([409, "connection_in_use", [flow.id]]);
    const stranger = await signIn();
    expect((await app.inject({ method: "DELETE", url: `/v1/connections/${conn.id}`, headers: bearer(stranger.token) })).statusCode).toBe(404);
    // A stranger cannot use it in their flows either.
    const theirs = await createFlowVia(stranger.token, def);
    expect(theirs.statusCode).toBe(422);
    expect(theirs.json().error.issues[0]).toMatchObject({ path: "actions.0.params.connection_id", message: `connection ${conn.id} not found` });
    await app.inject({ method: "DELETE", url: `/v1/flows/${flow.id}`, headers: bearer(me.token) });
    expect((await app.inject({ method: "DELETE", url: `/v1/connections/${conn.id}`, headers: bearer(me.token) })).statusCode).toBe(204);
  });

  it("keeps a VIGIL connection while a flow's trigger listens on it, and checks VIGIL's API URL", async () => {
    const me = await signIn();
    for (const api_url of ["javascript:alert(1)", "not a url", "https://user:pass@vigil.example/api/v1"]) {
      const bad = await app.inject({ method: "POST", url: "/v1/connections", headers: bearer(me.token), payload: { type: "vigil", api_url, api_key: "vgl_test_key_123" } });
      expect([bad.statusCode, bad.json().error.issues[0].path]).toEqual([400, "api_url"]);
    }
    // Without an API key: the connection (and its receiver URL) first, VIGIL's secret second.
    const vigil = await app.inject({ method: "POST", url: "/v1/connections", headers: bearer(me.token), payload: { type: "vigil" } });
    expect(vigil.statusCode).toBe(201);
    const conn = vigil.json().data;
    expect(conn.metadata).toMatchObject({ mode: "manual", verified: false, receiver_url: vigil.json().receiver_url });
    const receiver = new URL(vigil.json().receiver_url as string).pathname;
    const ping = (secret: string) => {
      const raw = JSON.stringify({ type: "ping", delivery_id: "dlv_1" });
      const ts = Math.floor(Date.now() / 1000);
      const signature = `sha256=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;
      return app.inject({ method: "POST", url: receiver, headers: { "content-type": "application/json", "x-vigil-signature": signature, "x-vigil-timestamp": String(ts) }, payload: raw });
    };
    const early = await ping("manual_secret_0123456789abcdef");
    expect([early.statusCode, early.json().error.code]).toEqual([401, "not_ready"]);
    const keyed = await app.inject({ method: "POST", url: `/v1/connections/${conn.id}/verify`, headers: bearer(me.token), payload: { webhook_secret: "manual_secret_0123456789abcdef" } });
    expect(keyed.json().data.metadata).toMatchObject({ mode: "manual", verified: true });
    expect((await ping("manual_secret_0123456789abcdef")).json()).toEqual({ ok: true, type: "ping" });
    expect((await ping("someone_elses_secret_0123456789")).statusCode).toBe(401);
    const hook = (await app.inject({ method: "POST", url: "/v1/connections", headers: bearer(me.token), payload: { type: "webhook", url: "https://hooks.example.com/v" } })).json().data;
    const def = { trigger: { type: "VIGIL_ALERT", params: { connection_id: conn.id } }, actions: [{ step_id: "hook", type: "WEBHOOK", params: { connection_id: hook.id } }] };
    const created = await createFlowVia(me.token, def, false);
    expect(created.statusCode).toBe(201);
    const inUse = await app.inject({ method: "DELETE", url: `/v1/connections/${conn.id}`, headers: bearer(me.token) });
    expect([inUse.statusCode, inUse.json().error.flows]).toEqual([409, [created.json().data.id]]);
  });
});

// ---- flows -----------------------------------------------------------------------

describe("flows", () => {
  it("creates, reads, renames, versions, pauses and deletes — owner only", async () => {
    const me = await signIn();
    const created = await createFlowVia(me.token);
    expect(created.statusCode).toBe(201);
    const flow = created.json().data;
    expect(flow).toMatchObject({ name: "My flow", status: "active", version: 1, trigger_type: "INBOUND_WEBHOOK", actions: ["WEBHOOK"] });
    expect(flow.hook_url).toMatch(new RegExp(`^http://api\\.test/v1/hooks/${flow.id}/[A-Za-z0-9_-]{43}$`));
    expect(flow.definition.settings).toEqual({ mode: "confirmed", max_runs_per_hour: 60, onchain: false });

    const stranger = await signIn();
    expect((await app.inject({ method: "GET", url: `/v1/flows/${flow.id}`, headers: bearer(stranger.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/pause`, headers: bearer(stranger.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/flows", headers: bearer(stranger.token) })).json().data).toEqual([]);

    const renamed = await app.inject({ method: "PATCH", url: `/v1/flows/${flow.id}`, headers: bearer(me.token), payload: { name: "  Orders  " } });
    expect(renamed.json().data).toMatchObject({ name: "Orders", version: 1 });
    const v2 = await app.inject({
      method: "PATCH",
      url: `/v1/flows/${flow.id}`,
      headers: bearer(me.token),
      payload: { definition: { ...hookFlow, conditions: { all: [{ field: "body.total", op: ">=", value: 100 }] } } },
    });
    expect(v2.json().data).toMatchObject({ version: 2, hook_url: flow.hook_url }); // the URL survives new versions
    expect((await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/pause`, headers: bearer(me.token) })).json().data.status).toBe("paused");
    expect((await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/resume`, headers: bearer(me.token) })).json().data.status).toBe("active");
    const rotated = (await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/hook/rotate`, headers: bearer(me.token) })).json().data.hook_url;
    expect(rotated).not.toBe(flow.hook_url);
    expect((await app.inject({ method: "DELETE", url: `/v1/flows/${flow.id}`, headers: bearer(me.token) })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/v1/flows/${flow.id}`, headers: bearer(me.token) })).statusCode).toBe(404);
  });

  it("returns every validation issue with its path (422)", async () => {
    const me = await signIn();
    const res = await createFlowVia(me.token, { trigger: { type: "TOKEN_TRANSFER", params: { token: "0xnope" } }, actions: [] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: "invalid_flow", issues: [{ path: "actions", message: expect.any(String) }] });
    const sched = await createFlowVia(me.token, { trigger: { type: "SCHEDULE", params: { cron: "*/5 * * * *" } }, actions: hookFlow.actions });
    expect(sched.json().error.issues[0].message).toBe("SCHEDULE needs the builder plan (you are on free)");
    await h.db.update(users).set({ plan: "builder" }).where(eq(users.id, me.userId)); // SCHEDULE is a Builder feature
    const dry = await app.inject({ method: "POST", url: "/v1/flows/validate", headers: bearer(me.token), payload: { definition: { trigger: { type: "SCHEDULE", params: { cron: "0 9 * * 1-5" } }, actions: hookFlow.actions } } });
    expect(dry.json().data.definition.trigger.params).toEqual({ cron: "0 9 * * 1-5", timezone: "Asia/Jakarta" });
    expect(dry.json().data.trigger_fields.map((f: { path: string }) => f.path)).toContain("scheduled_at_local");
  });

  it("enforces the plan's active-flow limit (402) and reports usage", async () => {
    const me = await signIn();
    for (let i = 0; i < 3; i++) expect((await createFlowVia(me.token)).statusCode).toBe(201);
    const fourth = await createFlowVia(me.token);
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json().error).toMatchObject({ code: "plan_limit_reached", limit: "active_flows", plan: "free", max: 3 });
    const paused = (await createFlowVia(me.token, hookFlow, false)).json().data;
    expect((await app.inject({ method: "POST", url: `/v1/flows/${paused.id}/resume`, headers: bearer(me.token) })).statusCode).toBe(402);

    await h.db.insert(usageMonthly).values({ userId: me.userId, period: usagePeriod(), runs: 120, planLimited: 0 });
    const usage = (await app.inject({ method: "GET", url: "/v1/me/usage", headers: bearer(me.token) })).json().data;
    expect(usage).toMatchObject({ plan: "free", period: usagePeriod(), runs: { used: 120, included: 500, remaining: 380, overage: 0 }, active_flows: { used: 3, limit: 3 } });
    expect(Date.parse(usage.resets_at)).toBeGreaterThan(Date.now());
  });

  it("lists runs with cursor pagination and returns full traces, owner only", async () => {
    const me = await signIn();
    const flow = (await createFlowVia(me.token)).json().data;
    const ids: string[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      const id = newId("run", t0 + i); // ULIDs order by time; within one millisecond the order is random
      ids.push(id);
      await h.db.insert(runs).values({ id, flowId: flow.id, flowVersion: 1, idempotencyKey: `k${i}`, triggerType: "INBOUND_WEBHOOK", triggerEvent: { body: { i } }, status: "succeeded", finishedAt: new Date() });
    }
    await h.db.insert(runSteps).values({ runId: ids[2] as string, stepId: "hook", position: 0, actionType: "WEBHOOK", status: "succeeded", attempts: 1, httpStatus: 200, finishedAt: new Date() });
    const page = (await app.inject({ method: "GET", url: `/v1/flows/${flow.id}/runs?limit=2`, headers: bearer(me.token) })).json();
    expect(page.data.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]]);
    const rest = (await app.inject({ method: "GET", url: `/v1/flows/${flow.id}/runs?limit=2&before=${page.next_before}`, headers: bearer(me.token) })).json();
    expect(rest.data.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
    const trace = (await app.inject({ method: "GET", url: `/v1/runs/${ids[2]}`, headers: bearer(me.token) })).json().data;
    expect(trace).toMatchObject({ status: "succeeded", trigger_event: { body: { i: 2 } }, steps: [{ step_id: "hook", http_status: 200 }] });
    const stranger = await signIn();
    expect((await app.inject({ method: "GET", url: `/v1/runs/${ids[2]}`, headers: bearer(stranger.token) })).statusCode).toBe(404);
  });
});

// ---- account -------------------------------------------------------------------------

describe("account", () => {
  it("hands the owner their webhook verification secret, updates the timezone, stores push subscriptions", async () => {
    const me = await signIn();
    const secret = (await app.inject({ method: "GET", url: "/v1/me/webhook-secret", headers: bearer(me.token) })).json().data.secret;
    expect(secret).toBe(deriveOwnerSigningSecret(MASTER, me.userId));
    const tz = await app.inject({ method: "PATCH", url: "/v1/me", headers: bearer(me.token), payload: { timezone: "Asia/Makassar" } });
    expect(tz.json().data.timezone).toBe("Asia/Makassar");
    expect((await app.inject({ method: "PATCH", url: "/v1/me", headers: bearer(me.token), payload: { timezone: "Nowhere/Land" } })).statusCode).toBe(400);

    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
    expect((await app.inject({ method: "POST", url: "/v1/push/subscriptions", headers: bearer(me.token), payload: sub })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/v1/push/subscriptions", headers: bearer(me.token), payload: { ...sub, keys: { ...sub.keys, auth: "short" } } })).statusCode).toBe(422);
    const list = (await app.inject({ method: "GET", url: "/v1/push/subscriptions", headers: bearer(me.token) })).json().data;
    expect(list).toEqual([expect.objectContaining({ endpoint_host: "fcm.googleapis.com" })]);
  });
});

// ---- inbound webhooks ---------------------------------------------------------------------

describe("inbound webhooks", () => {
  async function activeHook() {
    const me = await signIn();
    const flow = (await createFlowVia(me.token)).json().data;
    return { me, flow, path: new URL(flow.hook_url as string).pathname };
  }

  it("accepts JSON, form and text bodies (202) and stores them for the matcher", async () => {
    const { flow, path } = await activeHook();
    const json = await app.inject({ method: "POST", url: `${path}?source=shop`, payload: { order: "A-1", total: 120 }, headers: { "user-agent": "shop/1.0", "x-shop-event": "order.paid", "x-api-key": "hidden" } });
    expect(json.statusCode).toBe(202);
    expect(json.json()).toMatchObject({ accepted: true, duplicate: false, request_id: expect.stringMatching(/^req_/) });
    await app.inject({ method: "POST", url: path, payload: "a=1&b=two", headers: { "content-type": "application/x-www-form-urlencoded" } });
    await app.inject({ method: "POST", url: path, payload: "plain words", headers: { "content-type": "text/plain" } });
    const rows = await h.db.select().from(inboundEvents).where(eq(inboundEvents.flowId, flow.id)).orderBy(inboundEvents.id);
    expect(rows.map((r) => r.body)).toEqual([{ order: "A-1", total: 120 }, { a: "1", b: "two" }, { text: "plain words" }]);
    expect(rows[0]?.query).toEqual({ source: "shop" });
    expect(rows[0]?.headers).toMatchObject({ user_agent: "shop/1.0", x_shop_event: "order.paid" });
    expect(rows[0]?.headers).not.toHaveProperty("x_api_key");
  });

  it("deduplicates by Idempotency-Key", async () => {
    const { path } = await activeHook();
    const send = () => app.inject({ method: "POST", url: path, payload: { n: 1 }, headers: { "idempotency-key": "order-A-1" } });
    const first = (await send()).json();
    const again = (await send()).json();
    expect(again).toEqual({ accepted: true, duplicate: true, request_id: first.request_id });
    expect(await h.db.select().from(inboundEvents)).toHaveLength(1);
  });

  it("hides unknown flows and wrong tokens (404), refuses paused flows (409) and oversized bodies (413)", async () => {
    const { me, flow, path } = await activeHook();
    expect((await app.inject({ method: "POST", url: `${path.slice(0, -4)}AAAA`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/hooks/${newId("flow")}/${path.split("/").pop()}`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: path, payload: { big: "x".repeat(70_000) } })).statusCode).toBe(413);
    await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/pause`, headers: bearer(me.token) });
    const paused = await app.inject({ method: "POST", url: path, payload: {} });
    expect([paused.statusCode, paused.json().error.code]).toEqual([409, "flow_inactive"]);
  });

  it("stops accepting the old URL after rotation, and rate-limits per hook", async () => {
    const { me, flow, path } = await activeHook();
    const rotated = (await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/hook/rotate`, headers: bearer(me.token) })).json().data.hook_url as string;
    expect((await app.inject({ method: "POST", url: path, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: new URL(rotated).pathname, payload: {} })).statusCode).toBe(202);

    const limited = await server({ inboundRatePerMinute: 2 });
    const url = new URL(rotated).pathname;
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await limited.inject({ method: "POST", url, payload: {} })).statusCode);
    expect(codes).toEqual([202, 202, 429]);
    await limited.close();
  });

  it("bounds guessing per sender address: failed lookups spend a budget, deliveries do not", async () => {
    const { path } = await activeHook();
    const sender = { remoteAddress: "198.51.100.23" };
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "POST", url: path, payload: { i }, ...sender })).statusCode).toBe(202);
    const guess = `/v1/hooks/${newId("flow")}/${"A".repeat(43)}`;
    const misses = new Set<number>();
    for (let i = 0; i < 120; i++) misses.add((await app.inject({ method: "POST", url: guess, payload: {}, ...sender })).statusCode);
    expect([...misses]).toEqual([404]);
    // Spent: this address waits (even for real hooks) until the budget refills; others do not.
    const blocked = await app.inject({ method: "POST", url: guess, payload: {}, ...sender });
    expect([blocked.statusCode, typeof blocked.headers["retry-after"]]).toEqual([429, "string"]);
    expect((await app.inject({ method: "POST", url: path, payload: {}, remoteAddress: "198.51.100.24" })).statusCode).toBe(202);
  });

  it("stores nothing that could never run: free-plan quota (402) and a daily intake cap (429)", async () => {
    const { me, path } = await activeHook();
    await h.db.insert(usageMonthly).values({ userId: me.userId, period: usagePeriod(), runs: 500 });
    const exhausted = await app.inject({ method: "POST", url: path, payload: {} });
    expect([exhausted.statusCode, exhausted.json().error.code]).toEqual([402, "plan_quota_exhausted"]);
    await h.db.delete(usageMonthly);

    const capped = await server({ inboundDailyLimit: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await capped.inject({ method: "POST", url: path, payload: { i } })).statusCode);
    expect(codes).toEqual([202, 202, 429]);
    await capped.close();
  });

  it("is unavailable without WEBHOOK_SIGNING_SECRET (no unsigned URLs)", async () => {
    const plain = await server({ webhookMaster: null });
    const me = await (async () => {
      const prev = app;
      app = plain;
      try {
        return await signIn();
      } finally {
        app = prev;
      }
    })();
    const res = await plain.inject({ method: "POST", url: "/v1/flows", headers: bearer(me.token), payload: { name: "x", definition: hookFlow } });
    expect([res.statusCode, res.json().error.code]).toEqual([503, "not_configured"]);
    await plain.close();
  });
});
