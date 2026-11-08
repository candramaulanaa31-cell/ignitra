import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, resolveChainConfig } from "@ignitra/core";
import { createKeyring } from "@ignitra/core/server";
import { createConnection, generateVapidKeys } from "@ignitra/actions";
import { createDb, users, type DbHandle } from "@ignitra/db";
import { runDoctor, type Check, type DoctorInput } from "./doctor";

/** Phase 9: `pnpm ops doctor` against stubbed providers (the real ones only see the operator's own keys). */

let h: DbHandle;
const key = randomBytes(32);
const keyring = createKeyring({ kid: "k1", key });
const vapid = generateVapidKeys();

type Route = (url: URL, init: RequestInit | undefined) => { status: number; body: unknown } | null;
function fakeFetch(...routes: Route[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    for (const route of routes) {
      const hit = route(url, init);
      if (hit) return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
    }
    throw new TypeError(`fetch failed: ${url.host}`);
  }) as typeof fetch;
}
const rpcRoute =
  (host: string, chainId: number): Route =>
  (url, init) => {
    if (url.host !== host) return null;
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    return { status: 200, body: { jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? `0x${chainId.toString(16)}` : "0x67a1b2c" } };
  };
const resendDomains =
  (status: string): Route =>
  (url) =>
    url.host === "api.resend.com" && url.pathname === "/domains" ? { status: 200, body: { data: [{ name: "ignitra.app", status }] } } : null;
const googleToken =
  (error: string): Route =>
  (url) =>
    url.host === "oauth2.googleapis.com" ? { status: error === "invalid_client" ? 401 : 400, body: { error } } : null;

