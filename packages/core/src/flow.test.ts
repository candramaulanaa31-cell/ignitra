import { describe, expect, it } from "vitest";
import { LIMITS, flowDefinitionSchema, type ConditionNode, type FlowDefinitionInput } from "./flow";

const base: FlowDefinitionInput = {
  trigger: { type: "TOKEN_TRANSFER", params: { token: "0x0000000000000000000000000000000000000001" } },
  actions: [{ step_id: "notify", type: "DISCORD", params: { connection_id: "conn_x", template: "hi" } }],
};

const parse = (input: unknown) => flowDefinitionSchema.safeParse(input);

describe("flowDefinitionSchema", () => {
  it("accepts a minimal flow and applies default settings", () => {
    const result = parse(base);
    expect(result.success).toBe(true);
    expect(result.data?.settings).toEqual({ mode: "confirmed", max_runs_per_hour: 60, onchain: false });
  });

  it("accepts nested all/any conditions", () => {
    const result = parse({
      ...base,
      conditions: {
        all: [
          { field: "percent_of_supply", op: ">=", value: 0.5 },
          { any: [{ field: "to", op: "IN", value: ["0xabc", "0xdef"] }, { field: "token.symbol", op: "==", value: "XYZ" }] },
          { field: "memo", op: "EXISTS" },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown trigger and action types", () => {
    expect(parse({ ...base, trigger: { type: "NOPE", params: {} } }).success).toBe(false);
    expect(parse({ ...base, actions: [{ step_id: "a", type: "NOPE", params: {} }] }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(parse({ ...base, extra: true }).success).toBe(false);
    expect(parse({ ...base, settings: { mode: "fast", turbo: true } }).success).toBe(false);
  });

  it("requires 1..max actions with unique step ids", () => {
    expect(parse({ ...base, actions: [] }).success).toBe(false);
    const step = base.actions[0];
    expect(parse({ ...base, actions: [step, step] }).success).toBe(false);
    const many = Array.from({ length: LIMITS.maxActions + 1 }, (_, i) => ({ ...step, step_id: `s${i}` }));
    expect(parse({ ...base, actions: many }).success).toBe(false);
  });

  it("validates step_id format (used in {{steps.<id>}})", () => {
    for (const step_id of ["Notify", "1st", "has-dash", "a".repeat(41)]) {
      expect(parse({ ...base, actions: [{ ...base.actions[0], step_id }] }).success).toBe(false);
    }
  });

  it("enforces operator/value shapes", () => {
    const leaf = (l: object) => parse({ ...base, conditions: { all: [l] } }).success;
    expect(leaf({ field: "amount", op: ">", value: "1000" })).toBe(true);
    expect(leaf({ field: "amount", op: ">" })).toBe(false);
    expect(leaf({ field: "to", op: "IN", value: "0xabc" })).toBe(false);
    expect(leaf({ field: "to", op: "==", value: ["0xabc"] })).toBe(false);
    expect(leaf({ field: "memo", op: "EXISTS", value: 5 })).toBe(false);
    expect(leaf({ field: "amount", op: "LIKE", value: 1 })).toBe(false);
    expect(leaf({ field: "bad path!", op: "==", value: 1 })).toBe(false);
    expect(leaf({ field: "amount", op: ">", value: { $gt: 1 } })).toBe(false);
  });

  it("requires the conditions root to be a group", () => {
    expect(parse({ ...base, conditions: { field: "a", op: "==", value: 1 } }).success).toBe(false);
    expect(parse({ ...base, conditions: { all: [] } }).success).toBe(false);
  });

  it("bounds condition depth and size", () => {
    let deep: ConditionNode = { field: "a", op: "==", value: 1 };
    for (let i = 0; i < LIMITS.maxConditionDepth; i++) deep = { all: [deep] };
    expect(parse({ ...base, conditions: deep }).success).toBe(false);

    const wide = { all: Array.from({ length: LIMITS.maxConditionNodes }, () => ({ field: "a", op: "==", value: 1 })) };
    expect(parse({ ...base, conditions: wide }).success).toBe(false);
  });

  it("bounds max_runs_per_hour", () => {
    expect(parse({ ...base, settings: { max_runs_per_hour: 0 } }).success).toBe(false);
    expect(parse({ ...base, settings: { max_runs_per_hour: LIMITS.maxRunsPerHour + 1 } }).success).toBe(false);
  });
});
