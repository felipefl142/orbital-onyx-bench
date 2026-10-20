import { gravityInto, type PlanetNow, type SimEvent } from '../../sim/physics';
import type { RuleSet } from '../../sim/ruleset';
import type { Vec } from '../../sim/vec';
import type { ArenaFrame } from '../../workers/protocol';

export interface Overlays {
  trails: boolean;
  prediction: boolean;
  field: boolean;
  contours: boolean;
  labels: boolean;
}

interface Palette {
  bg: string;
  border: string;
  borderDim: string;
  title: string;
  accent: string;
  dim: string;
  muted: string;
  text: string;
  error: string;
  ships: string[];
}

interface Effect {
  kind: 'hit' | 'death';
  pos: Vec;
  t0: number;
  ship: number;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#fff';
}

export class ArenaRenderer {
  private ctx: CanvasRenderingContext2D;
  private pal!: Palette;
  private rules: RuleSet | null = null;
  private contourCanvas: HTMLCanvasElement | null = null;
  private contourKey = '';
  private effects: Effect[] = [];
  private size = 0;
  private scale = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.refreshPalette();
  }

  refreshPalette() {
    this.pal = {
      bg: cssVar('--bg'),
      border: cssVar('--border'),
      borderDim: cssVar('--border-dim'),
      title: cssVar('--title'),
      accent: cssVar('--accent'),
      dim: cssVar('--dim'),
      muted: cssVar('--muted'),
      text: cssVar('--text'),
      error: cssVar('--error'),
      ships: Array.from({ length: 8 }, (_, i) => cssVar(`--ship-${i}`)),
    };
    this.contourKey = '';
  }

  setRules(rules: RuleSet) {
    this.rules = rules;
    this.effects = [];
    this.contourKey = '';
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(50, Math.floor(this.canvas.clientWidth * dpr));
    if (this.canvas.width !== w || this.canvas.height !== w) {
      this.canvas.width = w;
      this.canvas.height = w;
    }
    this.size = w;
    this.scale = w / 2 / ((this.rules?.arenaRadius ?? 2000) * 1.04);
  }

  private sx = (x: number) => this.size / 2 + x * this.scale;
  private sy = (y: number) => this.size / 2 - y * this.scale;

  addEvents(events: SimEvent[], t: number) {
    for (const e of events) {
      if (e.type === 'hit') this.effects.push({ kind: 'hit', pos: e.pos, t0: t, ship: e.ship });
      if (e.type === 'death') this.effects.push({ kind: 'death', pos: e.pos, t0: t, ship: e.ship });
    }
  }

  draw(cur: ArenaFrame, prev: ArenaFrame | null, alpha: number, trails: Vec[][], names: string[], ov: Overlays) {
    if (!this.rules) return;
    this.resize();
    const { ctx, pal } = this;
    const R = this.rules.arenaRadius;
    const planets: PlanetNow[] = cur.planets.map((p) => ({ pos: p.pos, vel: { x: 0, y: 0 }, radius: p.radius, mass: p.mass }));
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, this.size, this.size);

    if (ov.contours) this.drawContours(planets);
    if (ov.field) this.drawField(planets);

    // Arena edge
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = pal.borderDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.sx(0), this.sy(0), R * this.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Planets
    for (const p of planets) {
      const x = this.sx(p.pos.x);
      const y = this.sy(p.pos.y);
      const r = Math.max(2, p.radius * this.scale);
      const glow = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2.2);
      glow.addColorStop(0, withAlpha(pal.accent, 0.18));
      glow.addColorStop(1, withAlpha(pal.accent, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
      g.addColorStop(0, pal.title);
      g.addColorStop(0.45, pal.accent);
      g.addColorStop(1, pal.border);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const lerp = (a: number, b: number) => (prev ? a + (b - a) * alpha : b);

    // Trails
    if (ov.trails) {
      trails.forEach((tr, i) => {
        if (tr.length < 2) return;
        ctx.strokeStyle = withAlpha(pal.ships[i % 8], 0.45);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        tr.forEach((p, k) => (k ? ctx.lineTo(this.sx(p.x), this.sy(p.y)) : ctx.moveTo(this.sx(p.x), this.sy(p.y))));
        ctx.stroke();
      });
    }

    // Predicted free-fall paths
    if (ov.prediction) {
      cur.ships.forEach((s, i) => {
        if (!s.alive) return;
        const path = predictPath(planets, this.rules!, s.pos, s.vel, 4);
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = withAlpha(pal.ships[i % 8], 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.sx(s.pos.x), this.sy(s.pos.y));
        for (const p of path.points) ctx.lineTo(this.sx(p.x), this.sy(p.y));
        ctx.stroke();
        ctx.setLineDash([]);
        if (path.hit) {
          const e = path.points[path.points.length - 1];
          ctx.fillStyle = pal.error;
          ctx.font = `${Math.max(10, 14 * (this.size / 900))}px var(--font), monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('✕', this.sx(e.x), this.sy(e.y));
        }
      });
    }

    // Bullets
    for (const b of cur.bullets) {
      ctx.fillStyle = pal.ships[b.owner % 8];
      ctx.beginPath();
      ctx.arc(this.sx(b.x), this.sy(b.y), Math.max(1.5, 2.5 * this.scale), 0, Math.PI * 2);
      ctx.fill();
    }

    // Ships
    const shipPx = Math.max(7, this.rules.ship.radius * this.scale * 1.4);
    cur.ships.forEach((s, i) => {
      if (!s.alive) return;
      const p = prev?.ships[i];
      const x = this.sx(p ? lerp(p.pos.x, s.pos.x) : s.pos.x);
      const y = this.sy(p ? lerp(p.pos.y, s.pos.y) : s.pos.y);
      const a = s.angle;
      const c = Math.cos(a);
      const sn = -Math.sin(a);
      const col = pal.ships[i % 8];
      if (s.action.thrust > 0.02 && s.fuel > 0) {
        const fl = shipPx * (0.6 + s.action.thrust * 0.9);
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - c * shipPx * 0.6, y - sn * shipPx * 0.6);
        ctx.lineTo(x - c * (shipPx * 0.6 + fl), y - sn * (shipPx * 0.6 + fl));
        ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.strokeStyle = pal.bg;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + c * shipPx, y + sn * shipPx);
      ctx.lineTo(x - c * shipPx * 0.7 - sn * shipPx * 0.6, y - sn * shipPx * 0.7 + c * shipPx * 0.6);
      ctx.lineTo(x - c * shipPx * 0.35, y - sn * shipPx * 0.35);
      ctx.lineTo(x - c * shipPx * 0.7 + sn * shipPx * 0.6, y - sn * shipPx * 0.7 - c * shipPx * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (ov.labels) {
        ctx.fillStyle = col;
        ctx.font = `${Math.max(10, 11 * (this.size / 900))}px var(--font), monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${names[i] ?? `ship${i}`} ${Math.max(0, s.hp).toFixed(0)}`, x + shipPx + 3, y - 3);
      }
    });

    // Effects
    const now = cur.t;
    this.effects = this.effects.filter((e) => now - e.t0 < (e.kind === 'death' ? 1.2 : 0.35) && now >= e.t0);
    for (const e of this.effects) {
      const k = (now - e.t0) / (e.kind === 'death' ? 1.2 : 0.35);
      const r = (e.kind === 'death' ? 60 : 18) * this.scale * (0.3 + k) + 2;
      ctx.strokeStyle = withAlpha(e.kind === 'death' ? pal.title : pal.ships[e.ship % 8], 1 - k);
      ctx.lineWidth = e.kind === 'death' ? 3 : 1.5;
      ctx.beginPath();
      ctx.arc(this.sx(e.pos.x), this.sy(e.pos.y), r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Iso-potential lines: log(-φ) banded, rendered once per planet layout into an offscreen canvas. */
  private drawContours(planets: PlanetNow[]) {
    // Rounded positions: with orbiting planets the field is re-rendered only every ~10 world units of motion.
    const key = planets.map((p) => `${Math.round(p.pos.x / 10)},${Math.round(p.pos.y / 10)}`).join(';') + this.pal.borderDim;
    if (key !== this.contourKey || !this.contourCanvas) {
      this.contourKey = key;
      const N = 420;
      const c = this.contourCanvas ?? document.createElement('canvas');
      c.width = N;
      c.height = N;
      const g = c.getContext('2d')!;
      const img = g.createImageData(N, N);
      const [r, gg, b] = hexRgb(this.pal.borderDim);
      const ext = this.rules!.arenaRadius * 1.04;
      const G = this.rules!.G;
      const soft = this.rules!.softeningFactor;
      for (let py = 0; py < N; py++) {
        for (let px = 0; px < N; px++) {
          const x = ((px + 0.5) / N) * 2 * ext - ext;
          const y = ext - ((py + 0.5) / N) * 2 * ext;
          let phi = 0;
          let inside = false;
          for (const p of planets) {
            const dx = p.pos.x - x;
            const dy = p.pos.y - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < p.radius * p.radius) inside = true;
            const e = soft * p.radius;
            phi += (G * p.mass) / Math.sqrt(d2 + e * e);
          }
          if (inside || phi <= 0) continue;
          const v = Math.log(phi) * 4;
          const f = v - Math.floor(v);
          const a = f < 0.035 ? 170 : f < 0.06 ? 70 : 0;
          if (!a) continue;
          const o = (py * N + px) * 4;
          img.data[o] = r;
          img.data[o + 1] = gg;
          img.data[o + 2] = b;
          img.data[o + 3] = a;
        }
      }
      g.putImageData(img, 0, 0);
      this.contourCanvas = c;
    }
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.contourCanvas, 0, 0, this.size, this.size);
  }

  private drawField(planets: PlanetNow[]) {
    const { ctx } = this;
    const N = 22;
    const ext = this.rules!.arenaRadius;
    const cell = (2 * ext) / N;
    const acc = { x: 0, y: 0 };
    ctx.strokeStyle = withAlpha(this.pal.muted, 0.7);
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = -ext + (i + 0.5) * cell;
        const y = -ext + (j + 0.5) * cell;
        if (x * x + y * y > ext * ext) continue;
        if (planets.some((p) => (p.pos.x - x) ** 2 + (p.pos.y - y) ** 2 < (p.radius * 1.1) ** 2)) continue;
        gravityInto(planets, this.rules!, x, y, acc);
        const m = Math.hypot(acc.x, acc.y);
        if (m < 1e-6) continue;
        const L = Math.min(1, Math.log1p(m) / Math.log1p(80)) * cell * 0.42 * this.scale;
        const ux = acc.x / m;
        const uy = -acc.y / m;
        const X = this.sx(x);
        const Y = this.sy(y);
        ctx.beginPath();
        ctx.moveTo(X - ux * L, Y - uy * L);
        ctx.lineTo(X + ux * L, Y + uy * L);
        ctx.lineTo(X + ux * L * 0.55 - uy * L * 0.3, Y + uy * L * 0.55 + ux * L * 0.3);
        ctx.stroke();
      }
    }
  }
}

/** Free fall from (pos, vel) for `seconds`, planets frozen at their current spot (display only). */
export function predictPath(planets: PlanetNow[], rules: RuleSet, pos: Vec, vel: Vec, seconds: number) {
  const step = 1 / 30;
  const p = { ...pos };
  const v = { ...vel };
  const a = gravityInto(planets, rules, p.x, p.y, { x: 0, y: 0 });
  const points: Vec[] = [];
  let hit = false;
  for (let t = 0; t < seconds && !hit; t += step) {
    v.x += a.x * step * 0.5;
    v.y += a.y * step * 0.5;
    p.x += v.x * step;
    p.y += v.y * step;
    gravityInto(planets, rules, p.x, p.y, a);
    v.x += a.x * step * 0.5;
    v.y += a.y * step * 0.5;
    points.push({ ...p });
    hit = planets.some((q) => (q.pos.x - p.x) ** 2 + (q.pos.y - p.y) ** 2 < (q.radius + rules.ship.radius) ** 2);
  }
  return { points, hit };
}

function hexRgb(c: string): [number, number, number] {
  const m = c.replace('#', '');
  const h = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

function withAlpha(c: string, a: number): string {
  const [r, g, b] = hexRgb(c);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
