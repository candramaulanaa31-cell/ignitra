import { createECDH } from "node:crypto";
import type { ChainConfig } from "@ignitra/core";
import type { Keyring } from "@ignitra/core/server";
import { migrationStatus, type DbHandle } from "@ignitra/db";
import { assertVapid, keyUsage, rewrapAll, verifySecrets, type EmailConfig, type GoogleConfig, type VapidConfig } from "@ignitra/actions";

/**
 * `pnpm ops doctor` (Phase 9): checks a deployment's configuration against the real services, so
 * a wrong key shows up here instead of as failed runs. Integrations are checked only when they are
 * configured. Nothing is sent to users and nothing is written: the email check reads the provider
 * account, the Google check presents the OAuth client with a dummy code (Google answers whether it
 * knows the client), and secrets are only unwrapped in memory. RPC URLs (they may carry API keys)
 * and secrets are never printed.
 */

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  readonly area: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorInput {
  readonly db: DbHandle;
  readonly chain: ChainConfig;
  /** An Error when ENCRYPTION_KEY / ENCRYPTION_KEYS_PREVIOUS do not parse. */
  readonly keyring: Keyring | null | Error;
  readonly webhookMaster: string | null;
  readonly webhookMasterPrevious: string | null;
  /** From vapidFromEnv / emailFromEnv / googleFromEnv; an Error when only some of their variables are set. */
  readonly vapid: VapidConfig | null | Error;
  readonly email: EmailConfig | null | Error;
  readonly google: GoogleConfig | null | Error;
  readonly urls: { readonly apiPublic: string | null; readonly web: string | null; readonly cors: readonly string[]; readonly siweDomains: readonly string[] | null };
  readonly services: { readonly trustLayer: string | null; readonly vigil: string | null };
  readonly explorerApiKey: boolean;
  readonly mandateRequired: boolean;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const ok = (area: string, detail: string): Check => ({ area, status: "ok", detail });
const warn = (area: string, detail: string): Check => ({ area, status: "warn", detail });
const fail = (area: string, detail: string): Check => ({ area, status: "fail", detail });
const message = (err: unknown) => (err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err));
const isLocal = (u: URL) => u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]";

export async function runDoctor(input: DoctorInput): Promise<Check[]> {
  const http = input.fetch ?? fetch;
  const timeout = input.timeoutMs ?? 8_000;
  const request = (url: string, init: RequestInit = {}) => http(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const groups = await Promise.all([
    database(input.db),
    rpc(input.chain, request),
    secrets(input),
    Promise.resolve(webhooks(input)),
    Promise.resolve(vapid(input.vapid)),
    email(input.email, request),
    google(input.google, request),
    Promise.resolve(urls(input.urls)),
    services(input, request),
  ]);
  return groups.flat();
}

async function database(db: DbHandle): Promise<Check[]> {
  let latency: number;
  try {
    latency = await db.ping();
  } catch (err) {
    return [fail("database", `unreachable: ${message(err)}`)];
  }
  const out = [
    db.driver === "pg"
      ? ok("database", `Postgres, ${latency} ms`)
      : ok("database", `PGlite, ${latency} ms (one process: use Postgres to run the API, listener and runner separately)`),
  ];
  const m = await migrationStatus(db.db);
  out.push(m.pending === 0 ? ok("migrations", `schema up to date (${m.applied} applied)`) : fail("migrations", `${m.pending} of ${m.available} pending: run pnpm db:migrate`));
  return out;
}

async function rpc(chain: ChainConfig, request: (url: string, init?: RequestInit) => Promise<Response>): Promise<Check[]> {
  const endpoint = async (label: string, url: string): Promise<Check> => {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "(invalid URL)";
      }
    })();
    const call = async (method: string): Promise<string> => {
      const res = await request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: string; error?: { message?: string } };
      if (body.error || typeof body.result !== "string") throw new Error(body.error?.message ?? "no result");
      return body.result;
    };
    const started = performance.now();
    try {
      const id = Number(BigInt(await call("eth_chainId")));
      if (id !== chain.id) return fail(label, `${host} is chain ${id}, expected ${chain.id}`);
      const block = Number(BigInt(await call("eth_blockNumber")));
      return ok(label, `${host}: chain ${id}, block ${block.toLocaleString("en-US")}, ${Math.round(performance.now() - started)} ms`);
    } catch (err) {
      return fail(label, `${host}: ${message(err)}`);
    }
  };
  const out = [await endpoint("rpc primary", chain.rpc.primary)];
  out.push(chain.rpc.fallback ? await endpoint("rpc fallback", chain.rpc.fallback) : warn("rpc fallback", "RPC_URL_FALLBACK is not set: the public RPC rate-limits; add a second provider"));
  return out;
}

