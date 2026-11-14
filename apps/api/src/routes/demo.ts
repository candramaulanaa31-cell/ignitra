import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { outlineDefinition } from "@ignitra/core";
import { flowStats, flowVersions, flows, runs } from "@ignitra/db";
import type { ApiContext } from "../context";
import { ApiError, iso, notFound } from "../http";
import { eventSummary } from "../views";

/**
 * GET /v1/demo — the landing page's live demo: one flow the operator designates
 * (DEMO_FLOW_ID) running on mainnet. Only public chain data leaves: event
 * summaries, transaction hashes, timings. Cached for 5 s.
 */
export function registerDemoRoutes(app: FastifyInstance, ctx: ApiContext): void {
  let cache: { at: number; body: unknown } | null = null;

  app.get("/v1/demo", async (_req, reply) => {
    const id = ctx.demoFlowId;
    if (!id) throw new ApiError(404, "not_configured", "no demo flow on this server (DEMO_FLOW_ID)");
    reply.header("cache-control", "public, max-age=5");
    if (cache && ctx.now() - cache.at < 5_000) return cache.body;

    const [row] = await ctx.db
      .select({ flow: flows, definition: flowVersions.definition, stats: flowStats })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
      .leftJoin(flowStats, eq(flowStats.flowId, flows.id))
      .where(eq(flows.id, id));
    if (!row) throw notFound("demo flow");
    const recent = await ctx.db
      .select()
      .from(runs)
      .where(and(eq(runs.flowId, id), eq(runs.isTest, false)))
      // Runs queued in the same instant (several matches in one block; PGlite's clock ticks in
      // milliseconds) share created_at. Their ids are time-ordered, so they settle the order.
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(100);
    const latency = (r: (typeof recent)[number]): number | null => {
      const ts = r.triggerEvent.block_timestamp;
      if (r.status !== "succeeded" || !r.finishedAt || typeof ts !== "string") return null;
      const ms = r.finishedAt.getTime() - Date.parse(ts);
      return Number.isFinite(ms) && ms >= 0 ? ms : null;
    };
    const samples = recent.map(latency).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    const pct = (p: number) => (samples.length ? (samples[Math.min(samples.length - 1, Math.floor(p * samples.length))] ?? null) : null);

    const body = {
      data: {
        name: row.flow.name,
        status: row.flow.status,
        trigger_type: row.definition.trigger.type,
        outline: outlineDefinition(row.definition, [], { hideTargets: true }),
        stats: { runs: row.stats?.runs ?? 0, matched: row.stats?.matched ?? 0, last_run_at: iso(row.stats?.lastRunAt) },
        // Block time → run finished (includes the confirmation depth).
        latency_ms: { p50: pct(0.5), p90: pct(0.9), samples: samples.length },
        runs: recent.slice(0, 12).map((r) => ({
          at: iso(r.createdAt),
          status: r.status,
          summary: eventSummary(r.triggerEvent),
          tx_hash: typeof r.triggerEvent.tx_hash === "string" ? r.triggerEvent.tx_hash : null,
          block_number: typeof r.triggerEvent.block_number === "number" ? r.triggerEvent.block_number : null,
          latency_ms: latency(r),
        })),
      },
    };
    cache = { at: ctx.now(), body };
    return body;
  });
}
