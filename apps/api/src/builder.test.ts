import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChainConfig } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { FakeChain, addr } from "@ignitra/chain/testing";
import { createRunner, createSafeHttp } from "@ignitra/actions";
import { connections, createDb, flowStats, flows, runSteps, runs, sessions, usageMonthly, users, type DbHandle } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import { createSession } from "./auth";
import { buildServer } from "./server";

/** Phase 6 API: address detection, live samples, variables, "Test flow", email / http / Google connections. */

const chainConfig = resolveChainConfig({ chainId: 4663 });
const logger = createLogger("api-test", "silent");
const MASTER = "builder-test-webhook-master";
const BOT_TOKEN = "1234567890:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const TOKEN = addr(0x70c);
const WHALE = addr(0x3a1e);
const ALICE = addr(0xa11ce);
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });

interface Hit {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
let stub: Server;
let base: string;
let hits: Hit[] = [];
let h: DbHandle;
let chain: FakeChain;
let wakeups = 0;

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", (): void => {
      const hit = { url: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      res.setHeader("content-type", "application/json");
      if (hit.url.startsWith("/tg/")) {
        res.end(JSON.stringify({ ok: true, result: { message_id: hits.length, title: "Ops", type: "group", chat: { id: -1 } } }));
        return;
      }
      if (hit.url === "/resend/emails") {
        res.end(JSON.stringify({ id: `email_${hits.length}` }));
        return;
      }
      if (hit.url === "/oauth/token") {
        const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@gmail.example" })).toString("base64url")}.y`;
        res.end(JSON.stringify({ access_token: "ya29.a", refresh_token: "1//refresh", expires_in: 3599, id_token: idToken, scope: "openid email https://www.googleapis.com/auth/spreadsheets" }));
        return;
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  h = await createDb("pglite://memory");
  await h.migrate();
  chain = new FakeChain({ logTimestamps: false });
  const token = chain.token(TOKEN, { symbol: "USDG", name: "Global Dollar", decimals: 6 });
  token.seed(WHALE, 10n ** 12n);
  chain.mine([token.transfer(WHALE, ALICE, 250_000_000n)]); // 250 USDG
  chain.mineEmpty(30);
}, 30_000);

afterAll(async () => {
  stub.closeAllConnections();
  stub.close();
  await h.close();
});

beforeEach(async () => {
  for (const t of [runs, sessions, usageMonthly, connections, flowStats]) await h.db.delete(t);
  await h.db.delete(flows);
  await h.db.delete(users);
  hits = [];
  wakeups = 0;
  app = await buildServer({
    db: h,
    chain: chainConfig,
    logger,
    version: "test",
    corsOrigins: ["http://localhost:3000"],
    publicUrl: "http://api.test",
    webUrl: "http://localhost:3000",
    reader: chain,
    keyring,
    webhookMaster: MASTER,
    allowPrivateOutbound: true,
    telegramApiBase: `${base}/tg`,
    email: { provider: "resend", apiKey: "re_test_key", from: "IGNITRA <alerts@ignitra.example>", apiBase: `${base}/resend` },
    google: { clientId: "client-id.apps", clientSecret: "client-secret", redirectUri: "http://localhost:3000/api/v1/connections/google/callback", tokenUrl: `${base}/oauth/token`, sheetsUrl: `${base}/sheets` },
    confirmationDepth: 0,
    onRunQueued: () => wakeups++,
  });
});

async function session(plan: "free" | "builder" = "free") {
  const userId = await ensureUser(h.db, addr(Math.floor(Math.random() * 1e9)));
  await h.db.update(users).set({ plan }).where(eq(users.id, userId));
  const { token } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
  return { userId, auth: { authorization: `Bearer ${token}` }, cookie: `ignitra_session=${token}` };
}

describe("address detection", () => {
  it("recognizes tokens, contracts and wallets on paste", async () => {
    const me = await session();
    const token = (await app.inject({ method: "GET", url: `/v1/chain/addresses/${TOKEN}`, headers: me.auth })).json().data;
    expect(token).toMatchObject({ kind: "token", is_contract: true, token: { symbol: "USDG", name: "Global Dollar", decimals: 6, total_supply: "1000000000000" } });
    expect(token.abi.events).toContain("event Transfer(address indexed from, address indexed to, uint256 value)");
    expect(token.abi.functions).toContain("function balanceOf(address account) view returns (uint256)");
    const wallet = (await app.inject({ method: "GET", url: `/v1/chain/addresses/${ALICE}`, headers: me.auth })).json().data;
    expect(wallet).toMatchObject({ kind: "wallet", is_contract: false, token: null, checksum: expect.stringMatching(/^0x/) });
    expect((await app.inject({ method: "GET", url: "/v1/chain/addresses/0x123", headers: me.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/v1/chain/addresses/${TOKEN}` })).statusCode).toBe(401);
  });
});

describe("samples and variables", () => {
  it("returns the latest real event, scheduled time or pasted request", async () => {
    const me = await session();
    const transfer = (await app.inject({ method: "POST", url: "/v1/samples", headers: me.auth, payload: { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } } } })).json().data;
    expect(transfer).toMatchObject({ kind: "event", payload: { to: ALICE, amount_decimal: "250", block_number: 1, token: { symbol: "USDG" } } });
    const time = (await app.inject({ method: "POST", url: "/v1/samples", headers: me.auth, payload: { trigger: { type: "SCHEDULE", params: { cron: "0 8 * * *" } } } })).json().data;
    expect(time).toMatchObject({ kind: "time", payload: { scheduled_at_local: expect.stringMatching(/08:00:00 WIB$/) } });
    const pasted = (await app.inject({ method: "POST", url: "/v1/samples", headers: me.auth, payload: { trigger: { type: "INBOUND_WEBHOOK", params: {} }, body: { order: "A-1" } } })).json().data;
    expect(pasted).toMatchObject({ kind: "request", payload: { body: { order: "A-1" } } });
    const none = (await app.inject({ method: "POST", url: "/v1/samples", headers: me.auth, payload: { trigger: { type: "TOKEN_TRANSFER", params: { token: addr(0xdead) } } } })).json();
    expect(none).toMatchObject({ data: null, hint: expect.stringMatching(/no matching event/) });
    const bad = await app.inject({ method: "POST", url: "/v1/samples", headers: me.auth, payload: { trigger: { type: "TOKEN_TRANSFER", params: { token: "0xnope" } } } });
    expect([bad.statusCode, bad.json().error.issues[0].path]).toEqual([422, "trigger.params.token"]);
  });

  it("lists variables for the picker: trigger fields and each step's typed outputs", async () => {
    const me = await session();
    const res = await app.inject({
      method: "POST",
      url: "/v1/catalog/fields",
      headers: me.auth,
      payload: {
        trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
        actions: [{ step_id: "supply", type: "CHAIN_READ", params: { address: TOKEN, function: "function totalSupply() view returns (uint256)" } }],
      },
    });
    const data = res.json().data;
    expect(data.trigger.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["amount_formatted", "token.symbol", "explorer_url", "time.hour_wib"]));
    expect(data.steps.supply).toEqual(expect.arrayContaining([expect.objectContaining({ path: "result", type: "uint" })]));
    expect(data.builtins).toContain("now_wib");
  });
});

describe("Test flow", () => {
  const telegramFlow = (connectionId: string) => ({
    trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
    conditions: { all: [{ field: "amount_decimal", op: ">=", value: "1000" }] },
    actions: [{ step_id: "notify", type: "TELEGRAM", params: { connection_id: connectionId, text: "{{trigger.amount_formatted}} {{trigger.token.symbol}} → {{trigger.to | short}}" } }],
  });

  it("runs the actions with the latest real event, marked TEST, unmetered, on a paused draft", async () => {
    const me = await session();
    const conn = (await app.inject({ method: "POST", url: "/v1/connections", headers: me.auth, payload: { type: "telegram", bot_token: BOT_TOKEN, chat_id: "-1001" } })).json().data;
    const flow = (await app.inject({ method: "POST", url: "/v1/flows", headers: me.auth, payload: { name: "Big buys", definition: telegramFlow(conn.id) } })).json().data;
    expect(flow.status).toBe("paused");

    const res = await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/test`, headers: me.auth, payload: {} });
    expect(res.statusCode).toBe(202);
    const body = res.json().data;
    expect(body).toMatchObject({ run: { test: true, status: "queued" }, conditions_passed: false, sample: { kind: "event" } }); // 250 < 1000: a real run would not have happened
    expect(wakeups).toBe(1);

    const runner = createRunner({ db: h.db, owner: "r", logger, keyring, webhookMaster: MASTER, vapid: null, http: createSafeHttp({ allowPrivate: true }), telegramApiBase: `${base}/tg` });
    await runner.pass();
    await runner.drain();
    const trace = (await app.inject({ method: "GET", url: `/v1/runs/${body.run.id}`, headers: me.auth })).json().data;
    expect(trace).toMatchObject({ test: true, status: "succeeded", steps: [{ step_id: "notify", status: "succeeded" }] });
    const sent = hits.filter((x) => x.url.endsWith("/sendMessage")).map((x) => JSON.parse(x.body).text);
    expect(sent).toEqual([`🧪 <b>TEST</b> · 250 USDG → ${ALICE.slice(0, 6)}…${ALICE.slice(-4)}`]);
    expect(await h.db.select().from(usageMonthly)).toEqual([]); // never metered
    expect((await h.db.select().from(flowStats).where(eq(flowStats.flowId, flow.id)))[0]?.runs ?? 0).toBe(0);
    expect((await h.db.select().from(runSteps)).length).toBe(1);
  });

  it("accepts a provided sample; without any event there is nothing to test with (409)", async () => {
    const me = await session();
    const conn = (await app.inject({ method: "POST", url: "/v1/connections", headers: me.auth, payload: { type: "telegram", bot_token: BOT_TOKEN, chat_id: "-1001" } })).json().data;
    const def = { ...telegramFlow(conn.id), trigger: { type: "TOKEN_TRANSFER", params: { token: addr(0xdead) } } };
    const flow = (await app.inject({ method: "POST", url: "/v1/flows", headers: me.auth, payload: { name: "Quiet token", definition: def } })).json().data;
    const none = await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/test`, headers: me.auth, payload: {} });
    expect([none.statusCode, none.json().error.code]).toEqual([409, "no_sample"]);
    const custom = await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/test`, headers: me.auth, payload: { sample: { amount_formatted: "5,000", amount_decimal: "5000", token: { symbol: "XYZ" }, to: ALICE } } });
    expect(custom.json().data).toMatchObject({ conditions_passed: true, sample: { kind: "custom" } });
    const stranger = await session();
    expect((await app.inject({ method: "POST", url: `/v1/flows/${flow.id}/test`, headers: stranger.auth, payload: {} })).statusCode).toBe(404);
  });
});

describe("new connection types", () => {
  it("email: verified by a mailed code before a flow may send to it (Builder plan)", async () => {
    const me = await session("builder");
    const created = await app.inject({ method: "POST", url: "/v1/connections", headers: me.auth, payload: { type: "email", address: "ops@team.example" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ verification: "sent", data: { type: "email", metadata: { address: "ops@team.example", verified: false } } });
    const conn = created.json().data;
    const code = /code is (\d{6})/.exec(JSON.parse(hits.find((x) => x.url === "/resend/emails")?.body ?? "{}").text)?.[1] as string;
    const def = { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: [{ step_id: "mail", type: "EMAIL", params: { connection_id: conn.id, subject: "Order {{trigger.body.order}}", body: "Total {{trigger.body.total}}" } }] };
    const early = await app.inject({ method: "POST", url: "/v1/flows", headers: me.auth, payload: { name: "Mail", definition: def } });
    expect(early.json().error.issues[0].message).toMatch(/ops@team\.example is not verified yet/);
    const wrong = await app.inject({ method: "POST", url: `/v1/connections/${conn.id}/verify`, headers: me.auth, payload: { code: code === "000000" ? "111111" : "000000" } });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([422, "invalid_code"]);
    const ok = await app.inject({ method: "POST", url: `/v1/connections/${conn.id}/verify`, headers: me.auth, payload: { code } });
    expect(ok.json().data.metadata).toMatchObject({ verified: true });
    expect((await app.inject({ method: "POST", url: "/v1/flows", headers: me.auth, payload: { name: "Mail", definition: def } })).statusCode).toBe(201);

    const free = await session("free");
    const locked = await app.inject({ method: "POST", url: "/v1/flows", headers: free.auth, payload: { name: "Mail", definition: def } });
    expect(locked.json().error.issues.map((i: { message: string }) => i.message)).toContain("EMAIL needs the builder plan (you are on free)");
  });

  it("bounds verification emails: at most 3 pending addresses per user", async () => {
    const me = await session("builder");
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "POST", url: "/v1/connections", headers: me.auth, payload: { type: "email", address: `p${i}@team.example` } })).statusCode);
    expect(codes).toEqual([201, 201, 201, 409]);
    expect(hits.filter((x) => x.url === "/resend/emails")).toHaveLength(3);
  });

  it("http: secret headers in, never out; bound to one host", async () => {
    const me = await session();
    const res = await app.inject({ method: "POST", url: "/v1/connections", headers: me.auth, payload: { type: "http", host: "api.example.com", headers: [{ name: "Authorization", value: "Bearer sk_live_abc" }] } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ type: "http", label: "HTTP api.example.com", metadata: { host: "api.example.com", header_names: ["Authorization"] } });
    expect(res.body).not.toContain("sk_live_abc");
    expect((await app.inject({ method: "GET", url: "/v1/connections", headers: me.auth })).body).not.toContain("sk_live_abc");
  });

  it("google: OAuth start → consent → callback stores the account and returns to the app", async () => {
    const me = await session();
    const start = (await app.inject({ method: "POST", url: "/v1/connections/google/start", headers: me.auth })).json().data.url as string;
    const state = new URL(start).searchParams.get("state") as string;
    expect(new URL(start).searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/v1/connections/google/callback");

    const cb = await app.inject({ method: "GET", url: `/v1/connections/google/callback?code=4%2Fabc&state=${encodeURIComponent(state)}`, headers: { cookie: me.cookie } });
    expect(cb.statusCode).toBe(302);
    const back = new URL(cb.headers.location as string);
    expect(back.origin + back.pathname).toBe("http://localhost:3000/app/connections");
    expect(back.searchParams.get("google")).toBe("connected");
    const [row] = await h.db.select().from(connections).where(eq(connections.id, back.searchParams.get("connection") as string));
    expect(row).toMatchObject({ type: "google", ownerId: me.userId, metadata: { email: "me@gmail.example" } });
    expect(JSON.stringify(row)).not.toContain("1//refresh"); // encrypted

    const noSession = await app.inject({ method: "GET", url: `/v1/connections/google/callback?code=x&state=${encodeURIComponent(state)}` });
    expect(new URL(noSession.headers.location as string).searchParams.get("google_error")).toMatch(/sign in first/);
    const other = await session();
    const stolen = await app.inject({ method: "GET", url: `/v1/connections/google/callback?code=x&state=${encodeURIComponent(state)}`, headers: { cookie: other.cookie } });
    expect(new URL(stolen.headers.location as string).searchParams.get("google_error")).toMatch(/expired or was not started here/);
    const denied = await app.inject({ method: "GET", url: "/v1/connections/google/callback?error=access_denied", headers: { cookie: me.cookie } });
    expect(new URL(denied.headers.location as string).searchParams.get("google_error")).toBe("access was not granted");
  });
});
