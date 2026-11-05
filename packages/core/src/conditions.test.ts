import { describe, expect, it } from "vitest";
import { conditionEquals, evaluateConditions, resolveField } from "./conditions";
import { compareDecimal, numberToDecimal, toDecimal } from "./decimal";
import type { ConditionGroup, ConditionLeaf } from "./flow";

const ctx = {
  amount: "1000000000000000000000", // 1e21 raw — beyond float precision
  amount_decimal: "1000.5",
  percent_of_supply: 0.82,
  from: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
  to: "0x0000000000000000000000000000000000000b0b",
  is_mint: false,
  memo: null,
  token: { symbol: "USDG", decimals: 6 },
  tags: ["whale", "dex"],
  time: { hour_wib: 9, minutes_wib: 545 },
};

const one = (leaf: ConditionLeaf) => evaluateConditions({ all: [leaf] }, ctx).results[0]!;

describe("decimal arithmetic", () => {
  it.each([
    ["1", "2", -1],
    ["10", "9", 1],
    ["1000000000000000000001", "1000000000000000000000", 1],
    ["0.1", "0.10", 0],
    ["-1", "0", -1],
    ["-0", "0", 0],
    ["-2.5", "-2.4", -1],
    ["007", "7", 0],
    ["0.000001", "0", 1],
  ] as const)("compareDecimal(%s, %s) = %i", (a, b, expected) => {
    expect(compareDecimal(a, b)).toBe(expected);
  });

  it("converts numbers without exponent notation or float noise", () => {
    expect(numberToDecimal(1e21)).toBe("1000000000000000000000");
    expect(numberToDecimal(0.5)).toBe("0.5");
    expect(numberToDecimal(1e-7)).toBe("0.0000001");
    expect(numberToDecimal(Number.NaN)).toBeNull();
    expect(toDecimal("12.5")).toBe("12.5");
    expect(toDecimal("1e5")).toBeNull();
    expect(toDecimal("0x10")).toBeNull();
    expect(toDecimal(true)).toBeNull();
  });
});

describe("equality semantics", () => {
  it("compares numbers and numeric strings exactly", () => {
    expect(conditionEquals("1000000000000000000000", 1e21)).toEqual({ equal: true });
    expect(conditionEquals("1000000000000000000001", 1e21)).toEqual({ equal: false });
  });

  it("compares hex case-insensitively and other strings exactly", () => {
    expect(conditionEquals("0xABCdef", "0xabcDEF")).toEqual({ equal: true });
    expect(conditionEquals("USDG", "usdg")).toEqual({ equal: false });
  });

  it("refuses to compare incompatible types", () => {
    expect(conditionEquals(true, "true")).toEqual({ mismatch: true });
    expect(conditionEquals("USDG", 5)).toEqual({ mismatch: true });
  });
});

describe("operators", () => {
  it("== and !=", () => {
    expect(one({ field: "token.symbol", op: "==", value: "USDG" }).passed).toBe(true);
    expect(one({ field: "from", op: "==", value: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }).passed).toBe(true);
    expect(one({ field: "from", op: "!=", value: "0x0000000000000000000000000000000000000000" }).passed).toBe(true);
    expect(one({ field: "is_mint", op: "==", value: false }).passed).toBe(true);
    expect(one({ field: "is_mint", op: "!=", value: "no" })).toMatchObject({ passed: false, error: "type_mismatch" });
  });

  it("> >= < <= with exact decimals", () => {
    expect(one({ field: "amount", op: ">", value: "999999999999999999999" }).passed).toBe(true);
    expect(one({ field: "amount", op: ">", value: 1e21 }).passed).toBe(false);
    expect(one({ field: "amount", op: ">=", value: 1e21 }).passed).toBe(true);
    expect(one({ field: "percent_of_supply", op: ">=", value: 0.5 }).passed).toBe(true);
    expect(one({ field: "percent_of_supply", op: "<", value: 0.82 }).passed).toBe(false);
    expect(one({ field: "percent_of_supply", op: "<=", value: 0.82 }).passed).toBe(true);
    expect(one({ field: "amount_decimal", op: ">", value: "1000.49" }).passed).toBe(true);
  });

  it("ordering on non-numeric values is a type mismatch", () => {
    expect(one({ field: "token.symbol", op: ">", value: 1 })).toMatchObject({ passed: false, error: "type_mismatch" });
    expect(one({ field: "amount", op: ">", value: "lots" })).toMatchObject({ passed: false, error: "type_mismatch" });
  });

  it("IN and NOT_IN", () => {
    const list = ["0x0000000000000000000000000000000000000B0B", "0x0000000000000000000000000000000000000001"];
    expect(one({ field: "to", op: "IN", value: list }).passed).toBe(true);
    expect(one({ field: "to", op: "NOT_IN", value: list }).passed).toBe(false);
    expect(one({ field: "token.symbol", op: "IN", value: ["USDC", "USDT"] }).passed).toBe(false);
    expect(one({ field: "token.symbol", op: "NOT_IN", value: ["USDC", "USDT"] }).passed).toBe(true);
    expect(one({ field: "time.hour_wib", op: "IN", value: [8, 9, 10] }).passed).toBe(true);
  });

  it("CONTAINS on strings and arrays", () => {
    expect(one({ field: "token.symbol", op: "CONTAINS", value: "SD" }).passed).toBe(true);
    expect(one({ field: "token.symbol", op: "CONTAINS", value: "sd" }).passed).toBe(false);
    expect(one({ field: "from", op: "CONTAINS", value: "0x5AAE" }).passed).toBe(true);
    expect(one({ field: "tags", op: "CONTAINS", value: "whale" }).passed).toBe(true);
    expect(one({ field: "tags", op: "CONTAINS", value: "cex" }).passed).toBe(false);
    expect(one({ field: "percent_of_supply", op: "CONTAINS", value: "8" })).toMatchObject({ error: "type_mismatch" });
  });

  it("EXISTS treats null as missing", () => {
    expect(one({ field: "token.symbol", op: "EXISTS" }).passed).toBe(true);
    expect(one({ field: "memo", op: "EXISTS" }).passed).toBe(false);
    expect(one({ field: "memo", op: "EXISTS", value: false }).passed).toBe(true);
    expect(one({ field: "nope", op: "EXISTS", value: false }).passed).toBe(true);
  });

  it("fails every other operator on missing or null fields — never runs on absent data", () => {
    for (const op of ["==", "!=", ">", "<", "IN", "NOT_IN", "CONTAINS"] as const) {
      const value = op === "IN" || op === "NOT_IN" ? ["x"] : "1";
      expect(one({ field: "nope", op, value })).toMatchObject({ passed: false, error: "missing_field", actual: null });
      expect(one({ field: "memo", op, value })).toMatchObject({ passed: false, error: "missing_field" });
    }
  });
});

