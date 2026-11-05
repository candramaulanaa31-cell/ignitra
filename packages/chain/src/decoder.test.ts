import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { normalizeHash } from "@ignitra/core";
import { BUILTIN_ABIS } from "./abis";
import { EventDecoder } from "./decoder";
import { addr, encodeLog, erc20Transfer, erc721Transfer, type LogSpec } from "./testing";
import type { RawLog } from "./types";

const TOKEN = addr(0xaa);
const ALICE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BOB = addr(0xb0b);

function raw(spec: LogSpec): RawLog {
  return {
    address: addr(0xaa),
    topics: spec.topics.map((t) => normalizeHash(t)),
    data: (spec.data ?? "0x") as `0x${string}`,
    blockNumber: 1,
    blockHash: normalizeHash(`0x${"11".repeat(32)}`),
    blockTimestamp: 1,
    txHash: normalizeHash(`0x${"22".repeat(32)}`),
    txIndex: 0,
    logIndex: 0,
  };
}

const decoder = new EventDecoder();

describe("EventDecoder — built-ins", () => {
  it("decodes ERC-20 Transfer with normalized args", () => {
    const value = 123_456_789_012_345_678_901_234_567_890n; // > 2^53: must not lose precision
    const decoded = decoder.decode(raw(erc20Transfer(TOKEN, ALICE, BOB, value)));
    expect(decoded).toEqual({
      name: "Transfer",
      signature: "Transfer(address,address,uint256)",
      source: "builtin:erc20",
      args: { from: ALICE.toLowerCase(), to: BOB, value: value.toString() },
    });
  });

  it("decodes ERC-721 Transfer (same topic0, tokenId indexed) via the erc721 variant", () => {
    const decoded = decoder.decode(raw(erc721Transfer(TOKEN, ALICE, BOB, 42n)));
    expect(decoded?.source).toBe("builtin:erc721");
    expect(decoded?.args).toEqual({ from: ALICE.toLowerCase(), to: BOB, tokenId: "42" });
  });

  it("decodes both Safe AddedOwner layouts (v1.4 indexed, v1.3 not)", () => {
    const [indexed, plain] = BUILTIN_ABIS.safe.filter((i) => i.type === "event" && i.name === "AddedOwner");
    const owner = addr(0x0e);
    const v14 = encodeLog([indexed!], "AddedOwner", { owner }, TOKEN);
    const v13 = encodeLog([plain!], "AddedOwner", { owner }, TOKEN);
    expect(v14.topics).toHaveLength(2);
    expect(v13.topics).toHaveLength(1);
    expect(v14.topics[0]).toBe(v13.topics[0]);
    expect(decoder.decode(raw(v14))?.args).toEqual({ owner });
    expect(decoder.decode(raw(v13))?.args).toEqual({ owner });
  });

  it("decodes proxy upgrades and ownership changes", () => {
    const impl = addr(0x1234);
    const upgraded = decoder.decode(raw(encodeLog(BUILTIN_ABIS.erc1967, "Upgraded", { implementation: impl }, TOKEN)));
    expect(upgraded).toMatchObject({ name: "Upgraded", source: "builtin:erc1967", args: { implementation: impl } });

    const owned = decoder.decode(
      raw(encodeLog(BUILTIN_ABIS.ownable, "OwnershipTransferred", { previousOwner: ALICE, newOwner: BOB }, TOKEN)),
    );
    expect(owned?.args).toEqual({ previousOwner: ALICE.toLowerCase(), newOwner: BOB });
  });

  it("normalizes bytes32 to lowercase hex", () => {
    const role = `0x${"AB".repeat(32)}` as const;
    const decoded = decoder.decode(
      raw(encodeLog(BUILTIN_ABIS.accessControl, "RoleGranted", { role, account: ALICE, sender: BOB }, TOKEN)),
    );
    expect(decoded?.args.role).toBe(role.toLowerCase());
  });
});

describe("EventDecoder — contract ABIs", () => {
  const custom = parseAbi([
    "event Launched(address indexed token, string symbol, uint256[] tiers, (address owner, uint64 cap) config)",
    "event Ping(uint256, address)",
  ]);

  it("prefers the contract ABI and handles strings, arrays, tuples", () => {
    const log = encodeLog(
      custom,
      "Launched",
      { token: BOB, symbol: "XYZ", tiers: [1n, 2n], config: { owner: ALICE, cap: 10n } },
      TOKEN,
    );
    const decoded = decoder.decode(raw(log), custom);
    expect(decoded).toEqual({
      name: "Launched",
      signature: "Launched(address,string,uint256[],(address,uint64))",
      source: "contract",
      args: { token: BOB, symbol: "XYZ", tiers: ["1", "2"], config: { owner: ALICE.toLowerCase(), cap: "10" } },
    });
  });

  it("names unnamed params arg<i>", () => {
    const pingAbi = custom.filter((i) => i.type === "event" && i.name === "Ping");
    const [event] = pingAbi;
    if (!event || event.type !== "event") throw new Error("fixture");
    const log: LogSpec = {
      address: TOKEN,
      topics: encodeEventTopics({ abi: [event], eventName: "Ping" }) as `0x${string}`[],
      data: encodeAbiParameters(event.inputs, [7n, BOB]),
    };
    expect(decoder.decode(raw(log), custom)?.args).toEqual({ arg0: "7", arg1: BOB });
  });

  it("falls back to built-ins when the contract ABI lacks the event", () => {
    const decoded = decoder.decode(raw(erc20Transfer(TOKEN, ALICE, BOB, 1n)), custom);
    expect(decoded?.source).toBe("builtin:erc20");
  });

  it("skips malformed ABI items instead of failing", () => {
    const broken = [{ type: "event", name: "Bad", inputs: [{ type: "notatype", name: "x" }] }] as never;
    expect(decoder.decode(raw(erc20Transfer(TOKEN, ALICE, BOB, 1n)), broken)?.source).toBe("builtin:erc20");
  });
});

describe("EventDecoder — undecodable input never throws", () => {
  it("returns null for unknown topic0, anonymous logs, and corrupt data", () => {
    expect(decoder.decode(raw({ address: TOKEN, topics: [`0x${"99".repeat(32)}`] }))).toBeNull();
    expect(decoder.decode(raw({ address: TOKEN, topics: [] }))).toBeNull();
    const transfer = erc20Transfer(TOKEN, ALICE, BOB, 1n);
    expect(decoder.decode(raw({ ...transfer, data: "0x1234" }))).toBeNull();
    expect(decoder.decode(raw({ ...transfer, topics: transfer.topics.slice(0, 2) }))).toBeNull();
  });

  it("computes selectors from signatures and fragments", () => {
    const expected = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    expect(EventDecoder.selector("Transfer(address,address,uint256)")).toBe(expected);
    expect(EventDecoder.selector("event Transfer(address indexed from, address indexed to, uint256 value)")).toBe(expected);
  });
});
