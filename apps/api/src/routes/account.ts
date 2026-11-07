import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidTimeZone, nextPeriodStart, planLimits, usagePeriod, type Plan } from "@ignitra/core";
import { flows, ownerNotifications, pushSubscriptions, usageMonthly, users } from "@ignitra/db";
import { PushSubscriptionError, addPushSubscription, deriveOwnerSigningSecret } from "@ignitra/actions";
import { SESSION_COOKIE, caller, revokeSession } from "../auth";
import type { ApiContext } from "../context";
import { ApiError, clampLimit, iso, parse, setCookie } from "../http";
import { notificationView, userView } from "../views";

export async function usageFor(ctx: ApiContext, userId: string, plan: Plan) {
  const now = new Date(ctx.now());
  const period = usagePeriod(now);
  const [u] = await ctx.db.select().from(usageMonthly).where(and(eq(usageMonthly.userId, userId), eq(usageMonthly.period, period)));
  const [active] = await ctx.db.select({ n: count() }).from(flows).where(and(eq(flows.ownerId, userId), eq(flows.status, "active")));
  const limits = planLimits(plan);
  const used = u?.runs ?? 0;
  return {
    period,
    resets_at: nextPeriodStart(now).toISOString(),
    runs: {
      used,
      included: limits.runsPerMonth,
      remaining: Math.max(0, limits.runsPerMonth - used),
      overage: limits.overage ? Math.max(0, used - limits.runsPerMonth) : 0,
      /** Matches that did not run because the quota was used up (free plan). */
      plan_limited: u?.planLimited ?? 0,
    },
    active_flows: { used: Number(active?.n ?? 0), limit: limits.activeFlows },
  };
}

const meBody = z.object({ timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, { message: "must be an IANA timezone such as Asia/Jakarta" }) }).strict();

const subscriptionBody = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  expirationTime: z.unknown().optional(),
});

/** Authenticated: profile, usage, sign-out, notifications, Web Push subscriptions. */
export function registerAccountRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post("/v1/auth/logout", async (req, reply) => {
    await revokeSession(ctx.db, caller(req).sessionId);
    setCookie(reply, SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: ctx.auth.secureCookies });
    return reply.code(204).send();
  });

  app.get("/v1/me", async (req) => {
    const me = caller(req);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, me.userId));
    if (!user) throw new ApiError(401, "unauthenticated", "account no longer exists");
    return { data: { ...userView(user), usage: await usageFor(ctx, user.id, user.plan) } };
  });

  app.patch("/v1/me", async (req) => {
    const me = caller(req);
    const body = parse(meBody, req.body);
    const [user] = await ctx.db.update(users).set({ timezone: body.timezone }).where(eq(users.id, me.userId)).returning();
    if (!user) throw new ApiError(401, "unauthenticated", "account no longer exists");
    return { data: userView(user) };
  });

  app.get("/v1/me/usage", async (req) => {
    const me = caller(req);
    return { data: { plan: me.plan, ...(await usageFor(ctx, me.userId, me.plan)) } };
  });

  // The owner's secret for verifying inline-URL webhook signatures (connection webhooks have their own).
  app.get("/v1/me/webhook-secret", async (req, reply) => {
    const me = caller(req);
    if (!ctx.webhookMaster) throw new ApiError(503, "not_configured", "webhook signing is not configured on this server (WEBHOOK_SIGNING_SECRET)");
    reply.header("cache-control", "no-store");
    return { data: { secret: deriveOwnerSigningSecret(ctx.webhookMaster, me.userId), header: "X-Ignitra-Signature", scheme: "v1=HMAC-SHA256(secret, \"<timestamp>.<raw body>\")" } };
  });

  app.get("/v1/notifications", async (req) => {
    const me = caller(req);
    const limit = clampLimit((req.query as Record<string, unknown>).limit, 50, 200);
    const rows = await ctx.db.select().from(ownerNotifications).where(eq(ownerNotifications.userId, me.userId)).orderBy(desc(ownerNotifications.createdAt)).limit(limit);
    return { data: rows.map(notificationView) };
  });

  app.post("/v1/push/subscriptions", async (req, reply) => {
    const me = caller(req);
    const body = parse(subscriptionBody, req.body);
    try {
      const id = await addPushSubscription(ctx.db, me.userId, { endpoint: body.endpoint, keys: body.keys }, req.headers["user-agent"]?.slice(0, 300) ?? null);
      return reply.code(201).send({ data: { id } });
    } catch (err) {
      if (err instanceof PushSubscriptionError) throw new ApiError(422, "invalid_subscription", err.message);
      throw err;
    }
  });

  app.delete("/v1/push/subscriptions", async (req, reply) => {
    const me = caller(req);
    const body = parse(z.object({ endpoint: z.string().min(1).max(2048) }), req.body);
    await ctx.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, body.endpoint), eq(pushSubscriptions.userId, me.userId)));
    return reply.code(204).send();
  });

  app.get("/v1/push/subscriptions", async (req) => {
    const me = caller(req);
    const rows = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, me.userId)).orderBy(desc(pushSubscriptions.createdAt));
    return {
      data: rows.map((s) => ({
        id: s.id,
        endpoint_host: new URL(s.endpoint).host,
        user_agent: s.userAgent,
        created_at: iso(s.createdAt),
        last_success_at: iso(s.lastSuccessAt),
        disabled_at: iso(s.disabledAt),
      })),
    };
  });
}
