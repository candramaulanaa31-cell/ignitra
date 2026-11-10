/**
 * Scroll scenes: how far a landing section has come into view, as plain numbers that CSS turns into
 * motion (custom properties --enter, --p and --step), and the spring that carries them. Pure, so the
 * driver in components/scroll-scenes.tsx stays a thin loop and the math is tested.
 */

export interface Box {
  top: number;
  height: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Ease in and out with no jerk at either end: a scene starts and settles gently against the scroll. */
export function smootherstep(x: number): number {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 0 while the box is below the viewport; 1 once its top edge reaches `end` (a fraction of the viewport height, from the top). */
export function enterProgress(box: Box, viewport: number, end = 0.45): number {
  if (viewport <= 0) return 1;
  return clamp01((viewport - box.top) / (viewport * (1 - end)));
}

/** 0 when the box's top enters at the bottom of the viewport, 1 when its bottom leaves at the top. */
export function passProgress(box: Box, viewport: number): number {
  const span = viewport + box.height;
  return span <= 0 ? 1 : clamp01((viewport - box.top) / span);
}

/**
 * Steps reached, fractional: each step counts from 0 to 1 (eased) while its top edge moves from
 * `from` to `to` (fractions of the viewport height, from the top).
 */
export function stepProgress(tops: readonly number[], viewport: number, from = 0.78, to = 0.52): number {
  if (viewport <= 0) return tops.length;
  let sum = 0;
  for (const top of tops) sum += smootherstep((viewport * from - top) / (viewport * (from - to)));
  return sum;
}

export interface Spring {
  /** Position. */
  x: number;
  /** Velocity, per second. */
  v: number;
}

/**
 * Advances a critically damped spring toward `target` by `dt` seconds. The step is the exact
 * solution, not an integration, so it is stable at any frame rate: motion starts softly (velocity
 * is continuous when the target moves again) and settles without overshoot from rest. `omega`
 * sets the pace (about 6 / omega seconds to settle). Returns whether it is still moving.
 */
export function springTo(s: Spring, target: number, dt: number, omega = 8.5): boolean {
  const step = Math.max(0, dt);
  const x0 = s.x - target;
  const k = s.v + omega * x0;
  const e = Math.exp(-omega * step);
  s.x = target + (x0 + k * step) * e;
  s.v = (s.v - omega * k * step) * e;
  if (Math.abs(s.x - target) < 2e-4 && Math.abs(s.v) < 2e-3) {
    s.x = target;
    s.v = 0;
    return false;
  }
  return true;
}
