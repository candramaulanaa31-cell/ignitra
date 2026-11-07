import { and, eq, ne, sql } from "drizzle-orm";
import {
  evaluateConditions,
  flowDefinitionSchema,
  newId,
  normalizeAddress,
  planFor,
  planLimits,
  validateConditionFields,
  validateTemplate,
  type ActionRegistry,
  type FieldSpec,
  type FlowDefinition,
  type FlowStatus,
  type Plan,
} from "@ignitra/core";
import { connections, flowVersions, flows, ownerNotifications, runs, triggerState, users, watches, type Database, type Run, type Tx } from "@ignitra/db";
import { ensureInboundHook } from "./hooks";
import type { PrepareContext, TriggerModuleRegistry } from "./types";

/**
 * Flow service — the only way flows are created or changed (API and CLI).
 * Every save goes through the same validation:
 *   structure → trigger params → module prepare() → mode support → plan limits → condition fields → actions
 * and versions are append-only: a change writes version N+1, never edits N.
 * Plan limits (active flows, schedule frequency) are enforced here, server-side.
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

/** The owner's plan does not allow this (e.g. another active flow). */
export class PlanLimitError extends Error {
  readonly limit: "active_flows";
  readonly plan: Plan;
  readonly max: number;

  constructor(plan: Plan, max: number, current: number) {
    super(`The ${plan} plan allows ${max} active flow${max === 1 ? "" : "s"} (you have ${current}). Pause another flow or upgrade.`);
    this.name = "PlanLimitError";
    this.limit = "active_flows";
    this.plan = plan;
    this.max = max;
  }
}

async function ownerPlan(db: Database | Tx, ownerId: string): Promise<Plan> {
  const [row] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, ownerId));
  return row?.plan ?? "free";
}

/** Inside the activating transaction: locks the owner row so concurrent activations cannot both pass. */
async function assertCanActivate(tx: Tx, ownerId: string, flowId: string | null): Promise<void> {
  const [owner] = await tx.select({ plan: users.plan }).from(users).where(eq(users.id, ownerId)).for("update");
  const plan = owner?.plan ?? "free";
  const max = planLimits(plan).activeFlows;
  if (max === null) return;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(flows)
    .where(and(eq(flows.ownerId, ownerId), eq(flows.status, "active"), flowId ? ne(flows.id, flowId) : undefined));
  const active = Number(row?.n ?? 0);
  if (active >= max) throw new PlanLimitError(plan, max, active);
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
  const plan = deps.db && ownerId ? await ownerPlan(deps.db, ownerId) : null;
  if (plan) {
    // Features of higher plans (spec §10: Builder adds Sheets, email and schedule).
    const limits = planLimits(plan);
    if (limits.lockedTriggers.includes(def.trigger.type)) {
      issues.push({ path: "trigger.type", message: `${def.trigger.type} needs the ${planFor(def.trigger.type)} plan (you are on ${plan})` });
    }
    def.actions.forEach((a, i) => {
      if (limits.lockedActions.includes(a.type)) issues.push({ path: `actions.${i}.type`, message: `${a.type} needs the ${planFor(a.type)} plan (you are on ${plan})` });
    });
  }
  if (module.minIntervalMs && plan) {
    const interval = module.minIntervalMs(prepared);
    const minMinutes = planLimits(plan).minScheduleMinutes;
    if (interval !== null && interval < minMinutes * 60_000) {
      issues.push({
        path: "trigger.params",
        message: `the ${plan} plan allows schedules at most every ${minMinutes} minute${minMinutes === 1 ? "" : "s"}; this one fires every ${Math.max(1, Math.round(interval / 60_000))} minute(s)`,
      });
    }
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
      const [conn] = await deps.db
        .select({ ownerId: connections.ownerId, type: connections.type, metadata: connections.metadata })
        .from(connections)
        .where(eq(connections.id, connectionId));
      if (!conn || conn.ownerId !== ownerId) {
        issues.push({ path: `${at}.params.connection_id`, message: `connection ${connectionId} not found` });
      } else if (action.connectionType && conn.type !== action.connectionType) {
        issues.push({ path: `${at}.params.connection_id`, message: `connection ${connectionId} is ${conn.type}; ${step.type} needs ${action.connectionType}` });
      } else if (conn.metadata.verified === false) {
        issues.push({ path: `${at}.params.connection_id`, message: `${String(conn.metadata.address ?? connectionId)} is not verified yet (enter the code we emailed)` });
      }
    }
    for (const t of action.templates(params)) {
      for (const message of validateTemplate(t.template, { triggerFields, earlierSteps: earlier })) issues.push({ path: `${at}.params.${t.name}`, message });
    }
    for (const message of action.validate?.(params, { triggerFields }) ?? []) issues.push({ path: `${at}.params`, message });
    earlier.set(step.step_id, action.outputFieldsFor?.(params) ?? action.outputFields);
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
    if (input.activate) await assertCanActivate(tx, input.ownerId, null);
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
    if (definition.trigger.type === "INBOUND_WEBHOOK") await ensureInboundHook(tx, flowId);
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
    if (definition.trigger.type === "INBOUND_WEBHOOK") await ensureInboundHook(tx, flowId);
    return { version, definition };
  });
}

