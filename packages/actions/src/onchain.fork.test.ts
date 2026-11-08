import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { encodeFunctionData, keccak256, parseAbi, toHex, zeroAddress, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, normalizeAddress, renderTemplate, type ActionContext, type ChainTxClient, type NormalizedAddress } from "@ignitra/core";
import { createKeyring } from "@ignitra/core/server";
import { createChainWriter, createRpcChainReader } from "@ignitra/chain";
import { createDb, onchainActions, onchainGrants, users, type DbHandle } from "@ignitra/db";
import { createConnection } from "./connections";
import { createSafeHttp } from "./http";
import { createOnchainTxAction, explainRevert, onchainTxParams } from "./actions/onchain-tx";
import { ROLES_ABI, SESSION_BOUNDS_ADDRESS } from "./onchain/contracts";
import { activateGrant, createGrant, expireGrants, revokeGrant } from "./onchain/grants";
import { execTransactionByOwner, planGrant, revokeCall, rolesAddressFor, safeTransactionFor } from "./onchain/roles";
import { grantInputSchema, normalizeGrantScope, type GrantScope } from "./onchain/scope";
import { verifyGrantTransaction } from "./onchain/verify";
import { verifyWebhookSignature } from "./signing";

/**
 * ONCHAIN_TX against a local fork of Robinhood Chain mainnet (anvil): the real Safe 1.4.1,
 * Zodiac Roles v2, MultiSendCallOnly and USDG contracts, nothing mocked on chain. Every limit is
 * checked twice: through the action (IGNITRA's own checks) and directly against Roles as the
 * session key, which proves the CHAIN refuses it even if IGNITRA did not.
 *
 * Opt-in (needs Foundry's anvil and network access to the public RPC): FORK_TESTS=1.
 */

