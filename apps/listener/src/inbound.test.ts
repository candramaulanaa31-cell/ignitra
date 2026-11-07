import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChainConfig, usagePeriod } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { FakeChain, addr } from "@ignitra/chain/testing";
import { createRunner, createSafeHttp } from "@ignitra/actions";
import { buildServer, createSession } from "@ignitra/api";
import { createDb, flowEvaluations, runSteps, runs, usageMonthly, type DbHandle } from "@ignitra/db";
import { Matcher, TokenInfo, createTriggerModules, ensureUser } from "@ignitra/engine";

/**
 * Phase 5 end-to-end, one process like LISTENER_ROLES=sync,matcher,runner,api:
 * HTTP POST to a flow's inbound URL → 202 → matcher (conditions, quota) → runner →
 * CHAIN_READ against the chain → Telegram message rendered with the read result.
 */

const silent = createLogger("test", "silent");
const chainConfig = resolveChainConfig({ chainId: 4663 });
const TOKEN = addr(0x70c);
const WALLET = addr(0xb0b);
const BOT_TOKEN = "1234567890:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const MASTER = "inbound-e2e-webhook-master";
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });

let receiver: Server;
let base: string;
const telegram: Array<{ url: string; body: string; headers: IncomingMessage["headers"] }> = [];
let h: DbHandle;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      telegram.push({ url: req.url ?? "", body, headers: req.headers });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: telegram.length, title: "Ops", type: "group", chat: { id: -1001 } } }));
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  h = await createDb("pglite://memory");
  await h.migrate();
}, 30_000);

afterAll(async () => {
  receiver.closeAllConnections();
  receiver.close();
  await h.close();
});

describe("inbound webhook → run → CHAIN_READ → Telegram", () => {
  it("delivers once per Idempotency-Key, filters by body conditions and meters usage", async () => {
    const chain = new FakeChain();
    const token = chain.token(TOKEN, { symbol: "USDG", decimals: 6 });
    token.seed(WALLET, 2_500_000n); // 2.5 USDG
    chain.mineEmpty(3);

    let wakeups = 0;
    const app = await buildServer({
      db: h,
      chain: chainConfig,
      logger: silent,
      version: "test",
      publicUrl: "http://api.test",
      reader: chain,
      keyring,
      webhookMaster: MASTER,
      allowPrivateOutbound: true,
      telegramApiBase: `${base}/tg`,
      onInboundEvent: () => wakeups++,
    });
    const userId = await ensureUser(h.db, addr(0xa11ce));
    const { token: session } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
    const auth = { authorization: `Bearer ${session}` };

    const conn = await app.inject({ method: "POST", url: "/v1/connections", headers: auth, payload: { type: "telegram", bot_token: BOT_TOKEN, chat_id: "-1001" } });
    expect(conn.statusCode).toBe(201);
    const flow = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers: auth,
      payload: {
        name: "Paid orders",
        activate: true,
        definition: {
          trigger: { type: "INBOUND_WEBHOOK", params: {} },
          conditions: { all: [{ field: "body.total", op: ">=", value: 100 }] },
          actions: [
            { step_id: "read", type: "CHAIN_READ", params: { address: TOKEN, function: "function balanceOf(address account) view returns (uint256)", args: ["{{trigger.body.wallet}}"] } },
            { step_id: "notify", type: "TELEGRAM", params: { connection_id: conn.json().data.id, text: "Order {{trigger.body.order}}: wallet holds {{steps.read.result}} base units (block {{steps.read.block_number}})" } },
          ],
        },
      },
    });
    expect(flow.statusCode).toBe(201);
    const hookPath = new URL(flow.json().data.hook_url as string).pathname;

    const post = (body: unknown, key?: string) => app.inject({ method: "POST", url: hookPath, payload: body as Record<string, unknown>, headers: key ? { "idempotency-key": key } : {} });
    expect((await post({ order: "A-1", total: 120, wallet: WALLET }, "A-1")).statusCode).toBe(202);
    expect((await post({ order: "A-1", total: 120, wallet: WALLET }, "A-1")).json().duplicate).toBe(true); // sender retried
    expect((await post({ order: "B-2", total: 50, wallet: WALLET })).statusCode).toBe(202);
    expect(wakeups).toBe(2);

    const matcher = new Matcher({ db: h.db, chain: chainConfig, reader: chain, tokens: new TokenInfo(chain), triggers: createTriggerModules(), logger: silent, owner: "m", options: { flowsCacheMs: 0 } });
    expect((await matcher.tick()).inbound).toMatchObject({ processed: 2, runs: 1 });
    const runner = createRunner({ db: h.db, owner: "r", logger: silent, keyring, webhookMaster: MASTER, vapid: null, http: createSafeHttp({ allowPrivate: true }), telegramApiBase: `${base}/tg`, chain });
    await runner.pass();
    await runner.drain();

    const [run] = await h.db.select().from(runs);
    expect(run).toMatchObject({ status: "succeeded", triggerType: "INBOUND_WEBHOOK" });
    const steps = await h.db.select().from(runSteps).where(eq(runSteps.runId, run?.id ?? ""));
    expect(steps.find((s) => s.stepId === "read")).toMatchObject({ status: "succeeded", output: { result: "2500000", block_number: 3 } });
    const sent = telegram.filter((t) => t.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}").text).toBe("Order A-1: wallet holds 2500000 base units (block 3)");
    expect(sent[0]?.url).not.toContain("api.test");

    const evaluations = await h.db.select().from(flowEvaluations);
    expect(evaluations.map((e) => e.outcome)).toEqual(["conditions_failed"]);
    const [usage] = await h.db.select().from(usageMonthly).where(eq(usageMonthly.userId, userId));
    expect(usage).toMatchObject({ period: usagePeriod(), runs: 1 });

    // The owner's API view of the run carries the full trace.
    const trace = (await app.inject({ method: "GET", url: `/v1/runs/${run?.id}`, headers: auth })).json().data;
    expect(trace.steps.map((s: { step_id: string; status: string }) => [s.step_id, s.status])).toEqual([
      ["read", "succeeded"],
      ["notify", "succeeded"],
    ]);
    expect(JSON.stringify(trace)).not.toContain(BOT_TOKEN);
    await app.close();
  });
});
