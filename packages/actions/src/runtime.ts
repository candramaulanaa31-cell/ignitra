import type { Logger } from "pino";
import type { ActionRegistry, ChainCallClient, SafeHttpClient } from "@ignitra/core";
import type { Keyring } from "@ignitra/core/server";
import type { Database, Run } from "@ignitra/db";
import type { EmailConfig } from "./email";
import type { GoogleConfig } from "./google";
import { createActionModules } from "./actions/index";
import { RunExecutor, type ExecutorOptions } from "./executor";
import { createSafeHttp } from "./http";
import { Notifier } from "./notices";
import { WebPushSender, assertVapid, type VapidConfig } from "./push";
import { RunQueue } from "./queue";

/** Resolves on notify() or after a delay. */
class Wakeup {
  #waiters: Array<() => void> = [];

  notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  wait(signal: AbortSignal, delayMs: number, also?: Promise<unknown>): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delayMs);
      signal.addEventListener("abort", done, { once: true });
      this.#waiters.push(done);
      also?.then(done, done);
    });
  }
}

export interface RunnerHealth {
  status: "starting" | "ok" | "degraded";
  in_flight: number;
  concurrency: number;
  executed: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  requeued: number;
  last_tick_at: string | null;
  last_error: string | null;
  consecutive_errors: number;
}

/**
 * Worker pool: claims up to `concurrency` runs, executes them in parallel,
 * claims more as slots free up; housekeeping (revert notices, owner
 * notifications) every few seconds.
 */
export class RunnerRuntime {
  readonly wakeup = new Wakeup();
  readonly queue: RunQueue;
  readonly executor: RunExecutor;
  readonly notifier: Notifier;
  readonly #log: Logger;
  readonly #concurrency: number;
  readonly #pollMs: number;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #counts = { executed: 0, succeeded: 0, partial: 0, failed: 0, skipped: 0, requeued: 0 };
  #lastOkAt: number | null = null;
  #lastError: string | null = null;
  #errors = 0;
  #lastHousekeeping = 0;
  #housekeeping: Promise<void> | null = null;

  constructor(deps: { queue: RunQueue; executor: RunExecutor; notifier: Notifier; logger: Logger; concurrency?: number; pollMs?: number }) {
    this.queue = deps.queue;
    this.executor = deps.executor;
    this.notifier = deps.notifier;
    this.#log = deps.logger;
    this.#concurrency = deps.concurrency ?? 4;
    this.#pollMs = deps.pollMs ?? 1000;
  }

