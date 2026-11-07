import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { flowVersions, flows } from "@ignitra/db";
import { ConnectionError, createConnection, deleteConnection, inspectTelegramDestination, listConnections, webhookDestination } from "@ignitra/actions";
import { caller } from "../auth";
import type { ApiContext } from "../context";
import { ApiError, notFound, parse } from "../http";
import { connectionView } from "../views";

const label = z.string().trim().min(1).max(120).optional();

const createBody = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("telegram"),
      label,
      /** From @BotFather. Verified with Telegram, stored encrypted, never returned. */
      bot_token: z.string().trim().min(1).max(200),
      chat_id: z.union([z.string().trim().min(1).max(64), z.number().int()]),
      thread_id: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("webhook"),
      label,
      url: z.string().trim().min(1).max(2048),
    })
    .strict(),
]);

/** Authenticated: connections are credentials for destinations; secrets go in, never out. */
export function registerConnectionRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get("/v1/connections", async (req) => {
    const me = caller(req);
    return { data: (await listConnections(ctx.db, me.userId)).map(connectionView) };
  });

  app.post("/v1/connections", async (req, reply) => {
    const me = caller(req);
    if (!ctx.keyring) throw new ApiError(503, "not_configured", "connections are not available: ENCRYPTION_KEY is not configured on this server");
    const body = parse(createBody, req.body);
    try {
      if (body.type === "telegram") {
        const chatId = String(body.chat_id);
        const dest = await inspectTelegramDestination(ctx.http, {
          token: body.bot_token,
          chatId,
          ...(body.thread_id !== undefined ? { threadId: body.thread_id } : {}),
          ...(ctx.telegramApiBase ? { apiBase: ctx.telegramApiBase } : {}),
        });
        const title = typeof dest.metadata.chat_title === "string" ? dest.metadata.chat_title : null;
        const conn = await createConnection(ctx.db, ctx.keyring, {
          ownerId: me.userId,
          type: "telegram",
          label: body.label ?? (title ? `Telegram: ${title}` : `Telegram ${chatId}`),
          secret: dest.secret,
          metadata: dest.metadata,
        });
        return reply.code(201).send({ data: connectionView(conn) });
      }
      const dest = webhookDestination(body.url, { allowPrivate: ctx.allowPrivateOutbound });
      const conn = await createConnection(ctx.db, ctx.keyring, {
        ownerId: me.userId,
        type: "webhook",
        label: body.label ?? `Webhook ${String(dest.metadata.host)}`,
        secret: dest.secret,
        metadata: dest.metadata,
      });
      reply.header("cache-control", "no-store");
      // Shown exactly once: configure the receiver with it now.
      return reply.code(201).send({ data: connectionView(conn), signing_secret: dest.signingSecret });
    } catch (err) {
      if (err instanceof ConnectionError) throw new ApiError(422, "invalid_connection", err.message);
      if (err instanceof Error && err.name === "SsrfBlockedError") throw new ApiError(422, "invalid_connection", err.message);
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/connections/:id", async (req, reply) => {
    const me = caller(req);
    const id = req.params.id;
    // Refuse while a flow's current version still sends through it: its steps would fail permanently.
    const users = await ctx.db
      .select({ id: flows.id, name: flows.name })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
      .where(
        and(
          eq(flows.ownerId, me.userId),
          ne(flows.status, "disabled"),
          sql`${flowVersions.definition} -> 'actions' @> ${JSON.stringify([{ params: { connection_id: id } }])}::jsonb`,
        ),
      );
    if (users.length > 0) {
      throw new ApiError(409, "connection_in_use", `used by ${users.length} flow(s): ${users.map((f) => `${f.name} (${f.id})`).join(", ")}; change or delete those flows first`, {
        flows: users.map((f) => f.id),
      });
    }
    if (!(await deleteConnection(ctx.db, id, me.userId))) throw notFound("connection");
    return reply.code(204).send();
  });
}
