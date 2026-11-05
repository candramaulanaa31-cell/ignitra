import type { Logger } from "pino";
import { redactUrl } from "@ignitra/core";
import { subscribeNewHeads, type HeadSubscription } from "@ignitra/chain";

/**
 * Wakes the sync loop. Always polls; a WebSocket (if configured) only makes
 * wake-ups earlier. The loop re-reads the head over HTTP every time, so a
 * dead or lying socket degrades latency, never correctness.
 */
export class HeadWatcher {
  readonly #pollMs: number;
  readonly #wsUrl: string | null;
  readonly #log: Logger;
  #waiters: Array<() => void> = [];
  #sub: HeadSubscription | null = null;
  #retryMs = 1000;
  #retryTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #lastWsHead: number | null = null;

  constructor(opts: { pollIntervalMs: number; wsUrl: string | null; logger: Logger }) {
    this.#pollMs = opts.pollIntervalMs;
    this.#wsUrl = opts.wsUrl;
    this.#log = opts.logger;
  }

  get mode(): "websocket" | "polling" {
    return this.#sub ? "websocket" : "polling";
  }

  start(): void {
    if (this.#wsUrl) this.#connect(this.#wsUrl);
  }

  #connect(url: string): void {
    if (this.#stopped) return;
    this.#sub = subscribeNewHeads(url, {
      onHead: (n) => {
        this.#retryMs = 1000;
        if (this.#lastWsHead === null || n > this.#lastWsHead) {
          this.#lastWsHead = n;
          this.#wake();
        }
      },
      onError: (err) => this.#log.warn({ err: err.message, ws: redactUrl(url) }, "websocket error"),
      onClose: () => {
        this.#sub = null;
        if (this.#stopped) return;
        this.#log.warn({ retryMs: this.#retryMs }, "websocket closed — polling until reconnect");
        this.#retryTimer = setTimeout(() => this.#connect(url), this.#retryMs);
        this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
      },
    });
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  /** Resolves on the next WebSocket head, after `delayMs` (default: poll interval), or on abort. */
  wait(signal: AbortSignal, delayMs: number = this.#pollMs): Promise<void> {
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
    });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#sub?.close();
    this.#sub = null;
    this.#wake();
  }
}
