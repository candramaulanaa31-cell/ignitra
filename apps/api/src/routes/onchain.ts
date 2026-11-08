import { and, count, desc, eq, gte, inArray, max } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { encodeFunctionData, formatEther, type Hex } from "viem";
import { z } from "zod";
import { normalizeAddress, planLimits, type ChainTxClient, type NormalizedAddress } from "@ignitra/core";
import { flowVersions, flows, onchainActions, onchainGrants, type Database, type OnchainActionRow, type OnchainGrantRow } from "@ignitra/db";
import {
  SAFE_ABI,
  activateGrant,
  createGrant,
  execTransactionByOwner,
  grantInputSchema,
  loadConnection,
  loadGrant,
  normalizeGrantScope,
  planGrant,
  revokeCall,
  revokeGrant,
  rolesAddressFor,
  safeModules,
  safeTransactionFor,
  txBuilderJson,
  verifyGrantTransaction,
  type GrantScope,
  type PlannedCall,
} from "@ignitra/actions";
import { audit } from "../audit";
import { caller, requireSession } from "../auth";
import type { ApiContext } from "../context";
import { ApiError, RateLimiter, clampLimit, enforceRate, iso, notFound, parse } from "../http";

/**
 * Onchain grants (Phase 8): scoped, revocable permissions from the user's Safe to an IGNITRA
 * session key, through Zodiac Roles v2. IGNITRA never holds the user's keys; the session key
 * it holds can do only what the Safe granted, and stops when revoked or expired.
 *
 *   GET  /v1/onchain/grants                list
 *   POST /v1/onchain/grants                create (wallet session, Team plan) → the Safe transaction to approve
 *   GET  /v1/onchain/grants/:id            one grant, its session key's gas balance, recent actions
 *   GET  /v1/onchain/review                every grant that can still act: what it allows, which flows use it, what to fix
 *   POST /v1/onchain/grants/revoke-all     revoke every live grant now (keys wiped) → per Safe, the transaction removing the roles
 *   POST /v1/onchain/grants/:id/verify     { tx_hash } → active, once the transaction is proven
 *   POST /v1/onchain/grants/:id/revoke     revoke now (key wiped) → the Safe transaction that removes the role
 *   GET  /v1/onchain/actions               every onchain action, with its transaction
 */

const verifyBody = z.object({ tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, { message: "a transaction hash" }) }).strict();

function grantView(g: OnchainGrantRow, explorer: string | null) {
  const scope = g.scope as unknown as GrantScope;
  return {
    id: g.id,
    label: g.label,
    status: g.status,
    chain_id: g.chainId,
    safe: g.safeAddress,
    roles: g.rolesAddress,
    role_key: g.roleKey,
    session_key: g.sessionKeyAddress,
    scope: {
      targets: scope.targets,
      max_value_per_tx: formatEther(BigInt(scope.max_value_per_tx_wei)),
      max_value_per_day: formatEther(BigInt(scope.max_value_per_day_wei)),
      expires_at: scope.expires_at,
    },
    mandate_connection_id: g.mandateConnectionId,
    grant_tx_hash: g.grantTxHash,
    grant_tx_url: g.grantTxHash && explorer ? `${explorer}/tx/${g.grantTxHash}` : null,
    expires_at: iso(g.expiresAt),
    created_at: iso(g.createdAt),
    activated_at: iso(g.activatedAt),
    revoked_at: iso(g.revokedAt),
  };
}

function actionView(a: OnchainActionRow, explorer: string | null) {
  return {
    id: a.id,
    grant_id: a.grantId,
    flow_id: a.flowId,
    run_id: a.runId,
    step_id: a.stepId,
    test: a.isTest,
    to: a.toAddress,
    function: a.functionSignature,
    args: a.args,
    value: formatEther(BigInt(a.valueWei)),
    status: a.status,
    mandate: a.mandate,
    tx_hash: a.txHash,
    tx_url: a.txHash && explorer ? `${explorer}/tx/${a.txHash}` : null,
    block_number: a.blockNumber,
    gas_used: a.gasUsed,
    error: a.error,
    created_at: iso(a.createdAt),
  };
}

const callView = (c: PlannedCall) => ({ to: c.to, value: c.value.toString(), data: c.data, description: c.description });

