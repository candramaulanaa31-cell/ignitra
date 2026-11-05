/**
 * In-memory admission helpers. They protect the system, not correctness:
 * after a restart they start empty, and the hourly run cap itself is always
 * enforced from the database (runs table), not from these counters.
 */

const MINUTE = 60_000;

/** Per-key event counts over a sliding window, in one-minute buckets. */
export class SlidingCounter {
  readonly #windowMs: number;
  readonly #buckets = new Map<string, Map<number, number>>();

  constructor(windowMs = 60 * MINUTE) {
    this.#windowMs = windowMs;
  }

  add(key: string, n = 1, now = Date.now()): void {
    const bucket = Math.floor(now / MINUTE);
    const map = this.#buckets.get(key) ?? new Map<number, number>();
    map.set(bucket, (map.get(bucket) ?? 0) + n);
    this.#buckets.set(key, map);
  }

  total(key: string, now = Date.now()): number {
    const map = this.#buckets.get(key);
    if (!map) return 0;
    const oldest = Math.floor((now - this.#windowMs) / MINUTE);
    let sum = 0;
    for (const [bucket, n] of map) {
      if (bucket <= oldest) map.delete(bucket);
      else sum += n;
    }
    return sum;
  }

  clear(key: string): void {
    this.#buckets.delete(key);
  }
}

/**
 * Token bucket per flow for writing evaluation rows: a busy token can fail a
 * whale-alert condition 20×/s; counters stay exact, but only a sample is
 * stored as evidence.
 */
export class EvaluationSampler {
  readonly #perMinute: number;
  readonly #state = new Map<string, { tokens: number; at: number }>();

  constructor(perMinute: number) {
    this.#perMinute = perMinute;
  }

  allow(flowId: string, now = Date.now()): boolean {
    if (this.#perMinute <= 0) return false;
    const s = this.#state.get(flowId) ?? { tokens: this.#perMinute, at: now };
    s.tokens = Math.min(this.#perMinute, s.tokens + ((now - s.at) / MINUTE) * this.#perMinute);
    s.at = now;
    const ok = s.tokens >= 1;
    if (ok) s.tokens -= 1;
    this.#state.set(flowId, s);
    return ok;
  }
}

/** Resolves on notify() or after a delay; lets the listener wake the matcher right after a commit. */
export class Wakeup {
  #waiters: Array<() => void> = [];

  notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  wait(signal: AbortSignal, delayMs: number): Promise<void> {
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
}
