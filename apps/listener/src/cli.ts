import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, between, count, desc, eq, inArray, max, min, sql } from "drizzle-orm";
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
  recordAudit,
  runSteps,
  runs,
  templates,
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
import { createActionModules, keyUsage, keyringFromRunnerEnv, retryRun, rewrapAll } from "@ignitra/actions";
import { DELIVERY_USAGE, deliveryCommand } from "./cli-delivery";
import { explorerApiUrl, listenerEnvSchema } from "./config";
import { collectMetrics, toPrometheus } from "./metrics";
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
 *   metrics [--prometheus]                   listener lag, gap detector, RPC errors, queue, latency, outcomes
 *
 * Keys
 *   keys status                              stored secrets per encryption key id
 *   keys rewrap [--dry-run]                  wrap every secret's data key with the active ENCRYPTION_KEY
 *   dead-letters [--owner 0x…] [--limit n]   runs whose steps failed for good
 *   run retry <run id>                       run those steps again (delivered steps are not repeated)
 *
 * Accounts
 *   user plan <wallet> <free|builder|team>   (no billing yet: operators set plans)
 *   usage [--owner 0x…]                      runs metered this month vs the plan
 *
 * Public surface
 *   template list | template hide <slug> | template unhide <slug>   (moderation of shared templates)
 *   demo setup <wallet> [--token 0x…] [--min 1000]                   the landing page's live demo flow
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
  dead-letters [--owner 0x..] [--limit n] | run retry <run-id> | metrics [--prometheus]
  keys status | keys rewrap [--dry-run]
  user plan <wallet> <free|builder|team> | usage [--owner 0x..]
  template list | template hide <slug> | template unhide <slug>
  demo setup <wallet> [--token 0x..] [--min 1000]
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
    prometheus: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
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
    min: { type: "string" },
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
    const [before] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId));
    await db.update(users).set({ plan: plan as Plan }).where(eq(users.id, userId));
    const pausedFlows = await enforcePlanFeatures(db, userId);
    await recordAudit(db, { ownerId: userId, actor: "operator", action: "account.plan_changed", targetType: "account", targetId: userId, details: { from: before?.plan ?? null, to: plan, paused_flows: pausedFlows } });
    if (pausedFlows.length > 0) console.log(`paused ${pausedFlows.length} flow(s) using features outside the ${plan} plan: ${pausedFlows.join(", ")}`);
    const l = planLimits(plan);
    console.log(`${userId} (${normalizeAddress(wallet)}) is on ${plan}: ${l.activeFlows ?? "unlimited"} active flows, ${l.runsPerMonth} runs/month${l.overage ? " + metered overage" : ""}, schedules every ${l.minScheduleMinutes} min at most`);
  } else if (cmd === "template" && sub === "list") {
    const rows = await db.select({ t: templates, owner: users.address }).from(templates).innerJoin(users, eq(users.id, templates.ownerId)).orderBy(desc(templates.createdAt)).limit(limit);
    console.table(rows.map((r) => ({ slug: r.t.slug, name: short(r.t.name, 40), owner: short(r.owner, 12), visibility: r.t.visibility, hidden: r.t.hiddenAt ? "yes" : "", created: r.t.createdAt.toISOString().slice(0, 16) })));
  } else if (cmd === "template" && (sub === "hide" || sub === "unhide")) {
    const [slug] = rest;
    if (!slug) throw new Error(USAGE);
    const updated = await db.update(templates).set({ hiddenAt: sub === "hide" ? new Date() : null }).where(eq(templates.slug, slug)).returning({ id: templates.id, ownerId: templates.ownerId });
    for (const t of updated) {
      // The author sees why their template disappeared (or came back).
      await recordAudit(db, { ownerId: t.ownerId, actor: "operator", action: sub === "hide" ? "template.hidden" : "template.unhidden", targetType: "template", targetId: t.id, details: { slug } });
    }
    console.log(updated.length ? `${slug} ${sub === "hide" ? "hidden (answers 404)" : "visible again"}` : `no template ${slug}`);
  } else if (cmd === "demo" && sub === "setup") {
    const [wallet] = rest;
    if (!wallet) throw new Error("usage: pnpm ops demo setup <wallet> [--token 0x..] [--min 1000]");
    const ownerId = await ensureUser(db, wallet);
    const token = values.token && /^0x[0-9a-fA-F]{40}$/.test(values.token) ? values.token : "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    const min = values.min ?? "1000";
    // A read-only flow: nothing leaves IGNITRA, the landing page shows its runs live.
    const created = await createFlow(flowDeps(), {
      ownerId,
      name: `Live demo: transfers ≥ ${min} of ${token.slice(0, 6)}…${token.slice(-4)}`,
      activate: true,
      definition: {
        trigger: { type: "TOKEN_TRANSFER", params: { token } },
        conditions: { all: [{ field: "amount_decimal", op: ">=", value: min }] },
        actions: [{ step_id: "balance", type: "CHAIN_READ", params: { address: token, function: "function balanceOf(address account) view returns (uint256)", args: ["{{trigger.to}}"] } }],
        settings: { mode: "confirmed", max_runs_per_hour: 600 },
      },
    });
    console.log(`demo flow ${created.flowId} is active. Set DEMO_FLOW_ID=${created.flowId} for the API.`);
    // Demo runs are metered like any other: on a capped plan the landing page would go quiet once the month's runs are used.
    const [owner] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, ownerId));
    const limits = planLimits(owner?.plan ?? "free");
    if (!limits.overage) {
      console.log(`warning: the owner is on the ${owner?.plan ?? "free"} plan (${limits.runsPerMonth} runs/month, no overage); the demo stops when they are used. Give it room: pnpm ops user plan ${wallet} team`);
    }
  } else if (cmd === "keys" && (sub === "status" || sub === "rewrap")) {
    // ENCRYPTION_KEY rotation: new key active, old one in ENCRYPTION_KEYS_PREVIOUS, then rewrap.
    const keyring = keyringFromRunnerEnv(env);
    if (!keyring) throw new Error("ENCRYPTION_KEY is not set");
    if (sub === "status") {
      const usage = await keyUsage(db, keyring);
      console.log(JSON.stringify(usage, null, 2));
      console.log(usage.pending > 0 ? `${usage.pending} secret(s) are still wrapped by an older key: run pnpm ops keys rewrap` : "every secret is wrapped by the active key: older keys can be removed");
    } else {
      const report = await rewrapAll(db, keyring, { dryRun: values["dry-run"] });
      console.log(JSON.stringify({ dry_run: values["dry-run"], ...report }, null, 2));
      if (report.failed.length > 0) process.exitCode = 2;
    }
  } else if (cmd === "metrics") {
    // What /metrics serves, readable (or --prometheus for the exposition text).
    const m = await collectMetrics(db, chainId);
    if (values.prometheus) process.stdout.write(toPrometheus(m, chainId));
    else console.log(JSON.stringify(m, null, 2));
  } else if (cmd === "dead-letters") {
    // Runs whose steps failed for good, across accounts (or one with --owner).
    const rows = await db
      .select({ run: runs.id, flow: flows.name, owner: users.address, status: runs.status, at: runs.createdAt })
      .from(runs)
      .innerJoin(flows, eq(flows.id, runs.flowId))
      .innerJoin(users, eq(users.id, flows.ownerId))
      .where(
        and(
          eq(runs.isTest, false),
          inArray(runs.status, ["failed", "partial"]),
          values.owner ? eq(users.address, normalizeAddress(values.owner)) : undefined,
          sql`exists (select 1 from run_steps s where s.run_id = ${runs.id} and s.status = 'failed')`,
        ),
      )
      .orderBy(desc(runs.id))
      .limit(limit);
    const failed = rows.length ? await db.select({ run: runSteps.runId, step: runSteps.stepId, error: runSteps.error }).from(runSteps).where(and(inArray(runSteps.runId, rows.map((r) => r.run)), eq(runSteps.status, "failed"))) : [];
    console.table(
      rows.map((r) => ({
        run: r.run,
        flow: short(r.flow, 30),
        owner: short(r.owner, 12),
        status: r.status,
        at: r.at.toISOString().slice(0, 16),
        failed: failed.filter((f) => f.run === r.run).map((f) => `${f.step}: ${short(f.error ?? "", 60)}`).join(" | "),
      })),
    );
  } else if (cmd === "run" && sub === "retry") {
    const [runId] = rest;
    if (!runId) throw new Error(USAGE);
    const [owner] = await db.select({ id: flows.ownerId }).from(runs).innerJoin(flows, eq(flows.id, runs.flowId)).where(eq(runs.id, runId));
    if (!owner) throw new Error(`no run ${runId}`);
    const result = await retryRun(db, { runId, ownerId: owner.id });
    await recordAudit(db, { ownerId: owner.id, actor: "operator", action: "run.retried", targetType: "run", targetId: runId, details: { flow_id: result.flowId, steps: result.steps } });
    console.log(`${runId} queued again for ${result.steps.join(", ")} (steps that delivered are not repeated)`);
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
