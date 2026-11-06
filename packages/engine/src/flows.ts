import { and, eq, sql } from "drizzle-orm";
import {
  flowDefinitionSchema,
  newId,
  normalizeAddress,
  validateConditionFields,
  validateTemplate,
  type ActionRegistry,
  type FieldSpec,
  type FlowDefinition,
  type FlowStatus,
} from "@ignitra/core";
import { connections, flowVersions, flows, triggerState, users, watches, type Database, type Tx } from "@ignitra/db";
import type { PrepareContext, TriggerModuleRegistry } from "./types";

/**
 * Flow service — the only way flows are created or changed (CLI now, API in
 * Phase 5). Every save goes through the same validation:
 *   structure → trigger params → module prepare() → mode support → condition fields
 * and versions are append-only: a change writes version N+1, never edits N.
 */

export interface FlowIssue {
  readonly path: string;
  readonly message: string;
}

export class FlowValidationError extends Error {
  readonly issues: readonly FlowIssue[];

  constructor(issues: readonly FlowIssue[]) {
    super(`invalid flow:\n  - ${issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("\n  - ")}`);
    this.name = "FlowValidationError";
    this.issues = issues;
  }
}

export class FlowNotFoundError extends Error {
  constructor(flowId: string) {
    super(`flow ${flowId} not found`);
    this.name = "FlowNotFoundError";
  }
}

export interface FlowServiceDeps {
  readonly db: Database;
  readonly chainId: number;
  readonly triggers: TriggerModuleRegistry;
  readonly prepare: PrepareContext;
  /** When present, action types / params / connections / templates are validated too. */
  readonly actions?: ActionRegistry;
}

type ValidationDeps = Pick<FlowServiceDeps, "triggers" | "prepare"> & { readonly actions?: ActionRegistry | undefined; readonly db?: Database | undefined };

export async function validateFlowDefinition(input: unknown, deps: ValidationDeps, ownerId?: string): Promise<FlowDefinition> {
  const parsed = flowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new FlowValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })));
  }
  const def = parsed.data;
  const module = deps.triggers.has(def.trigger.type) ? deps.triggers.get(def.trigger.type) : undefined;
  if (!module) throw new FlowValidationError([{ path: "trigger.type", message: `${def.trigger.type} is not available yet` }]);

  const params = module.paramsSchema.safeParse(def.trigger.params);
  if (!params.success) {
    throw new FlowValidationError(
      params.error.issues.map((i) => ({ path: ["trigger", "params", ...i.path.map(String)].join("."), message: i.message })),
    );
  }
  let prepared: unknown = params.data;
  if (module.prepare) {
    try {
      prepared = await module.prepare(params.data, deps.prepare);
    } catch (err) {
      throw new FlowValidationError([{ path: "trigger.params", message: (err as Error).message }]);
    }
  }

  const issues: FlowIssue[] = [];
  if (def.settings.mode === "fast" && !module.supportsFast) {
    issues.push({ path: "settings.mode", message: `${def.trigger.type} needs confirmed data and does not support fast mode` });
  }
  const triggerFields = module.fields(prepared);
  for (const issue of validateConditionFields(def.conditions, triggerFields)) {
    issues.push({ path: `conditions.${issue.path}`, message: issue.message });
  }
  const actions = deps.actions ? await validateActions(def, triggerFields, deps, ownerId, issues) : def.actions;
  if (issues.length > 0) throw new FlowValidationError(issues);
  return { ...def, trigger: { type: def.trigger.type, params: prepared as Record<string, unknown> }, actions };
}

/** Types available, params valid, connections owned and of the right type, template variables resolvable. */
async function validateActions(
  def: FlowDefinition,
  triggerFields: readonly FieldSpec[],
  deps: ValidationDeps,
  ownerId: string | undefined,
  issues: FlowIssue[],
): Promise<FlowDefinition["actions"]> {
  const registry = deps.actions as ActionRegistry;
  const earlier = new Map<string, readonly FieldSpec[]>();
  const out: FlowDefinition["actions"] = [];
  for (const [i, step] of def.actions.entries()) {
    const at = `actions.${i}`;
    const action = registry.has(step.type) ? registry.get(step.type) : undefined;
    if (!action) {
      issues.push({ path: `${at}.type`, message: `${step.type} is not available yet${step.type === "DISCORD" ? " (use TELEGRAM)" : ""}` });
      out.push(step);
      continue;
    }
    const parsed = action.paramsSchema.safeParse(step.params);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push({ path: [at, "params", ...issue.path.map(String)].join("."), message: issue.message });
      out.push(step);
      continue;
    }
    const params = parsed.data as Record<string, unknown>;
    const connectionId = typeof params.connection_id === "string" ? params.connection_id : null;
    if (action.connectionType && !connectionId && !action.connectionOptional) {
      issues.push({ path: `${at}.params.connection_id`, message: `${step.type} needs a ${action.connectionType} connection` });
    }
    if (connectionId && deps.db && ownerId) {
      const [conn] = await deps.db.select({ ownerId: connections.ownerId, type: connections.type }).from(connections).where(eq(connections.id, connectionId));
      if (!conn || conn.ownerId !== ownerId) {
        issues.push({ path: `${at}.params.connection_id`, message: `connection ${connectionId} not found` });
      } else if (action.connectionType && conn.type !== action.connectionType) {
        issues.push({ path: `${at}.params.connection_id`, message: `connection ${connectionId} is ${conn.type}; ${step.type} needs ${action.connectionType}` });
      }
    }
    for (const t of action.templates(params)) {
      for (const message of validateTemplate(t.template, { triggerFields, earlierSteps: earlier })) issues.push({ path: `${at}.params.${t.name}`, message });
    }
    earlier.set(step.step_id, action.outputFields);
    out.push({ ...step, params });
  }
  return out;
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) throw new FlowValidationError([{ path: "name", message: "must be 1-120 characters" }]);
  return trimmed;
}

