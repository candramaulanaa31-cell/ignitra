import { and, asc, count, desc, eq, gt, isNotNull, ne, or, sql } from "drizzle-orm";
import { DecryptionError, rewrapSecret, type EncryptedEnvelope, type Keyring } from "@ignitra/core/server";
import { connections, onchainGrants, type Database } from "@ignitra/db";

/**
 * ENCRYPTION_KEY rotation (Phase 9). Every secret has its own data key, wrapped by the
 * key-encryption key (ENCRYPTION_KEY, id ENCRYPTION_KEY_ID). To rotate:
 *
 *   1. Set a new ENCRYPTION_KEY and ENCRYPTION_KEY_ID; list the old one in ENCRYPTION_KEYS_PREVIOUS.
 *   2. Restart every service: old secrets still decrypt, new ones use the new key.
 *   3. `pnpm ops keys rewrap`: each data key is wrapped again by the new key (ciphertexts unchanged).
 *   4. Once `pnpm ops keys status` shows nothing on the old key, drop it from ENCRYPTION_KEYS_PREVIOUS.
 *
 * A re-wrap only replaces an envelope that is still exactly what was read: a secret changed
 * meanwhile (already under the new key) is never overwritten with its old value.
 */

export interface KeyUsage {
  readonly activeKid: string;
  /** Envelopes per key id, all tables. */
  readonly byKid: Readonly<Record<string, number>>;
  /** Envelopes not under the active key yet. */
  readonly pending: number;
}

interface Source {
  readonly name: "connections" | "onchain_grants";
  readonly context: (id: string) => string;
  usage(db: Database): Promise<Array<{ kid: string | null; n: number }>>;
  page(db: Database, activeKid: string, after: string, limit: number): Promise<Array<{ id: string; envelope: EncryptedEnvelope }>>;
  /** The newest secrets, whatever key they are under. */
  latest(db: Database, limit: number): Promise<Array<{ id: string; envelope: EncryptedEnvelope }>>;
  replace(db: Database, id: string, before: EncryptedEnvelope, after: EncryptedEnvelope): Promise<boolean>;
}

const SOURCES: readonly Source[] = [
  {
    name: "connections",
    context: (id) => `connection:${id}`,
    usage: (db) => db.select({ kid: sql<string | null>`${connections.secretEnc}->>'kid'`, n: count() }).from(connections).groupBy(sql`1`),
    page: async (db, activeKid, after, limit) =>
      (
        await db
          .select({ id: connections.id, envelope: connections.secretEnc })
          .from(connections)
          .where(and(gt(connections.id, after), or(ne(sql`${connections.secretEnc}->>'kid'`, activeKid), sql`${connections.secretEnc}->>'kid' is null`)))
          .orderBy(asc(connections.id))
          .limit(limit)
      ).map((r) => ({ id: r.id, envelope: r.envelope as unknown as EncryptedEnvelope })),
    latest: async (db, limit) =>
      (await db.select({ id: connections.id, envelope: connections.secretEnc }).from(connections).orderBy(desc(connections.id)).limit(limit)).map((r) => ({
        id: r.id,
        envelope: r.envelope as unknown as EncryptedEnvelope,
      })),
    replace: async (db, id, before, after) =>
      (
        await db
          .update(connections)
          .set({ secretEnc: after })
          .where(and(eq(connections.id, id), sql`${connections.secretEnc} = ${JSON.stringify(before)}::jsonb`))
          .returning({ id: connections.id })
      ).length > 0,
  },
  {
    name: "onchain_grants",
    context: (id) => `onchain-grant:${id}`,
    usage: (db) => db.select({ kid: sql<string | null>`${onchainGrants.sessionKeyEnc}->>'kid'`, n: count() }).from(onchainGrants).where(isNotNull(onchainGrants.sessionKeyEnc)).groupBy(sql`1`),
    page: async (db, activeKid, after, limit) =>
      (
        await db
          .select({ id: onchainGrants.id, envelope: onchainGrants.sessionKeyEnc })
          .from(onchainGrants)
          .where(and(gt(onchainGrants.id, after), isNotNull(onchainGrants.sessionKeyEnc), ne(sql`${onchainGrants.sessionKeyEnc}->>'kid'`, activeKid)))
          .orderBy(asc(onchainGrants.id))
          .limit(limit)
      ).map((r) => ({ id: r.id, envelope: r.envelope as unknown as EncryptedEnvelope })),
    latest: async (db, limit) =>
      (
        await db
          .select({ id: onchainGrants.id, envelope: onchainGrants.sessionKeyEnc })
          .from(onchainGrants)
          .where(isNotNull(onchainGrants.sessionKeyEnc))
          .orderBy(desc(onchainGrants.id))
          .limit(limit)
      ).map((r) => ({ id: r.id, envelope: r.envelope as unknown as EncryptedEnvelope })),
    replace: async (db, id, before, after) =>
      (
        await db
          .update(onchainGrants)
          .set({ sessionKeyEnc: after as unknown as Record<string, unknown> })
          .where(and(eq(onchainGrants.id, id), sql`${onchainGrants.sessionKeyEnc} = ${JSON.stringify(before)}::jsonb`))
          .returning({ id: onchainGrants.id })
      ).length > 0,
  },
];

