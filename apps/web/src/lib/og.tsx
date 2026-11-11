import type { ReactNode } from "react";
import { SITE_URL } from "./site";
import { emberShade, sparkFaces } from "./spark";

/**
 * Share cards (Open Graph / X): the pieces the cards are drawn from, rendered by next/og at build
 * time or on first request. Same identity as the site: graphite, schematic paper, the heat line,
 * Archivo and JetBrains Mono, and the spark computed by the same solid as the hero's core.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

export const C = {
  bg: "#0c0b0a",
  text: "#f1ece5",
  muted: "#a39a90",
  faint: "#877d73",
  ember: "#ff6a13",
  emberStrong: "#ff8a3d",
  heat: "linear-gradient(90deg, #ff3b1f 0%, #ff6a13 52%, #ffb547 100%)",
} as const;

export const DISPLAY = "Archivo";
export const MONO = "JetBrains Mono";

type OgFont = { name: string; data: ArrayBuffer; weight: 500 | 700 | 800; style: "normal" };

/** A static TTF instance from Google Fonts (the CSS API serves TrueType to plain clients); null when offline. */
async function ttf(family: string): Promise<ArrayBuffer | null> {
  try {
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family}`, { headers: { "user-agent": "Mozilla/5.0 (compatible; IGNITRA share cards)" } })).text();
    const url = /src: url\((.+?)\) format\('(?:opentype|truetype)'\)/.exec(css)?.[1];
    if (!url) return null;
    const res = await fetch(url);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

let fonts: Promise<OgFont[]> | null = null;

/** Archivo (wide, heavy) for headlines, JetBrains Mono for chain data; fetched once. Offline: the default font. */
export function ogFonts(): Promise<OgFont[]> {
  fonts ??= Promise.all([ttf("Archivo:wdth,wght@118,800"), ttf("JetBrains+Mono:wght@500"), ttf("JetBrains+Mono:wght@700")]).then(([display, mono, monoBold]) => {
    const out: OgFont[] = [];
    if (display) out.push({ name: DISPLAY, data: display, weight: 800, style: "normal" });
    if (mono) out.push({ name: MONO, data: mono, weight: 500, style: "normal" });
    if (monoBold) out.push({ name: MONO, data: monoBold, weight: 700, style: "normal" });
    return out;
  });
  return fonts;
}

/** The site's host for the card's footer (nothing for localhost). */
export function siteHost(): string | null {
  try {
    const host = new URL(SITE_URL).host;
    return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? null : host;
  } catch {
    return null;
  }
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The mark: node → wire → spark. */
export function Mark({ width }: { width: number }) {
  return (
    <svg width={width} height={(width * 16) / 28} viewBox="0 0 28 16">
      <defs>
        <linearGradient id="mark-heat" gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="28" y2="8">
          <stop offset="0" stopColor="#ff3b1f" />
          <stop offset="0.55" stopColor="#ff6a13" />
          <stop offset="1" stopColor="#ffb547" />
        </linearGradient>
      </defs>
      <circle cx="4" cy="8" r="3.1" fill="none" stroke={C.text} strokeWidth="1.8" />
      <path d="M7.4 8H18.2" stroke="url(#mark-heat)" strokeWidth="2" strokeLinecap="round" />
      <path d="M22.8 2.6 27.6 8l-4.8 5.4L18 8z" fill="url(#mark-heat)" />
    </svg>
  );
}

interface Ring {
  rx: number;
  ry: number;
  tilt: number; // degrees
}

/** Half of a ring as an SVG arc: the front half passes below the centre, the back half above it. */
function halfRing(c: number, ring: Ring, front: boolean): string {
  const t = (ring.tilt * Math.PI) / 180;
  const at = (a: number) => [c + ring.rx * Math.cos(a) * Math.cos(t) - ring.ry * Math.sin(a) * Math.sin(t), c + ring.rx * Math.cos(a) * Math.sin(t) + ring.ry * Math.sin(a) * Math.cos(t)];
  const [x0, y0] = at(0);
  const [x1, y1] = at(Math.PI);
  return `M ${x0} ${y0} A ${ring.rx} ${ring.ry} ${ring.tilt} 0 ${front ? 1 : 0} ${x1} ${y1}`;
}

function ringPoint(c: number, ring: Ring, a: number): [number, number] {
  const t = (ring.tilt * Math.PI) / 180;
  return [c + ring.rx * Math.cos(a) * Math.cos(t) - ring.ry * Math.sin(a) * Math.sin(t), c + ring.rx * Math.cos(a) * Math.sin(t) + ring.ry * Math.sin(a) * Math.cos(t)];
}

/**
 * The spark of the mark as a solid, circled by two orbits with embers: the same octahedron, light
 * and ember ramp as the hero's core, as SVG.
 */
export function Spark({ size, yaw = 0.62, pitch = 0.34 }: { size: number; yaw?: number; pitch?: number }) {
  const c = size / 2;
  const r = size * 0.21;
  const rings: Ring[] = [
    { rx: r * 1.85, ry: r * 0.42, tilt: -14 },
    { rx: r * 2.3, ry: r * 0.3, tilt: 11 },
  ];
  const embers: Array<[Ring, number]> = [
    [rings[0] as Ring, 0.6],
    [rings[0] as Ring, 2.5],
    [rings[0] as Ring, 4.3],
    [rings[1] as Ring, 1.4],
    [rings[1] as Ring, 3.6],
    [rings[1] as Ring, 5.6],
  ];
  const ember = (front: boolean) =>
    embers
      .filter(([, a]) => Math.sin(a) > 0 === front)
      .map(([ring, a], i) => {
        const [x, y] = ringPoint(c, ring, a);
        return (
          <g key={`${front ? "f" : "b"}${i}`}>
            <circle cx={x} cy={y} r={size * 0.026} fill="rgba(255, 106, 19, 0.22)" />
            <circle cx={x} cy={y} r={size * 0.008} fill="#ffd9a8" />
          </g>
        );
      });
  const faces = sparkFaces(yaw, pitch, 7);
  // Light falls across each facet from the upper left (the hero draws it the same way).
  const lx = -0.57;
  const ly = -0.82;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <radialGradient id="spark-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#ff7626" stopOpacity="0.5" />
          <stop offset="0.42" stopColor="#ff6e1e" stopOpacity="0.14" />
          <stop offset="1" stopColor="#ff6a13" stopOpacity="0" />
        </radialGradient>
        {faces.map((f, i) => {
          const cx = c + ((f.points[0]?.[0] ?? 0) + (f.points[1]?.[0] ?? 0) + (f.points[2]?.[0] ?? 0)) * (r / 3);
          const cy = c + ((f.points[0]?.[1] ?? 0) + (f.points[1]?.[1] ?? 0) + (f.points[2]?.[1] ?? 0)) * (r / 3);
          const base = 0.1 + f.light * 0.8 + f.shine * 0.3;
          return (
            <linearGradient key={i} id={`facet-${i}`} gradientUnits="userSpaceOnUse" x1={cx + lx * r * 0.55} y1={cy + ly * r * 0.55} x2={cx - lx * r * 0.55} y2={cy - ly * r * 0.55}>
              <stop offset="0" stopColor={emberShade(base + 0.13)} />
              <stop offset="1" stopColor={emberShade(base - 0.11)} />
            </linearGradient>
          );
        })}
      </defs>
      <circle cx={c} cy={c} r={c} fill="url(#spark-glow)" />
      {rings.map((ring, i) => (
        <path key={`back${i}`} d={halfRing(c, ring, false)} fill="none" stroke="rgba(255, 238, 220, 0.16)" strokeWidth={1.4} strokeDasharray="3 7" />
      ))}
      {ember(false)}
      {faces.map((f, i) => (
        <polygon
          key={i}
          points={f.points.map(([x, y]) => `${(c + x * r).toFixed(2)},${(c + y * r).toFixed(2)}`).join(" ")}
          fill={`url(#facet-${i})`}
          stroke={`rgba(255, 232, 204, ${(0.1 + f.light * 0.45).toFixed(3)})`}
          strokeWidth={size * 0.004}
          strokeLinejoin="round"
        />
      ))}
      {rings.map((ring, i) => (
        <path key={`front${i}`} d={halfRing(c, ring, true)} fill="none" stroke="rgba(255, 238, 220, 0.34)" strokeWidth={1.6} strokeDasharray="3 7" />
      ))}
      {ember(true)}
    </svg>
  );
}

