import { createActionRegistry } from "@ignitra/core";
import { createLogger, loadServiceEnv, runService, workerEnvSchema } from "@ignitra/core/server";
import { createDb } from "@ignitra/db";

/**
 * Flow runner. Phase 1: boots, connects to the DB and idles. Phase 4 adds
 * the Postgres job queue, workers, retries, templating and MVP actions.
 */
const env = loadServiceEnv(workerEnvSchema);
const logger = createLogger("runner", env.LOG_LEVEL);

await runService(logger, async () => {
  const actions = createActionRegistry();
  const db = await createDb(env.DATABASE_URL, {
    applicationName: "ignitra-runner",
    onPoolError: (err) => logger.warn({ err }, "db pool error"),
  });
  await db.ping();

  logger.info(
    { db: db.driver, actionsRegistered: actions.size },
    "runner started (phase 1 skeleton: no job execution yet)",
  );

  const heartbeat = setInterval(() => logger.debug("heartbeat"), 60_000);
  return async () => {
    clearInterval(heartbeat);
    await db.close();
  };
});
