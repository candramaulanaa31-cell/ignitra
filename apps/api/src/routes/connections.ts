import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { flowVersions, flows } from "@ignitra/db";
import {
  ConnectionError,
  GoogleAuthError,
  createConnection,
  deleteConnection,
  exchangeGoogleCode,
  googleAuthUrl,
  httpDestination,
  fitLabel,
  inspectTelegramDestination,
  listConnections,
  resendEmailCode,
  signOAuthState,
  startEmailConnection,
  verifyEmailConnection,
  verifyOAuthState,
  webhookDestination,
} from "@ignitra/actions";
import { authenticate, caller } from "../auth";
import type { ApiContext } from "../context";
import { eq as eqOp } from "drizzle-orm";
import { connections as connectionsTable } from "@ignitra/db";
import { ApiError, RateLimiter, enforceRate, notFound, parse } from "../http";
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
  z
    .object({
      type: z.literal("email"),
      label,
      address: z.string().trim().min(3).max(254),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      label,
      /** Headers are only ever sent to this host. */
      host: z.string().trim().min(1).max(253),
      headers: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().min(1).max(4000) }).strict()).min(1).max(10),
      /** Give the connection its own signing secret (else the owner secret signs). */
      sign: z.boolean().optional(),
    })
    .strict(),
]);

/** Authenticated: connections are credentials for destinations; secrets go in, never out. */
/** Abuse bounds: creating a connection calls Telegram or sends an email to an address the user typed. */
const MAX_CONNECTIONS = 100;
const MAX_PENDING_EMAILS = 3;

