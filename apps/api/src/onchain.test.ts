import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChainConfig, type ChainTxClient } from "@ignitra/core";
import { createKeyring, createLogger } from "@ignitra/core/server";
import { addr } from "@ignitra/chain/testing";
import { createConnection } from "@ignitra/actions";
import { apiKeys, connections, createDb, flows, onchainActions, onchainGrants, sessions, users, type DbHandle } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import { createSession } from "./auth";
import { buildServer } from "./server";

/** Phase 8: onchain grant routes and ONCHAIN_TX flow validation (the chain itself: onchain.fork.test.ts). */

const chain = resolveChainConfig({ chainId: 4663 });
const logger = createLogger("api-test", "silent");
const keyring = createKeyring({ kid: "k1", key: randomBytes(32) });
const SAFE = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const SINK = "0x2222222222222222222222222222222222222222";
const SEL = {
  getOwners: toFunctionSelector("getOwners()"),
  getThreshold: toFunctionSelector("getThreshold()"),
  isModuleEnabled: toFunctionSelector("isModuleEnabled(address)"),
  getModulesPaginated: toFunctionSelector("getModulesPaginated(address,uint256)"),
};
const MODULE = "0x4444444444444444444444444444444444444444";

let h: DbHandle;
let owners: string[] = [];
let threshold = 1;
let notASafe = false;
let modules: string[] = [];
let modulesFail = false;
const fakeChain: ChainTxClient = {
  nonce: async () => 0,
  balance: async () => 5n * 10n ** 16n,
  async call({ data }) {
    if (notASafe) throw new Error("execution reverted");
    if (data.startsWith(SEL.getOwners as string)) return encodeAbiParameters([{ type: "address[]" }], [owners as `0x${string}`[]]);
    if (data.startsWith(SEL.getThreshold as string)) return encodeAbiParameters([{ type: "uint256" }], [BigInt(threshold)]);
    if (data.startsWith(SEL.isModuleEnabled as string)) return encodeAbiParameters([{ type: "bool" }], [false]);
    if (data.startsWith(SEL.getModulesPaginated as string)) {
      if (modulesFail) throw new Error("rpc unavailable");
      return encodeAbiParameters([{ type: "address[]" }, { type: "address" }], [modules as `0x${string}`[], "0x0000000000000000000000000000000000000001"]);
    }
    throw new Error("unexpected call");
  },
  getCode: async () => "0x",
  estimateGas: async () => 100_000n,
  fees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
  sendRawTransaction: async () => `0x${"ab".repeat(32)}`,
  receipt: async () => null,
};

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
}, 30_000);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  for (const t of [onchainActions, onchainGrants, apiKeys, sessions, connections]) await h.db.delete(t);
  await h.db.delete(flows);
  await h.db.delete(users);
  threshold = 1;
  notASafe = false;
  modules = [];
  modulesFail = false;
  app = await buildServer({ db: h, chain, logger, version: "test", keyring, chainTx: fakeChain, mandateRequired: false });
});

async function user(plan: "free" | "builder" | "team" = "team") {
  const address = addr(Math.floor(Math.random() * 1e9));
  const userId = await ensureUser(h.db, address);
  await h.db.update(users).set({ plan }).where(eq(users.id, userId));
  const { token } = await createSession(h.db, { userId, chainId: 4663, userAgent: "test", ttlMs: 3_600_000, now: Date.now() });
  owners = [address];
  return { userId, address, auth: { authorization: `Bearer ${token}` } };
}

const grantBody = (over: Record<string, unknown> = {}) => ({
  label: "Treasury bot",
  safe: SAFE,
  targets: [
    { address: SINK, functions: [{ signature: "ping() payable" }] },
    { address: TOKEN, functions: [{ signature: "transfer(address to, uint256 amount)", amount_arg: 1, max_amount_per_tx: "100000000", max_amount_per_day: "150000000" }] },
  ],
  max_value_per_tx: "0.1",
  max_value_per_day: "0.25",
  expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  ...over,
});

