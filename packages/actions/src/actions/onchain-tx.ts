import { and, eq, gt, inArray, max, ne } from "drizzle-orm";
import { decodeErrorResult, encodeFunctionData, formatEther, keccak256, parseEther, toFunctionSelector, type Hex } from "viem";
import { z } from "zod";
import { isValidAddress, newId, normalizeAddress, type ActionContext, type ActionDefinition, type ActionResult, type ChainTxClient, type NormalizedAddress, type TxReceiptSummary } from "@ignitra/core";
import type { Keyring } from "@ignitra/core/server";
import { CallRevertedError, FunctionCallError, TransactionRejectedError, encodeFunctionCall, normalizeCallArgs, parseWriteFunction } from "@ignitra/chain";
import { onchainActions, onchainGrants, type Database, type OnchainActionRow, type OnchainGrantRow } from "@ignitra/db";
import { loadConnection } from "../connections";
import { ROLES_ABI, ROLES_STATUS, ROLES_STATUS_TEXT } from "../onchain/contracts";
import { expireGrants, loadGrant, sessionAccount } from "../onchain/grants";
import { askMandate } from "../onchain/mandate";
import { findScopedFunction, type GrantScope, type ScopedFunction } from "../onchain/scope";

/**
 * ONCHAIN_TX — a pre-approved transaction from the user's Safe, through an IGNITRA session key
 * the Safe granted a Zodiac Roles v2 role (Phase 8). Strictly limited:
 *
 *   - default OFF: the flow must opt in (`settings.onchain: true`) and run on confirmed events;
 *   - the grant (targets, functions, ETH and token limits per call and per day, expiry) is
 *     enforced ON CHAIN by Roles and IgnitraSessionBounds, and checked here first;
 *   - MANDATE must allow it when the grant names a MANDATE policy (or the operator requires one);
 *   - TEST runs simulate only, never send;
 *   - every attempt is logged in onchain_actions BEFORE anything is sent; the signed transaction
 *     is stored first, so a retry re-sends the same transaction instead of signing another;
 *   - revoking (in IGNITRA or on the Safe) or expiry stops it: the key is wiped / the role gone.
 *
 *   { "grant_id": "grt_…", "to": "0x…", "function": "transfer(address to, uint256 amount)",
 *     "args": ["{{trigger.from}}", "1000000"], "value": "0" }
 */

const template = z.string().max(2000);

export const onchainTxParams = z
  .object({
    grant_id: z.string().regex(/^grt_[0-9a-z]{26}$/, { message: "pick an onchain grant" }),
    /** Literal: the grant's scope is checked when the flow is saved. */
    to: z.string().trim().refine(isValidAddress, { message: "must be a literal address in the grant" }),
    function: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .refine(
        (f) => {
          try {
            parseWriteFunction(f);
            return true;
          } catch {
            return false;
          }
        },
        { message: "a function signature, e.g. transfer(address to, uint256 amount)" },
      ),
    args: z.array(template).max(16).default([]),
    /** ETH to send, in ETH (e.g. "0.01"), or a template. */
    value: template.default("0"),
  })
  .strict();
export type OnchainTxParams = z.output<typeof onchainTxParams>;

export interface OnchainDeps {
  readonly db: Database;
  readonly keyring: Keyring;
  readonly writer: ChainTxClient;
  readonly chainId: number;
  readonly explorerUrl: string | null;
  /** Operator policy: every grant must name a MANDATE connection. */
  readonly mandateRequired: boolean;
  readonly receiptTimeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
}

const fnOf = (sig: string) => parseWriteFunction(sig);
const DAY_MS = 86_400_000;
/** A signed transaction holds its nonce this long even if the node has not seen it (yet). */
const NONCE_HOLD_MS = 10 * 60_000;

