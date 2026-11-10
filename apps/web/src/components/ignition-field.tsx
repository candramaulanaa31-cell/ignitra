"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { IgnitionField, type FieldTheme } from "@/lib/field";
import { Odometer } from "./odometer";

/** Sent by the live demo when real runs arrive: one ignition per label. */
export interface RunsSignal {
  labels: string[];
  total: number;
}
export const RUNS_EVENT = "ignitra:runs";

const PAUSE_KEY = "ignitra:field-paused";

/** "#f1ece5" → "241, 236, 229" (canvas colors take per-particle alphas). */
function rgb(hex: string, fallback: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = Number.parseInt(m[1] as string, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function readTheme(el: HTMLElement): FieldTheme {
  const css = getComputedStyle(el);
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    dark,
    // Chain activity is cool steel on graphite, warm ink on bone: heat is reserved for real runs.
    ink: dark ? "176, 190, 214" : "74, 64, 56",
    guide: dark ? "255, 238, 220" : "28, 24, 20",
    text: rgb(css.getPropertyValue("--text"), dark ? "241, 236, 229" : "28, 24, 20"),
    muted: rgb(css.getPropertyValue("--muted"), dark ? "163, 154, 144" : "103, 93, 83"),
    mono: css.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
  };
}

/**
 * The landing hero: an ignition field behind the pitch. Activity rises from the chain at the real
 * block rate and circles IGNITRA; each real run ignites one particle that flies to its action. The
 * field sleeps while off screen or in a hidden tab, starts paused for reduced motion, and the
 * console's button pauses it for anyone (remembered on this device).
 */
export function IgnitionFieldHero({ actions, initialRuns, children }: { actions: string[]; initialRuns: number; children: ReactNode }) {
  const host = useRef<HTMLElement>(null);
  const back = useRef<HTMLCanvasElement>(null);
  const front = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const engine = useRef<IgnitionField | null>(null);
  const sync = useRef<() => void>(() => {});
  const userPaused = useRef(false);
  const [paused, setPaused] = useState(false);
  const [head, setHead] = useState<number | null>(null);
  const [runs, setRuns] = useState(initialRuns);
  const actionKey = actions.join("|");

  useEffect(() => {
    const el = host.current;
    if (!el || !back.current || !front.current || !over.current) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const field = new IgnitionField(back.current, front.current, over.current, readTheme(el), actionKey.split("|").filter(Boolean));
    engine.current = field;
    const fit = () => {
      const r = el.getBoundingClientRect();
      field.resize(r.width, r.height);
    };
    fit();
    let stored = false;
    try {
      stored = localStorage.getItem(PAUSE_KEY) === "1";
    } catch {
      // storage unavailable: just use the default
    }
    userPaused.current = stored || reduced.matches;
    setPaused(userPaused.current);

    let visible = true;
    sync.current = () => {
      if (visible && !userPaused.current && document.visibilityState === "visible") field.start();
      else {
        field.stop();
        field.drawStill();
      }
    };
    sync.current();

    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      sync.current();
    });
    io.observe(el);
    const onVisibility = () => sync.current();
    const onTheme = () => field.setTheme(readTheme(el));
    const onRuns = (e: Event) => {
      const detail = (e as CustomEvent<RunsSignal>).detail;
      setRuns(detail.total);
      detail.labels.slice(0, 4).forEach((label, i) => setTimeout(() => field.ignite(label), i * 420));
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      field.setPointer({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const onLeave = () => field.setPointer(null);
    // Scrolling the hero away raises the field's camera.
    const onScroll = () => {
      const r = el.getBoundingClientRect();
      field.setScroll(r.height > 0 ? -r.top / r.height : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    dark.addEventListener("change", onTheme);
    window.addEventListener(RUNS_EVENT, onRuns);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      field.stop();
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      dark.removeEventListener("change", onTheme);
      window.removeEventListener(RUNS_EVENT, onRuns);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      engine.current = null;
    };
  }, [actionKey]);

  // The chain's height: drives the horizon ticks (one per real block) and how fast activity rises.
  useEffect(() => {
    let last: { head: number; at: number } | null = null;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/health", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ listener?: { head?: number } }>) : null))
        .then((h) => {
          const next = h?.listener?.head;
          if (typeof next !== "number") return;
          setHead(next);
          const now = performance.now();
          if (last && next > last.head) {
            engine.current?.setBlockRate((next - last.head) / ((now - last.at) / 1000));
            engine.current?.addBlocks(next - last.head);
          }
          last = { head: next, at: now };
        })
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  const toggle = () => {
    userPaused.current = !userPaused.current;
    setPaused(userPaused.current);
    try {
      localStorage.setItem(PAUSE_KEY, userPaused.current ? "1" : "0");
    } catch {
      // the choice just isn't remembered
    }
    sync.current();
  };

  return (
    <section className="field-hero" ref={host} aria-label="IGNITRA">
      <canvas ref={back} className="field-layer" aria-hidden="true" />
      <canvas ref={front} className="field-layer" aria-hidden="true" />
      <canvas ref={over} className="field-layer" aria-hidden="true" />
      <div className="field-copy">{children}</div>
      <div className="field-console" role="group" aria-label="Live chain">
        <span className="console-live">
          <span className="live-dot" aria-hidden="true" />
          live
        </span>
        <span className="console-item">
          <span className="console-key">block</span> {head === null ? "…" : <Odometer value={head} />}
        </span>
        <span className="console-item">
          <Odometer value={runs} /> <span className="console-key">runs</span>
        </span>
        <button type="button" className="console-toggle" aria-pressed={paused} onClick={toggle} title={paused ? "Play the field" : "Pause the field"}>
          {paused ? (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor" />
            </svg>
          )}
          <span className="sr-only">{paused ? "Play" : "Pause"} the animation</span>
        </button>
      </div>
      <p className="field-legend">ember: real runs · gray: illustrative</p>
    </section>
  );
}
