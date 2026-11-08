import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, keccak256, padHex, toFunctionSelector, type AbiEvent, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, normalizeAddress, renderTemplate, type ActionContext, type ActionResult, type ChainTxClient, type TxReceiptSummary } from "@ignitra/core";
import { createKeyring } from "@ignitra/core/server";
import { TransactionRejectedError } from "@ignitra/chain";
import { createDb, onchainActions, users, type DbHandle, type OnchainActionRow } from "@ignitra/db";
import { createSafeHttp } from "./http";
import { createOnchainTxAction, onchainTxParams } from "./actions/onchain-tx";
import { ROLES_ABI, SAFE_ABI } from "./onchain/contracts";
import { activateGrant, createGrant, revokeGrant } from "./onchain/grants";
import { allowancesFor, ethPerDayKey, functionConditions, roleKeyFor, rolesAddressFor } from "./onchain/roles";
import { grantInputSchema, normalizeGrantScope, type GrantScope } from "./onchain/scope";
import { verifyGrantTransaction } from "./onchain/verify";

/**
 * ONCHAIN_TX's guarantees against a scripted node (the fork test proves them on real contracts):
 * a step is signed at most once, re-sent only as the same bytes, never sent after its grant is
 * revoked, and nonces hold even when the node has not seen a transaction yet. Plus the grant
 * verifier replaying a crafted batch.
 */

const OWNER = normalizeAddress("0x9999999999999999999999999999999999999999");
const SAFE = normalizeAddress("0x1111111111111111111111111111111111111111");
const SINK = normalizeAddress("0x2222222222222222222222222222222222222222");
const TOKEN = normalizeAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });

let h: DbHandle;
let ownerId: string;
beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
  ownerId = newId("user");
  await h.db.insert(users).values({ id: ownerId, address: OWNER, plan: "team" });
}, 30_000);
afterAll(async () => {
  await h.close();
});

