import type { Logger } from "pino";
import { evaluateConditions, newId, type ChainConfig, type FlowDefinition, type NormalizedHash } from "@ignitra/core";
import type { ChainReader } from "@ignitra/chain";
import type { ChainEvent, Database } from "@ignitra/db";
import { idempotencyKey } from "../evidence";
import type { TokenInfo } from "../tokens";
import type { AnyLogTrigger, AnyPollTrigger, AnyTriggerModule, ChainEventView, TriggerModuleRegistry, TriggerOutcome, TriggerRuntime } from "../types";
import { EvaluationSampler, SlidingCounter } from "./admission";
import { MatcherStore, type BatchCommit, type EvaluationInsert, type MatcherStream, type RunInsert, type StatsDelta } from "./store";

/**
 * Matcher — turns chain events into queued runs.
 *
 *   confirmed stream  events in confirmation order → flows in `confirmed` mode (default)
 *   head stream       events in ingestion order    → flows in `fast` mode (act at head)
 *   reverted stream   reorged-out events           → mark / cancel / re-point their runs
 *   polls             BALANCE_THRESHOLD, CONTRACT_DEPLOYED sampled at the confirmed cursor
 *
 * Each (event, flow) pair is evaluated by exactly one stream. Every decision
 * is uniform across trigger types: trigger outcome → conditions → hourly cap
 * → run (queued) or evaluation record. Runs are unique on their idempotency
 * key `chain_id:tx_hash:log_index:flow_id`, so replays are no-ops.
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
}

interface ActiveFlow {
  readonly id: string;
  readonly version: number;
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
  readonly paused?: string[];
}

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

export class Matcher {
  readonly store: MatcherStore;
  readonly #chain: ChainConfig;
  readonly #reader: ChainReader;
  readonly #rt: TriggerRuntime;
  readonly #triggers: TriggerModuleRegistry;
  readonly #log: Logger;
  readonly #opts: Required<MatcherOptions>;
  readonly #drops = new SlidingCounter();
  readonly #sampler: EvaluationSampler;
  readonly #lastPoll = new Map<string, number>();
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
  }) {
    this.#chain = deps.chain;
    this.#reader = deps.reader;
    this.#triggers = deps.triggers;
    this.#log = deps.logger;
    this.store = new MatcherStore(deps.db, { chainId: deps.chain.id, owner: deps.owner });
    this.#rt = { chain: deps.chain, reader: deps.reader, tokens: deps.tokens, logger: deps.logger };
    this.#opts = {
      batchSize: 500,
      pollIntervalMs: 15_000,
      evaluationsPerMinute: 20,
      runawayFactor: 3,
      keepEvaluations: 200,
      evaluationMaxAgeDays: 7,
      pruneEveryMs: 10 * 60_000,
      flowsCacheMs: 2_000,
      ...deps.options,
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
    if (paused.length > 0) this.invalidateFlows();

    if (Date.now() - this.#lastPrune > this.#opts.pruneEveryMs) {
      this.#lastPrune = Date.now();
      const pruned = await this.store.pruneEvaluations(this.#opts.keepEvaluations, this.#opts.evaluationMaxAgeDays);
      if (pruned > 0) this.#log.debug({ pruned }, "pruned flow evaluations");
    }
    return { role: "leader", flows: index.log.length + index.poll.length, confirmed, head, reverted, polled, paused };
  }

  // ---- flow index ------------------------------------------------------------

  #warnOnce(key: string, msg: string, extra: Record<string, unknown>): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log.warn(extra, msg);
  }

  async #flows(): Promise<FlowIndex> {
    if (this.#index && Date.now() - this.#index.loadedAt < this.#opts.flowsCacheMs) return this.#index;
    const log: ActiveFlow[] = [];
    const poll: ActiveFlow[] = [];
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
        version: row.version,
        activatedAtMs: row.activatedAt ? row.activatedAt.getTime() : null,
        definition: row.definition,
        module,
        params: params.data,
        generation: `${row.version}:${row.activatedAt?.getTime() ?? 0}`,
        fast: row.definition.settings.mode === "fast" && module.supportsFast,
      };
      if (module.kind === "log") {
        const keys = new Set((module as AnyLogTrigger).watches(params.data).map((w) => watchKey(w.address, w.topic0)));
        log.push({ ...base, watchKeys: keys });
      } else {
        poll.push({ ...base, watchKeys: new Set() });
      }
    }
    this.#index = { log, poll, loadedAt: Date.now() };
    return this.#index;
  }

  // ---- admission -------------------------------------------------------------

  async #admit(decisions: readonly Decision[], paused: string[]): Promise<BatchCommit> {
    const runs: RunInsert[] = [];
    const evaluations: EvaluationInsert[] = [];
    const stats = new Map<string, StatsDelta>();
    const pauses: Array<{ flowId: string; reason: string }> = [];
    const delta = (flowId: string) => {
      let d = stats.get(flowId);
      if (!d) stats.set(flowId, (d = { matched: 0, conditionsFailed: 0, rateLimited: 0, undetermined: 0 }));
      return d;
    };
    const record = (d: Decision, outcome: EvaluationInsert["outcome"], reason: string | null, conditions: unknown[]) => {
      if (!this.#sampler.allow(d.flow.id)) return;
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

    const candidates = decisions.filter((d) => d.outcome.kind === "match").map((d) => d.flow.id);
    const counts = await this.store.runsLastHour([...new Set(candidates)]);
    const dropped = new Map<string, number>();

    for (const d of decisions) {
      const flowId = d.flow.id;
      if (d.outcome.kind === "undetermined") {
        delta(flowId).undetermined++;
        record(d, "undetermined", d.outcome.reason, []);
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
      const used = counts.get(flowId) ?? 0;
      if (used >= cap) {
        delta(flowId).rateLimited++;
        dropped.set(flowId, (dropped.get(flowId) ?? 0) + 1);
        record(d, "rate_limited", `max_runs_per_hour=${cap} reached`, evaluation.results as unknown[]);
        continue;
      }
      counts.set(flowId, used + 1);
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
      this.#drops.add(flowId, n);
      const flow = decisions.find((d) => d.flow.id === flowId)?.flow;
      if (!flow) continue;
      const cap = flow.definition.settings.max_runs_per_hour;
      const total = this.#drops.total(flowId);
      if (total >= cap * this.#opts.runawayFactor && !paused.includes(flowId)) {
        const reason = `auto-paused: ${total} matching events dropped in the last hour by max_runs_per_hour=${cap} (possible loop). Raise the limit or tighten the conditions, then resume.`;
        pauses.push({ flowId, reason });
        paused.push(flowId);
        this.#drops.clear(flowId);
        this.#log.warn({ flowId, dropped: total, cap }, "flow auto-paused (runaway)");
      }
    }
    return { runs, evaluations, stats, pauses };
  }

  // ---- streams ---------------------------------------------------------------

  async #consume(stream: Exclude<MatcherStream, "reverted">, flows: ActiveFlow[], paused: string[]): Promise<StreamReport> {
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
  async #blockCompleteBatch(stream: Exclude<MatcherStream, "reverted">, offset: number): Promise<ChainEvent[]> {
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

  async #polls(index: FlowIndex, paused: string[]): Promise<PollReport> {
    const now = Date.now();
    const due = index.poll.filter((f) => now - (this.#lastPoll.get(f.id) ?? 0) >= this.#opts.pollIntervalMs);
    if (due.length === 0) return { flows: 0, runs: 0, errors: 0 };
    const cursor = await this.store.confirmedCursor();
    if (cursor === null) return { flows: 0, runs: 0, errors: 0 };
    const block = await this.#reader.blockByNumber(cursor);
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
}
