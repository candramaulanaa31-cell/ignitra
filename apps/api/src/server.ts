import Fastify, { type FastifyError } from "fastify";
import type { ChainConfig } from "@ignitra/core";
import type { Logger } from "@ignitra/core/server";
import type { DbHandle } from "@ignitra/db";

export interface ServerDeps {
  readonly db: DbHandle;
  readonly chain: ChainConfig;
  readonly logger: Logger;
  readonly version: string;
  /** DB ping budget for /health. */
  readonly healthTimeoutMs?: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
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

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 1024 * 1024,
    // Behind a reverse proxy in production; set explicitly when deploying.
    trustProxy: false,
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
    const ok = db.status === "ok";
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      service: "api",
      version: deps.version,
      chain: { id: deps.chain.id, name: deps.chain.name },
      db: { driver: deps.db.driver, ...db },
      time: new Date().toISOString(),
    });
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ApiErrorBody = { error: { code: "not_found", message: `${req.method} ${req.url} not found` } };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    const body: ApiErrorBody =
      status >= 500
        ? { error: { code: "internal_error", message: "Internal server error" } }
        : { error: { code: err.code ?? "bad_request", message: err.message } };
    return reply.code(status).send(body);
  });

  return app;
}
