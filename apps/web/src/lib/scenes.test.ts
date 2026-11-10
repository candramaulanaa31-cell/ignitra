import { describe, expect, it } from "vitest";
import { approach, enterProgress, passProgress, stepProgress } from "./scenes";

describe("scroll scenes", () => {
  const vh = 1000;

  it("enters from the bottom edge to the reading line", () => {
    expect(enterProgress({ top: 1400, height: 300 }, vh)).toBe(0);
    expect(enterProgress({ top: vh, height: 300 }, vh)).toBe(0);
    expect(enterProgress({ top: 725, height: 300 }, vh)).toBeCloseTo(0.5);
    expect(enterProgress({ top: 450, height: 300 }, vh)).toBe(1);
    expect(enterProgress({ top: -900, height: 300 }, vh)).toBe(1);
    expect(enterProgress({ top: 500, height: 300 }, 0)).toBe(1);
  });

  it("measures a whole pass through the viewport", () => {
    expect(passProgress({ top: vh, height: 500 }, vh)).toBe(0);
    expect(passProgress({ top: 250, height: 500 }, vh)).toBeCloseTo(0.5);
    expect(passProgress({ top: -500, height: 500 }, vh)).toBe(1);
    expect(passProgress({ top: -2000, height: 500 }, vh)).toBe(1);
  });

  it("counts steps as they cross the reading band", () => {
    expect(stepProgress([900, 1100, 1300], vh)).toBe(0);
    expect(stepProgress([400, 500, 900], vh)).toBe(2);
    expect(stepProgress([650], vh)).toBeCloseTo(0.5);
    expect(stepProgress([-100, -50], vh)).toBe(2);
    expect(stepProgress([100, 200], 0)).toBe(2);
  });

  it("glides toward the target without overshooting, then lands on it", () => {
    let v = 0;
    let steps = 0;
    while (v !== 1 && steps < 1000) {
      const next = approach(v, 1, 1 / 60);
      expect(next).toBeGreaterThan(v);
      expect(next).toBeLessThanOrEqual(1);
      v = next;
      steps++;
    }
    expect(v).toBe(1);
    expect(steps).toBeGreaterThan(20); // a glide, not a jump
    expect(steps).toBeLessThan(120); // settles within two seconds
    expect(approach(0.3, 0.8, 0)).toBe(0.3);
    expect(approach(0.5, 0.2, 1 / 60)).toBeLessThan(0.5);
  });
});
