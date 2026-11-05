/**
 * @ignitra/sdk — Phase 1 skeleton.
 * Phase 8 adds: flows, runs, connections, and webhook signature verification.
 * Kept dependency-free so it runs in Node, Bun, Deno, and edge runtimes.
 */

export interface IgnitraOptions {
  apiKey: string;
  /** API origin, e.g. http://localhost:4000. Required until a hosted API exists. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export class Ignitra {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: IgnitraOptions) {
    if (!options.apiKey) throw new Error("Ignitra: apiKey is required");
    if (!options.baseUrl) throw new Error("Ignitra: baseUrl is required");
    this.#apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Placeholder until Phase 8; proves auth header + transport wiring. */
  async health(): Promise<unknown> {
    const res = await this.#fetch(`${this.baseUrl}/health`, {
      headers: { authorization: `Bearer ${this.#apiKey}` },
    });
    return res.json();
  }
}