const scopeOf = (): GrantScope => {
  const { scope, issues } = normalizeGrantScope(
    grantInputSchema.parse({
      label: "unit",
      safe: SAFE,
      targets: [
        { address: SINK, functions: [{ signature: "ping() payable" }] },
        { address: TOKEN, functions: [{ signature: "transfer(address to, uint256 amount)", amount_arg: 1, max_amount_per_tx: "100", max_amount_per_day: "150" }] },
      ],
      max_value_per_tx: "0.1",
      max_value_per_day: "0.25",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    { now: Date.now(), forbidden: [{ address: SAFE, why: "the Safe" }] },
  );
  expect(issues).toEqual([]);
  return scope;
};

async function activeGrant() {
  const grant = await createGrant(h.db, keyring, { ownerId, chainId: 4663, label: "unit", safe: SAFE, scope: scopeOf(), mandateConnectionId: null });
  await activateGrant(h.db, grant.id, `0x${"aa".repeat(32)}`, new Date());
  return grant;
}

/** A node whose answers each test scripts: what it accepts, mines and reports as the next nonce. */
function scriptedNode() {
  const node = {
    pendingNonce: 0,
    send: "ok" as "ok" | "network" | "nonce-too-high",
    autoMine: true,
    sent: [] as Hex[],
    mined: new Map<string, TxReceiptSummary>(),
    mine(raw: Hex) {
      node.mined.set(keccak256(raw), { status: "success", blockNumber: 7, gasUsed: 50_000n, logs: [] });
    },
  };
  const writer: ChainTxClient = {
    nonce: async () => node.pendingNonce,
    balance: async () => 10n ** 18n,
    call: async () => "0x",
    getCode: async () => "0x",
    estimateGas: async () => 100_000n,
    fees: async () => ({ maxFeePerGas: 10n ** 8n, maxPriorityFeePerGas: 0n }),
    async sendRawTransaction(raw) {
      if (node.send === "network") throw new Error("socket hang up");
      if (node.send === "nonce-too-high") throw new TransactionRejectedError("eth_sendRawTransaction: nonce too high");
      node.sent.push(raw);
      if (node.autoMine) node.mine(raw);
      return keccak256(raw);
    },
    receipt: async (hash) => node.mined.get(hash) ?? null,
  };
  return { node, writer };
}

function harness() {
  const { node, writer } = scriptedNode();
  const action = createOnchainTxAction({ db: h.db, keyring, writer, chainId: 4663, explorerUrl: null, mandateRequired: false, receiptTimeoutMs: 60, pollMs: 10 });
  const ctx = (idempotencyKey: string): ActionContext => ({
    runId: "run_unit",
    flowId: "fl_unit",
    flowName: "unit",
    flowVersion: 1,
    stepId: "pay",
    idempotencyKey,
    runIdempotencyKey: "unit",
    attempt: 1,
    isTest: false,
    signal: new AbortController().signal,
    trigger: {},
    render: (t, escape) => renderTemplate(t, { trigger: {}, steps: {} }, { escape: escape ?? "none" }),
    connection: null,
    http: createSafeHttp({ allowPrivate: true }),
    push: null,
    ownerSigningSecret: null,
    chain: null,
    ownerId,
    flowSettings: { mode: "confirmed", onchain: true },
  });
  const ping = (grantId: string, key: string, value = "0.01"): Promise<ActionResult> => action.execute(onchainTxParams.parse({ grant_id: grantId, to: SINK, function: "ping()", value }), ctx(key));
  const row = async (key: string) => (await h.db.select().from(onchainActions).where(eq(onchainActions.idempotencyKey, key)))[0] as OnchainActionRow;
  return { node, ping, row };
}

let keys = 0;
const key = () => `unit:${++keys}`;

describe("ONCHAIN_TX delivery", () => {
  it("records the signed transaction before sending, and a retry re-sends those same bytes", async () => {
    const { node, ping, row } = harness();
    const g = await activeGrant();
    const k = key();
    node.send = "network";
    expect(await ping(g.id, k)).toMatchObject({ status: "failed", retryable: true, error: expect.stringContaining("will retry with the same transaction") });
    const signed = await row(k);
    expect(signed).toMatchObject({ status: "signed", nonce: 0, txHash: keccak256(signed.rawTx as Hex) });

    node.send = "ok";
    const done = await ping(g.id, k);
    expect(done).toMatchObject({ status: "succeeded", output: { tx_hash: signed.txHash, simulated: false } });
    expect(node.sent).toEqual([signed.rawTx]);
    expect(await row(k)).toMatchObject({ status: "confirmed", blockNumber: 7 });
    // Asked again: answered from the record, nothing sent.
    expect(await ping(g.id, k)).toMatchObject({ status: "succeeded", output: { tx_hash: signed.txHash } });
    expect(node.sent).toHaveLength(1);
  });

  it("never sends a transaction after its grant is revoked, unless it already went out", async () => {
    const { node, ping, row } = harness();
    const g = await activeGrant();
    const k = key();
    node.send = "network";
    await ping(g.id, k);
    await revokeGrant(h.db, g.id, ownerId, new Date());
    node.send = "ok";
    expect(await ping(g.id, k)).toMatchObject({ status: "failed", retryable: false, error: expect.stringContaining("it was never broadcast") });
    expect(node.sent).toEqual([]);
    expect(await row(k)).toMatchObject({ status: "failed", txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(await ping(g.id, key())).toMatchObject({ status: "failed", error: `grant ${g.id} is revoked` });
  });

  it("awaits a transaction sent before the revocation, without sending it again", async () => {
    const { node, ping, row } = harness();
    const g = await activeGrant();
    const k = key();
    node.autoMine = false;
    expect(await ping(g.id, k)).toMatchObject({ status: "failed", retryable: true, error: expect.stringContaining("no receipt yet") });
    expect((await row(k)).status).toBe("sent");
    await revokeGrant(h.db, g.id, ownerId, new Date());
    expect(await ping(g.id, k)).toMatchObject({ status: "failed", retryable: true, error: expect.stringContaining("no receipt yet") });
    node.mine(node.sent[0] as Hex);
    expect(await ping(g.id, k)).toMatchObject({ status: "succeeded" });
    expect(node.sent).toHaveLength(1);
  });

  it("holds a nonce the node has not seen yet, and retries (not fails) behind it", async () => {
    const { node, ping, row } = harness();
    const g = await activeGrant();
    const [a, b] = [key(), key()];
    node.send = "network";
    await ping(g.id, a); // signed with nonce 0, not sent
    node.send = "nonce-too-high";
    expect(await ping(g.id, b)).toMatchObject({ status: "failed", retryable: true, error: expect.stringContaining("earlier transaction of this session key") });
    expect([(await row(a)).nonce, (await row(b)).nonce, (await row(b)).status]).toEqual([0, 1, "signed"]);

    node.send = "ok";
    expect((await ping(g.id, a)).status).toBe("succeeded");
    node.pendingNonce = 1;
    expect((await ping(g.id, b)).status).toBe("succeeded");
    expect(node.sent).toEqual([(await row(a)).rawTx, (await row(b)).rawTx]);
  });

  it("counts signed transactions against the daily limit", async () => {
    const { node, ping } = harness();
    const g = await activeGrant();
    node.send = "network";
    await ping(g.id, key(), "0.1"); // signed, never sent: still counts
    node.send = "ok";
    expect((await ping(g.id, key(), "0.1")).status).toBe("succeeded");
    expect(await ping(g.id, key(), "0.1")).toMatchObject({ status: "failed", retryable: false, error: expect.stringContaining("0.25 ETH per day would be exceeded") });
  });
});

describe("grant verification replays the batch's Roles events in order", () => {
  const id = "grt_verifyunit000000000000000";
  const scope = scopeOf();
  const roles = rolesAddressFor(SAFE);
  const roleKey = roleKeyFor(id);
  const sessionKey = normalizeAddress("0x3333333333333333333333333333333333333333");
  const transferSel = toFunctionSelector("transfer(address,uint256)");
  const pingSel = toFunctionSelector("ping()");

  const log = (eventName: string, args: readonly unknown[]) => {
    const item = getAbiItem({ abi: ROLES_ABI, name: eventName as never }) as AbiEvent;
    return { address: roles, topics: encodeEventTopics({ abi: ROLES_ABI, eventName: eventName as never }) as Hex[], data: encodeAbiParameters(item.inputs, args) };
  };
  const honest = () => [
    log("AssignRoles", [sessionKey, [roleKey], [true]]),
    ...scope.targets.flatMap((t) => [
      log("ScopeTarget", [roleKey, t.address]),
      ...t.functions.map((f) => log("ScopeFunction", [roleKey, t.address, f.selector, functionConditions(id, t.address, f, scope), 1])),
    ]),
    ...allowancesFor(id, scope).map((a) => log("SetAllowance", [a.key, a.amount, a.amount, a.amount, 86_400n, 0n])),
  ];
  const chainWith = (logs: Array<ReturnType<typeof log>>) => ({
    receipt: async (): Promise<TxReceiptSummary> => ({ status: "success", blockNumber: 1, gasUsed: 1n, logs: logs.map((l, logIndex) => ({ ...l, logIndex })) }),
    call: async ({ data }: { data: Hex }) => (data.startsWith(toFunctionSelector(getAbiItem({ abi: SAFE_ABI, name: "isModuleEnabled" }))) ? padHex("0x01", { size: 32 }) : padHex(SAFE, { size: 32 })),
    getCode: async () => "0x60" as const,
  });
  const verify = (logs: Array<ReturnType<typeof log>>) => verifyGrantTransaction(chainWith(logs), { id, safe: SAFE, roles, roleKey, sessionKey, scope }, `0x${"bb".repeat(32)}`);
  const wide = [{ parent: 0, paramType: 5, operator: 5, compValue: "0x" }, { parent: 0, paramType: 1, operator: 0, compValue: "0x" }, { parent: 0, paramType: 1, operator: 0, compValue: "0x" }];

  it("accepts exactly the grant", async () => {
    expect(await verify(honest())).toMatchObject({ ok: true, problems: [] });
  });

  it("catches anything wider, even when the expected scope is also there", async () => {
    const problems = async (extra: Array<ReturnType<typeof log>>) => (await verify([...honest(), ...extra])).problems;
    expect(await problems([log("ScopeFunction", [roleKey, TOKEN, transferSel, wide, 1])])).toContainEqual(expect.stringContaining("does not end up scoped with the expected conditions"));
    expect(await problems([log("AllowFunction", [roleKey, SINK, pingSel, 1])])).toContainEqual(expect.stringContaining("does not end up scoped with the expected conditions"));
    expect(await problems([log("AllowFunction", [roleKey, TOKEN, toFunctionSelector("approve(address,uint256)"), 0])])).toContainEqual(expect.stringContaining("also gives the role"));
    expect(await problems([log("AllowTarget", [roleKey, OWNER, 0])])).toContainEqual(`the transaction also gives the role ${OWNER}`);
    expect(await problems([log("AssignRoles", [sessionKey, [keccak256("0x01")], [true]])])).toContainEqual("the session key also receives another role");
    expect(await problems([log("SetAllowance", [ethPerDayKey(id), 10n ** 21n, 10n ** 21n, 10n ** 21n, 86_400n, 0n])])).toContainEqual("the ETH per day limit does not end up as granted");
    expect(await problems([log("AssignRoles", [sessionKey, [roleKey], [false]])])).toContainEqual("the session key does not end up holding the role");
  });

  it("goes by the final state: a wide scope that the batch narrows again is fine", async () => {
    const all = honest();
    const widenedFirst = [log("ScopeFunction", [roleKey, TOKEN, transferSel, wide, 1]), ...all];
    expect(await verify(widenedFirst)).toMatchObject({ ok: true });
  });

  it("ignores events of other contracts", async () => {
    const forged = { ...log("AllowTarget", [roleKey, OWNER, 0]), address: SINK };
    expect(await verify([...honest(), forged])).toMatchObject({ ok: true });
  });
});