async function secrets(input: DoctorInput): Promise<Check[]> {
  const keyring = input.keyring;
  if (keyring instanceof Error) return [fail("encryption", keyring.message)];
  if (!keyring) return [fail("encryption", "ENCRYPTION_KEY is not set: connections and onchain grants cannot be stored or used")];
  try {
    const usage = await keyUsage(input.db.db, keyring);
    const sampled = await verifySecrets(input.db.db, keyring);
    const older = await rewrapAll(input.db.db, keyring, { dryRun: true });
    const unreadable = new Set([...sampled.failed, ...older.failed].map((f) => `${f.table}:${f.id}`)).size;
    const total = Object.values(usage.byKid).reduce((a, b) => a + b, 0);
    if (unreadable > 0) {
      return [fail("encryption", `${unreadable} secret(s) open with none of the listed keys: was ENCRYPTION_KEY changed without listing the old one in ENCRYPTION_KEYS_PREVIOUS?`)];
    }
    if (usage.pending > 0) return [warn("encryption", `${usage.pending} of ${total} secret(s) still on an older key: run pnpm ops keys rewrap`)];
    return [ok("encryption", `key ${usage.activeKid}: ${total} secret(s), all on it (${sampled.checked} opened)`)];
  } catch (err) {
    return [fail("encryption", message(err))];
  }
}

function webhooks(input: DoctorInput): Check[] {
  if (!input.webhookMaster) return [warn("webhook secret", "WEBHOOK_SIGNING_SECRET is not set: inbound webhook URLs, inline-URL webhooks and Google sign-in are off")];
  if (input.webhookMasterPrevious) return [warn("webhook secret", "rotation in progress (WEBHOOK_SIGNING_SECRET_PREVIOUS): remove it once receivers use the new secret")];
  return [ok("webhook secret", "set")];
}

function vapid(v: VapidConfig | null | Error): Check[] {
  if (v instanceof Error) return [fail("web push", v.message)];
  if (!v) return [warn("web push", "VAPID keys are not set: WEB_PUSH steps fail (pnpm gen:vapid)")];
  try {
    assertVapid(v);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(v.privateKey, "base64url"));
    if (ecdh.getPublicKey().toString("base64url") !== v.publicKey) {
      return [fail("web push", "VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY: push services refuse every message")];
    }
  } catch (err) {
    return [fail("web push", message(err))];
  }
  if (/example\.(com|org|net)\b/i.test(v.subject)) return [warn("web push", `VAPID_SUBJECT is a placeholder (${v.subject}): use a real contact, push services may refuse it`)];
  return [ok("web push", `VAPID key pair matches; subject ${v.subject}`)];
}

/** "IGNITRA <alerts@example.org>" or "alerts@example.org" → the address. */
const fromAddress = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

async function email(cfg: EmailConfig | null | Error, request: (url: string, init?: RequestInit) => Promise<Response>): Promise<Check[]> {
  if (cfg instanceof Error) return [fail("email", cfg.message)];
  if (!cfg) return [warn("email", "EMAIL_* is not set: EMAIL steps and email connections are off")];
  const address = fromAddress(cfg.from);
  const domain = address.split("@")[1] ?? "";
  try {
    if (cfg.provider === "resend") {
      const base = (cfg.apiBase ?? "https://api.resend.com").replace(/\/+$/, "");
      const res = await request(`${base}/domains`, { headers: { authorization: `Bearer ${cfg.apiKey}` } });
      const body = (await res.json().catch(() => ({}))) as { data?: Array<{ name?: string; status?: string }>; name?: string; message?: string };
      if (res.status === 401 && body.name === "restricted_api_key") return [ok("email", `Resend: a valid sending key (it cannot list domains, so ${domain} was not checked)`)];
      // Resend answers an unknown key with 400 validation_error ("API key is invalid").
      if (res.status === 400 || res.status === 401 || res.status === 403) return [fail("email", `Resend refused EMAIL_API_KEY (${body.message ?? `HTTP ${res.status}`})`)];
      if (!res.ok) return [warn("email", `Resend answered HTTP ${res.status}`)];
      if (domain === "resend.dev") return [warn("email", "EMAIL_FROM uses resend.dev: Resend then delivers only to your own account's address; verify your domain")];
      const found = (body.data ?? []).find((d) => d.name?.toLowerCase() === domain);
      if (!found) return [fail("email", `${domain} is not a domain of this Resend account: add and verify it`)];
      if (found.status !== "verified") return [fail("email", `${domain} is ${found.status ?? "not verified"} in Resend: finish its DNS records`)];
      return [ok("email", `Resend: ${domain} verified`)];
    }
    const base = (cfg.apiBase ?? "https://api.brevo.com").replace(/\/+$/, "");
    const headers = { "api-key": cfg.apiKey, accept: "application/json" };
    const account = await request(`${base}/v3/account`, { headers });
    if (account.status === 401 || account.status === 403) return [fail("email", `Brevo refused EMAIL_API_KEY (HTTP ${account.status})`)];
    if (!account.ok) return [warn("email", `Brevo answered HTTP ${account.status}`)];
    const senders = (await (await request(`${base}/v3/senders`, { headers })).json().catch(() => ({}))) as { senders?: Array<{ email?: string; active?: boolean }> };
    const sender = (senders.senders ?? []).find((s) => s.email?.toLowerCase() === address);
    if (!sender) return [fail("email", `${address} is not a sender of this Brevo account: add and verify it`)];
    if (sender.active === false) return [fail("email", `${address} is not active in Brevo yet: confirm it`)];
    return [ok("email", `Brevo: ${address} is an active sender`)];
  } catch (err) {
    return [fail("email", `${cfg.provider}: ${message(err)}`)];
  }
}

