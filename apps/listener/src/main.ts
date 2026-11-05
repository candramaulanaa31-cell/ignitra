import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { redactUrl } from "@ignitra/core";
import { chainConfigFromEnv, createLogger, loadServiceEnv, runService } from "@ignitra/core/server";
import { AbiRegistry, BlockscoutAbiFetcher, EventDecoder, createRpcChainReader } from "@ignitra/chain";
import { createDb } from "@ignitra/db";
import { explorerApiUrl, listenerEnvSchema } from "./config";
import { HeadWatcher } from "./head";
import { ListenerRuntime, startHealthServer } from "./runtime";
import { DbAbiStore, ListenerStore } from "./store";
import { ChainSync } from "./sync";

const env = loadServiceEnv(listenerEnvSchema);
const logger = createLogger("listener", env.LOG_LEVEL);

await runService(logger, async () => {
  const chain = chainConfigFromEnv(env);
  const reader = createRpcChainReader({ primary: chain.rpc.primary, fallback: chain.rpc.fallback });

  // Refuse to start against the wrong chain: every event would be fabricated.
  const { dropped } = await reader.pool.verifyChainId(chain.id);
  for (const d of dropped) logger.error(d, "RPC fallback disabled");

  const db = await createDb(env.DATABASE_URL, {
    applicationName: "ignitra-listener",
    onPoolError: (err) => logger.warn({ err }, "db pool error"),
  });
  if (db.driver === "pglite") await db.migrate();

  const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  const store = new ListenerStore(db.db, { chainId: chain.id, owner });

  const apiUrl = explorerApiUrl(env);
  const fetcher = apiUrl && env.EXPLORER_API_KEY ? new BlockscoutAbiFetcher({ baseUrl: apiUrl, apiKey: env.EXPLORER_API_KEY }) : null;
  if (!fetcher) logger.warn("EXPLORER_API_KEY not set — decoding with built-in ABIs only");
  const abis = new AbiRegistry({
    store: new DbAbiStore(db.db, chain.id),
    fetcher,
    reader,
    onError: (address, err) => logger.warn({ address, err: (err as Error).message }, "ABI fetch failed"),
  });

  const sync = new ChainSync({
    reader,
    store,
    decoder: new EventDecoder(),
    abis,
    logger,
    options: {
      strategy: env.CONFIRMATION_STRATEGY,
      depth: env.CONFIRMATION_DEPTH,
      maxRange: env.LOG_RANGE_MAX,
      addressChunk: env.LOG_ADDRESS_CHUNK,
      rewindBlocks: env.REORG_REWIND_BLOCKS,
      startBlock: env.LISTENER_START_BLOCK,
    },
  });

  const head = new HeadWatcher({ pollIntervalMs: env.POLL_INTERVAL_MS, wsUrl: chain.rpc.ws, logger });
  const runtime = new ListenerRuntime({
    sync,
    store,
    head,
    rpcStats: () => reader.pool.stats(),
    logger,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    lagAlertBlocks: env.LISTENER_LAG_ALERT_BLOCKS,
  });

  const health = env.LISTENER_HEALTH_PORT > 0 ? await startHealthServer(runtime, env.LISTENER_HEALTH_HOST, env.LISTENER_HEALTH_PORT) : null;

  logger.info(
    {
      chainId: chain.id,
      owner,
      rpc: reader.pool.endpoints.map((e) => e.label),
      ws: chain.rpc.ws ? redactUrl(chain.rpc.ws) : null,
      confirmation: env.CONFIRMATION_STRATEGY === "depth" ? `depth ${env.CONFIRMATION_DEPTH}` : env.CONFIRMATION_STRATEGY,
      health: health ? `http://${env.LISTENER_HEALTH_HOST}:${env.LISTENER_HEALTH_PORT}/health` : "disabled",
      db: db.driver,
    },
    "listener starting",
  );

  head.start();
  const controller = new AbortController();
  const loop = runtime.run(controller.signal);

  return async () => {
    controller.abort();
    head.stop();
    await loop;
    await abis.idle();
    await store.releaseLease().catch(() => {});
    await new Promise<void>((resolve) => (health ? health.close(() => resolve()) : resolve()));
    await db.close();
  };
});
