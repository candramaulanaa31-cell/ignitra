import { z } from "zod";
import type { ChainCallClient } from "@ignitra/core";
import { chainConfigFromEnv, envVar, keyringFromEnv, parseEnv, encryptionEnvSchema, workerEnvSchema, type Keyring } from "@ignitra/core/server";
import { createChainWriter, createRpcChainReader, type RpcChainReader } from "@ignitra/chain";
import type { Logger } from "pino";
import type { Database } from "@ignitra/db";
import { createRunner, type RunnerRuntime } from "./runtime";
import type { VapidConfig } from "./push";
import type { EmailConfig } from "./email";
import type { GoogleConfig } from "./google";

const flag = (fallback: boolean) =>
  envVar.withDefault(
    z
      .enum(["true", "false", "1", "0"])
      .default(fallback ? "true" : "false")
      .transform((v) => v === "true" || v === "1"),
  );

/** Runner-only variables (merged into the listener's schema for the single-process `runner` role). */
export const runnerEnvShape = {
  ENCRYPTION_KEY: envVar.optional(z.string()),
  ENCRYPTION_KEY_ID: envVar.optional(z.string()),
  ENCRYPTION_KEYS_PREVIOUS: envVar.optional(z.string()),
  /** Master for per-owner webhook signing secrets (inline-URL webhooks). */
  WEBHOOK_SIGNING_SECRET: envVar.optional(z.string().min(16)),
  VAPID_PUBLIC_KEY: envVar.optional(z.string()),
  VAPID_PRIVATE_KEY: envVar.optional(z.string()),
  VAPID_SUBJECT: envVar.optional(z.string().regex(/^(mailto:|https:\/\/)/, { message: "must start with mailto: or https://" })),
  TELEGRAM_API_URL: envVar.optional(envVar.httpUrl),
  /** EMAIL action + address verification: the platform's provider account (Resend or Brevo free tier). */
  EMAIL_PROVIDER: envVar.optional(z.enum(["resend", "brevo"])),
  EMAIL_API_KEY: envVar.optional(z.string().min(8)),
  EMAIL_FROM: envVar.optional(z.string().min(3).max(200)),
  /** Override only for tests / stubs. */
  EMAIL_API_URL: envVar.optional(envVar.httpUrl),
  /** GOOGLE_SHEETS: an OAuth client from the Google Cloud console (scopes: openid, email, spreadsheets). */
  GOOGLE_CLIENT_ID: envVar.optional(z.string().min(8)),
  GOOGLE_CLIENT_SECRET: envVar.optional(z.string().min(8)),
  /** Registered redirect URI: <web app>/api/v1/connections/google/callback (or the API's own URL). */
  GOOGLE_REDIRECT_URI: envVar.optional(envVar.httpUrl),
  /** Overrides only for tests / stubs. */
  GOOGLE_AUTH_URL: envVar.optional(envVar.httpUrl),
  GOOGLE_TOKEN_URL: envVar.optional(envVar.httpUrl),
  GOOGLE_SHEETS_URL: envVar.optional(envVar.httpUrl),
  RUNNER_CONCURRENCY: envVar.withDefault(envVar.int(1, 64).default(4)),
  RUNNER_POLL_MS: envVar.withDefault(envVar.int(200, 60_000).default(1000)),
  RUNNER_LEASE_MS: envVar.withDefault(envVar.int(5000, 600_000).default(60_000)),
  RUNNER_MAX_ATTEMPTS: envVar.withDefault(envVar.int(1, 20).default(5)),
  /** Consecutive failed runs before a flow is auto-paused. */
  RUNNER_AUTOPAUSE_FAILURES: envVar.withDefault(envVar.int(1, 1000).default(5)),
  RUNNER_HEALTH_HOST: envVar.withDefault(z.string().default("127.0.0.1")),
  RUNNER_HEALTH_PORT: envVar.withDefault(envVar.int(0, 65_535).default(4002)),
  /** DEV ONLY: allow outbound requests to private/loopback networks (local receivers). */
  OUTBOUND_ALLOW_PRIVATE: flag(false),
  /** ONCHAIN_TX: every grant must name a MANDATE policy that allows each transaction (spec default). */
  ONCHAIN_MANDATE_REQUIRED: flag(true),
  OUTBOUND_TIMEOUT_MS: envVar.withDefault(envVar.int(1000, 60_000).default(10_000)),
} as const;

export const runnerEnvSchema = workerEnvSchema.extend(runnerEnvShape);
type RunnerEnv = z.output<typeof runnerEnvSchema>;

export function keyringFromRunnerEnv(env: RunnerEnv): Keyring | null {
  if (!env.ENCRYPTION_KEY) return null;
  return keyringFromEnv(parseEnv(encryptionEnvSchema, { ENCRYPTION_KEY: env.ENCRYPTION_KEY, ENCRYPTION_KEY_ID: env.ENCRYPTION_KEY_ID, ENCRYPTION_KEYS_PREVIOUS: env.ENCRYPTION_KEYS_PREVIOUS }));
}

