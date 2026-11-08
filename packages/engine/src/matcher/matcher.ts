import type { Logger } from "pino";
import { evaluateConditions, newId, planLimits, usagePeriod, type ChainConfig, type FlowDefinition, type NormalizedHash, type Plan } from "@ignitra/core";
import { enrichWithTrust, type TrustLookup } from "../enrich/trust";
import type { ChainReader } from "@ignitra/chain";
import type { ChainEvent, Database, InboundEvent } from "@ignitra/db";
import { idempotencyKey } from "../evidence";
import type { TokenInfo } from "../tokens";
import type {
  AnyInboundTrigger,
  AnyLogTrigger,
  AnyPollTrigger,
  AnyScheduleTrigger,
  AnyTriggerModule,
  ChainEventView,
  InboundEventView,
  TriggerModuleRegistry,
  TriggerOutcome,
  TriggerRuntime,
} from "../types";
import { EvaluationSampler, SlidingCounter } from "./admission";
import { MatcherStore, emptyStats, type BatchCommit, type EvaluationInsert, type MatcherStream, type RunInsert, type StatsDelta } from "./store";

/**
 * Matcher — turns trigger occurrences into queued runs.
 *
 *   confirmed stream  events in confirmation order → flows in `confirmed` mode (default)
 *   head stream       events in ingestion order    → flows in `fast` mode (act at head)
 *   reverted stream   reorged-out events           → mark / cancel / re-point their runs
 *   polls             BALANCE_THRESHOLD, CONTRACT_DEPLOYED, STATE_CHANGE sampled at the confirmed cursor
 *   schedules         SCHEDULE, on the clock (independent of the chain)
 *   inbound stream    requests accepted by INBOUND_WEBHOOK URLs
 *
 * Every decision is uniform across trigger types:
 *   trigger outcome → conditions → hourly cap → plan quota → run (queued) or evaluation record
 * Runs are unique on their idempotency key (`chain_id:tx_hash:log_index:flow_id` for
 * chain events, `…:schedule:<time>:…`, `…:inbound:<key>:…`), so replays are no-ops, and
 * usage is metered in the same transaction that creates the runs.
 */

export interface MatcherOptions {
  batchSize?: number;
  /** How often each poll trigger samples. */
  pollIntervalMs?: number;
  /** Evaluation rows written per flow per minute (counters stay exact). */
  evaluationsPerMinute?: number;
  /** Auto-pause when events dropped by the hourly cap reach factor × cap within an hour. */
  runawayFactor?: number;
  keepEvaluations?: number;
  evaluationMaxAgeDays?: number;
  pruneEveryMs?: number;
  flowsCacheMs?: number;
  /** A scheduled time fires if the scheduler reaches it within this window; older ones are recorded as missed. */
  scheduleGraceMs?: number;
  /** Inbound webhook requests are kept this long. */
  inboundRetentionDays?: number;
  /** Clock (tests). */
  now?: () => number;
}

interface ActiveFlow {
  readonly id: string;
  readonly ownerId: string;
  readonly plan: Plan;
  readonly version: number;
  readonly versionCreatedAtMs: number;
  readonly activatedAtMs: number | null;
  readonly definition: FlowDefinition;
  readonly module: AnyTriggerModule;
  readonly params: unknown;
  readonly generation: string;
  readonly fast: boolean;
  readonly watchKeys: ReadonlySet<string>;
}

interface FlowIndex {
  readonly log: ActiveFlow[];
  readonly poll: ActiveFlow[];
  readonly schedule: ActiveFlow[];
  readonly inbound: ActiveFlow[];
  readonly loadedAt: number;
}

interface Decision {
  readonly flow: ActiveFlow;
  readonly outcome: TriggerOutcome;
}

export interface StreamReport {
  readonly processed: number;
  readonly runs: number;
  readonly restored?: number;
  /** More events are waiting (batch was full). */
  readonly behind: boolean;
}

export interface RevertReport {
  readonly processed: number;
  readonly moved: number;
  readonly reverted: number;
  readonly cancelled: number;
}

