import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { closeServer, createLogger, loadServiceEnv, runService, startHealthServer } from "@ignitra/core/server";
import { createDb } from "@ignitra/db";
import { createRunnerFromEnv, runnerEnvSchema } from "@ignitra/actions";

/**
 * Flow runner: executes queued runs (WEBHOOK, TELEGRAM, WEB_PUSH, CHAIN_READ) with
 * retries, step traces and auto-pause. Any number of runner processes can
 * share one database (FOR UPDATE SKIP LOCKED + leases).
 *
 * With embedded PGlite (one process only) run the runner inside the listener
 * instead: LISTENER_ROLES=sync,matcher,runner (add ",api" for the HTTP API).
 */
const env = loadServiceEnv(runnerEnvSchema);
const logger = createLogger("runner", env.LOG_LEVEL);

await runService(logger, async () => {
  const db = await createDb(env.DATABASE_URL, {
    applicationName: "ignitra-runner",
    onPoolError: (err) => logger.warn({ err }, "db pool error"),
  });
  if (db.driver === "pglite") await db.migrate();

  const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  const runner = createRunnerFromEnv(env, { db: db.db, logger, owner });
  const health = env.RUNNER_HEALTH_PORT > 0 ? await startHealthServer(runner, env.RUNNER_HEALTH_HOST, env.RUNNER_HEALTH_PORT) : null;
  logger.info(
    { owner, concurrency: env.RUNNER_CONCURRENCY, health: health ? `http://${env.RUNNER_HEALTH_HOST}:${env.RUNNER_HEALTH_PORT}/health` : "disabled", db: db.driver },
    "runner starting",
  );

  const controller = new AbortController();
  const loop = runner.run(controller.signal);
  return async () => {
    controller.abort();
    runner.wakeup.notify();
    await loop; // drains in-flight runs
    await closeServer(health);
    await db.close();
  };
});
