import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeAddress } from "@ignitra/core";
import { createSafeHttp } from "./http";
import { SESSION_BOUNDS_ADDRESS, SESSION_BOUNDS_INITCODE } from "./onchain/contracts";
import { askMandate, type MandateIntent } from "./onchain/mandate";
import { boundsCompValue, encodeMultiSend, execTransactionByOwner, functionConditions, roleKeyFor, rolesAddressFor, safeTransactionFor } from "./onchain/roles";
import { grantInputSchema, normalizeGrantScope } from "./onchain/scope";
import { verifyWebhookSignature } from "./signing";

/** ONCHAIN_TX building blocks without a chain (the fork test runs them against real contracts). */

const SAFE = normalizeAddress("0x1111111111111111111111111111111111111111");
const TOKEN = normalizeAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const NOW = Date.parse("2026-11-07T12:00:00Z");
const base = (over: Record<string, unknown> = {}) =>
  grantInputSchema.parse({
    label: "test",
    safe: SAFE,
    targets: [{ address: TOKEN, functions: [{ signature: "transfer(address to, uint256 amount)", amount_arg: 1, max_amount_per_tx: "100", max_amount_per_day: "150" }] }],
    max_value_per_tx: "0",
    max_value_per_day: "0",
    expires_at: new Date(NOW + 86_400_000).toISOString(),
    ...over,
  });
const check = (input: ReturnType<typeof base>) => normalizeGrantScope(input, { now: NOW, forbidden: [{ address: SAFE, why: "the Safe itself" }] });

describe("grant scope rules", () => {
  it("normalizes a valid grant", () => {
    const { scope, issues } = check(base({ max_value_per_tx: "0.1", max_value_per_day: "0.5" }));
    expect(issues).toEqual([]);
    expect(scope.targets[0]?.functions[0]).toMatchObject({ signature: "transfer(address,uint256)", selector: "0xa9059cbb", amount: { arg: 1, max_per_tx: "100", max_per_day: "150" } });
    expect(scope).toMatchObject({ max_value_per_tx_wei: "100000000000000000", max_value_per_day_wei: "500000000000000000" });
  });

  it("refuses what would let the session key take over or drain the Safe", () => {
    const paths = (input: ReturnType<typeof base>) => check(input).issues.map((i) => `${i.path}: ${i.message}`);
    expect(paths(base({ targets: [{ address: SAFE, functions: [{ signature: "addOwnerWithThreshold(address,uint256)" }] }] }))).toContainEqual("targets.0.address: not allowed: the Safe itself");
    // Token movers need amount limits.
    for (const signature of ["transfer(address,uint256)", "approve(address,uint256)", "transferFrom(address,address,uint256)", "increaseAllowance(address,uint256)"]) {
      expect(paths(base({ targets: [{ address: TOKEN, functions: [{ signature }] }] })).some((p) => p.includes("moves tokens"))).toBe(true);
    }
    expect(paths(base({ targets: [{ address: TOKEN, functions: [{ signature: "transfer(address,uint256)", amount_arg: 0, max_amount_per_tx: "1", max_amount_per_day: "1" }] }] }))).toContainEqual("targets.0.functions.0.amount_arg: argument 0 is not an unsigned integer");
    expect(paths(base({ targets: [{ address: TOKEN, functions: [{ signature: "transfer(address,uint256)", amount_arg: 1, max_amount_per_tx: "200", max_amount_per_day: "100" }] }] }))).toContainEqual("targets.0.functions.0.max_amount_per_tx: the per-transaction limit is above the daily one");
    expect(paths(base({ targets: [{ address: TOKEN, functions: [{ signature: "balanceOf(address) view returns (uint256)" }] }] })).some((p) => p.includes("read-only"))).toBe(true);
    expect(paths(base({ max_value_per_tx: "1", max_value_per_day: "0" }))).toContainEqual("max_value_per_day: set a daily ETH limit at least as large as the per-transaction one");
  });

  it("bounds the expiry between 10 minutes and 90 days", () => {
    expect(check(base({ expires_at: new Date(NOW + 5 * 60_000).toISOString() })).issues.map((i) => i.path)).toEqual(["expires_at"]);
    expect(check(base({ expires_at: new Date(NOW + 91 * 86_400_000).toISOString() })).issues.map((i) => i.path)).toEqual(["expires_at"]);
    expect(() => base({ max_value_per_tx: "0.0000000001" })).toThrow(); // finer than the gwei the chain bound counts
  });
});

