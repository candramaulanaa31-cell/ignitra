import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { evaluateConditions, newId, type ConditionGroup, type NormalizedHash } from "@ignitra/core";
import { LogRangeTooLargeError, type ChainReader, type LogQuery, type RawLog } from "@ignitra/chain";
import { inboundEvents, type Database } from "@ignitra/db";
import { timeFields } from "./evidence";
import { createNewHolderTrigger } from "./triggers/new-holder";
import type { AnyInboundTrigger, AnyLogTrigger, AnyPollTrigger, AnyScheduleTrigger, AnyTriggerModule, ChainEventView, InboundEventView, Payload, TriggerMatch, TriggerRuntime } from "./types";

/**
 * Live samples for the builder and "Test flow" (never fabricated):
 *
 *   log triggers     the most recent REAL matching event, found by scanning back
 *                    from the confirmed head (2k → 10k → 30k → 60k blocks, ≈ 2.8 h)
 *   poll triggers    the current on-chain state (a balance, the latest deployment,
 *                    a read) — labelled as state, not as an occurrence
 *   SCHEDULE         the latest scheduled time
 *   INBOUND_WEBHOOK  the flow's latest request, or a body the user pasted
 *
 * When conditions are given, the newest sample that PASSES them is preferred.
 */

export type SampleKind = "event" | "state" | "time" | "request";

export interface TriggerSample {
  readonly kind: SampleKind;
  readonly payload: Payload;
  /** What the sample is, in words (shown next to it). */
  readonly note: string;
  /** Conditions evaluated against the sample (when conditions were given). */
  readonly conditions?: { readonly passed: boolean; readonly results: readonly unknown[] };
  readonly scannedBlocks?: number;
}

export interface SampleContext {
  /** Chain access (needed by log and poll triggers). */
  readonly rt: TriggerRuntime | null;
  /** Confirmed head to sample at. */
  readonly head: number;
  readonly conditions?: ConditionGroup | undefined;
  /** INBOUND_WEBHOOK: the flow whose latest request to use, and/or a pasted body. */
  readonly db?: Database;
  readonly flowId?: string | undefined;
  readonly body?: unknown;
}

const LOG_WINDOWS = [2_000, 10_000, 30_000, 60_000];
/** NEW_HOLDER seeds balances at the batch's first block: stay inside the node's ~10–20 min of state. */
const HOLDER_WINDOWS = [1_000, 3_000];
const MAX_SAMPLE_EVENTS = 300;

async function getLogsAdaptive(reader: ChainReader, query: LogQuery): Promise<RawLog[]> {
  let from = query.fromBlock;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await reader.getLogs({ ...query, fromBlock: from });
    } catch (err) {
      if (!(err instanceof LogRangeTooLargeError) || query.toBlock - from < 10) throw err;
      from = query.toBlock - Math.floor((query.toBlock - from) / 2); // keep the newest half
    }
  }
  return [];
}

/** The last `max` events, extended backwards to whole blocks. */
function tailWholeBlocks(logs: readonly RawLog[], max: number): RawLog[] {
  if (logs.length <= max) return [...logs];
  const firstBlock = logs[logs.length - max]?.blockNumber ?? 0;
  return logs.filter((l) => l.blockNumber >= firstBlock);
}

async function withBlockTime(payload: Payload, reader: ChainReader): Promise<Payload> {
  const n = payload.block_number;
  if (typeof n !== "number") return payload;
  try {
    const header = await reader.blockByNumber(n);
    if (!header) return payload;
    return { ...payload, block_timestamp: new Date(header.timestamp * 1000).toISOString(), time: timeFields(header.timestamp) };
  } catch {
    return payload;
  }
}

function pick(payloads: readonly Payload[], conditions: ConditionGroup | undefined): { payload: Payload; conditions?: TriggerSample["conditions"] } | null {
  if (payloads.length === 0) return null;
  if (!conditions) return { payload: payloads[payloads.length - 1] as Payload };
  for (let i = payloads.length - 1; i >= 0; i--) {
    const r = evaluateConditions(conditions, payloads[i] as Payload);
    if (r.passed) return { payload: payloads[i] as Payload, conditions: { passed: true, results: r.results } };
  }
  const last = payloads[payloads.length - 1] as Payload;
  const r = evaluateConditions(conditions, last);
  return { payload: last, conditions: { passed: r.passed, results: r.results } };
}