/** Users are keyed by wallet (SIWE in Phase 5). */
export async function ensureUser(db: Database, address: string): Promise<string> {
  const normalized = normalizeAddress(address);
  await db.insert(users).values({ id: newId("user"), address: normalized }).onConflictDoNothing();
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.address, normalized));
  if (!row) throw new Error("user upsert failed");
  return row.id;
}

/** Replace the flow's watch rows with those of its current definition (log triggers only). */
async function syncWatches(tx: Tx, deps: FlowServiceDeps, flowId: string, def: FlowDefinition): Promise<void> {
  await tx.delete(watches).where(eq(watches.flowId, flowId));
  const module = deps.triggers.has(def.trigger.type) ? deps.triggers.get(def.trigger.type) : undefined;
  if (!module || module.kind !== "log") return;
  const params = module.paramsSchema.parse(def.trigger.params);
  const fast = def.settings.mode === "fast" && module.supportsFast;
  const rows = module.watches(params).map((w) => ({
    id: newId("watch"),
    chainId: deps.chainId,
    address: w.address,
    topic0: w.topic0,
    fast,
    source: "flow" as const,
    flowId,
  }));
  if (rows.length > 0) await tx.insert(watches).values(rows).onConflictDoNothing();
}

export interface CreatedFlow {
  readonly flowId: string;
  readonly version: number;
  readonly status: FlowStatus;
  readonly definition: FlowDefinition;
}

export async function createFlow(
  deps: FlowServiceDeps,
  input: { ownerId: string; name: string; definition: unknown; activate?: boolean },
): Promise<CreatedFlow> {
  const definition = await validateFlowDefinition(input.definition, deps, input.ownerId);
  const name = validateName(input.name);
  const flowId = newId("flow");
  const status: FlowStatus = input.activate ? "active" : "paused";
  await deps.db.transaction(async (tx) => {
    await tx.insert(flows).values({
      id: flowId,
      ownerId: input.ownerId,
      name,
      status,
      currentVersion: 1,
      activatedAt: input.activate ? sql`now()` : null,
    });
    await tx.insert(flowVersions).values({ flowId, version: 1, definition });
    await syncWatches(tx, deps, flowId, definition);
  });
  return { flowId, version: 1, status, definition };
}

/** Writes version N+1 and makes it current. Polling-trigger state restarts from scratch. */
export async function updateFlowDefinition(deps: FlowServiceDeps, flowId: string, input: unknown): Promise<{ version: number; definition: FlowDefinition }> {
  const [owner] = await deps.db.select({ ownerId: flows.ownerId }).from(flows).where(eq(flows.id, flowId));
  if (!owner) throw new FlowNotFoundError(flowId);
  const definition = await validateFlowDefinition(input, deps, owner.ownerId);
  return deps.db.transaction(async (tx) => {
    const [flow] = await tx.select().from(flows).where(eq(flows.id, flowId)).for("update");
    if (!flow) throw new FlowNotFoundError(flowId);
    const version = flow.currentVersion + 1;
    await tx.insert(flowVersions).values({ flowId, version, definition });
    await tx.update(flows).set({ currentVersion: version, updatedAt: sql`now()` }).where(eq(flows.id, flowId));
    await tx.delete(triggerState).where(eq(triggerState.flowId, flowId));
    await syncWatches(tx, deps, flowId, definition);
    return { version, definition };
  });
}

export async function getCurrentDefinition(db: Database, flowId: string): Promise<{ version: number; definition: FlowDefinition; status: FlowStatus; ownerId: string }> {
  const [row] = await db
    .select({ version: flows.currentVersion, status: flows.status, ownerId: flows.ownerId, definition: flowVersions.definition })
    .from(flows)
    .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
    .where(eq(flows.id, flowId));
  if (!row) throw new FlowNotFoundError(flowId);
  return row;
}

/**
 * Activation re-validates the current version (modules or field catalogs may
 * have changed since it was saved) and stamps `activated_at`: events from
 * blocks before that moment never trigger the flow.
 */
export async function setFlowStatus(deps: FlowServiceDeps, flowId: string, status: FlowStatus, reason: string | null = null): Promise<void> {
  const current = await getCurrentDefinition(deps.db, flowId);
  if (status === "active") await validateFlowDefinition(current.definition, deps, current.ownerId);
  await deps.db.transaction(async (tx) => {
    const becomingActive = status === "active" && current.status !== "active";
    await tx
      .update(flows)
      .set({
        status,
        statusReason: reason,
        updatedAt: sql`now()`,
        ...(becomingActive ? { activatedAt: sql`now()` } : {}),
      })
      .where(eq(flows.id, flowId));
    if (becomingActive) await syncWatches(tx, deps, flowId, current.definition);
  });
}
