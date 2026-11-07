import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import ece from "http_ece";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderTemplate, type ActionConnection, type ActionContext, type SafeHttpClient, type SafeHttpRequest } from "@ignitra/core";
import { createDb, pushSubscriptions, users, type DbHandle } from "@ignitra/db";
import { checkTelegramHtml, createTelegramAction, telegramParams } from "./actions/telegram";
import { webPushAction } from "./actions/web-push";
import { webhookAction, webhookParams } from "./actions/webhook";
import { createSafeHttp } from "./http";
import { WebPushSender, addPushSubscription, assertVapid, generateVapidKeys } from "./push";
import { deriveOwnerSigningSecret, verifyWebhookSignature } from "./signing";

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let base: string;
let received: Received[] = [];
let reply: (r: Received) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: { ok: true } });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      received.push(r);
      const out = reply(r);
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

afterEach(() => {
  received = [];
  reply = () => ({ status: 200, body: { ok: true } });
});

const http = createSafeHttp({ allowPrivate: true });
const trigger = {
  amount_formatted: "1,234.5",
  from: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
  token: { symbol: "<b>EVIL</b>&co" },
  explorer_url: "https://robinhoodchain.blockscout.com/tx/0xabc",
};

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  const scope = { trigger, steps: {}, flow: { id: "fl_1", name: "Big buys", version: 1 }, run: { id: "run_1", idempotency_key: "4663:0xabc:7:fl_1", test: false }, now_utc: "", now_wib: "" };
  return {
    runId: "run_1",
    flowId: "fl_1",
    flowName: "Big buys",
    flowVersion: 1,
    stepId: "notify",
    idempotencyKey: "4663:0xabc:7:fl_1:notify",
    runIdempotencyKey: "4663:0xabc:7:fl_1",
    attempt: 1,
    isTest: false,
    signal: new AbortController().signal,
    trigger,
    render: (t, escape) => renderTemplate(t, scope, { escape: escape ?? "none" }),
    connection: null,
    http,
    push: null,
    ownerSigningSecret: deriveOwnerSigningSecret("master", "usr_owner"),
    chain: null,
    ...overrides,
  };
}

describe("WEBHOOK", () => {
  it("POSTs a signed envelope the receiver can verify, with a stable idempotency key", async () => {
    const result = await webhookAction.execute({ url: `${base}/hook` }, ctx({ attempt: 2 }));
    expect(result).toMatchObject({ status: "succeeded", httpStatus: 200, output: { status: 200, body: { ok: true } } });
    const [r] = received;
    expect(r?.headers["x-ignitra-idempotency-key"]).toBe("4663:0xabc:7:fl_1:notify");
    expect(r?.headers["x-ignitra-event"]).toBe("run.action");
    expect(
      verifyWebhookSignature({
        secret: deriveOwnerSigningSecret("master", "usr_owner"),
        body: r?.body ?? "",
        signature: r?.headers["x-ignitra-signature"] as string,
        timestamp: r?.headers["x-ignitra-timestamp"] as string,
      }),
    ).toBe(true);
    expect(JSON.parse(r?.body ?? "{}")).toMatchObject({
      type: "run.action",
      run_id: "run_1",
      flow_id: "fl_1",
      step_id: "notify",
      idempotency_key: "4663:0xabc:7:fl_1:notify",
      run_idempotency_key: "4663:0xabc:7:fl_1",
      attempt: 2,
      test: false,
      trigger,
    });
  });

  it("maps receiver answers to retry / permanent failure", async () => {
    const run = async (status: number, headers: Record<string, string> = {}) => {
      reply = () => ({ status, body: { error: "x" }, headers });
      return webhookAction.execute({ url: `${base}/hook` }, ctx());
    };
    expect(await run(500)).toMatchObject({ status: "failed", retryable: true, httpStatus: 500 });
    expect(await run(429, { "retry-after": "7" })).toMatchObject({ status: "failed", retryable: true, retryAfterMs: 7000 });
    expect(await run(404)).toMatchObject({ status: "failed", retryable: false });
    expect(await run(302, { location: "http://169.254.169.254/" })).toMatchObject({ status: "failed", retryable: false, error: expect.stringContaining("redirects are not followed") });
  });

  it("is blocked from private networks unless the runner allows them", async () => {
    const strict = await webhookAction.execute({ url: `${base}/hook` }, ctx({ http: createSafeHttp() }));
    expect(strict).toMatchObject({ status: "failed", retryable: false, error: expect.stringMatching(/^blocked: .*private/) });
  });

  it("uses a connection's URL and secret, and never exposes the URL in traces", async () => {
    const connection: ActionConnection = { id: "conn_x", type: "webhook", label: "prod", metadata: {}, secret: { url: `${base}/secret-token/hook`, signing_secret: "whsec_conn" } };
    const result = await webhookAction.execute({ connection_id: "conn_01jabcdefghjkmnpqrstvwxyz0" }, ctx({ connection }));
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result.request)).not.toContain("secret-token");
    const [r] = received;
    expect(verifyWebhookSignature({ secret: "whsec_conn", body: r?.body ?? "", signature: r?.headers["x-ignitra-signature"] as string, timestamp: r?.headers["x-ignitra-timestamp"] as string })).toBe(true);
  });

  it("validates params: exactly one of url / connection_id", () => {
    expect(webhookParams.safeParse({}).success).toBe(false);
    expect(webhookParams.safeParse({ url: "https://a.example", connection_id: "conn_01jabcdefghjkmnpqrstvwxyz0" }).success).toBe(false);
    expect(webhookParams.safeParse({ url: "ftp://a.example" }).success).toBe(false);
    expect(webhookParams.safeParse({ url: "https://u:p@a.example" }).success).toBe(false);
    expect(webhookParams.safeParse({ url: "https://a.example/hook" }).success).toBe(true);
  });

  it("fails clearly when no signing secret is configured", async () => {
    expect(await webhookAction.execute({ url: `${base}/hook` }, ctx({ ownerSigningSecret: null }))).toMatchObject({ status: "failed", retryable: false, error: expect.stringContaining("WEBHOOK_SIGNING_SECRET") });
  });
});

