"use client";

import Lenis from "lenis";
import { useEffect } from "react";

/**
 * Smooth wheel scrolling for the landing page: a notch of the mouse wheel glides instead of
 * jumping, so the scenes it drives move as one. The page still scrolls natively, so scrollbars,
 * the keyboard, find-in-page and sticky elements behave as usual, and in-page links (#status)
 * glide too. Touch screens keep their own momentum; reduced motion gets plain scrolling.
 */
export function SmoothScroll() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    // Anchor targets keep their CSS scroll-margin-top (globals.css), so headings land below the sticky header.
    const lenis = new Lenis({ autoRaf: true, anchors: true, lerp: 0.12 });
    return () => lenis.destroy();
  }, []);
  return null;
}
