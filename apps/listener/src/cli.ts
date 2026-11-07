import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, between, count, desc, eq, max, min } from "drizzle-orm";
import { PLANS, normalizeAddress, normalizeHash, planLimits, toChecksumAddress, usagePeriod, type NormalizedHash, type Plan } from "@ignitra/core";
import { chainConfigFromEnv, loadServiceEnv } from "@ignitra/core/server";
import { AbiRegistry, BlockscoutAbiFetcher, EventDecoder, LogRangeTooLargeError, createRpcChainReader, type RawLog } from "@ignitra/chain";
import {
  chainCursors,
  chainEvents,
  chainSyncStatus,
  createDb,
  flowEvaluations,
  flowStats,
  flowVersions,
  flows,
  runs,
  usageMonthly,
  users,
  watches,
} from "@ignitra/db";
import {
  FlowValidationError,
  createFlow,
  createTriggerModules,
  enforcePlanFeatures,
  ensureUser,
  getCurrentDefinition,
  inboundHookSalt,
  inboundHookUrl,
  setFlowStatus,
  updateFlowDefinition,
  type FlowServiceDeps,
} from "@ignitra/engine";
import { createActionModules } from "@ignitra/actions";
import { DELIVERY_USAGE, deliveryCommand } from "./cli-delivery";
import { explorerApiUrl, listenerEnvSchema } from "./config";
import { WatchFilter } from "./filter";
import { DbAbiStore, ListenerStore, addWatch } from "./store";

/**
 * Operator CLI — `pnpm ops <command>`.
 *
 * Flows
 *   flow create <file.json> [--owner 0x…] [--name …] [--paused]
 *        file: { "name", "owner", "definition": {…} }  or a bare definition
 *   flow list | flow show <id> | flow pause <id> [--reason …] | flow resume <id>
 *   flow update <id> <file.json>
 *   runs [--flow <id>] [--limit n]          queued/finished runs with condition traces
 *   evals --flow <id> [--limit n]            why matching events did NOT run
 *
 * Accounts
 *   user plan <wallet> <free|builder|team>   (no billing yet: operators set plans)
 *   usage [--owner 0x…]                      runs metered this month vs the plan
 *
 * Chain
 *   watch add <address> [event] [--fast] [--note …] | watch list | watch rm <id>
 *   status | events [--limit n] | stats | verify <from> <to>
 */

const USAGE = `usage: pnpm ops <command>
  flow create <file.json> [--owner 0x..] [--name ..] [--paused]
  flow list | flow show <id> | flow pause <id> [--reason ..] | flow resume <id>
  flow update <id> <file.json>
  runs [--flow <id>] [--limit n]
  evals --flow <id> [--limit n]
  user plan <wallet> <free|builder|team> | usage [--owner 0x..]
  watch add <address> [event-signature|topic0] [--fast] [--note ..] | watch list | watch rm <id>
  status | events [--limit n] | stats | verify <from-block> <to-block>
${DELIVERY_USAGE}`;

// Telegram group/channel ids are negative ("-1001234567890"): parseArgs would read them as
// flags, so join "--chat -100…" / "--thread -…" into "--chat=-100…" first.
const NEGATIVE_VALUE_FLAGS = /^--(chat|thread)$/;
const NEGATIVE_NUMBER = /^-\d+$/;
const argv: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i] ?? "";
  const next = process.argv[i + 1] ?? "";
  if (NEGATIVE_VALUE_FLAGS.test(arg) && NEGATIVE_NUMBER.test(next)) {
    argv.push(`${arg}=${next}`);
    i++;
  } else {
    argv.push(arg);
  }
}

const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    fast: { type: "boolean", default: false },
    paused: { type: "boolean", default: false },
    note: { type: "string" },
    owner: { type: "string" },
    name: { type: "string" },
    reason: { type: "string" },
    flow: { type: "string" },
    limit: { type: "string", default: "20" },
    label: { type: "string" },
    token: { type: "string" },
    chat: { type: "string" },
    thread: { type: "string" },
    url: { type: "string" },
    file: { type: "string" },
    test: { type: "boolean", default: false },
  },
});

const env = loadServiceEnv(listenerEnvSchema);
const handle = await createDb(env.DATABASE_URL, { applicationName: "ignitra-ops" });
if (handle.driver === "pglite") await handle.migrate();
const db = handle.db;
const chainId = env.CHAIN_ID;
const limit = Math.min(500, Math.max(1, Number.parseInt(values.limit ?? "20", 10) || 20));

