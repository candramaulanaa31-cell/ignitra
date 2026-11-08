import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, normalizeAddress, type FlowDefinition } from "@ignitra/core";
import { BackupError, exportDatabase, exportToFile, importDatabase, openBackupFile, verifyBackup } from "./backup";
import { createDb, type DbHandle } from "./client";
import { auditLog, connections, consumerOffsets, flowVersions, flows, inboundEvents, inboundHooks, runSteps, runs, users } from "./schema";

/** Phase 9: a backup restores into an empty database exactly (rows, jsonb, bigints, sequences), or not at all. */

const NOW = () => new Date("2026-11-08T12:00:00.000Z");
const DEFINITION: FlowDefinition = {
  trigger: { type: "TOKEN_TRANSFER", params: { token: "0x0000000000000000000000000000000000000001" } },
  actions: [{ step_id: "notify", type: "DISCORD", params: {} }],
  settings: { mode: "confirmed", max_runs_per_hour: 60, onchain: false },
};
const BIG_BLOCK = "9007199254740993"; // 2^53 + 1: wrong by one if it ever passed through a JS number
const BIG_JSON = '{"value": 123456789012345678901234567890, "note": "line one\\nline two → ✓"}';

const handles: DbHandle[] = [];
async function fresh(): Promise<DbHandle> {
  const h = await createDb("pglite://memory");
  await h.migrate();
  handles.push(h);
  return h;
}
const rows = async <T>(h: DbHandle, q: ReturnType<typeof sql>) => ((await h.db.execute(q)) as unknown as { rows: T[] }).rows;

async function dump(h: DbHandle): Promise<string> {
  const parts: string[] = [];
  const out = new Writable({
    write(chunk: Buffer, _enc, cb) {
      parts.push(chunk.toString("utf8"));
      cb();
    },
  });
  await exportDatabase(h.db, out, { now: NOW });
  return parts.join("");
}

async function insertEvent(h: DbHandle, logIndex: number, block = "120") {
  const [row] = await rows<{ id: string; confirmed_seq: string }>(
    h,
    sql`insert into chain_events (chain_id, block_number, block_hash, block_timestamp, tx_hash, tx_index, log_index, address, topics, data, args, status, confirmed_at, confirmed_seq)
        values (4663, ${block}::bigint, ${`0x${"ab".repeat(32)}`}, '2026-11-08T10:00:00.123456Z', ${`0x${"cd".repeat(32)}`}, 0, ${logIndex}, ${`0x${"11".repeat(20)}`},
                '["0xddf2"]'::jsonb, '0x', ${BIG_JSON}::jsonb, 'confirmed', now(), nextval('chain_events_confirmed_seq'))
        returning id::text, confirmed_seq::text`,
  );
  return row as { id: string; confirmed_seq: string };
}

let source: DbHandle;
let backup: string;