  async #one(run: Run): Promise<void> {
    try {
      const outcome = await this.executor.execute(run);
      this.#counts.executed++;
      if (outcome.kind === "requeued") this.#counts.requeued++;
      if (outcome.kind === "finished") {
        this.#counts[outcome.status]++;
        this.#log.info({ runId: run.id, flowId: run.flowId, status: outcome.status }, "run finished");
      } else if (outcome.kind === "requeued") {
        this.#log.info({ runId: run.id, retryInMs: outcome.delayMs }, "run backing off");
      } else {
        this.#log.warn({ runId: run.id }, "lost the run lease mid-execution — another worker owns it now");
      }
    } catch (err) {
      // The run keeps its lease; once it expires any worker reclaims it.
      this.#log.error({ err, runId: run.id }, "run execution crashed");
    }
  }

  /** One scheduling pass (exposed for tests). */
  async pass(): Promise<number> {
    const free = this.#concurrency - this.#inFlight.size;
    const claimed = free > 0 ? await this.queue.claim(free) : [];
    for (const run of claimed) {
      const p: Promise<void> = this.#one(run).finally(() => this.#inFlight.delete(p));
      this.#inFlight.add(p);
    }
    if (!this.#housekeeping && Date.now() - this.#lastHousekeeping > 5000) {
      this.#lastHousekeeping = Date.now();
      // In the background: slow receivers of notices must not delay claiming runs.
      this.#housekeeping = this.housekeeping()
        .catch((err: unknown) => this.#log.warn({ err }, "runner housekeeping failed"))
        .finally(() => {
          this.#housekeeping = null;
        });
    }
    return claimed.length;
  }

  /** run.reverted notices + owner notifications (exposed for tests). */
  async housekeeping(): Promise<void> {
    await this.notifier.revertNotices();
    await this.notifier.ownerNotifications();
  }

  /** Waits until every in-flight run settled (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
    await this.#housekeeping;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let delay = this.#pollMs;
      try {
        const claimed = await this.pass();
        this.#lastOkAt = Date.now();
        this.#errors = 0;
        this.#lastError = null;
        if (claimed > 0 && this.#inFlight.size < this.#concurrency) delay = 0; // more may be waiting
      } catch (err) {
        this.#errors++;
        this.#lastError = err instanceof Error ? err.message : String(err);
        delay = Math.min(30_000, this.#pollMs * 2 ** Math.min(this.#errors, 5));
        this.#log.error({ err, retryInMs: delay }, "runner pass failed");
      }
      // Wake on a new run (notify), on a freed slot, or after the poll interval.
      const slotFreed = this.#inFlight.size >= this.#concurrency ? Promise.race(this.#inFlight) : undefined;
      await this.wakeup.wait(signal, delay, slotFreed);
    }
    await this.drain();
  }

  health(): RunnerHealth {
    const fresh = this.#lastOkAt !== null && Date.now() - this.#lastOkAt < Math.max(10 * this.#pollMs, 30_000);
    return {
      status: this.#lastOkAt === null ? (this.#errors > 0 ? "degraded" : "starting") : fresh ? "ok" : "degraded",
      in_flight: this.#inFlight.size,
      concurrency: this.#concurrency,
      ...this.#counts,
      last_tick_at: this.#lastOkAt ? new Date(this.#lastOkAt).toISOString() : null,
      last_error: this.#lastError,
      consecutive_errors: this.#errors,
    };
  }
}

export interface RunnerConfig {
  db: Database;
  owner: string;
  logger: Logger;
  keyring: Keyring | null;
  webhookMaster: string | null;
  vapid: VapidConfig | null;
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  executor?: ExecutorOptions;
  outbound?: { allowPrivateNetworks?: boolean; timeoutMs?: number };
  telegramApiBase?: string;
  email?: EmailConfig | null;
  google?: GoogleConfig | null;
  /** Chain RPC for CHAIN_READ. */
  chain?: ChainCallClient | null;
  /** Overrides (tests). */
  http?: SafeHttpClient;
  actions?: ActionRegistry;
}

export function createRunner(config: RunnerConfig): RunnerRuntime {
  const http =
    config.http ??
    createSafeHttp({
      allowPrivate: config.outbound?.allowPrivateNetworks ?? false,
      ...(config.outbound?.timeoutMs ? { timeoutMs: config.outbound.timeoutMs } : {}),
    });
  const actions =
    config.actions ??
    createActionModules({ ...(config.telegramApiBase ? { telegramApiBase: config.telegramApiBase } : {}), email: config.email ?? null, google: config.google ?? null });
  if (config.vapid) assertVapid(config.vapid);
  const push = config.vapid ? new WebPushSender({ db: config.db, vapid: config.vapid, http, logger: config.logger }) : null;
  const queue = new RunQueue(config.db, { owner: config.owner, ...(config.leaseMs ? { leaseMs: config.leaseMs } : {}) });
  const executor = new RunExecutor({
    db: config.db,
    queue,
    actions,
    http,
    keyring: config.keyring,
    push,
    webhookMaster: config.webhookMaster,
    chain: config.chain ?? null,
    logger: config.logger,
    ...(config.executor ? { options: config.executor } : {}),
  });
  const notifier = new Notifier({ db: config.db, keyring: config.keyring, http, push, webhookMaster: config.webhookMaster, actions, logger: config.logger });
  return new RunnerRuntime({
    queue,
    executor,
    notifier,
    logger: config.logger,
    ...(config.concurrency ? { concurrency: config.concurrency } : {}),
    ...(config.pollMs ? { pollMs: config.pollMs } : {}),
  });
}
