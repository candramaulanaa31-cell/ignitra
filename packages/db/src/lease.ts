import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import { leases } from "./schema";

export class LeaseLostError extends Error {
  constructor(name: string) {
    super(`lease "${name}" is no longer held by this process`);
    this.name = "LeaseLostError";
  }
}

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Single-writer election for long-running loops (listener sync, matcher).
 *
 * - `acquire()` takes or renews the lease using the DATABASE clock (hosts with
 *   skewed clocks still agree on expiry).
 * - `fence(tx)` renews inside a write transaction and throws if the lease was
 *   lost — so a paused or partitioned process can never commit stale work.
 *   The renewal row-locks the lease, which also serializes a new holder behind
 *   any in-flight transaction of the old one.
 */
export class Lease {
  readonly name: string;
  readonly owner: string;
  readonly #db: Database;
  readonly #interval: string;

  constructor(db: Database, name: string, owner: string, ttlMs = 30_000) {
    this.#db = db;
    this.name = name;
    this.owner = owner;
    this.#interval = `${ttlMs} milliseconds`;
  }

  async acquire(): Promise<boolean> {
    const rows = await this.#db
      .insert(leases)
      .values({ name: this.name, owner: this.owner, expiresAt: sql`now() + ${this.#interval}::interval` })
      .onConflictDoUpdate({
        target: leases.name,
        set: {
          owner: this.owner,
          expiresAt: sql`now() + ${this.#interval}::interval`,
          acquiredAt: sql`case when ${leases.owner} = ${this.owner} then ${leases.acquiredAt} else now() end`,
        },
        setWhere: sql`${leases.owner} = ${this.owner} or ${leases.expiresAt} < now()`,
      })
      .returning({ owner: leases.owner });
    return rows[0]?.owner === this.owner;
  }

  async release(): Promise<void> {
    await this.#db.delete(leases).where(and(eq(leases.name, this.name), eq(leases.owner, this.owner)));
  }

  async fence(tx: Tx): Promise<void> {
    const rows = await tx
      .update(leases)
      .set({ expiresAt: sql`now() + ${this.#interval}::interval` })
      .where(and(eq(leases.name, this.name), eq(leases.owner, this.owner), sql`${leases.expiresAt} > now()`))
      .returning({ name: leases.name });
    if (rows.length === 0) throw new LeaseLostError(this.name);
  }
}
