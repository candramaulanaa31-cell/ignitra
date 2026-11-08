/**
 * The shapes the IGNITRA API sends: snake_case, ISO-8601 UTC timestamps, lowercase hex
 * addresses. A test in the API package runs this SDK against the real server, so these
 * cannot drift from what it answers.
 */

export type Plan = "free" | "builder" | "team";
export type FlowStatus = "active" | "paused" | "disabled";
export type FlowMode = "confirmed" | "fast";
export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "skipped";
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type EvaluationOutcome = "conditions_failed" | "rate_limited" | "plan_limited" | "undetermined" | "missed";
export type ConditionOperator = "==" | "!=" | ">" | ">=" | "<" | "<=" | "IN" | "NOT_IN" | "CONTAINS" | "EXISTS";

// ── Flow definitions ────────────────────────────────────────────────────────

export interface TriggerSpec {
  type: string;
  params: Record<string, unknown>;
}

export interface ConditionLeaf {
  field: string;
  op: ConditionOperator;
  value?: unknown;
}

export type ConditionNode = ConditionLeaf | ConditionGroup;
export type ConditionGroup = { all: ConditionNode[] } | { any: ConditionNode[] };

export interface ActionStep {
  /** Lowercase snake_case, unique in the flow; later steps read `{{steps.<step_id>.…}}`. */
  step_id: string;
  type: string;
  params: Record<string, unknown>;
}

/** An action as you may write it: the SDK names steps that have no step_id. */
export type ActionStepInput = Omit<ActionStep, "step_id"> & { step_id?: string };

export interface FlowSettings {
  mode: FlowMode;
  max_runs_per_hour: number;
  /** ONCHAIN_TX steps need this explicit opt-in (default false). */
  onchain?: boolean;
}

export interface FlowDefinition {
  trigger: TriggerSpec;
  conditions?: ConditionGroup;
  actions: ActionStep[];
  settings: FlowSettings;
}

export interface FlowDefinitionInput {
  trigger: TriggerSpec;
  conditions?: ConditionGroup;
  actions: ActionStepInput[];
  settings?: Partial<FlowSettings>;
}

// ── Flows, runs, evaluations ────────────────────────────────────────────────

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

export interface Flow {
  id: string;
  name: string;
  status: FlowStatus;
  status_reason: string | null;
  version: number;
  trigger_type: string;
  mode: FlowMode;
  actions: string[];
  activated_at: string | null;
  created_at: string;
  updated_at: string;
  stats: FlowStats;
  /** INBOUND_WEBHOOK flows: the URL to POST to (null when the server cannot sign hook URLs). */
  hook_url?: string | null;
}

export interface FlowDetail extends Flow {
  definition: FlowDefinition;
}

export interface ValidatedFlow {
  definition: FlowDefinition;
  trigger_fields: Array<{ path: string; type: string; description: string; nullable?: boolean }>;
}