describe("onchain grants", () => {
  it("creates a pending grant and the Safe transaction to approve, never exposing the session key", async () => {
    const me = await user();
    const res = await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody() });
    expect(res.statusCode).toBe(201);
    const { data, approval } = res.json();
    expect(data).toMatchObject({ status: "pending", safe: SAFE, scope: { max_value_per_tx: "0.1", max_value_per_day: "0.25" }, session_key: expect.stringMatching(/^0x[0-9a-f]{40}$/) });
    expect(approval.calls.map((c: { description: string }) => c.description.split(" ")[0])).toEqual(["Deploy", "Deploy", "Enable", "Give", "Allow", "Allow", "Allow", "Allow", "Limit:", "Limit:"]);
    expect(approval.owner_transaction).toMatchObject({ from: me.address, to: SAFE, value: "0" });
    expect(approval.tx_builder).toMatchObject({ chainId: "4663", meta: { createdFromSafeAddress: SAFE } });
    expect(JSON.stringify(res.json())).not.toMatch(/private|session_key_enc|ciphertext/i);
    const [row] = await h.db.select().from(onchainGrants);
    expect(row?.sessionKeyEnc).not.toBeNull(); // stored encrypted, server-side only

    // A multisig (or a Safe the caller does not own) gets the Transaction Builder batch instead.
    threshold = 2;
    const multi = (await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody({ label: "multisig" }) })).json().approval;
    expect(multi.owner_transaction).toBeNull();
    expect(multi.note).toMatch(/needs 2 signatures/);
  });

  it("is a Team feature, needs a wallet session, a real Safe and a safe scope", async () => {
    const free = await user("free");
    expect((await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: free.auth, payload: grantBody() })).json().error).toMatchObject({ code: "plan_limit_reached", limit: "onchain" });
    const me = await user();
    const key = (await app.inject({ method: "POST", url: "/v1/api-keys", headers: me.auth, payload: { name: "ci" } })).json().key;
    expect((await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: { authorization: `Bearer ${key}` }, payload: grantBody() })).json().error.code).toBe("session_required");
    const risky = await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody({ targets: [{ address: TOKEN, functions: [{ signature: "approve(address,uint256)" }] }, { address: SAFE, functions: [{ signature: "addOwnerWithThreshold(address,uint256)" }] }] }) });
    expect(risky.statusCode).toBe(422);
    expect(risky.json().error.issues.map((i: { path: string }) => i.path)).toEqual(["targets.0.functions.0.amount_arg", "targets.1.address"]);
    notASafe = true;
    expect((await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody() })).json().error.code).toBe("not_a_safe");
  });

  it("refuses the Safe's other modules as targets: each can act as the Safe", async () => {
    const me = await user();
    modules = [MODULE];
    const res = await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody({ targets: [{ address: MODULE, functions: [{ signature: "execTransactionFromModule(address,uint256,bytes,uint8)" }] }] }) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.issues).toContainEqual({ path: "targets.0.address", message: expect.stringContaining("an enabled module of this Safe") });
    // Unknown modules mean an unknown risk: no grant until they can be read.
    modulesFail = true;
    const blind = await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody() });
    expect([blind.statusCode, blind.json().error.code]).toEqual([502, "chain_unavailable"]);
  });

  it("keeps a grant's MANDATE policy for as long as the grant can act", async () => {
    const me = await user();
    const mandate = await createConnection(h.db, keyring, { ownerId: me.userId, type: "mandate", label: "Policy", secret: { url: "https://mandate.example/policy", signing_secret: "whsec_x" }, metadata: {} });
    const id = (await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody({ mandate_connection_id: mandate.id }) })).json().data.id;
    const inUse = await app.inject({ method: "DELETE", url: `/v1/connections/${mandate.id}`, headers: me.auth });
    expect([inUse.statusCode, inUse.json().error.code, inUse.json().error.grants]).toEqual([409, "connection_in_use", [id]]);
    // The database holds the link too (it is never silently dropped).
    await expect(h.db.delete(connections).where(eq(connections.id, mandate.id))).rejects.toThrow();
    await app.inject({ method: "POST", url: `/v1/onchain/grants/${id}/revoke`, headers: me.auth });
    expect((await app.inject({ method: "DELETE", url: `/v1/connections/${mandate.id}`, headers: me.auth })).statusCode).toBe(204);
    const [row] = await h.db.select().from(onchainGrants).where(eq(onchainGrants.id, id));
    expect(row).toMatchObject({ status: "revoked", mandateConnectionId: null });
  });

  it("requires a MANDATE policy when the server does (the default)", async () => {
    const strict = await buildServer({ db: h, chain, logger, version: "test", keyring, chainTx: fakeChain });
    const me = await user();
    const res = await strict.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody() });
    expect(res.json().error.issues).toContainEqual({ path: "mandate_connection_id", message: expect.stringContaining("requires a MANDATE policy") });
    const mandate = await createConnection(h.db, keyring, { ownerId: me.userId, type: "mandate", label: "Policy", secret: { url: "https://mandate.example/policy", signing_secret: "whsec_x" }, metadata: {} });
    expect((await strict.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody({ mandate_connection_id: mandate.id }) })).statusCode).toBe(201);
  });

  it("verifies before activating, revokes at once (key wiped) and lists actions", async () => {
    const me = await user();
    const id = (await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody() })).json().data.id;
    const unmined = await app.inject({ method: "POST", url: `/v1/onchain/grants/${id}/verify`, headers: me.auth, payload: { tx_hash: `0x${"12".repeat(32)}` } });
    expect(unmined.statusCode).toBe(422);
    expect(unmined.json().error.problems[0]).toMatch(/not mined/);
    const detail = (await app.inject({ method: "GET", url: `/v1/onchain/grants/${id}`, headers: me.auth })).json().data;
    expect(detail).toMatchObject({ status: "pending", session_key_balance: "0.05", actions: [] });

    const revoked = await app.inject({ method: "POST", url: `/v1/onchain/grants/${id}/revoke`, headers: me.auth });
    expect(revoked.json().data.status).toBe("revoked");
    expect(revoked.json().onchain.calls[0].description).toMatch(/Remove IGNITRA's session key/);
    const [row] = await h.db.select().from(onchainGrants).where(eq(onchainGrants.id, id));
    expect(row).toMatchObject({ status: "revoked", sessionKeyEnc: null });
    expect((await app.inject({ method: "GET", url: "/v1/onchain/grants", headers: me.auth })).json().data).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/v1/onchain/actions", headers: me.auth })).json().data).toEqual([]);
    const stranger = await user();
    expect((await app.inject({ method: "GET", url: `/v1/onchain/grants/${id}`, headers: stranger.auth })).statusCode).toBe(404);
  });
});

