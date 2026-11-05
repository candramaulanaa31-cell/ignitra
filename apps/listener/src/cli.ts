import { parseArgs } from "node:util";
import { and, between, count, desc, eq, max, min } from "drizzle-orm";
import { normalizeAddress, normalizeHash, toChecksumAddress, type NormalizedHash } from "@ignitra/core";
import { chainConfigFromEnv, loadServiceEnv, workerEnvSchema } from "@ignitra/core/server";
import { EventDecoder, LogRangeTooLargeError, createRpcChainReader, type RawLog } from "@ignitra/chain";
import { chainCursors, chainEvents, chainSyncStatus, createDb, watches } from "@ignitra/db";
import { WatchFilter } from "./filter";
import { ListenerStore, addWatch } from "./store";

/**
 * Operator CLI.
 *   pnpm listener:cli watch add <address> [event] [--fast] [--note <text>]
 *        event = signature `Transfer(address,address,uint256)`, a topic0 hash, or omitted (all events)
 *   pnpm listener:cli watch list
 *   pnpm listener:cli watch rm <watch_id>
 *   pnpm listener:cli status
 *   pnpm listener:cli events [--limit 20]
 *   pnpm listener:cli stats            counts by status / address, block span
 *   pnpm listener:cli verify <from> <to>  re-query the node and diff against confirmed rows
 */

const USAGE = `usage:
  watch add <address> [event-signature|topic0] [--fast] [--note <text>]
  watch list
  watch rm <watch_id>
  status
  events [--limit <n>]
  stats
  verify <from-block> <to-block>`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fast: { type: "boolean", default: false },
    note: { type: "string" },
    limit: { type: "string", default: "20" },
  },
});

const env = loadServiceEnv(workerEnvSchema);
const handle = await createDb(env.DATABASE_URL, { applicationName: "ignitra-cli" });
if (handle.driver === "pglite") await handle.migrate();
const db = handle.db;
const chainId = env.CHAIN_ID;

function topicFrom(input: string | undefined): NormalizedHash | null {
  if (!input) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) return normalizeHash(input);
  return normalizeHash(EventDecoder.selector(input));
}

try {
  const [cmd, sub, ...rest] = positionals;
  if (cmd === "watch" && sub === "add") {
    const [address, event] = rest;
    if (!address) throw new Error(USAGE);
    const id = await addWatch(db, {
      chainId,
      address: normalizeAddress(address),
      topic0: topicFrom(event),
      fast: values.fast ?? false,
      note: values.note ?? null,
    });
    console.log(`added ${id}`);
  } else if (cmd === "watch" && sub === "list") {
    const rows = await db.select().from(watches).where(eq(watches.chainId, chainId)).orderBy(watches.createdAt);
    console.table(
      rows.map((w) => ({
        id: w.id,
        address: toChecksumAddress(w.address),
        topic0: w.topic0 ?? "*",
        fast: w.fast,
        source: w.source,
        flow: w.flowId ?? "",
        note: w.note ?? "",
      })),
    );
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
    const limit = Math.min(500, Math.max(1, Number.parseInt(values.limit ?? "20", 10) || 20));
    const rows = await db.select().from(chainEvents).where(eq(chainEvents.chainId, chainId)).orderBy(desc(chainEvents.id)).limit(limit);
    for (const e of rows.reverse()) {
      console.log(
        [e.status.padEnd(9), String(e.blockNumber).padStart(10), `${e.txHash.slice(0, 10)}…:${e.logIndex}`, e.eventName ?? "(undecoded)", JSON.stringify(e.args)].join("  "),
      );
    }
  } else if (cmd === "stats") {
    const rows = await db
      .select({
        address: chainEvents.address,
        status: chainEvents.status,
        event: chainEvents.eventName,
        n: count(),
        fromBlock: min(chainEvents.blockNumber),
        toBlock: max(chainEvents.blockNumber),
      })
      .from(chainEvents)
      .where(eq(chainEvents.chainId, chainId))
      .groupBy(chainEvents.address, chainEvents.status, chainEvents.eventName);
    console.table(rows);
  } else if (cmd === "verify") {
    const from = Number.parseInt(sub ?? "", 10);
    const to = Number.parseInt(rest[0] ?? "", 10);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) throw new Error(USAGE);
    const reader = createRpcChainReader({ primary: chainConfigFromEnv(env).rpc.primary, fallback: chainConfigFromEnv(env).rpc.fallback });
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
    console.error(USAGE);
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await handle.close();
}
