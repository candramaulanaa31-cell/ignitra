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
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const ACTION_TYPES = [
  "WEBHOOK",
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

export const CONNECTION_TYPES = ["discord", "webhook", "google", "email"] as const;
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
