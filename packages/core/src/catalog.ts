/**
 * Closed vocabularies shared by the API, DB, runner and UI. Adding a value here
 * is a deliberate product change; implementations register against these ids.
 */

export const TRIGGER_TYPES = [
  "CONTRACT_EVENT",
  "TOKEN_TRANSFER",
  "NEW_HOLDER",
  "BALANCE_THRESHOLD",
  "CONTRACT_DEPLOYED",
  "STATE_CHANGE",
  "SCHEDULE",
  "INBOUND_WEBHOOK",
  "VIGIL_ALERT",
  "NEW_LAUNCH",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const ACTION_TYPES = [
  "WEBHOOK",
  "TELEGRAM",
  "DISCORD",
  "WEB_PUSH",
  "EMAIL",
  "GOOGLE_SHEETS",
  "HTTP_REQUEST",
  "X_POST",
  "CHAIN_READ",
  "ONCHAIN_TX",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const CONDITION_OPERATORS = [
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "IN",
  "NOT_IN",
  "CONTAINS",
  "EXISTS",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const CONNECTION_TYPES = ["telegram", "webhook", "discord", "google", "email", "http", "vigil", "mandate"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export const FLOW_STATUSES = ["active", "paused", "disabled"] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

/** `confirmed` = run only after the confirmation depth; `fast` = run at head, record reorgs. */
export const FLOW_MODES = ["confirmed", "fast"] as const;
export type FlowMode = (typeof FLOW_MODES)[number];

export const RUN_FINAL_STATUSES = ["succeeded", "partial", "failed", "skipped"] as const;
export const RUN_STATUSES = ["queued", "running", ...RUN_FINAL_STATUSES] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunFinalStatus = (typeof RUN_FINAL_STATUSES)[number];

export const STEP_STATUSES = ["pending", "running", "succeeded", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const PLANS = ["free", "builder", "team"] as const;
export type Plan = (typeof PLANS)[number];

// ---- Chain ingestion (Phase 2) -------------------------------------------

/** pending = seen at head (fast mode only); confirmed = canonical at confirmation depth; reverted = reorged out. */
export const CHAIN_EVENT_STATUSES = ["pending", "confirmed", "reverted"] as const;
export type ChainEventStatus = (typeof CHAIN_EVENT_STATUSES)[number];

export const CURSOR_STREAMS = ["confirmed", "pending"] as const;
export type CursorStream = (typeof CURSOR_STREAMS)[number];

/** flow = derived from an active flow's trigger (Phase 3); manual = operator-added (CLI). */
export const WATCH_SOURCES = ["flow", "manual"] as const;
export type WatchSource = (typeof WATCH_SOURCES)[number];

/** depth = head - N blocks; safe / finalized = the node's L1-backed block tags. */
export const CONFIRMATION_STRATEGIES = ["depth", "safe", "finalized"] as const;
export type ConfirmationStrategy = (typeof CONFIRMATION_STRATEGIES)[number];

export const ABI_STATUSES = ["verified", "unverified", "error"] as const;
export type AbiStatus = (typeof ABI_STATUSES)[number];

// ---- Matching (Phase 3) ----------------------------------------------------

/**
 * Why a matched event did NOT become a run. Recorded (sampled) in
 * flow_evaluations so users can answer "why didn't my flow run?".
 *   conditions_failed — conditions evaluated false (per-condition results kept)
 *   rate_limited      — over settings.max_runs_per_hour
 *   plan_limited      — the owner's plan has no runs left this month
 *   undetermined      — the trigger could not be decided (e.g. pruned historical state)
 *   missed            — scheduled times that passed while the scheduler was not running
 */
export const EVALUATION_OUTCOMES = ["conditions_failed", "rate_limited", "plan_limited", "undetermined", "missed"] as const;
export type EvaluationOutcome = (typeof EVALUATION_OUTCOMES)[number];
