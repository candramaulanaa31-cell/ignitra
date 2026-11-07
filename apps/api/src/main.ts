import { chainConfigFromEnv, createLogger, loadServiceEnv, runService } from "@ignitra/core/server";
import { createRpcChainReader } from "@ignitra/chain";
import { createDb } from "@ignitra/db";
import pkg from "../package.json" with { type: "json" };
import { apiServiceEnvSchema, createApiFromEnv } from "./config";

const env = loadServiceEnv(apiServiceEnvSchema);
const logger = createLogger("api", env.LOG_LEVEL);

await runService(logger, async () => {
  const chain = chainConfigFromEnv(env);
  // ERC-1271 sign-in (smart wallets) and save-time ABI / proxy lookups. The chain id is
  // verified before the first read, so a wrong RPC URL can never validate a signature.
  const reader = createRpcChainReader({ primary: chain.rpc.primary, fallback: chain.rpc.fallback }, { expectedChainId: chain.id });
  const db = await createDb(env.DATABASE_URL, {
    applicationName: "ignitra-api",
    onPoolError: (err) => logger.warn({ err }, "db pool error"),
  });
  const { app, abis, publicUrl } = await createApiFromEnv(env, { db, chain, logger, version: pkg.version, reader });
  try {
    // Embedded PGlite is a dev convenience: migrate on start. Real Postgres is
    // migrated explicitly (`pnpm db:migrate`) as a deploy step.
    if (db.driver === "pglite") await db.migrate();
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
  } catch (err) {
    // Release the DB (and the PGlite dir lock) before the process exits.
    await app.close().catch(() => {});
    await db.close().catch(() => {});
    throw err;
  }
  logger.info({ chainId: chain.id, chain: chain.name, db: db.driver, publicUrl, cors: env.CORS_ORIGINS }, "api ready");

  return async () => {
    await app.close();
    await abis.idle();
    await db.close();
  };
});
