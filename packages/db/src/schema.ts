import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  ABI_STATUSES,
  CHAIN_EVENT_STATUSES,
  CURSOR_STREAMS,
  EVALUATION_OUTCOMES,
  FLOW_STATUSES,
  PLANS,
  RUN_STATUSES,
  TEMPLATE_CATEGORIES,
  STEP_STATUSES,
  WATCH_SOURCES,
  type FlowDefinition,
  type TemplatePlaceholder,
} from "@ignitra/core";
import type { EncryptedEnvelope } from "@ignitra/core/server";

/**
 * Invariants are enforced by Postgres, not just application code:
 *   - one run per idempotency key            (runs_idempotency_key_key)
 *   - every run points at the exact flow version it executed (composite FK)
 *   - addresses stored in canonical lowercase form (CHECK)
 *   - statuses are closed sets; finished_at is set iff the status is final
 * All timestamps are timestamptz (stored as UTC).
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(", ")})`);

const OPEN_RUN_STATUSES = ["queued", "running"] as const;
const OPEN_STEP_STATUSES = ["pending", "running"] as const;

// ---------------------------------------------------------------------------
// users — one row per wallet (SIWE in Phase 5)
// ---------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    plan: text("plan", { enum: PLANS }).notNull().default("free"),
    timezone: text("timezone").notNull().default("Asia/Jakarta"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("users_address_key").on(t.address),
    check("users_address_canonical", sql`address ~ '^0x[0-9a-f]{40}$'`),
    check("users_plan_valid", inList("plan", PLANS)),
  ],
);

// ---------------------------------------------------------------------------
// flows — mutable header; the definition lives in immutable flow_versions
// ---------------------------------------------------------------------------
export const flows = pgTable(
  "flows",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status", { enum: FLOW_STATUSES }).notNull().default("paused"),
    /** Why the flow is paused/disabled (e.g. auto-paused after repeated failures). */
    statusReason: text("status_reason"),
    currentVersion: integer("current_version").notNull(),
    /** Last transition to active. Events from blocks before it never trigger the flow. */
    activatedAt: ts("activated_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("flows_owner_idx").on(t.ownerId),
    index("flows_status_idx").on(t.status),
    check("flows_status_valid", inList("status", FLOW_STATUSES)),
    check("flows_name_length", sql`char_length(name) between 1 and 120`),
    check("flows_current_version_positive", sql`current_version >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// flow_versions — append-only snapshots; runs reference (flow_id, version)
// ---------------------------------------------------------------------------
export const flowVersions = pgTable(
  "flow_versions",
  {
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<FlowDefinition>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "flow_versions_pkey", columns: [t.flowId, t.version] }),
    check("flow_versions_version_positive", sql`version >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// connections — credentials for external services; secret is an envelope
// ---------------------------------------------------------------------------
export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    label: text("label").notNull(),
    /** Encrypted with context `connection:<id>`. Never returned to clients. */
    secretEnc: jsonb("secret_enc").$type<EncryptedEnvelope>().notNull(),
    /** Non-secret, client-visible details (e.g. webhook host, channel name). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("connections_owner_idx").on(t.ownerId),
    check("connections_label_length", sql`char_length(label) between 1 and 120`),
  ],
);

// ---------------------------------------------------------------------------
// runs — one execution of one flow version for one trigger event
// ---------------------------------------------------------------------------
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    flowVersion: integer("flow_version").notNull(),
    /** `chain_id:tx_hash:log_index:flow_id` for chain events; unique across all runs. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** TEST runs come from "Test flow" with sample data and are always labelled. */
    isTest: boolean("is_test").notNull().default(false),
    triggerType: text("trigger_type").notNull(),
    /** Evidence: tx hash, block, log index, decoded args, enrichment. */
    triggerEvent: jsonb("trigger_event").$type<Record<string, unknown>>().notNull(),
    /** Per-condition pass/fail with actual values. */
    conditionsResult: jsonb("conditions_result").$type<unknown[]>().notNull().default([]),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("queued"),
    statusReason: text("status_reason"),
    /** chain_events row that triggered the run (log triggers). No FK: events may be pruned. */
    chainEventId: bigint("chain_event_id", { mode: "number" }),
    /** Set when the triggering event was reorged out (fast mode / deep reorg). */
    revertedAt: ts("reverted_at"),
    revertReason: text("revert_reason"),
    // ---- execution queue (Phase 4) ----
    /** Earliest time a worker may (re)claim the run; null = now. Set when a step backs off. */
    nextAttemptAt: ts("next_attempt_at"),
    /** Times a worker picked the run up. */
    attempts: integer("attempts").notNull().default(0),
    /** Worker holding the run while running, and until when (expired = reclaimable after a crash). */
    lockedBy: text("locked_by"),
    leaseUntil: ts("lease_until"),
    /** `run.reverted` notices sent to webhooks after a delivered run's event was reorged out. */
    revertNotice: jsonb("revert_notice").$type<Record<string, unknown>>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    foreignKey({
      name: "runs_flow_version_fkey",
      columns: [t.flowId, t.flowVersion],
      foreignColumns: [flowVersions.flowId, flowVersions.version],
    }).onDelete("cascade"),
    uniqueIndex("runs_idempotency_key_key").on(t.idempotencyKey),
    index("runs_flow_created_idx").on(t.flowId, t.createdAt.desc()),
    index("runs_chain_event_idx").on(t.chainEventId),
    index("runs_claim_idx").on(t.nextAttemptAt, t.createdAt).where(sql`status = 'queued'`),
    index("runs_lease_idx").on(t.leaseUntil).where(sql`status = 'running'`),
    index("runs_open_idx")
      .on(t.status, t.createdAt)
      .where(inList("status", OPEN_RUN_STATUSES)),
    check("runs_status_valid", inList("status", RUN_STATUSES)),
    check("runs_finished_iff_final", sql`(finished_at is null) = (${inList("status", OPEN_RUN_STATUSES)})`),
  ],
);

