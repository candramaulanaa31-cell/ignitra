import { z } from "zod";
import {
  ACTION_TYPES,
  CONDITION_OPERATORS,
  FLOW_MODES,
  TRIGGER_TYPES,
  type ConditionOperator,
} from "./catalog";

/**
 * Flow definition = the immutable body of a FlowVersion:
 *   TRIGGER → CONDITIONS → ACTIONS (+ settings)
 *
 * This validates structure only. Per-type params are validated by the
 * registered module's `paramsSchema` (see registry/modules.ts).
 */

export const LIMITS = {
  maxActions: 10,
  maxConditionNodes: 50,
  maxConditionDepth: 4,
  maxInList: 500,
  maxRunsPerHour: 3600,
} as const;

/** Referenced from templates as `{{steps.<step_id>.*}}`. */
export const stepIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, {
  message: "step_id must be lowercase snake_case, starting with a letter, max 40 chars",
});

/** Dotted path into trigger data, e.g. `amount`, `token.symbol`. */
export const fieldPathSchema = z.string().regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*){0,5}$/i, {
  message: "field must be a dotted path like `amount` or `token.symbol`",
});

/** Conditions carry JSON scalars only. Big integers travel as decimal strings. */
const scalarSchema = z.union([z.string().max(1000), z.number(), z.boolean()]);
export type ConditionScalar = z.infer<typeof scalarSchema>;

const LIST_OPS: ReadonlySet<ConditionOperator> = new Set(["IN", "NOT_IN"]);

export const conditionLeafSchema = z
  .object({
    field: fieldPathSchema,
    op: z.enum(CONDITION_OPERATORS),
    value: z.union([scalarSchema, z.array(scalarSchema).max(LIMITS.maxInList)]).optional(),
  })
  .strict()
  .superRefine((leaf, ctx) => {
    const isList = Array.isArray(leaf.value);
    if (leaf.op === "EXISTS") {
      if (leaf.value !== undefined && typeof leaf.value !== "boolean") {
        ctx.addIssue({ code: "custom", path: ["value"], message: "EXISTS takes no value or a boolean" });
      }
    } else if (LIST_OPS.has(leaf.op)) {
      if (!isList) ctx.addIssue({ code: "custom", path: ["value"], message: `${leaf.op} requires an array value` });
    } else if (leaf.value === undefined || isList) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `${leaf.op} requires a single value` });
    }
  });

export type ConditionLeaf = z.infer<typeof conditionLeafSchema>;
export type ConditionGroup = { all: ConditionNode[] } | { any: ConditionNode[] };
export type ConditionNode = ConditionLeaf | ConditionGroup;

const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([conditionLeafSchema, conditionGroupShape]),
);

const conditionGroupShape: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionNodeSchema).min(1) }).strict(),
    z.object({ any: z.array(conditionNodeSchema).min(1) }).strict(),
  ]),
);

export function isConditionGroup(node: ConditionNode): node is ConditionGroup {
  return "all" in node || "any" in node;
}

function measure(node: ConditionNode, depth: number): { nodes: number; depth: number } {
  if (!isConditionGroup(node)) return { nodes: 1, depth };
  const children = "all" in node ? node.all : node.any;
  let nodes = 1;
  let maxDepth = depth;
  for (const child of children) {
    const m = measure(child, depth + 1);
    nodes += m.nodes;
    maxDepth = Math.max(maxDepth, m.depth);
  }
  return { nodes, depth: maxDepth };
}

/** Root must be a group; size and nesting are bounded to keep evaluation cheap. */
export const conditionsSchema = conditionGroupShape.superRefine((root, ctx) => {
  const m = measure(root, 1);
  if (m.nodes > LIMITS.maxConditionNodes) {
    ctx.addIssue({ code: "custom", message: `too many condition nodes (max ${LIMITS.maxConditionNodes})` });
  }
  if (m.depth > LIMITS.maxConditionDepth) {
    ctx.addIssue({ code: "custom", message: `conditions nested too deeply (max ${LIMITS.maxConditionDepth})` });
  }
});

const paramsSchema = z.record(z.string(), z.unknown());

export const triggerSpecSchema = z
  .object({
    type: z.enum(TRIGGER_TYPES),
    params: paramsSchema,
  })
  .strict();

export const actionStepSchema = z
  .object({
    step_id: stepIdSchema,
    type: z.enum(ACTION_TYPES),
    params: paramsSchema,
  })
  .strict();

export const flowSettingsSchema = z
  .object({
    mode: z.enum(FLOW_MODES).default("confirmed"),
    max_runs_per_hour: z.number().int().min(1).max(LIMITS.maxRunsPerHour).default(60),
    /** Explicit, per-flow opt-in for ONCHAIN_TX steps (spec: default OFF). */
    onchain: z.boolean().default(false),
  })
  .strict();

export const flowDefinitionSchema = z
  .object({
    trigger: triggerSpecSchema,
    conditions: conditionsSchema.optional(),
    actions: z.array(actionStepSchema).min(1).max(LIMITS.maxActions),
    settings: flowSettingsSchema.default({ mode: "confirmed", max_runs_per_hour: 60, onchain: false }),
  })
  .strict()
  .superRefine((def, ctx) => {
    const seen = new Set<string>();
    def.actions.forEach((step, i) => {
      if (seen.has(step.step_id)) {
        ctx.addIssue({ code: "custom", path: ["actions", i, "step_id"], message: `duplicate step_id "${step.step_id}"` });
      }
      seen.add(step.step_id);
    });
  });

export type TriggerSpec = z.infer<typeof triggerSpecSchema>;
export type ActionStep = z.infer<typeof actionStepSchema>;
export type FlowSettings = z.infer<typeof flowSettingsSchema>;
/** Parsed (defaults applied) definition — the shape persisted in flow_versions. */
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;
/** What a client may send (settings optional). */
export type FlowDefinitionInput = z.input<typeof flowDefinitionSchema>;
