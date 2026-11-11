/**
 * The ignition field: the landing hero, on two canvases. The back one is static (haze and horizon,
 * drawn on resize and theme changes only, so scrolling never repaints it). The front one is cleared
 * and redrawn every frame in depth order: orbit guides (they follow the camera), block ticks, the
 * swarm behind the core, the core, the swarm in front of it, then the ports and their labels.
 * Trails are drawn from each particle's recent path, not by fading old frames, so they stay
 * continuous at any speed and refresh rate and leave nothing behind.
 *
 * It shows IGNITRA's job. Chain activity rises from the horizon (the chain) at the rate the listener
 * sees blocks, and circles the core (the matcher): the spark of the mark as a solid, turning, with
 * the swarm passing behind and in front of it. When a real run happens on mainnet, one particle
 * ignites and shoots to its action's port, which shows that run. Block ticks and ignitions are real;
 * the ambient particles are an illustration of chain activity, and the page says so.
 *
 * Scrolling away raises the camera: the orbits open up from a low angle to a view from above.
 *
 * Sharpness: the canvases map 1:1 onto the screen's physical pixels (the browser reports their exact
 * device-pixel size), so nothing is resampled on a 1.5x or 2x screen. Low-density screens get an
 * exact 2:1 supersample instead. If the device cannot hold a steady frame rate, the resolution
 * steps down.
 */
import { springTo, type Spring } from "./scenes";
import { drawSpark } from "./spark";

export interface FieldTheme {
  dark: boolean;
  /** "r, g, b" triplets, so alphas can be applied per particle. */
  ink: string;
  guide: string;
  text: string;
  muted: string;
  mono: string;
}

type Kind = "rise" | "orbit" | "ignite" | "fade";

/** How much of its path a particle trails, in seconds. */
const TRAIL_SECONDS: Record<Kind, number> = { orbit: 0.2, fade: 0.2, rise: 0.28, ignite: 0.36 };
/** Positions kept per particle: the longest trail at up to 170 frames per second. */
const TRAIL_CAP = 64;

/** A particle's recent positions, in a ring: what its trail is drawn from. */
class Trail {
  readonly x = new Float32Array(TRAIL_CAP);
  readonly y = new Float32Array(TRAIL_CAP);
  readonly t = new Float64Array(TRAIL_CAP);
  head = 0;
  count = 0;

  push(x: number, y: number, t: number): void {
    this.x[this.head] = x;
    this.y[this.head] = y;
    this.t[this.head] = t;
    this.head = (this.head + 1) % TRAIL_CAP;
    this.count = Math.min(TRAIL_CAP, this.count + 1);
  }
}

interface Particle {
  kind: Kind;
  a: number; // orbit angle
  r: number; // orbit radius (before flattening)
  w: number; // angular speed, rad/s
  x: number;
  y: number;
  sx: number;
  sy: number;
  cx: number; // bezier control point (rise / ignite)
  cy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  life: number;
  size: number;
  port?: number;
  label?: string;
  trail: Trail;
}

interface Port {
  name: string;
  x: number;
  y: number;
  flash: number; // 1 → 0
  label: string | null;
  labelT: number; // seconds left on the label
}

interface Tick {
  x: number;
}

type Quality = "high" | "native" | "low";

const TAU = Math.PI * 2;
const FLAT = 0.36; // orbits are ellipses: a disc seen at a low angle...
const FLAT_TOP = 0.74; // ...and from above, once the hero has scrolled away
const TILT = -0.16; // radians
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const quad = (a: number, c: number, b: number, t: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;

/** Particles per second rising from the chain for a block rate (blocks/s), within sane bounds. */
export function riseRate(blocksPerSecond: number): number {
  return clamp(blocksPerSecond * 0.45, 0.6, 5);
}

/** A soft round glow, drawn once and stamped per particle (far cheaper than a gradient each time). */
function glowSprite(rgb: string): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const glow = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    glow.addColorStop(0, `rgba(${rgb}, 0.9)`);
    glow.addColorStop(0.22, `rgba(${rgb}, 0.32)`);
    glow.addColorStop(0.55, `rgba(${rgb}, 0.08)`);
    glow.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = glow;
    g.fillRect(0, 0, size, size);
  }
  return c;
}

