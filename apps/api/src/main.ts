import { apiEnvSchema, chainConfigFromEnv, createLogger, loadServiceEnv, runService } from "@ignitra/core/server";
import { createDb } from "@ignitra/db";
import pkg from "../package.json" with { type: "json" };
import { buildServer } from "./server";

const env = loadServiceEnv(apiEnvSchema);
const logger = createLogger("api", env.LOG_LEVEL);

await runService(logger, async () => {
  const chain = chainConfigFromEnv(env);
  const db = await createDb(env.DATABASE_URL, {
    applicationName: "ignitra-api",
    onPoolError: (err) => logger.warn({ err }, "db pool error"),
  });
  const app = await buildServer({ db, chain, logger, version: pkg.version });
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
  logger.info({ chainId: chain.id, chain: chain.name, db: db.driver }, "api ready");

  return async () => {
    await app.close();
    await db.close();
  };
});