describe("groups", () => {
  it("evaluates every leaf (no short-circuit) and reports paths", () => {
    const conditions: ConditionGroup = {
      all: [
        { field: "percent_of_supply", op: ">=", value: 1 },
        { any: [{ field: "token.symbol", op: "==", value: "USDG" }, { field: "nope", op: "==", value: 1 }] },
      ],
    };
    const evaluation = evaluateConditions(conditions, ctx);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.results.map((r) => [r.path, r.passed])).toEqual([
      ["all.0", false],
      ["all.1.any.0", true],
      ["all.1.any.1", false],
    ]);
    expect(evaluation.results[0]).toMatchObject({ field: "percent_of_supply", actual: 0.82, expected: 1 });
  });

  it("any passes when one child passes; all needs every child", () => {
    expect(evaluateConditions({ any: [{ field: "amount", op: ">", value: 1 }, { field: "nope", op: "==", value: 1 }] }, ctx).passed).toBe(true);
    expect(evaluateConditions({ all: [{ field: "amount", op: ">", value: 1 }, { field: "nope", op: "==", value: 1 }] }, ctx).passed).toBe(false);
  });

  it("passes with no conditions", () => {
    expect(evaluateConditions(undefined, ctx)).toEqual({ passed: true, results: [] });
  });

  it("supports time windows via minutes since midnight (08:00–22:00 WIB)", () => {
    const window: ConditionGroup = { all: [{ field: "time.minutes_wib", op: ">=", value: 480 }, { field: "time.minutes_wib", op: "<", value: 1320 }] };
    expect(evaluateConditions(window, ctx).passed).toBe(true);
    expect(evaluateConditions(window, { time: { minutes_wib: 1350 } }).passed).toBe(false);
  });
});

describe("safety", () => {
  it("never reads through the prototype chain", () => {
    expect(resolveField({}, "constructor")).toBeUndefined();
    expect(resolveField({}, "__proto__")).toBeUndefined();
    expect(resolveField({ a: { b: 1 } }, "a.toString")).toBeUndefined();
    expect(resolveField({ a: [1, 2] }, "a.length")).toBeUndefined();
  });

  it("summarizes oversized values in traces", () => {
    const big = { blob: "x".repeat(1000), list: Array.from({ length: 50 }, (_, i) => i) };
    const [blob, list] = evaluateConditions({ all: [{ field: "blob", op: "EXISTS" }, { field: "list", op: "EXISTS" }] }, big).results;
    expect(String(blob?.actual)).toHaveLength(257);
    expect(list?.actual).toHaveLength(21);
  });

  it("never throws on hostile input", () => {
    const weird = { a: Symbol("s"), b: () => 1, c: 10n, d: Number.POSITIVE_INFINITY };
    for (const field of ["a", "b", "c", "d"]) {
      const evaluation = evaluateConditions({ all: [{ field, op: ">", value: 1 }] }, weird);
      expect(() => JSON.stringify(evaluation)).not.toThrow(); // traces are persisted as JSON
    }
  });
});
