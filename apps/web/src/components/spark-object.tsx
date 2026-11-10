"use client";

import { useEffect, useRef } from "react";
import { approach, passProgress } from "@/lib/scenes";
import { drawSpark } from "@/lib/spark";

const TAU = Math.PI * 2;

interface Ring {
  radius: number;
  tilt: number;
  flat: number;
  speed: number;
}

/**
 * The closing spark: the mark's diamond as a solid, circled by two orbits of embers (the hero's
 * field, close up). It turns as the page reaches its end, draws only while on screen, and holds one
 * still frame for reduced motion.
 */
export function SparkObject() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    let idle = 0.7;
    let p = 0.5;
    let goal = 0.5;
    let visible = false;

    const halfRing = (ring: Ring, front: boolean, cx: number, cy: number, dark: boolean) => {
      g.beginPath();
      g.ellipse(cx, cy, ring.radius, ring.radius * ring.flat, ring.tilt, front ? 0 : Math.PI, front ? Math.PI : TAU);
      g.setLineDash([2, 5]);
      g.strokeStyle = dark ? `rgba(255, 238, 220, ${front ? 0.3 : 0.14})` : `rgba(28, 24, 20, ${front ? 0.32 : 0.16})`;
      g.lineWidth = 1;
      g.stroke();
      g.setLineDash([]);
      for (let j = 0; j < 3; j++) {
        const a = idle * ring.speed * 2.2 + (j * TAU) / 3;
        if (Math.sin(a) > 0 !== front) continue;
        const lx = Math.cos(a) * ring.radius;
        const ly = Math.sin(a) * ring.radius * ring.flat;
        const x = cx + lx * Math.cos(ring.tilt) - ly * Math.sin(ring.tilt);
        const y = cy + lx * Math.sin(ring.tilt) + ly * Math.cos(ring.tilt);
        const depth = (Math.sin(a) + 1) / 2;
        g.beginPath();
        g.arc(x, y, 5 + depth * 3, 0, TAU);
        g.fillStyle = `rgba(255, 106, 19, ${0.12 + depth * 0.14})`;
        g.fill();
        g.beginPath();
        g.arc(x, y, 1.4 + depth * 1.3, 0, TAU);
        g.fillStyle = `rgba(255, ${190 + Math.round(depth * 40)}, 140, ${0.55 + depth * 0.45})`;
        g.fill();
      }
    };

    const draw = () => {
      g.clearRect(0, 0, w, h);
      if (w === 0 || h === 0) return;
      const dark = scheme.matches;
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w * 0.2, h * 0.27);
      const pitch = 0.6 - p * 0.4;
      const rings: Ring[] = [
        { radius: r * 1.8, tilt: -0.3, flat: Math.max(0.14, Math.sin(pitch) * 0.8), speed: 1 },
        { radius: r * 2.35, tilt: 0.24, flat: Math.max(0.1, Math.sin(pitch) * 0.55), speed: -0.65 },
      ];
      for (const ring of rings) halfRing(ring, false, cx, cy, dark);
      drawSpark(g, cx, cy, r, idle + p * Math.PI * 1.6, pitch, { dark, reach: Math.min(w, h) / 2 });
      for (const ring of rings) halfRing(ring, true, cx, cy, dark);
    };

    const fit = () => {
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = box.width;
      h = box.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    const frame = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const box = canvas.getBoundingClientRect();
      goal = passProgress(box, window.innerHeight);
      p = approach(p, goal, dt, 6);
      idle += dt * 0.32;
      draw();
      raf = visible ? requestAnimationFrame(frame) : 0;
    };
    const sync = () => {
      if (still || !visible || document.visibilityState !== "visible") {
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      } else if (!raf) raf = requestAnimationFrame(frame);
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      sync();
    });
    io.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    scheme.addEventListener("change", draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      scheme.removeEventListener("change", draw);
    };
  }, []);

  return <canvas ref={ref} className="spark-object" aria-hidden="true" />;
}
