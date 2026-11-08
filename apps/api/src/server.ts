import Fastify, { type FastifyBaseLogger, type FastifyError } from "fastify";
import type { ActionRegistry, ChainConfig, ChainTxClient, SafeHttpClient } from "@ignitra/core";
import type { Keyring, Logger } from "@ignitra/core/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AbiRegistry, ChainReader } from "@ignitra/chain";
import { FlowNotFoundError, FlowValidationError, PlanLimitError, TokenInfo, createTriggerModules, type TriggerModuleRegistry, type TrustLookup } from "@ignitra/engine";
import { createActionModules, createSafeHttp, type EmailConfig, type GoogleConfig } from "@ignitra/actions";
import { planFor } from "@ignitra/core";
import { chainSyncStatus, type DbHandle } from "@ignitra/db";
import { authenticate, type AuthOptions } from "./auth";
import type { ApiContext } from "./context";
import { ApiError, CallerLimiter } from "./http";
import { registerApiKeyRoutes } from "./routes/api-keys";
import { registerAuditRoutes } from "./audit";
import { registerIntegrationRoutes } from "./routes/integrations";
import { registerOnchainRoutes } from "./routes/onchain";
import { registerAccountRoutes } from "./routes/account";
import { registerAuthRoutes } from "./routes/auth";
import { registerBuilderRoutes } from "./routes/builder";
import { registerConnectionRoutes, registerGoogleCallback } from "./routes/connections";
import { registerDemoRoutes } from "./routes/demo";
import { registerPublicTemplateRoutes, registerTemplateRoutes } from "./routes/templates";
import { registerFlowRoutes } from "./routes/flows";
import { registerHookRoutes } from "./routes/hooks";

export interface ServerDeps {
  readonly db: DbHandle;
  readonly chain: ChainConfig;
  readonly logger: Logger;
  readonly version: string;
  /** DB ping budget for /health. */
  readonly healthTimeoutMs?: number;
  /** Listener heartbeat older than this is reported as stale. */
  readonly listenerStaleMs?: number;
  readonly triggers?: TriggerModuleRegistry;
  readonly actions?: ActionRegistry;
  /** Browsers need it to subscribe to Web Push (null when push is not configured). */
  readonly vapidPublicKey?: string | null;
  // ---- accounts & flows API (Phase 5) ----
  /** Web app origins allowed to call the API with credentials (CORS + CSRF check). */
  readonly corsOrigins?: readonly string[];
  readonly auth?: Partial<AuthOptions>;
  /** Public base URL of this API (inbound hook URLs). */
  readonly publicUrl?: string;
  readonly reader?: ChainReader | null;
  readonly abis?: AbiRegistry | null;
  readonly keyring?: Keyring | null;
  readonly webhookMaster?: string | null;
  readonly webhookMasterPrevious?: string | null;
  readonly http?: SafeHttpClient;
  readonly allowPrivateOutbound?: boolean;
  readonly telegramApiBase?: string;
  readonly inboundRatePerMinute?: number;
  readonly inboundDailyLimit?: number;
  /** Default VIGIL API for VIGIL connections. */
  readonly vigilApiUrl?: string | null;
  /** Chain reads / receipts for onchain grants. */
  readonly chainTx?: ChainTxClient | null;
  /** Every onchain grant must name a MANDATE policy (default true, as the spec requires). */
  readonly mandateRequired?: boolean;
  /** TRUST LAYER scores for samples and test runs (null: not configured). */
  readonly trust?: TrustLookup | null;
  /** Anonymous requests per client address and minute (public routes). */
  readonly publicRatePerMinute?: number;
  /** Requests per signed-in user and minute (API keys carry their own rate). */
  readonly sessionRatePerMinute?: number;
  /** Behind a reverse proxy: take the client IP from X-Forwarded-For (true, or the proxy addresses). */
  readonly trustProxy?: boolean | string[];
  readonly email?: EmailConfig | null;
  readonly google?: GoogleConfig | null;
  /** The web app URL (OAuth returns there). Default: the first CORS origin. */
  readonly webUrl?: string;
  readonly confirmationDepth?: number;
  /** A TEST run was queued (single process: wake the runner). */
  readonly onRunQueued?: () => void;
  /** The flow the landing page shows live (DEMO_FLOW_ID). */
  readonly demoFlowId?: string | null;
  /** Called after an inbound webhook request is stored (single process: wake the matcher). */
  readonly onInboundEvent?: () => void;
  readonly now?: () => number;
}

/** Public action catalog: params as JSON Schema, output fields for {{steps.<id>.*}}. */
function actionCatalog(registry: ActionRegistry) {
  return registry.list().map((a) => ({
    type: a.type,
    label: a.label,
    description: a.description,
    connection_type: a.connectionType,
    connection_optional: a.connectionOptional ?? false,
    min_plan: planFor(a.type),
    params_schema: z.toJSONSchema(a.paramsSchema, { io: "input", unrepresentable: "any" }),
    output_fields: a.outputFields,
  }));
}

