import type { z } from "zod";
import type { NormalizedAddress } from "../address";
import type { ActionType, ConditionOperator, ConnectionType, TriggerType } from "../catalog";
import type { FieldSpec } from "../fields";
import { Registry } from "./registry";

/**
 * Shared module interfaces. Phase 1 defines the contracts and empty
 * registries only — implementations arrive in their phases:
 *   triggers   → Phase 3 (chain) / Phase 5 (schedule, state, inbound) / Phase 8 (VIGIL)
 *   operators  → Phase 3
 *   actions    → Phase 4 (WEBHOOK, DISCORD, WEB_PUSH) and later
 */

export type TriggerSource = "chain" | "schedule" | "inbound" | "integration";

export interface TriggerDefinition<TParams = unknown> {
  readonly type: TriggerType;
  readonly label: string;
  readonly description: string;
  readonly source: TriggerSource;
  /** Validates `flow.trigger.params` when a flow is saved. */
  readonly paramsSchema: z.ZodType<TParams>;
  // Phase 3 adds: event filter derivation, matcher, enrichment.
}

/** Why a condition could not be evaluated as written (shown in run traces). */
export type ConditionError = "missing_field" | "type_mismatch";

export interface OperatorOutcome {
  readonly passed: boolean;
  readonly error?: ConditionError;
}

export interface ConditionOperatorDefinition {
  readonly type: ConditionOperator;
  readonly label: string;
  /**
   * Pure and total: never throws, never performs I/O. `actual` is never
   * undefined/null here (missing fields are handled by the evaluator), except
   * for EXISTS, which receives it as-is. `expected` is undefined for EXISTS.
   */
  evaluate(actual: unknown, expected: unknown): OperatorOutcome;
}

/** Outbound HTTP as actions see it: SSRF-guarded, no redirects, bounded (implemented in @ignitra/actions). */
export interface SafeHttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly timeoutMs?: number;
}

export interface SafeHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** First bytes of the body as text (bounded). */
  readonly body: string;
  readonly durationMs: number;
}

export interface SafeHttpClient {
  request(req: SafeHttpRequest): Promise<SafeHttpResponse>;
}

/** Read-only chain access for actions (CHAIN_READ). Implemented by the RPC reader. */
export interface ChainCallClient {
  /** eth_call; `blockNumber` omitted = latest. Throws CallRevertedError / StateUnavailableError (@ignitra/chain). */
  call(request: { readonly to: NormalizedAddress; readonly data: `0x${string}`; readonly blockNumber?: number }): Promise<`0x${string}`>;
  blockNumber(): Promise<number>;
}

/** A decrypted connection. Secrets live only in memory, for the duration of the step. */
export interface ActionConnection {
  readonly id: string;
  readonly type: ConnectionType;
  readonly label: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly secret: Readonly<Record<string, unknown>>;
}

export type TemplateEscapeMode = "none" | "html";

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  readonly tag?: string;
}

export interface PushDelivery {
  readonly subscriptions: number;
  readonly delivered: number;
  readonly expired: number;
  readonly failed: number;
  readonly retryable: boolean;
  readonly errors: readonly string[];
}

export interface ActionContext {
  readonly runId: string;
  readonly flowId: string;
  readonly flowName: string;
  readonly flowVersion: number;
  readonly stepId: string;
  /** `<run idempotency key>:<step_id>` — identical on every retry so receivers can deduplicate. */
  readonly idempotencyKey: string;
  readonly runIdempotencyKey: string;
  /** 1-based attempt of this step. */
  readonly attempt: number;
  readonly isTest: boolean;
  readonly signal: AbortSignal;
  /** Trigger payload (`trigger.*`) of the run. */
  readonly trigger: Readonly<Record<string, unknown>>;
  /** Renders a template against the run scope; throws TemplateError on unknown variables. */
  render(template: string, escape?: TemplateEscapeMode): string;
  /** The step's connection, decrypted (null when the action needs none). */
  readonly connection: ActionConnection | null;
  readonly http: SafeHttpClient;
  /** Web Push to the flow owner's subscriptions (null when push is not configured). */
  readonly push: { send(message: PushMessage): Promise<PushDelivery> } | null;
  /** Per-owner webhook signing secret (derived), when configured. */
  readonly ownerSigningSecret: string | null;
  /** eth_call against the chain (null when the runner has no RPC configured). */
  readonly chain: ChainCallClient | null;
}

/** Summaries stored in run_steps — never raw secrets. */
export interface ActionTrace {
  readonly request?: Record<string, unknown>;
  readonly response?: Record<string, unknown>;
}

export type ActionResult =
  | (ActionTrace & {
      readonly status: "succeeded";
      readonly httpStatus?: number;
      /** Exposed to later steps as `{{steps.<step_id>.*}}`. Must be JSON-serializable. */
      readonly output?: Record<string, unknown>;
    })
  | (ActionTrace & {
      /** Nothing to do (e.g. the owner has no push subscriptions) — not a failure. */
      readonly status: "skipped";
      readonly reason: string;
    })
  | (ActionTrace & {
      readonly status: "failed";
      readonly httpStatus?: number;
      readonly error: string;
      /** False for permanent failures (4xx, invalid params) — the runner stops retrying. */
      readonly retryable: boolean;
      /** Server-requested delay (Retry-After, Telegram retry_after). */
      readonly retryAfterMs?: number;
    });

export interface ActionDefinition<TParams = unknown> {
  readonly type: ActionType;
  readonly label: string;
  readonly description: string;
  /** Connection type this action needs (`params.connection_id`), if any. */
  readonly connectionType: ConnectionType | null;
  /** Whether `connection_id` may be omitted (e.g. WEBHOOK with an inline url). */
  readonly connectionOptional?: boolean;
  readonly paramsSchema: z.ZodType<TParams>;
  /** Templates in these params, for save-time variable validation. */
  templates(params: TParams): ReadonlyArray<{ readonly name: string; readonly template: string }>;
  /** Fields of `output`, referenceable by later steps as `steps.<id>.*`. */
  readonly outputFields: readonly FieldSpec[];
  /** Output fields for these params, when they depend on them (e.g. CHAIN_READ's return types). */
  outputFieldsFor?(params: TParams): readonly FieldSpec[];
  /** Save-time checks that need the flow's context (e.g. a trigger field the action relies on). */
  validate?(params: TParams, ctx: { readonly triggerFields: readonly FieldSpec[] }): string[];
  execute(params: TParams, ctx: ActionContext): Promise<ActionResult>;
}

/*
 * Registries store definitions with erased params. Each module validates its
 * own params through `paramsSchema` before `execute` is reached, so the erased
 * `any` never leaks unchecked data into an implementation.
 */
export type AnyTriggerDefinition = TriggerDefinition<any>;
export type AnyActionDefinition = ActionDefinition<any>;

export type TriggerRegistry = Registry<TriggerType, AnyTriggerDefinition>;
export type ConditionOperatorRegistry = Registry<ConditionOperator, ConditionOperatorDefinition>;
export type ActionRegistry = Registry<ActionType, AnyActionDefinition>;

export function createTriggerRegistry(): TriggerRegistry {
  return new Registry("trigger");
}

export function createConditionOperatorRegistry(): ConditionOperatorRegistry {
  return new Registry("condition operator");
}

export function createActionRegistry(): ActionRegistry {
  return new Registry("action");
}
