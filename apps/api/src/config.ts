import { z } from "zod";
import { ROBINHOOD_CHAIN_ID, type ChainConfig } from "@ignitra/core";
import { apiEnvSchema, encryptionEnvSchema, envVar, keyringFromEnv, parseEnv, type Logger } from "@ignitra/core/server";
import { AbiRegistry, BlockscoutAbiFetcher, createChainWriter, type ChainReader, type RpcChainReader } from "@ignitra/chain";
import { emailFromEnv, googleFromEnv, runnerEnvShape } from "@ignitra/actions";
import type { DbHandle } from "@ignitra/db";
import { DbAbiStore, createTrustLayerClient, type TrustLookup } from "@ignitra/engine";
import { buildServer, type ServerDeps } from "./server";

const list = (fallback: string) =>
  envVar.withDefault(
    z
      .string()
      .default(fallback)
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  );

/** API variables (also merged into the listener's schema for the single-process `api` role). */
export const apiEnvShape = {
  /** TRUST LAYER (reputation for Robinhood Chain): counterparty_trust_score conditions. Optional. */
  TRUST_LAYER_API_URL: envVar.optional(envVar.httpUrl),
  TRUST_LAYER_API_KEY: envVar.optional(z.string().min(8)),
  /** Default VIGIL API for VIGIL connections (the site followed by /api/v1). Optional. */
  VIGIL_API_URL: envVar.optional(envVar.httpUrl),
  API_HOST: envVar.withDefault(z.string().default("127.0.0.1")),
  API_PORT: envVar.withDefault(envVar.int(1, 65_535).default(4000)),
  /** Public base URL of the API, used in inbound webhook URLs. Default http://API_HOST:API_PORT. */
  API_PUBLIC_URL: envVar.optional(envVar.httpUrl),
  /** Web app origins allowed to call the API with the session cookie. */
  CORS_ORIGINS: list("http://localhost:3000").pipe(z.array(z.url({ protocol: /^https?$/ }))),
  /** SIWE `domain` values accepted (host[:port]). Default: the hosts of CORS_ORIGINS. */
  SIWE_DOMAINS: envVar.optional(z.string().transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))),
  SESSION_TTL_HOURS: envVar.withDefault(envVar.int(1, 24 * 90).default(24 * 7)),
  /**
   * Behind a reverse proxy (the web app proxies /api): trust X-Forwarded-For for client IPs
   * (rate limits). "true", "false", or the proxy's addresses, e.g. "127.0.0.1,::1".
   */
  TRUST_PROXY: envVar.withDefault(
    z
      .string()
      .default("false")
      .transform((v): boolean | string[] => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v.split(",").map((s) => s.trim()).filter(Boolean))),
  ),
  /** The web app (OAuth sends the browser back there). Default: the first CORS origin. */
  WEB_URL: envVar.optional(envVar.httpUrl),
  /** The flow shown live on the landing page (create it with: pnpm ops demo setup <wallet>). */
  DEMO_FLOW_ID: envVar.optional(z.string().regex(/^fl_[0-9a-z]{26}$/)),
  /** Requests per minute accepted per inbound webhook URL. */
  INBOUND_RATE_PER_MINUTE: envVar.withDefault(envVar.int(1, 100_000).default(60)),
  /** Requests stored per inbound webhook URL per 24 h (bounds storage; bodies are up to 64 KB). */
  INBOUND_DAILY_LIMIT: envVar.withDefault(envVar.int(1, 10_000_000).default(5000)),
  PUBLIC_RATE_PER_MINUTE: envVar.withDefault(envVar.int(1, 1_000_000).default(300)),
  SESSION_RATE_PER_MINUTE: envVar.withDefault(envVar.int(1, 1_000_000).default(600)),
} as const;

export const apiServiceEnvSchema = apiEnvSchema.extend({
  ...apiEnvShape,
  ...runnerEnvShape,
  EXPLORER_API_URL: envVar.optional(envVar.httpUrl),
  EXPLORER_API_KEY: envVar.optional(z.string().min(8)),
});

export type ApiEnv = z.output<typeof apiServiceEnvSchema>;

type ApiEnvSubset = Pick<
  ApiEnv,
  | keyof typeof apiEnvShape
  | "ENCRYPTION_KEY"
  | "ENCRYPTION_KEY_ID"
  | "ENCRYPTION_KEYS_PREVIOUS"
  | "WEBHOOK_SIGNING_SECRET"
  | "WEBHOOK_SIGNING_SECRET_PREVIOUS"
  | "TELEGRAM_API_URL"
  | "OUTBOUND_ALLOW_PRIVATE"
  | "ONCHAIN_MANDATE_REQUIRED"
  | "VAPID_PUBLIC_KEY"
  | "EXPLORER_API_URL"
  | "EXPLORER_API_KEY"
  | "CHAIN_ID"
  | "EMAIL_PROVIDER"
  | "EMAIL_API_KEY"
  | "EMAIL_FROM"
  | "EMAIL_API_URL"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_REDIRECT_URI"
  | "GOOGLE_AUTH_URL"
  | "GOOGLE_TOKEN_URL"
  | "GOOGLE_SHEETS_URL"