function input(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    db: h,
    chain: resolveChainConfig({ chainId: 4663, rpcUrlPrimary: "https://rpc.one.test/v1/secret-key-123", rpcUrlFallback: "https://rpc.two.test" }),
    keyring,
    webhookMaster: "webhook-master-secret-0123456789",
    webhookMasterPrevious: null,
    vapid: { ...vapid, subject: "mailto:ops@ignitra.app" },
    email: { provider: "resend", apiKey: "re_live_key_123", from: "IGNITRA <alerts@ignitra.app>" },
    google: { clientId: "123.apps.googleusercontent.com", clientSecret: "GOCSPX-secret", redirectUri: "https://ignitra.app/api/v1/connections/google/callback" },
    urls: { apiPublic: "https://api.ignitra.app", web: "https://ignitra.app", cors: ["https://ignitra.app"], siweDomains: null },
    services: { trustLayer: null, vigil: null },
    explorerApiKey: true,
    mandateRequired: true,
    fetch: fakeFetch(rpcRoute("rpc.one.test", 4663), rpcRoute("rpc.two.test", 4663), resendDomains("verified"), googleToken("invalid_grant")),
    ...over,
  };
}
const byArea = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.area, `${c.status}: ${c.detail}`]));

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
  const ownerId = newId("user");
  await h.db.insert(users).values({ id: ownerId, address: `0x${randomBytes(20).toString("hex")}` });
  await createConnection(h.db, keyring, { ownerId, type: "webhook", label: "Hook", secret: { url: "https://hooks.example.com/x", signing_secret: "whsec_a" }, metadata: {} });
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("pnpm ops doctor", () => {
  it("passes a complete configuration, checking each integration against its service", async () => {
    const checks = await runDoctor(input());
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(byArea(checks)).toMatchObject({
      migrations: expect.stringMatching(/^ok: schema up to date/),
      "rpc primary": expect.stringMatching(/^ok: rpc\.one\.test: chain 4663, block 108,665,644/),
      encryption: "ok: key k1: 1 secret(s), all on it (1 opened)",
      "web push": "ok: VAPID key pair matches; subject mailto:ops@ignitra.app",
      email: "ok: Resend: ignitra.app verified",
      google: expect.stringMatching(/^ok: OAuth client id and secret accepted/),
    });
    expect(JSON.stringify(checks)).not.toContain("secret-key-123"); // RPC URLs may carry API keys
  });

  it("names what is wrong: wrong chain, unverified domain, unknown OAuth client, mismatched VAPID keys, origins", async () => {
    const other = generateVapidKeys();
    const checks = byArea(
      await runDoctor(
        input({
          vapid: { publicKey: other.publicKey, privateKey: vapid.privateKey, subject: "mailto:ops@ignitra.app" },
          urls: { apiPublic: "http://api.ignitra.app", web: "https://ignitra.app", cors: ["https://app.other.example"], siweDomains: null },
          fetch: fakeFetch(rpcRoute("rpc.one.test", 4663), rpcRoute("rpc.two.test", 1), resendDomains("pending"), googleToken("invalid_client")),
        }),
      ),
    );
    expect(checks["rpc fallback"]).toBe("fail: rpc.two.test is chain 1, expected 4663");
    expect(checks.email).toBe("fail: ignitra.app is pending in Resend: finish its DNS records");
    expect(checks.google).toBe("fail: Google refused GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
    expect(checks["web push"]).toMatch(/^fail: VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY/);
    expect(checks["public urls"]).toMatch(/^fail: /);
  });

  it("catches a replaced ENCRYPTION_KEY that kept its key id, and pending migrations", async () => {
    const replaced = createKeyring({ kid: "k1", key: randomBytes(32) });
    expect(byArea(await runDoctor(input({ keyring: replaced }))).encryption).toMatch(/^fail: 1 secret\(s\) open with none of the listed keys/);
    // The old key listed as previous under a new id: readable, and a rewrap is due.
    const rotated = createKeyring({ kid: "k2", key: randomBytes(32) }, [{ kid: "k1", key }]);
    expect(byArea(await runDoctor(input({ keyring: rotated }))).encryption).toBe("warn: 1 of 1 secret(s) still on an older key: run pnpm ops keys rewrap");

    // The newest migration "not applied" (its row removed, then put back).
    const removed = (await h.db.execute(sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations) returning id, hash, created_at::text as created_at`)) as unknown as {
      rows: Array<{ id: number; hash: string; created_at: string }>;
    };
    expect(byArea(await runDoctor(input())).migrations).toBe("fail: 1 of 11 pending: run pnpm db:migrate");
    const [row] = removed.rows;
    await h.db.execute(sql`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${row?.id}, ${row?.hash}, ${row?.created_at}::bigint)`);
    expect(byArea(await runDoctor(input())).migrations).toMatch(/^ok: /);
  });

  it("checks the provider the operator chose, and says what is off when nothing is configured", async () => {
    const restricted: Route = (url) => (url.host === "api.resend.com" ? { status: 401, body: { name: "restricted_api_key", message: "This API key is restricted to only send emails" } } : null);
    expect(byArea(await runDoctor(input({ fetch: fakeFetch(rpcRoute("rpc.one.test", 4663), rpcRoute("rpc.two.test", 4663), restricted, googleToken("invalid_grant")) }))).email).toMatch(
      /^ok: Resend: a valid sending key/,
    );

    // What Resend really answers for a wrong key (probed 2026-11-08).
    const invalid: Route = (url) => (url.host === "api.resend.com" ? { status: 400, body: { statusCode: 400, message: "API key is invalid", name: "validation_error" } } : null);
    expect(byArea(await runDoctor(input({ fetch: fakeFetch(rpcRoute("rpc.one.test", 4663), rpcRoute("rpc.two.test", 4663), invalid, googleToken("invalid_grant")) }))).email).toBe(
      "fail: Resend refused EMAIL_API_KEY (API key is invalid)",
    );

    const brevo = (active: boolean): Route =>
      (url) =>
        url.host !== "api.brevo.com" ? null : url.pathname === "/v3/account" ? { status: 200, body: { email: "ops@ignitra.app" } } : { status: 200, body: { senders: [{ email: "alerts@ignitra.app", active }] } };
    const viaBrevo = (active: boolean) =>
      runDoctor(input({ email: { provider: "brevo", apiKey: "xkeysib-123", from: "alerts@ignitra.app" }, fetch: fakeFetch(rpcRoute("rpc.one.test", 4663), rpcRoute("rpc.two.test", 4663), brevo(active), googleToken("invalid_grant")) }));
    expect(byArea(await viaBrevo(true)).email).toBe("ok: Brevo: alerts@ignitra.app is an active sender");
    expect(byArea(await viaBrevo(false)).email).toBe("fail: alerts@ignitra.app is not active in Brevo yet: confirm it");

    const bare = byArea(
      await runDoctor(
        input({
          chain: resolveChainConfig({ chainId: 4663, rpcUrlPrimary: "https://rpc.one.test" }),
          keyring: null,
          webhookMaster: null,
          vapid: null,
          email: new Error("set all of EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM (or none)"),
          google: null,
          explorerApiKey: false,
          mandateRequired: false,
        }),
      ),
    );
    expect(bare).toMatchObject({
      "rpc fallback": expect.stringMatching(/^warn: RPC_URL_FALLBACK is not set/),
      encryption: expect.stringMatching(/^fail: ENCRYPTION_KEY is not set/),
      "webhook secret": expect.stringMatching(/^warn: /),
      "web push": expect.stringMatching(/^warn: VAPID keys are not set/),
      email: "fail: set all of EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM (or none)",
      google: "warn: GOOGLE_* is not set: GOOGLE_SHEETS is off",
      explorer: expect.stringMatching(/^warn: /),
      onchain: expect.stringMatching(/^warn: ONCHAIN_MANDATE_REQUIRED=false/),
    });
  });
});