export interface PollReport {
  readonly flows: number;
  readonly runs: number;
  readonly errors: number;
}

export interface MatcherReport {
  readonly role: "leader" | "standby";
  readonly flows?: number;
  readonly confirmed?: StreamReport;
  readonly head?: StreamReport;
  readonly reverted?: RevertReport;
  readonly polled?: PollReport;
  readonly scheduled?: PollReport;
  readonly inbound?: StreamReport;
  readonly paused?: string[];
}

/** Missed scheduled times counted individually up to this many (then "N+"). */
const MAX_MISSED_COUNT = 200;

const watchKey = (address: string, topic0: string | null) => `${address}:${topic0 ?? "*"}`;

function toView(row: ChainEvent): ChainEventView {
  return {
    id: row.id,
    chainId: row.chainId,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash as NormalizedHash,
    blockTimestamp: row.blockTimestamp ? Math.floor(row.blockTimestamp.getTime() / 1000) : null,
    txHash: row.txHash as NormalizedHash,
    txIndex: row.txIndex,
    logIndex: row.logIndex,
    address: row.address as ChainEventView["address"],
    topics: row.topics as NormalizedHash[],
    data: row.data as `0x${string}`,
    status: row.status === "pending" ? "pending" : "confirmed",
  };
}

function toInboundView(row: InboundEvent): InboundEventView {
  return {
    id: row.id,
    requestId: row.requestId,
    flowId: row.flowId,
    dedupeKey: row.dedupeKey,
    idempotencyKey: row.dedupeKey === row.requestId ? null : row.dedupeKey,
    contentType: row.contentType,
    body: row.body,
    query: row.query,
    headers: row.headers,
    bytes: row.bytes,
    receivedAt: row.receivedAt,
  };
}

