/**
 * The spark: the diamond of IGNITRA's mark as a solid, an octahedron standing on one tip, drawn on a
 * 2D canvas with one warm light from the upper left. The hero's core and the closing statement both
 * use it, so the page opens and ends on the same object.
 */

type Vec = [number, number, number];

// Screen axes: x to the right, y down, z toward the viewer. Vertex 2 is the top tip.
const VERTS: readonly Vec[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
// Every face takes one vertex from each axis pair.
const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 4],
  [0, 2, 5],
  [0, 3, 4],
  [0, 3, 5],
  [1, 2, 4],
  [1, 2, 5],
  [1, 3, 4],
  [1, 3, 5],
];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec): Vec => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where the light comes from: up and to the left, a little in front. */
const LIGHT = normalize([-0.5, -0.72, 0.55]);
const HALF = normalize(add(LIGHT, [0, 0, 1]));

export interface SparkFace {
  /** The projected corners, in units of the spark's radius around its center. */
  points: Array<[number, number]>;
  /** Diffuse light on the face, 0 to 1. */
  light: number;
  /** The highlight where a face turns toward both the light and the viewer, 0 to 1. */
  shine: number;
}

/**
 * The faces seen from the front after the spark spins by `yaw` (around its vertical axis) and the
 * view tilts by `pitch` (positive: seen from above). `focal` 0 projects orthographically; otherwise
 * the eye sits `focal` radii in front of the center. Faces turned away are culled; a convex solid
 * needs no sorting after that.
 */
export function sparkFaces(yaw: number, pitch: number, focal = 0): SparkFace[] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const pts = VERTS.map(([x, y, z]): Vec => {
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
  });
  const project = (v: Vec): [number, number] => {
    const k = focal > 0 ? focal / (focal - v[2]) : 1;
    return [v[0] * k, v[1] * k];
  };
  const faces: SparkFace[] = [];
  for (const [i, j, k] of FACES) {
    const a = pts[i] as Vec;
    const b = pts[j] as Vec;
    const c = pts[k] as Vec;
    const center = scale(add(add(a, b), c), 1 / 3);
    let n = normalize(cross(sub(b, a), sub(c, a)));
    if (dot(n, center) < 0) n = scale(n, -1); // outward
    const toEye: Vec = focal > 0 ? sub([0, 0, focal], center) : [0, 0, 1];
    if (dot(n, toEye) <= 1e-6) continue;
    faces.push({ points: [project(a), project(b), project(c)], light: Math.max(0, dot(n, LIGHT)), shine: Math.pow(Math.max(0, dot(n, HALF)), 24) });
  }
  return faces;
}

// Ember, from the shadowed facet to the one catching the light.
const STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [58, 15, 5]],
  [0.45, [214, 74, 22]],
  [0.75, [255, 132, 46]],
  [1, [255, 216, 160]],
];

