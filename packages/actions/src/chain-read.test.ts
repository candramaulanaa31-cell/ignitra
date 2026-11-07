import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { renderTemplate, validateTemplate, type ActionContext } from "@ignitra/core";
import { CallRevertedError } from "@ignitra/chain";
import { FakeChain, addr } from "@ignitra/chain/testing";
import { chainReadAction, chainReadParams } from "./actions/chain-read";
import { createSafeHttp } from "./http";

const TOKEN = addr(0x70c);
const HOLDER = addr(0xb0b);
const abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function boom() view returns (uint256)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
]);

function chain(stateWindow: number | null = null): FakeChain {
  const c = new FakeChain(stateWindow === null ? {} : { stateWindow });
  c.registerContract(TOKEN, (data, block) => {
    const call = decodeFunctionData({ abi, data });
    if (call.functionName === "balanceOf") return encodeFunctionResult({ abi, functionName: "balanceOf", result: call.args[0].toLowerCase() === HOLDER ? 10n ** 24n + BigInt(block) : 0n });
    if (call.functionName === "slot0") return encodeFunctionResult({ abi, functionName: "slot0", result: [79228162514264337593543950336n, -7] });
    throw new CallRevertedError("eth_call: execution reverted", "0x08c379a0");
  });
  c.mineEmpty(5);
  return c;
}

function ctx(c: FakeChain | null, trigger: Record<string, unknown> = { token: { address: TOKEN }, to: HOLDER, block_number: 3 }): ActionContext {
  const scope = { trigger, steps: {}, flow: { id: "fl_1", name: "Reads", version: 1 }, run: { id: "run_1", idempotency_key: "k", test: false }, now_utc: "", now_wib: "" };
  return {
    runId: "run_1",
    flowId: "fl_1",
    flowName: "Reads",
    flowVersion: 1,
    stepId: "read",
    idempotencyKey: "k:read",
    runIdempotencyKey: "k",
    attempt: 1,
    isTest: false,
    signal: new AbortController().signal,
    trigger,
    render: (t, escape) => renderTemplate(t, scope, { escape: escape ?? "none" }),
    connection: null,
    http: createSafeHttp(),
    push: null,
    ownerSigningSecret: null,
    chain: c,
  };
}

const params = (p: unknown) => chainReadParams.parse(p);
const BALANCE_OF = "function balanceOf(address account) view returns (uint256)";

describe("CHAIN_READ params", () => {
  it("canonicalizes the function and checks literal arguments at save time", () => {
    expect(params({ address: TOKEN.toUpperCase().replace("0X", "0x"), function: "balanceOf(address account) view returns (uint256)", args: [HOLDER] })).toEqual({
      address: TOKEN,
      function: BALANCE_OF,
      args: [HOLDER],
      block: "latest",
    });
    const issues = (p: unknown) => chainReadParams.safeParse(p).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ address: TOKEN, function: BALANCE_OF, args: [] })).toEqual(["balanceOf expects 1 argument(s), got 0"]);
    expect(issues({ address: TOKEN, function: BALANCE_OF, args: ["0x12"] })[0]).toMatch(/not a valid address/);
    expect(issues({ address: "nope", function: BALANCE_OF, args: [HOLDER] })[0]).toMatch(/must be an address or a template/);
    expect(issues({ address: TOKEN, function: "function poke()", args: [] })[0]).toMatch(/declares no return values/);
    // Templates are checked once rendered.
    expect(chainReadParams.safeParse({ address: "{{trigger.token.address}}", function: BALANCE_OF, args: ["{{trigger.to}}"] }).success).toBe(true);
  });

  it("types its output from the return values and needs a chain trigger for block \"trigger\"", () => {
    const single = params({ address: TOKEN, function: BALANCE_OF, args: [HOLDER] });
    expect(chainReadAction.outputFieldsFor?.(single).map((f) => [f.path, f.type])).toEqual([
      ["result", "uint"],
      ["block_number", "uint"],
    ]);
    const fields = chainReadAction.outputFieldsFor?.(params({ address: TOKEN, function: "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)" })) ?? [];
    expect(validateTemplate("{{steps.read.result.tick}}", { triggerFields: [], earlierSteps: new Map([["read", fields]]) })).toEqual([]);
    expect(validateTemplate("{{steps.read.result.nope}}", { triggerFields: [], earlierSteps: new Map([["read", fields]]) })).toEqual(['unknown variable "steps.read.result.nope"']);
    expect(chainReadAction.validate?.(params({ address: TOKEN, function: BALANCE_OF, args: [HOLDER], block: "trigger" }), { triggerFields: [] })).toEqual([
      'block "trigger" needs a chain trigger (this trigger has no block_number); use "latest"',
    ]);
  });
});

describe("CHAIN_READ execution", () => {
  it("renders templated address and args, reads at the latest block, exposes result and block", async () => {
    const c = chain();
    const result = await chainReadAction.execute(params({ address: "{{trigger.token.address}}", function: BALANCE_OF, args: ["{{trigger.to}}"] }), ctx(c));
    expect(result).toMatchObject({
      status: "succeeded",
      output: { result: (10n ** 24n + 5n).toString(), block_number: 5 },
      request: { contract: TOKEN, function: "balanceOf(address)", args: [HOLDER], block: 5 },
    });
  });

  it("reads at the trigger's block, and explains pruned history", async () => {
    const p = params({ address: TOKEN, function: BALANCE_OF, args: [HOLDER], block: "trigger" });
    expect(await chainReadAction.execute(p, ctx(chain()))).toMatchObject({ status: "succeeded", output: { result: (10n ** 24n + 3n).toString(), block_number: 3 } });
    expect(await chainReadAction.execute(p, ctx(chain(1)))).toMatchObject({ status: "failed", retryable: false, error: expect.stringMatching(/no longer has state for block 3.*use block "latest"/) });
  });

  it("decodes several return values into an object", async () => {
    const result = await chainReadAction.execute(params({ address: TOKEN, function: "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)" }), ctx(chain()));
    expect(result).toMatchObject({ status: "succeeded", output: { result: { sqrtPriceX96: "79228162514264337593543950336", tick: -7 } } });
  });

  it("fails permanently on reverts and bad rendered input, retryably on RPC trouble", async () => {
    const c = chain();
    expect(await chainReadAction.execute(params({ address: TOKEN, function: "function boom() view returns (uint256)" }), ctx(c))).toMatchObject({
      status: "failed",
      retryable: false,
      error: "call reverted (data 0x08c379a0)",
    });
    expect(await chainReadAction.execute(params({ address: "{{trigger.to}}x", function: BALANCE_OF, args: [HOLDER] }), ctx(c))).toMatchObject({ status: "failed", retryable: false, error: expect.stringMatching(/not a valid address/) });
    expect(await chainReadAction.execute(params({ address: TOKEN, function: BALANCE_OF, args: ["{{trigger.token.address}}x"] }), ctx(c))).toMatchObject({ status: "failed", retryable: false });
    c.failNext("call", new Error("primary: eth_call: HTTP 429"));
    expect(await chainReadAction.execute(params({ address: TOKEN, function: BALANCE_OF, args: [HOLDER] }), ctx(c))).toMatchObject({ status: "failed", retryable: true, error: expect.stringMatching(/RPC error/) });
    expect(await chainReadAction.execute(params({ address: TOKEN, function: BALANCE_OF, args: [HOLDER] }), ctx(null))).toMatchObject({ status: "failed", retryable: false, error: "this runner has no chain RPC configured" });
  });
});
