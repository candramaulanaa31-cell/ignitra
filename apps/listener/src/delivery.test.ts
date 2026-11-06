import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChainConfig } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { EventDecoder } from "@ignitra/chain";
import { FakeChain, addr } from "@ignitra/chain/testing";
import { createActionModules, createConnection, createRunner, deriveOwnerSigningSecret, verifyWebhookSignature, type RunnerRuntime } from "@ignitra/actions";
import { chainCursors, chainEvents, chainSyncStatus, consumerOffsets, createDb, flowStats, flows, leases, runSteps, runs, users, watches, type DbHandle } from "@ignitra/db";
import { Matcher, TokenInfo, createFlow, createTriggerModules, ensureUser } from "@ignitra/engine";
import { ListenerStore } from "./store";
import { ChainSync } from "./sync";

/**
 * Phase 4 end-to-end: FakeChain → ChainSync → Matcher → Runner → real HTTP
 * receivers on localhost (a webhook server and a Telegram Bot API stub).
 */

const silent = createLogger("test", "silent");
const chainConfig = resolveChainConfig({ chainId: 4663 });
const TOKEN = addr(0x70c);
const WHALE = addr(0x3a1e);
const BOB = addr(0xb0b);
const SUPPLY = 1_000_000_000_000n;
const BOT_TOKEN = "1234567890:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const MASTER = "e2e-webhook-master-secret";
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });

interface Hit {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
let server: Server;
let base: string;
let webhookHits: Hit[] = [];
let telegramHits: Hit[] = [];
let webhookStatus = 200;

let h: DbHandle;
let owner: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const hit = { url: req.url ?? "", headers: req.headers, body };
      res.setHeader("content-type", "application/json");
      if (hit.url.startsWith("/tg/")) {
        telegramHits.push(hit);
        res.end(JSON.stringify({ ok: true, result: { message_id: telegramHits.length, chat: { id: -1001 } } }));
        return;
      }
      webhookHits.push(hit);
      res.statusCode = webhookStatus;
      res.end(JSON.stringify({ received: webhookStatus < 300 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h = await createDb("pglite://memory");
  await h.migrate();
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await h.close();
});

beforeEach(async () => {
  for (const t of [runs, flowStats, chainEvents, chainCursors, watches, leases, chainSyncStatus, consumerOffsets]) await h.db.delete(t);
  await h.db.delete(flows);
  await h.db.delete(users);
  owner = await ensureUser(h.db, addr(0xa11ce));
  webhookHits = [];
  telegramHits = [];
  webhookStatus = 200;
});

async function stack() {
  const chain = new FakeChain({ logTimestamps: false, timestampOf: () => Math.floor(Date.now() / 1000) });
  const token = chain.token(TOKEN, { symbol: "USDG", decimals: 6 });
  token.seed(WHALE, SUPPLY);
  const sync = new ChainSync({
    reader: chain,
    store: new ListenerStore(h.db, { chainId: 4663, owner: "listener-e2e" }),
    decoder: new EventDecoder(),
    abis: null,
    logger: silent,
    options: { strategy: "depth", depth: 3, maxRange: 100, addressChunk: 100, rewindBlocks: 50, startBlock: 0 },
  });
  const matcher = new Matcher({ db: h.db, chain: chainConfig, reader: chain, tokens: new TokenInfo(chain), triggers: createTriggerModules(), logger: silent, owner: "matcher-e2e", options: { pollIntervalMs: 0, flowsCacheMs: 0 } });
  const runner: RunnerRuntime = createRunner({
    db: h.db,
    owner: "runner-e2e",
    logger: silent,
    keyring,
    webhookMaster: MASTER,
    vapid: null,
    outbound: { allowPrivateNetworks: true }, // receivers run on localhost in this test
    telegramApiBase: `${base}/tg`,
    executor: { baseBackoffMs: 1000 },
  });
  const deps = { db: h.db, chainId: 4663, triggers: createTriggerModules(), actions: createActionModules({ telegramApiBase: `${base}/tg` }), prepare: { abis: null } };
  const settle = async () => {
    await sync.tick();
    await matcher.tick();
    await runner.pass();
    await runner.drain();
  };
  await settle(); // initialize cursors and offsets
  return { chain, token, sync, matcher, runner, deps, settle };
}

async function telegramConnection(): Promise<string> {
  const conn = await createConnection(h.db, keyring, { ownerId: owner, type: "telegram", label: "alerts", secret: { bot_token: BOT_TOKEN }, metadata: { chat_id: "-1001" } });
  return conn.id;
}

const allRuns = () => h.db.select().from(runs).orderBy(asc(runs.createdAt), asc(runs.chainEventId));
const stepsOf = (runId: string) => h.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.position));

