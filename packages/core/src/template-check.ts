import type { FieldSpec } from "./fields";
import { TemplateError, templateVariables } from "./templates";

/**
 * Save-time validation of template variables. Runtime scope:
 *   trigger.*            the trigger payload (field catalog of the trigger)
 *   steps.<step_id>.*    output of an EARLIER step (its action's output fields)
 *   flow.id|name|version, run.id|idempotency_key|test, now_utc, now_wib
 */

export const BUILTIN_TEMPLATE_VARIABLES = [
  "flow.id",
  "flow.name",
  "flow.version",
  "run.id",
  "run.idempotency_key",
  "run.test",
  "now_utc",
  "now_wib",
] as const;

export interface TemplateContext {
  readonly triggerFields: readonly FieldSpec[];
  /** Earlier steps only (no forward references), with their action's output fields. */
  readonly earlierSteps: ReadonlyMap<string, readonly FieldSpec[]>;
}

function fieldKnown(fields: readonly FieldSpec[], path: string): boolean {
  if (path === "") return true; // the whole object
  return fields.some(
    (f) =>
      f.path === path ||
      f.path.startsWith(`${path}.`) || // an object that has known children
      ((f.type === "object" || f.type === "array") && path.startsWith(`${f.path}.`)), // inside a free-form object/array
  );
}

export function validateTemplate(template: string, ctx: TemplateContext): string[] {
  let variables: string[];
  try {
    variables = templateVariables(template);
  } catch (err) {
    return [(err as TemplateError).message];
  }
  const issues: string[] = [];
  for (const variable of variables) {
    const [root, ...rest] = variable.split(".");
    const sub = rest.join(".");
    if (root === "trigger") {
      if (!fieldKnown(ctx.triggerFields, sub)) issues.push(`unknown variable "${variable}"`);
    } else if (root === "steps") {
      const [stepId, ...field] = rest;
      const outputs = stepId ? ctx.earlierSteps.get(stepId) : undefined;
      if (!stepId || !outputs) issues.push(`"${variable}": steps can only reference an earlier step's output`);
      else if (!fieldKnown(outputs, field.join("."))) issues.push(`unknown variable "${variable}"`);
    } else if (!(BUILTIN_TEMPLATE_VARIABLES as readonly string[]).includes(variable)) {
      issues.push(`unknown variable "${variable}" (use trigger.*, steps.<id>.*, flow.*, run.*, now_utc, now_wib)`);
    }
  }
  return issues;
}