function flowDeps(): FlowServiceDeps {
  const chain = chainConfigFromEnv(env);
  const reader = createRpcChainReader({ primary: chain.rpc.primary, fallback: chain.rpc.fallback });
  const apiUrl = explorerApiUrl(env);
  const abis = new AbiRegistry({
    store: new DbAbiStore(db, chainId),
    fetcher: apiUrl && env.EXPLORER_API_KEY ? new BlockscoutAbiFetcher({ baseUrl: apiUrl, apiKey: env.EXPLORER_API_KEY }) : null,
    reader,
  });
  return { db, chainId, triggers: createTriggerModules(), actions: createActionModules(env.TELEGRAM_API_URL ? { telegramApiBase: env.TELEGRAM_API_URL } : {}), prepare: { abis } };
}

function readJson(path: string | undefined): Record<string, unknown> {
  if (!path) throw new Error(USAGE);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function topicFrom(input: string | undefined): NormalizedHash | null {
  if (!input) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) return normalizeHash(input);
  return normalizeHash(EventDecoder.selector(input));
}

const short = (s: string | null | undefined, n = 10) => (s ? (s.length > n + 3 ? `${s.slice(0, n)}…` : s) : "");

async function flowCommand(sub: string | undefined, rest: string[]): Promise<void> {
  if (sub === "create") {
    const file = readJson(rest[0]);
    const definition = "definition" in file ? file.definition : file;
    const ownerAddress = values.owner ?? (typeof file.owner === "string" ? file.owner : undefined);
    if (!ownerAddress) throw new Error("--owner <wallet> is required (or an `owner` field in the file)");
    const name = values.name ?? (typeof file.name === "string" ? file.name : "Untitled flow");
    const ownerId = await ensureUser(db, ownerAddress);
    const created = await createFlow(flowDeps(), { ownerId, name, definition, activate: !values.paused });
    console.log(`created ${created.flowId} (v${created.version}, ${created.status})`);
    console.log(JSON.stringify(created.definition.trigger, null, 2));
  } else if (sub === "list") {
    const rows = await db
      .select({ flow: flows, stats: flowStats, definition: flowVersions.definition })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
      .leftJoin(flowStats, eq(flowStats.flowId, flows.id))
      .orderBy(desc(flows.createdAt));
    console.table(
      rows.map((r) => ({
        id: r.flow.id,
        name: short(r.flow.name, 28),
        status: r.flow.status,
        v: r.flow.currentVersion,
        trigger: r.definition.trigger.type,
        mode: r.definition.settings.mode,
        matched: r.stats?.matched ?? 0,
        runs: r.stats?.runs ?? 0,
        failed: r.stats?.conditionsFailed ?? 0,
        limited: r.stats?.rateLimited ?? 0,
        quota: r.stats?.planLimited ?? 0,
        undetermined: r.stats?.undetermined ?? 0,
        missed: r.stats?.missed ?? 0,
        reason: short(r.flow.statusReason, 40),
      })),
    );
  } else if (sub === "show") {
    const id = rest[0];
    if (!id) throw new Error(USAGE);
    const current = await getCurrentDefinition(db, id);
    const [stats] = await db.select().from(flowStats).where(eq(flowStats.flowId, id));
    const [flow] = await db.select().from(flows).where(eq(flows.id, id));
    const salt = current.definition.trigger.type === "INBOUND_WEBHOOK" ? await inboundHookSalt(db, id) : null;
    const publicUrl = env.API_PUBLIC_URL ?? `http://${env.API_HOST}:${env.API_PORT}`;
    const hook = salt && env.WEBHOOK_SIGNING_SECRET ? { hook_url: inboundHookUrl(publicUrl, env.WEBHOOK_SIGNING_SECRET, id, salt) } : {};
    console.log(JSON.stringify({ flow, ...hook, stats: stats ?? null, definition: current.definition }, null, 2));
  } else if (sub === "pause" || sub === "resume") {
    const id = rest[0];
    if (!id) throw new Error(USAGE);
    await setFlowStatus(flowDeps(), id, sub === "pause" ? "paused" : "active", sub === "pause" ? (values.reason ?? "paused by operator") : null);
    console.log(`${id} ${sub === "pause" ? "paused" : "active"}`);
  } else if (sub === "update") {
    const [id, path] = rest;
    if (!id) throw new Error(USAGE);
    const file = readJson(path);
    const { version } = await updateFlowDefinition(flowDeps(), id, "definition" in file ? file.definition : file);
    console.log(`${id} now at v${version}`);
  } else {
    throw new Error(USAGE);
  }
}

