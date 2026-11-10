import { describe, expect, it } from "vitest";
import { emberShade, sparkFaces } from "./spark";

describe("the spark solid", () => {
  it("shows exactly four faces from any generic angle (orthographic)", () => {
    for (let i = 0; i < 200; i++) {
      const yaw = 0.07 + i * 0.173;
      const pitch = -1.2 + ((i * 0.618) % 2.4);
      expect(sparkFaces(yaw, pitch).length).toBe(4);
    }
  });

  it("is the mark's diamond when seen straight on", () => {
    const faces = sparkFaces(0, 0);
    const xs = faces.flatMap((f) => f.points.map(([x]) => x));
    const ys = faces.flatMap((f) => f.points.map(([, y]) => y));
    expect(Math.min(...xs)).toBeCloseTo(-1);
    expect(Math.max(...xs)).toBeCloseTo(1);
    expect(Math.min(...ys)).toBeCloseTo(-1); // the top tip
    expect(Math.max(...ys)).toBeCloseTo(1);
  });

  it("lights the upper left facets more than the lower right ones", () => {
    const faces = sparkFaces(Math.PI / 4, 0.3);
    const centerOf = (f: (typeof faces)[number]) => f.points.reduce((s, [x, y]) => [s[0] + x / 3, s[1] + y / 3], [0, 0]);
    const upperLeft = faces.filter((f) => centerOf(f)[0] < 0 && (centerOf(f)[1] ?? 0) < 0);
    const lowerRight = faces.filter((f) => centerOf(f)[0] > 0 && (centerOf(f)[1] ?? 0) > 0);
    expect(upperLeft.length).toBeGreaterThan(0);
    expect(lowerRight.length).toBeGreaterThan(0);
    expect(Math.max(...upperLeft.map((f) => f.light))).toBeGreaterThan(Math.max(...lowerRight.map((f) => f.light)));
    for (const f of faces) {
      expect(f.light).toBeGreaterThanOrEqual(0);
      expect(f.light).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the perspective view a closed, culled solid", () => {
    for (let i = 0; i < 50; i++) {
      const n = sparkFaces(i * 0.31, 0.2 + (i % 5) * 0.1, 7).length;
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(4);
    }
  });

  it("shades from deep ember to pale heat", () => {
    expect(emberShade(0)).toBe("rgb(58, 15, 5)");
    expect(emberShade(1)).toBe("rgb(255, 216, 160)");
    expect(emberShade(-3)).toBe("rgb(58, 15, 5)");
    expect(emberShade(9)).toBe("rgb(255, 216, 160)");
  });
});
