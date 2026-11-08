import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newId, planLimits } from "@ignitra/core";
import { apiKeys, type ApiKeyRow } from "@ignitra/db";
import { generateApiKey, requireSession } from "../auth";
import type { ApiContext } from "../context";
import { ApiError, RateLimiter, enforceRate, iso, notFound, parse } from "../http";

/**
 * API keys for the public API and the SDK (Team plan). Managed from a wallet session
 * only: a leaked key cannot mint more keys or keep itself alive.
 *
 *   GET    /v1/api-keys        list (never the secret)
 *   POST   /v1/api-keys        { name } → 201 { data, key }: the secret, shown once
 *   DELETE /v1/api-keys/:id    revoke (immediate; the key answers 401 from then on)
 */

const MAX_ACTIVE_KEYS = 20;

const createBody = z.object({ name: z.string().trim().min(1).max(80) }).strict();

const view = (k: ApiKeyRow) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  rate_per_minute: k.ratePerMinute,
  created_at: iso(k.createdAt),
  last_used_at: iso(k.lastUsedAt),
  revoked_at: iso(k.revokedAt),
});

export function registerApiKeyRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const creates = new RateLimiter(20, 3_600_000, ctx.now);

  app.get("/v1/api-keys", async (req) => {
    const me = requireSession(req);
    const rows = await ctx.db.select().from(apiKeys).where(eq(apiKeys.userId, me.userId)).orderBy(desc(apiKeys.createdAt));
    return { data: rows.map(view) };
  });

  app.post("/v1/api-keys", async (req, reply) => {
    const me = requireSession(req);
    if (!planLimits(me.plan).apiKeys) {
      throw new ApiError(402, "plan_limit_reached", `API keys are part of the team plan; you are on ${me.plan}. Wallet sessions work on every plan.`, { limit: "api_keys", plan: me.plan, max: 0 });
    }
    enforceRate(creates, me.userId, reply, "new API keys this hour");
    const body = parse(createBody, req.body);
    const [active] = await ctx.db.select({ n: count() }).from(apiKeys).where(and(eq(apiKeys.userId, me.userId), isNull(apiKeys.revokedAt)));
    if (Number(active?.n ?? 0) >= MAX_ACTIVE_KEYS) throw new ApiError(409, "too_many_keys", `at most ${MAX_ACTIVE_KEYS} active keys; revoke unused ones first`);
    const key = generateApiKey();
    const [row] = await ctx.db.insert(apiKeys).values({ id: newId("apiKey"), userId: me.userId, name: body.name, prefix: key.prefix, tokenHash: key.hash }).returning();
    if (!row) throw new Error("api key insert returned nothing");
    ctx.logger.info({ userId: me.userId, keyId: row.id }, "api key created");
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ data: view(row), key: key.token });
  });

  app.delete<{ Params: { id: string } }>("/v1/api-keys/:id", async (req, reply) => {
    const me = requireSession(req);
    const revoked = await ctx.db
      .update(apiKeys)
      .set({ revokedAt: new Date(ctx.now()) })
      .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.userId, me.userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (revoked.length === 0) throw notFound("api key");
    ctx.logger.info({ userId: me.userId, keyId: req.params.id }, "api key revoked");
    return reply.code(204).send();
  });
}