export function emberShade(t: number): string {
  const v = clamp(t, 0, 1);
  for (let s = 1; s < STOPS.length; s++) {
    const [t1, c1] = STOPS[s] as (typeof STOPS)[number];
    const [t0, c0] = STOPS[s - 1] as (typeof STOPS)[number];
    if (v <= t1) {
      const k = (v - t0) / (t1 - t0);
      return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * k)}, ${Math.round(c0[1] + (c1[1] - c0[1]) * k)}, ${Math.round(c0[2] + (c1[2] - c0[2]) * k)})`;
    }
  }
  return "rgb(255, 216, 160)";
}

export interface SparkLook {
  dark: boolean;
  /** Extra heat, 0 to 1: a real run just went through. */
  heat?: number;
  /** Draw the glow behind the solid (default true). */
  glow?: boolean;
  /** How far the glow may reach, in pixels: keep it inside a small canvas so it never shows an edge. */
  reach?: number;
}

/** The light's direction on screen, for the falloff across each facet. */
const LIGHT_2D: readonly [number, number] = (() => {
  const l = Math.hypot(LIGHT[0], LIGHT[1]) || 1;
  return [LIGHT[0] / l, LIGHT[1] / l];
})();

/**
 * Draws the spark centered on (x, y) with radius `r` (center to tip). Each facet carries its own
 * light with a falloff across it, the edges catch a bevel of light, and the facet that turns toward
 * both the light and the eye shows a glint.
 */
export function drawSpark(g: CanvasRenderingContext2D, x: number, y: number, r: number, yaw: number, pitch: number, look: SparkLook): void {
  const heat = clamp(look.heat ?? 0, 0, 1);
  if (look.glow !== false) {
    const reach = Math.min(r * (2.7 + heat * 1.6), look.reach ?? Infinity);
    const glow = g.createRadialGradient(x, y, r * 0.25, x, y, reach);
    glow.addColorStop(0, `rgba(255, 118, 38, ${(look.dark ? 0.34 : 0.22) + heat * 0.3})`);
    glow.addColorStop(0.45, `rgba(255, 110, 30, ${(look.dark ? 0.1 : 0.06) + heat * 0.1})`);
    glow.addColorStop(1, "rgba(255, 106, 19, 0)");
    g.fillStyle = glow;
    g.beginPath();
    g.arc(x, y, reach, 0, Math.PI * 2);
    g.fill();
  }
  const [lx, ly] = LIGHT_2D;
  const faces = sparkFaces(yaw, pitch, 7).map((face) => {
    const pts = face.points.map(([px, py]): [number, number] => [x + px * r, y + py * r]);
    const cx = (pts[0]![0] + pts[1]![0] + pts[2]![0]) / 3;
    const cy = (pts[0]![1] + pts[1]![1] + pts[2]![1]) / 3;
    return { face, pts, cx, cy };
  });
  const trace = (pts: Array<[number, number]>) => {
    g.beginPath();
    pts.forEach(([px, py], i) => (i === 0 ? g.moveTo(px, py) : g.lineTo(px, py)));
    g.closePath();
  };
  g.save();
  g.lineJoin = "round";
  for (const { face, pts, cx, cy } of faces) {
    const base = 0.1 + face.light * 0.8 + face.shine * 0.3 + heat * 0.18;
    const span = r * 0.55;
    const paint = g.createLinearGradient(cx + lx * span, cy + ly * span, cx - lx * span, cy - ly * span);
    paint.addColorStop(0, emberShade(base + 0.13));
    paint.addColorStop(1, emberShade(base - 0.11));
    trace(pts);
    g.fillStyle = paint;
    g.fill();
    // The same paint along the edges closes the hairline seams anti-aliasing leaves between facets.
    g.strokeStyle = paint;
    g.lineWidth = Math.max(0.8, r / 40);
    g.stroke();
  }
  // Bevels: every edge catches a little light, the edges of lit facets more.
  g.lineWidth = Math.max(0.7, r / 34);
  for (const { face, pts } of faces) {
    trace(pts);
    g.strokeStyle = `rgba(255, 232, 204, ${(0.1 + face.light * 0.45).toFixed(3)})`;
    g.stroke();
  }
  // A glint on the facet turned toward both the light and the eye, kept inside that facet.
  const lit = faces.reduce<(typeof faces)[number] | null>((best, f) => (f.face.shine > (best?.face.shine ?? 0.15) ? f : best), null);
  if (lit) {
    g.save();
    trace(lit.pts);
    g.clip();
    const gx = lit.cx + lx * r * 0.22;
    const gy = lit.cy + ly * r * 0.22;
    const spot = g.createRadialGradient(gx, gy, 0, gx, gy, r * 0.5);
    spot.addColorStop(0, `rgba(255, 246, 228, ${(0.1 + lit.face.shine * 0.55).toFixed(3)})`);
    spot.addColorStop(1, "rgba(255, 246, 228, 0)");
    g.fillStyle = spot;
    g.fillRect(gx - r, gy - r, r * 2, r * 2);
    g.restore();
  }
  g.restore();
}
