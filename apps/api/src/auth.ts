import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { decodeFunctionResult, encodeFunctionData, hashMessage, parseAbi, recoverAddress, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { isValidAddress, newId, normalizeAddress, planLimits, type NormalizedAddress, type Plan } from "@ignitra/core";
import { RpcQueryError, type ChainReader } from "@ignitra/chain";
import { apiKeys, authNonces, sessions, users, type Database } from "@ignitra/db";
import { ApiError, readCookie, type CallerLimiter } from "./http";

/**
 * Sign-In with Ethereum (EIP-4361). No passwords, no private keys:
 *
 *   GET  /v1/auth/nonce   → single-use nonce (10 min)
 *   POST /v1/auth/verify  { message, signature } → session (HttpOnly cookie + bearer token)
 *
 * Checks: complete EIP-4361 message, domain allow-listed, uri on that domain,
 * chain id = Robinhood Chain, time bounds, nonce unused and unexpired, and the
 * signature: ECDSA recovery for wallets (EOAs), ERC-1271 `isValidSignature`
 * on-chain for smart-contract wallets. The nonce is deleted atomically on
 * success, so a signed message can be redeemed exactly once.
 */

export const SESSION_COOKIE = "ignitra_session";
export const NONCE_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;

export interface AuthOptions {
  /** Accepted SIWE `domain` values: host[:port] of the web app(s). */
  readonly domains: readonly string[];
  readonly sessionTtlMs: number;
  /** `Secure` cookies (HTTPS deployments). */
  readonly secureCookies: boolean;
}

export interface AuthContext {
  readonly userId: string;
  readonly address: NormalizedAddress;
  readonly plan: Plan;
  readonly timezone: string;
  /** The wallet session; null for API-key requests. */
  readonly sessionId: string | null;
  readonly apiKeyId: string | null;
  readonly via: "cookie" | "bearer" | "api_key";
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export async function issueNonce(db: Database, now: number): Promise<{ nonce: string; expiresAt: Date }> {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(now + NONCE_TTL_MS);
  await db.insert(authNonces).values({ nonce, expiresAt });
  // Opportunistic cleanup keeps the table small without a scheduler.
  await db.delete(authNonces).where(lt(authNonces.expiresAt, new Date(now)));
  return { nonce, expiresAt };
}

const ERC1271_ABI = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const ERC1271_MAGIC = "0x1626ba7e";

/** EOA signature (ECDSA recovery), else ERC-1271 for contract wallets. */
export async function verifyWalletSignature(reader: ChainReader | null, address: NormalizedAddress, message: string, signature: Hex): Promise<boolean> {
  const hash = hashMessage(message);
  try {
    if ((await recoverAddress({ hash, signature })).toLowerCase() === address) return true;
  } catch {
    // not a 65-byte ECDSA signature: maybe a smart-contract wallet
  }
  if (!reader) return false;
  // The node answered "no" (revert, pruned state) → not valid. Anything else (node down,
  // wrong chain configured) is an outage: fail closed, but say so instead of "bad signature".
  const outage = (err: unknown) => {
    if (err instanceof RpcQueryError) return false;
    throw new ApiError(503, "chain_unavailable", "could not reach the chain to verify a smart-wallet signature; try again");
  };
  let code: `0x${string}`;
  try {
    code = await reader.getCode(address);
  } catch (err) {
    return outage(err);
  }
  if (code === "0x") return false;
  let data: `0x${string}`;
  try {
    data = await reader.call({ to: address, data: encodeFunctionData({ abi: ERC1271_ABI, functionName: "isValidSignature", args: [hash, signature] }) });
  } catch (err) {
    return outage(err);
  }
  try {
    return decodeFunctionResult({ abi: ERC1271_ABI, functionName: "isValidSignature", data }).toLowerCase() === ERC1271_MAGIC;
  } catch {
    return false; // malformed answer: not a valid ERC-1271 response
  }
}

const validDate = (d: Date | undefined): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

export interface VerifiedSignIn {
  readonly address: NormalizedAddress;
  readonly chainId: number;
}

export async function verifySiwe(
  deps: { db: Database; reader: ChainReader | null; chainId: number; auth: AuthOptions; now: number },
  input: { message: string; signature: Hex },
): Promise<VerifiedSignIn> {
  const fail = (code: string, message: string) => new ApiError(401, code, message);
  const f = parseSiweMessage(input.message);
  if (!f.address || !f.domain || !f.nonce || !f.uri || !f.version || f.chainId === undefined || !validDate(f.issuedAt)) {
    throw fail("invalid_message", "not a complete Sign-In with Ethereum (EIP-4361) message");
  }
  if (f.version !== "1") throw fail("invalid_message", "unsupported SIWE version");
  if (!isValidAddress(f.address)) throw fail("invalid_message", "address is not a valid (checksummed) address");
  if (!deps.auth.domains.includes(f.domain)) throw fail("domain_mismatch", `sign-in is accepted for ${deps.auth.domains.join(", ")}, not ${f.domain}`);
  let uriHost: string;
  try {
    uriHost = new URL(f.uri).host;
  } catch {
    throw fail("invalid_message", "uri is not a valid URL");
  }
  if (uriHost !== f.domain) throw fail("domain_mismatch", "uri must be on the signing domain");
  if (f.chainId !== deps.chainId) throw fail("wrong_chain", `sign in on chain ${deps.chainId} (Robinhood Chain), not chain ${f.chainId}`);
  if (f.issuedAt.getTime() > deps.now + CLOCK_SKEW_MS) throw fail("invalid_message", "issuedAt is in the future");
  if (f.expirationTime !== undefined && (!validDate(f.expirationTime) || f.expirationTime.getTime() <= deps.now)) throw fail("message_expired", "the message has expired");
  if (f.notBefore !== undefined && (!validDate(f.notBefore) || f.notBefore.getTime() > deps.now + CLOCK_SKEW_MS)) throw fail("invalid_message", "the message is not valid yet");

  const live = and(eq(authNonces.nonce, f.nonce), gt(authNonces.expiresAt, new Date(deps.now)));
  const [pending] = await deps.db.select({ nonce: authNonces.nonce }).from(authNonces).where(live);
  if (!pending) throw fail("invalid_nonce", "nonce expired or already used; request a new one");

  const address = normalizeAddress(f.address);
  if (!(await verifyWalletSignature(deps.reader, address, input.message, input.signature))) {
    throw fail("invalid_signature", "the signature does not match the address in the message");
  }
  // Single use: of concurrent verifications of one message, exactly one deletes the nonce.
  const consumed = await deps.db.delete(authNonces).where(live).returning({ nonce: authNonces.nonce });
  if (consumed.length === 0) throw fail("invalid_nonce", "nonce expired or already used; request a new one");
  return { address, chainId: f.chainId };
}

// ---- sessions -------------------------------------------------------------------

export async function createSession(
  db: Database,
  input: { userId: string; chainId: number; userAgent: string | undefined; ttlMs: number; now: number },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = `igs_${randomBytes(32).toString("base64url")}`;
  const sessionId = newId("session");
  const expiresAt = new Date(input.now + input.ttlMs);
  await db.insert(sessions).values({
    id: sessionId,
    userId: input.userId,
    tokenHash: sha256(token),
    chainId: input.chainId,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    expiresAt,
  });
  await db.delete(sessions).where(and(eq(sessions.userId, input.userId), lt(sessions.expiresAt, new Date(input.now))));
  return { token, sessionId, expiresAt };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m?.[1] ?? null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ---- API keys ---------------------------------------------------------------------

export const API_KEY_PREFIX = "igk_";

/** A new API key: the secret is returned to the user once; only the hash and prefix are stored. */
export function generateApiKey(): { token: string; prefix: string; hash: string } {
  const token = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, prefix: token.slice(0, 12), hash: sha256(token) };
}

export interface AuthDeps {
  readonly db: Database;
  readonly corsOrigins: readonly string[];
  readonly now: () => number;
  readonly limiter: CallerLimiter;
  readonly sessionPerMinute: number;
}

/**
 * onRequest hook for authenticated routes. Accepts:
 *   - `Authorization: Bearer igk_…`: an API key (Team plan), limited per key;
 *   - `Authorization: Bearer igs_…` or the HttpOnly session cookie: a wallet session, limited per user.
 * Cookie-authenticated writes must come from an allow-listed Origin (CSRF protection on top of
 * SameSite=Lax). Bearer credentials are not sent by browsers on their own, so they need no Origin.
 */
export function authenticate(deps: AuthDeps) {
  const lastUsedWrites = new Map<string, number>();
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const fromHeader = bearer(req);
    if (fromHeader?.startsWith(API_KEY_PREFIX)) {
      const [key] = await deps.db
        .select({ keyId: apiKeys.id, rate: apiKeys.ratePerMinute, userId: users.id, address: users.address, plan: users.plan, timezone: users.timezone })
        .from(apiKeys)
        .innerJoin(users, eq(users.id, apiKeys.userId))
        .where(and(eq(apiKeys.tokenHash, sha256(fromHeader)), isNull(apiKeys.revokedAt)));
      if (!key) throw new ApiError(401, "invalid_api_key", "unknown or revoked API key");
      if (!planLimits(key.plan).apiKeys) {
        throw new ApiError(403, "plan_required", `API keys are part of the team plan; this account is on ${key.plan}. Wallet sessions keep working.`, { plan: key.plan, required: "team" });
      }
      deps.limiter.enforce(`key:${key.keyId}`, key.rate, reply);
      const now = deps.now();
      if ((lastUsedWrites.get(key.keyId) ?? 0) < now - 60_000) {
        lastUsedWrites.set(key.keyId, now);
        await deps.db.update(apiKeys).set({ lastUsedAt: new Date(now) }).where(eq(apiKeys.id, key.keyId));
      }
      req.auth = { userId: key.userId, address: key.address as NormalizedAddress, plan: key.plan, timezone: key.timezone, sessionId: null, apiKeyId: key.keyId, via: "api_key" };
      return;
    }

    const token = fromHeader ?? readCookie(req, SESSION_COOKIE);
    if (!token) throw new ApiError(401, "unauthenticated", "sign in with your wallet first (POST /v1/auth/verify), or send an API key");
    const [row] = await deps.db
      .select({ sessionId: sessions.id, userId: users.id, address: users.address, plan: users.plan, timezone: users.timezone })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), sql`${sessions.expiresAt} > ${new Date(deps.now())}`));
    if (!row) throw new ApiError(401, "unauthenticated", "session expired or signed out; sign in again");
    const via = fromHeader ? "bearer" : "cookie";
    if (via === "cookie" && !SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (!origin || !deps.corsOrigins.includes(origin)) throw new ApiError(403, "bad_origin", "cross-site request refused");
    }
    deps.limiter.enforce(`user:${row.userId}`, deps.sessionPerMinute, reply);
    req.auth = { userId: row.userId, address: row.address as NormalizedAddress, plan: row.plan, timezone: row.timezone, sessionId: row.sessionId, apiKeyId: null, via };
  };
}

/** Routes that manage credentials or sign-in itself answer wallet sessions only, never an API key. */
export function requireSession(req: FastifyRequest): AuthContext & { sessionId: string } {
  const auth = caller(req);
  if (auth.via === "api_key" || auth.sessionId === null) {
    throw new ApiError(403, "session_required", "this needs a signed-in wallet session; API keys cannot manage credentials");
  }
  return auth as AuthContext & { sessionId: string };
}

/** The authenticated caller (routes behind `authenticate`). */
export function caller(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new ApiError(401, "unauthenticated", "sign in first");
  return req.auth;
}