/** One signer at a time per session key: nonces are sequential. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  locks.set(key, prev.then(() => mine));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === mine) locks.delete(key);
  }
}

/** Why Roles refused a call, in words. */
export function explainRevert(err: unknown): string {
  const data = err instanceof CallRevertedError ? err.data : null;
  if (data && data !== "0x") {
    try {
      const decoded = decodeErrorResult({ abi: ROLES_ABI, data: data as Hex });
      if (decoded.errorName === "ConditionViolation") {
        const status = ROLES_STATUS[Number(decoded.args[0])] ?? `status ${String(decoded.args[0])}`;
        return `the grant does not allow it: ${ROLES_STATUS_TEXT[status] ?? status}`;
      }
      if (decoded.errorName === "NotAuthorized" || decoded.errorName === "NoMembership") return "the session key no longer holds the role (was it revoked on the Safe?)";
      if (decoded.errorName === "ModuleTransactionFailed") return "the call itself reverted at the target contract";
      return `reverted: ${decoded.errorName}`;
    } catch {
      return `reverted (data ${data.slice(0, 74)})`;
    }
  }
  return `reverted: ${(err as Error).message.slice(0, 200)}`;
}

export function createOnchainTxAction(deps: OnchainDeps | null): ActionDefinition<OnchainTxParams> {
  return {
    type: "ONCHAIN_TX",
    label: "Onchain transaction",
    description: "A pre-approved transaction from your Safe through a scoped, revocable IGNITRA session key (Zodiac Roles). Off unless the flow opts in.",
    connectionType: null,
    paramsSchema: onchainTxParams,
    templates: (p) => [...p.args.map((a, i) => ({ name: `args.${i}`, template: a })), { name: "value", template: p.value }],
    outputFields: [
      { path: "tx_hash", type: "hash", description: "The transaction (null for a TEST simulation)", nullable: true },
      { path: "block_number", type: "uint", description: "Block it was mined in", nullable: true },
      { path: "gas_used", type: "uint", description: "Gas used", nullable: true },
      { path: "explorer_url", type: "string", description: "Explorer link", nullable: true },
      { path: "simulated", type: "boolean", description: "True for a TEST run: simulated, not sent" },
      { path: "safe", type: "address", description: "The Safe that made the call" },
    ],
    validate(p) {
      const fn = fnOf(p.function);
      return p.args.length === fn.inputs.length ? [] : [`${fn.name} takes ${fn.inputs.length} argument(s); ${p.args.length} given`];
    },

    async execute(p, ctx) {
      if (!deps) return { status: "failed", retryable: false, error: "onchain actions are not configured on this runner (ENCRYPTION_KEY and an RPC are required)" };
      const now = deps.now ?? Date.now;
      if (ctx.flowSettings?.onchain !== true) return { status: "failed", retryable: false, error: "this flow has not opted in to onchain actions (settings.onchain)" };
      if (ctx.flowSettings.mode !== "confirmed") return { status: "failed", retryable: false, error: "onchain actions run on confirmed events only" };

      let grant = await loadGrant(deps.db, p.grant_id);
      if (!grant || grant.ownerId !== ctx.ownerId) return { status: "failed", retryable: false, error: `grant ${p.grant_id} not found` };
      if (grant.status === "active" && grant.expiresAt.getTime() <= now()) {
        await expireGrants(deps.db, new Date(now()));
        grant = (await loadGrant(deps.db, p.grant_id)) as OnchainGrantRow;
      }
      const g = grant;
      const scope = g.scope as unknown as GrantScope;
      const safe = normalizeAddress(g.safeAddress);
      const sessionKey = normalizeAddress(g.sessionKeyAddress);

      return withLock(sessionKey, async (): Promise<ActionResult> => {
        // ---- exactly-once, FIRST: an earlier attempt of this very step decides, whatever changed since.
        if (!ctx.isTest) {
          const [existing] = await deps.db.select().from(onchainActions).where(eq(onchainActions.idempotencyKey, ctx.idempotencyKey));
          if (existing) {
            const before = { safe, session_key: sessionKey, to: existing.toAddress, function: existing.functionSignature, args: existing.args, value_eth: formatEther(BigInt(existing.valueWei)) };
            if (existing.status === "denied" || existing.status === "reverted" || existing.status === "failed" || existing.status === "simulated") {
              return { status: "failed", retryable: false, error: existing.error ?? `previous attempt ${existing.status}`, request: before };
            }
            // Never signed again: the recorded transaction is re-sent while the grant is active, else awaited.
            return settle(deps, existing, { safe, sessionKey, now: now() }, before);
          }
        }
        if (g.status !== "active") return { status: "failed", retryable: false, error: `grant ${g.id} is ${g.status}${g.status === "pending" ? " (its Safe transaction was not verified yet)" : ""}` };

        // ---- what exactly would be sent, checked against the grant before anything else
        const to = normalizeAddress(p.to);
        const fn = fnOf(p.function);
        const selector = toFunctionSelector(fn);
        const scoped = findScopedFunction(scope, to, selector);
        if (!scoped) return { status: "failed", retryable: false, error: `${fn.name} on ${to} is not in grant ${g.id}` };
        const args = p.args.map((a) => (a.includes("{{") ? ctx.render(a) : a));
        let value: bigint;
        try {
          const v = (p.value.includes("{{") ? ctx.render(p.value) : p.value).trim();
          value = parseEther(v === "" ? "0" : v);
        } catch {
          return { status: "failed", retryable: false, error: `value "${p.value.slice(0, 40)}" is not an ETH amount` };
        }
        if (value < 0n) return { status: "failed", retryable: false, error: "value cannot be negative" };
        let inner: Hex;
        let shownArgs: unknown[];
        try {
          inner = encodeFunctionCall(fn, args);
          shownArgs = normalizeCallArgs(fn, args);
        } catch (err) {
          if (err instanceof FunctionCallError) return { status: "failed", retryable: false, error: err.message };
          throw err;
        }
        const request = { safe, session_key: sessionKey, to, function: scoped.signature, args: shownArgs, value_eth: formatEther(value) };
        if (value > BigInt(scope.max_value_per_tx_wei)) return { status: "failed", retryable: false, error: `${formatEther(value)} ETH is above the grant's ${formatEther(BigInt(scope.max_value_per_tx_wei))} ETH per call`, request };
        const amount = scoped.amount ? BigInt(String(shownArgs[scoped.amount.arg] ?? "0")) : null;
        if (scoped.amount && amount !== null && amount > BigInt(scoped.amount.max_per_tx)) {
          return { status: "failed", retryable: false, error: `amount ${amount} is above the grant's ${scoped.amount.max_per_tx} per call`, request };
        }
        const overLimit = async (db: Database) => overDailyLimit(await spentLastDay(db, g.id, scope, now(), ctx.idempotencyKey), scope, scoped, `${to}:${selector}`, value, amount);
        const over = await overLimit(deps.db);
        if (over) return { status: "failed", retryable: false, error: over, request };
        const data = encodeFunctionData({ abi: ROLES_ABI, functionName: "execTransactionWithRole", args: [to, value, inner, 0, g.roleKey as Hex, true] });
        const roles = normalizeAddress(g.rolesAddress);

        // ---- TEST runs: a simulation, never a transaction
        if (ctx.isTest) {
          try {
            const gas = await deps.writer.estimateGas({ from: sessionKey, to: roles, data, value: 0n });
            await logAction(deps.db, { grant: g, ctx, to, scoped: scoped.signature, args: shownArgs, value, status: "simulated", error: null, isTest: true });
            return { status: "succeeded", output: { tx_hash: null, block_number: null, gas_used: null, explorer_url: null, simulated: true, safe }, request: { ...request, simulated: true, estimated_gas: gas.toString() } };
          } catch (err) {
            if (err instanceof CallRevertedError) return { status: "failed", retryable: false, error: `TEST simulation: ${explainRevert(err)}`, request };
            return { status: "failed", retryable: true, error: `RPC unavailable: ${(err as Error).message}`, request };
          }
        }

        // ---- MANDATE
        let mandate: Record<string, unknown> | null = null;
        if (g.mandateConnectionId || deps.mandateRequired) {
          const conn = g.mandateConnectionId ? await loadConnection(deps.db, deps.keyring, g.mandateConnectionId) : null;
          const url = conn?.secret.url;
          const secret = conn?.secret.signing_secret;
          if (!conn || conn.type !== "mandate" || typeof url !== "string" || typeof secret !== "string") {
            return { status: "failed", retryable: false, error: "this grant needs a MANDATE policy and none is connected", request };
          }
          const decision = await askMandate(ctx.http, { url, secret }, {
            chain_id: deps.chainId,
            grant_id: g.id,
            safe,
            session_key: sessionKey,
            to,
            function: scoped.signature,
            selector,
            args: shownArgs,
            value_wei: value.toString(),
            flow_id: ctx.flowId,
            run_id: ctx.runId,
            step_id: ctx.stepId,
            idempotency_key: ctx.idempotencyKey,
            test: false,
          });
          mandate = { ...decision };
          if (decision.decision === "unavailable") return { status: "failed", retryable: true, error: `${decision.reason}: not sent (fail-closed)`, request: { ...request, mandate } };
          if (decision.decision === "deny") {
            const error = `MANDATE denied it: ${decision.reason}`;
            await logAction(deps.db, { grant: g, ctx, to, scoped: scoped.signature, args: shownArgs, value, status: "denied", error, mandate });
            return { status: "failed", retryable: false, error, request: { ...request, mandate } };
          }
        }

        // ---- simulate (Roles' own checks, as the session key)
        let gas: bigint;
        try {
          gas = await deps.writer.estimateGas({ from: sessionKey, to: roles, data, value: 0n });
        } catch (err) {
          if (!(err instanceof CallRevertedError)) return { status: "failed", retryable: true, error: `RPC unavailable: ${(err as Error).message}`, request };
          const error = explainRevert(err);
          await logAction(deps.db, { grant: g, ctx, to, scoped: scoped.signature, args: shownArgs, value, status: "failed", error, mandate });
          return { status: "failed", retryable: false, error, request };
        }
        const fees = await deps.writer.fees();
        const gasLimit = (gas * 12n) / 10n + 10_000n;
        const balance = await deps.writer.balance(sessionKey);
        if (balance < gasLimit * fees.maxFeePerGas) {
          return { status: "failed", retryable: false, error: `the session key ${sessionKey} needs ETH for gas (has ${formatEther(balance)}, needs about ${formatEther(gasLimit * fees.maxFeePerGas)})`, request };
        }

        // ---- sign and record under a row lock on the grant: one signer at a time across runner
        // processes. A revocation committed meanwhile is seen before anything is signed, a twin
        // attempt of this very step finds this one's record, and the daily limits count both.
        let signing: { kind: "signed" | "existing"; row: OnchainActionRow } | { kind: "stopped"; error: string };
        try {
          signing = await deps.db.transaction(async (t) => {
            const tx = t as unknown as Database;
            const [fresh] = await tx.select().from(onchainGrants).where(eq(onchainGrants.id, g.id)).for("update");
            const account = fresh && fresh.status === "active" && fresh.expiresAt.getTime() > now() ? sessionAccount(deps.keyring, fresh) : null;
            if (!fresh || !account) return { kind: "stopped", error: `grant ${g.id} was revoked or expired just now: nothing was signed` } as const;
            const twin = async () => (await tx.select().from(onchainActions).where(eq(onchainActions.idempotencyKey, ctx.idempotencyKey)))[0];
            const earlier = await twin();
            if (earlier) return { kind: "existing", row: earlier } as const;
            const limit = await overLimit(tx);
            if (limit) return { kind: "stopped", error: limit } as const;
            // The node's pending nonce, or past this key's transactions signed moments ago that the
            // node may not have seen yet.
            const [last] = await tx
              .select({ n: max(onchainActions.nonce) })
              .from(onchainActions)
              .where(and(eq(onchainActions.grantId, g.id), inArray(onchainActions.status, ["signed", "sent"]), gt(onchainActions.createdAt, new Date(Date.now() - NONCE_HOLD_MS))));
            const held = last?.n ?? null;
            const nonce = Math.max(await deps.writer.nonce(sessionKey), held === null ? 0 : held + 1);
            const raw = await account.signTransaction({ chainId: deps.chainId, type: "eip1559", to: roles, data, value: 0n, nonce, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
            const row = await logAction(tx, { grant: fresh, ctx, to, scoped: scoped.signature, args: shownArgs, value, status: "signed", error: null, mandate, nonce, raw });
            if (row) return { kind: "signed", row } as const;
            const raced = await twin();
            return raced ? ({ kind: "existing", row: raced } as const) : ({ kind: "stopped", error: "the transaction could not be recorded: nothing was sent" } as const);
          });
        } catch (err) {
          return { status: "failed", retryable: true, error: `not signed: ${(err as Error).message}`, request };
        }
        if (signing.kind === "stopped") return { status: "failed", retryable: false, error: signing.error, request };
        return settle(deps, signing.row, { safe, sessionKey, now: now() }, request);
      });
    },
  };
}

function overDailyLimit(spent: { value: bigint; amounts: Map<string, bigint> }, scope: GrantScope, scoped: ScopedFunction, amountKey: string, value: bigint, amount: bigint | null): string | null {
  if (value > 0n && spent.value + value > BigInt(scope.max_value_per_day_wei)) return `the grant's ${formatEther(BigInt(scope.max_value_per_day_wei))} ETH per day would be exceeded`;
  if (scoped.amount && amount !== null && (spent.amounts.get(amountKey) ?? 0n) + amount > BigInt(scoped.amount.max_per_day)) return `the grant's daily amount (${scoped.amount.max_per_day}) would be exceeded`;
  return null;
}

/**
 * Drives a recorded transaction to its outcome. It never signs: the stored bytes are re-sent
 * while the grant is active and unexpired (the same transaction, so at most once on chain), and
 * awaited. After a revocation or expiry, a transaction that was not sent yet is never sent.
 */
async function settle(deps: OnchainDeps, row: OnchainActionRow, at: { safe: NormalizedAddress; sessionKey: NormalizedAddress; now: number }, request: Record<string, unknown>): Promise<ActionResult> {
  const hash = (row.txHash ?? (row.rawTx ? keccak256(row.rawTx as Hex) : null)) as Hex | null;
  if (!hash) return { status: "failed", retryable: false, error: "no transaction was recorded for this attempt", request };
  const shown = { ...request, tx_hash: hash };
  const retry = (error: string): ActionResult => ({ status: "failed", retryable: true, error, request: shown });
  const finish = async (receipt: TxReceiptSummary): Promise<ActionResult> => {
    const output = { tx_hash: hash, block_number: receipt.blockNumber, gas_used: receipt.gasUsed.toString(), explorer_url: deps.explorerUrl ? `${deps.explorerUrl}/tx/${hash}` : null, simulated: false, safe: at.safe };
    if (receipt.status === "success") {
      await deps.db.update(onchainActions).set({ status: "confirmed", txHash: hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), error: null, updatedAt: new Date() }).where(eq(onchainActions.id, row.id));
      return { status: "succeeded", output, request: shown };
    }
    const error = `the transaction reverted on chain (block ${receipt.blockNumber})`;
    await deps.db.update(onchainActions).set({ status: "reverted", txHash: hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), error, updatedAt: new Date() }).where(eq(onchainActions.id, row.id));
    return { status: "failed", retryable: false, error, request: shown, response: output };
  };
  const fail = async (error: string): Promise<ActionResult> => {
    await deps.db.update(onchainActions).set({ status: "failed", error, updatedAt: new Date() }).where(eq(onchainActions.id, row.id));
    return { status: "failed", retryable: false, error, request: shown };
  };

  let mined: TxReceiptSummary | null;
  try {
    mined = await deps.writer.receipt(hash);
  } catch (err) {
    return retry(`RPC unavailable: ${(err as Error).message}`);
  }
  if (mined) return finish(mined);

  if ((row.status === "signed" || row.status === "sent") && row.rawTx) {
    const sent = await broadcast(deps, row, at.now);
    if (sent.kind === "inactive" && row.status === "signed") {
      // Its nonce still free means it never reached the network: it is never sent now. (Taken: it
      // went out just before the revocation, and is awaited like any sent transaction.)
      const pending = await deps.writer.nonce(at.sessionKey).catch(() => null);
      if (pending === null) return retry("RPC unavailable while checking whether the transaction went out");
      if (row.nonce === null || pending <= row.nonce) return fail("the grant was revoked or expired before this transaction was sent: it was never broadcast");
    }
    if (sent.kind === "error") {
      if (!(sent.error instanceof TransactionRejectedError)) return retry(`send failed, will retry with the same transaction: ${sent.error.message}`);
      const receipt = await deps.writer.receipt(hash).catch(() => null);
      if (receipt) return finish(receipt);
      const why = sent.error.message.replace(/^eth_sendRawTransaction: /, "");
      if (/nonce too high/i.test(why)) return retry(`an earlier transaction of this session key is not mined yet: this same transaction is sent again later (${why})`);
      return fail(`the node refused the transaction: ${why}`);
    }
  }
  const deadline = Date.now() + (deps.receiptTimeoutMs ?? 30_000);
  for (;;) {
    const receipt = await deps.writer.receipt(hash).catch(() => null);
    if (receipt) return finish(receipt);
    if (Date.now() >= deadline) return retry(`sent ${hash}, no receipt yet: checking again later (it is never re-signed)`);
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 500));
  }
}

