import { describe, expect, it } from "vitest";
import { CHAIN_EVIDENCE_FIELDS, validateConditionFields, type FieldSpec } from "./fields";

const fields: FieldSpec[] = [
  ...CHAIN_EVIDENCE_FIELDS,
  { path: "amount", type: "uint", description: "" },
  { path: "percent_of_supply", type: "number", description: "", nullable: true },
  { path: "token.symbol", type: "string", description: "" },
  { path: "from", type: "address", description: "" },
];

describe("validateConditionFields", () => {
  it("accepts known fields with compatible operators", () => {
    expect(
      validateConditionFields(
        { all: [{ field: "percent_of_supply", op: ">=", value: 0.5 }, { field: "token.symbol", op: "CONTAINS", value: "US" }, { field: "time.hour_wib", op: "<", value: 22 }] },
        fields,
      ),
    ).toEqual([]);
  });

  it("rejects unknown fields with suggestions", () => {
    const [issue] = validateConditionFields({ all: [{ field: "symbol", op: "==", value: "X" }] }, fields);
    expect(issue).toMatchObject({ path: "all.0" });
    expect(issue?.message).toContain('unknown field "symbol"');
    expect(issue?.message).toContain('"token.symbol"');
  });

  it("rejects ordering on non-numeric fields and CONTAINS on numbers", () => {
    const issues = validateConditionFields(
      { any: [{ field: "from", op: ">", value: 1 }, { field: "amount", op: "CONTAINS", value: "1" }] },
      fields,
    );
    expect(issues.map((i) => i.path)).toEqual(["any.0", "any.1"]);
  });
});
