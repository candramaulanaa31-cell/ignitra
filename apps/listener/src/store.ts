import { and, between, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import {
  newId,
  type CursorStream,
  type NormalizedAddress,
  type NormalizedHash,
} from "@ignitra/core";
import {
  chainCursors,
  chainEvents,
  chainSyncStatus,
  chainVerification,
  flows,
  watches,
  Lease,
  type ChainVerificationRow,
  type Database,
  type NewChainEvent,
  type Tx,
} from "@ignitra/db";

export { LeaseLostError } from "@ignitra/db";
export { DbAbiStore } from "@ignitra/engine";
import type { WatchKey } from "./filter";

export interface Cursor {
  readonly blockNumber: number;
  readonly blockHash: NormalizedHash | null;
}

export interface ActiveWatch extends WatchKey {
  readonly fast: boolean;
}

export interface CommitResult {
  readonly upserted: number;
  readonly inserted: number;
  readonly reverted: number;
  readonly deepReverted: number;
}

/** Postgres caps a statement at 65 535 bind parameters; chain_events rows bind ~17 each. */
const INSERT_CHUNK = 1000;

/**
 * All listener persistence. Every write that moves a cursor runs in one
 * transaction together with a lease renewal, so a process that lost its
 * lease (paused, partitioned) can never commit stale progress (fencing).
 */
export class ListenerStore {
  readonly #db: Database;
  readonly chainId: number;
  readonly owner: string;
  readonly #lease: Lease;

  constructor(db: Database, opts: { chainId: number; owner: string; leaseMs?: number }) {
    this.#db = db;
    this.chainId = opts.chainId;
    this.owner = opts.owner;
    this.#lease = new Lease(db, `listener:${opts.chainId}`, opts.owner, opts.leaseMs ?? 30_000);
  }

  get leaseName(): string {
    return this.#lease.name;
  }

  acquireLease(): Promise<boolean> {
    return this.#lease.acquire();
  }

  releaseLease(): Promise<void> {
    return this.#lease.release();
  }

  #fence(tx: Tx): Promise<void> {
    return this.#lease.fence(tx);
  }


  // ---- cursors -------------------------------------------------------------

  async getCursor(stream: CursorStream): Promise<Cursor | null> {
    const [row] = await this.#db
      .select()
      .from(chainCursors)
      .where(and(eq(chainCursors.chainId, this.chainId), eq(chainCursors.stream, stream)));
    return row ? { blockNumber: row.blockNumber, blockHash: (row.blockHash as NormalizedHash | null) ?? null } : null;
  }

  async #setCursor(tx: Tx, stream: CursorStream, cursor: Cursor): Promise<void> {
    await tx
      .insert(chainCursors)
      .values({ chainId: this.chainId, stream, blockNumber: cursor.blockNumber, blockHash: cursor.blockHash })
      .onConflictDoUpdate({
        target: [chainCursors.chainId, chainCursors.stream],
        set: { blockNumber: cursor.blockNumber, blockHash: cursor.blockHash, updatedAt: sql`now()` },
      });
  }

  /** First start: both streams begin at `start` (exclusive — the next block processed is start + 1). */
  async initCursors(start: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await this.#fence(tx);
      for (const stream of ["confirmed", "pending"] as const) {
        await tx
          .insert(chainCursors)
          .values({ chainId: this.chainId, stream, blockNumber: start, blockHash: null })
          .onConflictDoNothing();
      }
    });
  }

  // ---- watches -------------------------------------------------------------

  /** Manual watches plus watches of ACTIVE flows, grouped by (address, topic0). */
  async loadWatches(): Promise<ActiveWatch[]> {
    const rows = await this.#db
      .select({
        address: watches.address,
        topic0: watches.topic0,
        fast: sql<boolean>`bool_or(${watches.fast})`,
      })
      .from(watches)
      .leftJoin(flows, eq(flows.id, watches.flowId))
      .where(and(eq(watches.chainId, this.chainId), or(isNull(watches.flowId), eq(flows.status, "active"))))
      .groupBy(watches.address, watches.topic0);
    return rows.map((r) => ({
      address: r.address as NormalizedAddress,
      topic0: (r.topic0 as NormalizedHash | null) ?? null,
      fast: Boolean(r.fast),
    }));
  }

  /**
   * Watches that were live for a whole window starting at `cutoff`: created before it, and (for a
   * flow's watch) the flow active since before it. Watches added or flows resumed later are not
   * backfilled on purpose, so the gap detector must not count their older events as missing.
   */
  async verifiableWatches(cutoff: Date): Promise<ActiveWatch[]> {
    const rows = await this.#db
      .select({ address: watches.address, topic0: watches.topic0 })
      .from(watches)
      .leftJoin(flows, eq(flows.id, watches.flowId))
      .where(
        and(
          eq(watches.chainId, this.chainId),
          lt(watches.createdAt, cutoff),
          or(isNull(watches.flowId), and(eq(flows.status, "active"), lt(flows.activatedAt, cutoff))),
        ),
      )
      .groupBy(watches.address, watches.topic0);
    return rows.map((r) => ({ address: r.address as NormalizedAddress, topic0: (r.topic0 as NormalizedHash | null) ?? null, fast: false }));
  }

  // ---- gap detector ----------------------------------------------------------

  async verification(): Promise<ChainVerificationRow | null> {
    const [row] = await this.#db.select().from(chainVerification).where(eq(chainVerification.chainId, this.chainId));
    return row ?? null;
  }

  async saveVerification(v: { verifiedBlock: number; checked: number; missing: number; window: { from: number; to: number; count: number; sample: string[] } | null }): Promise<void> {
    await this.#db
      .insert(chainVerification)
      .values({ chainId: this.chainId, verifiedBlock: v.verifiedBlock, checkedBlocks: v.checked, missingTotal: v.missing, lastCheckedAt: sql`now()`, lastMissingAt: v.window ? sql`now()` : null, lastMissing: v.window })
      .onConflictDoUpdate({
        target: chainVerification.chainId,
        set: {
          verifiedBlock: v.verifiedBlock,
          checkedBlocks: sql`${chainVerification.checkedBlocks} + ${v.checked}`,
          missingTotal: sql`${chainVerification.missingTotal} + ${v.missing}`,
          lastCheckedAt: sql`now()`,
          ...(v.window ? { lastMissingAt: sql`now()`, lastMissing: v.window } : {}),
          updatedAt: sql`now()`,
        },
      });
  }

  /** Identities (block hash : log index) of the confirmed events stored in a range. */
  async confirmedIdentities(from: number, to: number): Promise<Set<string>> {
    const rows = await this.#db
      .select({ blockHash: chainEvents.blockHash, logIndex: chainEvents.logIndex })
      .from(chainEvents)
      .where(and(eq(chainEvents.chainId, this.chainId), eq(chainEvents.status, "confirmed"), between(chainEvents.blockNumber, from, to)));
    return new Set(rows.map((r) => `${r.blockHash}:${r.logIndex}`));
  }

  /** Inserts events the gap detector found missing, as confirmed (the matcher sees them next). Never touches cursors or existing rows. */
  async repairConfirmed(rows: readonly NewChainEvent[]): Promise<number> {
    return this.#db.transaction(async (tx) => {
      await this.#fence(tx);
      let inserted = 0;
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const chunk = rows.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, status: "confirmed" as const, confirmedAt: sql`now()`, confirmedSeq: sql`nextval('chain_events_confirmed_seq')` }));
        const result = await tx.insert(chainEvents).values(chunk).onConflictDoNothing().returning({ id: chainEvents.id });
        inserted += result.length;
      }
      return inserted;
    });
  }

  // ---- events --------------------------------------------------------------

  /** Live (pending/confirmed) rows in a range: their keys widen the re-query, their identities guard against false reverts. */
  async liveEvents(from: number, to: number): Promise<{ keys: WatchKey[]; identities: Set<string> }> {
    const rows = await this.#db
      .select({ address: chainEvents.address, topic0: chainEvents.topic0, blockHash: chainEvents.blockHash, logIndex: chainEvents.logIndex })
      .from(chainEvents)
      .where(
        and(
          eq(chainEvents.chainId, this.chainId),
          between(chainEvents.blockNumber, from, to),
          inArray(chainEvents.status, ["pending", "confirmed"]),
        ),
      );
    const keys = new Map<string, WatchKey>();
    const identities = new Set<string>();
    for (const r of rows) {
      keys.set(`${r.address}:${r.topic0 ?? "*"}`, {
        address: r.address as NormalizedAddress,
        topic0: (r.topic0 as NormalizedHash | null) ?? null,
      });
      identities.add(`${r.blockHash}:${r.logIndex}`);
    }
    return { keys: [...keys.values()], identities };
  }

  /**
   * Reconcile [from, to] against the canonical chain and advance the confirmed cursor:
   *  - canonical rows → confirmed (inserted, promoted from pending, or resurrected)
   *  - live rows in range that are no longer canonical → reverted
   *    (`reorg` if they were pending, `deep_reorg` if they had been confirmed)
   */
  async commitConfirmed(args: { from: number; to: number; rows: NewChainEvent[]; cursor: Cursor }): Promise<CommitResult> {
    return this.#db.transaction(async (tx) => {
      await this.#fence(tx);
      const ids: number[] = [];
      let inserted = 0;
      for (let i = 0; i < args.rows.length; i += INSERT_CHUNK) {
        const chunk = args.rows.slice(i, i + INSERT_CHUNK).map((r) => ({
          ...r,
          status: "confirmed" as const,
          confirmedAt: sql`now()`,
          confirmedSeq: sql`nextval('chain_events_confirmed_seq')`,
        }));
        const result = await tx
          .insert(chainEvents)
          .values(chunk)
          .onConflictDoUpdate({
            target: [chainEvents.chainId, chainEvents.blockHash, chainEvents.logIndex],
            set: {
              status: "confirmed",
              confirmedAt: sql`coalesce(${chainEvents.confirmedAt}, now())`,
              // A fresh position whenever the row (re)enters confirmed: the matcher sees it exactly then.
              confirmedSeq: sql`case when ${chainEvents.status} = 'confirmed' then ${chainEvents.confirmedSeq} else nextval('chain_events_confirmed_seq') end`,
              eventName: sql`coalesce(excluded.event_name, ${chainEvents.eventName})`,
              eventSignature: sql`coalesce(excluded.event_signature, ${chainEvents.eventSignature})`,
              args: sql`coalesce(excluded.args, ${chainEvents.args})`,
              abiSource: sql`coalesce(excluded.abi_source, ${chainEvents.abiSource})`,
              blockTimestamp: sql`coalesce(excluded.block_timestamp, ${chainEvents.blockTimestamp})`,
            },
          })
          .returning({ id: chainEvents.id, inserted: sql<boolean>`(xmax = 0)` });
        for (const r of result) {
          ids.push(r.id);
          if (r.inserted) inserted++;
        }
      }

      const reverted = await tx
        .update(chainEvents)
        .set({
          status: "reverted",
          revertedAt: sql`now()`,
          revertReason: sql`case when ${chainEvents.status} = 'confirmed' then 'deep_reorg' else 'reorg' end`,
          revertedSeq: sql`nextval('chain_events_reverted_seq')`,
        })
        .where(
          and(
            eq(chainEvents.chainId, this.chainId),
            between(chainEvents.blockNumber, args.from, args.to),
            inArray(chainEvents.status, ["pending", "confirmed"]),
            notInArray(chainEvents.id, ids),
          ),
        )
        .returning({ reason: chainEvents.revertReason });

      await this.#setCursor(tx, "confirmed", args.cursor);
      return {
        upserted: ids.length,
        inserted,
        reverted: reverted.length,
        deepReverted: reverted.filter((r) => r.reason === "deep_reorg").length,
      };
    });
  }

  /** Fast-mode ingestion at head: insert as pending (duplicates ignored) and advance the pending cursor. */
  async commitPending(args: { rows: NewChainEvent[]; cursor: Cursor }): Promise<number> {
    return this.#db.transaction(async (tx) => {
      await this.#fence(tx);
      let inserted = 0;
      for (let i = 0; i < args.rows.length; i += INSERT_CHUNK) {
        const chunk = args.rows.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, status: "pending" as const }));
        const result = await tx.insert(chainEvents).values(chunk).onConflictDoNothing().returning({ id: chainEvents.id });
        inserted += result.length;
      }
      await this.#setCursor(tx, "pending", args.cursor);
      return inserted;
    });
  }

  // ---- status --------------------------------------------------------------

  async writeStatus(status: {
    headBlock: number;
    confirmedHead: number;
    confirmedCursor: number;
    pendingCursor: number | null;
    watchCount: number;
    rpc: Record<string, unknown>;
    lastError: string | null;
    deepReorg: boolean;
  }): Promise<void> {
    const values = {
      chainId: this.chainId,
      owner: this.owner,
      headBlock: status.headBlock,
      confirmedHead: status.confirmedHead,
      confirmedCursor: status.confirmedCursor,
      pendingCursor: status.pendingCursor,
      watchCount: status.watchCount,
      rpc: status.rpc,
      lastError: status.lastError,
      lastTickAt: sql`now()`,
      ...(status.deepReorg ? { lastDeepReorgAt: sql`now()` } : {}),
    };
    await this.#db.insert(chainSyncStatus).values(values).onConflictDoUpdate({ target: chainSyncStatus.chainId, set: values });
  }
}

/** Operator CLI helpers. */
export async function addWatch(
  db: Database,
  w: { chainId: number; address: NormalizedAddress; topic0: NormalizedHash | null; fast: boolean; note: string | null },
): Promise<string> {
  const id = newId("watch");
  await db.insert(watches).values({ id, ...w, source: "manual" }).onConflictDoNothing();
  return id;
}
