import type { z } from "zod";
import type { ActionType, ConditionOperator, ConnectionType, TriggerType } from "../catalog";
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

export interface ActionContext {
  readonly runId: string;
  readonly flowId: string;
  readonly stepId: string;
  /** Same value on every retry so receivers can deduplicate. */
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly isTest: boolean;
  readonly signal: AbortSignal;
}

export type ActionResult =
  | {
      readonly status: "succeeded";
      readonly httpStatus?: number;
      /** Exposed to later steps as `{{steps.<step_id>.*}}`. Must be JSON-serializable. */
      readonly output?: unknown;
    }
  | {
      readonly status: "failed";
      readonly httpStatus?: number;
      readonly error: string;
      /** False for permanent failures (4xx, invalid params) — the runner stops retrying. */
      readonly retryable: boolean;
    };

export interface ActionDefinition<TParams = unknown> {
  readonly type: ActionType;
  readonly label: string;
  readonly description: string;
  /** Connection type whose secret this action needs, if any. */
  readonly connectionType: ConnectionType | null;
  readonly paramsSchema: z.ZodType<TParams>;
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
