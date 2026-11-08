import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readSync, renameSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "./client";

/**
 * Logical backups (Phase 9). One file holds every table of the `public` schema, read in ONE
 * repeatable-read snapshot, so a backup taken while the services run is consistent. The same
 * file restores into PGlite or Postgres (also: move a PGlite dev database to Postgres).
 *
 * Format (UTF-8 lines, gzip when the file name ends in .gz):
 *   @ignitra-backup {"version":1,"created_at":…,"migrations":{"count":…,"last":…},"tables":[…]}
 *   @table <name>                      tables parents-first (foreign-key order)
 *   {row_to_json of one row}            rows ordered by primary key
 *   …
 *   @end {"tables":{name:rows},"rows":n,"sha256":<hex of every line before @end>}
 *
 * Rows never pass through JSON.parse: Postgres renders them and parses them back
 * (json_populate_recordset), so bigints, timestamps and jsonb round-trip exactly.
 *
 * Secrets stay encrypted inside (envelopes; sessions and API keys only as hashes). Restoring
 * needs the same ENCRYPTION_KEY (or it in ENCRYPTION_KEYS_PREVIOUS). Still: a backup holds
 * account data, so it is written owner-only (0600) and should be stored like the database.
 */

export const BACKUP_FORMAT = "ignitra-backup";
export const BACKUP_VERSION = 1;
const FETCH = 1000;