export class IgnitionField {
  readonly #back: CanvasRenderingContext2D;
  readonly #front: CanvasRenderingContext2D;
  readonly #canvases: HTMLCanvasElement[];
  #theme: FieldTheme;
  #glow: HTMLCanvasElement | null = null; // the swarm's glow (graphite theme only)
  #ember: HTMLCanvasElement | null = null; // an ignition's glow
  #w = 0;
  #h = 0;
  /** Canvas pixels per device pixel in use (see #scale). */
  #k = 1;
  /** The canvases' exact size in device pixels, when the browser reports it. */
  #device: { width: number; height: number } | null = null;
  #quality: Quality = "high";
  #slow = 0;
  #core = { x: 0, y: 0, r0: 0, r1: 0, s: 0, pulse: 0 };
  #clock = 0;
  #spin = 0;
  #camera: Spring = { x: 0, v: 0 };
  #scrollGoal = 0;
  #flat = FLAT;
  #horizonY = 0;
  #riseFrom = { x0: 0, x1: 0 };
  #particles: Particle[] = [];
  #ports: Port[] = [];
  #ticks: Tick[] = [];
  #pendingBlocks = 0;
  #blockRate = 9;
  #riseCarry = 0;
  #tickCarry = 0;
  #pointer: { x: number; y: number } | null = null;
  #raf = 0;
  #last = 0;
  #running = false;
  #max = 120;

  constructor(back: HTMLCanvasElement, front: HTMLCanvasElement, theme: FieldTheme, actions: readonly string[]) {
    this.#canvases = [back, front];
    this.#back = back.getContext("2d") as CanvasRenderingContext2D;
    this.#front = front.getContext("2d") as CanvasRenderingContext2D;
    this.#theme = theme;
    this.#makeSprites();
    this.#ports = (actions.length ? actions : ["Your stack"]).slice(0, 3).map((name) => ({ name, x: 0, y: 0, flash: 0, label: null, labelT: 0 }));
  }

  get running(): boolean {
    return this.#running;
  }

