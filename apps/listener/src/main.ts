import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { redactUrl } from "@ignitra/core";
import { chainConfigFromEnv, createLogger, loadServiceEnv, runService } from "@ignitra/core/server";
import { AbiRegistry, BlockscoutAbiFetcher, EventDecoder, createRpcChainReader } from "@ignitra/chain";
import { createDb } from "@ignitra/db";
import { Matcher, MatcherRuntime, TokenInfo, createTriggerModules } from "@ignitra/engine";
import { explorerApiUrl, listenerEnvSchema } from "./config";
import { HeadWatcher } from "./head";
import { ListenerRuntime, startHealthServer } from "./runtime";
import { DbAbiStore, ListenerStore } from "./store";
import { ChainSync } from "./sync";

/**
 * Chain-side process. Roles (LISTENER_ROLES, default both):
 *   sync     — ingest logs for watched contracts, confirm, handle reorgs
 *   matcher  — turn confirmed (and fast-mode pending) events into queued runs
 * Each role holds its own lease, so they can later run as separate processes.
 */
const env = loadServiceEnv(listenerEnvSchema);
const logger = createLogger("listener", env.LOG_LEVEL);
const roles = new Set(env.LISTENER_ROLES);

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
  const controller = new AbortController();
  const loops: Promise<void>[] = [];

  // ---- matcher -------------------------------------------------------------
  let matcherRuntime: MatcherRuntime | null = null;
  if (roles.has("matcher")) {
    const matcher = new Matcher({
      db: db.db,
      chain,
      reader,
      tokens: new TokenInfo(reader),
      triggers: createTriggerModules(),
      logger: logger.child({ component: "matcher" }),
      owner,
      options: {
        batchSize: env.MATCHER_BATCH_SIZE,
        pollIntervalMs: env.MATCHER_POLL_TRIGGERS_MS,
        evaluationsPerMinute: env.MATCHER_EVALUATIONS_PER_MINUTE,
        runawayFactor: env.MATCHER_RUNAWAY_FACTOR,
      },
    });
    matcherRuntime = new MatcherRuntime({ matcher, logger: logger.child({ component: "matcher" }) });
  }

  // ---- sync ----------------------------------------------------------------
  let syncRuntime: ListenerRuntime | null = null;
  let head: HeadWatcher | null = null;
  let abis: AbiRegistry | null = null;
  let store: ListenerStore | null = null;
  if (roles.has("sync")) {
    store = new ListenerStore(db.db, { chainId: chain.id, owner });
    const apiUrl = explorerApiUrl(env);
    const fetcher = apiUrl && env.EXPLORER_API_KEY ? new BlockscoutAbiFetcher({ baseUrl: apiUrl, apiKey: env.EXPLORER_API_KEY }) : null;
    if (!fetcher) logger.warn("EXPLORER_API_KEY not set — decoding with built-in ABIs only");
    abis = new AbiRegistry({
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
    head = new HeadWatcher({ pollIntervalMs: env.POLL_INTERVAL_MS, wsUrl: chain.rpc.ws, logger });
    syncRuntime = new ListenerRuntime({
      sync,
      store,
      head,
      rpcStats: () => reader.pool.stats(),
      logger,
      pollIntervalMs: env.POLL_INTERVAL_MS,
      lagAlertBlocks: env.LISTENER_LAG_ALERT_BLOCKS,
      // Wake the matcher right after events are committed: event → run latency ≈ one matcher tick.
      onProgress: () => matcherRuntime?.wakeup.notify(),
    });
  }

  const health = {
    health() {
      const sync = syncRuntime?.health() ?? null;
      const matcher = matcherRuntime?.health() ?? null;
      const degraded = sync?.status === "degraded" || matcher?.status === "degraded";
      return { status: degraded ? "degraded" : (sync?.status ?? matcher?.status ?? "ok"), roles: [...roles], sync, matcher };
    },
  };
  const server = env.LISTENER_HEALTH_PORT > 0 ? await startHealthServer(health, env.LISTENER_HEALTH_HOST, env.LISTENER_HEALTH_PORT) : null;

  logger.info(
    {
      chainId: chain.id,
      owner,
      roles: [...roles],
      rpc: reader.pool.endpoints.map((e) => e.label),
      ws: chain.rpc.ws ? redactUrl(chain.rpc.ws) : null,
      confirmation: env.CONFIRMATION_STRATEGY === "depth" ? `depth ${env.CONFIRMATION_DEPTH}` : env.CONFIRMATION_STRATEGY,
      health: server ? `http://${env.LISTENER_HEALTH_HOST}:${env.LISTENER_HEALTH_PORT}/health` : "disabled",
      db: db.driver,
    },
    "listener starting",
  );

  if (head && syncRuntime) {
    head.start();
    loops.push(syncRuntime.run(controller.signal));
  }
  if (matcherRuntime) loops.push(matcherRuntime.run(controller.signal));

  return async () => {
    controller.abort();
    head?.stop();
    matcherRuntime?.wakeup.notify();
    await Promise.all(loops);
    await abis?.idle();
    await store?.releaseLease().catch(() => {});
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await db.close();
  };
});
