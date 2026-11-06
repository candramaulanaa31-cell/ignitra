import type { Logger } from "pino";
import type { EndpointStats } from "@ignitra/chain";
import type { HeadWatcher } from "./head";
import type { ListenerStore } from "./store";
import type { ChainSync, TickReport } from "./sync";

export interface HealthSnapshot {
  status: "starting" | "ok" | "degraded";
  role: "leader" | "standby" | "unknown";
  chain_id: number;
  head: number | null;
  confirmed_head: number | null;
  confirmed_cursor: number | null;
  pending_cursor: number | null;
  lag_blocks: number | null;
  watches: number | null;
  head_source: "websocket" | "polling";
  log_range: number;
  last_tick_at: string | null;
  last_error: string | null;
  consecutive_errors: number;
  rpc: EndpointStats[];
}

export class ListenerRuntime {
  readonly #sync: ChainSync;
  readonly #store: ListenerStore;
  readonly #head: HeadWatcher;
  readonly #rpcStats: () => EndpointStats[];
  readonly #log: Logger;
  readonly #pollMs: number;
  readonly #lagAlert: number;
  readonly #onProgress: () => void;
  #last: TickReport | null = null;
  #lastOkAt: number | null = null;
  #lastError: string | null = null;
  #errors = 0;

  constructor(deps: {
    sync: ChainSync;
    store: ListenerStore;
    head: HeadWatcher;
    rpcStats: () => EndpointStats[];
    logger: Logger;
    pollIntervalMs: number;
    lagAlertBlocks: number;
    /** Called after a leader tick that wrote events (wakes the matcher). */
    onProgress?: () => void;
  }) {
    this.#sync = deps.sync;
    this.#store = deps.store;
    this.#head = deps.head;
    this.#rpcStats = deps.rpcStats;
    this.#log = deps.logger;
    this.#pollMs = deps.pollIntervalMs;
    this.#lagAlert = deps.lagAlertBlocks;
    this.#onProgress = deps.onProgress ?? (() => {});
  }

  async run(signal: AbortSignal): Promise<void> {
    let wasLeader = false;
    while (!signal.aborted) {
      let delay = this.#pollMs;
      try {
        const report = await this.#sync.tick();
        this.#last = report;
        this.#lastOkAt = Date.now();
        this.#errors = 0;
        this.#lastError = null;

        if (report.role === "leader") {
          if (!wasLeader) this.#log.info("acquired listener lease — active");
          wasLeader = true;
          if (report.confirmed && report.confirmed.inserted + report.confirmed.reverted > 0) {
            this.#log.info({ confirmed: report.confirmed }, "confirmed events");
          }
          if (report.pending && report.pending.inserted > 0) this.#log.info({ pending: report.pending }, "pending events");
          if (report.confirmed || report.pending || report.deepReorg) this.#onProgress();
          // Catching up: go again immediately instead of sleeping.
          if (report.confirmed && report.confirmed.to < (report.confirmedHead ?? 0)) delay = 0;
          await this.#writeStatus(report, null);
        } else {
          if (wasLeader) this.#log.warn("lost listener lease — standby");
          wasLeader = false;
        }
      } catch (err) {
        this.#errors++;
        this.#lastError = err instanceof Error ? err.message : String(err);
        delay = Math.min(30_000, this.#pollMs * 2 ** Math.min(this.#errors, 5));
        this.#log.error({ err, consecutiveErrors: this.#errors, retryInMs: delay }, "tick failed");
        if (wasLeader && this.#last) await this.#writeStatus(this.#last, this.#lastError).catch(() => {});
      }
      await this.#head.wait(signal, delay);
    }
  }

  async #writeStatus(report: TickReport, error: string | null): Promise<void> {
    await this.#store.writeStatus({
      headBlock: report.head ?? 0,
      confirmedHead: report.confirmedHead ?? 0,
      confirmedCursor: report.confirmedCursor ?? 0,
      pendingCursor: report.pendingCursor ?? null,
      watchCount: report.watchCount ?? 0,
      rpc: { endpoints: this.#rpcStats(), head_source: this.#head.mode, log_range: this.#sync.range },
      lastError: error,
      deepReorg: report.deepReorg !== undefined,
    });
  }

  health(): HealthSnapshot {
    const r = this.#last;
    const lag = r?.confirmedHead !== undefined && r.confirmedCursor !== undefined ? r.confirmedHead - r.confirmedCursor : null;
    const fresh = this.#lastOkAt !== null && Date.now() - this.#lastOkAt < Math.max(3 * this.#pollMs, 15_000);
    let status: HealthSnapshot["status"] = "ok";
    if (!r) status = this.#errors > 0 ? "degraded" : "starting";
    else if (!fresh || (r.role === "leader" && lag !== null && lag > this.#lagAlert)) status = "degraded";
    return {
      status,
      role: r?.role ?? "unknown",
      chain_id: this.#store.chainId,
      head: r?.head ?? null,
      confirmed_head: r?.confirmedHead ?? null,
      confirmed_cursor: r?.confirmedCursor ?? null,
      pending_cursor: r?.pendingCursor ?? null,
      lag_blocks: lag,
      watches: r?.watchCount ?? null,
      head_source: this.#head.mode,
      log_range: this.#sync.range,
      last_tick_at: this.#lastOkAt ? new Date(this.#lastOkAt).toISOString() : null,
      last_error: this.#lastError,
      consecutive_errors: this.#errors,
      rpc: this.#rpcStats(),
    };
  }
}
