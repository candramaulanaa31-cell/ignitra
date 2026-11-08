import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { findWorkspaceRoot } from "@ignitra/core/server";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Driver-agnostic handle. Application code depends on this, never on a driver. */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export type DbTarget =
  | { driver: "pg"; url: string }
  | { driver: "pglite"; dataDir: string | null };

export interface DbHandle {
  readonly db: Database;
  readonly driver: DbTarget["driver"];
  /** Round-trip latency in ms; throws if the database is unreachable. */
  ping(): Promise<number>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * `postgres://…` / `postgresql://…` → node-postgres pool.
 * `pglite://memory`                 → ephemeral embedded Postgres (tests).
 * `pglite://<path>`                 → embedded Postgres on disk, path relative to repo root.
 */
export function parseDatabaseUrl(url: string, rootDir: string = findWorkspaceRoot() ?? process.cwd()): DbTarget {
  if (/^postgres(ql)?:\/\//.test(url)) return { driver: "pg", url };
  if (url.startsWith("pglite://")) {
    const rest = url.slice("pglite://".length);
    if (rest === "" || rest === "memory") return { driver: "pglite", dataDir: null };
    return { driver: "pglite", dataDir: isAbsolute(rest) ? rest : resolve(rootDir, rest) };
  }
  throw new Error("DATABASE_URL must start with postgres://, postgresql:// or pglite://");
}

/** Migrations in the repository vs applied to the database (the migrator applies those newer than the last one). */
export async function migrationStatus(db: Database): Promise<{ applied: number; available: number; pending: number }> {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
  let applied = 0;
  let last = 0;
  try {
    const result = (await db.execute(sql`select count(*)::int as n, max(created_at)::text as last from drizzle.__drizzle_migrations`)) as unknown as { rows?: Array<{ n: number; last: string | null }> };
    const [row] = result.rows ?? [];
    applied = Number(row?.n ?? 0);
    last = Number(row?.last ?? 0);
  } catch {
    // No migrations table yet: nothing applied.
  }
  return { applied, available: files.length, pending: files.filter((f) => f.folderMillis > last).length };
}

export class DatabaseLockedError extends Error {
  constructor(dataDir: string, pid: number) {
    super(
      `PGlite data dir ${dataDir} is in use by process ${pid}. PGlite allows ONE process; ` +
        `use a real Postgres DATABASE_URL to run several services at once.`,
    );
    this.name = "DatabaseLockedError";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** PGlite has no multi-process safety; two writers corrupt the data dir. Guard it. */
function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lockFile = join(dataDir, "ignitra.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number.parseInt(readFileSync(lockFile, "utf8"), 10);
      // Our own pid counts as alive: two handles in one process corrupt the dir too.
      if (Number.isInteger(pid) && isAlive(pid)) throw new DatabaseLockedError(dataDir, pid);
      rmSync(lockFile, { force: true }); // stale lock from a crashed process
    }
  }
  throw new Error(`could not acquire PGlite lock at ${lockFile}`);
}

async function timed(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return Math.round((performance.now() - started) * 100) / 100;
}

export async function createDb(databaseUrl: string, options: { applicationName?: string; onPoolError?: (err: Error) => void } = {}): Promise<DbHandle> {
  const target = parseDatabaseUrl(databaseUrl);

  if (target.driver === "pg") {
    const pool = new pg.Pool({
      connectionString: target.url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: options.applicationName ?? "ignitra",
    });
    // An idle client losing its connection must not crash the process; the pool replaces it.
    pool.on("error", (err) => options.onPoolError?.(err));
    const db: Database = drizzlePg(pool, { schema });
    return {
      db,
      driver: "pg",
      ping: () => timed(() => pool.query("select 1")),
      migrate: () => migratePg(drizzlePg(pool), { migrationsFolder: MIGRATIONS_DIR }),
      close: () => pool.end(),
    };
  }

  const release = target.dataDir ? acquireLock(target.dataDir) : () => {};
  let client: PGlite;
  try {
    client = target.dataDir ? new PGlite(target.dataDir) : new PGlite();
    await client.waitReady;
  } catch (err) {
    release();
    throw err;
  }
  const db: Database = drizzlePglite(client, { schema });
  return {
    db,
    driver: "pglite",
    ping: () => timed(() => db.execute(sql`select 1`)),
    migrate: () => migratePglite(drizzlePglite(client), { migrationsFolder: MIGRATIONS_DIR }),
    close: async () => {
      try {
        await client.close();
      } finally {
        release();
      }
    },
  };
}