>;

/** Builds the API from env: secrets, CORS / SIWE domains, ABI lookups for save-time event/function resolution. */
/** The TRUST LAYER client, when the operator configured one. */
export function trustFromEnv(env: { TRUST_LAYER_API_URL?: string | undefined; TRUST_LAYER_API_KEY?: string | undefined }): TrustLookup | null {
  return env.TRUST_LAYER_API_URL ? createTrustLayerClient({ baseUrl: env.TRUST_LAYER_API_URL, apiKey: env.TRUST_LAYER_API_KEY ?? null }) : null;
}

export async function createApiFromEnv(
  env: ApiEnvSubset,
  deps: { db: DbHandle; chain: ChainConfig; logger: Logger; version: string; reader: ChainReader | null; onInboundEvent?: () => void; onRunQueued?: () => void },
) {
  const keyring = env.ENCRYPTION_KEY
    ? keyringFromEnv(parseEnv(encryptionEnvSchema, { ENCRYPTION_KEY: env.ENCRYPTION_KEY, ENCRYPTION_KEY_ID: env.ENCRYPTION_KEY_ID, ENCRYPTION_KEYS_PREVIOUS: env.ENCRYPTION_KEYS_PREVIOUS }))
    : null;
  const explorer = env.EXPLORER_API_URL ?? (env.CHAIN_ID === ROBINHOOD_CHAIN_ID ? `https://api.blockscout.com/${ROBINHOOD_CHAIN_ID}` : null);
  const abis = new AbiRegistry({
    store: new DbAbiStore(deps.db.db, deps.chain.id),
    fetcher: explorer && env.EXPLORER_API_KEY ? new BlockscoutAbiFetcher({ baseUrl: explorer, apiKey: env.EXPLORER_API_KEY }) : null,
    reader: deps.reader,
  });
  if (!keyring) deps.logger.warn("ENCRYPTION_KEY not set — POST /v1/connections is disabled");
  if (!env.WEBHOOK_SIGNING_SECRET) deps.logger.warn("WEBHOOK_SIGNING_SECRET not set — INBOUND_WEBHOOK flows and /v1/me/webhook-secret are disabled");
  const publicUrl = env.API_PUBLIC_URL ?? `http://${env.API_HOST}:${env.API_PORT}`;
  const email = emailFromEnv(env);
  const google = googleFromEnv(env);
  if (!email) deps.logger.warn("EMAIL_* not set — email connections (verification codes) are disabled");
  if (!google) deps.logger.warn("GOOGLE_* not set — Google Sheets connections are disabled");
  const options: ServerDeps = {
    db: deps.db,
    chain: deps.chain,
    logger: deps.logger,
    version: deps.version,
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
    corsOrigins: env.CORS_ORIGINS,
    auth: {
      ...(env.SIWE_DOMAINS ? { domains: env.SIWE_DOMAINS } : {}),
      sessionTtlMs: env.SESSION_TTL_HOURS * 3600_000,
      secureCookies: publicUrl.startsWith("https://"),
    },
    publicUrl,
    reader: deps.reader,
    abis,
    keyring,
    webhookMaster: env.WEBHOOK_SIGNING_SECRET ?? null,
    webhookMasterPrevious: env.WEBHOOK_SIGNING_SECRET_PREVIOUS ?? null,
    allowPrivateOutbound: env.OUTBOUND_ALLOW_PRIVATE,
    ...(env.TELEGRAM_API_URL ? { telegramApiBase: env.TELEGRAM_API_URL } : {}),
    inboundRatePerMinute: env.INBOUND_RATE_PER_MINUTE,
    inboundDailyLimit: env.INBOUND_DAILY_LIMIT,
    publicRatePerMinute: env.PUBLIC_RATE_PER_MINUTE,
    sessionRatePerMinute: env.SESSION_RATE_PER_MINUTE,
    trustProxy: env.TRUST_PROXY,
    ...(deps.onInboundEvent ? { onInboundEvent: deps.onInboundEvent } : {}),
    ...(deps.onRunQueued ? { onRunQueued: deps.onRunQueued } : {}),
    ...(env.WEB_URL ? { webUrl: env.WEB_URL } : {}),
    demoFlowId: env.DEMO_FLOW_ID ?? null,
    trust: trustFromEnv(env),
    vigilApiUrl: env.VIGIL_API_URL ?? null,
    chainTx: deps.reader && "pool" in deps.reader ? createChainWriter((deps.reader as RpcChainReader).pool) : null,
    mandateRequired: env.ONCHAIN_MANDATE_REQUIRED,
    email,
    google,
  };
  return { app: await buildServer(options), abis, publicUrl };
}
