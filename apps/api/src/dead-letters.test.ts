import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, resolveChainConfig } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { addr } from "@ignitra/chain/testing";
import { auditLog, createDb, flows, runSteps, runs, sessions, users, type DbHandle } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import { createSession } from "./auth";
import { buildServer } from "./server";

/** Phase 9: dead letters (steps that failed for good) and retrying them through the API. */

const chain = resolveChainConfig({ chainId: 4663 });
const logger = createLogger("api-test", "silent");
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });
const HOOK_FLOW = { trigger: { type: "INBOUND_WEBHOOK", params: {} }, actions: [{ step_id: "notify", type: "WEBHOOK", params: { url: "https://example.com/ok" } }, { step_id: "hook", type: "WEBHOOK", params: { url: "https://example.com/down" } }] };

let h: DbHandle;
type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
}, 30_000);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(sessions);
  await h.db.delete(users);
  app = await buildServer({ db: h, chain, logger, version: "test", keyring, webhookMaster: "dead-letter-test", sessionRatePerMinute: 10_000 });
});

async function user() {
  const userId = await ensureUser(h.db, addr(Math.floor(Math.random() * 1e9)));
  const { token } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
  return { userId, auth: { authorization: `Bearer ${token}` } };
}

/** A run as the runner leaves it: the first step delivered, the second gave up. */
async function partialRun(flowId: string): Promise<string> {
  const id = newId("run");
  const done = new Date();
  await h.db.insert(runs).values({ id, flowId, flowVersion: 1, idempotencyKey: `inbound:${id}`, triggerType: "INBOUND_WEBHOOK", triggerEvent: { body: { order: "A-1" } }, status: "partial", statusReason: "hook: HTTP 503 (gave up after 5 attempts)", finishedAt: done });
  await h.db.insert(runSteps).values([
    { runId: id, stepId: "notify", position: 0, actionType: "WEBHOOK", status: "succeeded", attempts: 1, output: { status: 200 }, finishedAt: done },
    { runId: id, stepId: "hook", position: 1, actionType: "WEBHOOK", status: "failed", attempts: 5, error: "HTTP 503 (gave up after 5 attempts)", finishedAt: done },
  ]);
  return id;
}

describe("dead letters", () => {
  it("lists failed steps per run and retries only those, recorded in the audit log", async () => {
    const me = await user();
    const flow = (await app.inject({ method: "POST", url: "/v1/flows", headers: me.auth, payload: { name: "Orders", definition: HOOK_FLOW, activate: true } })).json().data;
    const runId = await partialRun(flow.id);

    const list = (await app.inject({ method: "GET", url: "/v1/dead-letters", headers: me.auth })).json();
    expect(list).toEqual({
      data: [{ run_id: runId, flow_id: flow.id, flow_name: "Orders", run_status: "partial", created_at: expect.any(String), steps: [{ step_id: "hook", action_type: "WEBHOOK", error: "HTTP 503 (gave up after 5 attempts)", attempts: 5, failed_at: expect.any(String) }] }],
      next_before: null,
    });

    const retried = await app.inject({ method: "POST", url: `/v1/runs/${runId}/retry`, headers: me.auth });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().data).toMatchObject({ id: runId, status: "queued", status_reason: "retrying hook" });
    const steps = await h.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(runSteps.position);
    expect(steps.map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ["notify", "succeeded", 1],
      ["hook", "pending", 0],
    ]);
    expect((await app.inject({ method: "GET", url: "/v1/dead-letters", headers: me.auth })).json().data).toEqual([]);
    const again = await app.inject({ method: "POST", url: `/v1/runs/${runId}/retry`, headers: me.auth });
    expect([again.statusCode, again.json().error.code]).toEqual([409, "not_failed"]);
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, "run.retried"));
    expect(entry).toMatchObject({ ownerId: me.userId, actor: "session", targetId: runId, details: { flow_id: flow.id, steps: ["hook"] } });
  });

  it("asks to resume a paused flow first, and hides other owners' runs", async () => {
    const me = await user();
    const flow = (await app.inject({ method: "POST", url: "/v1/flows", headers: me.auth, payload: { name: "Orders", definition: HOOK_FLOW, activate: true } })).json().data;
    const runId = await partialRun(flow.id);
    await h.db.update(flows).set({ status: "paused" }).where(eq(flows.id, flow.id));
    const paused = await app.inject({ method: "POST", url: `/v1/runs/${runId}/retry`, headers: me.auth });
    expect([paused.statusCode, paused.json().error.code]).toEqual([409, "flow_inactive"]);

    const stranger = await user();
    expect((await app.inject({ method: "GET", url: "/v1/dead-letters", headers: stranger.auth })).json().data).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/v1/runs/${runId}/retry`, headers: stranger.auth })).statusCode).toBe(404);
  });
});
