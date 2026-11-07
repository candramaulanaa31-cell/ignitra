import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RUN_STATUSES, EVALUATION_OUTCOMES, type FlowDefinition } from "@ignitra/core";
import { flowEvaluations, flowStats, flowVersions, flows, runSteps, runs } from "@ignitra/db";
import {
  createFlow,
  deleteFlow,
  ensureInboundHook,
  inboundHookUrl,
  renameFlow,
  rotateInboundHook,
  setFlowStatus,
  updateFlowDefinition,
  validateFlowDefinition,
} from "@ignitra/engine";
import { caller } from "../auth";
import type { ApiContext } from "../context";
import { ApiError, clampLimit, notFound, parse } from "../http";
import { evaluationView, flowView, runView } from "../views";

const createBody = z.object({ name: z.string().max(200), definition: z.unknown(), activate: z.boolean().optional() }).strict();
const patchBody = z
  .object({ name: z.string().max(200).optional(), definition: z.unknown().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.definition !== undefined, { message: "send name and/or definition" });

const triggerType = (definition: unknown): string | null => {
  const t = (definition as { trigger?: { type?: unknown } } | null)?.trigger?.type;
  return typeof t === "string" ? t : null;
};

/** Authenticated: flows (versions are append-only), their runs, traces and evaluations. Other owners' flows are 404. */
export function registerFlowRoutes(app: FastifyInstance, ctx: ApiContext): void {
  async function owned(userId: string, flowId: string) {
    const [row] = await ctx.db
      .select({ flow: flows, definition: flowVersions.definition, stats: flowStats })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
      .leftJoin(flowStats, eq(flowStats.flowId, flows.id))
      .where(and(eq(flows.id, flowId), eq(flows.ownerId, userId)));
    if (!row) throw notFound("flow");
    return row;
  }

  async function hookUrl(flowId: string, definition: FlowDefinition): Promise<string | null | undefined> {
    if (definition.trigger.type !== "INBOUND_WEBHOOK") return undefined;
    if (!ctx.webhookMaster) return null;
    return inboundHookUrl(ctx.publicUrl, ctx.webhookMaster, flowId, await ensureInboundHook(ctx.db, flowId));
  }

  async function detail(userId: string, flowId: string) {
    const row = await owned(userId, flowId);
    return flowView(row.flow, row.definition, row.stats, { hookUrl: await hookUrl(flowId, row.definition), full: true });
  }

  const requireHookSupport = (definition: unknown) => {
    if (triggerType(definition) === "INBOUND_WEBHOOK" && !ctx.webhookMaster) {
      throw new ApiError(503, "not_configured", "INBOUND_WEBHOOK needs WEBHOOK_SIGNING_SECRET on the API to sign hook URLs");
    }
  };

  app.get("/v1/flows", async (req) => {
    const me = caller(req);
    const rows = await ctx.db
      .select({ flow: flows, definition: flowVersions.definition, stats: flowStats })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
      .leftJoin(flowStats, eq(flowStats.flowId, flows.id))
      .where(eq(flows.ownerId, me.userId))
      .orderBy(desc(flows.createdAt));
    return { data: rows.map((r) => flowView(r.flow, r.definition, r.stats)) };
  });

  // Dry run of the save-time validation: normalized definition + the trigger's payload fields.
  app.post("/v1/flows/validate", async (req) => {
    const me = caller(req);
    const body = parse(z.object({ definition: z.unknown() }).strict(), req.body);
    const definition = await validateFlowDefinition(body.definition, ctx.flowDeps, me.userId);
    const module = ctx.triggers.require(definition.trigger.type);
    return { data: { definition, trigger_fields: module.fields(definition.trigger.params as never) } };
  });

  app.post("/v1/flows", async (req, reply) => {
    const me = caller(req);
    const body = parse(createBody, req.body);
    requireHookSupport(body.definition);
    const created = await createFlow(ctx.flowDeps, { ownerId: me.userId, name: body.name, definition: body.definition, activate: body.activate ?? false });
    ctx.logger.info({ flowId: created.flowId, userId: me.userId, trigger: created.definition.trigger.type, status: created.status }, "flow created");
    return reply.code(201).send({ data: await detail(me.userId, created.flowId) });
  });

  app.get<{ Params: { id: string } }>("/v1/flows/:id", async (req) => {
    const me = caller(req);
    return { data: await detail(me.userId, req.params.id) };
  });

  app.patch<{ Params: { id: string } }>("/v1/flows/:id", async (req) => {
    const me = caller(req);
    await owned(me.userId, req.params.id);
    const body = parse(patchBody, req.body);
    if (body.definition !== undefined) {
      requireHookSupport(body.definition);
      await updateFlowDefinition(ctx.flowDeps, req.params.id, body.definition);
    }
    if (body.name !== undefined) await renameFlow(ctx.db, req.params.id, body.name);
    return { data: await detail(me.userId, req.params.id) };
  });

  app.delete<{ Params: { id: string } }>("/v1/flows/:id", async (req, reply) => {
    const me = caller(req);
    await owned(me.userId, req.params.id);
    await deleteFlow(ctx.db, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/flows/:id/pause", async (req) => {
    const me = caller(req);
    await owned(me.userId, req.params.id);
    await setFlowStatus(ctx.flowDeps, req.params.id, "paused", null);
    return { data: await detail(me.userId, req.params.id) };
  });

  // Re-validates the current version and enforces the plan's active-flow limit.
  app.post<{ Params: { id: string } }>("/v1/flows/:id/resume", async (req) => {
    const me = caller(req);
    const row = await owned(me.userId, req.params.id);
    requireHookSupport(row.definition);
    await setFlowStatus(ctx.flowDeps, req.params.id, "active", null);
    return { data: await detail(me.userId, req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/v1/flows/:id/hook/rotate", async (req) => {
    const me = caller(req);
    const row = await owned(me.userId, req.params.id);
    if (row.definition.trigger.type !== "INBOUND_WEBHOOK") throw new ApiError(409, "not_inbound", "this flow is not triggered by an inbound webhook");
    requireHookSupport(row.definition);
    const salt = await rotateInboundHook(ctx.db, req.params.id);
    return { data: { hook_url: inboundHookUrl(ctx.publicUrl, ctx.webhookMaster as string, req.params.id, salt) } };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>("/v1/flows/:id/runs", async (req) => {
    const me = caller(req);
    await owned(me.userId, req.params.id);
    const q = parse(
      z.object({ limit: z.string().optional(), before: z.string().regex(/^run_[0-9a-z]{26}$/).optional(), status: z.enum(RUN_STATUSES).optional() }),
      req.query,
    );
    const limit = clampLimit(q.limit, 50, 200);
    const rows = await ctx.db
      .select()
      .from(runs)
      .where(and(eq(runs.flowId, req.params.id), q.before ? lt(runs.id, q.before) : undefined, q.status ? eq(runs.status, q.status) : undefined))
      .orderBy(desc(runs.id))
      .limit(limit);
    const last = rows[rows.length - 1];
    return { data: rows.map((r) => runView(r)), next_before: rows.length === limit && last ? last.id : null };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>("/v1/flows/:id/evaluations", async (req) => {
    const me = caller(req);
    await owned(me.userId, req.params.id);
    const q = parse(z.object({ limit: z.string().optional(), outcome: z.enum(EVALUATION_OUTCOMES).optional() }), req.query);
    const rows = await ctx.db
      .select()
      .from(flowEvaluations)
      .where(and(eq(flowEvaluations.flowId, req.params.id), q.outcome ? eq(flowEvaluations.outcome, q.outcome) : undefined))
      .orderBy(desc(flowEvaluations.id))
      .limit(clampLimit(q.limit, 50, 200));
    return { data: rows.map(evaluationView) };
  });

  // Full trace: trigger evidence, per-condition results, every step's request / response summary.
  app.get<{ Params: { id: string } }>("/v1/runs/:id", async (req) => {
    const me = caller(req);
    const [row] = await ctx.db
      .select({ run: runs })
      .from(runs)
      .innerJoin(flows, eq(flows.id, runs.flowId))
      .where(and(eq(runs.id, req.params.id), eq(flows.ownerId, me.userId)));
    if (!row) throw notFound("run");
    const steps = await ctx.db.select().from(runSteps).where(eq(runSteps.runId, row.run.id));
    return { data: runView(row.run, steps) };
  });
}