describe("ONCHAIN_TX in flows", () => {
  it("needs the opt-in, confirmed mode and an unrevoked grant that covers the call", async () => {
    const me = await user();
    const id = (await app.inject({ method: "POST", url: "/v1/onchain/grants", headers: me.auth, payload: grantBody() })).json().data.id;
    const flow = (settings: Record<string, unknown>, params: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: me.auth,
        payload: {
          name: "Pay",
          definition: {
            trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
            actions: [{ step_id: "pay", type: "ONCHAIN_TX", params: { grant_id: id, to: TOKEN, function: "transfer(address to, uint256 amount)", args: ["{{trigger.from}}", "1000"], ...params } }],
            settings,
          },
        },
      });
    const issues = async (r: Awaited<ReturnType<typeof flow>>) => (r.json().error?.issues ?? []).map((i: { path: string; message: string }) => `${i.path}: ${i.message}`);
    expect(await issues(await flow({}))).toContainEqual("settings.onchain: ONCHAIN_TX is off by default: opt in with settings.onchain = true");
    expect(await issues(await flow({ onchain: true, mode: "fast" }))).toContainEqual("settings.mode: ONCHAIN_TX runs on confirmed events only");
    expect((await issues(await flow({ onchain: true }, { function: "approve(address,uint256)" })))[0]).toMatch(/^actions\.0\.params\.function: not in grant/);
    expect((await issues(await flow({ onchain: true }, { to: SAFE })))[0]).toMatch(/^actions\.0\.params\.to: .* is not in grant/);
    expect((await flow({ onchain: true })).statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/v1/onchain/grants/${id}/revoke`, headers: me.auth });
    expect(await issues(await flow({ onchain: true }))).toContainEqual(`actions.0.params.grant_id: grant ${id} is revoked`);
  });
});
