/**
 * The ignition field: the landing hero, drawn on three canvases: a back layer (haze, horizon, orbit
 * guides; redrawn only when the camera moves), a trail layer whose pixels fade each frame (comet
 * trails), and a crisp overlay cleared every frame (the core, the ports and their labels).
 *
 * It shows IGNITRA's job. Chain activity rises from the horizon (the chain) at the rate the listener
 * sees blocks, and circles the core (the matcher): the spark of the mark as a solid, turning, with
 * the swarm passing behind and in front of it. When a real run happens on mainnet, one particle
 * ignites and shoots to its action's port, which shows that run. Block ticks and ignitions are real;
 * the ambient particles are an illustration of chain activity, and the page says so.
 *
 * Scrolling away raises the camera: the orbits open up from a low angle to a view from above.
 */
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

export class IgnitionField {
  readonly #back: CanvasRenderingContext2D;
  readonly #front: CanvasRenderingContext2D;
  readonly #over: CanvasRenderingContext2D;
  readonly #canvases: HTMLCanvasElement[];
  #theme: FieldTheme;
  #w = 0;
  #h = 0;
  #dpr = 1;
  #core = { x: 0, y: 0, r0: 0, r1: 0, s: 0, pulse: 0 };
  #spin = 0;
  #scroll = 0;
  #scrollGoal = 0;
  #flat = FLAT;
  #backFlat = -1;
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

  constructor(back: HTMLCanvasElement, front: HTMLCanvasElement, overlay: HTMLCanvasElement, theme: FieldTheme, actions: readonly string[]) {
    this.#canvases = [back, front, overlay];
    this.#back = back.getContext("2d") as CanvasRenderingContext2D;
    this.#front = front.getContext("2d") as CanvasRenderingContext2D;
    this.#over = overlay.getContext("2d") as CanvasRenderingContext2D;
    this.#theme = theme;
    this.#ports = (actions.length ? actions : ["Your stack"]).slice(0, 3).map((name) => ({ name, x: 0, y: 0, flash: 0, label: null, labelT: 0 }));
  }

  get running(): boolean {
    return this.#running;
  }