export interface BackupSummary {
  readonly createdAt: string;
  readonly migrations: { readonly count: number; readonly last: string | null };
  readonly tables: Readonly<Record<string, number>>;
  readonly rows: number;
  readonly sha256: string;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

type Executor = Pick<Database, "execute">;

async function rows<T>(db: Executor, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
  return Array.isArray(result) ? result : (result.rows ?? []);
}

interface TablePlan {
  readonly name: string;
  /** Columns an INSERT may set (generated columns are computed by Postgres). */
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly identity: readonly string[];
}

/** Every table of `public`, parents before children; ties alphabetical, so the order is stable. */
async function tablePlan(db: Executor): Promise<TablePlan[]> {
  const tables = await rows<{ name: string }>(db, sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const columns = await rows<{ table_name: string; column_name: string; is_identity: string; is_generated: string }>(
    db,
    sql`select table_name, column_name, is_identity, is_generated from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`,
  );
  const keys = await rows<{ table_name: string; column_name: string }>(
    db,
    sql`select tc.table_name, kcu.column_name from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on kcu.constraint_schema = tc.constraint_schema and kcu.constraint_name = tc.constraint_name
        where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY' order by tc.table_name, kcu.ordinal_position`,
  );
  const edges = await rows<{ child: string; parent: string }>(
    db,
    sql`select c.relname as child, p.relname as parent from pg_constraint k
        join pg_class c on c.oid = k.conrelid join pg_class p on p.oid = k.confrelid join pg_namespace n on n.oid = k.connamespace
        where k.contype = 'f' and n.nspname = 'public'`,
  );

  const parents = new Map<string, Set<string>>(tables.map((t) => [t.name, new Set<string>()]));
  for (const e of edges) {
    if (e.child === e.parent) throw new BackupError(`table ${e.child} references itself: restore order cannot be derived`);
    parents.get(e.child)?.add(e.parent);
  }
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < parents.size) {
    const ready = [...parents].filter(([t, ps]) => !placed.has(t) && [...ps].every((p) => placed.has(p) || !parents.has(p))).map(([t]) => t);
    if (ready.length === 0) throw new BackupError(`foreign keys form a cycle among: ${[...parents.keys()].filter((t) => !placed.has(t)).join(", ")}`);
    for (const t of ready.sort()) {
      order.push(t);
      placed.add(t);
    }
  }
  return order.map((name) => {
    const own = columns.filter((c) => c.table_name === name);
    return {
      name,
      columns: own.filter((c) => c.is_generated !== "ALWAYS").map((c) => c.column_name),
      primaryKey: keys.filter((k) => k.table_name === name).map((k) => k.column_name),
      identity: own.filter((c) => c.is_identity === "YES").map((c) => c.column_name),
    };
  });
}

type Sequences = Record<string, { last_value: string; is_called: boolean }>;

/**
 * Every sequence of `public`: identity columns and the chain_events confirmed/reverted sequences that
 * consumer offsets point into (restored lower, new events would sort before the offsets: never run).
 * Sequences ignore snapshots, so these are at least the values the snapshot's rows used.
 */
async function sequenceState(db: Executor): Promise<Sequences> {
  const names = await rows<{ name: string }>(
    db,
    sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and n.nspname = 'public' order by 1`,
  );
  const out: Sequences = {};
  for (const { name } of names) {
    const [state] = await rows<{ last_value: string; is_called: boolean }>(db, sql`select last_value::text as last_value, is_called from ${sql.identifier(name)}`);
    if (state) out[name] = { last_value: String(state.last_value), is_called: Boolean(state.is_called) };
  }
  return out;
}

async function migrationState(db: Executor): Promise<{ count: number; last: string | null }> {
  const [state] = await rows<{ count: number; last: string | null }>(
    db,
    sql`select count(*)::int as count, (select hash from drizzle.__drizzle_migrations order by created_at desc, id desc limit 1) as last from drizzle.__drizzle_migrations`,
  );
  return { count: Number(state?.count ?? 0), last: state?.last ?? null };
}

const list = (names: readonly string[]) =>
  sql.join(
    names.map((n) => sql.identifier(n)),
    sql`, `,
  );

/** Writes a backup of `db` to `out` (does not end it). */
export async function exportDatabase(db: Database, out: Writable, options: { now?: () => Date } = {}): Promise<BackupSummary> {
  const hash = createHash("sha256");
  const write = async (line: string, hashed = true) => {
    if (hashed) hash.update(`${line}\n`);
    if (!out.write(`${line}\n`)) await once(out, "drain");
  };
  return db.transaction(
    async (tx) => {
      // row_to_json renders timestamptz in the session's TimeZone, which initdb takes from the OS:
      // UTC makes the same data give the same bytes on every server.
      await tx.execute(sql`set local timezone to 'UTC'`);
      const migrations = await migrationState(tx);
      const plan = await tablePlan(tx);
      const sequences = await sequenceState(tx);
      const createdAt = (options.now?.() ?? new Date()).toISOString();
      await write(`@${BACKUP_FORMAT} ${JSON.stringify({ version: BACKUP_VERSION, created_at: createdAt, migrations, tables: plan.map((t) => t.name), sequences })}`);
      const counts: Record<string, number> = {};
      for (const table of plan) {
        await write(`@table ${table.name}`);
        const order = table.primaryKey.length > 0 ? sql` order by ${list(table.primaryKey)}` : sql``;
        await tx.execute(sql`declare ignitra_backup no scroll cursor for select row_to_json(t)::text as r from ${sql.identifier(table.name)} t${order}`);
        let n = 0;
        for (;;) {
          const batch = await rows<{ r: string }>(tx, sql.raw(`fetch forward ${FETCH} from ignitra_backup`));
          for (const row of batch) await write(row.r);
          n += batch.length;
          if (batch.length < FETCH) break;
        }
        await tx.execute(sql`close ignitra_backup`);
        counts[table.name] = n;
      }
      const summary: BackupSummary = { createdAt, migrations, tables: counts, rows: Object.values(counts).reduce((a, b) => a + b, 0), sha256: hash.digest("hex") };
      await write(`@end ${JSON.stringify({ tables: summary.tables, rows: summary.rows, sha256: summary.sha256 })}`, false);
      return summary;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

function json<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BackupError(`backup ${what} is malformed`);
  }
}

interface Header {
  version: number;
  created_at: string;
  migrations: { count: number; last: string | null };
  tables: string[];
  sequences: Sequences;
}

interface Trailer {
  tables: Record<string, number>;
  rows: number;
  sha256: string;
}

/**
 * Reads a backup line by line, checking its structure as it goes; `onRows` gets each table's rows in
 * batches. Resolves only when the trailer's checksum and row counts match what was read.
 */
async function readBackup(input: Readable, handlers: { onHeader?: (h: Header) => Promise<void>; onRows?: (table: string, rows: string[]) => Promise<void> }, batchSize: number): Promise<BackupSummary> {
  const hash = createHash("sha256");
  let header: Header | null = null;
  let table: string | null = null;
  let tableIndex = -1;
  let batch: string[] = [];
  const counts: Record<string, number> = {};
  let trailer: Trailer | null = null;
  let lineNo = 0;

  const flush = async () => {
    if (table && batch.length > 0) await handlers.onRows?.(table, batch);
    batch = [];
  };

  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    lineNo++;
    if (trailer) {
      if (line.trim() === "") continue;
      throw new BackupError(`line ${lineNo}: data after @end`);
    }
    if (lineNo === 1) {
      if (!line.startsWith(`@${BACKUP_FORMAT} `)) throw new BackupError("not an IGNITRA backup (missing @ignitra-backup header)");
      const parsed = json<Header>(line.slice(BACKUP_FORMAT.length + 2), "header");
      if (parsed.version !== BACKUP_VERSION) throw new BackupError(`backup format version ${parsed.version} is not supported (expected ${BACKUP_VERSION})`);
      if (!Array.isArray(parsed.tables) || !parsed.migrations || typeof parsed.sequences !== "object" || parsed.sequences === null) throw new BackupError("backup header is malformed");
      header = parsed;
      hash.update(`${line}\n`);
      await handlers.onHeader?.(parsed);
      continue;
    }
    if (!header) throw new BackupError("backup header is malformed");
    if (line.startsWith("@end ")) {
      await flush();
      trailer = json<Trailer>(line.slice(5), "@end line");
      continue;
    }
    hash.update(`${line}\n`);
    if (line.startsWith("@table ")) {
      await flush();
      table = line.slice(7);
      tableIndex++;
      if (header.tables[tableIndex] !== table) throw new BackupError(`line ${lineNo}: table ${table} is out of the header's order`);
      counts[table] = 0;
    } else if (line.startsWith("{")) {
      if (!table) throw new BackupError(`line ${lineNo}: row outside a table`);
      batch.push(line);
      counts[table] = (counts[table] ?? 0) + 1;
      if (batch.length >= batchSize) await flush();
    } else {
      throw new BackupError(`line ${lineNo}: unexpected content`);
    }
  }

