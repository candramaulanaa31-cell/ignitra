import { and, count, eq, gt } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isId, newId, planLimits, usagePeriod } from "@ignitra/core";
import { flowVersions, flows, inboundEvents, usageMonthly, users } from "@ignitra/db";
import { inboundHookSalt, verifyInboundToken } from "@ignitra/engine";
import type { ApiContext } from "../context";
import { ApiError, RECEIVER_MISSES_PER_MINUTE, RateLimiter, enforceRate, notFound } from "../http";

/**
 * Public INBOUND_WEBHOOK endpoint: POST /v1/hooks/<flow_id>/<token>
 *
 *   202 { accepted: true, request_id, duplicate }   stored; the matcher runs the flow
 *   404  unknown flow or wrong token (indistinguishable on purpose)
 *   402  free plan: this month's runs are used up (nothing would run)
 *   409  the flow is paused          413  body over 64 KB
 *   429  over the per-flow rate (per minute) or the daily intake cap
 *
 * The request is stored as-is (bounded) and runs through the same admission as
 * every trigger. `Idempotency-Key` makes retries safe: a repeated key answers
 * 202 again with `duplicate: true` and never creates a second run.
 */

export const INBOUND_MAX_BYTES = 64 * 1024;

const SENSITIVE = /auth|cookie|token|secret|key|signature|password|session|forwarded|real-ip/i;

function pickHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [name, raw] of Object.entries(req.headers)) {
    if (n >= 30) break;
    const keep = name === "content-type" || name === "user-agent" || (name.startsWith("x-") && !SENSITIVE.test(name));
    if (!keep || raw === undefined) continue;
    out[name.replace(/-/g, "_")] = (Array.isArray(raw) ? raw.join(", ") : String(raw)).slice(0, 500);
    n++;
  }
  return out;
}

function pickQuery(query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query || typeof query !== "object") return out;
  for (const [k, v] of Object.entries(query as Record<string, unknown>).slice(0, 50)) {
    out[k.slice(0, 100)] = (Array.isArray(v) ? v.join(",") : String(v ?? "")).slice(0, 1000);
  }
  return out;
}

function normalizeBody(body: unknown): unknown {
  if (body === undefined || body === null || body === "") return {};
  if (typeof body === "string") return { text: body };
  if (typeof body === "object") return body;
  return { value: body };
}

export function registerHookRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const limiter = new RateLimiter(ctx.inboundRatePerMinute, 60_000, ctx.now);

  app.register(async (scope) => {
    // Senders post JSON, forms or text; anything else is kept as text.
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: INBOUND_MAX_BYTES }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: INBOUND_MAX_BYTES }, (_req, body, done) => done(null, body));

    scope.post<{ Params: { flowId: string; token: string } }>("/v1/hooks/:flowId/:token", { bodyLimit: INBOUND_MAX_BYTES }, async (req, reply) => {
      const { flowId, token } = req.params;
      if (!ctx.webhookMaster) throw new ApiError(503, "not_configured", "inbound webhooks are not configured on this server");
      // Wrong URLs cost the sender's address: guessing is bounded, real senders are not.
      const misses = `inbound-miss:${req.ip}`;
      ctx.limiter.ensure(misses, RECEIVER_MISSES_PER_MINUTE, reply);
      const miss = () => {
        ctx.limiter.spend(misses, RECEIVER_MISSES_PER_MINUTE);
        return notFound("hook");
      };
      if (!isId("flow", flowId) || token.length > 128) throw miss();
      const salt = await inboundHookSalt(ctx.db, flowId);
      // While WEBHOOK_SIGNING_SECRET rotates, URLs made with the previous one keep working.
      const valid = salt !== null && (verifyInboundToken(ctx.webhookMaster, flowId, salt, token) || (ctx.webhookMasterPrevious !== null && verifyInboundToken(ctx.webhookMasterPrevious, flowId, salt, token)));
      if (!valid) throw miss();
      enforceRate(limiter, flowId, reply, "requests for this hook");

      const [flow] = await ctx.db
        .select({ status: flows.status, ownerId: flows.ownerId, plan: users.plan, definition: flowVersions.definition })
        .from(flows)
        .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
        .innerJoin(users, eq(users.id, flows.ownerId))
        .where(eq(flows.id, flowId));
      if (!flow || flow.definition.trigger.type !== "INBOUND_WEBHOOK") throw notFound("hook");
      if (flow.status !== "active") throw new ApiError(409, "flow_inactive", `the flow is ${flow.status}; resume it to accept requests`);

      // Storage is bounded: nothing is kept that could never run, and intake per flow per day is capped.
      const limits = planLimits(flow.plan);
      if (!limits.overage) {
        const period = usagePeriod(new Date(ctx.now()));
        const [usage] = await ctx.db
          .select({ runs: usageMonthly.runs })
          .from(usageMonthly)
          .where(and(eq(usageMonthly.userId, flow.ownerId), eq(usageMonthly.period, period)));
        if ((usage?.runs ?? 0) >= limits.runsPerMonth) {
          throw new ApiError(402, "plan_quota_exhausted", `the flow owner's ${flow.plan} plan has used all ${limits.runsPerMonth} runs of ${period}`);
        }
      }
      const [today] = await ctx.db
        .select({ n: count() })
        .from(inboundEvents)
        .where(and(eq(inboundEvents.flowId, flowId), gt(inboundEvents.receivedAt, new Date(ctx.now() - 86_400_000))));
      if (Number(today?.n ?? 0) >= ctx.inboundDailyLimit) {
        reply.header("retry-after", "3600");
        throw new ApiError(429, "daily_limit_reached", `this hook accepted ${ctx.inboundDailyLimit} requests in the last 24 hours`);
      }

      const rawKey = req.headers["idempotency-key"];
      const key = typeof rawKey === "string" ? rawKey.trim() : undefined;
      if (key !== undefined && (key.length < 1 || key.length > 200)) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-200 characters");

      const requestId = newId("inboundRequest");
      const body = normalizeBody(req.body);
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].slice(0, 200) : null;
      const bytes = Number(req.headers["content-length"] ?? Number.NaN);
      const inserted = await ctx.db
        .insert(inboundEvents)
        .values({
          requestId,
          flowId,
          dedupeKey: key ?? requestId,
          contentType,
          body,
          query: pickQuery(req.query),
          headers: pickHeaders(req),
          bytes: Number.isFinite(bytes) ? bytes : Buffer.byteLength(JSON.stringify(body)),
        })
        .onConflictDoNothing({ target: [inboundEvents.flowId, inboundEvents.dedupeKey] })
        .returning({ requestId: inboundEvents.requestId });
      if (inserted.length === 0) {
        const [existing] = await ctx.db
          .select({ requestId: inboundEvents.requestId })
          .from(inboundEvents)
          .where(and(eq(inboundEvents.flowId, flowId), eq(inboundEvents.dedupeKey, key ?? requestId)));
        return reply.code(202).send({ accepted: true, duplicate: true, request_id: existing?.requestId ?? null });
      }
      ctx.onInboundEvent();
      return reply.code(202).send({ accepted: true, duplicate: false, request_id: requestId });
    });
  });
}
