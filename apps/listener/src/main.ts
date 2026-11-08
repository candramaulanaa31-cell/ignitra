import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { redactUrl } from "@ignitra/core";
import { chainConfigFromEnv, closeServer, createLogger, loadServiceEnv, runService, startHealthServer } from "@ignitra/core/server";
import { createRunnerFromEnv, type RunnerRuntime } from "@ignitra/actions";
import { createApiFromEnv, trustFromEnv } from "@ignitra/api";
import { AbiRegistry, BlockscoutAbiFetcher, EventDecoder, createRpcChainReader } from "@ignitra/chain";
import { createDb } from "@ignitra/db";
import { Matcher, MatcherRuntime, TokenInfo, createTriggerModules } from "@ignitra/engine";
import { explorerApiUrl, listenerEnvSchema } from "./config";
import { HeadWatcher } from "./head";
import pkg from "../package.json" with { type: "json" };
import { ListenerRuntime } from "./runtime";
import { DbAbiStore, ListenerStore } from "./store";
import { ChainSync } from "./sync";

/**
 * Chain-side process. Roles (LISTENER_ROLES, default sync,matcher):
 *   sync     — ingest logs for watched contracts, confirm, handle reorgs
 *   matcher  — turn confirmed (and fast-mode pending) events into queued runs
 *   runner   — execute runs (normally apps/runner; here for single-process setups)
 *   api      — the HTTP API (normally apps/api; here for single-process setups)
 * Each role holds its own lease / row locks, so they can run as separate processes.
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

  // ---- runner (optional, single-process mode) -------------------------------
  const runner: RunnerRuntime | null = roles.has("runner")
    ? createRunnerFromEnv(env, { db: db.db, logger: logger.child({ component: "runner" }), owner, chain: reader })
    : null;

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
      trust: trustFromEnv(env),
      options: {
        batchSize: env.MATCHER_BATCH_SIZE,
        pollIntervalMs: env.MATCHER_POLL_TRIGGERS_MS,
        evaluationsPerMinute: env.MATCHER_EVALUATIONS_PER_MINUTE,
        runawayFactor: env.MATCHER_RUNAWAY_FACTOR,
      },
    });
    matcherRuntime = new MatcherRuntime({
      matcher,
      logger: logger.child({ component: "matcher" }),
      // In-process runner: start executing new runs immediately instead of at its next poll.
      onRunsQueued: () => runner?.wakeup.notify(),
    });
  }

  // ---- api (optional, single-process mode) ------------------------------------
  const api = roles.has("api")
    ? await createApiFromEnv(env, {
        db,
        chain,
        logger: logger.child({ component: "api" }),
        version: pkg.version,
        reader,
        // Inbound webhook stored: match it now instead of at the next matcher tick.
        onInboundEvent: () => matcherRuntime?.wakeup.notify(),
        // "Test flow" queued a TEST run: execute it now.
        onRunQueued: () => runner?.wakeup.notify(),
      })
    : null;

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
      const execution = runner?.health() ?? null;
      const degraded = [sync, matcher, execution].some((h) => h?.status === "degraded");
      return { status: degraded ? "degraded" : (sync?.status ?? matcher?.status ?? execution?.status ?? "ok"), roles: [...roles], sync, matcher, runner: execution };
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
  if (runner) loops.push(runner.run(controller.signal));
  if (api) {
    await api.app.listen({ host: env.API_HOST, port: env.API_PORT });
    logger.info({ url: `http://${env.API_HOST}:${env.API_PORT}`, publicUrl: api.publicUrl }, "api listening");
  }

  return async () => {
    await api?.app.close();
    controller.abort();
    head?.stop();
    matcherRuntime?.wakeup.notify();
    runner?.wakeup.notify();
    await Promise.all(loops);
    await abis?.idle();
    await api?.abis.idle();
    await store?.releaseLease().catch(() => {});
    await closeServer(server);
    await db.close();
  };
});
