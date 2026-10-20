import { atan2 } from './dmath';
import { planetState } from './mapgen';
import { gravityInto, worldTime, type PlanetNow, type World } from './physics';
import type { RuleSet } from './ruleset';
import { add, cross, dot, len, norm, scale, sub, wrapAngle, type Vec } from './vec';

export interface BodyLike {
  pos: Vec;
  vel: Vec;
}

export interface PredictResult {
  /** Samples every `step` seconds, starting after the first step. */
  points: Array<{ t: number; pos: Vec; vel: Vec }>;
  /** First planet contact along the path (radius `radius` given to predict), or null. */
  hit: { planet: number; t: number } | null;
  /** True when the path leaves the arena. */
  leavesArena: boolean;
}

export interface StrategyLib {
  gravityAt(pos: Vec, t?: number): Vec;
  /** Integrates a free body (no thrust) under gravity for `seconds` (≤ 10). */
  predict(body: BodyLike, seconds: number, opts?: { step?: number; radius?: number }): PredictResult;
  /** Straight-line intercept (ignores gravity): angle to aim, time to impact and impact point. null = unreachable. */
  leadTarget(shooter: BodyLike, target: BodyLike, bulletSpeed: number): { angle: number; time: number; point: Vec } | null;
  angleTo(from: Vec, to: Vec): number;
  wrapAngle(a: number): number;
  add(a: Vec, b: Vec): Vec;
  sub(a: Vec, b: Vec): Vec;
  scale(a: Vec, s: number): Vec;
  len(a: Vec): number;
  norm(a: Vec): Vec;
  dot(a: Vec, b: Vec): number;
  cross(a: Vec, b: Vec): number;
}

export interface Observation {
  tick: number;
  t: number;
  dtDecision: number;
  rules: RuleSet;
  arena: { radius: number };
  self: {
    id: string;
    pos: Vec;
    vel: Vec;
    angle: number;
    angVel: number;
    hp: number;
    fuel: number;
    ammo: number;
    heat: number;
    cooldown: number;
    overheated: boolean;
  };
  enemies: Array<{ id: string; pos: Vec; vel: Vec; angle: number; hp: number; alive: boolean }>;
  bullets: Array<{ pos: Vec; vel: Vec; owner: string; ttl: number }>;
  planets: Array<{ pos: Vec; vel: Vec; radius: number; mass: number }>;
  G: number;
  rng: () => number;
  lib: StrategyLib;
}

/** Charge function: adds `n` ops to the strategy budget and throws when exceeded. */
export type Charge = (n: number) => void;