describe("on-chain event → delivered actions", () => {
  it("delivers a Telegram message and a signed webhook with the event's data", async () => {
    const s = await stack();
    const connectionId = await telegramConnection();
    const { flowId } = await createFlow(s.deps, {
      ownerId: owner,
      name: "Big buys",
      activate: true,
      definition: {
        trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
        conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 0.5 }] },
        actions: [
          { step_id: "notify", type: "TELEGRAM", params: { connection_id: connectionId, text: "🔥 <b>{{trigger.amount_formatted}} {{trigger.token.symbol}}</b> → {{trigger.to | short}}\n<a href=\"{{trigger.explorer_url}}\">tx</a>" } },
          { step_id: "hook", type: "WEBHOOK", params: { url: `${base}/hook` } },
        ],
      },
    });
    s.chain.mine([s.token.transfer(WHALE, BOB, SUPPLY / 100n)]); // 1% of supply
    s.chain.mineEmpty(3);
    await s.settle();

    const [run] = await allRuns();
    expect(run).toMatchObject({ flowId, status: "succeeded", attempts: 1 });
    expect((await stepsOf(run!.id)).map((x) => [x.stepId, x.status, x.httpStatus])).toEqual([
      ["notify", "succeeded", 200],
      ["hook", "succeeded", 200],
    ]);

    // Telegram: rendered with the event's data, HTML-escaped values, bot token never stored.
    expect(telegramHits).toHaveLength(1);
    const sent = JSON.parse(telegramHits[0]?.body ?? "{}") as { chat_id: string; text: string; parse_mode: string };
    expect(sent).toMatchObject({ chat_id: "-1001", parse_mode: "HTML" });
    expect(sent.text).toBe(`🔥 <b>10,000 USDG</b> → 0x0000…0b0b\n<a href="https://robinhoodchain.blockscout.com/tx/${s.chain.block(1)?.logs[0]?.txHash}">tx</a>`);
    expect(JSON.stringify(await stepsOf(run!.id))).not.toContain(BOT_TOKEN);

    // Webhook: verifiable signature, stable idempotency key, full trigger evidence.
    const hit = webhookHits[0] as Hit;
    expect(verifyWebhookSignature({ secret: deriveOwnerSigningSecret(MASTER, owner), body: hit.body, signature: hit.headers["x-ignitra-signature"] as string, timestamp: hit.headers["x-ignitra-timestamp"] as string })).toBe(true);
    expect(hit.headers["x-ignitra-idempotency-key"]).toBe(`${run!.idempotencyKey}:hook`);
    expect(JSON.parse(hit.body)).toMatchObject({
      type: "run.action",
      run_id: run!.id,
      flow_id: flowId,
      trigger: { to: BOB, amount_decimal: "10000", percent_of_supply: 1, tx_hash: s.chain.block(1)?.logs[0]?.txHash },
    });
    expect((await h.db.select().from(flowStats).where(eq(flowStats.flowId, flowId)))[0]).toMatchObject({ runs: 1, runsSucceeded: 1 });
  });

  it("retries a failing receiver without re-sending steps that already went out", async () => {
    const s = await stack();
    const connectionId = await telegramConnection();
    await createFlow(s.deps, {
      ownerId: owner,
      name: "Every transfer",
      activate: true,
      definition: {
        trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
        actions: [
          { step_id: "notify", type: "TELEGRAM", params: { connection_id: connectionId, text: "{{trigger.amount_formatted}}" } },
          { step_id: "hook", type: "WEBHOOK", params: { url: `${base}/hook` } },
        ],
      },
    });
    webhookStatus = 503;
    s.chain.mine([s.token.transfer(WHALE, BOB, 5n)]);
    s.chain.mineEmpty(3);
    await s.settle();
    const [run] = await allRuns();
    expect(run).toMatchObject({ status: "queued", statusReason: expect.stringMatching(/^retrying hook \(attempt 2\/5\): receiver answered HTTP 503/) });

    webhookStatus = 200;
    await h.db.update(runs).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(runs.id, run!.id));
    await s.runner.pass();
    await s.runner.drain();
    expect(await allRuns()).toMatchObject([{ status: "succeeded", attempts: 2 }]);
    expect(telegramHits).toHaveLength(1); // the Telegram step was NOT re-sent
    expect(webhookHits.map((x) => x.headers["x-ignitra-idempotency-key"])).toEqual([`${run!.idempotencyKey}:hook`, `${run!.idempotencyKey}:hook`]);
  });

  it("sends run.reverted when a fast-mode run was delivered and its event is reorged out", async () => {
    const s = await stack();
    await createFlow(s.deps, {
      ownerId: owner,
      name: "Fast hook",
      activate: true,
      definition: { trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } }, actions: [{ step_id: "hook", type: "WEBHOOK", params: { url: `${base}/hook` } }], settings: { mode: "fast" } },
    });
    s.chain.mine([s.token.transfer(WHALE, BOB, 7n)]);
    await s.settle(); // ingested as pending → run at head → delivered
    expect(webhookHits).toHaveLength(1);

    s.chain.reorg(1, [[]]);
    s.chain.mineEmpty(3);
    await s.settle(); // confirmation pass reverts the event; matcher marks the run
    await s.runner.housekeeping();

    const [run] = await allRuns();
    expect(run).toMatchObject({ status: "succeeded", revertReason: "reorg", revertNotice: { deliveries: [{ step_id: "hook", status: "succeeded", http_status: 200 }] } });
    const notice = webhookHits[1] as Hit;
    expect(notice.headers["x-ignitra-event"]).toBe("run.reverted");
    expect(JSON.parse(notice.body)).toMatchObject({ type: "run.reverted", run_id: run!.id, reason: "reorg" });
    expect(verifyWebhookSignature({ secret: deriveOwnerSigningSecret(MASTER, owner), body: notice.body, signature: notice.headers["x-ignitra-signature"] as string, timestamp: notice.headers["x-ignitra-timestamp"] as string })).toBe(true);
  });
});