/** Public trigger catalog (builder + docs): params as JSON Schema, payload fields for conditions/templates. */
function triggerCatalog(registry: TriggerModuleRegistry) {
  return registry.list().map((m) => {
    let fields: unknown[] = [];
    try {
      fields = [...m.fields({} as never)];
    } catch {
      fields = [];
    }
    return {
      type: m.type,
      kind: m.kind,
      source: m.source,
      label: m.label,
      description: m.description,
      supports_fast: m.supportsFast,
      min_plan: planFor(m.type),
      params_schema: z.toJSONSchema(m.paramsSchema, { io: "input", unrepresentable: "any" }),
      fields,
    };
  });
}

export type ListenerHealth =
  | { status: "unknown" }
  | {
      status: "ok" | "stale" | "lagging";
      head: number;
      confirmed_cursor: number;
      lag_blocks: number;
      watches: number;
      last_tick_at: string;
      heartbeat_age_s: number;
      last_error: string | null;
    };

export interface ApiErrorBody {
  error: { code: string; message: string; [k: string]: unknown };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function readListener(deps: ServerDeps): Promise<ListenerHealth> {
  try {
    const [row] = await deps.db.db.select().from(chainSyncStatus).where(eq(chainSyncStatus.chainId, deps.chain.id));
    if (!row) return { status: "unknown" };
    const ageMs = Date.now() - row.lastTickAt.getTime();
    const lag = row.confirmedHead - row.confirmedCursor;
    const status = ageMs > (deps.listenerStaleMs ?? 60_000) ? "stale" : lag > 600 ? "lagging" : "ok";
    return {
      status,
      head: row.headBlock,
      confirmed_cursor: row.confirmedCursor,
      lag_blocks: lag,
      watches: row.watchCount,
      last_tick_at: row.lastTickAt.toISOString(),
      heartbeat_age_s: Math.round(ageMs / 1000),
      last_error: row.lastError,
    };
  } catch {
    return { status: "unknown" };
  }
}

const DEFAULT_ORIGINS = ["http://localhost:3000"];

function context(deps: ServerDeps, triggers: TriggerModuleRegistry, actions: ActionRegistry): ApiContext {
  const corsOrigins = deps.corsOrigins ?? DEFAULT_ORIGINS;
  const publicUrl = (deps.publicUrl ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
  const allowPrivateOutbound = deps.allowPrivateOutbound ?? false;
  return {
    db: deps.db.db,
    chain: deps.chain,
    logger: deps.logger,
    triggers,
    actions,
    flowDeps: { db: deps.db.db, chainId: deps.chain.id, triggers, actions, prepare: { abis: deps.abis ?? null } },
    reader: deps.reader ?? null,
    tokens: deps.reader ? new TokenInfo(deps.reader) : null,
    abis: deps.abis ?? null,
    confirmationDepth: deps.confirmationDepth ?? 20,
    email: deps.email ?? null,
    google: deps.google ?? null,
    webUrl: (deps.webUrl ?? corsOrigins[0] ?? "http://localhost:3000").replace(/\/+$/, ""),
    onRunQueued: deps.onRunQueued ?? (() => {}),
    demoFlowId: deps.demoFlowId ?? null,
    keyring: deps.keyring ?? null,
    webhookMaster: deps.webhookMaster ?? null,
    webhookMasterPrevious: deps.webhookMasterPrevious ?? null,
    http: deps.http ?? createSafeHttp({ allowPrivate: allowPrivateOutbound }),
    allowPrivateOutbound,
    telegramApiBase: deps.telegramApiBase,
    publicUrl,
    corsOrigins,
    auth: {
      domains: deps.auth?.domains ?? corsOrigins.map((o) => new URL(o).host),
      sessionTtlMs: deps.auth?.sessionTtlMs ?? 7 * 24 * 3600_000,
      secureCookies: deps.auth?.secureCookies ?? publicUrl.startsWith("https://"),
    },
    inboundRatePerMinute: deps.inboundRatePerMinute ?? 60,
    inboundDailyLimit: deps.inboundDailyLimit ?? 5000,
    vapidPublicKey: deps.vapidPublicKey ?? null,
    onInboundEvent: deps.onInboundEvent ?? (() => {}),
    now: deps.now ?? Date.now,
    limiter: new CallerLimiter(deps.now ?? Date.now),
    trust: deps.trust ?? null,
    vigilApiUrl: deps.vigilApiUrl ?? null,
    chainTx: deps.chainTx ?? null,
    mandateRequired: deps.mandateRequired ?? true,
    rates: { publicPerMinute: deps.publicRatePerMinute ?? 300, sessionPerMinute: deps.sessionRatePerMinute ?? 600 },
  };
}

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({
    // pino is a FastifyBaseLogger; typing it as such keeps route plugins on the default instance type.
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    // Behind a reverse proxy in production; set explicitly when deploying.
    trustProxy: deps.trustProxy ?? false,
  });
  const triggers = deps.triggers ?? createTriggerModules();
  const actions =
    deps.actions ?? createActionModules({ ...(deps.telegramApiBase ? { telegramApiBase: deps.telegramApiBase } : {}), email: deps.email ?? null, google: deps.google ?? null });
  const ctx = context(deps, triggers, actions);
  app.decorateRequest("auth", null);

  // Set before any plugin is registered: child scopes inherit the handlers at creation.
  app.setNotFoundHandler((req, reply) => {
    const body: ApiErrorBody = { error: { code: "not_found", message: `${req.method} ${req.url.split("?")[0]} not found` } };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.details } });
    if (err instanceof FlowValidationError) {
      return reply.code(422).send({ error: { code: "invalid_flow", message: "the flow definition is invalid", issues: err.issues } });
    }
    if (err instanceof PlanLimitError) {
      return reply.code(402).send({ error: { code: "plan_limit_reached", message: err.message, limit: err.limit, plan: err.plan, max: err.max } });
    }
    if (err instanceof FlowNotFoundError) return reply.code(404).send({ error: { code: "not_found", message: "flow not found" } });
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    const body: ApiErrorBody =
      status >= 500
        ? { error: { code: "internal_error", message: "Internal server error" } }
        : { error: { code: err.code ?? "bad_request", message: err.message } };
    return reply.code(status).send(body);
  });

  // CORS for the web app (credentials: the session cookie). Unknown origins get no CORS headers.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && ctx.corsOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
  });
  app.options("*", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && ctx.corsOrigins.includes(origin)) {
      reply.header("access-control-allow-methods", "GET, POST, PATCH, DELETE");
      reply.header("access-control-allow-headers", "authorization, content-type, idempotency-key");
      reply.header("access-control-max-age", "600");
    }
    return reply.code(204).send();
  });

  app.get("/health", async (_req, reply) => {
    let db: { status: "ok"; latency_ms: number } | { status: "error"; error: string };
    try {
      db = { status: "ok", latency_ms: await withTimeout(deps.db.ping(), deps.healthTimeoutMs ?? 2000) };
    } catch (err) {
      // Log the cause server-side; the response never carries driver errors (they can echo DSNs).
      app.log.warn({ err }, "health: database ping failed");
      db = { status: "error", error: "database unreachable" };
    }
    const listener = db.status === "ok" ? await readListener(deps) : { status: "unknown" as const };
    const ok = db.status === "ok";
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      service: "api",
      version: deps.version,
      chain: { id: deps.chain.id, name: deps.chain.name },
      db: { driver: deps.db.driver, ...db },
      // Informational: the API stays "ok" while the listener is down; alerting keys off this block.
      listener,
      time: new Date().toISOString(),
    });
  });

  // Inbound hooks and integration receivers carry their own limits.
  registerHookRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);

  // Public routes: limited per client address (behind a proxy, set TRUST_PROXY so this is the visitor).
  await app.register(async (pub) => {
    pub.addHook("onRequest", async (req, reply) => {
      // The landing page's live demo polls a 5-second cache: its own budget, so busy shared
      // addresses never starve sign-in or the template gallery (and the other way round).
      if (req.routeOptions.url === "/v1/demo") ctx.limiter.enforce(`ip-demo:${req.ip}`, ctx.rates.publicPerMinute * 4, reply);
      else ctx.limiter.enforce(`ip:${req.ip}`, ctx.rates.publicPerMinute, reply);
    });
    const triggersJson = triggerCatalog(triggers);
    pub.get("/v1/triggers", async () => ({ data: triggersJson }));
    const actionsJson = actionCatalog(actions);
    pub.get("/v1/actions", async () => ({ data: actionsJson }));
    pub.get("/v1/push/vapid-public-key", async () => ({ public_key: ctx.vapidPublicKey }));
    registerAuthRoutes(pub, ctx);
    registerGoogleCallback(pub, ctx);
    registerPublicTemplateRoutes(pub, ctx);
    registerDemoRoutes(pub, ctx);
  });

  await app.register(async (scope) => {
    scope.addHook("onRequest", authenticate({ db: ctx.db, corsOrigins: ctx.corsOrigins, now: ctx.now, limiter: ctx.limiter, sessionPerMinute: ctx.rates.sessionPerMinute }));
    registerAccountRoutes(scope, ctx);
    registerApiKeyRoutes(scope, ctx);
    registerAuditRoutes(scope, ctx);
    registerOnchainRoutes(scope, ctx);
    registerConnectionRoutes(scope, ctx);
    registerFlowRoutes(scope, ctx);
    registerBuilderRoutes(scope, ctx);
    registerTemplateRoutes(scope, ctx);
  });

  return app;
}
