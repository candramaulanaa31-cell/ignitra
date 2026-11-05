import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ROBINHOOD_CHAIN_ID, resolveChainConfig, type ChainConfig } from "../chain";

/**
 * Env handling. Each service composes only the schemas it needs, so a missing
 * VAPID key never blocks the listener. Errors list variable NAMES only —
 * values (which may be secrets) are never echoed.
 */

/** Repo root = nearest ancestor holding pnpm-workspace.yaml. */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads `<repo root>/.env` into process.env if present. Variables already set
 * in the real environment win (Node's loadEnvFile does not override).
 */
export function loadDotEnv(startDir?: string): string | null {
  const root = findWorkspaceRoot(startDir);
  if (!root) return null;
  const file = join(root, ".env");
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

/** Empty strings in .env mean "unset". */
const blank = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());

const httpUrl = z.url({ protocol: /^https?$/ });
const wsUrl = z.url({ protocol: /^wss?$/ });

/** Building blocks for service-specific env schemas. */
export const envVar = {
  /** Optional variable; "" counts as unset. */
  optional,
  /** Variable with a default; "" counts as unset. */
  withDefault: <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema),
  int: (min: number, max: number) => z.coerce.number().int().min(min).max(max),
  httpUrl,
  wsUrl,
} as const;

const base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: "must be base64" })
  .refine((v) => Buffer.from(v, "base64").length === 32, { message: "must decode to exactly 32 bytes" });

const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, { message: "must be 1-32 chars of [A-Za-z0-9_-]" });

export const runtimeEnvSchema = z.object({
  NODE_ENV: z.preprocess(blank, z.enum(["development", "test", "production"]).default("development")),
  LOG_LEVEL: z.preprocess(
    blank,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
});

export const chainEnvSchema = z.object({
  CHAIN_ID: z.preprocess(blank, z.coerce.number().int().positive().default(ROBINHOOD_CHAIN_ID)),
  RPC_URL_PRIMARY: optional(httpUrl),
  RPC_URL_FALLBACK: optional(httpUrl),
  WS_URL: optional(wsUrl),
  EXPLORER_URL: optional(httpUrl),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^(postgres|postgresql|pglite):\/\//.test(v), {
      message: "must start with postgres://, postgresql:// or pglite://",
    }),
});

export const encryptionEnvSchema = z.object({
  ENCRYPTION_KEY: base64Key32,
  ENCRYPTION_KEY_ID: z.preprocess(blank, keyId.default("k1")),
  ENCRYPTION_KEYS_PREVIOUS: optional(
    z
      .string()
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
      .pipe(
        z.array(
          z
            .string()
            .transform((entry) => {
              const idx = entry.indexOf(":");
              return { kid: entry.slice(0, idx), key: entry.slice(idx + 1) };
            })
            .pipe(z.object({ kid: keyId, key: base64Key32 })),
        ),
      ),
  ),
});

export const apiEnvSchema = runtimeEnvSchema
  .extend(chainEnvSchema.shape)
  .extend(databaseEnvSchema.shape)
  .extend({
    API_HOST: z.preprocess(blank, z.string().default("127.0.0.1")),
    API_PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(4000)),
  });

export const workerEnvSchema = runtimeEnvSchema.extend(chainEnvSchema.shape).extend(databaseEnvSchema.shape);

export function chainConfigFromEnv(env: z.output<typeof chainEnvSchema>): ChainConfig {
  return resolveChainConfig({
    chainId: env.CHAIN_ID,
    rpcUrlPrimary: env.RPC_URL_PRIMARY,
    rpcUrlFallback: env.RPC_URL_FALLBACK,
    wsUrl: env.WS_URL,
    explorerUrl: env.EXPLORER_URL,
  });
}

export class EnvError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => {
    const name = i.path.length > 0 ? i.path.map(String).join(".") : "(root)";
    return `${name}: ${i.message}`;
  });
  throw new EnvError(issues);
}

/**
 * Service bootstrap: load <root>/.env, validate, and on failure print the
 * variable names that are wrong and exit(1) — before any logger exists.
 */
export function loadServiceEnv<S extends z.ZodType>(schema: S): z.output<S> {
  loadDotEnv();
  try {
    return parseEnv(schema);
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
