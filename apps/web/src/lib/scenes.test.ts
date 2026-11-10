import { describe, expect, it } from "vitest";
import { enterProgress, passProgress, smootherstep, springTo, stepProgress, type Spring } from "./scenes";

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

  it("counts steps as they cross the reading band, eased", () => {
    expect(stepProgress([900, 1100, 1300], vh)).toBe(0);
    expect(stepProgress([400, 500, 900], vh)).toBe(2);
    expect(stepProgress([650], vh)).toBeCloseTo(0.5);
    expect(stepProgress([741], vh)).toBeLessThan(0.1); // a step starts slowly...
    expect(stepProgress([559], vh)).toBeGreaterThan(0.9); // ...and settles slowly
    expect(stepProgress([-100, -50], vh)).toBe(2);
    expect(stepProgress([100, 200], 0)).toBe(2);
  });

  it("eases with flat ends and a symmetric middle", () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(-2)).toBe(0);
    expect(smootherstep(3)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5);
    expect(smootherstep(0.02)).toBeLessThan(0.001);
    for (let i = 0; i < 100; i++) expect(smootherstep((i + 1) / 100)).toBeGreaterThanOrEqual(smootherstep(i / 100));
  });

  it("springs toward the target softly, without overshoot from rest, and lands on it", () => {
    const s: Spring = { x: 0, v: 0 };
    let steps = 0;
    let moving = true;
    let last = 0;
    while (moving && steps < 1000) {
      moving = springTo(s, 1, 1 / 60);
      expect(s.x).toBeGreaterThanOrEqual(last);
      expect(s.x).toBeLessThanOrEqual(1);
      last = s.x;
      steps++;
    }
    expect(s.x).toBe(1);
    expect(s.v).toBe(0);
    expect(steps).toBeGreaterThan(30); // a glide, not a jump
    expect(steps).toBeLessThan(150); // done within two and a half seconds

    // The first frame barely moves: the start is soft (an exponential chase would jump ~14%).
    const fresh: Spring = { x: 0, v: 0 };
    springTo(fresh, 1, 1 / 60);
    expect(fresh.x).toBeLessThan(0.02);
    expect(fresh.v).toBeGreaterThan(0);
  });

  it("is the same motion at 30, 60 or 144 frames per second", () => {
    const at = (fps: number) => {
      const s: Spring = { x: 0, v: 0 };
      for (let i = 0; i < fps / 2; i++) springTo(s, 1, 1 / fps); // half a second
      return s.x;
    };
    expect(at(30)).toBeCloseTo(at(60), 6);
    expect(at(144)).toBeCloseTo(at(60), 6);
  });

  it("keeps its velocity when the target moves mid-glide", () => {
    const s: Spring = { x: 0, v: 0 };
    for (let i = 0; i < 10; i++) springTo(s, 1, 1 / 60);
    const before = s.v;
    springTo(s, 2, 1 / 60); // the reader scrolls on
    expect(s.v).toBeGreaterThan(before * 0.9);
    expect(springTo({ x: 0.3, v: 0 }, 0.3, 1 / 60)).toBe(false);
  });
});
