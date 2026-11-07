import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { users } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE, createSession, issueNonce, verifySiwe } from "../auth";
import type { ApiContext } from "../context";
import { RateLimiter, enforceRate, iso, parse, setCookie } from "../http";
import { userView } from "../views";

const verifyBody = z.object({
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, { message: "must be 0x-prefixed hex" }).max(20_000),
  /** Non-browser clients (scripts, CLI) ask for a bearer token; browsers rely on the HttpOnly cookie only. */
  return_token: z.boolean().optional(),
});

/** Public sign-in endpoints (rate-limited per IP). */
export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const nonces = new RateLimiter(30, 60_000, ctx.now);
  const verifies = new RateLimiter(20, 60_000, ctx.now);

  app.get("/v1/auth/nonce", async (req, reply) => {
    enforceRate(nonces, req.ip, reply, "nonce requests");
    const { nonce, expiresAt } = await issueNonce(ctx.db, ctx.now());
    reply.header("cache-control", "no-store");
    return { nonce, expires_at: iso(expiresAt), domains: ctx.auth.domains, chain_id: ctx.chain.id };
  });

  app.post("/v1/auth/verify", async (req, reply) => {
    enforceRate(verifies, req.ip, reply, "sign-in attempts");
    const body = parse(verifyBody, req.body);
    const signIn = await verifySiwe(
      { db: ctx.db, reader: ctx.reader, chainId: ctx.chain.id, auth: ctx.auth, now: ctx.now() },
      { message: body.message, signature: body.signature as `0x${string}` },
    );
    const userId = await ensureUser(ctx.db, signIn.address);
    const session = await createSession(ctx.db, { userId, chainId: signIn.chainId, userAgent: req.headers["user-agent"], ttlMs: ctx.auth.sessionTtlMs, now: ctx.now() });
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error("user vanished after sign-in");
    setCookie(reply, SESSION_COOKIE, session.token, { maxAgeSeconds: ctx.auth.sessionTtlMs / 1000, secure: ctx.auth.secureCookies });
    reply.header("cache-control", "no-store");
    ctx.logger.info({ userId, address: signIn.address }, "signed in");
    // Browsers never see the token (script injected into the page cannot steal the session);
    // non-browser clients opt in and send it as Authorization: Bearer.
    return { ...(body.return_token ? { token: session.token } : {}), expires_at: iso(session.expiresAt), user: userView(user) };
  });
}