/**
 * Sends a recorded transaction while its grant is active and unexpired, holding the grant's row
 * lock: once a revocation commits, nothing more goes out. Re-sending the same bytes is idempotent.
 */
async function broadcast(deps: OnchainDeps, row: OnchainActionRow, now: number): Promise<{ kind: "sent" | "inactive" } | { kind: "error"; error: Error }> {
  return deps.db.transaction(async (t) => {
    const tx = t as unknown as Database;
    const [grant] = await tx.select({ status: onchainGrants.status, expiresAt: onchainGrants.expiresAt }).from(onchainGrants).where(eq(onchainGrants.id, row.grantId)).for("update");
    if (!grant || grant.status !== "active" || grant.expiresAt.getTime() <= now) return { kind: "inactive" as const };
    try {
      await deps.writer.sendRawTransaction(row.rawTx as Hex);
    } catch (error) {
      return { kind: "error" as const, error: error as Error };
    }
    if (row.status === "signed") await tx.update(onchainActions).set({ status: "sent", updatedAt: new Date() }).where(and(eq(onchainActions.id, row.id), eq(onchainActions.status, "signed")));
    return { kind: "sent" as const };
  });
}

/** Records an attempt. Never overwrites one (the idempotency key is unique): null if it exists. */
async function logAction(
  db: Database,
  a: {
    grant: OnchainGrantRow;
    ctx: ActionContext;
    to: NormalizedAddress;
    scoped: string;
    args: unknown[];
    value: bigint;
    status: OnchainActionRow["status"];
    error: string | null;
    mandate?: Record<string, unknown> | null;
    nonce?: number;
    raw?: Hex;
    isTest?: boolean;
  },
): Promise<OnchainActionRow | null> {
  const id = newId("onchainAction");
  const [row] = await db
    .insert(onchainActions)
    .values({
      id,
      grantId: a.grant.id,
      ownerId: a.grant.ownerId,
      flowId: a.ctx.flowId,
      runId: a.ctx.runId,
      stepId: a.ctx.stepId,
      // TEST simulations get their own keys: they must never block the real step.
      idempotencyKey: a.isTest ? `${a.ctx.idempotencyKey}:test:${id}` : a.ctx.idempotencyKey,
      isTest: a.isTest ?? false,
      toAddress: a.to,
      functionSignature: a.scoped,
      args: a.args,
      valueWei: a.value.toString(),
      status: a.status,
      mandate: a.mandate ?? null,
      nonce: a.nonce ?? null,
      rawTx: a.raw ?? null,
      // Known once signed: a transaction is traceable even if it is never sent.
      txHash: a.raw ? keccak256(a.raw) : null,
      error: a.error,
    })
    .onConflictDoNothing({ target: onchainActions.idempotencyKey })
    .returning();
  return row ?? null;
}

