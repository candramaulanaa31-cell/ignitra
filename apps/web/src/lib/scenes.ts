/**
 * Scroll scenes: how far a landing section has come into view, as plain numbers that CSS turns into
 * motion (custom properties --enter, --p and --step). Pure, so the driver in
 * components/scroll-scenes.tsx stays a thin loop and the math is tested.
 */

export interface Box {
  top: number;
  height: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
 * Steps reached, fractional: each step counts from 0 to 1 while its top edge moves from `from` to
 * `to` (fractions of the viewport height, from the top).
 */
export function stepProgress(tops: readonly number[], viewport: number, from = 0.78, to = 0.52): number {
  if (viewport <= 0) return tops.length;
  let sum = 0;
  for (const top of tops) sum += clamp01((viewport * from - top) / (viewport * (from - to)));
  return sum;
}

/**
 * Moves `current` toward `target` at a rate independent of the frame rate, so a wheel notch reads as
 * a glide rather than a jump. Lands exactly on the target once within `epsilon`.
 */
export function approach(current: number, target: number, dt: number, rate = 9, epsilon = 0.0005): number {
  const next = current + (target - current) * (1 - Math.exp(-rate * Math.max(0, dt)));
  return Math.abs(target - next) < epsilon ? target : next;
}
