import { describe, expect, it } from "vitest";
import {
  DuplicateRegistrationError,
  UnknownTypeError,
  createActionRegistry,
  createConditionOperatorRegistry,
  createTriggerRegistry,
} from "./registry";
import { formatInTimeZone, isValidTimeZone } from "./time";

describe("registries", () => {
  it("start empty in phase 1", () => {
    expect(createTriggerRegistry().size).toBe(0);
    expect(createConditionOperatorRegistry().size).toBe(0);
    expect(createActionRegistry().size).toBe(0);
  });

  it("register, look up, and reject duplicates / unknown types", () => {
    const ops = createConditionOperatorRegistry();
    ops.register({ type: "==", label: "equals", evaluate: (a, b) => a === b });
    expect(ops.has("==")).toBe(true);
    expect(ops.require("==").evaluate(1, 1)).toBe(true);
    expect(ops.list()).toHaveLength(1);
    expect(() => ops.register({ type: "==", label: "dup", evaluate: () => false })).toThrow(DuplicateRegistrationError);
    expect(() => ops.require(">")).toThrow(UnknownTypeError);
    expect(() => ops.require("DROP TABLE")).toThrow(UnknownTypeError);
  });

  it("isolates instances (no global state)", () => {
    const a = createConditionOperatorRegistry();
    a.register({ type: "==", label: "equals", evaluate: () => true });
    expect(createConditionOperatorRegistry().size).toBe(0);
  });
});

describe("time", () => {
  const instant = new Date("2026-11-05T01:00:00.000Z");

  it("displays WIB by default", () => {
    expect(formatInTimeZone(instant)).toBe("2026-11-05 08:00:00 WIB");
  });

  it("supports other zones", () => {
    expect(formatInTimeZone(instant, "Asia/Makassar")).toBe("2026-11-05 09:00:00 WITA");
    expect(formatInTimeZone(instant, "UTC")).toBe("2026-11-05 01:00:00 UTC");
  });

  it("handles midnight with a 24h clock", () => {
    expect(formatInTimeZone(new Date("2026-11-04T17:00:00.000Z"))).toBe("2026-11-05 00:00:00 WIB");
  });

  it("validates IANA zones", () => {
    expect(isValidTimeZone("Asia/Jakarta")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