type Integrations = Pick<
  RunnerEnv,
  "EMAIL_PROVIDER" | "EMAIL_API_KEY" | "EMAIL_FROM" | "EMAIL_API_URL" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REDIRECT_URI" | "GOOGLE_AUTH_URL" | "GOOGLE_TOKEN_URL" | "GOOGLE_SHEETS_URL"
>;

export function emailFromEnv(env: Integrations): EmailConfig | null {
  const set = [env.EMAIL_PROVIDER, env.EMAIL_API_KEY, env.EMAIL_FROM].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3) throw new Error("set all of EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM (or none)");
  return { provider: env.EMAIL_PROVIDER as "resend" | "brevo", apiKey: env.EMAIL_API_KEY as string, from: env.EMAIL_FROM as string, ...(env.EMAIL_API_URL ? { apiBase: env.EMAIL_API_URL } : {}) };
}

export function googleFromEnv(env: Integrations): GoogleConfig | null {
  const set = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3) throw new Error("set all of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI (or none)");
  return {
    clientId: env.GOOGLE_CLIENT_ID as string,
    clientSecret: env.GOOGLE_CLIENT_SECRET as string,
    redirectUri: env.GOOGLE_REDIRECT_URI as string,
    ...(env.GOOGLE_AUTH_URL ? { authUrl: env.GOOGLE_AUTH_URL } : {}),
    ...(env.GOOGLE_TOKEN_URL ? { tokenUrl: env.GOOGLE_TOKEN_URL } : {}),
    ...(env.GOOGLE_SHEETS_URL ? { sheetsUrl: env.GOOGLE_SHEETS_URL } : {}),
  };
}

export function vapidFromEnv(env: RunnerEnv): VapidConfig | null {
  const set = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3) throw new Error("set all of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (or none)");
  return { publicKey: env.VAPID_PUBLIC_KEY as string, privateKey: env.VAPID_PRIVATE_KEY as string, subject: env.VAPID_SUBJECT as string };
}

/** RPC reader for CHAIN_READ (presets supply a public RPC for Robinhood Chain); verifies the chain id before reading. */
function chainFromEnv(env: RunnerEnv): RpcChainReader {
  const chain = chainConfigFromEnv(env);
  return createRpcChainReader({ primary: chain.rpc.primary, fallback: chain.rpc.fallback }, { expectedChainId: chain.id });
}

/** Builds a runner from env, logging what is (not) configured. */
export function createRunnerFromEnv(env: RunnerEnv, deps: { db: Database; logger: Logger; owner: string; chain?: ChainCallClient }): RunnerRuntime {
  const reader = deps.chain ?? chainFromEnv(env);
  const chainConfig = chainConfigFromEnv(env);
  // ONCHAIN_TX writes through the same RPC pool (with its fallback) as reads.
  const writer = "pool" in reader ? createChainWriter((reader as RpcChainReader).pool) : null;
  const keyring = keyringFromRunnerEnv(env);
  const vapid = vapidFromEnv(env);
  if (!keyring) deps.logger.warn("ENCRYPTION_KEY not set — steps that use connections (TELEGRAM, connection webhooks) will fail");
  if (!env.WEBHOOK_SIGNING_SECRET) deps.logger.warn("WEBHOOK_SIGNING_SECRET not set — inline-URL WEBHOOK steps will fail");
  if (!vapid) deps.logger.warn("VAPID keys not set — WEB_PUSH steps will fail (generate with: pnpm gen:vapid)");
  const email = emailFromEnv(env);
  const google = googleFromEnv(env);
  if (!email) deps.logger.warn("EMAIL_* not set — EMAIL steps will fail");
  if (!google) deps.logger.warn("GOOGLE_* not set — GOOGLE_SHEETS steps will fail");
  if (env.OUTBOUND_ALLOW_PRIVATE) deps.logger.warn("OUTBOUND_ALLOW_PRIVATE=true — SSRF protection is relaxed (development only)");
  return createRunner({
    db: deps.db,
    owner: deps.owner,
    logger: deps.logger,
    keyring,
    webhookMaster: env.WEBHOOK_SIGNING_SECRET ?? null,
    vapid,
    concurrency: env.RUNNER_CONCURRENCY,
    pollMs: env.RUNNER_POLL_MS,
    leaseMs: env.RUNNER_LEASE_MS,
    executor: { maxAttempts: env.RUNNER_MAX_ATTEMPTS, autoPauseAfter: env.RUNNER_AUTOPAUSE_FAILURES },
    outbound: { allowPrivateNetworks: env.OUTBOUND_ALLOW_PRIVATE, timeoutMs: env.OUTBOUND_TIMEOUT_MS },
    ...(env.TELEGRAM_API_URL ? { telegramApiBase: env.TELEGRAM_API_URL } : {}),
    email,
    google,
    chain: reader,
    onchain: writer ? { writer, chainId: chainConfig.id, explorerUrl: chainConfig.explorerUrl ?? null, mandateRequired: env.ONCHAIN_MANDATE_REQUIRED } : null,
  });
}