async function google(cfg: GoogleConfig | null | Error, request: (url: string, init?: RequestInit) => Promise<Response>): Promise<Check[]> {
  if (cfg instanceof Error) return [fail("google", cfg.message)];
  if (!cfg) return [warn("google", "GOOGLE_* is not set: GOOGLE_SHEETS is off")];
  const redirect = new URL(cfg.redirectUri);
  if (!redirect.pathname.endsWith("/v1/connections/google/callback")) {
    return [fail("google", "GOOGLE_REDIRECT_URI must end with /v1/connections/google/callback (…/api/v1/… when the web app proxies the API)")];
  }
  if (redirect.protocol !== "https:" && !isLocal(redirect)) return [fail("google", "GOOGLE_REDIRECT_URI must be https: Google refuses http redirects except to localhost")];
  try {
    // A made-up code: Google first checks the client, then answers invalid_grant for the code.
    const res = await request(cfg.tokenUrl ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "ignitra-doctor", client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "invalid_grant") return [ok("google", "OAuth client id and secret accepted (the redirect URI is checked at the first sign-in)")];
    if (body.error === "invalid_client" || body.error === "unauthorized_client") return [fail("google", "Google refused GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET")];
    if (body.error === "redirect_uri_mismatch") return [fail("google", "GOOGLE_REDIRECT_URI is not an authorized redirect URI of this OAuth client")];
    return [warn("google", `Google answered HTTP ${res.status}${body.error ? ` ${body.error}` : ""}`)];
  } catch (err) {
    return [fail("google", message(err))];
  }
}

function urls(u: DoctorInput["urls"]): Check[] {
  const out: Check[] = [];
  const pub = u.apiPublic ? new URL(u.apiPublic) : null;
  if (!pub) out.push(warn("public urls", "API_PUBLIC_URL is not set: inbound webhook URLs use the API's listen address"));
  else if (pub.protocol !== "https:" && !isLocal(pub)) out.push(fail("public urls", "API_PUBLIC_URL must be https: webhook senders and VIGIL refuse http"));
  const web = u.web ? new URL(u.web) : null;
  if (!web) {
    out.push(warn("public urls", "WEB_URL is not set: Google sign-in returns to the API instead of the app"));
  } else {
    if (web.protocol !== "https:" && !isLocal(web)) out.push(fail("public urls", "WEB_URL must be https: browsers allow Web Push and wallet sign-in only on secure origins"));
    if (!u.cors.some((o) => new URL(o).origin === web.origin)) out.push(fail("public urls", `CORS_ORIGINS does not include ${web.origin}: the web app cannot call the API`));
    const domains = u.siweDomains ?? u.cors.map((o) => new URL(o).host);
    if (!domains.includes(web.host)) out.push(fail("public urls", `wallet sign-in accepts ${domains.join(", ") || "no domain"}, not ${web.host}: set SIWE_DOMAINS or CORS_ORIGINS`));
  }
  if (out.length === 0) out.push(ok("public urls", `API ${pub?.origin}, web ${web?.origin}`));
  return out;
}

async function services(input: DoctorInput, request: (url: string, init?: RequestInit) => Promise<Response>): Promise<Check[]> {
  const reach = async (area: string, base: string | null, off: string): Promise<Check> => {
    if (!base) return ok(area, off);
    try {
      const res = await request(base.replace(/\/+$/, "") + "/health");
      return ok(area, `${new URL(base).host} answers (HTTP ${res.status})`);
    } catch (err) {
      return warn(area, `${new URL(base).host} unreachable (${message(err)})`);
    }
  };
  return [
    await reach("trust layer", input.services.trustLayer, "not configured (TRUST LAYER conditions report unavailable)"),
    await reach("vigil", input.services.vigil, "not configured (VIGIL connections need VIGIL_API_URL)"),
    input.explorerApiKey ? ok("explorer", "EXPLORER_API_KEY set") : warn("explorer", "EXPLORER_API_KEY is not set: event and function names are not looked up on Blockscout"),
    input.mandateRequired ? ok("onchain", "every grant needs a MANDATE policy") : warn("onchain", "ONCHAIN_MANDATE_REQUIRED=false: grants may act without a MANDATE policy"),
  ];
}
