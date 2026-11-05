import { z } from "zod";
import { CONFIRMATION_STRATEGIES, ROBINHOOD_CHAIN_ID } from "@ignitra/core";
import { envVar, workerEnvSchema } from "@ignitra/core/server";

/**
 * Listener tuning. Defaults come from measurements of Robinhood Chain mainnet
 * (2026-11-05): ~10 blocks/s, `safe` ≈ 12 min behind head, `finalized` ≈ 18 min,
 * public RPC caps eth_getLogs at 10k logs / 30k blocks, no public WebSocket.
 */
export const listenerEnvSchema = workerEnvSchema.extend({
  /** depth: head - CONFIRMATION_DEPTH (default, ~2 s); safe / finalized: L1-backed tags (minutes). */
  CONFIRMATION_STRATEGY: envVar.withDefault(z.enum(CONFIRMATION_STRATEGIES).default("depth")),
  CONFIRMATION_DEPTH: envVar.withDefault(envVar.int(0, 100_000).default(20)),
  POLL_INTERVAL_MS: envVar.withDefault(envVar.int(200, 60_000).default(2000)),
  LOG_RANGE_MAX: envVar.withDefault(envVar.int(1, 30_000).default(2000)),
  LOG_ADDRESS_CHUNK: envVar.withDefault(envVar.int(1, 1000).default(100)),
  /** Window re-verified when a reorg below the confirmed cursor is detected. */
  REORG_REWIND_BLOCKS: envVar.withDefault(envVar.int(1, 100_000).default(1000)),
  /** First block on a fresh database. Default: the current confirmed head (no history replay). */
  LISTENER_START_BLOCK: envVar.optional(envVar.int(0, Number.MAX_SAFE_INTEGER)),
  /** Health is degraded when the confirmed cursor trails the confirmed head by more than this. */
  LISTENER_LAG_ALERT_BLOCKS: envVar.withDefault(envVar.int(1, 10_000_000).default(600)),
  LISTENER_HEALTH_HOST: envVar.withDefault(z.string().default("127.0.0.1")),
  /** 0 disables the health server. */
  LISTENER_HEALTH_PORT: envVar.withDefault(envVar.int(0, 65_535).default(4001)),
  /** Blockscout PRO API base (chain-scoped). ABI fetching is off without a key. */
  EXPLORER_API_URL: envVar.optional(envVar.httpUrl),
  EXPLORER_API_KEY: envVar.optional(z.string().min(8)),
  /** What this process runs: chain ingestion (sync), event → run matching (matcher), or both. */
  LISTENER_ROLES: envVar.withDefault(
    z
      .string()
      .default("sync,matcher")
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
      .pipe(z.array(z.enum(["sync", "matcher"])).min(1)),
  ),
  MATCHER_BATCH_SIZE: envVar.withDefault(envVar.int(1, 5000).default(500)),
  /** Sampling interval of BALANCE_THRESHOLD / CONTRACT_DEPLOYED flows. */
  MATCHER_POLL_TRIGGERS_MS: envVar.withDefault(envVar.int(1000, 3_600_000).default(15_000)),
  /** Evaluation rows stored per flow per minute (counters are always exact). */
  MATCHER_EVALUATIONS_PER_MINUTE: envVar.withDefault(envVar.int(0, 10_000).default(20)),
  /** Auto-pause a flow when events dropped by its hourly cap reach factor × cap. */
  MATCHER_RUNAWAY_FACTOR: envVar.withDefault(envVar.int(1, 1000).default(3)),
});

export type ListenerEnv = z.output<typeof listenerEnvSchema>;

export function explorerApiUrl(env: ListenerEnv): string | null {
  if (env.EXPLORER_API_URL) return env.EXPLORER_API_URL;
  return env.CHAIN_ID === ROBINHOOD_CHAIN_ID ? `https://api.blockscout.com/${ROBINHOOD_CHAIN_ID}` : null;
}