export async function keyUsage(db: Database, keyring: Keyring): Promise<KeyUsage> {
  const byKid: Record<string, number> = {};
  for (const source of SOURCES) {
    for (const r of await source.usage(db)) {
      const kid = r.kid ?? "(not an envelope)";
      byKid[kid] = (byKid[kid] ?? 0) + Number(r.n);
    }
  }
  const pending = Object.entries(byKid).reduce((sum, [kid, n]) => (kid === keyring.activeKid ? sum : sum + n), 0);
  return { activeKid: keyring.activeKid, byKid, pending };
}

/**
 * Opens the newest `sample` secrets of each table with the keyring, whatever key they are under,
 * to prove ENCRYPTION_KEY still matches the data: a new key under the old ENCRYPTION_KEY_ID would
 * leave every secret unreadable while `keys status` looks fine. Only the data keys are unwrapped;
 * nothing is written.
 */
export async function verifySecrets(db: Database, keyring: Keyring, opts: { sample?: number } = {}): Promise<{ checked: number; failed: Array<{ table: string; id: string; error: string }> }> {
  let checked = 0;
  const failed: Array<{ table: string; id: string; error: string }> = [];
  for (const source of SOURCES) {
    for (const row of await source.latest(db, opts.sample ?? 25)) {
      checked++;
      try {
        rewrapSecret(keyring, row.envelope, source.context(row.id));
      } catch (err) {
        failed.push({ table: source.name, id: row.id, error: err instanceof DecryptionError ? err.message : String(err) });
      }
    }
  }
  return { checked, failed };
}

export interface RewrapReport {
  readonly rewrapped: Readonly<Record<string, number>>;
  /** Changed meanwhile (left as is: already re-encrypted by the change). */
  readonly skipped: number;
  /** Could not be unwrapped with any key in the keyring: listed, never altered. */
  readonly failed: ReadonlyArray<{ table: string; id: string; error: string }>;
}

/** Re-wraps every data key under the active key, page by page. With `dryRun`, only counts. */
export async function rewrapAll(db: Database, keyring: Keyring, opts: { dryRun?: boolean; pageSize?: number } = {}): Promise<RewrapReport> {
  const rewrapped: Record<string, number> = {};
  const failed: Array<{ table: string; id: string; error: string }> = [];
  let skipped = 0;
  for (const source of SOURCES) {
    rewrapped[source.name] = 0;
    let after = "";
    for (;;) {
      const page = await source.page(db, keyring.activeKid, after, opts.pageSize ?? 200);
      if (page.length === 0) break;
      for (const row of page) {
        after = row.id;
        let next: EncryptedEnvelope;
        try {
          next = rewrapSecret(keyring, row.envelope, source.context(row.id));
        } catch (err) {
          failed.push({ table: source.name, id: row.id, error: err instanceof DecryptionError ? err.message : String(err) });
          continue;
        }
        if (opts.dryRun) {
          rewrapped[source.name] = (rewrapped[source.name] ?? 0) + 1;
          continue;
        }
        if (await source.replace(db, row.id, row.envelope, next)) rewrapped[source.name] = (rewrapped[source.name] ?? 0) + 1;
        else skipped++;
      }
    }
  }
  return { rewrapped, skipped, failed };
}