/**
 * ETH and capped token amounts sent through a grant in the last 24 hours (signed or later), keyed
 * `<to>:<selector>`. A conservative pre-check: the onchain allowances refill per period and stay
 * the authority.
 */
async function spentLastDay(db: Database, grantId: string, scope: GrantScope, now: number, exceptKey: string): Promise<{ value: bigint; amounts: Map<string, bigint> }> {
  const rows = await db
    .select({ to: onchainActions.toAddress, fn: onchainActions.functionSignature, args: onchainActions.args, value: onchainActions.valueWei })
    .from(onchainActions)
    .where(and(eq(onchainActions.grantId, grantId), eq(onchainActions.isTest, false), ne(onchainActions.idempotencyKey, exceptKey), inArray(onchainActions.status, ["signed", "sent", "confirmed"]), gt(onchainActions.createdAt, new Date(now - DAY_MS))));
  let value = 0n;
  const amounts = new Map<string, bigint>();
  for (const r of rows) {
    value += BigInt(r.value);
    const selector = toFunctionSelector(fnOf(r.fn));
    const scoped = findScopedFunction(scope, normalizeAddress(r.to), selector);
    const arg = scoped?.amount ? (r.args as unknown[])[scoped.amount.arg] : undefined;
    if (arg === undefined) continue;
    const key = `${r.to}:${selector}`;
    amounts.set(key, (amounts.get(key) ?? 0n) + BigInt(String(arg)));
  }
  return { value, amounts };
}
