"use client";

import { useEffect } from "react";
import { enterProgress, passProgress, smootherstep, springTo, stepProgress, type Spring } from "@/lib/scenes";

type Key = "enter" | "p" | "step";
const KEYS: readonly Key[] = ["enter", "p", "step"];

interface Scene {
  el: HTMLElement;
  /** Where --enter reaches 1: the scene's top at this fraction of the viewport (data-scene="0.7"). */
  end: number;
  steps: HTMLElement[];
  /** Layout in page coordinates, read when layout can have changed, never per frame. */
  top: number;
  height: number;
  stepTops: number[];
  shown: boolean;
  goal: Record<Key, number>;
  spring: Record<Key, Spring>;
  written: Record<Key, number>;
}

/** Enter progress at which a scene's text animates in (on its own clock, once). */
const SHOW_AT = 0.16;
/** Spring pace: about 0.7 s to settle, soft at both ends. */
const OMEGA = 8.5;

/**
 * Drives the landing's scroll scenes. Every [data-scene] element gets --enter (0 → 1 as it comes
 * in, eased at both ends; complete once its top reaches the fraction of the viewport given as the
 * attribute's value, 0.45 by default), --p (0 → 1 across its pass through the viewport) and, with
 * [data-step] children, --step (how many have been reached). Each value rides a critically damped
 * spring toward the scroll position: a wheel notch starts the motion softly and lets it settle,
 * with no jump and no overshoot. data-in is set once a scene is in (text then animates on its own
 * clock), data-live while it is near the viewport (loops run only then). [data-tilt] elements lean
 * toward a mouse.
 *
 * Scene elements are never transformed themselves, and their positions are cached in page
 * coordinates, so scrolling reads no layout at all. With reduced motion nothing is driven: the CSS
 * shows every scene assembled and still.
 */
export function ScrollScenes() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    const scenes: Scene[] = [...document.querySelectorAll<HTMLElement>("[data-scene]")].map((el) => ({
      el,
      end: Number(el.dataset.scene) || 0.45,
      steps: [...el.querySelectorAll<HTMLElement>("[data-step]")],
      top: 0,
      height: 0,
      stepTops: [],
      shown: false,
      goal: { enter: 0, p: 0, step: 0 },
      spring: { enter: { x: 0, v: 0 }, p: { x: 0, v: 0 }, step: { x: 0, v: 0 } },
      written: { enter: Number.NaN, p: Number.NaN, step: Number.NaN },
    }));
    const byEl = new Map(scenes.map((s) => [s.el as Element, s]));

    const layout = () => {
      const y = window.scrollY;
      for (const s of scenes) {
        const r = s.el.getBoundingClientRect();
        s.top = r.top + y;
        s.height = r.height;
        s.stepTops = s.steps.map((x) => x.getBoundingClientRect().top + y);
      }
    };
    const aim = (s: Scene, y: number, vh: number) => {
      const box = { top: s.top - y, height: s.height };
      const enter = enterProgress(box, vh, s.end);
      s.goal.enter = smootherstep(enter);
      s.goal.p = passProgress(box, vh);
      s.goal.step = s.stepTops.length ? stepProgress(s.stepTops.map((t) => t - y), vh) : 0;
      if (!s.shown && enter > SHOW_AT) {
        s.shown = true;
        s.el.setAttribute("data-in", "");
      }
    };
    const write = (s: Scene, key: Key) => {
      const v = s.spring[key].x;
      if (Math.abs(v - s.written[key]) < 1e-4) return;
      s.written[key] = v;
      s.el.style.setProperty(`--${key}`, v.toFixed(4));
    };

    // Start where the page already is, before text is allowed to hide: what is on screen at load
    // never flashes, and only what scrolls in later animates.
    layout();
    const y0 = window.scrollY;
    const vh0 = window.innerHeight;
    for (const s of scenes) {
      aim(s, y0, vh0);
      for (const k of KEYS) {
        s.spring[k] = { x: s.goal[k], v: 0 };
        write(s, k);
      }
    }
    root.setAttribute("data-scenes", "");

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const y = window.scrollY;
      const vh = window.innerHeight;
      let moving = false;
      for (const s of scenes) {
        aim(s, y, vh);
        for (const k of KEYS) {
          const spring = s.spring[k];
          if (spring.x === s.goal[k] && spring.v === 0) continue;
          if (springTo(spring, s.goal[k], dt, OMEGA)) moving = true;
          write(s, k);
        }
      }
      if (moving) raf = requestAnimationFrame(frame);
      else {
        raf = 0;
        last = 0;
      }
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const relayout = () => {
      layout();
      kick();
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) byEl.get(e.target)?.el.toggleAttribute("data-live", e.isIntersecting);
      },
      { rootMargin: "20% 0px 20% 0px" },
    );
    for (const s of scenes) io.observe(s.el);
    // Fonts, the live feed or a resize can move things: re-read layout only then.
    const ro = new ResizeObserver(relayout);
    ro.observe(document.body);
    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", relayout);
    window.addEventListener("load", relayout);

    // Cards lean toward the mouse (not on touch: there is no hover to lean toward).
    const tilts = matchMedia("(hover: hover) and (pointer: fine)").matches ? [...document.querySelectorAll<HTMLElement>("[data-tilt]")] : [];
    const lean = (e: PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      const r = (el.closest("[data-scene]") ?? el).getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty("--tx", `${(x * 9).toFixed(2)}deg`);
      el.style.setProperty("--ty", `${(-y * 7).toFixed(2)}deg`);
    };
    const settle = (e: PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      el.style.removeProperty("--tx");
      el.style.removeProperty("--ty");
    };
    for (const el of tilts) {
      el.addEventListener("pointermove", lean);
      el.addEventListener("pointerleave", settle);
    }

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("scroll", kick);
      window.removeEventListener("resize", relayout);
      window.removeEventListener("load", relayout);
      for (const el of tilts) {
        el.removeEventListener("pointermove", lean);
        el.removeEventListener("pointerleave", settle);
      }
      root.removeAttribute("data-scenes");
    };
  }, []);
  return null;
}