async function safeOwners(chain: ChainTxClient, safe: NormalizedAddress): Promise<{ owners: NormalizedAddress[]; threshold: number } | null> {
  try {
    const owners = await chain.call({ from: safe, to: safe, data: encodeFunctionData({ abi: SAFE_ABI, functionName: "getOwners" }) });
    const threshold = await chain.call({ from: safe, to: safe, data: encodeFunctionData({ abi: SAFE_ABI, functionName: "getThreshold" }) });
    // address[] ABI: offset, length, then one word per owner.
    const words = (owners.slice(2).match(/.{64}/g) ?? []).map((w) => `0x${w}`);
    const count = Number(BigInt(words[1] ?? "0x0"));
    if (count === 0 || count > 50) return null;
    return { owners: words.slice(2, 2 + count).map((w) => normalizeAddress(`0x${w.slice(-40)}`)), threshold: Number(BigInt(threshold)) };
  } catch {
    return null;
  }
}

/** The calls a Safe owner approves, in the forms they can use. */
function approvalOptions(calls: readonly PlannedCall[], ctx: ApiContext, safe: NormalizedAddress, me: NormalizedAddress, ownership: { owners: NormalizedAddress[]; threshold: number }, name: string) {
  const tx = safeTransactionFor(calls);
  const canExecute = ownership.threshold === 1 && ownership.owners.includes(me);
  return {
    calls: calls.map(callView),
    safe_transaction: { to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation },
    // A 1-of-N owner signs this as a normal transaction from their wallet (pre-validated signature).
    owner_transaction: canExecute ? { from: me, to: safe, value: "0", data: execTransactionByOwner(tx, me) } : null,
    tx_builder: txBuilderJson(ctx.chain.id, safe, name, calls),
    note: canExecute
      ? "Send owner_transaction from your wallet (you are an owner of this 1-of-N Safe)."
      : !ownership.owners.includes(me)
        ? `You are not an owner of this Safe: one of its owners imports tx_builder into the Safe Transaction Builder (${ownership.threshold} signature${ownership.threshold === 1 ? "" : "s"} needed).`
        : `This Safe needs ${ownership.threshold} signatures: import tx_builder into the Safe Transaction Builder and collect them.`,
  };
}

const DAY = 86_400_000;

export interface ReviewFinding {
  readonly level: "warn" | "info";
  readonly code: "pending_stale" | "unused" | "idle" | "no_mandate" | "expires_soon" | "sends_eth";
  readonly message: string;
}

/** What a person reviewing a live grant should know or fix, warnings first. */
export function reviewFindings(
  g: Pick<OnchainGrantRow, "status" | "createdAt" | "activatedAt" | "expiresAt" | "mandateConnectionId">,
  scope: GrantScope,
  usedBy: ReadonlyArray<{ status: string }>,
  lastActionAt: Date | null,
  now: number,
): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  if (g.status === "pending" && now - g.createdAt.getTime() > DAY) {
    out.push({ level: "warn", code: "pending_stale", message: "Waiting for your Safe's approval for over a day: revoke it if you will not approve it." });
  }
  if (g.status === "active" && !usedBy.some((f) => f.status === "active")) {
    out.push({ level: "warn", code: "unused", message: "No active flow uses this grant. Revoke it unless you need it soon: an unused permission is only risk." });
  }
  const since = lastActionAt ?? g.activatedAt;
  if (g.status === "active" && since && now - since.getTime() > 30 * DAY) {
    out.push({ level: "info", code: "idle", message: lastActionAt ? "No transaction through it in 30 days." : "Never used in the 30 days since it became active." });
  }
  if (!g.mandateConnectionId) out.push({ level: "info", code: "no_mandate", message: "No MANDATE policy: only the onchain limits stand between a flow and a transaction." });
  const left = g.expiresAt.getTime() - now;
  if (left < DAY) out.push({ level: "info", code: "expires_soon", message: `Expires in ${Math.max(1, Math.round(left / 3_600_000))} h: flows using it stop then.` });
  if (BigInt(scope.max_value_per_day_wei) > 0n) out.push({ level: "info", code: "sends_eth", message: `Can send up to ${formatEther(BigInt(scope.max_value_per_day_wei))} ETH a day from the Safe.` });
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
}

/** Flows whose current version has an ONCHAIN_TX step acting through each grant. */
async function flowsByGrant(db: Database, ownerId: string): Promise<Map<string, Array<{ flow_id: string; name: string; status: string }>>> {
  const rows = await db
    .select({ id: flows.id, name: flows.name, status: flows.status, definition: flowVersions.definition })
    .from(flows)
    .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.currentVersion)))
    .where(eq(flows.ownerId, ownerId));
  const out = new Map<string, Array<{ flow_id: string; name: string; status: string }>>();
  for (const f of rows) {
    const actions = (f.definition as { actions?: Array<{ type?: string; params?: { grant_id?: unknown } }> }).actions ?? [];
    const grants = new Set(actions.filter((a) => a.type === "ONCHAIN_TX" && typeof a.params?.grant_id === "string").map((a) => a.params?.grant_id as string));
    for (const id of grants) out.set(id, [...(out.get(id) ?? []), { flow_id: f.id, name: f.name, status: f.status }]);
  }
  return out;
}

