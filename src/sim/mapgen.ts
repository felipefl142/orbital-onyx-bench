import { atan2, cos, hypot, sin } from './dmath';
import { deriveSeed, mulberry32 } from './prng';
import type { RuleSet } from './ruleset';
import type { Vec } from './vec';

export interface MapParams {
  seed: number;
  planets: number;
  ships: number;
  /** Non-central planets rotate rigidly around the arena centre (and the central planet, if any). */
  orbits: boolean;
}

export interface PlanetDef {
  /** Position at t = 0. */
  pos: Vec;
  radius: number;
  mass: number;
  /** Angular speed (rad/s) around the origin; 0 = fixed. */
  omega: number;
}

export interface SpawnDef {
  pos: Vec;
  vel: Vec;
  angle: number;
}

export interface MapDef {
  params: MapParams;
  planets: PlanetDef[];
  spawns: SpawnDef[];
}

const ORBIT_OMEGA = 0.04;

/** Planet position and velocity at time t (kinematic, deterministic). */
export function planetState(p: PlanetDef, t: number): { pos: Vec; vel: Vec } {
  if (p.omega === 0) return { pos: p.pos, vel: { x: 0, y: 0 } };
  const a = p.omega * t;
  const c = cos(a);
  const s = sin(a);
  const pos = { x: p.pos.x * c - p.pos.y * s, y: p.pos.x * s + p.pos.y * c };
  return { pos, vel: { x: -p.omega * pos.y, y: p.omega * pos.x } };
}

/**
 * Seeded map generator. Planets are laid out with k-fold rotational symmetry (k = ships) where the count allows it:
 * floor(N/k) planets per sector, one central planet if N mod k ≥ 1, and any further remainder placed freely (that part
 * is asymmetric; spawn swapping in the tournament covers it).
 */
export function generateMap(params: MapParams, rules: RuleSet): MapDef {
  const { planets: n, ships: k } = params;
  const R = rules.arenaRadius;
  const rng = mulberry32(deriveSeed(params.seed, 'map'));
  const rand = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const massOf = (radius: number) => radius * radius * 0.1 * rand(0.8, 1.25);

  const perSector = Math.floor(n / k);
  const rem = n % k;
  const out: PlanetDef[] = [];
  const fits = (pos: Vec, radius: number, list: PlanetDef[]) =>
    list.every((p) => hypot(p.pos.x - pos.x, p.pos.y - pos.y) >= p.radius + radius + 200);

  if (rem >= 1) {
    const radius = rand(70, 110);
    out.push({ pos: { x: 0, y: 0 }, radius, mass: massOf(radius), omega: 0 });
  }

  for (let i = 0; i < perSector; i++) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const radius = rand(40, 90);
      const r = rand(380, R * 0.68);
      const a = rand(0, (Math.PI * 2) / k);
      const mass = massOf(radius);
      const replicas: PlanetDef[] = [];
      for (let j = 0; j < k; j++) {
        const aj = a + (j * Math.PI * 2) / k;
        replicas.push({ pos: { x: cos(aj) * r, y: sin(aj) * r }, radius, mass, omega: 0 });
      }
      const ok = replicas.every((p, idx) => fits(p.pos, p.radius, [...out, ...replicas.slice(0, idx)]));
      if (ok) {
        out.push(...replicas);
        break;
      }
    }
  }

  for (let i = 1; i < rem; i++) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const radius = rand(35, 70);
      const r = rand(380, R * 0.7);
      const a = rand(0, Math.PI * 2);
      const pos = { x: cos(a) * r, y: sin(a) * r };
      if (fits(pos, radius, out)) {
        out.push({ pos, radius, mass: massOf(radius), omega: 0 });
        break;
      }
    }
  }

  if (params.orbits) {
    for (const p of out) if (p.pos.x !== 0 || p.pos.y !== 0) p.omega = ORBIT_OMEGA;
  }

  const totalMass = out.reduce((s, p) => s + p.mass, 0);
  const spawns: SpawnDef[] = [];
  let ring = R * 0.8;
  const a0Base = rand(0, Math.PI * 2);
  let placed = false;
  for (let shrink = 0; shrink < 6 && !placed; shrink++, ring *= 0.93) {
    for (let attempt = 0; attempt < 64 && !placed; attempt++) {
      const a0 = a0Base + (attempt * Math.PI * 2) / (64 * k);
      const cand: Vec[] = [];
      for (let i = 0; i < k; i++) {
        const a = a0 + (i * Math.PI * 2) / k;
        cand.push({ x: cos(a) * ring, y: sin(a) * ring });
      }
      if (cand.every((c) => out.every((p) => hypot(p.pos.x - c.x, p.pos.y - c.y) >= p.radius + 220))) {
        const speed = totalMass > 0 ? 0.85 * Math.sqrt((rules.G * totalMass) / ring) : 0;
        for (const c of cand) {
          const a = atan2(c.y, c.x);
          spawns.push({
            pos: c,
            vel: { x: -sin(a) * speed, y: cos(a) * speed },
            angle: a + Math.PI,
          });
        }
        placed = true;
      }
    }
  }
  if (!placed) {
    for (let i = 0; i < k; i++) {
      const a = a0Base + (i * Math.PI * 2) / k;
      spawns.push({ pos: { x: cos(a) * R * 0.9, y: sin(a) * R * 0.9 }, vel: { x: 0, y: 0 }, angle: a + Math.PI });
    }
  }

  return { params, planets: out, spawns };
}
