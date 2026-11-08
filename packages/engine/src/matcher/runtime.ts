import type { Logger } from "pino";
import { Wakeup } from "./admission";
import type { Matcher, MatcherReport } from "./matcher";

export interface MatcherHealth {
  status: "starting" | "ok" | "degraded";
  role: "leader" | "standby" | "unknown";
  flows: number | null;
  last_tick_at: string | null;
  last_error: string | null;
  consecutive_errors: number;
  runs_created: number;
  behind: boolean;
}

/**
 * Matcher loop. Runs right after the listener commits (wake-up), otherwise on
 * an interval; immediately again while a stream is behind; backs off on errors.
 */
export class MatcherRuntime {
  readonly wakeup = new Wakeup();
  readonly #matcher: Matcher;
  readonly #log: Logger;
  readonly #intervalMs: number;
  #last: MatcherReport | null = null;
  #lastOkAt: number | null = null;
  #lastError: string | null = null;
  #errors = 0;
  #runsCreated = 0;

  readonly #onRunsQueued: () => void;

  constructor(deps: { matcher: Matcher; logger: Logger; intervalMs?: number; onRunsQueued?: () => void }) {
    this.#matcher = deps.matcher;
    this.#log = deps.logger;
    this.#intervalMs = deps.intervalMs ?? 1000;
    this.#onRunsQueued = deps.onRunsQueued ?? (() => {});
  }

  async run(signal: AbortSignal): Promise<void> {
    let wasLeader = false;
    while (!signal.aborted) {
      let delay = this.#intervalMs;
      try {
        const report = await this.#matcher.tick();
        this.#last = report;
        this.#lastOkAt = Date.now();
        this.#errors = 0;
        this.#lastError = null;
        if (report.role === "leader") {
          if (!wasLeader) this.#log.info("acquired matcher lease — active");
          wasLeader = true;
          const runs = (report.confirmed?.runs ?? 0) + (report.head?.runs ?? 0) + (report.polled?.runs ?? 0) + (report.scheduled?.runs ?? 0) + (report.inbound?.runs ?? 0);
          this.#runsCreated += runs;
          if (runs > 0) {
            this.#log.info({ runs, confirmed: report.confirmed, head: report.head, polled: report.polled, scheduled: report.scheduled, inbound: report.inbound }, "runs queued");
            this.#onRunsQueued();
          }
          if (report.confirmed?.behind || report.head?.behind || report.inbound?.behind) delay = 0;
        } else {
          if (wasLeader) this.#log.warn("lost matcher lease — standby");
          wasLeader = false;
        }
      } catch (err) {
        this.#errors++;
        this.#lastError = err instanceof Error ? err.message : String(err);
        delay = Math.min(30_000, this.#intervalMs * 2 ** Math.min(this.#errors, 5));
        this.#log.error({ err, consecutiveErrors: this.#errors, retryInMs: delay }, "matcher tick failed");
      }
      await this.wakeup.wait(signal, delay);
    }
  }

  /** On a graceful stop: hand the lease over at once instead of when it expires (a restart would otherwise create no runs for up to the lease's TTL). */
  async release(): Promise<void> {
    await this.#matcher.store.lease.release();
  }

  health(): MatcherHealth {
    const r = this.#last;
    const fresh = this.#lastOkAt !== null && Date.now() - this.#lastOkAt < Math.max(10 * this.#intervalMs, 30_000);
    let status: MatcherHealth["status"] = "ok";
    if (!r) status = this.#errors > 0 ? "degraded" : "starting";
    else if (!fresh) status = "degraded";
    return {
      status,
      role: r?.role ?? "unknown",
      flows: r?.flows ?? null,
      last_tick_at: this.#lastOkAt ? new Date(this.#lastOkAt).toISOString() : null,
      last_error: this.#lastError,
      consecutive_errors: this.#errors,
      runs_created: this.#runsCreated,
      behind: Boolean(r?.confirmed?.behind || r?.head?.behind || r?.inbound?.behind),
    };
  }
}