const liveGrants = (db: Database, ownerId: string) =>
  db
    .select()
    .from(onchainGrants)
    .where(and(eq(onchainGrants.ownerId, ownerId), inArray(onchainGrants.status, ["pending", "active"])))
    .orderBy(desc(onchainGrants.createdAt));

export function registerOnchainRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const creates = new RateLimiter(20, 3_600_000, ctx.now);
  const explorer = ctx.chain.explorerUrl ?? null;
  const chainTx = () => {
    if (!ctx.chainTx) throw new ApiError(503, "not_configured", "onchain grants need a chain RPC on this server");
    return ctx.chainTx;
  };

  // Permission review (Phase 9): only grants that can still act; revoked/expired ones hold no key.
  app.get("/v1/onchain/review", async (req) => {
    const me = caller(req);
    const now = ctx.now();
    const live = await liveGrants(ctx.db, me.userId);
    const ids = live.map((g) => g.id);
    const usedBy = await flowsByGrant(ctx.db, me.userId);
    const recent = ids.length
      ? await ctx.db
          .select({ grantId: onchainActions.grantId, status: onchainActions.status, n: count() })
          .from(onchainActions)
          .where(and(eq(onchainActions.ownerId, me.userId), inArray(onchainActions.grantId, ids), gte(onchainActions.createdAt, new Date(now - 7 * DAY))))
          .groupBy(onchainActions.grantId, onchainActions.status)
      : [];
    const last = ids.length
      ? await ctx.db
          .select({ grantId: onchainActions.grantId, at: max(onchainActions.createdAt) })
          .from(onchainActions)
          .where(and(eq(onchainActions.ownerId, me.userId), inArray(onchainActions.grantId, ids), eq(onchainActions.isTest, false)))
          .groupBy(onchainActions.grantId)
      : [];
    const grants = live.map((g) => {
      const flowsUsing = usedBy.get(g.id) ?? [];
      const lastAt = last.find((l) => l.grantId === g.id)?.at ?? null;
      const findings = reviewFindings(g, g.scope as unknown as GrantScope, flowsUsing, lastAt, now);
      return {
        ...grantView(g, explorer),
        used_by: flowsUsing,
        actions_7d: Object.fromEntries(recent.filter((r) => r.grantId === g.id).map((r) => [r.status, Number(r.n)])),
        last_action_at: iso(lastAt),
        findings,
      };
    });
    grants.sort((a, b) => b.findings.filter((f) => f.level === "warn").length - a.findings.filter((f) => f.level === "warn").length);
    return {
      data: {
        summary: {
          live: grants.length,
          active: grants.filter((g) => g.status === "active").length,
          pending: grants.filter((g) => g.status === "pending").length,
          warnings: grants.reduce((n, g) => n + g.findings.filter((f) => f.level === "warn").length, 0),
          flows_using: new Set(grants.flatMap((g) => g.used_by.map((f) => f.flow_id))).size,
        },
        grants,
      },
    };
  });

  // Emergency stop: like revoking each one (allowed with an API key: it only removes power).
  app.post("/v1/onchain/grants/revoke-all", async (req) => {
    const me = caller(req);
    const live = await liveGrants(ctx.db, me.userId);
    const at = new Date(ctx.now());
    const revoked: OnchainGrantRow[] = [];
    for (const g of live) {
      const r = await revokeGrant(ctx.db, g.id, me.userId, at);
      if (!r) continue; // revoked or expired meanwhile
      revoked.push(r);
      await audit(ctx, req, "grant.revoked", { type: "grant", id: r.id }, { label: r.label, was: g.status, all: true });
    }
    ctx.logger.info({ userId: me.userId, grants: revoked.length }, "every onchain grant revoked (session keys wiped)");
    const usedBy = await flowsByGrant(ctx.db, me.userId);
    const affected = new Set(revoked.flatMap((g) => (usedBy.get(g.id) ?? []).map((f) => f.flow_id)));
    // The keys are gone already; one optional Safe transaction per Safe also removes the roles.
    const bySafe = new Map<string, OnchainGrantRow[]>();
    for (const g of revoked) bySafe.set(g.safeAddress, [...(bySafe.get(g.safeAddress) ?? []), g]);
    const onchain = [];
    for (const [safeAddress, gs] of bySafe) {
      const safe = normalizeAddress(safeAddress);
      const calls = gs.map((g) => revokeCall({ roles: normalizeAddress(g.rolesAddress), sessionKey: normalizeAddress(g.sessionKeyAddress), roleKey: g.roleKey as Hex }));
      const ownership = ctx.chainTx ? await safeOwners(ctx.chainTx, safe) : null;
      onchain.push({ safe, grant_ids: gs.map((g) => g.id), ...(ownership ? approvalOptions(calls, ctx, safe, me.address, ownership, `Revoke ${gs.length} IGNITRA grant(s)`) : { calls: calls.map(callView) }) });
    }
    return { data: { revoked: revoked.map((g) => grantView(g, explorer)), affected_flows: affected.size }, onchain };
  });

  app.get("/v1/onchain/grants", async (req) => {
    const me = caller(req);
    const rows = await ctx.db.select().from(onchainGrants).where(eq(onchainGrants.ownerId, me.userId)).orderBy(desc(onchainGrants.createdAt));
    return { data: rows.map((g) => grantView(g, explorer)) };
  });

  app.post("/v1/onchain/grants", async (req, reply) => {
    const me = requireSession(req);
    if (!planLimits(me.plan).lockedActions.every((a) => a !== "ONCHAIN_TX")) {
      throw new ApiError(402, "plan_limit_reached", `onchain actions are part of the team plan; you are on ${me.plan}`, { limit: "onchain", plan: me.plan, max: 0 });
    }
    if (!ctx.keyring) throw new ApiError(503, "not_configured", "onchain grants need ENCRYPTION_KEY on this server");
    enforceRate(creates, me.userId, reply, "new grants this hour");
    const body = parse(grantInputSchema, req.body);
    const chain = chainTx();
    const safe = normalizeAddress(body.safe);
    const ownership = await safeOwners(chain, safe);
    if (!ownership) throw new ApiError(422, "not_a_safe", `${safe} is not a Safe on this chain (getOwners failed)`);
    const roles = rolesAddressFor(safe);
    // Every enabled module can act as the Safe (another Roles modifier could even widen this one).
    let modules: NormalizedAddress[];
    try {
      modules = await safeModules(chain, safe);
    } catch {
      throw new ApiError(502, "chain_unavailable", `could not read the modules of ${safe}: try again`);
    }
    const { scope, issues } = normalizeGrantScope(body, {
      now: ctx.now(),
      forbidden: [
        { address: safe, why: "calls would run as the Safe itself (it could change its owners)" },
        { address: roles, why: "the role could widen its own permissions" },
        ...modules.filter((m) => m !== roles).map((m) => ({ address: m, why: "an enabled module of this Safe: it can act as the Safe" })),
      ],
    });
    if (body.mandate_connection_id) {
      const conn = await loadConnection(ctx.db, ctx.keyring, body.mandate_connection_id).catch(() => null);
      if (!conn || conn.ownerId !== me.userId || conn.type !== "mandate") issues.push({ path: "mandate_connection_id", message: "not one of your MANDATE connections" });
    } else if (ctx.mandateRequired) {
      issues.push({ path: "mandate_connection_id", message: "this server requires a MANDATE policy for every grant: add a MANDATE connection" });
    }
    if (issues.length > 0) throw new ApiError(422, "invalid_grant", "the grant is not valid", { issues });

    const grant = await createGrant(ctx.db, ctx.keyring, { ownerId: me.userId, chainId: ctx.chain.id, label: body.label, safe, scope, mandateConnectionId: body.mandate_connection_id ?? null });
    const plan = await planGrant(chain, { id: grant.id, safe, sessionKey: normalizeAddress(grant.sessionKeyAddress), scope });
    ctx.logger.info({ userId: me.userId, grantId: grant.id, safe, calls: plan.calls.length }, "onchain grant created (pending)");
    await audit(ctx, req, "grant.created", { type: "grant", id: grant.id }, { label: body.label, safe });
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ data: grantView(grant, explorer), approval: approvalOptions(plan.calls, ctx, safe, me.address, ownership, `IGNITRA grant ${grant.id}`) });
  });

  app.get<{ Params: { id: string } }>("/v1/onchain/grants/:id", async (req) => {
    const me = caller(req);
    const grant = await loadGrant(ctx.db, req.params.id);
    if (!grant || grant.ownerId !== me.userId) throw notFound("grant");
    const actions = await ctx.db.select().from(onchainActions).where(eq(onchainActions.grantId, grant.id)).orderBy(desc(onchainActions.createdAt)).limit(20);
    let gas: string | null = null;
    if (ctx.chainTx) gas = formatEther(await ctx.chainTx.balance(normalizeAddress(grant.sessionKeyAddress)).catch(() => 0n));
    // Still to approve: the Safe transaction, planned against the chain as it is now (a modifier
    // deployed meanwhile is not deployed twice).
    let approval: ReturnType<typeof approvalOptions> | null = null;
    if (grant.status === "pending" && ctx.chainTx) {
      const safe = normalizeAddress(grant.safeAddress);
      const ownership = await safeOwners(ctx.chainTx, safe);
      const plan = ownership ? await planGrant(ctx.chainTx, { id: grant.id, safe, sessionKey: normalizeAddress(grant.sessionKeyAddress), scope: grant.scope as unknown as GrantScope }).catch(() => null) : null;
      if (ownership && plan) approval = approvalOptions(plan.calls, ctx, safe, me.address, ownership, `IGNITRA grant ${grant.id}`);
    }
    return { data: { ...grantView(grant, explorer), session_key_balance: gas, approval, actions: actions.map((a) => actionView(a, explorer)) } };
  });

  app.post<{ Params: { id: string } }>("/v1/onchain/grants/:id/verify", async (req) => {
    const me = requireSession(req);
    const body = parse(verifyBody, req.body);
    const grant = await loadGrant(ctx.db, req.params.id);
    if (!grant || grant.ownerId !== me.userId) throw notFound("grant");
    if (grant.status !== "pending") throw new ApiError(409, "not_pending", `the grant is ${grant.status}`);
    const result = await verifyGrantTransaction(
      chainTx(),
      {
        id: grant.id,
        safe: normalizeAddress(grant.safeAddress),
        roles: normalizeAddress(grant.rolesAddress),
        roleKey: grant.roleKey as Hex,
        sessionKey: normalizeAddress(grant.sessionKeyAddress),
        scope: grant.scope as unknown as GrantScope,
      },
      body.tx_hash.toLowerCase() as `0x${string}`,
    );
    if (!result.ok) throw new ApiError(422, "grant_not_verified", "the transaction does not set up this grant exactly", { problems: result.problems });
    const active = await activateGrant(ctx.db, grant.id, body.tx_hash, new Date(ctx.now()));
    ctx.logger.info({ userId: me.userId, grantId: grant.id, tx: body.tx_hash }, "onchain grant verified and active");
    await audit(ctx, req, "grant.verified", { type: "grant", id: grant.id }, { tx_hash: body.tx_hash.toLowerCase() });
    return { data: grantView(active ?? grant, explorer) };
  });

  // Revoking only reduces power: allowed with an API key too.
  app.post<{ Params: { id: string } }>("/v1/onchain/grants/:id/revoke", async (req) => {
    const me = caller(req);
    const before = await loadGrant(ctx.db, req.params.id);
    if (!before || before.ownerId !== me.userId) throw notFound("grant");
    const revoked = await revokeGrant(ctx.db, before.id, me.userId, new Date(ctx.now()));
    const grant = revoked ?? before;
    ctx.logger.info({ userId: me.userId, grantId: grant.id }, "onchain grant revoked (session key wiped)");
    if (revoked) await audit(ctx, req, "grant.revoked", { type: "grant", id: grant.id }, { label: grant.label, was: before.status });
    const call = revokeCall({ roles: normalizeAddress(grant.rolesAddress), sessionKey: normalizeAddress(grant.sessionKeyAddress), roleKey: grant.roleKey as Hex });
    const ownership = ctx.chainTx ? await safeOwners(ctx.chainTx, normalizeAddress(grant.safeAddress)) : null;
    return {
      data: grantView(grant, explorer),
      // Already powerless (the key no longer exists); this also removes the role on the Safe.
      onchain: ownership ? approvalOptions([call], ctx, normalizeAddress(grant.safeAddress), me.address, ownership, `Revoke IGNITRA grant ${grant.id}`) : { calls: [callView(call)] },
    };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/onchain/actions", async (req) => {
    const me = caller(req);
    const q = parse(z.object({ grant_id: z.string().regex(/^grt_[0-9a-z]{26}$/).optional(), limit: z.string().optional() }), req.query);
    const rows = await ctx.db
      .select()
      .from(onchainActions)
      .where(and(eq(onchainActions.ownerId, me.userId), q.grant_id ? eq(onchainActions.grantId, q.grant_id) : undefined))
      .orderBy(desc(onchainActions.createdAt))
      .limit(clampLimit(q.limit, 50, 200));
    return { data: rows.map((a) => actionView(a, explorer)) };
  });
}