async function sampleLog(module: AnyLogTrigger, params: unknown, ctx: SampleContext & { rt: TriggerRuntime }): Promise<TriggerSample | null> {
  // A fresh NEW_HOLDER instance: its running balances must not mix with anything else.
  const mod = module.type === "NEW_HOLDER" ? createNewHolderTrigger() : module;
  const watches = mod.watches(params);
  const addresses = [...new Set(watches.map((w) => w.address))];
  const topic0s = watches.some((w) => w.topic0 === null) ? null : [...new Set(watches.map((w) => w.topic0 as NormalizedHash))];
  let to = ctx.head;
  let scanned = 0;
  for (const span of module.type === "NEW_HOLDER" ? HOLDER_WINDOWS : LOG_WINDOWS) {
    if (to < 0) break;
    const from = Math.max(0, to - span + 1);
    const logs = await getLogsAdaptive(ctx.rt.reader, { fromBlock: from, toBlock: to, addresses, topic0s });
    scanned += to - from + 1;
    to = from - 1;
    if (logs.length === 0) continue;
    const views: ChainEventView[] = tailWholeBlocks(logs, MAX_SAMPLE_EVENTS).map((l) => ({ ...l, id: 0, chainId: ctx.rt.chain.id, status: "confirmed" }));
    const outcomes = await mod.matchBatch(views, params, ctx.rt, { flowId: `sample:${randomUUID()}`, generation: "sample" });
    const matches = outcomes.filter((o): o is TriggerMatch => o?.kind === "match").map((o) => o.payload);
    const chosen = pick(matches, ctx.conditions);
    if (!chosen) continue;
    const payload = await withBlockTime(chosen.payload, ctx.rt.reader);
    return {
      kind: "event",
      payload,
      note: `latest real event (block ${String(payload.block_number)}${typeof payload.tx_hash === "string" ? `, tx ${payload.tx_hash.slice(0, 10)}…` : ""})`,
      ...(chosen.conditions ? { conditions: chosen.conditions } : {}),
      scannedBlocks: scanned,
    };
  }
  return null;
}

function withConditions(sample: Omit<TriggerSample, "conditions">, conditions: ConditionGroup | undefined): TriggerSample {
  if (!conditions) return sample;
  const r = evaluateConditions(conditions, sample.payload);
  return { ...sample, conditions: { passed: r.passed, results: r.results } };
}

export async function sampleTrigger(module: AnyTriggerModule, params: unknown, ctx: SampleContext): Promise<TriggerSample | null> {
  const rt = ctx.rt;
  switch (module.kind) {
    case "log":
      if (!rt) throw new Error("log trigger samples need chain access");
      return sampleLog(module, params, { ...ctx, rt });
    case "poll": {
      const poll = module as AnyPollTrigger;
      if (!poll.sample) return null;
      if (!rt) throw new Error("poll trigger samples need chain access");
      const block = await rt.reader.blockByNumber(ctx.head);
      if (!block) return null;
      const s = await poll.sample(params, rt, block);
      return s ? withConditions({ kind: "state", payload: s.payload, note: s.note }, ctx.conditions) : null;
    }
    case "schedule": {
      const schedule = module as AnyScheduleTrigger;
      const now = new Date();
      const slot = schedule.latest(params, now) ?? schedule.next(params, now);
      if (!slot) return null;
      const payload = schedule.payload(params, slot, now);
      return withConditions({ kind: "time", payload, note: `scheduled time ${String(payload.scheduled_at_local)}` }, ctx.conditions);
    }
    case "inbound": {
      const inbound = module as AnyInboundTrigger;
      let view: InboundEventView | null = null;
      let note = "";
      if (ctx.body !== undefined) {
        const requestId = newId("inboundRequest");
        view = { id: 0, requestId, flowId: ctx.flowId ?? "fl_sample", dedupeKey: requestId, idempotencyKey: null, contentType: "application/json", body: ctx.body, query: {}, headers: { content_type: "application/json" }, bytes: Buffer.byteLength(JSON.stringify(ctx.body)), receivedAt: new Date() };
        note = "the sample body you pasted";
      } else if (ctx.db && ctx.flowId) {
        const [row] = await ctx.db.select().from(inboundEvents).where(eq(inboundEvents.flowId, ctx.flowId)).orderBy(desc(inboundEvents.id)).limit(1);
        if (row) {
          view = { id: row.id, requestId: row.requestId, flowId: row.flowId, dedupeKey: row.dedupeKey, idempotencyKey: row.dedupeKey === row.requestId ? null : row.dedupeKey, contentType: row.contentType, body: row.body, query: row.query, headers: row.headers, bytes: row.bytes, receivedAt: row.receivedAt };
          note = `latest request to the hook (${row.receivedAt.toISOString()})`;
        }
      }
      if (!view) return null;
      const outcome = inbound.match(view, params);
      return outcome ? withConditions({ kind: "request", payload: outcome.payload, note }, ctx.conditions) : null;
    }
  }
}