describe("Roles v2 encoding", () => {
  it("derives one deterministic Roles modifier per Safe and one role per grant", () => {
    expect(rolesAddressFor(SAFE)).toBe(rolesAddressFor(SAFE));
    expect(rolesAddressFor(SAFE)).not.toBe(rolesAddressFor(TOKEN));
    expect(roleKeyFor("grt_a")).not.toBe(roleKeyFor("grt_b"));
  });

  it("packs expiry and the per-call ETH cap for IgnitraSessionBounds", () => {
    const compValue = boundsCompValue(1_800_000_000, 10n ** 17n);
    expect(compValue.slice(0, 42)).toBe(SESSION_BOUNDS_ADDRESS);
    const extra = BigInt(`0x${compValue.slice(42)}`);
    expect(extra >> 64n).toBe(1_800_000_000n);
    expect(extra & ((1n << 64n) - 1n)).toBe(100_000_000n); // gwei
  });

  it("builds breadth-first condition trees that Roles accepts", () => {
    const { scope } = check(base({ max_value_per_tx: "0.1", max_value_per_day: "0.5" }));
    const fn = scope.targets[0]?.functions[0];
    if (!fn) throw new Error("no function");
    const tree = functionConditions("grt_x", TOKEN, fn, scope);
    expect(tree.map((c) => [c.parent, c.paramType, c.operator])).toEqual([
      [0, 5, 5], // Matches(Calldata)
      [0, 1, 0], // to: Pass(Static)
      [0, 0, 1], // amount: And
      [0, 0, 22], // Custom(IgnitraSessionBounds)
      [0, 0, 29], // EtherWithinAllowance
      [2, 1, 18], // amount < 101
      [2, 1, 28], // amount within the daily allowance
    ]);
    expect(BigInt(tree[5]?.compValue ?? "0x0")).toBe(101n);
    for (let i = 1; i < tree.length; i++) expect((tree[i] as { parent: number }).parent).toBeGreaterThanOrEqual((tree[i - 1] as { parent: number }).parent);
  });

  it("batches through MultiSendCallOnly (delegatecall to it only), and signs as the sending owner", () => {
    const calls = [
      { to: SAFE, value: 0n, data: "0x12345678" as const, description: "a" },
      { to: TOKEN, value: 1n, data: "0x" as const, description: "b" },
    ];
    const tx = safeTransactionFor(calls);
    expect(tx).toMatchObject({ to: "0x9641d764fc13c8b624c04430c7356c1c7c8102e2", operation: 1 });
    expect(encodeMultiSend(calls).startsWith("0x8d80ff0a")).toBe(true);
    expect(safeTransactionFor([calls[0] as (typeof calls)[number]])).toMatchObject({ to: SAFE, operation: 0 });
    const data = execTransactionByOwner(tx, SAFE);
    expect(data.endsWith(`${SAFE.slice(2).padStart(64, "0")}${"0".repeat(64)}01${"0".repeat(62)}`)).toBe(true); // r = owner, s = 0, v = 1
  });

  it("embeds the bounds contract exactly as forge builds it", () => {
    const artifact = "../../contracts/out/IgnitraSessionBounds.sol/IgnitraSessionBounds.json";
    if (!existsSync(artifact)) return; // contracts/out appears after `forge build`
    expect((JSON.parse(readFileSync(artifact, "utf8")) as { bytecode: { object: string } }).bytecode.object).toBe(SESSION_BOUNDS_INITCODE);
  });
});

describe("MANDATE protocol", () => {
  let server: Server;
  let url: string;
  let answer: { status: number; body: string } = { status: 200, body: "{}" };
  const requests: Array<{ body: string; signed: boolean; idem: string | undefined }> = [];
  const secret = "whsec_mandate_unit_test_secret";
  const intent: MandateIntent = {
    chain_id: 4663,
    grant_id: "grt_1",
    safe: SAFE,
    session_key: TOKEN,
    to: TOKEN,
    function: "transfer(address,uint256)",
    selector: "0xa9059cbb",
    args: ["0xabc", "1"],
    value_wei: "0",
    flow_id: "fl_1",
    run_id: "run_1",
    step_id: "pay",
    idempotency_key: "4663:x:pay",
    test: false,
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ body, signed: verifyWebhookSignature({ secret, body, signature: req.headers["x-ignitra-signature"] as string, timestamp: req.headers["x-ignitra-timestamp"] as string }), idem: req.headers["x-ignitra-idempotency-key"] as string | undefined });
        res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/policy`;
  });
  afterAll(() => {
    server.close();
  });

  const ask = () => askMandate(createSafeHttp({ allowPrivate: true }), { url, secret }, intent, 2000);

  it("sends a signed intent and needs an explicit allow", async () => {
    answer = { status: 200, body: JSON.stringify({ decision: "allow", policy_id: "pol_7" }) };
    expect(await ask()).toEqual({ decision: "allow", reason: null, policy_id: "pol_7", status: 200 });
    expect(requests.at(-1)).toMatchObject({ signed: true, idem: "4663:x:pay" });
    expect(JSON.parse(requests.at(-1)?.body ?? "{}")).toMatchObject({ type: "onchain.intent", grant_id: "grt_1", to: TOKEN, value_wei: "0" });
  });

  it("treats deny as final and anything unclear as unavailable (fail-closed)", async () => {
    answer = { status: 200, body: JSON.stringify({ decision: "deny", reason: "counterparty frozen" }) };
    expect(await ask()).toMatchObject({ decision: "deny", reason: "counterparty frozen" });
    for (const a of [{ status: 500, body: "{}" }, { status: 200, body: "not json" }, { status: 200, body: JSON.stringify({ decision: "maybe" }) }, { status: 200, body: JSON.stringify({ allow: true }) }]) {
      answer = a;
      expect((await ask()).decision).toBe("unavailable");
    }
    const down = await askMandate(createSafeHttp({ allowPrivate: true }), { url: "http://127.0.0.1:1/policy", secret }, intent, 1000);
    expect(down.decision).toBe("unavailable");
  });
});