  if (!header) throw new BackupError("the backup is empty");
  if (!trailer) throw new BackupError("the backup is truncated (no @end line)");
  const sha256 = hash.digest("hex");
  if (sha256 !== trailer.sha256) throw new BackupError("checksum mismatch: the backup is corrupted or was edited");
  if (tableIndex !== header.tables.length - 1) throw new BackupError("the backup is missing tables");
  for (const name of header.tables) {
    if ((counts[name] ?? 0) !== trailer.tables[name]) throw new BackupError(`row count mismatch in ${name}`);
  }
  return { createdAt: header.created_at, migrations: header.migrations, tables: counts, rows: Object.values(counts).reduce((a, b) => a + b, 0), sha256 };
}

/** Checks a backup end to end (structure, checksum, counts) without touching a database. */
export function verifyBackup(input: Readable): Promise<BackupSummary> {
  return readBackup(input, {}, Number.MAX_SAFE_INTEGER);
}

/**
 * Restores a backup into an EMPTY, migrated database at the backup's schema version, in one
 * transaction: any problem (wrong version, data present, corrupt file) leaves the database as it was.
 */
export async function importDatabase(db: Database, input: Readable, options: { batchSize?: number } = {}): Promise<BackupSummary> {
  return db.transaction(async (tx) => {
    let plan = new Map<string, TablePlan>();
    let sequences: Sequences = {};
    const summary = await readBackup(
      input,
      {
        onHeader: async (header) => {
          const here = await migrationState(tx);
          if (here.count !== header.migrations.count || here.last !== header.migrations.last) {
            throw new BackupError(
              `the backup was taken at schema migration ${header.migrations.count}, this database is at ${here.count}: restore with the IGNITRA version that took it, then upgrade`,
            );
          }
          const tables = await tablePlan(tx);
          if (tables.map((t) => t.name).join(",") !== header.tables.join(",")) throw new BackupError("the backup's tables do not match this database's schema");
          for (const t of tables) {
            const [row] = await rows<{ present: boolean }>(tx, sql`select exists (select 1 from ${sql.identifier(t.name)}) as present`);
            if (row?.present) throw new BackupError(`restore needs an empty database: ${t.name} has rows (stop the services and use a fresh database)`);
          }
          plan = new Map(tables.map((t) => [t.name, t]));
          const sequenceNames = Object.keys(await sequenceState(tx)).sort().join(",");
          if (sequenceNames !== Object.keys(header.sequences).sort().join(",")) throw new BackupError("the backup's sequences do not match this database's schema");
          sequences = header.sequences;
        },
        onRows: async (name, batch) => {
          const t = plan.get(name);
          if (!t) throw new BackupError(`unknown table ${name}`);
          const overriding = t.identity.length > 0 ? sql` overriding system value` : sql``;
          await tx.execute(
            sql`insert into ${sql.identifier(t.name)} (${list(t.columns)})${overriding} select ${list(t.columns)} from json_populate_recordset(null::${sql.identifier(t.name)}, ${`[${batch.join(",")}]`}::json)`,
          );
        },
      },
      options.batchSize ?? 500,
    );
    // Sequences continue exactly where the source's were (ids, consumer-offset positions).
    for (const [name, state] of Object.entries(sequences)) {
      if (!/^-?\d+$/.test(state.last_value)) throw new BackupError(`sequence ${name} has a malformed value`);
      await tx.execute(sql`select setval(${`public.${name}`}::regclass, ${state.last_value}::bigint, ${state.is_called})`);
    }
    return summary;
  });
}

