import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { isId, newId } from "@ignitra/core";
import { flowVersions, flows, inboundEvents } from "@ignitra/db";
import { loadConnection, verifyVigilSignature } from "@ignitra/actions";
import type { ApiContext } from "../context";
import { ApiError, RECEIVER_MISSES_PER_MINUTE, RateLimiter, enforceRate, notFound } from "../http";

/**
 * Receivers for integrations that push to IGNITRA (Phase 8).
 *
 *   POST /v1/integrations/vigil/:connection_id
 *     VIGIL webhook deliveries, verified with the connection's secret (x-vigil-signature).
 *     200 { ok, flows, stored }: one inbound event per active VIGIL_ALERT flow on the connection
 *     (deduplicated per alert and event type, so VIGIL's retries never run a flow twice);
 *     pings and event types IGNITRA does not know are acknowledged and ignored.
 *     401 bad signature · 404 unknown connection · 413 over 256 KB · 429 over 600/min.
 */

const MAX_BYTES = 256 * 1024;
const ALERT_TYPES = new Set(["alert.created", "alert.confirmed", "alert.retracted"]);

export function registerIntegrationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const limiter = new RateLimiter(600, 60_000, ctx.now);

  app.register(async (scope) => {
    // The signature covers the raw bytes: keep the body as text.
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

    scope.post<{ Params: { connectionId: string } }>("/v1/integrations/vigil/:connectionId", { bodyLimit: MAX_BYTES }, async (req, reply) => {
      const { connectionId } = req.params;
      if (!ctx.keyring) throw new ApiError(503, "not_configured", "integrations need ENCRYPTION_KEY on this server");
      // Unknown connections and bad signatures cost the sender's address; genuine deliveries never do
      // (VIGIL delivers for every user from the same address).
      const misses = `inbound-miss:${req.ip}`;
      ctx.limiter.ensure(misses, RECEIVER_MISSES_PER_MINUTE, reply);
      const spend = () => ctx.limiter.spend(misses, RECEIVER_MISSES_PER_MINUTE);
      if (!isId("connection", connectionId)) {
        spend();
        throw notFound("connection");
      }
      enforceRate(limiter, connectionId, reply, "VIGIL deliveries");
      const conn = await loadConnection(ctx.db, ctx.keyring, connectionId).catch(() => null);
      if (!conn || conn.type !== "vigil") {
        spend();
        throw notFound("connection");
      }
      const raw = typeof req.body === "string" ? req.body : "";
      const secret = conn.secret.webhook_secret;
      if (typeof secret !== "string") throw new ApiError(401, "not_ready", "this VIGIL connection is waiting for VIGIL's signing secret: paste it in IGNITRA under Connections");
      if (!verifyVigilSignature(raw, req.headers as Record<string, unknown>, secret, ctx.now())) {
        spend();
        throw new ApiError(401, "bad_signature", "the VIGIL signature does not match this connection's secret (or is older than 5 minutes)");
      }
      let event: { type?: unknown; delivery_id?: unknown; alert?: { alert_id?: unknown } } | null;
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        throw new ApiError(400, "invalid_json", "the body is not JSON");
      }
      const type = typeof event?.type === "string" ? event.type : "";
      if (type === "ping") return { ok: true, type: "ping" };
      // VIGIL may add event types: acknowledge what IGNITRA does not know, so it is not retried forever.
      if (!ALERT_TYPES.has(type)) return { ok: true, ignored: type || "unknown" };

      const active = await ctx.db
        .select({ id: flows.id, definition: flowVersions.definition })
        .from(flows)
        .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
        .where(and(eq(flows.ownerId, conn.ownerId), eq(flows.status, "active")));
      const targets = active.filter((f) => f.definition.trigger.type === "VIGIL_ALERT" && (f.definition.trigger.params as { connection_id?: unknown }).connection_id === connectionId);
      const alertId = typeof event?.alert?.alert_id === "string" ? event.alert.alert_id.slice(0, 100) : String(event?.delivery_id ?? "").slice(0, 100);
      const dedupeKey = `vigil:${type.slice(0, 40)}:${alertId}`;
      const delivery = typeof req.headers["x-vigil-delivery"] === "string" ? req.headers["x-vigil-delivery"].slice(0, 120) : null;
      let stored = 0;
      for (const target of targets) {
        const inserted = await ctx.db
          .insert(inboundEvents)
          .values({
            requestId: newId("inboundRequest"),
            flowId: target.id,
            dedupeKey,
            contentType: "application/json",
            body: event as Record<string, unknown>,
            query: {},
            headers: delivery ? { x_vigil_delivery: delivery } : {},
            bytes: Buffer.byteLength(raw),
          })
          .onConflictDoNothing({ target: [inboundEvents.flowId, inboundEvents.dedupeKey] })
          .returning({ requestId: inboundEvents.requestId });
        stored += inserted.length;
      }
      if (stored > 0) ctx.onInboundEvent();
      return { ok: true, flows: targets.length, stored };
    });
  });
}
