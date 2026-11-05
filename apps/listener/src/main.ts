import { createTriggerRegistry, redactUrl } from "@ignitra/core";
import { chainConfigFromEnv, createLogger, loadServiceEnv, runService, workerEnvSchema } from "@ignitra/core/server";
import { createDb } from "@ignitra/db";

/**
 * Chain listener. Phase 1: boots, validates config, connects to the DB and
 * idles. Phase 2 adds block subscription, log fetching, decoding,
 * checkpoints and confirmation/reorg tracking.
 */
const env = loadServiceEnv(workerEnvSchema);
const logger = createLogger("listener", env.LOG_LEVEL);

await runService(logger, async () => {
  const chain = chainConfigFromEnv(env);
  const triggers = createTriggerRegistry();
  const db = await createDb(env.DATABASE_URL, {
    applicationName: "ignitra-listener",
    onPoolError: (err) => logger.warn({ err }, "db pool error"),
  });
  await db.ping();

  logger.info(
    {
      chainId: chain.id,
      rpcPrimary: redactUrl(chain.rpc.primary),
      rpcFallback: chain.rpc.fallback ? redactUrl(chain.rpc.fallback) : null,
      ws: chain.rpc.ws ? redactUrl(chain.rpc.ws) : null,
      db: db.driver,
      triggersRegistered: triggers.size,
    },
    "listener started (phase 1 skeleton: no ingestion yet)",
  );

  const heartbeat = setInterval(() => logger.debug("heartbeat"), 60_000);
  return async () => {
    clearInterval(heartbeat);
    await db.close();
  };
});
