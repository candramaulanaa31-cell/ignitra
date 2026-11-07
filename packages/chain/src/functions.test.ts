import { encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  FunctionCallError,
  decodeFunctionReturn,
  encodeFunctionCall,
  formatFunctionFragment,
  normalizeCallArgs,
  parseFunctionFragment,
  resolveFunctionByName,
  returnFields,
} from "./functions";

const BALANCE_OF = "function balanceOf(address account) view returns (uint256)";

describe("function fragments", () => {
  it("parses and canonicalizes signatures (with or without the `function` keyword)", () => {
    expect(formatFunctionFragment(parseFunctionFragment("balanceOf(address account) view returns (uint256)"))).toBe(BALANCE_OF);
    expect(formatFunctionFragment(parseFunctionFragment("function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 ts)"))).toBe(
      "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 ts)",
    );
  });

  it("refuses what a read cannot use", () => {
    expect(() => parseFunctionFragment("function poke()")).toThrow(/declares no return values/);
    expect(() => parseFunctionFragment("function f(address[] a) view returns (uint256)")).toThrow(/not supported/);
    expect(() => parseFunctionFragment("event Transfer(address from)")).toThrow(FunctionCallError);
    expect(() => parseFunctionFragment("not a signature")).toThrow(/cannot parse/);
  });

  it("resolves bare names from a contract ABI plus built-ins, by argument count", () => {
    expect(formatFunctionFragment(resolveFunctionByName("totalSupply", 0, null))).toBe("function totalSupply() view returns (uint256)");
    expect(formatFunctionFragment(resolveFunctionByName("balanceOf", 1, null))).toBe(BALANCE_OF);
    const abi = parseAbi(["function price() view returns (uint256)", "function price(address) view returns (uint256)"]);
    expect(resolveFunctionByName("price", 1, abi).inputs).toHaveLength(1);
    expect(() => resolveFunctionByName("price", 2, abi)).toThrow(/not found/);
    expect(() => resolveFunctionByName("nope", 0, null)).toThrow(/ABI unavailable/);
  });
});

describe("encoding arguments", () => {
  const fn = parseFunctionFragment("function f(address a, uint8 small, int256 signed, bool flag, bytes4 tag, string s) view returns (uint256)");

  it("coerces JSON scalars: decimal strings, safe integers, booleans, hex", () => {
    const data = encodeFunctionCall(fn, ["0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED".toLowerCase(), "255", -5, "true", "0xdeadbeef", "hi"]);
    expect(data.startsWith("0x")).toBe(true);
    expect(normalizeCallArgs(fn, ["0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", 7, "-5", false, "0xDEADBEEF", "hi"])).toEqual([
      "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
      "7",
      "-5",
      false,
      "0xdeadbeef",
      "hi",
    ]);
  });

  it("explains bad arguments instead of failing deep inside the encoder", () => {
    expect(() => encodeFunctionCall(fn, [])).toThrow(/expects 6 argument/);
    const ok = ["0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "1", "1", true, "0xdeadbeef", "x"] as const;
    const bad = (i: number, v: string | number | boolean) => () => encodeFunctionCall(fn, ok.map((o, j) => (j === i ? v : o)));
    expect(bad(0, "0x123")).toThrow(/argument 1 .*not a valid address/);
    expect(bad(1, "256")).toThrow(/out of range for uint8/);
    expect(bad(1, "1.5")).toThrow(/expected an integer/);
    expect(bad(1, 2 ** 60)).toThrow(/expected an integer/); // unsafe JS number: use a string
    expect(bad(3, "yes")).toThrow(/true or false/);
    expect(bad(4, "0xdead")).toThrow(/exactly 4 bytes/);
  });
});

describe("decoding results", () => {
  it("one return value → the value; several → an object; big integers as strings", () => {
    const typed = parseAbi([BALANCE_OF, "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, bool unlocked)"]);
    const single = parseFunctionFragment(BALANCE_OF);
    expect(decodeFunctionReturn(single, encodeFunctionResult({ abi: typed, functionName: "balanceOf", result: 10n ** 30n }))).toBe("1000000000000000000000000000000");
    const multi = parseFunctionFragment("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, bool unlocked)");
    const data = encodeFunctionResult({ abi: typed, functionName: "slot0", result: [5n, -3, true] });
    expect(decodeFunctionReturn(multi, data)).toEqual({ sqrtPriceX96: "5", tick: -3, unlocked: true });
  });

  it("empty return data means no contract / no such function", () => {
    expect(() => decodeFunctionReturn(parseFunctionFragment(BALANCE_OF), "0x")).toThrow(/returned no data/);
  });

  it("derives field specs for conditions and templates", () => {
    expect(returnFields(parseFunctionFragment(BALANCE_OF), "current", "Now")).toEqual([{ path: "current", type: "uint", description: "Now `uint256`" }]);
    const fields = returnFields(parseFunctionFragment("function slot0() view returns (uint160 sqrtPriceX96, int24 tick)"), "result", "Return value");
    expect(fields.map((f) => [f.path, f.type])).toEqual([
      ["result.sqrtPriceX96", "uint"],
      ["result.tick", "int"],
    ]);
  });
});