  setTheme(theme: FieldTheme): void {
    this.#theme = theme;
    this.#makeSprites();
    this.#drawBack();
    if (!this.#running) this.#drawStill();
  }

  /**
   * Lays the field out for the canvas size in CSS pixels, and `device`, its exact size in device
   * pixels when known. Seeds an orbit so the first frame is already alive.
   */
  resize(width: number, height: number, device?: { width: number; height: number }): void {
    if (width <= 0 || height <= 0) return;
    if (device) this.#device = device;
    const dpr = window.devicePixelRatio || 1;
    this.#k = this.#scale();
    // Trust the reported device size only when it agrees with the pixel ratio (emulators can disagree).
    const agrees = (d: number, css: number) => Math.abs(d - css * dpr) <= 2;
    const dev = this.#device && agrees(this.#device.width, width) && agrees(this.#device.height, height) ? this.#device : null;
    const backingW = Math.max(1, Math.round((dev?.width ?? width * dpr) * this.#k));
    const backingH = Math.max(1, Math.round((dev?.height ?? height * dpr) * this.#k));
    this.#w = width;
    this.#h = height;
    for (const c of this.#canvases) {
      c.width = backingW;
      c.height = backingH;
    }
    // Draw in CSS pixels; the transform maps them onto the backing pixels exactly.
    for (const g of [this.#back, this.#front]) {
      g.setTransform(backingW / width, 0, 0, backingH / height, 0, 0);
      g.imageSmoothingQuality = "high";
    }
    const wide = width >= 960; // the same breakpoint as the CSS that stacks the hero
    const base = Math.min(width, height);
    // Wide screens: the swarm sits right of the pitch. Narrow: in its own zone (the CSS reserves
    // the bottom 340 px under the pitch), measured from the bottom so long copy never meets it.
    this.#core = {
      x: wide ? width * 0.75 : width * 0.5,
      y: wide ? height * 0.5 : height - 175,
      r0: base * 0.08,
      r1: wide ? base * 0.38 : Math.min(width * 0.42, 165),
      s: clamp(base * 0.034, 14, 30), // the spark's radius: the inner orbits pass behind and in front of it
      pulse: 0,
    };
    this.#horizonY = wide ? height * 0.84 : height - 62;
    this.#riseFrom = wide ? { x0: width * 0.42, x1: width * 0.99 } : { x0: width * 0.04, x1: width * 0.96 };
    this.#max = wide ? 130 : 70;
    this.#ports.forEach((p, i) => {
      const n = this.#ports.length;
      if (wide) {
        p.x = Math.min(width - 28, this.#core.x + this.#core.r1 * 0.92);
        p.y = this.#core.y - this.#core.r1 * 0.5 + (n === 1 ? this.#core.r1 * 0.12 : (i * this.#core.r1 * 0.9) / Math.max(1, n - 1));
      } else {
        p.x = width - 22;
        p.y = this.#core.y - 112 + i * 30; // above the swarm, inside its zone
      }
    });
    if (this.#particles.length === 0) {
      const seed = Math.round(this.#max * 0.55);
      for (let i = 0; i < seed; i++) this.#particles.push(this.#orbiter(Math.random() * TAU, Math.random() * 12));
    } else {
      // Keep the swarm, re-fit its radii to the new size.
      for (const p of this.#particles) p.r = clamp(p.r, this.#core.r0, this.#core.r1);
    }
    this.#drawBack();
    if (!this.#running) this.#drawStill();
  }

  /** The listener's block rate (blocks per second): sets how fast activity rises from the chain. */
  setBlockRate(blocksPerSecond: number): void {
    if (Number.isFinite(blocksPerSecond) && blocksPerSecond > 0) this.#blockRate = blocksPerSecond;
  }

  /** New real blocks: each becomes one tick travelling along the horizon (bounded, so a gap is not a flood). */
  addBlocks(count: number): void {
    this.#pendingBlocks = Math.min(60, this.#pendingBlocks + Math.max(0, Math.floor(count)));
  }

  setPointer(point: { x: number; y: number } | null): void {
    this.#pointer = point;
  }

  /** How far the hero has scrolled away, 0 to 1: raises the camera over the orbits. */
  setScroll(progress: number): void {
    this.#scrollGoal = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  }

  /** A real run: the nearest orbiting particle ignites and flies to the action's port, which then shows `label`. */
  ignite(label: string, port = 0): void {
    const target = this.#ports[Math.min(port, this.#ports.length - 1)];
    if (!target) return;
    let pick = -1;
    let best = -Infinity;
    this.#particles.forEach((p, i) => {
      if (p.kind !== "orbit") return;
      const front = Math.sin(p.a); // in front of the core reads best
      const score = front - Math.abs(p.r - this.#core.r1 * 0.55) / this.#core.r1;
      if (score > best) {
        best = score;
        pick = i;
      }
    });
    const p = pick >= 0 ? (this.#particles[pick] as Particle) : this.#orbiter(Math.random() * TAU, 10);
    if (pick < 0) this.#particles.push(p);
    p.kind = "ignite";
    p.t = 0;
    p.dur = 1.25;
    p.sx = p.x || this.#core.x;
    p.sy = p.y || this.#core.y;
    p.tx = target.x;
    p.ty = target.y;
    p.cx = this.#core.x + (p.sx - this.#core.x) * 1.5;
    p.cy = Math.min(p.sy, target.y) - this.#core.r1 * 0.35;
    p.port = this.#ports.indexOf(target);
    p.label = label;
    p.size = 2.6;
    this.#core.pulse = 1;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#last = performance.now();
    const frame = (now: number) => {
      if (!this.#running) return;
      const elapsed = (now - this.#last) / 1000;
      this.#last = now;
      this.#govern(elapsed);
      const dt = Math.min(0.05, elapsed);
      this.#step(dt);
      this.#draw();
      this.#raf = requestAnimationFrame(frame);
    };
    this.#raf = requestAnimationFrame(frame);
  }

  stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#raf);
  }

  /** Reduced motion or paused: one composed still frame (the swarm without trails). */
  drawStill(): void {
    this.#drawStill();
  }

  // ---- quality ---------------------------------------------------------------------------------

  /**
   * Canvas pixels per device pixel. One on 1.5x screens and up: a 1:1 map, nothing resampled. Two on
   * low-density screens: an exact 2:1 supersample, which the browser averages cleanly (a 2x canvas
   * on a 1.5x screen would be resampled at 1.33:1 and blur). Stepped down, one per CSS pixel.
   */
  #scale(): number {
    const dpr = window.devicePixelRatio || 1;
    if (this.#quality === "high") return dpr < 1.5 ? 2 : 1;
    if (this.#quality === "native") return 1;
    return 1 / dpr;
  }

  /**
   * Steps the resolution down if frames keep running long: a slow device or a busy page keeps a
   * steady frame rate rather than a sharper image. The first moments after start (hydration,
   * fonts) do not count.
   */
  #govern(elapsed: number): void {
    if (this.#quality === "low" || this.#clock < 2) return;
    this.#slow = elapsed > 1 / 40 ? this.#slow + 1 : Math.max(0, this.#slow - 2);
    if (this.#slow < 45) return;
    this.#slow = 0;
    this.#quality = this.#quality === "high" ? "native" : "low";
    if (this.#scale() !== this.#k) this.resize(this.#w, this.#h);
  }

  #makeSprites(): void {
    this.#glow = this.#theme.dark ? glowSprite(this.#theme.ink) : null;
    this.#ember = glowSprite("255, 140, 50");
  }

  // ---- simulation ------------------------------------------------------------------------------

  #orbiter(a: number, age = 0): Particle {
    const { r0, r1 } = this.#core;
    const u = Math.pow(Math.random(), 0.8);
    const r = r0 + (r1 - r0) * u;
    return {
      kind: "orbit",
      a,
      r,
      w: (0.75 - 0.45 * u) * (Math.random() < 0.82 ? 1 : -1) * (0.7 + Math.random() * 0.6),
      x: 0,
      y: 0,
      sx: 0,
      sy: 0,
      cx: 0,
      cy: 0,
      tx: 0,
      ty: 0,
      t: 0,
      dur: 0,
      life: Math.max(2, 9 + Math.random() * 10 - age),
      size: 0.8 + Math.random() * 1.2,
      trail: new Trail(),
    };
  }

  #orbitPoint(a: number, r: number): { x: number; y: number } {
    const ex = Math.cos(a) * r;
    const ey = Math.sin(a) * r * this.#flat;
    return { x: this.#core.x + ex * Math.cos(TILT) - ey * Math.sin(TILT), y: this.#core.y + ex * Math.sin(TILT) + ey * Math.cos(TILT) };
  }

  #rise(): Particle {
    const p = this.#orbiter(Math.random() * TAU);
    p.kind = "rise";
    p.t = 0;
    p.dur = 1.6 + Math.random() * 1.1;
    p.sx = this.#riseFrom.x0 + Math.random() * (this.#riseFrom.x1 - this.#riseFrom.x0);
    p.sy = this.#horizonY;
    const end = this.#orbitPoint(p.a, p.r);
    p.tx = end.x;
    p.ty = end.y;
    p.cx = (p.sx + end.x) / 2 + (Math.random() - 0.5) * 120;
    p.cy = Math.min(p.sy, end.y) - 40 - Math.random() * 80;
    p.x = p.sx;
    p.y = p.sy;
    return p;
  }

  #step(dt: number): void {
    this.#clock += dt;
    // The camera follows the scroll on a spring: it eases off and settles, whatever the wheel does.
    springTo(this.#camera, this.#scrollGoal, dt, 5.5);
    this.#flat = FLAT + (FLAT_TOP - FLAT) * ease(clamp(this.#camera.x, 0, 1));
    this.#spin += dt * (0.45 + this.#core.pulse * 2.6);
    // Activity rises from the chain at a rate tied to the real block rate.
    this.#riseCarry += riseRate(this.#blockRate) * dt;
    while (this.#riseCarry >= 1) {
      this.#riseCarry -= 1;
      if (this.#particles.length < this.#max) this.#particles.push(this.#rise());
    }
    // One horizon tick per real block, released evenly.
    this.#tickCarry += Math.max(this.#blockRate, 1) * dt;
    while (this.#tickCarry >= 1 && this.#pendingBlocks > 0) {
      this.#tickCarry -= 1;
      this.#pendingBlocks -= 1;
      this.#ticks.push({ x: -10 });
    }
    if (this.#pendingBlocks === 0) this.#tickCarry = Math.min(this.#tickCarry, 1);
    // Fast enough that ticks stay about 18 px apart even on a phone: one block, one mark.
    const tickSpeed = Math.max(90, this.#w / 7, this.#blockRate * 18);
    for (const t of this.#ticks) t.x += tickSpeed * dt;
    this.#ticks = this.#ticks.filter((t) => t.x < this.#w + 40);

    this.#core.pulse = Math.max(0, this.#core.pulse - dt * 1.6);
    for (const port of this.#ports) {
      port.flash = Math.max(0, port.flash - dt * 1.2);
      port.labelT = Math.max(0, port.labelT - dt);
      if (port.labelT === 0) port.label = null;
    }

    const keep: Particle[] = [];
    for (const p of this.#particles) {
      if (p.kind === "rise") {
        p.t += dt;
        // Aim at where the orbit is now: the camera may have moved since the particle set off.
        const end = this.#orbitPoint(p.a, p.r);
        p.tx = end.x;
        p.ty = end.y;
        const k = ease(Math.min(1, p.t / p.dur));
        p.x = quad(p.sx, p.cx, p.tx, k);
        p.y = quad(p.sy, p.cy, p.ty, k);
        if (p.t >= p.dur) p.kind = "orbit";
      } else if (p.kind === "orbit") {
        p.a += p.w * dt;
        p.life -= dt;
        const pt = this.#orbitPoint(p.a, p.r);
        p.x = pt.x;
        p.y = pt.y;
        if (p.life <= 0) {
          p.kind = "fade";
          p.t = 0;
          p.dur = 0.9;
        }
      } else if (p.kind === "ignite") {
        p.t += dt;
        const k = ease(Math.min(1, p.t / p.dur));
        p.x = quad(p.sx, p.cx, p.tx, k);
        p.y = quad(p.sy, p.cy, p.ty, k);
        if (p.t >= p.dur) {
          const port = this.#ports[p.port ?? 0];
          if (port) {
            port.flash = 1;
            port.label = p.label ?? null;
            port.labelT = 3.2;
          }
          continue; // delivered
        }
      } else {
        p.t += dt;
        p.a += p.w * dt;
        const pt = this.#orbitPoint(p.a, p.r);
        p.x = pt.x;
        p.y = pt.y;
        if (p.t >= p.dur) continue;
      }
      // The pointer parts the swarm a little.
      if (this.#pointer && p.kind !== "ignite") {
        const dx = p.x - this.#pointer.x;
        const dy = p.y - this.#pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 110 * 110 && d2 > 1) {
          const f = (1 - Math.sqrt(d2) / 110) * 26;
          const d = Math.sqrt(d2);
          p.x += (dx / d) * f;
          p.y += (dy / d) * f;
        }
      }
      p.trail.push(p.x, p.y, this.#clock);
      keep.push(p);
    }
    this.#particles = keep;
  }

  // ---- drawing ---------------------------------------------------------------------------------

  #drawBack(): void {
    const g = this.#back;
    const { dark } = this.#theme;
    g.clearRect(0, 0, this.#w, this.#h);
    // Heat haze around the core.
    const haze = g.createRadialGradient(this.#core.x, this.#core.y, 0, this.#core.x, this.#core.y, this.#core.r1 * 1.25);
    haze.addColorStop(0, dark ? "rgba(255, 96, 20, 0.16)" : "rgba(255, 106, 19, 0.10)");
    haze.addColorStop(0.5, dark ? "rgba(255, 96, 20, 0.05)" : "rgba(255, 106, 19, 0.03)");
    haze.addColorStop(1, "rgba(255, 96, 20, 0)");
    g.fillStyle = haze;
    g.fillRect(0, 0, this.#w, this.#h);
    // The horizon: a band of glow above the chain line.
    const band = g.createLinearGradient(0, this.#horizonY - 140, 0, this.#horizonY + 2);
    band.addColorStop(0, "rgba(255, 106, 19, 0)");
    band.addColorStop(1, dark ? "rgba(255, 106, 19, 0.13)" : "rgba(255, 106, 19, 0.09)");
    g.fillStyle = band;
    g.fillRect(0, this.#horizonY - 140, this.#w, 142);
    const line = g.createLinearGradient(0, 0, this.#w, 0);
    line.addColorStop(0, "rgba(255, 59, 31, 0)");
    line.addColorStop(0.18, "rgba(255, 59, 31, 0.75)");
    line.addColorStop(0.6, "rgba(255, 106, 19, 0.95)");
    line.addColorStop(0.92, "rgba(255, 181, 71, 0.7)");
    line.addColorStop(1, "rgba(255, 181, 71, 0)");
    g.fillStyle = line;
    g.fillRect(0, this.#horizonY, this.#w, 1.5);
  }

  /** The orbit guides: on the front layer, because they follow the camera. */
  #drawGuides(g: CanvasRenderingContext2D): void {
    const { dark, guide } = this.#theme;
    g.save();
    g.translate(this.#core.x, this.#core.y);
    g.rotate(TILT);
    g.setLineDash([2, 6]);
    g.strokeStyle = `rgba(${guide}, ${dark ? 0.16 : 0.22})`;
    g.lineWidth = 1;
    for (const k of [0.45, 0.72, 1]) {
      g.beginPath();
      g.ellipse(0, 0, this.#core.r1 * k, this.#core.r1 * k * this.#flat, 0, 0, TAU);
      g.stroke();
    }
    g.restore();
  }

  #draw(): void {
    this.#drawFront(true);
  }

  #drawStill(): void {
    for (const p of this.#particles) {
      if (p.kind === "orbit" || p.kind === "fade") {
        const pt = this.#orbitPoint(p.a, p.r);
        p.x = pt.x;
        p.y = pt.y;
      }
    }
    this.#drawFront(false);
  }

  /** The front layer, back to front, so the core hides what passes behind it. */
  #drawFront(trails: boolean): void {
    const g = this.#front;
    const blend = this.#theme.dark ? "lighter" : "source-over";
    g.clearRect(0, 0, this.#w, this.#h);
    this.#drawGuides(g);
    this.#drawTicks(g);
    g.globalCompositeOperation = blend;
    for (const p of this.#particles) if (this.#behind(p)) this.#drawParticle(g, p, trails);
    g.globalCompositeOperation = "source-over";
    this.#drawCore(g);
    g.globalCompositeOperation = blend;
    for (const p of this.#particles) if (!this.#behind(p)) this.#drawParticle(g, p, trails);
    g.globalCompositeOperation = "source-over";
    this.#drawPorts(g);
  }

  #behind(p: Particle): boolean {
    return (p.kind === "orbit" || p.kind === "fade") && Math.sin(p.a) < 0;
  }

  /** Block ticks along the horizon, each with a short wake: pale heat on graphite, deeper ember on bone. */
  #drawTicks(g: CanvasRenderingContext2D): void {
    const rgb = this.#theme.dark ? "255, 210, 150" : "225, 83, 26";
    for (const t of this.#ticks) {
      const wake = g.createLinearGradient(t.x - 14, 0, t.x + 7, 0);
      wake.addColorStop(0, `rgba(${rgb}, 0)`);
      wake.addColorStop(0.62, `rgba(${rgb}, 0.5)`);
      wake.addColorStop(0.68, `rgba(${rgb}, 0.95)`);
      wake.addColorStop(1, `rgba(${rgb}, 0.95)`);
      g.fillStyle = wake;
      g.fillRect(t.x - 14, this.#horizonY - 1, 21, 2.5);
    }
  }

  /** The core: the spark as a solid, seen from the camera's height, flaring when a run goes through. */
  #drawCore(g: CanvasRenderingContext2D): void {
    const { x, y, s, pulse } = this.#core;
    drawSpark(g, x, y, s * (1 + pulse * 0.12), this.#spin, 0.28 + ease(clamp(this.#camera.x, 0, 1)) * 0.5, { dark: this.#theme.dark, heat: pulse });
  }

  #drawPorts(g: CanvasRenderingContext2D): void {
    const { text, muted, mono } = this.#theme;
    g.textBaseline = "middle";
    for (const port of this.#ports) {
      // The port: a diamond, the spark of the mark.
      g.save();
      g.translate(port.x, port.y);
      g.rotate(Math.PI / 4);
      g.fillStyle = port.flash > 0 ? "#ffb547" : "rgba(255, 106, 19, 0.85)";
      g.fillRect(-4, -4, 8, 8);
      g.restore();
      if (port.flash > 0) {
        g.beginPath();
        g.arc(port.x, port.y, 6 + (1 - port.flash) * 22, 0, TAU);
        g.strokeStyle = `rgba(255, 150, 60, ${port.flash * 0.8})`;
        g.lineWidth = 1.5;
        g.stroke();
      }
      g.textAlign = "right";
      g.font = `600 10.5px ${mono}`;
      g.fillStyle = `rgba(${muted}, 0.95)`;
      g.fillText(port.name.toUpperCase(), port.x - 14, port.y - (port.label ? 9 : 0));
      if (port.label) {
        const a = Math.min(1, port.labelT / 0.5, (3.2 - port.labelT) / 0.25 + 0.2);
        g.font = `500 12px ${mono}`;
        g.fillStyle = `rgba(${text}, ${clamp(a, 0, 1)})`;
        g.fillText(port.label, port.x - 14, port.y + 8);
      }
    }
  }

  #drawParticle(g: CanvasRenderingContext2D, p: Particle, trails: boolean): void {
    const { dark, ink } = this.#theme;
    if (p.kind === "ignite") {
      if (trails) this.#drawTrail(g, p, "255, 156, 64", 0.95, 2.6);
      if (this.#ember) g.drawImage(this.#ember, p.x - 18, p.y - 18, 36, 36);
      g.fillStyle = "#fff1d2";
      g.beginPath();
      g.arc(p.x, p.y, 2.4, 0, TAU);
      g.fill();
      return;
    }
    const depth = p.kind === "rise" ? 0.7 : (Math.sin(p.a) + 1) / 2;
    let alpha = (dark ? 0.22 : 0.3) + depth * (dark ? 0.6 : 0.5);
    if (p.kind === "fade") alpha *= 1 - p.t / p.dur;
    if (p.kind === "rise") alpha *= Math.min(1, p.t / 0.4);
    const size = p.size * (0.7 + depth * 0.8);
    if (trails) this.#drawTrail(g, p, ink, alpha * (dark ? 0.8 : 0.65), size * 1.5);
    // The near half of the swarm glows a little on graphite.
    if (this.#glow && depth > 0.45) {
      const s = size * 7;
      g.globalAlpha = alpha * 0.5;
      g.drawImage(this.#glow, p.x - s / 2, p.y - s / 2, s, s);
      g.globalAlpha = 1;
    }
    g.fillStyle = `rgba(${ink}, ${alpha.toFixed(3)})`;
    g.beginPath();
    g.arc(p.x, p.y, size, 0, TAU);
    g.fill();
  }

  /** A trail along the particle's recent path, fading from its head to nothing. */
  #drawTrail(g: CanvasRenderingContext2D, p: Particle, rgb: string, alpha: number, width: number): void {
    const tr = p.trail;
    if (tr.count < 2) return;
    const span = TRAIL_SECONDS[p.kind];
    let i = (tr.head - 1 + TRAIL_CAP) % TRAIL_CAP;
    const hx = tr.x[i] as number;
    const hy = tr.y[i] as number;
    let ex = hx;
    let ey = hy;
    let n = 1;
    g.beginPath();
    g.moveTo(hx, hy);
    while (n < tr.count) {
      i = (i - 1 + TRAIL_CAP) % TRAIL_CAP;
      if (this.#clock - (tr.t[i] as number) > span) break;
      ex = tr.x[i] as number;
      ey = tr.y[i] as number;
      g.lineTo(ex, ey);
      n++;
    }
    if (n < 2 || Math.abs(ex - hx) + Math.abs(ey - hy) < 0.5) return;
    const fade = g.createLinearGradient(hx, hy, ex, ey);
    fade.addColorStop(0, `rgba(${rgb}, ${alpha.toFixed(3)})`);
    fade.addColorStop(1, `rgba(${rgb}, 0)`);
    g.strokeStyle = fade;
    g.lineWidth = width;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.stroke();
  }
}
