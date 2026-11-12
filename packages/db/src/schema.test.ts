import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, normalizeAddress, type FlowDefinition } from "@ignitra/core";
import { DatabaseLockedError, createDb, parseDatabaseUrl, type DbHandle } from "./client";
import { connections, flowVersions, flows, runSteps, runs, users } from "./schema";

const DEFINITION: FlowDefinition = {
  trigger: { type: "TOKEN_TRANSFER", params: { token: "0x0000000000000000000000000000000000000001" } },
  actions: [{ step_id: "notify", type: "DISCORD", params: {} }],
  settings: { mode: "confirmed", max_runs_per_hour: 60, onchain: false },
};

/** Drizzle wraps driver errors; the Postgres error (code, constraint) is on `cause`. */
async function pgError(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    return cause as { code?: string; constraint?: string };
  }
  throw new Error("expected the query to fail");
}

let h: DbHandle;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.db.delete(users); // cascades through flows → versions → runs → steps, and connections
});

async function seedFlow() {
  const userId = newId("user");
  const flowId = newId("flow");
  await h.db.insert(users).values({ id: userId, address: normalizeAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed") });
  await h.db.insert(flows).values({ id: flowId, ownerId: userId, name: "Big buys → Discord", currentVersion: 1 });
  await h.db.insert(flowVersions).values({ flowId, version: 1, definition: DEFINITION });
  return { userId, flowId };
}

const runRow = (flowId: string, key: string) => ({
  id: newId("run"),
  flowId,
  flowVersion: 1,
  idempotencyKey: key,
  triggerType: "TOKEN_TRANSFER",
  triggerEvent: { tx_hash: `0x${"ab".repeat(32)}`, block_number: 1, log_index: 7 },
});

describe("migrations", () => {
  it("are idempotent", async () => {
    await expect(h.migrate()).resolves.toBeUndefined();
  });

  it("ping reports latency", async () => {
    expect(await h.ping()).toBeGreaterThanOrEqual(0);
  });
});

describe("schema invariants", () => {
  it("stores and reads back a flow version definition as JSON", async () => {
    const { flowId } = await seedFlow();
    const [row] = await h.db.select().from(flowVersions).where(eq(flowVersions.flowId, flowId));
    expect(row?.definition).toEqual(DEFINITION);
  });

  it("defaults: new flows are paused, users are on the free plan in WIB", async () => {
    const { userId, flowId } = await seedFlow();
    const [flow] = await h.db.select().from(flows).where(eq(flows.id, flowId));
    const [user] = await h.db.select().from(users).where(eq(users.id, userId));
    expect(flow?.status).toBe("paused");
    expect(user).toMatchObject({ plan: "free", timezone: "Asia/Jakarta" });
    expect(user?.createdAt).toBeInstanceOf(Date);
  });

  it("allows exactly one run per idempotency key", async () => {
    const { flowId } = await seedFlow();
    const key = `4663:0x${"ab".repeat(32)}:7:${flowId}`;
    await h.db.insert(runs).values(runRow(flowId, key));
    const err = await pgError(h.db.insert(runs).values(runRow(flowId, key)));
    expect(err.code).toBe("23505");
    expect(err.constraint).toBe("runs_idempotency_key_key");

    // The listener's insert path: duplicates are a no-op, not an error.
    const inserted = await h.db.insert(runs).values(runRow(flowId, key)).onConflictDoNothing().returning();
    expect(inserted).toHaveLength(0);
  });

  it("rejects a run for a flow version that does not exist", async () => {
    const { flowId } = await seedFlow();
    const err = await pgError(h.db.insert(runs).values({ ...runRow(flowId, "k"), flowVersion: 2 }));
    expect(err.code).toBe("23503");
    expect(err.constraint).toBe("runs_flow_version_fkey");
  });

  it("rejects non-canonical addresses", async () => {
    const err = await pgError(
      h.db.insert(users).values({ id: newId("user"), address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }),
    );
    expect(err.constraint).toBe("users_address_canonical");
  });

  it("rejects unknown statuses", async () => {
    const { flowId } = await seedFlow();
    const err = await pgError(h.db.execute(`update flows set status = 'deleted' where id = '${flowId}'`));
    expect(err.constraint).toBe("flows_status_valid");
  });

  it("requires finished_at exactly when a run reaches a final status", async () => {
    const { flowId } = await seedFlow();
    const run = runRow(flowId, "k-final");
    await h.db.insert(runs).values(run);

    let err = await pgError(h.db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, run.id)));
    expect(err.constraint).toBe("runs_finished_iff_final");

    err = await pgError(h.db.update(runs).set({ finishedAt: new Date() }).where(eq(runs.id, run.id)));
    expect(err.constraint).toBe("runs_finished_iff_final");

    await h.db.update(runs).set({ status: "succeeded", finishedAt: new Date() }).where(eq(runs.id, run.id));
  });

  it("keys steps by (run, step_id) and orders them by position", async () => {
    const { flowId } = await seedFlow();
    const run = runRow(flowId, "k-steps");
    await h.db.insert(runs).values(run);
    const step = { runId: run.id, stepId: "notify", position: 0, actionType: "DISCORD" };
    await h.db.insert(runSteps).values(step);
    expect((await pgError(h.db.insert(runSteps).values(step))).code).toBe("23505");
    expect((await pgError(h.db.insert(runSteps).values({ ...step, stepId: "other" }))).constraint).toBe(
      "run_steps_run_position_key",
    );
  });

  it("cascades deletes from user down to steps and connections", async () => {
    const { userId, flowId } = await seedFlow();
    const run = runRow(flowId, "k-cascade");
    await h.db.insert(runs).values(run);
    await h.db.insert(runSteps).values({ runId: run.id, stepId: "notify", position: 0, actionType: "DISCORD" });
    await h.db.insert(connections).values({
      id: newId("connection"),
      ownerId: userId,
      type: "discord",
      label: "#alerts",
      secretEnc: { v: 1, alg: "AES-256-GCM", kid: "k1", wiv: "", wdek: "", wtag: "", iv: "", ct: "", tag: "" },
    });

    await h.db.delete(users).where(eq(users.id, userId));
    for (const table of [flows, flowVersions, runs, runSteps, connections]) {
      expect(await h.db.select().from(table)).toHaveLength(0);
    }
  });
});