/** The card: graphite, schematic paper fading toward the edges, the heat line along the top. */
export function Card({ children }: { children: ReactNode }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: C.bg, color: C.text, fontFamily: MONO }}>
      <svg width={OG_SIZE.width} height={OG_SIZE.height} viewBox={`0 0 ${OG_SIZE.width} ${OG_SIZE.height}`} style={{ position: "absolute", left: 0, top: 0 }}>
        <defs>
          <pattern id="paper" width="44" height="44" patternUnits="userSpaceOnUse">
            <path d="M44 0H0V44" fill="none" stroke="rgba(255, 240, 225, 0.05)" strokeWidth="1" />
          </pattern>
          <radialGradient id="fade" cx="62%" cy="45%" r="75%">
            <stop offset="0.35" stopColor={C.bg} stopOpacity="0" />
            <stop offset="1" stopColor={C.bg} stopOpacity="1" />
          </radialGradient>
          <radialGradient id="haze" cx="78%" cy="52%" r="45%">
            <stop offset="0" stopColor="#ff6014" stopOpacity="0.16" />
            <stop offset="1" stopColor="#ff6014" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width={OG_SIZE.width} height={OG_SIZE.height} fill="url(#paper)" />
        <rect width={OG_SIZE.width} height={OG_SIZE.height} fill="url(#fade)" />
        <rect width={OG_SIZE.width} height={OG_SIZE.height} fill="url(#haze)" />
      </svg>
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: 6, backgroundImage: C.heat }} />
      {children}
    </div>
  );
}

/** Mark and wordmark, with an optional section after a slash. */
export function Masthead({ section }: { section?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <Mark width={58} />
      <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 30, letterSpacing: "0.08em" }}>IGNITRA</span>
      {section ? <span style={{ fontSize: 20, fontWeight: 500, color: C.faint, letterSpacing: "0.12em", marginLeft: 6 }}>{`/ ${section}`}</span> : null}
    </div>
  );
}