export interface RunStep {
  step_id: string;
  position: number;
  action_type: string;
  status: StepStatus;
  attempts: number;
  http_status: number | null;
  duration_ms: number | null;
  request: unknown;
  response: unknown;
  output: unknown;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface Run {
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
  summary: string | null;
  tx_hash: string | null;
}

export interface RunDetail extends Run {
  trigger_event: Record<string, unknown>;
  conditions_result: unknown[];
  revert_notice: unknown;
  steps: RunStep[];
}

export interface Evaluation {
  id: string;
  flow_version: number;
  outcome: EvaluationOutcome;
  reason: string | null;
  trigger_event: Record<string, unknown>;
  conditions_result: unknown[];
  created_at: string;
}

export interface Page<T> {
  data: T[];
  /** Pass as `before` to get the next (older) page; null on the last one. */
  next_before: string | null;
}

export interface TestRunResult {
  run: Run;
  conditions_passed: boolean;
  sample: { kind: string; note: string };
}

// ── Connections ─────────────────────────────────────────────────────────────

export type ConnectionType = "telegram" | "webhook" | "email" | "google" | "http" | "vigil" | "mandate" | "discord";

export interface Connection {
  id: string;
  type: ConnectionType;
  label: string;
  /** Safe facts only (e.g. a chat title or a host); secrets never leave the server. */
  metadata: Record<string, unknown>;
  created_at: string;
}

export type ConnectionInput =
  | { type: "telegram"; label?: string; bot_token: string; chat_id: string | number; thread_id?: number }
  | { type: "webhook"; label?: string; url: string }
  | { type: "email"; label?: string; address: string }
  | { type: "http"; label?: string; host: string; headers: Array<{ name: string; value: string }>; sign?: boolean }
  /** With `api_key`, IGNITRA registers its receiver in VIGIL; without, see `connections.setVigilSecret`. */
  | { type: "vigil"; label?: string; api_key?: string; api_url?: string }
  | { type: "mandate"; label?: string; url: string };

export interface CreatedConnection {
  connection: Connection;
  /** Webhook, signed HTTP and MANDATE connections: the signing secret, returned only here. */
  signingSecret: string | null;
  /** Email connections: a code was sent to the address; verify it with `connections.verify`. */
  verification: "sent" | null;
  /** VIGIL connections: the URL VIGIL delivers alerts to. */
  receiverUrl: string | null;
}

// ── Templates ───────────────────────────────────────────────────────────────

export interface TemplatePlaceholder {
  key: string;
  label: string;
  type: "address" | "decimal" | "number" | "text" | "connection" | "cron" | "url" | "spreadsheet" | "select";
  help?: string;
  default?: unknown;
  optional?: boolean;
  connectionType?: ConnectionType;
  options?: Array<{ value: string; label: string }>;
  example?: string;
}

export interface TemplateCard {
  slug: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  official: boolean;
  visibility: "official" | "public" | "unlisted";
  author: string | null;
  trigger_type: string;
  action_types: string[];
  min_plan: Plan;
  uses: number;
  created_at: string | null;
}

export interface TemplateDetail extends TemplateCard {
  description: string;
  placeholders: TemplatePlaceholder[];
  definition: unknown;
  outline: Array<{ kind: "WHEN" | "IF" | "AND" | "OR" | "THEN"; text: string }>;
  share_text: string | null;
  url: string;
}

export interface PublishTemplateInput {
  flow_id: string;
  name: string;
  summary: string;
  description?: string;
  category: string;
  tags?: string[];
  visibility?: "unlisted" | "public";
}

// ── Account and catalogs ────────────────────────────────────────────────────

export interface User {
  id: string;
  address: string;
  plan: Plan;
  timezone: string;
  created_at: string;
  limits: { active_flows: number | null; runs_per_month: number; overage: boolean; min_schedule_minutes: number };
}

export interface Usage {
  plan: Plan;
  period: string;
  resets_at: string;
  runs: { used: number; included: number; remaining: number; overage: number; plan_limited: number };
  active_flows: { used: number; limit: number | null };
}

export interface CatalogField {
  path: string;
  type: string;
  description: string;
  nullable?: boolean;
}

export interface TriggerInfo {
  type: string;
  kind: "log" | "poll" | "schedule" | "inbound";
  source: string;
  label: string;
  description: string;
  supports_fast: boolean;
  min_plan: Plan;
  params_schema: unknown;
  fields: CatalogField[];
}

export interface ActionInfo {
  type: string;
  label: string;
  description: string;
  connection_type: string | null;
  connection_optional: boolean;
  min_plan: Plan;
  params_schema: unknown;
  output_fields: CatalogField[];
}

// ── Webhooks IGNITRA sends ──────────────────────────────────────────────────

export interface RunActionEvent {
  type: "run.action";
  run_id: string;
  flow_id: string;
  flow: { id: string; name: string; version: number };
  step_id: string;
  /** Identical on every retry of this step: deduplicate on it. */
  idempotency_key: string;
  run_idempotency_key: string;
  test: boolean;
  attempt: number;
  trigger: Record<string, unknown>;
  sent_at: string;
}

export interface RunRevertedEvent {
  type: "run.reverted";
  run_id: string;
  flow_id: string;
  step_id: string;
  idempotency_key: string;
  reason: "reorg" | "deep_reorg" | (string & {});
  reverted_at: string | null;
  trigger: { tx_hash: string | null; block_number: number | null };
  sent_at: string;
}

/** New event types may be added: ignore a `type` you do not know rather than fail. */
export type WebhookEvent = RunActionEvent | RunRevertedEvent;
