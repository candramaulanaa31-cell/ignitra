import { describe, expect, it } from "vitest";
import { idTimestamp, isId, newId, ulid } from "./ids";

describe("ids", () => {
  it("prefixes ids by kind", () => {
    expect(newId("flow")).toMatch(/^fl_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(newId("run")).toMatch(/^run_/);
    expect(newId("connection")).toMatch(/^conn_/);
    expect(newId("user")).toMatch(/^usr_/);
  });

  it("validates kind and shape", () => {
    const id = newId("flow");
    expect(isId("flow", id)).toBe(true);
    expect(isId("run", id)).toBe(false);
    expect(isId("flow", "fl_short")).toBe(false);
    expect(isId("flow", 42)).toBe(false);
  });

  it("round-trips the timestamp", () => {
    const now = Date.UTC(2026, 10, 5, 1, 2, 3, 456);
    expect(idTimestamp(newId("run", now))).toBe(now);
    expect(idTimestamp("run_not-a-ulid")).toBeNull();
  });

  it("sorts lexicographically by creation time", () => {
    const zeros = () => new Uint8Array(16);
    const earlier = ulid(1_000, zeros);
    const later = ulid(1_001, zeros);
    expect(earlier < later).toBe(true);
  });

  it("does not collide across many draws", () => {
    const seen = new Set(Array.from({ length: 10_000 }, () => newId("run", 1)));
    expect(seen.size).toBe(10_000);
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
  });
});