const duration = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`);

export class Matcher {
  readonly store: MatcherStore;
  readonly #chain: ChainConfig;
  readonly #reader: ChainReader;
  readonly #rt: TriggerRuntime;
  readonly #triggers: TriggerModuleRegistry;
  readonly #trust: TrustLookup | null;
  readonly #log: Logger;
  readonly #opts: Required<Omit<MatcherOptions, "now">>;
  readonly #now: () => number;
  readonly #drops = new SlidingCounter();
  readonly #sampler: EvaluationSampler;
  readonly #lastPoll = new Map<string, number>();
  /** Next scheduled time per (flow, generation): most ticks check a number, not the database. */
  readonly #scheduleDue = new Map<string, number>();
  readonly #warned = new Set<string>();
  #index: FlowIndex | null = null;
  #lastPrune = 0;

  constructor(deps: {
    db: Database;
    chain: ChainConfig;
    reader: ChainReader;
    tokens: TokenInfo;
    triggers: TriggerModuleRegistry;
    logger: Logger;
    owner: string;
    options?: MatcherOptions;
    /** TRUST LAYER scores for flows that read them (null: not configured, fields say "unavailable"). */
    trust?: TrustLookup | null;
  }) {
    this.#chain = deps.chain;
    this.#reader = deps.reader;
    this.#triggers = deps.triggers;
    this.#trust = deps.trust ?? null;
    this.#log = deps.logger;
    this.store = new MatcherStore(deps.db, { chainId: deps.chain.id, owner: deps.owner });
    this.#rt = { chain: deps.chain, reader: deps.reader, tokens: deps.tokens, logger: deps.logger };
    const { now, ...options } = deps.options ?? {};
    this.#now = now ?? Date.now;
    this.#opts = {
      batchSize: 500,
      pollIntervalMs: 15_000,
      evaluationsPerMinute: 20,
      runawayFactor: 3,
      keepEvaluations: 200,
      evaluationMaxAgeDays: 7,
      pruneEveryMs: 10 * 60_000,
      flowsCacheMs: 2_000,
      scheduleGraceMs: 3_600_000,
      inboundRetentionDays: 7,
      ...options,
    };
    this.#sampler = new EvaluationSampler(this.#opts.evaluationsPerMinute);
  }

  /** Drop the flow cache (after a flow changed in this process). */
  invalidateFlows(): void {
    this.#index = null;
  }

  async tick(): Promise<MatcherReport> {
    if (!(await this.store.lease.acquire())) return { role: "standby" };
    const index = await this.#flows();
    const paused: string[] = [];

    const confirmed = await this.#consume("confirmed", index.log.filter((f) => !f.fast), paused);
    const head = await this.#consume("head", index.log.filter((f) => f.fast), paused);
    const reverted = await this.#reverts(index);
    const polled = await this.#polls(index, paused);
    const scheduled = await this.#schedules(index, paused);
    const inbound = await this.#inbound(index, paused);
    if (paused.length > 0) this.invalidateFlows();

    if (this.#now() - this.#lastPrune > this.#opts.pruneEveryMs) {
      this.#lastPrune = this.#now();
      const pruned = await this.store.pruneEvaluations(this.#opts.keepEvaluations, this.#opts.evaluationMaxAgeDays);
      const requests = await this.store.pruneInbound(this.#opts.inboundRetentionDays);
      if (pruned + requests > 0) this.#log.debug({ pruned, requests }, "pruned flow evaluations / inbound requests");
    }
    const flows = index.log.length + index.poll.length + index.schedule.length + index.inbound.length;
    return { role: "leader", flows, confirmed, head, reverted, polled, scheduled, inbound, paused };
  }

  // ---- flow index ------------------------------------------------------------

  #warnOnce(key: string, msg: string, extra: Record<string, unknown>): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log.warn(extra, msg);
  }

  async #flows(): Promise<FlowIndex> {
    if (this.#index && this.#now() - this.#index.loadedAt < this.#opts.flowsCacheMs) return this.#index;
    const index: FlowIndex = { log: [], poll: [], schedule: [], inbound: [], loadedAt: this.#now() };
    for (const row of await this.store.loadActiveFlows()) {
      const type = row.definition.trigger.type;
      const module = this.#triggers.has(type) ? this.#triggers.get(type) : undefined;
      if (!module) {
        this.#warnOnce(`missing:${row.id}`, "active flow uses a trigger this process does not implement — skipped", { flowId: row.id, type });
        continue;
      }
      const params = module.paramsSchema.safeParse(row.definition.trigger.params);
      if (!params.success) {
        this.#warnOnce(`params:${row.id}:${row.version}`, "active flow has params its trigger rejects — skipped", { flowId: row.id, version: row.version });
        continue;
      }
      const base = {
        id: row.id,
        ownerId: row.ownerId,
        plan: row.plan,
        version: row.version,
        versionCreatedAtMs: row.versionCreatedAt.getTime(),
        activatedAtMs: row.activatedAt ? row.activatedAt.getTime() : null,
        definition: row.definition,
        module,
        params: params.data,
        generation: `${row.version}:${row.activatedAt?.getTime() ?? 0}`,
        fast: row.definition.settings.mode === "fast" && module.supportsFast,
        watchKeys: new Set<string>(),
      };
      if (module.kind === "log") {
        index.log.push({ ...base, watchKeys: new Set(module.watches(params.data).map((w) => watchKey(w.address, w.topic0))) });
      } else {
        index[module.kind].push(base);
      }
    }
    this.#index = index;
    return index;
  }

  // ---- admission -------------------------------------------------------------

  async #admit(raw: readonly Decision[], paused: string[]): Promise<BatchCommit> {
    // TRUST LAYER fields, only for flows that read them (lazy, cached, never throws).
    const decisions = await Promise.all(
      raw.map(async (d) => (d.outcome.kind === "match" ? { ...d, outcome: { ...d.outcome, payload: await enrichWithTrust(d.flow.definition, d.outcome.payload, this.#trust) } } : d)),
    );
    const runs: RunInsert[] = [];
    const evaluations: EvaluationInsert[] = [];
    const stats = new Map<string, StatsDelta>();
    const pauses: Array<{ flowId: string; reason: string }> = [];
    const owners = new Map(decisions.map((d) => [d.flow.id, d.flow.ownerId]));
    const period = usagePeriod(new Date(this.#now()));
    const delta = (flowId: string) => {
      let d = stats.get(flowId);
      if (!d) stats.set(flowId, (d = emptyStats()));
      return d;
    };
    const record = (d: Decision, outcome: EvaluationInsert["outcome"], reason: string | null, conditions: unknown[]) => {
      if (!this.#sampler.allow(d.flow.id, this.#now())) return;
      evaluations.push({
        flowId: d.flow.id,
        flowVersion: d.flow.version,
        idempotencyKey: idempotencyKey(this.#chain.id, d.outcome.key, d.flow.id),
        outcome,
        reason,
        triggerEvent: d.outcome.payload,
        conditionsResult: conditions,
      });
    };

    const matches = decisions.filter((d) => d.outcome.kind === "match");
    const counts = await this.store.runsLastHour([...new Set(matches.map((d) => d.flow.id))]);
    const used = await this.store.usage([...new Set(matches.map((d) => d.flow.ownerId))], period);
    const dropped = new Map<string, number>();

    for (const d of decisions) {
      const flowId = d.flow.id;
      if (d.outcome.kind === "undetermined") {
        delta(flowId).undetermined++;
        record(d, "undetermined", d.outcome.reason, []);
        continue;
      }
      if (d.outcome.kind === "missed") {
        delta(flowId).missed++;
        record(d, "missed", d.outcome.reason, []);
        continue;
      }
      delta(flowId).matched++;
      const evaluation = evaluateConditions(d.flow.definition.conditions, d.outcome.payload);
      if (!evaluation.passed) {
        delta(flowId).conditionsFailed++;
        record(d, "conditions_failed", null, evaluation.results as unknown[]);
        continue;
      }
      const cap = d.flow.definition.settings.max_runs_per_hour;
      const hour = counts.get(flowId) ?? 0;
      if (hour >= cap) {
        delta(flowId).rateLimited++;
        dropped.set(flowId, (dropped.get(flowId) ?? 0) + 1);
        record(d, "rate_limited", `max_runs_per_hour=${cap} reached`, evaluation.results as unknown[]);
        continue;
      }
      // Plan quota: free plans stop creating runs at the monthly limit; paid plans meter overage.
      const limits = planLimits(d.flow.plan);
      const month = used.get(d.flow.ownerId) ?? 0;
      if (!limits.overage && month >= limits.runsPerMonth) {
        delta(flowId).planLimited++;
        record(d, "plan_limited", `${d.flow.plan} plan: all ${limits.runsPerMonth} runs of ${period} used (resets on the 1st, UTC)`, evaluation.results as unknown[]);
        continue;
      }
      counts.set(flowId, hour + 1);
      used.set(d.flow.ownerId, month + 1);
      runs.push({
        id: newId("run"),
        flowId,
        flowVersion: d.flow.version,
        idempotencyKey: idempotencyKey(this.#chain.id, d.outcome.key, flowId),
        triggerType: d.flow.definition.trigger.type,
        triggerEvent: d.outcome.payload,
        conditionsResult: evaluation.results as unknown[],
        chainEventId: d.outcome.chainEventId ?? null,
      });
    }

    // Runaway protection: sustained demand far above the cap is almost always a loop or a misconfigured flow.
    for (const [flowId, n] of dropped) {
      this.#drops.add(flowId, n, this.#now());
      const flow = decisions.find((d) => d.flow.id === flowId)?.flow;
      if (!flow) continue;
      const cap = flow.definition.settings.max_runs_per_hour;
      const total = this.#drops.total(flowId, this.#now());
      if (total >= cap * this.#opts.runawayFactor && !paused.includes(flowId)) {
        const reason = `auto-paused: ${total} matching events dropped in the last hour by max_runs_per_hour=${cap} (possible loop). Raise the limit or tighten the conditions, then resume.`;
        pauses.push({ flowId, reason });
        paused.push(flowId);
        this.#drops.clear(flowId);
        this.#log.warn({ flowId, dropped: total, cap }, "flow auto-paused (runaway)");
      }
    }
    return { runs, evaluations, stats, pauses, owners, period };
  }

  // ---- chain event streams ---------------------------------------------------

  async #consume(stream: "confirmed" | "head", flows: ActiveFlow[], paused: string[]): Promise<StreamReport> {
    let offset = await this.store.offset(stream);
    if (offset === null) {
      // Fresh start: begin at the current end of the stream — no replay of history into runs.
      offset = await this.store.streamHead(stream);
      await this.store.setOffset(stream, offset);
      return { processed: 0, runs: 0, behind: false };
    }
    if (flows.length === 0) {
      // Nobody consumes this stream right now: keep the offset at the end so a new flow starts fresh.
      const head = await this.store.streamHead(stream);
      if (head > offset) await this.store.setOffset(stream, head);
      return { processed: 0, runs: 0, behind: false };
    }

    const rows = await this.#blockCompleteBatch(stream, offset);
    if (rows.length === 0) return { processed: 0, runs: 0, behind: false };
    const last = rows[rows.length - 1];
    const position = stream === "confirmed" ? (last?.confirmedSeq ?? offset) : (last?.id ?? offset);
    const views = rows.filter((r) => r.status !== "reverted").map(toView);

    const decisions: Decision[] = [];
    try {
      for (const flow of flows) {
        const events = views.filter(
          (e) =>
            (flow.watchKeys.has(watchKey(e.address, e.topics[0] ?? null)) || flow.watchKeys.has(watchKey(e.address, null))) &&
            // Events from blocks before activation never trigger the flow. Block time has
            // 1 s resolution, so compare in seconds: a tx in the activation second counts.
            (flow.activatedAtMs === null || e.blockTimestamp === null || e.blockTimestamp >= Math.floor(flow.activatedAtMs / 1000)),
        );
        if (events.length === 0) continue;
        const outcomes = await (flow.module as AnyLogTrigger).matchBatch(events, flow.params, this.#rt, { flowId: flow.id, generation: flow.generation });
        for (const outcome of outcomes) if (outcome) decisions.push({ flow, outcome });
      }
      const batch = await this.#admit(decisions, paused);
      const result = await this.store.commitBatch(stream, position, batch);
      const created = [...result.inserted.values()].reduce((a, b) => a + b, 0);
      return { processed: rows.length, runs: created, restored: result.restored, behind: rows.length >= this.#opts.batchSize };
    } catch (err) {
      // In-memory trigger state may already reflect this batch: drop it so the retry re-derives everything.
      for (const flow of flows) flow.module.reset?.();
      throw err;
    }
  }

  /**
   * A batch never ends in the middle of a block. Stateful triggers (NEW_HOLDER)
   * rely on seeing every Transfer of a block together; a split would hide an
   * earlier transfer of the same block from the next batch.
   */
  async #blockCompleteBatch(stream: "confirmed" | "head", offset: number): Promise<ChainEvent[]> {
    const size = this.#opts.batchSize;
    const fetch = (after: number, limit: number) => (stream === "confirmed" ? this.store.fetchConfirmed(after, limit) : this.store.fetchHead(after, limit));
    const position = (r: ChainEvent) => (stream === "confirmed" ? (r.confirmedSeq ?? 0) : r.id);
    const rows = await fetch(offset, size);
    if (rows.length < size) return rows;
    const lastBlock = rows[rows.length - 1]?.blockNumber;
    const kept = rows.filter((r) => r.blockNumber !== lastBlock);
    if (kept.length > 0) return kept;
    // One block alone fills the batch: take that whole block.
    const all = [...rows];
    for (;;) {
      const more = await fetch(position(all[all.length - 1] as ChainEvent), size);
      const same = more.filter((r) => r.blockNumber === lastBlock);
      all.push(...same);
      if (same.length < more.length || more.length < size) return all;
    }
  }

  async #reverts(index: FlowIndex): Promise<RevertReport> {
    let offset = await this.store.offset("reverted");
    if (offset === null) {
      offset = await this.store.streamHead("reverted");
      await this.store.setOffset("reverted", offset);
      return { processed: 0, moved: 0, reverted: 0, cancelled: 0 };
    }
    const rows = await this.store.fetchReverted(offset, this.#opts.batchSize);
    if (rows.length === 0) return { processed: 0, moved: 0, reverted: 0, cancelled: 0 };
    const position = rows[rows.length - 1]?.revertedSeq ?? offset;
    const result = await this.store.applyReverts(rows, position);
    // A confirmed event vanished: running balances built on it are suspect.
    if (rows.some((r) => r.revertReason === "deep_reorg")) for (const f of index.log) f.module.reset?.();
    if (result.reverted + result.moved > 0) this.#log.warn({ ...result }, "runs affected by reorg");
    return { processed: rows.length, ...result };
  }

  // ---- polled chain state ----------------------------------------------------

  async #polls(index: FlowIndex, paused: string[]): Promise<PollReport> {
    const now = this.#now();
    const due = index.poll.filter((f) => now - (this.#lastPoll.get(f.id) ?? 0) >= this.#opts.pollIntervalMs);
    if (due.length === 0) return { flows: 0, runs: 0, errors: 0 };
    const cursor = await this.store.confirmedCursor();
    if (cursor === null) return { flows: 0, runs: 0, errors: 0 };
    let block;
    try {
      block = await this.#reader.blockByNumber(cursor);
    } catch (err) {
      // e.g. RPC 429: streams were already committed; just sample next interval.
      this.#log.warn({ err: (err as Error).message }, "poll triggers: confirmed block unavailable — retrying next interval");
      return { flows: 0, runs: 0, errors: 1 };
    }
    if (!block) return { flows: 0, runs: 0, errors: 0 };

    let created = 0;
    let errors = 0;
    for (const flow of due) {
      this.#lastPoll.set(flow.id, now);
      try {
        const state = await this.store.loadTriggerState(flow.id, flow.version);
        const result = await (flow.module as AnyPollTrigger).poll(
          { params: flow.params, state, block, scope: { flowId: flow.id, generation: flow.generation } },
          this.#rt,
        );
        const batch = await this.#admit(result.outcomes.map((outcome) => ({ flow, outcome })), paused);
        const commit = await this.store.commitPoll(flow.id, flow.version, result.state as Record<string, unknown> | null, batch);
        created += commit.inserted.get(flow.id) ?? 0;
      } catch (err) {
        errors++;
        this.#log.warn({ err, flowId: flow.id, type: flow.definition.trigger.type }, "poll trigger failed — retrying next interval");
      }
    }
    return { flows: due.length, runs: created, errors };
  }

  // ---- schedules -------------------------------------------------------------

  /**
   * Eligible times are those after max(last fired time, activation, version
   * creation): pausing skips the paused period, a new version starts fresh.
   * Only the latest due time fires (within the grace window); earlier ones
   * that passed while the matcher was down are recorded once as `missed`.
   */
  async #schedules(index: FlowIndex, paused: string[]): Promise<PollReport> {
    const now = this.#now();
    const live = new Set<string>();
    let evaluated = 0;
    let created = 0;
    let errors = 0;
    for (const flow of index.schedule) {
      const cacheKey = `${flow.id}:${flow.generation}`;
      live.add(cacheKey);
      const due = this.#scheduleDue.get(cacheKey);
      if (due !== undefined && due > now) continue;
      evaluated++;
      const module = flow.module as AnyScheduleTrigger;
      try {
        const state = await this.store.loadTriggerState(flow.id, flow.version);
        const lastSlot = typeof state?.last_slot === "string" ? Date.parse(state.last_slot) : Number.NEGATIVE_INFINITY;
        const baseline = Math.max(lastSlot, flow.activatedAtMs ?? Number.NEGATIVE_INFINITY, flow.versionCreatedAtMs);
        const latest = module.latest(flow.params, new Date(now));
        if (!latest || latest.getTime() <= baseline) {
          const next = module.next(flow.params, new Date(Math.max(baseline, now)));
          this.#scheduleDue.set(cacheKey, next ? next.getTime() : Number.POSITIVE_INFINITY);
          continue;
        }

        let missed = 0;
        let firstMissed: Date | null = null;
        for (let slot = module.next(flow.params, new Date(baseline)); slot && slot.getTime() < latest.getTime() && missed < MAX_MISSED_COUNT; slot = module.next(flow.params, slot)) {
          missed++;
          firstMissed ??= slot;
        }
        const late = now - latest.getTime();
        const grace = this.#opts.scheduleGraceMs;
        const outcomes: TriggerOutcome[] = [];
        if (late <= grace) {
          outcomes.push({ kind: "match", key: `schedule:${latest.toISOString()}`, payload: module.payload(flow.params, latest, new Date(now)) });
        } else {
          missed++;
          firstMissed ??= latest;
        }
        if (firstMissed) {
          const count = missed >= MAX_MISSED_COUNT ? `${MAX_MISSED_COUNT}+` : String(missed);
          outcomes.push({
            kind: "missed",
            key: `schedule-missed:${firstMissed.toISOString()}`,
            reason: `${count} scheduled time(s) from ${firstMissed.toISOString()} passed while the scheduler was not running${late > grace ? `; the latest (${latest.toISOString()}) is beyond the ${duration(grace)} grace window` : ""}`,
            payload: module.payload(flow.params, firstMissed, new Date(now)),
          });
        }
        const batch = await this.#admit(outcomes.map((outcome) => ({ flow, outcome })), paused);
        const commit = await this.store.commitPoll(flow.id, flow.version, { last_slot: latest.toISOString() }, batch);
        created += commit.inserted.get(flow.id) ?? 0;
        const next = module.next(flow.params, latest);
        this.#scheduleDue.set(cacheKey, next ? next.getTime() : Number.POSITIVE_INFINITY);
      } catch (err) {
        errors++;
        this.#scheduleDue.set(cacheKey, now + 5_000);
        this.#log.warn({ err, flowId: flow.id }, "schedule trigger failed — retrying in 5 s");
      }
    }
    for (const key of this.#scheduleDue.keys()) if (!live.has(key)) this.#scheduleDue.delete(key);
    return { flows: evaluated, runs: created, errors };
  }

  // ---- inbound webhooks ------------------------------------------------------

  async #inbound(index: FlowIndex, paused: string[]): Promise<StreamReport> {
    // Starts at 0 on a fresh database: requests are explicit user input, never history to skip.
    const offset = (await this.store.offset("inbound")) ?? 0;
    const rows = await this.store.fetchInbound(offset, this.#opts.batchSize);
    if (rows.length === 0) return { processed: 0, runs: 0, behind: false };
    const flows = new Map(index.inbound.map((f) => [f.id, f]));
    const decisions: Decision[] = [];
    for (const row of rows) {
      // Paused / deleted flows, or flows whose trigger changed: the request does not run.
      const flow = flows.get(row.flowId);
      if (!flow) continue;
      if (flow.activatedAtMs !== null && row.receivedAt.getTime() < flow.activatedAtMs) continue;
      const outcome = (flow.module as AnyInboundTrigger).match(toInboundView(row), flow.params);
      if (outcome) decisions.push({ flow, outcome });
    }
    const position = rows[rows.length - 1]?.id ?? offset;
    const batch = await this.#admit(decisions, paused);
    const result = await this.store.commitBatch("inbound" satisfies MatcherStream, position, batch);
    const created = [...result.inserted.values()].reduce((a, b) => a + b, 0);
    return { processed: rows.length, runs: created, behind: rows.length >= this.#opts.batchSize };
  }
}