// ---------------------------------------------------------------------------
// run_steps — one row per action in a run (attempts counted, not duplicated)
// ---------------------------------------------------------------------------
export const runSteps = pgTable(
  "run_steps",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    position: integer("position").notNull(),
    actionType: text("action_type").notNull(),
    status: text("status", { enum: STEP_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    /** Redacted request/response summaries — never raw secrets. */
    request: jsonb("request").$type<Record<string, unknown>>(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    /** Exposed to later steps as {{steps.<step_id>.*}}. */
    output: jsonb("output"),
    error: text("error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    primaryKey({ name: "run_steps_pkey", columns: [t.runId, t.stepId] }),
    uniqueIndex("run_steps_run_position_key").on(t.runId, t.position),
    check("run_steps_status_valid", inList("status", STEP_STATUSES)),
    check("run_steps_attempts_nonneg", sql`attempts >= 0`),
    check("run_steps_position_nonneg", sql`position >= 0`),
    check("run_steps_finished_iff_final", sql`(finished_at is null) = (${inList("status", OPEN_STEP_STATUSES)})`),
  ],
);

// ===========================================================================
// Chain ingestion (Phase 2)
// ===========================================================================

const HEX32 = "'^0x[0-9a-f]{64}$'";

/** Consumption order for the matcher. Assigned when an event becomes confirmed / reverted. */
export const chainEventsConfirmedSeq = pgSequence("chain_events_confirmed_seq");
export const chainEventsRevertedSeq = pgSequence("chain_events_reverted_seq");
const ADDR = "'^0x[0-9a-f]{40}$'";

// ---------------------------------------------------------------------------
// leases — single-writer election for long-running loops (listener, later the
// scheduler). Every write the holder makes re-checks the lease (fencing).
// ---------------------------------------------------------------------------
export const leases = pgTable("leases", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: ts("expires_at").notNull(),
  acquiredAt: ts("acquired_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// watches — what the listener fetches logs for. Derived from active flows
// (Phase 3) or added manually. topic0 NULL = every event of the address.
// ---------------------------------------------------------------------------
export const watches = pgTable(
  "watches",
  {
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    topic0: text("topic0"),
    /** Also ingest at chain head (pending) for fast-mode flows. */
    fast: boolean("fast").notNull().default(false),
    source: text("source", { enum: WATCH_SOURCES }).notNull(),
    flowId: text("flow_id").references(() => flows.id, { onDelete: "cascade" }),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("watches_identity_key").on(t.chainId, t.address, t.topic0, t.flowId).nullsNotDistinct(),
    index("watches_chain_idx").on(t.chainId),
    check("watches_address_canonical", sql.raw(`address ~ ${ADDR}`)),
    check("watches_topic0_format", sql.raw(`topic0 is null or topic0 ~ ${HEX32}`)),
    check("watches_source_valid", inList("source", WATCH_SOURCES)),
    check("watches_flow_iff_source_flow", sql`(source = 'flow') = (flow_id is not null)`),
  ],
);

// ---------------------------------------------------------------------------
// chain_cursors — resumable sync checkpoints, one per stream.
// `block_number` is the last block FULLY processed (inclusive).
// ---------------------------------------------------------------------------
export const chainCursors = pgTable(
  "chain_cursors",
  {
    chainId: integer("chain_id").notNull(),
    stream: text("stream", { enum: CURSOR_STREAMS }).notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    /** Hash of `block_number` when known — used to detect reorgs below the cursor. */
    blockHash: text("block_hash"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chain_cursors_pkey", columns: [t.chainId, t.stream] }),
    check("chain_cursors_stream_valid", inList("stream", CURSOR_STREAMS)),
    check("chain_cursors_block_nonneg", sql`block_number >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// chain_events — normalized logs for watched contracts. Raw topics/data are
// always kept so events can be re-decoded once an ABI becomes available.
// Identity is (chain, block_hash, log_index): a tx re-included after a reorg
// lands in a different block and is a different row.
// ---------------------------------------------------------------------------
export const chainEvents = pgTable(
  "chain_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    chainId: integer("chain_id").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockHash: text("block_hash").notNull(),
    blockTimestamp: ts("block_timestamp"),
    txHash: text("tx_hash").notNull(),
    txIndex: integer("tx_index").notNull(),
    logIndex: integer("log_index").notNull(),
    address: text("address").notNull(),
    topic0: text("topic0"),
    topics: jsonb("topics").$type<string[]>().notNull(),
    data: text("data").notNull(),
    eventName: text("event_name"),
    eventSignature: text("event_signature"),
    args: jsonb("args").$type<Record<string, unknown>>(),
    abiSource: text("abi_source"),
    status: text("status", { enum: CHAIN_EVENT_STATUSES }).notNull(),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    confirmedAt: ts("confirmed_at"),
    revertedAt: ts("reverted_at"),
    revertReason: text("revert_reason"),
    /**
     * Matcher stream positions. Single writer (the listener lease) means
     * commit order equals sequence order, so a consumer cursor never skips.
     */
    confirmedSeq: bigint("confirmed_seq", { mode: "number" }),
    revertedSeq: bigint("reverted_seq", { mode: "number" }),
  },
  (t) => [
    unique("chain_events_identity_key").on(t.chainId, t.blockHash, t.logIndex),
    uniqueIndex("chain_events_confirmed_seq_key").on(t.confirmedSeq),
    uniqueIndex("chain_events_reverted_seq_key").on(t.revertedSeq),
    index("chain_events_status_block_idx").on(t.chainId, t.status, t.blockNumber),
    index("chain_events_address_block_idx").on(t.chainId, t.address, t.blockNumber),
    index("chain_events_tx_idx").on(t.txHash),
    check("chain_events_status_valid", inList("status", CHAIN_EVENT_STATUSES)),
    check("chain_events_confirmed_has_ts", sql`status <> 'confirmed' or confirmed_at is not null`),
    check("chain_events_reverted_has_ts", sql`status <> 'reverted' or reverted_at is not null`),
    check("chain_events_address_canonical", sql.raw(`address ~ ${ADDR}`)),
    check("chain_events_hashes_canonical", sql.raw(`block_hash ~ ${HEX32} and tx_hash ~ ${HEX32}`)),
  ],
);

// ---------------------------------------------------------------------------
// chain_sync_status — listener heartbeat, read by /health endpoints.
// ---------------------------------------------------------------------------
export const chainSyncStatus = pgTable("chain_sync_status", {
  chainId: integer("chain_id").primaryKey(),
  owner: text("owner").notNull(),
  headBlock: bigint("head_block", { mode: "number" }).notNull(),
  confirmedHead: bigint("confirmed_head", { mode: "number" }).notNull(),
  confirmedCursor: bigint("confirmed_cursor", { mode: "number" }).notNull(),
  pendingCursor: bigint("pending_cursor", { mode: "number" }),
  watchCount: integer("watch_count").notNull(),
  rpc: jsonb("rpc").$type<Record<string, unknown>>().notNull(),
  lastError: text("last_error"),
  lastDeepReorgAt: ts("last_deep_reorg_at"),
  lastTickAt: ts("last_tick_at").notNull(),
});

// ---------------------------------------------------------------------------
// contract_abis — explorer ABI cache (incl. negative results) per address.
// For EIP-1967 proxies the implementation ABI is merged in.
// ---------------------------------------------------------------------------
export const contractAbis = pgTable(
  "contract_abis",
  {
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    status: text("status", { enum: ABI_STATUSES }).notNull(),
    abi: jsonb("abi").$type<unknown[]>(),
    implementation: text("implementation"),
    source: text("source").notNull(),
    error: text("error"),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "contract_abis_pkey", columns: [t.chainId, t.address] }),
    check("contract_abis_status_valid", inList("status", ABI_STATUSES)),
    check("contract_abis_verified_has_abi", sql`status <> 'verified' or abi is not null`),
    check("contract_abis_address_canonical", sql.raw(`address ~ ${ADDR}`)),
  ],
);

// ===========================================================================
// Matching (Phase 3)
// ===========================================================================

// consumer_offsets — resumable positions of stream consumers (matcher streams).
export const consumerOffsets = pgTable("consumer_offsets", {
  name: text("name").primaryKey(),
  position: bigint("position", { mode: "number" }).notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// flow_evaluations — sampled, bounded log of matches that did NOT become runs.
export const flowEvaluations = pgTable(
  "flow_evaluations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    flowVersion: integer("flow_version").notNull(),
    /** Same key a run would have had — at most one evaluation per (event, flow). */
    idempotencyKey: text("idempotency_key").notNull(),
    outcome: text("outcome", { enum: EVALUATION_OUTCOMES }).notNull(),
    reason: text("reason"),
    triggerEvent: jsonb("trigger_event").$type<Record<string, unknown>>().notNull(),
    conditionsResult: jsonb("conditions_result").$type<unknown[]>().notNull().default([]),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("flow_evaluations_key").on(t.idempotencyKey),
    index("flow_evaluations_flow_idx").on(t.flowId, t.id.desc()),
    check("flow_evaluations_outcome_valid", inList("outcome", EVALUATION_OUTCOMES)),
  ],
);

// flow_stats — exact counters (evaluations are sampled; these are not).
export const flowStats = pgTable("flow_stats", {
  flowId: text("flow_id")
    .primaryKey()
    .references(() => flows.id, { onDelete: "cascade" }),
  matched: bigint("matched", { mode: "number" }).notNull().default(0),
  runs: bigint("runs", { mode: "number" }).notNull().default(0),
  conditionsFailed: bigint("conditions_failed", { mode: "number" }).notNull().default(0),
  rateLimited: bigint("rate_limited", { mode: "number" }).notNull().default(0),
  undetermined: bigint("undetermined", { mode: "number" }).notNull().default(0),
  /** Matches dropped because the owner's plan had no runs left this month (Phase 5). */
  planLimited: bigint("plan_limited", { mode: "number" }).notNull().default(0),
  /** Scheduled times that passed while the scheduler was down (Phase 5). */
  missed: bigint("missed", { mode: "number" }).notNull().default(0),
  lastMatchedAt: ts("last_matched_at"),
  lastRunAt: ts("last_run_at"),
  // ---- execution outcomes (Phase 4) ----
  runsSucceeded: bigint("runs_succeeded", { mode: "number" }).notNull().default(0),
  runsPartial: bigint("runs_partial", { mode: "number" }).notNull().default(0),
  runsFailed: bigint("runs_failed", { mode: "number" }).notNull().default(0),
  runsSkipped: bigint("runs_skipped", { mode: "number" }).notNull().default(0),
  /** Failed runs in a row; reset by any succeeded/partial run. Drives auto-pause. */
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  lastFinishedAt: ts("last_finished_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// trigger_state — persistent state of polling triggers (balance side, deployer nonce).
export const triggerState = pgTable("trigger_state", {
  flowId: text("flow_id")
    .primaryKey()
    .references(() => flows.id, { onDelete: "cascade" }),
  /** State belongs to one flow version; a new version starts fresh. */
  flowVersion: integer("flow_version").notNull(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ===========================================================================
// Delivery (Phase 4)
// ===========================================================================

// push_subscriptions — Web Push endpoints of a user's browsers / installed PWA.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSuccessAt: ts("last_success_at"),
    failureCount: integer("failure_count").notNull().default(0),
    /** Set when the push service says the subscription is gone (404/410). */
    disabledAt: ts("disabled_at"),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_key").on(t.endpoint),
    index("push_subscriptions_user_idx").on(t.userId),
    check("push_subscriptions_https", sql`endpoint like 'https://%'`),
  ],
);

// owner_notifications — system notices to a flow owner (auto-pause, …): inbox + push.
export const ownerNotifications = pgTable(
  "owner_notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flowId: text("flow_id").references(() => flows.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** Push delivery attempt finished (any outcome). */
    pushedAt: ts("pushed_at"),
  },
  (t) => [index("owner_notifications_user_idx").on(t.userId, t.createdAt.desc()), index("owner_notifications_unpushed_idx").on(t.createdAt).where(sql`pushed_at is null`)],
);

// ===========================================================================
// Accounts, metering and inbound webhooks (Phase 5)
// ===========================================================================

// auth_nonces — single-use SIWE nonces. Consumed by DELETE … RETURNING, so a
// nonce can be redeemed at most once even with concurrent verify requests.
export const authNonces = pgTable(
  "auth_nonces",
  {
    nonce: text("nonce").primaryKey(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("auth_nonces_expires_idx").on(t.expiresAt), check("auth_nonces_format", sql`nonce ~ '^[A-Za-z0-9]{8,64}$'`)],
);

// sessions — signed-in wallets. Only the SHA-256 of the bearer token is stored.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** Chain id of the SIWE message the session was created from. */
    chainId: integer("chain_id").notNull(),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
    check("sessions_token_hash_format", sql`token_hash ~ '^[0-9a-f]{64}$'`),
  ],
);

// usage_monthly — exact run metering per user and calendar month (UTC).
// Incremented in the same transaction that creates the runs.
export const usageMonthly = pgTable(
  "usage_monthly",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'YYYY-MM' (UTC). */
    period: text("period").notNull(),
    runs: bigint("runs", { mode: "number" }).notNull().default(0),
    /** Matches dropped because the plan's monthly runs were used up. */
    planLimited: bigint("plan_limited", { mode: "number" }).notNull().default(0),
    /** The owner was told the quota ran out (once per period). */
    limitNotifiedAt: ts("limit_notified_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "usage_monthly_pkey", columns: [t.userId, t.period] }),
    check("usage_monthly_period_format", sql`period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("usage_monthly_nonneg", sql`runs >= 0 and plan_limited >= 0`),
  ],
);

// inbound_hooks — per-flow salt of the INBOUND_WEBHOOK URL. The URL token is
// HMAC(master, flow_id:salt): nothing secret is stored; rotating = new salt.
export const inboundHooks = pgTable("inbound_hooks", {
  flowId: text("flow_id")
    .primaryKey()
    .references(() => flows.id, { onDelete: "cascade" }),
  salt: text("salt").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  rotatedAt: ts("rotated_at"),
});

// inbound_events — accepted INBOUND_WEBHOOK requests; the matcher consumes them in id order.
export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    requestId: text("request_id").notNull(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    /** Idempotency-Key header, else the request id: one event per (flow, key). */
    dedupeKey: text("dedupe_key").notNull(),
    contentType: text("content_type"),
    body: jsonb("body").$type<unknown>().notNull(),
    query: jsonb("query").$type<Record<string, string>>().notNull().default({}),
    /** Allow-listed, non-sensitive request headers only. */
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    bytes: integer("bytes").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbound_events_dedupe_key").on(t.flowId, t.dedupeKey),
    uniqueIndex("inbound_events_request_key").on(t.requestId),
    index("inbound_events_received_idx").on(t.receivedAt),
    /** Per-flow daily intake cap. */
    index("inbound_events_flow_received_idx").on(t.flowId, t.receivedAt),
    check("inbound_events_dedupe_length", sql`char_length(dedupe_key) between 1 and 200`),
  ],
);

// ===========================================================================
// Templates (Phase 7)
// ===========================================================================

/**
 * templates — flows users publish to share (official templates live in code).
 * The definition carries `{ "$param": key }` placeholders; private destinations
 * (connections, URLs, spreadsheets) are always placeholders without defaults.
 */
export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    description: text("description").notNull().default(""),
    category: text("category", { enum: TEMPLATE_CATEGORIES }).notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    placeholders: jsonb("placeholders").$type<TemplatePlaceholder[]>().notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    /** unlisted = anyone with the link; public = also listed in the gallery ("Community"). */
    visibility: text("visibility", { enum: ["unlisted", "public"] }).notNull().default("unlisted"),
    /** Operator moderation: hidden templates answer 404. */
    hiddenAt: ts("hidden_at"),
    sourceFlowId: text("source_flow_id").references(() => flows.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("templates_slug_key").on(t.slug),
    index("templates_owner_idx").on(t.ownerId),
    index("templates_public_idx").on(t.createdAt).where(sql`visibility = 'public' and hidden_at is null`),
    check("templates_slug_format", sql`slug ~ '^[a-z0-9-]{3,80}$'`),
    check("templates_category_valid", inList("category", TEMPLATE_CATEGORIES)),
    check("templates_visibility_valid", sql`visibility in ('unlisted', 'public')`),
  ],
);

/** template_stats — "used N times", for official (code) and user (DB) templates alike. */
export const templateStats = pgTable("template_stats", {
  slug: text("slug").primaryKey(),
  uses: bigint("uses", { mode: "number" }).notNull().default(0),
  lastUsedAt: ts("last_used_at"),
});

// ---------------------------------------------------------------------------
// api_keys — long-lived credentials for the public API and the SDK (Phase 8).
// The secret (`igk_…`) is shown once; only its SHA-256 and a display prefix are kept.
// ---------------------------------------------------------------------------
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The first characters of the key, for recognising it in lists (e.g. `igk_Ab12Cd34`). */
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    ratePerMinute: integer("rate_per_minute").notNull().default(600),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("api_keys_token_hash_key").on(t.tokenHash),
    index("api_keys_user_idx").on(t.userId),
    check("api_keys_token_hash_format", sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check("api_keys_name_length", sql`char_length(name) between 1 and 80`),
    check("api_keys_rate", sql`rate_per_minute between 1 and 100000`),
  ],
);

// ---------------------------------------------------------------------------
// onchain_grants — scoped, revocable permissions a user's Safe gives an IGNITRA session key
// (Zodiac Roles v2). The session key's private key is encrypted and wiped on revoke / expiry;
// the user's own keys are never involved.
// ---------------------------------------------------------------------------
export const ONCHAIN_GRANT_STATUSES = ["pending", "active", "revoked", "expired"] as const;
export const onchainGrants = pgTable(
  "onchain_grants",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    label: text("label").notNull(),
    safeAddress: text("safe_address").notNull(),
    rolesAddress: text("roles_address").notNull(),
    roleKey: text("role_key").notNull(),
    sessionKeyAddress: text("session_key_address").notNull(),
    /** Encrypted session private key; null once revoked or expired (the key no longer exists). */
    sessionKeyEnc: jsonb("session_key_enc").$type<Record<string, unknown>>(),
    /** Targets, functions, value / amount limits and expiry, as granted. */
    scope: jsonb("scope").$type<Record<string, unknown>>().notNull(),
    /**
     * The MANDATE policy every action of the grant must pass. Never silently dropped: deleting a
     * connection a grant still names fails ("no action", checked at the end of the statement, so
     * deleting the whole account still cascades). Terminal grants release it first.
     */
    mandateConnectionId: text("mandate_connection_id").references(() => connections.id, { onDelete: "no action" }),
    status: text("status", { enum: ONCHAIN_GRANT_STATUSES }).notNull().default("pending"),
    grantTxHash: text("grant_tx_hash"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    activatedAt: ts("activated_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    index("onchain_grants_owner_idx").on(t.ownerId),
    uniqueIndex("onchain_grants_role_key").on(t.rolesAddress, t.roleKey),
    check("onchain_grants_status", sql`status in ('pending', 'active', 'revoked', 'expired')`),
    check("onchain_grants_addresses", sql`safe_address ~ '^0x[0-9a-f]{40}$' and roles_address ~ '^0x[0-9a-f]{40}$' and session_key_address ~ '^0x[0-9a-f]{40}$'`),
    check("onchain_grants_key_wiped", sql`status in ('pending', 'active') or session_key_enc is null`),
  ],
);

// ---------------------------------------------------------------------------
// onchain_actions — every ONCHAIN_TX attempt, recorded before it is sent (exactly-once intent):
// unique on the step's idempotency key; the signed transaction is stored before broadcast so a
// retry re-sends that same transaction instead of signing a second one.
// ---------------------------------------------------------------------------
export const ONCHAIN_ACTION_STATUSES = ["simulated", "denied", "signed", "sent", "confirmed", "reverted", "failed"] as const;
export const onchainActions = pgTable(
  "onchain_actions",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => onchainGrants.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flowId: text("flow_id"),
    runId: text("run_id"),
    stepId: text("step_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    isTest: boolean("is_test").notNull().default(false),
    toAddress: text("to_address").notNull(),
    functionSignature: text("function_signature").notNull(),
    args: jsonb("args").$type<unknown[]>().notNull().default([]),
    valueWei: text("value_wei").notNull().default("0"),
    status: text("status", { enum: ONCHAIN_ACTION_STATUSES }).notNull(),
    mandate: jsonb("mandate").$type<Record<string, unknown>>(),
    nonce: integer("nonce"),
    rawTx: text("raw_tx"),
    txHash: text("tx_hash"),
    blockNumber: bigint("block_number", { mode: "number" }),
    gasUsed: text("gas_used"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("onchain_actions_idempotency_key").on(t.idempotencyKey),
    index("onchain_actions_grant_idx").on(t.grantId, t.createdAt.desc()),
    index("onchain_actions_owner_idx").on(t.ownerId, t.createdAt.desc()),
    check("onchain_actions_status", sql`status in ('simulated', 'denied', 'signed', 'sent', 'confirmed', 'reverted', 'failed')`),
    check("onchain_actions_value", sql`value_wei ~ '^[0-9]{1,78}$'`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Flow = typeof flows.$inferSelect;
export type NewFlow = typeof flows.$inferInsert;
export type FlowVersion = typeof flowVersions.$inferSelect;
export type NewFlowVersion = typeof flowVersions.$inferInsert;
export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunStep = typeof runSteps.$inferSelect;
export type NewRunStep = typeof runSteps.$inferInsert;
export type Watch = typeof watches.$inferSelect;
export type NewWatch = typeof watches.$inferInsert;
export type ChainCursor = typeof chainCursors.$inferSelect;
export type ChainEvent = typeof chainEvents.$inferSelect;
export type NewChainEvent = typeof chainEvents.$inferInsert;
export type ChainSyncStatus = typeof chainSyncStatus.$inferSelect;
export type ContractAbi = typeof contractAbis.$inferSelect;
export type FlowEvaluation = typeof flowEvaluations.$inferSelect;
export type FlowStats = typeof flowStats.$inferSelect;
// ---------------------------------------------------------------------------
// audit_log — who changed what in an account (Phase 9): flows, connections, API keys,
// onchain grants, templates, account settings; also what the operator (CLI) and the system
// (auto-pause) did. Never holds secrets: names, types, ids and which settings changed.
// ---------------------------------------------------------------------------
export const AUDIT_ACTORS = ["session", "api_key", "operator", "system"] as const;
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actor: text("actor", { enum: AUDIT_ACTORS }).notNull(),
    /** The API key that acted (key_…); null for wallet sessions, the operator and the system. */
    actorId: text("actor_id"),
    /** <target>.<verb>, e.g. flow.paused. */
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_owner_idx").on(t.ownerId, t.id),
    check("audit_log_actor", sql`actor in ('session', 'api_key', 'operator', 'system')`),
    check("audit_log_action_format", sql`action ~ '^[a-z_]+[.][a-z_]+$'`),
  ],
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type OwnerNotification = typeof ownerNotifications.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type UsageMonthly = typeof usageMonthly.$inferSelect;
export type InboundEvent = typeof inboundEvents.$inferSelect;
export type TemplateRow = typeof templates.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type OnchainGrantRow = typeof onchainGrants.$inferSelect;
export type OnchainActionRow = typeof onchainActions.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewInboundEvent = typeof inboundEvents.$inferInsert;
