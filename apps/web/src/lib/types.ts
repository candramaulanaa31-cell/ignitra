import type { FieldSpec, FlowDefinitionInput } from "@ignitra/core";

/** Shapes returned by the IGNITRA API (snake_case, ISO-8601 UTC timestamps). */

export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "skipped";
export type FlowStatus = "active" | "paused" | "disabled";

export interface Limits {
  active_flows: number | null;
  runs_per_month: number;
  overage: boolean;
  min_schedule_minutes: number;
}

export interface Usage {
  period: string;
  resets_at: string;
  runs: { used: number; included: number; remaining: number; overage: number; plan_limited: number };
  active_flows: { used: number; limit: number | null };
}

export interface Me {
  id: string;
  address: string;
  plan: "free" | "builder" | "team";
  timezone: string;
  created_at: string;
  limits: Limits;
  usage: Usage;
}

export interface FlowStats {
  matched: number;
  runs: number;
  runs_succeeded: number;
  runs_partial: number;
  runs_failed: number;
  runs_skipped: number;
  conditions_failed: number;
  rate_limited: number;
  plan_limited: number;
  undetermined: number;
  missed: number;
  consecutive_failures: number;
  last_matched_at: string | null;
  last_run_at: string | null;
  last_finished_at: string | null;
  last_error: string | null;
}

export interface FlowSummary {
  id: string;
  name: string;
  status: FlowStatus;
  status_reason: string | null;
  version: number;
  trigger_type: string;
  mode: "confirmed" | "fast";
  actions: string[];
  activated_at: string | null;
  created_at: string;
  updated_at: string;
  stats: FlowStats;
  hook_url?: string | null;
}

export interface StoredDefinition {
  trigger: { type: string; params: Record<string, unknown> };
  conditions?: FlowDefinitionInput["conditions"];
  actions: Array<{ step_id: string; type: string; params: Record<string, unknown> }>;
  settings: { mode: "confirmed" | "fast"; max_runs_per_hour: number; onchain?: boolean };
}

export interface FlowDetail extends FlowSummary {
  definition: StoredDefinition;
}

export interface ConditionResult {
  field: string;
  op: string;
  expected?: unknown;
  actual?: unknown;
  passed: boolean;
  error?: string;
}

export interface RunSummary {
  id: string;
  flow_id: string;
  flow_version: number;
  status: RunStatus;
  status_reason: string | null;
  test: boolean;
  trigger_type: string;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  next_attempt_at: string | null;
  reverted_at: string | null;
  revert_reason: string | null;
  /** One line describing the occurrence. */
  summary: string | null;
  tx_hash: string | null;
}

export interface RunStep {
  step_id: string;
  position: number;
  action_type: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  attempts: number;
  http_status: number | null;
  duration_ms: number | null;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  output: unknown;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunDetail extends RunSummary {
  trigger_event: Record<string, unknown>;
  conditions_result: ConditionResult[];
  revert_notice: Record<string, unknown> | null;
  steps: RunStep[];
}

export interface Evaluation {
  id: number;
  flow_version: number;
  outcome: "conditions_failed" | "rate_limited" | "plan_limited" | "undetermined" | "missed";
  reason: string | null;
  trigger_event: Record<string, unknown>;
  conditions_result: ConditionResult[];
  created_at: string;
}

export interface Connection {
  id: string;
  type: "telegram" | "webhook" | "email" | "google" | "http" | "discord" | "vigil" | "mandate";
  label: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface TriggerCatalogItem {
  type: string;
  kind: "log" | "poll" | "schedule" | "inbound";
  source: string;
  label: string;
  description: string;
  supports_fast: boolean;
  min_plan: "free" | "builder" | "team";
  params_schema: Record<string, unknown>;
  fields: FieldSpec[];
}

export interface ActionCatalogItem {
  type: string;
  label: string;
  description: string;
  connection_type: string | null;
  connection_optional: boolean;
  min_plan: "free" | "builder" | "team";
  params_schema: Record<string, unknown>;
  output_fields: FieldSpec[];
}

export interface AddressInfo {
  address: string;
  checksum: string;
  explorer_url: string;
  kind: "wallet" | "token" | "contract";
  is_contract: boolean;
  balance_wei?: string | null;
  code_bytes?: number;
  token: { symbol: string | null; name: string | null; decimals: number | null; total_supply: string | null } | null;
  abi: { status: string; source: string | null; implementation: string | null; events: string[]; functions: string[] } | null;
}

export interface Sample {
  kind: "event" | "state" | "time" | "request" | "custom";
  note: string;
  payload: Record<string, unknown>;
  conditions: { passed: boolean; results: ConditionResult[] } | null;
  scanned_blocks: number | null;
}

export interface CatalogFields {
  trigger: FieldSpec[];
  steps: Record<string, FieldSpec[]>;
  builtins: string[];
}

export interface Issue {
  path: string;
  message: string;
}

export interface OwnerNotification {
  id: string;
  kind: string;
  flow_id: string | null;
  message: string;
  created_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  rate_per_minute: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// ---- onchain grants (Safe + Zodiac Roles) ----

export interface ScopedFunctionView {
  signature: string;
  selector: string;
  inputs: string[];
  payable: boolean;
  amount: { arg: number; max_per_tx: string; max_per_day: string } | null;
}

export type GrantStatus = "pending" | "active" | "revoked" | "expired";

export interface Grant {
  id: string;
  label: string;
  status: GrantStatus;
  chain_id: number;
  safe: string;
  roles: string;
  role_key: string;
  session_key: string;
  scope: { targets: Array<{ address: string; functions: ScopedFunctionView[] }>; max_value_per_tx: string; max_value_per_day: string; expires_at: string };
  mandate_connection_id: string | null;
  grant_tx_hash: string | null;
  grant_tx_url: string | null;
  expires_at: string;
  created_at: string;
  activated_at: string | null;
  revoked_at: string | null;
}

export interface SafeCall {
  to: string;
  value: string;
  data: string;
  description: string;
}

/** A Safe transaction to approve, in every form an owner can use. */
export interface SafeApproval {
  calls: SafeCall[];
  safe_transaction?: { to: string; value: string; data: string; operation: number };
  /** 1-of-N owner: send it from the wallet as a normal transaction. */
  owner_transaction?: { from: string; to: string; value: string; data: string } | null;
  /** Safe{Wallet} Transaction Builder batch (import the JSON). */
  tx_builder?: unknown;
  note?: string;
}

export interface OnchainAction {
  id: string;
  grant_id: string;
  flow_id: string;
  run_id: string;
  step_id: string;
  test: boolean;
  to: string;
  function: string;
  args: unknown[];
  value: string;
  status: "simulated" | "denied" | "signed" | "sent" | "confirmed" | "reverted" | "failed";
  mandate: Record<string, unknown> | null;
  tx_hash: string | null;
  tx_url: string | null;
  block_number: number | null;
  gas_used: string | null;
  error: string | null;
  created_at: string;
}

export interface GrantDetail extends Grant {
  session_key_balance: string | null;
  approval: SafeApproval | null;
  actions: OnchainAction[];
}