async function chainCommand(cmd: string, sub: string | undefined, rest: string[]): Promise<boolean> {
  if (cmd === "watch" && sub === "add") {
    const [address, event] = rest;
    if (!address) throw new Error(USAGE);
    const id = await addWatch(db, { chainId, address: normalizeAddress(address), topic0: topicFrom(event), fast: values.fast ?? false, note: values.note ?? null });
    console.log(`added ${id}`);
  } else if (cmd === "watch" && sub === "list") {
    const rows = await db.select().from(watches).where(eq(watches.chainId, chainId)).orderBy(watches.createdAt);
    console.table(rows.map((w) => ({ id: w.id, address: toChecksumAddress(w.address), topic0: short(w.topic0 ?? "*", 18), fast: w.fast, source: w.source, flow: w.flowId ?? "", note: w.note ?? "" })));
  } else if (cmd === "watch" && sub === "rm") {
    const [id] = rest;
    if (!id) throw new Error(USAGE);
    const removed = await db.delete(watches).where(and(eq(watches.id, id), eq(watches.source, "manual"))).returning();
    console.log(removed.length > 0 ? `removed ${id}` : `no manual watch ${id}`);
  } else if (cmd === "status") {
    const [status] = await db.select().from(chainSyncStatus).where(eq(chainSyncStatus.chainId, chainId));
    const cursors = await db.select().from(chainCursors).where(eq(chainCursors.chainId, chainId));
    console.log(JSON.stringify({ status: status ?? null, cursors }, null, 2));
  } else if (cmd === "events") {
    const rows = await db.select().from(chainEvents).where(eq(chainEvents.chainId, chainId)).orderBy(desc(chainEvents.id)).limit(limit);
    for (const e of rows.reverse()) {
      console.log([e.status.padEnd(9), String(e.blockNumber).padStart(10), `${e.txHash.slice(0, 10)}…:${e.logIndex}`, e.eventName ?? "(undecoded)", JSON.stringify(e.args)].join("  "));
    }
  } else if (cmd === "stats") {
    const rows = await db
      .select({ address: chainEvents.address, status: chainEvents.status, event: chainEvents.eventName, n: count(), fromBlock: min(chainEvents.blockNumber), toBlock: max(chainEvents.blockNumber) })
      .from(chainEvents)
      .where(eq(chainEvents.chainId, chainId))
      .groupBy(chainEvents.address, chainEvents.status, chainEvents.eventName);
    console.table(rows);
  } else if (cmd === "verify") {
    const from = Number.parseInt(sub ?? "", 10);
    const to = Number.parseInt(rest[0] ?? "", 10);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) throw new Error(USAGE);
    const chain = chainConfigFromEnv(env);
    const reader = createRpcChainReader({ primary: chain.rpc.primary, fallback: chain.rpc.fallback });
    const filter = WatchFilter.from(await new ListenerStore(db, { chainId, owner: "cli" }).loadWatches());
    const onChain = new Map<string, RawLog>();
    let step = 500;
    for (let start = from; start <= to; ) {
      const end = Math.min(to, start + step - 1);
      try {
        for (const q of filter.queries(start, end, 100)) {
          for (const log of await reader.getLogs(q)) if (filter.matches(log)) onChain.set(`${log.blockHash}:${log.logIndex}`, log);
        }
        start = end + 1;
      } catch (err) {
        if (!(err instanceof LogRangeTooLargeError) || step === 1) throw err;
        step = Math.max(1, Math.floor(step / 2));
      }
    }
    const stored = await db
      .select({ blockHash: chainEvents.blockHash, logIndex: chainEvents.logIndex })
      .from(chainEvents)
      .where(and(eq(chainEvents.chainId, chainId), eq(chainEvents.status, "confirmed"), between(chainEvents.blockNumber, from, to)));
    const storedIds = new Set(stored.map((r) => `${r.blockHash}:${r.logIndex}`));
    const missing = [...onChain.keys()].filter((k) => !storedIds.has(k));
    const extra = [...storedIds].filter((k) => !onChain.has(k));
    console.log(JSON.stringify({ from, to, onChain: onChain.size, stored: storedIds.size, missing: missing.length, extra: extra.length, sampleMissing: missing.slice(0, 3), sampleExtra: extra.slice(0, 3) }, null, 2));
    if (missing.length + extra.length > 0) process.exitCode = 2;
  } else {
    return false;
  }
  return true;
}

