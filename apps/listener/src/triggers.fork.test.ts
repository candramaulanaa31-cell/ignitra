import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeAddress, resolveChainConfig, type NormalizedAddress } from "@ignitra/core";
import { createLogger } from "@ignitra/core/server";
import { EventDecoder, createRpcChainReader, type RpcChainReader } from "@ignitra/chain";
import { createDb, runs, users, type DbHandle } from "@ignitra/db";
import { LAUNCHPADS, Matcher, TOKEN_LAUNCHED_TOPIC, TokenInfo, createFlow, createTriggerModules, ensureUser, type FlowServiceDeps } from "@ignitra/engine";
import { ListenerStore } from "./store";
import { ChainSync } from "./sync";

/**
 * Phase 9 trigger matrix: every chain trigger, end to end, against a local fork of Robinhood Chain
 * mainnet (anvil): real USDG, a real Pons launch re-sent with a fresh salt, real RPC reads through the production
 * reader → ChainSync → chain_events → Matcher → runs. Then a restart of both proves each event
 * still has exactly one run. (SCHEDULE, INBOUND_WEBHOOK and VIGIL_ALERT do not read the chain:
 * they were validated live, see the README.)
 *
 * Opt-in (needs Foundry's anvil and network access to the public RPC): FORK_TESTS=1.
 */

const REMOTE = process.env.FORK_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const USDG = normalizeAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const USDG_HOLDER = normalizeAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"); // a pool holding ~29M USDG
const FUNDER = normalizeAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"); // anvil's first dev account (unlocked)
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function approve(address spender, uint256 amount) returns (bool)"]);
const silent = createLogger("fork", "silent");
const fresh = () => normalizeAddress(`0x${randomBytes(20).toString("hex")}`);

let anvil: ChildProcess | null = null;
let url = "";
let h: DbHandle;
let reader: RpcChainReader;
let owner: string;

async function call<T = unknown>(endpoint: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}
const rpc = <T = unknown>(method: string, params: unknown[] = []) => call<T>(url, method, params);