  setTheme(theme: FieldTheme): void {
    this.#theme = theme;
    this.#drawBack();
    if (!this.#running) this.#drawStill();
  }

  /** Lays the field out for the canvas size; seeds an orbit so the first frame is already alive. */
  resize(width: number, height: number): void {
    this.#dpr = Math.min(2, window.devicePixelRatio || 1);
    this.#w = width;
    this.#h = height;
    for (const c of this.#canvases) {
      c.width = Math.round(width * this.#dpr);
      c.height = Math.round(height * this.#dpr);
    }
    for (const g of [this.#back, this.#front, this.#over]) g.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
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
      const dt = Math.min(0.05, (now - this.#last) / 1000);
      this.#last = now;
      this.#step(dt);
      this.#draw(dt);
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
    // The camera follows the scroll, gliding rather than jumping with each wheel notch.
    this.#scroll += (this.#scrollGoal - this.#scroll) * (1 - Math.exp(-6 * dt));
    this.#flat = FLAT + (FLAT_TOP - FLAT) * ease(this.#scroll);
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
    this.#ticks = this.#ticks.filter((t) => t.x < this.#w + 20);

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
      keep.push(p);
    }
    this.#particles = keep;
  }

  // ---- drawing ---------------------------------------------------------------------------------

  #drawBack(): void {
    const g = this.#back;
    const { dark, guide } = this.#theme;
    this.#backFlat = this.#flat;
    g.clearRect(0, 0, this.#w, this.#h);
    // Heat haze around the core.
    const haze = g.createRadialGradient(this.#core.x, this.#core.y, 0, this.#core.x, this.#core.y, this.#core.r1 * 1.25);
    haze.addColorStop(0, dark ? "rgba(255, 96, 20, 0.16)" : "rgba(255, 106, 19, 0.10)");
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
    // Orbit guides.
    g.save();
    g.translate(this.#core.x, this.#core.y);
    g.rotate(TILT);
    g.setLineDash([2, 6]);
    for (const k of [0.45, 0.72, 1]) {
      g.beginPath();
      g.ellipse(0, 0, this.#core.r1 * k, this.#core.r1 * k * this.#flat, 0, 0, TAU);
      g.strokeStyle = `rgba(${guide}, ${dark ? 0.16 : 0.22})`;
      g.lineWidth = 1;
      g.stroke();
    }
    g.restore();
  }

  /** The core: the spark as a solid, seen from the camera's height, flaring when a run goes through. */
  #drawCore(g: CanvasRenderingContext2D): void {
    const { x, y, s, pulse } = this.#core;
    drawSpark(g, x, y, s * (1 + pulse * 0.12), this.#spin, 0.28 + ease(this.#scroll) * 0.5, { dark: this.#theme.dark, heat: pulse });
  }

  /** Particles crossing in front of the core are drawn again over it, so the swarm wraps the solid. */
  #drawFrontOfCore(g: CanvasRenderingContext2D): void {
    const { x, y, s } = this.#core;
    const reach = s * 1.9;
    g.globalCompositeOperation = this.#theme.dark ? "lighter" : "source-over";
    for (const p of this.#particles) {
      if (Math.abs(p.x - x) > reach || Math.abs(p.y - y) > reach) continue;
      const inFront = p.kind === "ignite" || p.kind === "rise" || Math.sin(p.a) > 0;
      if (inFront) this.#drawParticle(g, p);
    }
    g.globalCompositeOperation = "source-over";
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

  #drawParticle(g: CanvasRenderingContext2D, p: Particle): void {
    const { dark, ink } = this.#theme;
    if (p.kind === "ignite") {
      const k = p.t / p.dur;
      const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, 14);
      halo.addColorStop(0, `rgba(255, ${170 + Math.round(60 * (1 - k))}, 90, 0.85)`);
      halo.addColorStop(1, "rgba(255, 106, 19, 0)");
      g.fillStyle = halo;
      g.beginPath();
      g.arc(p.x, p.y, 14, 0, TAU);
      g.fill();
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
    g.fillStyle = `rgba(${ink}, ${alpha.toFixed(3)})`;
    g.beginPath();
    g.arc(p.x, p.y, size, 0, TAU);
    g.fill();
  }

  #draw(dt: number): void {
    const g = this.#front;
    const { dark } = this.#theme;
    if (Math.abs(this.#flat - this.#backFlat) > 0.002) this.#drawBack(); // the guides follow the camera
    // Fade the previous frame: what moved leaves a trail.
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = `rgba(0, 0, 0, ${clamp(dt * (dark ? 11 : 14), 0.12, 0.5).toFixed(3)})`;
    g.fillRect(0, 0, this.#w, this.#h);
    g.globalCompositeOperation = dark ? "lighter" : "source-over";
    for (const p of this.#particles) this.#drawParticle(g, p);
    // Block ticks along the horizon: pale heat on graphite, deeper ember on bone.
    g.fillStyle = dark ? "rgba(255, 210, 150, 0.95)" : "rgba(225, 83, 26, 0.9)";
    for (const t of this.#ticks) g.fillRect(t.x, this.#horizonY - 1, 7, 2.5);
    g.globalCompositeOperation = "source-over";
    this.#drawOverlay();
  }

  /** The crisp layer: cleared and redrawn whole, so the core and labels never smear. */
  #drawOverlay(): void {
    const o = this.#over;
    o.clearRect(0, 0, this.#w, this.#h);
    this.#drawCore(o);
    this.#drawFrontOfCore(o);
    this.#drawPorts(o);
  }

  #drawStill(): void {
    const g = this.#front;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, this.#w, this.#h);
    for (const p of this.#particles) {
      if (p.kind === "orbit" || p.kind === "fade") {
        const pt = this.#orbitPoint(p.a, p.r);
        p.x = pt.x;
        p.y = pt.y;
      }
      this.#drawParticle(g, p);
    }
    this.#drawOverlay();
  }
}