/** TEST runs a user may start per hour (they send real messages). */
export const TEST_RUNS_PER_HOUR = 30;

export class TestRunLimitError extends Error {
  constructor() {
    super(`at most ${TEST_RUNS_PER_HOUR} test runs per hour`);
    this.name = "TestRunLimitError";
  }
}

/**
 * "Test flow": queues a TEST run of the current version with a sample payload.
 * Actions always execute (that is the point of a test); the conditions are
 * evaluated and recorded so the user sees whether a real event would have run.
 * TEST runs are never metered, never count towards the hourly cap or flow
 * stats, run on paused flows, and every action labels what it sends.
 */
export async function queueTestRun(db: Database, input: { flowId: string; ownerId: string; payload: Record<string, unknown> }): Promise<{ run: Run; conditionsPassed: boolean }> {
  const current = await getCurrentDefinition(db, input.flowId);
  if (current.ownerId !== input.ownerId) throw new FlowNotFoundError(input.flowId);
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .where(and(eq(flows.ownerId, input.ownerId), eq(runs.isTest, true), sql`${runs.createdAt} > now() - interval '1 hour'`));
  if (Number(recent?.n ?? 0) >= TEST_RUNS_PER_HOUR) throw new TestRunLimitError();
  const evaluation = evaluateConditions(current.definition.conditions, input.payload);
  const id = newId("run");
  const [run] = await db
    .insert(runs)
    .values({
      id,
      flowId: input.flowId,
      flowVersion: current.version,
      idempotencyKey: `test:${id}`,
      isTest: true,
      triggerType: current.definition.trigger.type,
      triggerEvent: input.payload,
      conditionsResult: evaluation.results as unknown[],
      status: "queued",
    })
    .returning();
  if (!run) throw new Error("test run insert failed");
  return { run, conditionsPassed: evaluation.passed };
}

/**
 * After a plan change: pauses the owner's active flows that use triggers or actions
 * the plan does not include, telling the owner why. Returns the paused flow ids.
 */
export async function enforcePlanFeatures(db: Database, ownerId: string): Promise<string[]> {
  const plan = await ownerPlan(db, ownerId);
  const limits = planLimits(plan);
  const active = await db
    .select({ id: flows.id, name: flows.name, definition: flowVersions.definition })
    .from(flows)
    .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
    .where(and(eq(flows.ownerId, ownerId), eq(flows.status, "active")));
  const paused: string[] = [];
  for (const f of active) {
    const locked = [f.definition.trigger.type, ...f.definition.actions.map((a) => a.type)].filter(
      (t) => (limits.lockedTriggers as readonly string[]).includes(t) || (limits.lockedActions as readonly string[]).includes(t),
    );
    if (locked.length === 0) continue;
    const reason = `paused: the ${plan} plan does not include ${[...new Set(locked)].join(", ")}`;
    await db.transaction(async (tx) => {
      await tx.update(flows).set({ status: "paused", statusReason: reason, updatedAt: sql`now()` }).where(eq(flows.id, f.id));
      await tx.insert(ownerNotifications).values({ id: newId("notification"), userId: ownerId, flowId: f.id, kind: "flow_plan_paused", message: `"${f.name}" was ${reason}. Upgrade, or change the flow and resume it.` });
    });
    paused.push(f.id);
  }
  return paused;
}

export async function renameFlow(db: Database, flowId: string, name: string): Promise<string> {
  const trimmed = validateName(name);
  const rows = await db.update(flows).set({ name: trimmed, updatedAt: sql`now()` }).where(eq(flows.id, flowId)).returning({ id: flows.id });
  if (rows.length === 0) throw new FlowNotFoundError(flowId);
  return trimmed;
}

/** Deletes the flow with its versions, runs, evaluations and watches (FK cascades). */
export async function deleteFlow(db: Database, flowId: string): Promise<boolean> {
  const rows = await db.delete(flows).where(eq(flows.id, flowId)).returning({ id: flows.id });
  return rows.length > 0;
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
    if (becomingActive) await assertCanActivate(tx, current.ownerId, flowId);
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
