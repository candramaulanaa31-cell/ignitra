import { z } from "zod";
import type { ChainCallClient } from "@ignitra/core";
import { chainConfigFromEnv, envVar, keyringFromEnv, parseEnv, encryptionEnvSchema, workerEnvSchema, type Keyring } from "@ignitra/core/server";
import { createRpcChainReader } from "@ignitra/chain";
import type { Logger } from "pino";
import type { Database } from "@ignitra/db";
import { createRunner, type RunnerRuntime } from "./runtime";
import type { VapidConfig } from "./push";

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
  OUTBOUND_TIMEOUT_MS: envVar.withDefault(envVar.int(1000, 60_000).default(10_000)),
} as const;

export const runnerEnvSchema = workerEnvSchema.extend(runnerEnvShape);
type RunnerEnv = z.output<typeof runnerEnvSchema>;

export function keyringFromRunnerEnv(env: RunnerEnv): Keyring | null {
  if (!env.ENCRYPTION_KEY) return null;
  return keyringFromEnv(parseEnv(encryptionEnvSchema, { ENCRYPTION_KEY: env.ENCRYPTION_KEY, ENCRYPTION_KEY_ID: env.ENCRYPTION_KEY_ID, ENCRYPTION_KEYS_PREVIOUS: env.ENCRYPTION_KEYS_PREVIOUS }));
}

export function vapidFromEnv(env: RunnerEnv): VapidConfig | null {
  const set = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3) throw new Error("set all of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (or none)");
  return { publicKey: env.VAPID_PUBLIC_KEY as string, privateKey: env.VAPID_PRIVATE_KEY as string, subject: env.VAPID_SUBJECT as string };
}

/** RPC reader for CHAIN_READ (presets supply a public RPC for Robinhood Chain); verifies the chain id before reading. */
function chainFromEnv(env: RunnerEnv): ChainCallClient {
  const chain = chainConfigFromEnv(env);
  return createRpcChainReader({ primary: chain.rpc.primary, fallback: chain.rpc.fallback }, { expectedChainId: chain.id });
}

/** Builds a runner from env, logging what is (not) configured. */
export function createRunnerFromEnv(env: RunnerEnv, deps: { db: Database; logger: Logger; owner: string; chain?: ChainCallClient }): RunnerRuntime {
  const keyring = keyringFromRunnerEnv(env);
  const vapid = vapidFromEnv(env);
  if (!keyring) deps.logger.warn("ENCRYPTION_KEY not set — steps that use connections (TELEGRAM, connection webhooks) will fail");
  if (!env.WEBHOOK_SIGNING_SECRET) deps.logger.warn("WEBHOOK_SIGNING_SECRET not set — inline-URL WEBHOOK steps will fail");
  if (!vapid) deps.logger.warn("VAPID keys not set — WEB_PUSH steps will fail (generate with: pnpm gen:vapid)");
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
    chain: deps.chain ?? chainFromEnv(env),
  });
}