// ---- files ----

/** Opens a backup file, un-gzipping it when it starts with the gzip magic bytes. */
export function openBackupFile(path: string): Readable {
  const magic = Buffer.alloc(2);
  const fd = openSync(path, "r");
  try {
    readSync(fd, magic, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  const file = createReadStream(path);
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return file;
  const gunzip = createGunzip();
  file.on("error", (err) => gunzip.destroy(err));
  return file.pipe(gunzip);
}

/**
 * Writes a backup to `path` (gzip when it ends in .gz), owner-only. Written to `<path>.partial`
 * and renamed when complete, so a crash never leaves a file that looks like a finished backup.
 */
export async function exportToFile(db: Database, path: string, options: { now?: () => Date } = {}): Promise<BackupSummary> {
  if (existsSync(path)) throw new BackupError(`${path} already exists`);
  const partial = `${path}.partial`;
  const file = createWriteStream(partial, { mode: 0o600 });
  try {
    let summary: BackupSummary;
    if (path.endsWith(".gz")) {
      const gzip = createGzip();
      const done = pipeline(gzip, file);
      done.catch(() => {}); // awaited below; a failed export must not leave it unhandled
      summary = await exportDatabase(db, gzip, options);
      gzip.end();
      await done;
    } else {
      summary = await exportDatabase(db, file, options);
      file.end();
      await finished(file);
    }
    renameSync(partial, path);
    return summary;
  } catch (err) {
    if (!file.closed) {
      const closed = once(file, "close");
      file.destroy();
      await closed;
    }
    rmSync(partial, { force: true });
    throw err;
  }
}