try {
  const [cmd, sub, ...rest] = positionals;
  if (cmd === "flow") {
    await flowCommand(sub, rest);
  } else if (cmd === "runs") {
    const rows = await db
      .select()
      .from(runs)
      .where(values.flow ? eq(runs.flowId, values.flow) : undefined)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit);
    for (const r of rows.reverse()) {
      const conditions = (r.conditionsResult as Array<{ passed: boolean; field: string; actual: unknown }>) ?? [];
      const trace = conditions.map((c) => `${c.passed ? "✓" : "✗"} ${c.field}=${JSON.stringify(c.actual)}`).join(" ");
      const ev = r.triggerEvent as Record<string, unknown>;
      const subject = ev.holder ?? ev.to ?? ev.contract ?? ev.wallet ?? "";
      console.log(
        [
          r.createdAt.toISOString().slice(11, 19),
          r.status.padEnd(8),
          r.flowId,
          r.triggerType.padEnd(17),
          `blk ${String(ev.block_number)}`,
          short(String(subject), 12),
          String(ev.amount_formatted ?? ev.balance_after_formatted ?? ""),
          trace,
          r.revertedAt ? `REVERTED(${r.revertReason})` : "",
        ].join("  "),
      );
    }
  } else if (cmd === "user" && sub === "plan") {
    const [wallet, plan] = rest;
    if (!wallet || !plan || !(PLANS as readonly string[]).includes(plan)) throw new Error(`usage: pnpm ops user plan <wallet> <${PLANS.join("|")}>`);
    const userId = await ensureUser(db, wallet);
    await db.update(users).set({ plan: plan as Plan }).where(eq(users.id, userId));
    const pausedFlows = await enforcePlanFeatures(db, userId);
    if (pausedFlows.length > 0) console.log(`paused ${pausedFlows.length} flow(s) using features outside the ${plan} plan: ${pausedFlows.join(", ")}`);
    const l = planLimits(plan);
    console.log(`${userId} (${normalizeAddress(wallet)}) is on ${plan}: ${l.activeFlows ?? "unlimited"} active flows, ${l.runsPerMonth} runs/month${l.overage ? " + metered overage" : ""}, schedules every ${l.minScheduleMinutes} min at most`);
  } else if (cmd === "usage") {
    const period = usagePeriod();
    const rows = await db
      .select({ address: users.address, plan: users.plan, runs: usageMonthly.runs, planLimited: usageMonthly.planLimited, notified: usageMonthly.limitNotifiedAt })
      .from(usageMonthly)
      .innerJoin(users, eq(users.id, usageMonthly.userId))
      .where(and(eq(usageMonthly.period, period), values.owner ? eq(users.address, normalizeAddress(values.owner)) : undefined))
      .orderBy(desc(usageMonthly.runs));
    console.log(`period ${period} (UTC)`);
    console.table(rows.map((r) => ({ wallet: r.address, plan: r.plan, runs: r.runs, included: planLimits(r.plan).runsPerMonth, quota_dropped: r.planLimited, notified: r.notified?.toISOString() ?? "" })));
  } else if (cmd === "evals") {
    if (!values.flow) throw new Error("--flow <id> is required");
    const rows = await db.select().from(flowEvaluations).where(eq(flowEvaluations.flowId, values.flow)).orderBy(desc(flowEvaluations.id)).limit(limit);
    for (const e of rows.reverse()) {
      const failed = (e.conditionsResult as Array<{ passed: boolean; field: string; op: string; expected: unknown; actual: unknown; error?: string }>)
        .filter((c) => !c.passed)
        .map((c) => `${c.field} ${c.op} ${JSON.stringify(c.expected)} (actual ${JSON.stringify(c.actual)}${c.error ? `, ${c.error}` : ""})`)
        .join("; ");
      console.log([e.createdAt.toISOString().slice(11, 19), e.outcome.padEnd(17), `blk ${String((e.triggerEvent as { block_number?: number }).block_number)}`, e.reason ?? failed].join("  "));
    }
  } else if (!cmd || !((await deliveryCommand(db, env, values, cmd, sub, rest, limit)) || (await chainCommand(cmd, sub, rest)))) {
    console.error(USAGE);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof FlowValidationError ? err.message : (err as Error).message);
  process.exitCode = 1;
} finally {
  await handle.close();
}
