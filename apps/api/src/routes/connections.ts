import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { flowVersions, flows, onchainGrants } from "@ignitra/db";
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
  registerVigilWebhook,
  setVigilSecret,
  vigilApiBase,
  verifyOAuthState,
  webhookDestination,
} from "@ignitra/actions";
import { newId } from "@ignitra/core";
import { audit } from "../audit";
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
  z
    .object({
      type: z.literal("vigil"),
      label,
      /** VIGIL's API: the site followed by /api/v1 (default: the operator's VIGIL_API_URL). */
      api_url: z
        .string()
        .trim()
        .max(500)
        .refine(
          (u) => {
            try {
              const p = new URL(u);
              return (p.protocol === "https:" || p.protocol === "http:") && !p.username && !p.password;
            } catch {
              return false;
            }
          },
          { message: "VIGIL's API URL, e.g. https://vigil.example/api/v1" },
        )
        .optional(),
      /**
       * `vgl_…`: used once to register IGNITRA's receiver in VIGIL, then forgotten. Without it, you
       * register the receiver URL in VIGIL yourself and send its secret to …/verify.
       */
      api_key: z.string().trim().min(8).max(300).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("mandate"),
      label,
      /** The MANDATE policy endpoint IGNITRA asks before each onchain action. */
      url: z.string().trim().min(1).max(2048),
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
        await audit(ctx, req, "connection.created", { type: "connection", id: conn.id }, { type: conn.type, label: conn.label });
        return reply.code(201).send({ data: connectionView(conn) });
      }
      if (body.type === "email") {
        if (!ctx.email) throw new ApiError(503, "not_configured", "email is not configured on this server (EMAIL_PROVIDER / EMAIL_API_KEY / EMAIL_FROM)");
        const conn = await startEmailConnection(ctx.db, ctx.keyring, ctx.http, ctx.email, { ownerId: me.userId, address: body.address, ...(body.label ? { label: body.label } : {}) });
        // Unverified until the user enters the code: flows refuse it until then.
        await audit(ctx, req, "connection.created", { type: "connection", id: conn.id }, { type: conn.type, label: conn.label });
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
        await audit(ctx, req, "connection.created", { type: "connection", id: conn.id }, { type: conn.type, label: conn.label });
        return reply.code(201).send({ data: connectionView(conn), ...(dest.signingSecret ? { signing_secret: dest.signingSecret } : {}) });
      }
      if (body.type === "vigil") {
        const id = newId("connection");
        const receiverUrl = `${ctx.publicUrl}/v1/integrations/vigil/${id}`;
        // Without a key the user registers the receiver URL in VIGIL, which then shows a secret
        // once: it comes back through …/verify, and deliveries wait for it.
        let secret: Record<string, unknown> = {};
        let metadata: Record<string, unknown> = { mode: "manual", receiver_url: receiverUrl, verified: false };
        if (body.api_key !== undefined) {
          const apiUrl = body.api_url ?? ctx.vigilApiUrl;
          if (!apiUrl) throw new ApiError(400, "invalid_request", "api_url is required: VIGIL's API, e.g. https://vigil.example/api/v1");
          const created = await registerVigilWebhook(ctx.http, { apiUrl, apiKey: body.api_key, receiverUrl });
          secret = { webhook_secret: created.secret };
          metadata = { mode: "auto", vigil_host: new URL(vigilApiBase(apiUrl)).host, vigil_webhook_id: created.webhookId, receiver_url: receiverUrl };
        }
        const conn = await createConnection(ctx.db, ctx.keyring, {
          id,
          ownerId: me.userId,
          type: "vigil",
          label: body.label ?? fitLabel(metadata.vigil_host ? `VIGIL ${String(metadata.vigil_host)}` : "VIGIL"),
          secret,
          metadata,
        });
        reply.header("cache-control", "no-store");
        await audit(ctx, req, "connection.created", { type: "connection", id: conn.id }, { type: conn.type, label: conn.label });
        return reply.code(201).send({
          data: connectionView(conn),
          receiver_url: receiverUrl,
          ...(metadata.mode === "manual" ? { next: `Register receiver_url as a webhook in VIGIL, then send the signing secret VIGIL shows to POST /v1/connections/${id}/verify as webhook_secret.` } : {}),
        });
      }
      if (body.type === "mandate") {
        const dest = webhookDestination(body.url, { allowPrivate: ctx.allowPrivateOutbound });
        const conn = await createConnection(ctx.db, ctx.keyring, {
          ownerId: me.userId,
          type: "mandate",
          label: body.label ?? fitLabel(`MANDATE ${String(dest.metadata.host)}`),
          secret: dest.secret,
          metadata: dest.metadata,
        });
        reply.header("cache-control", "no-store");
        // MANDATE verifies IGNITRA's policy requests with it: shown exactly once.
        await audit(ctx, req, "connection.created", { type: "connection", id: conn.id }, { type: conn.type, label: conn.label });
        return reply.code(201).send({ data: connectionView(conn), signing_secret: dest.signingSecret });
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
      await audit(ctx, req, "connection.created", { type: "connection", id: conn.id }, { type: conn.type, label: conn.label });
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
    // An email address proves itself with the code we sent; a manual VIGIL connection with the secret VIGIL showed.
    const body = parse(
      z.union([z.object({ code: z.string().trim().regex(/^\d{6}$/, { message: "the code has 6 digits" }) }).strict(), z.object({ webhook_secret: z.string().trim().min(16).max(300) }).strict()]),
      req.body,
    );
    try {
      const conn =
        "webhook_secret" in body
          ? await setVigilSecret(ctx.db, ctx.keyring, { id: req.params.id, ownerId: me.userId, secret: body.webhook_secret })
          : await verifyEmailConnection(ctx.db, ctx.keyring, { id: req.params.id, ownerId: me.userId, code: body.code });
      await audit(ctx, req, "connection.verified", { type: "connection", id: conn.id }, { type: conn.type });
      return { data: connectionView(conn) };
    } catch (err) {
      if (err instanceof ConnectionError) {
        const missing = err.message === "connection not found";
        throw new ApiError(missing ? 404 : 422, missing ? "not_found" : "webhook_secret" in body ? "invalid_connection" : "invalid_code", err.message);
      }
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
    const [target] = await ctx.db.select({ type: connectionsTable.type, label: connectionsTable.label }).from(connectionsTable).where(and(eq(connectionsTable.id, id), eq(connectionsTable.ownerId, me.userId)));
    // Refuse while a flow's current version still uses it (a step sends through it, or its trigger
    // listens on it): the flow would fail permanently.
    const users = await ctx.db
      .select({ id: flows.id, name: flows.name })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
      .where(
        and(
          eq(flows.ownerId, me.userId),
          ne(flows.status, "disabled"),
          or(
            sql`${flowVersions.definition} -> 'actions' @> ${JSON.stringify([{ params: { connection_id: id } }])}::jsonb`,
            sql`${flowVersions.definition} -> 'trigger' -> 'params' ->> 'connection_id' = ${id}`,
          ),
        ),
      );
    if (users.length > 0) {
      throw new ApiError(409, "connection_in_use", `used by ${users.length} flow(s): ${users.map((f) => `${f.name} (${f.id})`).join(", ")}; change or delete those flows first`, {
        flows: users.map((f) => f.id),
      });
    }
    // A MANDATE policy stays while a grant that must pass it can still act.
    const grants = await ctx.db
      .select({ id: onchainGrants.id, label: onchainGrants.label })
      .from(onchainGrants)
      .where(and(eq(onchainGrants.ownerId, me.userId), eq(onchainGrants.mandateConnectionId, id), inArray(onchainGrants.status, ["pending", "active"])));
    const inUseByGrants = (found: Array<{ id: string; label: string }>) =>
      new ApiError(409, "connection_in_use", `the MANDATE policy of ${found.length} onchain grant(s): ${found.map((g) => `${g.label} (${g.id})`).join(", ")}; revoke them first`, { grants: found.map((g) => g.id) });
    if (grants.length > 0) throw inUseByGrants(grants);
    let deleted: boolean;
    try {
      deleted = await ctx.db.transaction(async (t) => {
        const tx = t as unknown as typeof ctx.db;
        // Revoked and expired grants can never act again: they let go of it.
        await tx
          .update(onchainGrants)
          .set({ mandateConnectionId: null })
          .where(and(eq(onchainGrants.ownerId, me.userId), eq(onchainGrants.mandateConnectionId, id), inArray(onchainGrants.status, ["revoked", "expired"])));
        return deleteConnection(tx, id, me.userId);
      });
    } catch (err) {
      // A grant naming it was created meanwhile: the database keeps the link (foreign key).
      if ((err as { code?: unknown }).code === "23503" || /foreign key/i.test((err as Error).message)) throw inUseByGrants([]);
      throw err;
    }
    if (!deleted) throw notFound("connection");
    await audit(ctx, req, "connection.deleted", { type: "connection", id }, { type: target?.type ?? null, label: target?.label ?? null });
    return reply.code(204).send();
  });
}

/**
 * OAuth callback. Public route (Google redirects the browser here) that checks the
 * session cookie itself, so every outcome ends on a page of the web app instead of JSON.
 */
export function registerGoogleCallback(app: FastifyInstance, ctx: ApiContext): void {
  const auth = authenticate({ db: ctx.db, corsOrigins: ctx.corsOrigins, now: ctx.now, limiter: ctx.limiter, sessionPerMinute: ctx.rates.sessionPerMinute });
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
      await audit(ctx, req, "connection.created", { type: "connection", id: conn.id }, { type: conn.type, label: conn.label });
      return back(reply, { google: "connected", connection: conn.id });
    } catch (err) {
      if (err instanceof GoogleAuthError) return back(reply, { google_error: err.message });
      ctx.logger.warn({ err }, "google oauth failed");
      return back(reply, { google_error: "could not reach Google; try again" });
    }
  });
}
