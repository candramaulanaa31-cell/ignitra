import { encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { normalizeHash, resolveChainConfig } from "@ignitra/core";
import { createLogger } from "@ignitra/core/server";
import { FakeChain, addr } from "@ignitra/chain/testing";
import { TokenInfo } from "./tokens";
import { LAUNCHPADS, TOKEN_LAUNCHED_TOPIC, newLaunchTrigger, parseTokenLaunched } from "./triggers/index";
import type { ChainEventView, FlowScope, TriggerRuntime } from "./types";

/**
 * NEW_LAUNCH (Phase 8). The launch below is a recorded mainnet log: Pons V2 factory,
 * tx 0x7bddc8a6061ac9d703ae0f23512cffb4a4be0e826b55f143927d0ceb66bf5e5a, block 108423028,
 * log index 10 (fetched 2026-11-07). Its socials() answer is re-encoded from the values the
 * token returned on chain the same day.
 */

const chainConfig = resolveChainConfig({ chainId: 4663 });
const scope: FlowScope = { flowId: "fl_test", generation: "g1" };
const TOKEN = "0xea4b90998cbc8bd7a9fe259fdfa493cd106493f1";
const DEPLOYER = "0x5d2bdab52763add33e61ab56f50cfe1b284fc0bf";
const RECORDED = {
  topics: [
    "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
    "0x000000000000000000000000ea4b90998cbc8bd7a9fe259fdfa493cd106493f1",
    "0x0000000000000000000000007ce010189c94d8d8edf471691be1ae9f455cf8e6",
    "0x0000000000000000000000005d2bdab52763add33e61ab56f50cfe1b284fc0bf",
  ] as `0x${string}`[],
  data: "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003a4965bf58a40000" as `0x${string}`,
};
const SOCIALS = parseAbi(["function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)"]);

function setup() {
  const chain = new FakeChain();
  const token = chain.token(TOKEN, { symbol: "THINKR", name: "ThinkrOS", decimals: 18 });
  chain.registerContract(TOKEN, (data, block) =>
    data.startsWith("0x53cd512a") ? encodeFunctionResult({ abi: SOCIALS, functionName: "socials", result: ["https://x.com/ThinkrOS", "", "", "https://thinkros.space", ""] }) : token.handle(data, block),
  );
  chain.mine([token.mint(addr(0xc0ffee), 1_000_000_000n * 10n ** 18n)]);
  chain.mine([{ address: LAUNCHPADS.pons.factory, topics: RECORDED.topics, data: RECORDED.data }]);
  const views: ChainEventView[] = [];
  for (let n = 1; n <= chain.head; n++) for (const log of chain.block(n)?.logs ?? []) views.push({ id: views.length + 1, chainId: 4663, status: "confirmed", ...log });
  const rt: TriggerRuntime = { chain: chainConfig, reader: chain, tokens: new TokenInfo(chain), logger: createLogger("test", "silent") };
  return { chain, views, rt, token };
}

describe("NEW_LAUNCH", () => {
  it("knows the Pons launch event by its verified signature", () => {
    expect(TOKEN_LAUNCHED_TOPIC).toBe(RECORDED.topics[0]);
    expect(newLaunchTrigger.watches(newLaunchTrigger.paramsSchema.parse({}))).toEqual([{ address: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", topic0: TOKEN_LAUNCHED_TOPIC }]);
    expect(parseTokenLaunched({ topics: RECORDED.topics.map((t) => normalizeHash(t)), data: RECORDED.data })).toEqual({
      token: TOKEN,
      curve: "0x7ce010189c94d8d8edf471691be1ae9f455cf8e6",
      deployer: DEPLOYER,
      pairToken: "0x0000000000000000000000000000000000000000",
      launchConfigId: 0n,
      graduationThreshold: 4_200_000_000_000_000_000n,
    });
    expect(parseTokenLaunched({ topics: RECORDED.topics.slice(0, 3).map((t) => normalizeHash(t)), data: RECORDED.data })).toBeNull();
  });

  it("builds the payload: token metadata, native ETH pair, threshold, the launcher's socials", async () => {
    const { views, rt } = setup();
    const [mint, launch] = await newLaunchTrigger.matchBatch(views, newLaunchTrigger.paramsSchema.parse({}), rt, scope);
    expect(mint).toBeNull(); // a token log, not a launch
    expect(launch).toMatchObject({
      kind: "match",
      payload: {
        launchpad: "pons",
        token: { address: TOKEN, symbol: "THINKR", name: "ThinkrOS", decimals: 18, total_supply_decimal: "1000000000" },
        deployer: DEPLOYER,
        curve: "0x7ce010189c94d8d8edf471691be1ae9f455cf8e6",
        pair_token: "0x0000000000000000000000000000000000000000",
        pair_symbol: "ETH",
        launch_config_id: "0",
        graduation_threshold: "4200000000000000000",
        graduation_threshold_decimal: "4.2",
        socials: { twitter: "https://x.com/ThinkrOS", telegram: null, discord: null, website: "https://thinkros.space", farcaster: null },
        contract: LAUNCHPADS.pons.factory,
        block_number: 2,
      },
    });
  });

  it("filters by deployer, and missing socials stay null rather than invented", async () => {
    const { views, rt, chain, token } = setup();
    const other = await newLaunchTrigger.matchBatch(views, newLaunchTrigger.paramsSchema.parse({ deployer: addr(0xbad) }), rt, scope);
    expect(other).toEqual([null, null]);
    const mine = await newLaunchTrigger.matchBatch(views, newLaunchTrigger.paramsSchema.parse({ deployer: DEPLOYER.toUpperCase().replace("0X", "0x") }), rt, scope);
    expect(mine[1]?.kind).toBe("match");
    // A token whose socials() reverts (or that has none): metadata still works, socials stay null.
    chain.registerContract(TOKEN, (data, block) => {
      if (data.startsWith("0x53cd512a")) throw new Error("execution reverted");
      return token.handle(data, block);
    });
    const bare = await newLaunchTrigger.matchBatch(views.slice(1), newLaunchTrigger.paramsSchema.parse({}), { ...rt, tokens: new TokenInfo(chain) }, scope);
    expect(bare[0]?.kind === "match" && bare[0].payload.socials).toEqual({ twitter: null, telegram: null, discord: null, website: null, farcaster: null });
  });
});