export function registerConnectionRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const creates = new RateLimiter(30, 3_600_000, ctx.now);
  const emails = new RateLimiter(5, 3_600_000, ctx.now);
  app.get("/v1/connections", async (req) => {
    const me = caller(req);
    return { data: (await listConnections(ctx.db, me.userId)).map(connectionView) };
  });

  app.post("/v1/connections", async (req, reply) => {
    const me = caller(req);
    if (!ctx.keyring) throw new ApiError(503, "not_configured", "connections are not available: ENCRYPTION_KEY is not configured on this server");
    const body = parse(createBody, req.body);
    enforceRate(creates, me.userId, reply, "new connections this hour");
    const mine = await ctx.db.select({ type: connectionsTable.type, metadata: connectionsTable.metadata }).from(connectionsTable).where(eqOp(connectionsTable.ownerId, me.userId));
    if (mine.length >= MAX_CONNECTIONS) throw new ApiError(409, "too_many_connections", `at most ${MAX_CONNECTIONS} connections; delete unused ones first`);
    if (body.type === "email") {
      // Verification mails go to addresses the user typed: bound them per user.
      if (mine.filter((c) => c.type === "email" && c.metadata.verified === false).length >= MAX_PENDING_EMAILS) {
        throw new ApiError(409, "too_many_pending", `verify or delete your ${MAX_PENDING_EMAILS} pending email addresses first`);
      }
      enforceRate(emails, me.userId, reply, "verification emails this hour");
    }
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
          label: body.label ?? fitLabel(title ? `Telegram: ${title}` : `Telegram ${chatId}`),
          secret: dest.secret,
          metadata: dest.metadata,
        });
        return reply.code(201).send({ data: connectionView(conn) });
      }
      if (body.type === "email") {
        if (!ctx.email) throw new ApiError(503, "not_configured", "email is not configured on this server (EMAIL_PROVIDER / EMAIL_API_KEY / EMAIL_FROM)");
        const conn = await startEmailConnection(ctx.db, ctx.keyring, ctx.http, ctx.email, { ownerId: me.userId, address: body.address, ...(body.label ? { label: body.label } : {}) });
        // Unverified until the user enters the code: flows refuse it until then.
        return reply.code(201).send({ data: connectionView(conn), verification: "sent" });
      }
      if (body.type === "http") {
        const dest = httpDestination({ host: body.host, headers: body.headers, ...(body.sign !== undefined ? { sign: body.sign } : {}) });
        const conn = await createConnection(ctx.db, ctx.keyring, {
          ownerId: me.userId,
          type: "http",
          label: body.label ?? fitLabel(`HTTP ${String(dest.metadata.host)}`),
          secret: dest.secret,
          metadata: dest.metadata,
        });
        reply.header("cache-control", "no-store");
        return reply.code(201).send({ data: connectionView(conn), ...(dest.signingSecret ? { signing_secret: dest.signingSecret } : {}) });
      }
      const dest = webhookDestination(body.url, { allowPrivate: ctx.allowPrivateOutbound });
      const conn = await createConnection(ctx.db, ctx.keyring, {
        ownerId: me.userId,
        type: "webhook",
        label: body.label ?? fitLabel(`Webhook ${String(dest.metadata.host)}`),
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

  app.post<{ Params: { id: string } }>("/v1/connections/:id/verify", async (req) => {
    const me = caller(req);
    if (!ctx.keyring) throw new ApiError(503, "not_configured", "connections are not available on this server");
    const body = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, { message: "the code has 6 digits" }) }).strict(), req.body);
    try {
      return { data: connectionView(await verifyEmailConnection(ctx.db, ctx.keyring, { id: req.params.id, ownerId: me.userId, code: body.code })) };
    } catch (err) {
      if (err instanceof ConnectionError) throw new ApiError(err.message === "connection not found" ? 404 : 422, err.message === "connection not found" ? "not_found" : "invalid_code", err.message);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/v1/connections/:id/resend", async (req, reply) => {
    const me = caller(req);
    if (!ctx.keyring || !ctx.email) throw new ApiError(503, "not_configured", "email is not configured on this server");
    try {
      await resendEmailCode(ctx.db, ctx.keyring, ctx.http, ctx.email, { id: req.params.id, ownerId: me.userId });
      return reply.code(202).send({ data: { verification: "sent" } });
    } catch (err) {
      if (err instanceof ConnectionError) throw new ApiError(err.message === "connection not found" ? 404 : 429, err.message === "connection not found" ? "not_found" : "resend_limited", err.message);
      throw err;
    }
  });

  // Google OAuth: the browser goes to Google and comes back to /v1/connections/google/callback.
  app.post("/v1/connections/google/start", async (req) => {
    const me = caller(req);
    if (!ctx.google || !ctx.keyring || !ctx.webhookMaster) {
      throw new ApiError(503, "not_configured", "Google is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)");
    }
    return { data: { url: googleAuthUrl(ctx.google, signOAuthState(ctx.webhookMaster, me.userId, ctx.now())) } };
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

/**
 * OAuth callback. Public route (Google redirects the browser here) that checks the
 * session cookie itself, so every outcome ends on a page of the web app instead of JSON.
 */
export function registerGoogleCallback(app: FastifyInstance, ctx: ApiContext): void {
  const auth = authenticate({ db: ctx.db, corsOrigins: ctx.corsOrigins, now: ctx.now });
  const back = (reply: FastifyReply, query: Record<string, string>) =>
    reply.redirect(`${ctx.webUrl}/app/connections?${new URLSearchParams(query).toString()}`, 302);

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/connections/google/callback", async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply) => {
    try {
      await auth(req, reply);
    } catch {
      return back(reply, { google_error: "sign in first, then connect Google again" });
    }
    const me = caller(req);
    const { code, state, error } = req.query;
    if (error) return back(reply, { google_error: error === "access_denied" ? "access was not granted" : error });
    if (!ctx.google || !ctx.keyring || !ctx.webhookMaster) return back(reply, { google_error: "Google is not configured on this server" });
    if (!code || !state || !verifyOAuthState(ctx.webhookMaster, state, me.userId, ctx.now())) return back(reply, { google_error: "the sign-in link expired or was not started here; try again" });
    try {
      const grant = await exchangeGoogleCode(ctx.http, ctx.google, code);
      const conn = await createConnection(ctx.db, ctx.keyring, {
        ownerId: me.userId,
        type: "google",
        label: fitLabel(`Google ${grant.email ?? "account"}`),
        secret: { refresh_token: grant.refreshToken },
        metadata: { email: grant.email, scopes: grant.scopes },
      });
      ctx.logger.info({ userId: me.userId, connectionId: conn.id }, "google connected");
      return back(reply, { google: "connected", connection: conn.id });
    } catch (err) {
      if (err instanceof GoogleAuthError) return back(reply, { google_error: err.message });
      ctx.logger.warn({ err }, "google oauth failed");
      return back(reply, { google_error: "could not reach Google; try again" });
    }
  });
}