interface Receipt {
  status: string;
  contractAddress: string | null;
  logs: Array<{ address: string; topics: string[] }>;
}
async function send(tx: { from: string; to?: string; data?: Hex; value?: bigint; gas?: number }): Promise<Receipt> {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from: tx.from, ...(tx.to ? { to: tx.to } : {}), data: tx.data ?? "0x", value: `0x${(tx.value ?? 0n).toString(16)}`, gas: `0x${(tx.gas ?? 8_000_000).toString(16)}` }]);
  for (let i = 0; i < 240; i++) {
    const receipt = await rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no receipt for ${hash}`);
}
const usdg = (to: string, amount: bigint) => send({ from: USDG_HOLDER, to: USDG, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to as Hex, amount] }) });

// The Pons V2 router's launchAndBuy (verified source on Sourcify, read 2026-11-08).
const PONS_ROUTER = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
const LAUNCH_AND_BUY = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
]);

/**
 * Launches a token on the fork the way real launches do: the newest real `launchAndBuy` through the
 * Pons router, sent again by its sender with a fresh CREATE2 salt (the token and curve addresses
 * derive from the salt, so re-sending the original reverts: that pair already exists).
 */
async function launchLikeTheLatest(): Promise<NormalizedAddress> {
  const head = Number(BigInt(await call<string>(REMOTE, "eth_blockNumber")));
  const logs = await call<Array<{ transactionHash: string }>>(REMOTE, "eth_getLogs", [
    { address: LAUNCHPADS.pons.factory, topics: [TOKEN_LAUNCHED_TOPIC], fromBlock: `0x${(head - 9_000).toString(16)}`, toBlock: `0x${head.toString(16)}` },
  ]);
  const tried: string[] = [];
  for (const log of logs.reverse().slice(0, 6)) {
    const tx = await call<{ from: string; to: string; input: Hex; value: string }>(REMOTE, "eth_getTransactionByHash", [log.transactionHash]);
    if (tx.to.toLowerCase() !== PONS_ROUTER) continue;
    let original;
    try {
      original = decodeFunctionData({ abi: LAUNCH_AND_BUY, data: tx.input });
    } catch {
      continue;
    }
    const [params, configId, pairToken, quoteIn, minOut, recipient, exemptions] = original.args;
    const data = encodeFunctionData({
      abi: LAUNCH_AND_BUY,
      functionName: "launchAndBuy",
      args: [{ ...params, salt: `0x${randomBytes(32).toString("hex")}` }, configId, pairToken, quoteIn, minOut, recipient, exemptions],
    });
    await rpc("anvil_impersonateAccount", [tx.from]);
    await rpc("anvil_setBalance", [tx.from, `0x${(BigInt(tx.value) + 10n ** 19n).toString(16)}`]);
    const receipt = await send({ from: tx.from, to: tx.to, data, value: BigInt(tx.value) });
    const launched = receipt.logs.find((l) => l.address.toLowerCase() === LAUNCHPADS.pons.factory && l.topics[0] === TOKEN_LAUNCHED_TOPIC);
    if (receipt.status === "0x1" && launched?.topics[1]) return normalizeAddress(`0x${launched.topics[1].slice(26)}`);
    tried.push(`${log.transactionHash}: ${receipt.status}`);
  }
  throw new Error(`no Pons launch went through on the fork (${logs.length} recent launches; tried ${tried.join(", ") || "none via the router"})`);
}

function pipeline() {
  const sync = new ChainSync({
    reader,
    store: new ListenerStore(h.db, { chainId: 4663, owner: "fork-listener" }),
    decoder: new EventDecoder(),
    abis: null,
    logger: silent,
    options: { strategy: "depth", depth: 2, maxRange: 100, addressChunk: 100, rewindBlocks: 20 },
  });
  const matcher = new Matcher({
    db: h.db,
    chain: resolveChainConfig({ chainId: 4663 }),
    reader,
    tokens: new TokenInfo(reader),
    triggers: createTriggerModules(),
    logger: silent,
    owner: "fork-matcher",
    options: { pollIntervalMs: 0, flowsCacheMs: 0, evaluationsPerMinute: 10_000 },
  });
  return {
    /** Mines `blocks` so every earlier block is confirmed, then lets both loops catch up. */
    async settle(blocks = 3) {
      await rpc("anvil_mine", [`0x${blocks.toString(16)}`]);
      for (let i = 0; i < 4; i++) {
        await sync.tick();
        await matcher.tick();
      }
    },
  };
}

const deps = (): FlowServiceDeps => ({ db: h.db, chainId: 4663, triggers: createTriggerModules(), prepare: { abis: null } });
async function flow(name: string, trigger: Record<string, unknown>): Promise<string> {
  const created = await createFlow(deps(), { ownerId: owner, name, activate: true, definition: { trigger, actions: [{ step_id: "notify", type: "WEBHOOK", params: { url: "https://example.com/hook" } }] } });
  return created.flowId;
}
const runsOf = async (flowId: string) => (await h.db.select().from(runs).where(eq(runs.flowId, flowId)).orderBy(asc(runs.createdAt), asc(runs.id))).map((r) => ({ key: r.idempotencyKey, event: r.triggerEvent as Record<string, unknown> }));

describe.skipIf(!process.env.FORK_TESTS)("every chain trigger on a fork of Robinhood Chain", () => {
  beforeAll(async () => {
    const port = 8600 + Math.floor(Math.random() * 300);
    url = `http://127.0.0.1:${port}`;
    anvil = spawn(process.env.ANVIL ?? "anvil", ["--fork-url", REMOTE, "--port", String(port), "--no-storage-caching", "--silent"], { stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await rpc<string>("eth_chainId")) === "0x1237") break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    reader = createRpcChainReader({ primary: url }, { expectedChainId: 4663 });
    h = await createDb("pglite://memory");
    await h.migrate();
    owner = await ensureUser(h.db, FUNDER);
    await h.db.update(users).set({ plan: "team" }).where(eq(users.id, owner));
    await rpc("anvil_impersonateAccount", [USDG_HOLDER]);
    await rpc("anvil_setBalance", [USDG_HOLDER, "0xde0b6b3a7640000"]);
  }, 300_000);

  afterAll(async () => {
    anvil?.kill();
    await h?.close();
  });

  it("turns each trigger's real onchain event into exactly one run, also after a restart", async () => {
    const [bob, carol, dave, erin, deployer] = [fresh(), fresh(), fresh(), fresh(), fresh()];
    await rpc("anvil_impersonateAccount", [deployer]);
    await rpc("anvil_setBalance", [deployer, "0xde0b6b3a7640000"]);

    const p = pipeline();
    await p.settle(); // cursors and offsets start at the fork's head: no history replay
    const f = {
      transfer: await flow("USDG into Bob", { type: "TOKEN_TRANSFER", params: { token: USDG, wallet: bob, direction: "in" } }),
      approval: await flow("USDG approvals", { type: "CONTRACT_EVENT", params: { address: USDG, event: "Approval(address indexed owner, address indexed spender, uint256 value)" } }),
      holder: await flow("New USDG holders", { type: "NEW_HOLDER", params: { token: USDG } }),
      balance: await flow("Erin above 1 ETH", { type: "BALANCE_THRESHOLD", params: { wallet: erin, asset: "native", threshold: "1", direction: "above" } }),
      deployed: await flow("Deployer ships", { type: "CONTRACT_DEPLOYED", params: { deployer } }),
      state: await flow("Bob's USDG balance", { type: "STATE_CHANGE", params: { address: USDG, function: "function balanceOf(address account) view returns (uint256)", args: [bob] } }),
      launch: await flow("Pons launches", { type: "NEW_LAUNCH", params: { launchpad: "pons" } }),
    };
    await p.settle(); // poll triggers take their first sample: nothing has crossed or changed yet
    expect(await h.db.select().from(runs)).toHaveLength(0);

    // Round 1: one real event per trigger.
    await usdg(bob, 12_500_000n); // 12.5 USDG: TOKEN_TRANSFER, NEW_HOLDER, STATE_CHANGE
    await send({ from: USDG_HOLDER, to: USDG, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [carol as Hex, 5_000_000n] }) });
    await usdg(dave, 1_000_000n); // NEW_HOLDER only
    await send({ from: FUNDER, to: erin, value: 2n * 10n ** 18n }); // crosses 1 ETH
    const contract = normalizeAddress((await send({ from: deployer, data: "0x6001600c60003960016000f300" })).contractAddress as string);
    const token = await launchLikeTheLatest();
    await p.settle();

    // Round 2: repeats that must not fire again (already a holder, still above), and one that must.
    await usdg(bob, 1_000_000n); // TOKEN_TRANSFER and STATE_CHANGE again; Bob is no NEW holder
    await send({ from: FUNDER, to: erin, value: 10n ** 18n });
    await p.settle();

    const expectRuns = async () => {
      expect((await runsOf(f.transfer)).map((r) => r.event.amount_decimal)).toEqual(["12.5", "1"]);
      expect((await runsOf(f.approval)).map((r) => [(r.event.args as Record<string, unknown>).spender, (r.event.args as Record<string, unknown>).value])).toEqual([[carol, "5000000"]]);
      expect((await runsOf(f.holder)).map((r) => r.event.holder).sort()).toEqual([bob, dave].sort());
      expect((await runsOf(f.balance)).map((r) => [r.event.direction, r.event.balance_after_decimal])).toEqual([["above", "2"]]);
      expect((await runsOf(f.deployed)).map((r) => r.event.contract)).toEqual([contract]);
      expect((await runsOf(f.state)).map((r) => [r.event.previous, r.event.current])).toEqual([
        ["0", "12500000"],
        ["12500000", "13500000"],
      ]);
      expect((await runsOf(f.launch)).map((r) => (r.event.token as { address?: string }).address ?? r.event.token)).toEqual([token]);
    };
    await expectRuns();

    // A restart (new listener and matcher on the same database) replays nothing.
    const restarted = pipeline();
    await restarted.settle(5);
    await expectRuns();
    const keys = (await h.db.select({ key: runs.idempotencyKey }).from(runs)).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  }, 600_000);
});