describe("TELEGRAM", () => {
  const TOKEN = "1234567890:AAH-abcdefghijklmnopqrstuvwxyz0123456";
  // Created lazily: the stub server URL is only known after beforeAll.
  const telegram = { execute: (...args: Parameters<ReturnType<typeof createTelegramAction>["execute"]>) => createTelegramAction({ apiBase: `${base}/tg` }).execute(...args) };
  const connection: ActionConnection = { id: "conn_t", type: "telegram", label: "alerts", metadata: { chat_id: "-1001234567890" }, secret: { bot_token: TOKEN } };
  const params = telegramParams.parse({
    connection_id: "conn_01jabcdefghjkmnpqrstvwxyz0",
    text: "🔥 <b>New buy</b> {{trigger.amount_formatted}} {{trigger.token.symbol}}\n<a href=\"{{trigger.explorer_url}}\">tx</a>",
  });

  it("sends HTML with every substituted value escaped (on-chain data cannot inject markup)", async () => {
    reply = () => ({ status: 200, body: { ok: true, result: { message_id: 77, chat: { id: -1001234567890 } } } });
    const result = await telegram.execute(params, ctx({ connection }));
    expect(result).toMatchObject({ status: "succeeded", output: { message_id: 77, chat_id: "-1001234567890" } });
    const [r] = received;
    expect(r?.url).toBe(`/tg/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(r?.body ?? "{}")).toEqual({
      chat_id: "-1001234567890",
      text: '🔥 <b>New buy</b> 1,234.5 &lt;b&gt;EVIL&lt;/b&gt;&amp;co\n<a href="https://robinhoodchain.blockscout.com/tx/0xabc">tx</a>',
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: false,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN); // traces never carry the bot token
  });

  it("honours Telegram's retry_after and reports permanent errors with their reason", async () => {
    reply = () => ({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } } });
    expect(await telegram.execute(params, ctx({ connection }))).toMatchObject({ status: "failed", retryable: true, retryAfterMs: 3000 });
    reply = () => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } });
    expect(await telegram.execute(params, ctx({ connection }))).toMatchObject({ status: "failed", retryable: false, error: "Telegram: Bad Request: chat not found" });
    reply = () => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded", parameters: { migrate_to_chat_id: -100999 } } });
    expect(await telegram.execute(params, ctx({ connection }))).toMatchObject({ status: "failed", retryable: false, error: expect.stringContaining("-100999") });
    reply = () => ({ status: 502, body: { ok: false } });
    expect(await telegram.execute(params, ctx({ connection }))).toMatchObject({ status: "failed", retryable: true });
  });

  it("falls back to plain text when a message exceeds Telegram's limit", async () => {
    reply = () => ({ status: 200, body: { ok: true, result: { message_id: 1, chat: { id: 1 } } } });
    const long = telegramParams.parse({ connection_id: "conn_01jabcdefghjkmnpqrstvwxyz0", text: `<b>{{trigger.memo}}</b>` });
    await telegram.execute(long, ctx({ connection, render: () => `<b>${"x".repeat(5000)}</b>` }));
    const sent = JSON.parse(received[0]?.body ?? "{}") as { text: string; parse_mode?: string };
    expect(sent.text.length).toBe(4096);
    expect(sent.parse_mode).toBeUndefined();
  });

  it("validates the template's markup against Telegram's HTML subset", () => {
    expect(checkTelegramHtml("<b>ok</b> <i>{{trigger.x}}</i> &lt; &amp; <a href=\"x\">y</a>")).toEqual([]);
    expect(checkTelegramHtml("<div>x</div>")[0]).toMatch(/<div> is not supported/);
    expect(checkTelegramHtml("<b>never closed")).toEqual(["<b> is never closed"]);
    expect(checkTelegramHtml("a < b & c")).toEqual(expect.arrayContaining([expect.stringMatching(/&lt;/), expect.stringMatching(/&amp;/)]));
    expect(checkTelegramHtml("&nbsp;")[0]).toMatch(/not supported/);
    expect(telegramParams.safeParse({ connection_id: "conn_01jabcdefghjkmnpqrstvwxyz0", text: "a < b" }).success).toBe(false);
    expect(telegramParams.safeParse({ connection_id: "conn_01jabcdefghjkmnpqrstvwxyz0", text: "a < b", parse_mode: "plain" }).success).toBe(true);
  });
});

describe("WEB_PUSH", () => {
  let h: DbHandle;

  beforeAll(async () => {
    h = await createDb("pglite://memory");
    await h.migrate();
    await h.db.insert(users).values({ id: "usr_owner", address: "0x00000000000000000000000000000000000000a1" });
  });

  afterAll(async () => {
    await h.close();
  });

  it("encrypts per RFC 8291 and signs per RFC 8292 — verified by decrypting as the browser would", async () => {
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const auth = randomBytes(16);
    await addPushSubscription(h.db, "usr_owner", { endpoint: "https://push.example.net/send/abc", keys: { p256dh: browser.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } });

    const captured: SafeHttpRequest[] = [];
    const fakeHttp: SafeHttpClient = { request: async (req) => (captured.push(req), { status: 201, headers: {}, body: "", durationMs: 1 }) };
    const vapid = { ...generateVapidKeys(), subject: "mailto:ops@example.com" };
    const sender = new WebPushSender({ db: h.db, vapid, http: fakeHttp });
    const result = await webPushAction.execute(
      { title: "Whale sell {{trigger.token.symbol}}", body: "{{trigger.amount_formatted}}", url: "{{trigger.explorer_url}}" },
      ctx({ push: { send: (m) => sender.sendToUser("usr_owner", m) } }),
    );
    expect(result).toMatchObject({ status: "succeeded", output: { delivered: 1, subscriptions: 1 } });

    const req = captured[0];
    expect(req?.url).toBe("https://push.example.net/send/abc");
    expect(req?.headers?.["content-encoding"]).toBe("aes128gcm");
    const plaintext = ece.decrypt(Buffer.from(req?.body as Uint8Array), { version: "aes128gcm", privateKey: browser, authSecret: auth.toString("base64url") });
    expect(JSON.parse(plaintext.toString("utf8"))).toEqual({ title: "Whale sell <b>EVIL</b>&co", body: "1,234.5", url: trigger.explorer_url, tag: "fl_1" });

    // VAPID: "vapid t=<jwt>, k=<public key>" — verify the ES256 JWT with the server's public key.
    const m = /vapid t=([^,]+), k=(.+)/.exec(req?.headers?.authorization ?? "");
    expect(m?.[2]).toBe(vapid.publicKey);
    const [header, payload, signature] = (m?.[1] ?? "").split(".");
    const point = Buffer.from(vapid.publicKey, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature ?? "", "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({ aud: "https://push.example.net", sub: "mailto:ops@example.com" });
  });

  it("disables gone subscriptions and skips when the owner has none left", async () => {
    const fakeHttp: SafeHttpClient = { request: async () => ({ status: 410, headers: {}, body: "", durationMs: 1 }) };
    const sender = new WebPushSender({ db: h.db, vapid: { ...generateVapidKeys(), subject: "mailto:x@example.com" }, http: fakeHttp });
    const first = await webPushAction.execute({ title: "t", body: "b" }, ctx({ push: { send: (m) => sender.sendToUser("usr_owner", m) } }));
    expect(first).toMatchObject({ status: "skipped", reason: expect.stringContaining("expired") });
    const [sub] = await h.db.select().from(pushSubscriptions);
    expect(sub?.disabledAt).toBeInstanceOf(Date);
    const second = await webPushAction.execute({ title: "t", body: "b" }, ctx({ push: { send: (m) => sender.sendToUser("usr_owner", m) } }));
    expect(second).toMatchObject({ status: "skipped", reason: "the flow owner has no active push subscriptions" });
  });

  it("accepts keys generated like `pnpm gen:vapid` and rejects broken ones at startup", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pub = publicKey.export({ format: "jwk" });
    const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(pub.x ?? "", "base64url"), Buffer.from(pub.y ?? "", "base64url")]);
    const vapid = { publicKey: point.toString("base64url"), privateKey: privateKey.export({ format: "jwk" }).d ?? "", subject: "mailto:ops@example.com" };
    expect(() => assertVapid(vapid)).not.toThrow();
    expect(() => assertVapid({ ...vapid, privateKey: "short" })).toThrow(/invalid VAPID configuration/);
    expect(() => assertVapid({ ...vapid, subject: "not-a-url" })).toThrow(/invalid VAPID configuration/);
  });

  it("rejects malformed subscriptions and fails clearly without VAPID keys", async () => {
    await expect(addPushSubscription(h.db, "usr_owner", { endpoint: "http://push.example.net/x", keys: { p256dh: "a", auth: "b" } })).rejects.toThrow(/endpoint/);
    await expect(addPushSubscription(h.db, "usr_owner", { endpoint: "https://push.example.net/x", keys: { p256dh: "abc", auth: "def" } })).rejects.toThrow(/p256dh/);
    expect(await webPushAction.execute({ title: "t", body: "b" }, ctx())).toMatchObject({ status: "failed", retryable: false, error: expect.stringContaining("VAPID") });
  });
});