describe("parseDatabaseUrl", () => {
  it("routes postgres and pglite URLs", () => {
    expect(parseDatabaseUrl("postgres://u:p@h/db")).toEqual({ driver: "pg", url: "postgres://u:p@h/db" });
    expect(parseDatabaseUrl("postgresql://h/db").driver).toBe("pg");
    expect(parseDatabaseUrl("pglite://memory")).toEqual({ driver: "pglite", dataDir: null });
    expect(parseDatabaseUrl("pglite://.data/pglite", "/repo")).toEqual({
      driver: "pglite",
      dataDir: resolve("/repo", ".data/pglite"),
    });
    expect(() => parseDatabaseUrl("mysql://h/db")).toThrow();
  });
});

describe("PGlite on disk", () => {
  it("refuses a second handle on the same data dir and frees it on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignitra-pglite-"));
    const url = `pglite://${dir}`;
    try {
      const first = await createDb(url);
      await expect(createDb(url)).rejects.toBeInstanceOf(DatabaseLockedError);
      await first.close();
      const second = await createDb(url);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a lock from before the last boot as stale, even when its pid is alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignitra-pglite-"));
    const lock = join(dir, "ignitra.lock");
    try {
      // After a reboot the old pid can belong to a live, unrelated process (Windows reuses pids).
      writeFileSync(lock, String(process.pid));
      utimesSync(lock, new Date(0), new Date(0));
      const db = await createDb(`pglite://${dir}`);
      await db.close();
      // A fresh lock with a live pid still refuses.
      writeFileSync(lock, String(process.pid));
      await expect(createDb(`pglite://${dir}`)).rejects.toBeInstanceOf(DatabaseLockedError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