beforeAll(async () => {
  source = await fresh();
  const owner = newId("user");
  const flowId = newId("flow");
  await source.db.insert(users).values([
    { id: owner, address: normalizeAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed") },
    { id: newId("user"), address: normalizeAddress("0x0000000000000000000000000000000000000abc") },
  ]);
  await source.db.insert(flows).values({ id: flowId, ownerId: owner, name: "Big buys → Discord", currentVersion: 1 });
  await source.db.insert(flowVersions).values({ flowId, version: 1, definition: DEFINITION });
  const runId = newId("run");
  await source.db.insert(runs).values({ id: runId, flowId, flowVersion: 1, idempotencyKey: "k1", triggerType: "TOKEN_TRANSFER", triggerEvent: { tx_hash: `0x${"ab".repeat(32)}`, block_number: 120, log_index: 0 }, status: "failed", finishedAt: new Date() });
  await source.db.insert(runSteps).values({ runId, stepId: "notify", position: 0, actionType: "DISCORD", status: "failed", error: "HTTP 500\n<html>", finishedAt: new Date() });
  await source.db.insert(connections).values({ id: newId("connection"), ownerId: owner, type: "webhook", label: "Hook", secretEnc: { v: 1, kid: "k1", alg: "A256GCM", iv: "aXY", tag: "dGFn", ct: "Y3Q", dek: "ZGVr" } as never, metadata: {} });
  await source.db.insert(inboundHooks).values({ flowId, salt: "salt-1" });
  await source.db.insert(inboundEvents).values([1, 2, 3].map((i) => ({ requestId: `req_${i}`, flowId, dedupeKey: `d${i}`, body: { i }, bytes: 7 })));
  await source.db.insert(auditLog).values({ id: newId("audit"), ownerId: owner, actor: "system", action: "flow.paused", targetType: "flow", targetId: flowId, details: { reason: "test" } });
  for (const i of [0, 1, 2]) await insertEvent(source, i, i === 2 ? BIG_BLOCK : "120");
  await source.db.insert(consumerOffsets).values({ name: "matcher", position: 3 });
  // A deleted row leaves its ids behind: the restored sequences must not hand them out again.
  await source.db.delete(inboundEvents).where(sql`${inboundEvents.requestId} = 'req_3'`);
  backup = await dump(source);
}, 60_000);

afterAll(async () => {
  for (const h of handles) await h.close();
});

describe("database backups", () => {
  it("restores into an empty database exactly: same rows, values, and sequence positions", async () => {
    const target = await fresh();
    const summary = await importDatabase(target.db, Readable.from([backup]), { batchSize: 2 });
    expect(summary.tables).toMatchObject({ users: 2, flows: 1, runs: 1, run_steps: 1, connections: 1, chain_events: 3, inbound_events: 2, consumer_offsets: 1, audit_log: 1 });
    expect(summary).toEqual(await verifyBackup(Readable.from([backup])));

    // Byte-identical when backed up again: nothing was lost or reshaped on the way.
    expect(await dump(target)).toBe(backup);
    // Also from a server in another TimeZone (initdb takes it from the OS): timestamps are UTC.
    await target.db.execute(sql`set timezone to 'Asia/Jakarta'`);
    expect(await dump(target)).toBe(backup);
    await target.db.execute(sql`set timezone to 'UTC'`);
    const raw = await rows<{ block: string; args: string }>(target, sql`select block_number::text as block, args::text as args from chain_events where block_number > 1000`);
    expect(raw).toEqual([{ block: BIG_BLOCK, args: expect.stringContaining("123456789012345678901234567890") }]);

    // New rows continue after the source's sequences (event stream positions, identity ids).
    expect(await insertEvent(target, 9)).toEqual({ id: "4", confirmed_seq: "4" });
    const [next] = await target.db.insert(inboundEvents).values({ requestId: "req_4", flowId: (await target.db.select().from(flows))[0]?.id as string, dedupeKey: "d4", body: {}, bytes: 2 }).returning();
    expect(next?.id).toBe(4);
  }, 60_000);

  it("refuses a database that already has data, a different schema version, or a damaged file, and changes nothing", async () => {
    const used = await fresh();
    await used.db.insert(users).values({ id: newId("user"), address: normalizeAddress("0x0000000000000000000000000000000000000def") });
    await expect(importDatabase(used.db, Readable.from([backup]))).rejects.toThrow(/restore needs an empty database: users has rows/);
    expect(await used.db.select().from(users)).toHaveLength(1);

    const older = await fresh();
    await older.db.execute(sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`);
    await expect(importDatabase(older.db, Readable.from([backup]))).rejects.toThrow(/schema migration/);

    // Corruption is found at the end of the file, after rows were inserted: all of it rolls back.
    const target = await fresh();
    const edited = backup.replace("Big buys → Discord", "Big bugs → Discord");
    await expect(importDatabase(target.db, Readable.from([edited]))).rejects.toThrow(/checksum mismatch/);
    expect(await target.db.select().from(users)).toHaveLength(0);
    expect(await rows(target, sql`select 1 from chain_events`)).toHaveLength(0);

    const truncated = backup.slice(0, backup.lastIndexOf("@end"));
    await expect(verifyBackup(Readable.from([truncated]))).rejects.toThrow(/truncated/);
    await expect(verifyBackup(Readable.from([backup.replace(/@table users\n/, "")]))).rejects.toThrow(BackupError);
    await expect(verifyBackup(Readable.from(["not a backup\n"]))).rejects.toThrow(/not an IGNITRA backup/);
    await expect(verifyBackup(Readable.from([`${backup}{"late":1}\n`]))).rejects.toThrow(/after @end/);
    expect(await target.db.select().from(users)).toHaveLength(0);
  }, 120_000);

  it("writes gzip files atomically and reads gzip or plain files back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignitra-backup-"));
    try {
      const gz = join(dir, "nightly.ignitra.gz");
      const summary = await exportToFile(source.db, gz, { now: NOW });
      expect(readFileSync(gz).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      expect(readdirSync(dir)).toEqual(["nightly.ignitra.gz"]); // no .partial left behind
      expect(await verifyBackup(openBackupFile(gz))).toEqual(summary);
      await expect(exportToFile(source.db, gz)).rejects.toThrow(/already exists/);

      const plain = join(dir, "plain.ignitra");
      writeFileSync(plain, backup);
      expect((await verifyBackup(openBackupFile(plain))).sha256).toBe(summary.sha256);

      const cut = join(dir, "cut.ignitra.gz");
      const zipped = gzipSync(backup);
      writeFileSync(cut, zipped.subarray(0, Math.floor(zipped.length * 0.6)));
      await expect(verifyBackup(openBackupFile(cut))).rejects.toThrow();

      const target = await fresh();
      expect((await importDatabase(target.db, openBackupFile(gz))).rows).toBe(summary.rows);
      expect(existsSync(`${gz}.partial`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
