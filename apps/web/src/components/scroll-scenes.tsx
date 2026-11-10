"use client";

import { useEffect } from "react";
import { approach, enterProgress, passProgress, stepProgress } from "@/lib/scenes";

type Key = "enter" | "p" | "step";
const KEYS: readonly Key[] = ["enter", "p", "step"];

interface Scene {
  el: HTMLElement;
  /** Where --enter reaches 1: the scene's top at this fraction of the viewport (data-scene="0.7"). */
  end: number;
  steps: HTMLElement[];
  near: boolean;
  shown: boolean;
  cur: Record<Key, number>;
  goal: Record<Key, number>;
}

/** Enter progress at which a scene's text animates in (on its own clock, once). */
const SHOW_AT = 0.16;

/**
 * Drives the landing's scroll scenes. Every [data-scene] element gets --enter (0 → 1 as it comes
 * in; complete once its top reaches the fraction of the viewport given as the attribute's value,
 * 0.45 by default), --p (0 → 1 across its pass through the viewport) and, with [data-step]
 * children, --step (how many have been reached). Values glide toward the scroll position instead of jumping with each
 * wheel notch. data-in is set once a scene is in (text then animates on its own clock), data-live
 * while it is near the viewport (loops run only then). [data-tilt] elements lean toward a mouse.
 *
 * Scene elements are never transformed themselves, so measuring them never feeds back. With reduced
 * motion nothing is driven: the CSS shows every scene assembled and still.
 */
export function ScrollScenes() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    const scenes: Scene[] = [...document.querySelectorAll<HTMLElement>("[data-scene]")].map((el) => ({
      el,
      end: Number(el.dataset.scene) || 0.45,
      steps: [...el.querySelectorAll<HTMLElement>("[data-step]")],
      near: false,
      shown: false,
      cur: { enter: 0, p: 0, step: 0 },
      goal: { enter: 0, p: 0, step: 0 },
    }));
    const byEl = new Map(scenes.map((s) => [s.el as Element, s]));

    const measure = (s: Scene, vh: number) => {
      const r = s.el.getBoundingClientRect();
      s.goal.enter = enterProgress(r, vh, s.end);
      s.goal.p = passProgress(r, vh);
      s.goal.step = s.steps.length ? stepProgress(s.steps.map((x) => x.getBoundingClientRect().top), vh) : 0;
      if (!s.shown && s.goal.enter > SHOW_AT) {
        s.shown = true;
        s.el.setAttribute("data-in", "");
      }
    };
    const write = (s: Scene, key: Key) => s.el.style.setProperty(`--${key}`, s.cur[key].toFixed(4));

    // Start where the page already is, before text is allowed to hide: what is on screen at load
    // never flashes, and only what scrolls in later animates.
    const vh0 = innerHeight;
    for (const s of scenes) {
      measure(s, vh0);
      s.cur = { ...s.goal };
      for (const k of KEYS) write(s, k);
    }
    root.setAttribute("data-scenes", "");

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const vh = innerHeight;
      let moving = false;
      for (const s of scenes) {
        if (s.near) measure(s, vh);
        for (const k of KEYS) {
          if (s.cur[k] === s.goal[k]) continue;
          s.cur[k] = approach(s.cur[k], s.goal[k], dt);
          write(s, k);
          moving = true;
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

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const s = byEl.get(e.target);
          if (!s) continue;
          s.near = e.isIntersecting;
          s.el.toggleAttribute("data-live", e.isIntersecting);
        }
        kick();
      },
      { rootMargin: "20% 0px 20% 0px" },
    );
    for (const s of scenes) io.observe(s.el);
    addEventListener("scroll", kick, { passive: true });
    addEventListener("resize", kick);

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
      removeEventListener("scroll", kick);
      removeEventListener("resize", kick);
      for (const el of tilts) {
        el.removeEventListener("pointermove", lean);
        el.removeEventListener("pointerleave", settle);
      }
      root.removeAttribute("data-scenes");
    };
  }, []);
  return null;
}