/** Builds the frozen helper library for one ship. `charge` meters host-side work done on the strategy's behalf. */
export function makeLib(world: World, charge: Charge): StrategyLib {
  const rules = world.rules;
  const planetsAtTime = (t: number): PlanetNow[] =>
    world.map.planets.map((d) => {
      const s = planetState(d, t);
      return { pos: s.pos, vel: s.vel, radius: d.radius, mass: d.mass };
    });
  const isStatic = world.map.planets.every((p) => p.omega === 0);

  const lib: StrategyLib = {
    gravityAt(pos, t) {
      charge(world.planets.length);
      const pl = t === undefined || isStatic ? world.planets : planetsAtTime(t);
      return gravityInto(pl, rules, pos.x, pos.y, { x: 0, y: 0 });
    },
    predict(body, seconds, opts) {
      const step = Math.max(1 / 120, Math.min(0.5, opts?.step ?? 1 / 30));
      const horizon = Math.max(0, Math.min(10, seconds));
      const radius = opts?.radius ?? rules.ship.radius;
      const n = Math.ceil(horizon / step);
      charge(n * (world.planets.length + 2));
      const t0 = worldTime(world);
      const pos = { x: body.pos.x, y: body.pos.y };
      const vel = { x: body.vel.x, y: body.vel.y };
      let pl = isStatic ? world.planets : planetsAtTime(t0);
      const acc = gravityInto(pl, rules, pos.x, pos.y, { x: 0, y: 0 });
      const points: PredictResult['points'] = [];
      let hit: PredictResult['hit'] = null;
      let leavesArena = false;
      const R2 = rules.arenaRadius * rules.arenaRadius;
      for (let i = 1; i <= n; i++) {
        vel.x += acc.x * step * 0.5;
        vel.y += acc.y * step * 0.5;
        pos.x += vel.x * step;
        pos.y += vel.y * step;
        if (!isStatic) pl = planetsAtTime(t0 + i * step);
        gravityInto(pl, rules, pos.x, pos.y, acc);
        vel.x += acc.x * step * 0.5;
        vel.y += acc.y * step * 0.5;
        const t = i * step;
        points.push({ t, pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y } });
        if (!leavesArena && pos.x * pos.x + pos.y * pos.y > R2) leavesArena = true;
        for (let k = 0; k < pl.length; k++) {
          const p = pl[k];
          const lim = p.radius + radius;
          const dx = p.pos.x - pos.x;
          const dy = p.pos.y - pos.y;
          if (dx * dx + dy * dy < lim * lim) {
            hit = { planet: k, t };
            break;
          }
        }
        if (hit) break;
      }
      return { points, hit, leavesArena };
    },
    leadTarget(shooter, target, bulletSpeed) {
      charge(4);
      // Bullet inherits shooter velocity, so solve in the shooter's frame.
      const rp = sub(target.pos, shooter.pos);
      const rv = sub(target.vel, shooter.vel);
      const a = dot(rv, rv) - bulletSpeed * bulletSpeed;
      const b = 2 * dot(rp, rv);
      const c = dot(rp, rp);
      let time: number;
      if (Math.abs(a) < 1e-9) {
        if (Math.abs(b) < 1e-9) return null;
        time = -c / b;
      } else {
        const disc = b * b - 4 * a * c;
        if (disc < 0) return null;
        const s = Math.sqrt(disc);
        const t1 = (-b - s) / (2 * a);
        const t2 = (-b + s) / (2 * a);
        time = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
      }
      if (!(time > 0)) return null;
      const aim = add(rp, scale(rv, time));
      return { angle: atan2(aim.y, aim.x), time, point: add(target.pos, scale(target.vel, time)) };
    },
    angleTo(from, to) {
      return atan2(to.y - from.y, to.x - from.x);
    },
    wrapAngle,
    add,
    sub,
    scale,
    len,
    norm,
    dot,
    cross,
  };
  return Object.freeze(lib);
}

const cv = (p: Vec): Vec => ({ x: p.x, y: p.y });

/** Fresh observation for ship `index` (all plain copies; strategies may mutate them freely). */
export function buildObservation(world: World, index: number, rng: () => number, lib: StrategyLib, rulesCopy: RuleSet): Observation {
  const me = world.ships[index];
  const rules = world.rules;
  const bullets = world.bullets
    .map((b) => {
      const dx = b.pos.x - me.pos.x;
      const dy = b.pos.y - me.pos.y;
      return { b, d: dx * dx + dy * dy };
    })
    .sort((a, c) => a.d - c.d || a.b.id - c.b.id)
    .slice(0, rules.obsBullets)
    .map(({ b }) => ({ pos: cv(b.pos), vel: cv(b.vel), owner: world.ships[b.owner].id, ttl: b.ttl }));
  return {
    tick: world.tick,
    t: worldTime(world),
    dtDecision: rules.dt * rules.decisionEvery,
    rules: rulesCopy,
    arena: { radius: rules.arenaRadius },
    self: {
      id: me.id,
      pos: cv(me.pos),
      vel: cv(me.vel),
      angle: me.angle,
      angVel: me.angVel,
      hp: me.hp,
      fuel: me.fuel,
      ammo: me.ammo,
      heat: me.heat,
      cooldown: me.cooldown,
      overheated: me.lock > 0,
    },
    enemies: world.ships
      .filter((s) => s.index !== index)
      .map((s) => ({ id: s.id, pos: cv(s.pos), vel: cv(s.vel), angle: s.angle, hp: s.hp, alive: s.alive })),
    bullets,
    planets: world.planets.map((p) => ({ pos: cv(p.pos), vel: cv(p.vel), radius: p.radius, mass: p.mass })),
    G: rules.G,
    rng,
    lib,
  };
}
