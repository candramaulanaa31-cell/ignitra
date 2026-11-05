import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  FLOW_STATUSES,
  PLANS,
  RUN_STATUSES,
  STEP_STATUSES,
  type FlowDefinition,
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