const RPC = process.env.FORK_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const USDG = normalizeAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const USDG_HOLDER = normalizeAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"); // a pool holding ~29M USDG
const OWNER = normalizeAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"); // anvil's first dev account (unlocked)
const BOB = normalizeAddress("0x00000000000000000000000000000000000b0b0b");
const SAFE_L2_141 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_FACTORY_141 = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const FALLBACK_141 = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function approve(address spender, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const DAY = 86_400;

let anvil: ChildProcess | null = null;
let url = "";
let h: DbHandle;
let writer: ChainTxClient;
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}
async function send(tx: { from: string; to?: string; data?: Hex; value?: bigint; gas?: number }) {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from: tx.from, ...(tx.to ? { to: tx.to } : {}), data: tx.data ?? "0x", value: `0x${(tx.value ?? 0n).toString(16)}`, gas: `0x${(tx.gas ?? 8_000_000).toString(16)}` }]);
  // Mining a fork block may fetch state from the remote RPC first: wait for the receipt.
  for (let i = 0; i < 240; i++) {
    const receipt = await rpc<{ status: string; contractAddress: string | null; logs: Array<{ topics: string[] }> } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) return { hash, receipt };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no receipt for ${hash}`);
}
const chainNow = async () => Number(BigInt((await rpc<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false])).timestamp));
const travel = async (seconds: number) => {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
};
const usdgBalance = async (who: string) => BigInt(await rpc<string>("eth_call", [{ to: USDG, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [who as Hex] }) }, "latest"]));
const ethBalance = async (who: string) => BigInt(await rpc<string>("eth_getBalance", [who, "latest"]));
const nonceOf = async (who: string) => Number(BigInt(await rpc<string>("eth_getTransactionCount", [who, "latest"])));

describe.skipIf(!process.env.FORK_TESTS)("ONCHAIN_TX on a fork of Robinhood Chain", () => {
  let safe: NormalizedAddress;
  let sink: NormalizedAddress;
  let ownerId: string;

  beforeAll(async () => {
    const port = 8600 + Math.floor(Math.random() * 300);
    url = `http://127.0.0.1:${port}`;
    anvil = spawn(process.env.ANVIL ?? "anvil", ["--fork-url", RPC, "--port", String(port), "--no-storage-caching", "--silent"], { stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await rpc<string>("eth_chainId")) === "0x1237") break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const reader = createRpcChainReader({ primary: url }, { expectedChainId: 4663 });
    writer = createChainWriter(reader.pool);
    h = await createDb("pglite://memory");
    await h.migrate();
    ownerId = newId("user");
    await h.db.insert(users).values({ id: ownerId, address: OWNER, plan: "team" });

    // A fresh 1-of-1 Safe 1.4.1, funded with ETH and 1,000 USDG.
    const setup = encodeFunctionData({
      abi: parseAbi(["function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)"]),
      functionName: "setup",
      args: [[OWNER], 1n, zeroAddress, "0x", FALLBACK_141, zeroAddress, 0n, zeroAddress],
    });
    const created = await send({
      from: OWNER,
      to: SAFE_FACTORY_141,
      data: encodeFunctionData({ abi: parseAbi(["function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)"]), functionName: "createProxyWithNonce", args: [SAFE_L2_141, setup, BigInt(Date.now())] }),
    });
    const proxyCreation = keccak256(toHex("ProxyCreation(address,address)"));
    const topic = created.receipt.logs.find((l) => l.topics[0] === proxyCreation)?.topics[1] as string;
    safe = normalizeAddress(`0x${topic.slice(-40)}`);
    await send({ from: OWNER, to: safe, value: 5n * 10n ** 18n });
    await rpc("anvil_impersonateAccount", [USDG_HOLDER]);
    await rpc("anvil_setBalance", [USDG_HOLDER, "0xde0b6b3a7640000"]);
    await send({ from: USDG_HOLDER, to: USDG, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [safe, 1_000_000_000n] }) });
    // A contract that accepts any call and any ETH (runtime: STOP).
    sink = normalizeAddress((await send({ from: OWNER, data: "0x6001600c60003960016000f300" })).receipt.contractAddress as string);
  }, 300_000);

  afterAll(async () => {
    anvil?.kill();
    await h?.close();
  });

  async function grantFor(opts: { expiresIn: number; mandateConnectionId?: string | null; label: string }) {
    const now = await chainNow();
    const input = grantInputSchema.parse({
      label: opts.label,
      safe,
      targets: [
        { address: sink, functions: [{ signature: "function ping() payable" }] },
        { address: USDG, functions: [{ signature: "function transfer(address to, uint256 amount)", amount_arg: 1, max_amount_per_tx: "100000000", max_amount_per_day: "150000000" }] },
      ],
      max_value_per_tx: "0.1",
      max_value_per_day: "0.25",
      expires_at: new Date((now + opts.expiresIn) * 1000).toISOString(),
    });
    const roles = rolesAddressFor(safe);
    const { scope, issues } = normalizeGrantScope(input, { now: now * 1000, forbidden: [{ address: safe, why: "the Safe" }, { address: roles, why: "the Roles modifier" }] });
    expect(issues).toEqual([]);
    const grant = await createGrant(h.db, keyring, { ownerId, chainId: 4663, label: opts.label, safe, scope, mandateConnectionId: opts.mandateConnectionId ?? null });
    const sessionKey = normalizeAddress(grant.sessionKeyAddress);
    const plan = await planGrant(writer, { id: grant.id, safe, sessionKey, scope });
    const exec = await send({ from: OWNER, to: safe, data: execTransactionByOwner(safeTransactionFor(plan.calls), OWNER) });
    expect(exec.receipt.status).toBe("0x1");
    const check = await verifyGrantTransaction(writer, { id: grant.id, safe, roles: plan.roles, roleKey: plan.roleKey, sessionKey, scope }, exec.hash);
    expect(check).toMatchObject({ ok: true, problems: [] });
    await activateGrant(h.db, grant.id, exec.hash, new Date());
    await rpc("anvil_setBalance", [sessionKey, "0xde0b6b3a7640000"]);
    return { grant, plan, scope, sessionKey };
  }

  const action = (mandateRequired = false) => createOnchainTxAction({ db: h.db, keyring, writer, chainId: 4663, explorerUrl: "https://robinhoodchain.blockscout.com", mandateRequired, receiptTimeoutMs: 20_000, pollMs: 100 });
  let step = 0;
  const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
    runId: "run_fork",
    flowId: "fl_fork",
    flowName: "fork",
    flowVersion: 1,
    stepId: "pay",
    idempotencyKey: `fork:${++step}`,
    runIdempotencyKey: "fork",
    attempt: 1,
    isTest: false,
    signal: new AbortController().signal,
    trigger: { to: BOB },
    render: (t, escape) => renderTemplate(t, { trigger: { to: BOB }, steps: {} }, { escape: escape ?? "none" }),
    connection: null,
    http: createSafeHttp({ allowPrivate: true }),
    push: null,
    ownerSigningSecret: null,
    chain: null,
    ownerId,
    flowSettings: { mode: "confirmed", onchain: true },
    ...over,
  });
  /** Straight to Roles as the session key, bypassing IGNITRA: what the chain itself allows. */
  const direct = (g: { plan: { roles: NormalizedAddress; roleKey: Hex }; sessionKey: NormalizedAddress }, to: string, value: bigint, inner: Hex) =>
    writer
      .estimateGas({ from: g.sessionKey, to: g.plan.roles, data: encodeFunctionData({ abi: ROLES_ABI, functionName: "execTransactionWithRole", args: [to as Hex, value, inner, 0, g.plan.roleKey, true] }), value: 0n })
      .then(
        () => "allowed",
        (err: unknown) => explainRevert(err),
      );
  const ping = encodeFunctionData({ abi: parseAbi(["function ping() payable"]), functionName: "ping" });
  const transfer = (amount: bigint) => encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [BOB, amount] });

  it("grants exactly the scope, then the chain enforces every limit", async () => {
    const g = await grantFor({ expiresIn: 3 * DAY, label: "fork A" });
    // The first grant deploys the bounds contract and the Safe's Roles modifier at the predicted addresses.
    expect(g.plan.calls.map((c) => c.description.split(" ")[0])).toEqual(["Deploy", "Deploy", "Enable", "Give", "Allow", "Allow", "Allow", "Allow", "Limit:", "Limit:"]);
    expect(await writer.getCode(SESSION_BOUNDS_ADDRESS)).not.toBe("0x");
    expect(await writer.getCode(g.plan.roles)).not.toBe("0x");
    const onchain = action();
    const run = (params: Record<string, unknown>, over: Partial<ActionContext> = {}) => onchain.execute(onchainTxParams.parse({ grant_id: g.grant.id, ...params }), ctx(over));

    // ETH: 0.1 per call, 0.25 per day.
    const sinkBefore = await ethBalance(sink);
    const first = await run({ to: sink, function: "ping()", value: "0.1" });
    expect(first).toMatchObject({ status: "succeeded", output: { simulated: false, safe, tx_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/), explorer_url: expect.stringContaining("/tx/0x") } });
    expect((await ethBalance(sink)) - sinkBefore).toBe(10n ** 17n);
    expect(await run({ to: sink, function: "ping()", value: "0.11" })).toMatchObject({ status: "failed", retryable: false, error: expect.stringContaining("above the grant's 0.1 ETH per call") });
    expect(await direct(g, sink, 11n * 10n ** 16n, ping)).toBe("the grant does not allow it: the grant has expired or the ETH value is above its per-transaction limit");
    expect((await run({ to: sink, function: "ping()", value: "0.1" })).status).toBe("succeeded");
    expect(await run({ to: sink, function: "ping()", value: "0.1" })).toMatchObject({ status: "failed", error: expect.stringContaining("0.25 ETH per day would be exceeded") });
    expect(await direct(g, sink, 10n ** 17n, ping)).toBe("the grant does not allow it: the grant's daily ETH limit is used up");

    // USDG: 100 per call, 150 per day; approve is not in the grant; neither is any other contract.
    expect((await run({ to: USDG, function: "transfer(address to, uint256 amount)", args: ["{{trigger.to}}", "100000000"] })).status).toBe("succeeded");
    expect(await usdgBalance(BOB)).toBe(100_000_000n);
    expect(await run({ to: USDG, function: "transfer(address,uint256)", args: [BOB, "100000001"] })).toMatchObject({ status: "failed", error: expect.stringContaining("above the grant's 100000000 per call") });
    expect(await direct(g, USDG, 0n, transfer(100_000_001n))).toBe("the grant does not allow it: the amount is above the grant's per-transaction limit");
    expect(await run({ to: USDG, function: "transfer(address,uint256)", args: [BOB, "60000000"] })).toMatchObject({ status: "failed", error: expect.stringContaining("daily amount (150000000) would be exceeded") });
    expect(await direct(g, USDG, 0n, transfer(60_000_000n))).toBe("the grant does not allow it: the grant's daily token limit is used up");
    expect(await run({ to: USDG, function: "approve(address,uint256)", args: [BOB, "1"] })).toMatchObject({ status: "failed", error: expect.stringContaining("is not in grant") });
    expect(await direct(g, USDG, 0n, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [BOB, 1n] }))).toBe("the grant does not allow it: this function is not in the grant");
    expect(await direct(g, "0xca11bde05977b3631167028862be2a173976ca11", 0n, ping)).toBe("the grant does not allow it: this contract is not in the grant");

    // A day later the daily limits refill, on chain and in IGNITRA's 24-hour window alike.
    await travel(DAY + 60);
    expect(await direct(g, USDG, 0n, transfer(50_000_000n))).toBe("allowed");

    // TEST runs simulate only: nothing is sent.
    const nonce = await nonceOf(g.sessionKey);
    expect(await run({ to: sink, function: "ping()", value: "0.01" }, { isTest: true })).toMatchObject({ status: "succeeded", output: { simulated: true, tx_hash: null } });
    expect(await nonceOf(g.sessionKey)).toBe(nonce);

    // Exactly once: the same step again answers from the log, without a second transaction.
    const once = { idempotencyKey: "fork:exactly-once" };
    const sent = await run({ to: sink, function: "ping()", value: "0.01" }, once);
    const again = await run({ to: sink, function: "ping()", value: "0.01" }, once);
    expect(sent.status).toBe("succeeded");
    expect(again).toMatchObject({ status: "succeeded", output: { tx_hash: (sent as unknown as { output: { tx_hash: string } }).output.tx_hash } });
    expect(await nonceOf(g.sessionKey)).toBe(nonce + 1);
    const logged = await h.db.select().from(onchainActions).where(eq(onchainActions.grantId, g.grant.id));
    expect(logged.filter((a) => a.status === "confirmed").every((a) => /^0x[0-9a-f]{64}$/.test(a.txHash ?? ""))).toBe(true);

    // Revoked on the Safe: the chain refuses the session key at once.
    const revoke = await send({ from: OWNER, to: safe, data: execTransactionByOwner(safeTransactionFor([revokeCall({ roles: g.plan.roles, sessionKey: g.sessionKey, roleKey: g.plan.roleKey })]), OWNER) });
    expect(revoke.receipt.status).toBe("0x1");
    expect(await direct(g, sink, 0n, ping)).toBe("the session key no longer holds the role (was it revoked on the Safe?)");
    // Revoked in IGNITRA: the key is wiped, and the action stops before any RPC call.
    await revokeGrant(h.db, g.grant.id, ownerId, new Date());
    const [row] = await h.db.select().from(onchainGrants).where(eq(onchainGrants.id, g.grant.id));
    expect(row).toMatchObject({ status: "revoked", sessionKeyEnc: null });
    expect(await run({ to: sink, function: "ping()", value: "0" })).toMatchObject({ status: "failed", error: expect.stringContaining("is revoked") });
  }, 600_000);

  it("asks MANDATE first (fail-closed), and the chain enforces expiry on its own", async () => {
    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    let mode: "deny" | "allow" | "down" = "deny";
    const seen: Array<{ to: string; value_wei: string; signed: boolean }> = [];
    const mandate: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const intent = JSON.parse(body) as { to: string; value_wei: string };
        seen.push({ to: intent.to, value_wei: intent.value_wei, signed: verifyWebhookSignature({ secret, body, signature: req.headers["x-ignitra-signature"] as string, timestamp: req.headers["x-ignitra-timestamp"] as string }) });
        if (mode === "down") {
          res.writeHead(503).end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(mode === "deny" ? { decision: "deny", reason: "counterparty frozen", policy_id: "pol_1" } : { decision: "allow", policy_id: "pol_1" }));
      });
    });
    await new Promise<void>((r) => mandate.listen(0, "127.0.0.1", r));
    const conn = await createConnection(h.db, keyring, { ownerId, type: "mandate", label: "MANDATE stub", secret: { url: `http://127.0.0.1:${(mandate.address() as AddressInfo).port}/policy`, signing_secret: secret }, metadata: {} });
    try {
      const g = await grantFor({ expiresIn: 20 * 60, mandateConnectionId: conn.id, label: "fork B" });
      // The Safe already has its Roles modifier: the second grant only adds a role.
      expect(g.plan.calls.some((c) => c.description.startsWith("Deploy"))).toBe(false);
      const onchain = action(true);
      const run = (over: Partial<ActionContext> = {}) => onchain.execute(onchainTxParams.parse({ grant_id: g.grant.id, to: sink, function: "ping()", value: "0.01" }), ctx(over));
      const nonce = await nonceOf(g.sessionKey);

      expect(await run()).toMatchObject({ status: "failed", retryable: false, error: "MANDATE denied it: counterparty frozen" });
      mode = "down";
      expect(await run()).toMatchObject({ status: "failed", retryable: true, error: expect.stringContaining("not sent (fail-closed)") });
      expect(await nonceOf(g.sessionKey)).toBe(nonce); // nothing was ever signed and sent
      mode = "allow";
      expect((await run()).status).toBe("succeeded");
      expect(await nonceOf(g.sessionKey)).toBe(nonce + 1);
      expect(seen.every((s) => s.signed && s.to === sink && s.value_wei === "10000000000000000")).toBe(true);

      // Past the expiry the chain refuses, even though IGNITRA's own clock has not moved.
      await travel(21 * 60);
      expect(await run()).toMatchObject({ status: "failed", retryable: false, error: "the grant does not allow it: the grant has expired or the ETH value is above its per-transaction limit" });
      expect(await expireGrants(h.db, new Date((await chainNow()) * 1000))).toBeGreaterThanOrEqual(1);
      const [row] = await h.db.select().from(onchainGrants).where(eq(onchainGrants.id, g.grant.id));
      expect(row).toMatchObject({ status: "expired", sessionKeyEnc: null });
      void (g.scope as GrantScope);
    } finally {
      mandate.close();
    }
  }, 600_000);
});
