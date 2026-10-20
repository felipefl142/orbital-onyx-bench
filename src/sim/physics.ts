import { cos, sin } from './dmath';
import { StateHasher } from './hash';
import { generateMap, planetState, type MapDef, type MapParams } from './mapgen';
import type { RuleSet } from './ruleset';
import type { Vec } from './vec';

export interface Action {
  thrust: number;
  turn: number;
  fire: boolean;
}

export const ZERO_ACTION: Action = Object.freeze({ thrust: 0, turn: 0, fire: false }) as Action;

export type DeathCause = 'planet' | 'bullet' | 'collision' | 'bounds';

export interface ShipStats {
  shots: number;
  hits: number;
  damageDealt: number;
  damageTaken: number;
  fuelUsed: number;
  decisions: number;
  timeouts: number;
  errors: number;
  disabled: boolean;
  lastError: string | null;
}

export interface Ship {
  id: string;
  index: number;
  pos: Vec;
  vel: Vec;
  /** Gravity acceleration at `pos` (kept for the leapfrog integrator). */
  gacc: Vec;
  angle: number;
  angVel: number;
  hp: number;
  fuel: number;
  ammo: number;
  heat: number;
  cooldown: number;
  lock: number;
  alive: boolean;
  deathTick: number;
  deathCause: DeathCause | null;
  killer: number | null;
  lastHitBy: number | null;
  action: Action;
  stats: ShipStats;
}

export interface Bullet {
  id: number;
  owner: number;
  pos: Vec;
  vel: Vec;
  gacc: Vec;
  ttl: number;
}

export interface PlanetNow {
  pos: Vec;
  vel: Vec;
  radius: number;
  mass: number;
}

export type SimEvent =
  | { type: 'fire'; tick: number; ship: number; pos: Vec }
  | { type: 'hit'; tick: number; ship: number; by: number; pos: Vec; damage: number }
  | { type: 'death'; tick: number; ship: number; cause: DeathCause; pos: Vec };

export interface World {
  rules: RuleSet;
  map: MapDef;
  tick: number;
  ships: Ship[];
  bullets: Bullet[];
  planets: PlanetNow[];
  nextBulletId: number;
  events: SimEvent[];
  recordEvents: boolean;
}

export function newStats(): ShipStats {
  return { shots: 0, hits: 0, damageDealt: 0, damageTaken: 0, fuelUsed: 0, decisions: 0, timeouts: 0, errors: 0, disabled: false, lastError: null };
}

export function createWorld(rules: RuleSet, params: MapParams, recordEvents = false): World {
  const map = generateMap(params, rules);
  const world: World = {
    rules,
    map,
    tick: 0,
    ships: [],
    bullets: [],
    planets: [],
    nextBulletId: 0,
    events: [],
    recordEvents,
  };
  updatePlanets(world, 0);
  map.spawns.forEach((s, i) => {
    const ship: Ship = {
      id: `ship${i}`,
      index: i,
      pos: { x: s.pos.x, y: s.pos.y },
      vel: { x: s.vel.x, y: s.vel.y },
      gacc: { x: 0, y: 0 },
      angle: s.angle,
      angVel: 0,
      hp: rules.ship.hp,
      fuel: rules.ship.fuelMax,
      ammo: rules.weapon.ammo,
      heat: 0,
      cooldown: 0,
      lock: 0,
      alive: true,
      deathTick: -1,
      deathCause: null,
      killer: null,
      lastHitBy: null,
      action: { ...ZERO_ACTION },
      stats: newStats(),
    };
    gravityInto(world.planets, rules, ship.pos.x, ship.pos.y, ship.gacc);
    world.ships.push(ship);
  });
  return world;
}

export function worldTime(world: World): number {
  return world.tick * world.rules.dt;
}

function updatePlanets(world: World, t: number) {
  const defs = world.map.planets;
  if (world.planets.length !== defs.length) {
    world.planets = defs.map((d) => ({ pos: { ...d.pos }, vel: { x: 0, y: 0 }, radius: d.radius, mass: d.mass }));
  }
  for (let i = 0; i < defs.length; i++) {
    const s = planetState(defs[i], t);
    world.planets[i].pos = s.pos;
    world.planets[i].vel = s.vel;
  }
}

/** Planet positions at time t (no allocation reuse; used for sub-steps). */
function planetsAt(world: World, t: number): PlanetNow[] {
  return world.map.planets.map((d) => {
    const s = planetState(d, t);
    return { pos: s.pos, vel: s.vel, radius: d.radius, mass: d.mass };
  });
}

/** Writes the summed planet gravity at (x, y) into `out`. */
export function gravityInto(planets: PlanetNow[], rules: RuleSet, x: number, y: number, out: Vec): Vec {
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const dx = p.pos.x - x;
    const dy = p.pos.y - y;
    const eps = rules.softeningFactor * p.radius;
    const r2 = dx * dx + dy * dy + eps * eps;
    const f = (rules.G * p.mass) / (r2 * Math.sqrt(r2));
    ax += dx * f;
    ay += dy * f;
  }
  out.x = ax;
  out.y = ay;
  return out;
}

function nearPlanet(planets: PlanetNow[], rules: RuleSet, x: number, y: number): boolean {
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const lim = rules.substepRadiusFactor * p.radius;
    const dx = p.pos.x - x;
    const dy = p.pos.y - y;
    if (dx * dx + dy * dy < lim * lim) return true;
  }
  return false;
}

/** Index of the planet the point (x, y) with radius r touches, or -1. */
function touchingPlanet(planets: PlanetNow[], x: number, y: number, r: number): number {
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const lim = p.radius + r;
    const dx = p.pos.x - x;
    const dy = p.pos.y - y;
    if (dx * dx + dy * dy < lim * lim) return i;
  }
  return -1;
}

interface Body {
  pos: Vec;
  vel: Vec;
  gacc: Vec;
}

/**
 * Kick-drift-kick leapfrog (velocity Verlet) over one physics step, with (ax, ay) constant acceleration (thrust).
 * Uses sub-steps near planets. Returns the index of a planet hit (radius `r`), or -1.
 */
function integrate(world: World, b: Body, ax: number, ay: number, r: number, subPlanets: PlanetNow[][] | null): number {
  const rules = world.rules;
  const n = subPlanets ? subPlanets.length : 1;
  const h = rules.dt / n;
  for (let s = 0; s < n; s++) {
    const pl = subPlanets ? subPlanets[s] : world.planets;
    b.vel.x += (b.gacc.x + ax) * h * 0.5;
    b.vel.y += (b.gacc.y + ay) * h * 0.5;
    b.pos.x += b.vel.x * h;
    b.pos.y += b.vel.y * h;
    gravityInto(pl, rules, b.pos.x, b.pos.y, b.gacc);
    b.vel.x += (b.gacc.x + ax) * h * 0.5;
    b.vel.y += (b.gacc.y + ay) * h * 0.5;
    const hit = touchingPlanet(pl, b.pos.x, b.pos.y, r);
    if (hit >= 0) return hit;
  }
  return -1;
}

function emit(world: World, e: SimEvent) {
  if (world.recordEvents) world.events.push(e);
}

function kill(world: World, ship: Ship, cause: DeathCause) {
  if (!ship.alive) return;
  ship.alive = false;
  ship.hp = Math.max(0, ship.hp);
  ship.deathTick = world.tick;
  ship.deathCause = cause;
  ship.killer = ship.lastHitBy;
  ship.vel = { x: 0, y: 0 };
  emit(world, { type: 'death', tick: world.tick, ship: ship.index, cause, pos: { ...ship.pos } });
}

function damage(world: World, ship: Ship, amount: number, by: number | null, cause: DeathCause) {
  if (!ship.alive || amount <= 0) return;
  ship.hp -= amount;
  ship.stats.damageTaken += amount;
  if (by !== null && by !== ship.index) {
    ship.lastHitBy = by;
    world.ships[by].stats.damageDealt += amount;
  }
  if (ship.hp <= 0) kill(world, ship, cause);
}

/** Advances the world by one physics step using each ship's current `action`. */
export function stepWorld(world: World): void {
  const rules = world.rules;
  const { dt } = rules;
  const t0 = world.tick * dt;
  const sr = rules.ship.radius;
  const subCache = new Map<number, PlanetNow[][]>();
  const subPlanets = (n: number): PlanetNow[][] => {
    let c = subCache.get(n);
    if (!c) {
      c = [];
      for (let s = 1; s <= n; s++) c.push(planetsAt(world, t0 + (dt * s) / n));
      subCache.set(n, c);
    }
    return c;
  };
  const hasOrbits = world.map.planets.some((p) => p.omega !== 0);
  // Planet positions at the end of the step; when planets are fixed, a single list is enough.
  const endPlanets = hasOrbits ? planetsAt(world, t0 + dt) : world.planets;
  const subFor = (x: number, y: number): PlanetNow[][] | null => {
    if (nearPlanet(world.planets, rules, x, y)) return subPlanets(rules.substeps);
    return hasOrbits ? [endPlanets] : null;
  };

  // Ships: rotation, thrust, integration.
  for (const ship of world.ships) {
    if (!ship.alive) continue;
    const a = ship.action;
    const target = a.turn * rules.ship.maxAngVel;
    const maxDw = rules.ship.angAccel * dt;
    const dw = target - ship.angVel;
    ship.angVel += dw > maxDw ? maxDw : dw < -maxDw ? -maxDw : dw;
    ship.angle += ship.angVel * dt;
    if (ship.angle > Math.PI) ship.angle -= Math.PI * 2;
    else if (ship.angle <= -Math.PI) ship.angle += Math.PI * 2;

    let ax = 0;
    let ay = 0;
    if (a.thrust > 0 && ship.fuel > 0) {
      const want = a.thrust * rules.ship.fuelBurn * dt;
      const burn = want < ship.fuel ? want : ship.fuel;
      const frac = burn / (rules.ship.fuelBurn * dt);
      const mass = rules.ship.dryMass + (rules.ship.fuelMass * ship.fuel) / rules.ship.fuelMax;
      const acc = (rules.ship.thrustForce * frac) / mass;
      ax = cos(ship.angle) * acc;
      ay = sin(ship.angle) * acc;
      ship.fuel -= burn;
      ship.stats.fuelUsed += burn;
    }
    const hit = integrate(world, ship, ax, ay, sr, subFor(ship.pos.x, ship.pos.y));
    if (hit >= 0) kill(world, ship, 'planet');
  }

  // Weapons.
  const w = rules.weapon;
  for (const ship of world.ships) {
    if (!ship.alive) continue;
    ship.cooldown = Math.max(0, ship.cooldown - dt);
    ship.heat = Math.max(0, ship.heat - w.coolRate * dt);
    ship.lock = Math.max(0, ship.lock - dt);
    if (ship.action.fire && ship.cooldown <= 0 && ship.ammo > 0 && ship.lock <= 0) {
      const cx = cos(ship.angle);
      const cy = sin(ship.angle);
      const pos = { x: ship.pos.x + cx * (sr + 3), y: ship.pos.y + cy * (sr + 3) };
      const b: Bullet = {
        id: world.nextBulletId++,
        owner: ship.index,
        pos,
        vel: { x: ship.vel.x + cx * w.bulletSpeed, y: ship.vel.y + cy * w.bulletSpeed },
        gacc: { x: 0, y: 0 },
        ttl: w.bulletLife,
      };
      gravityInto(world.planets, rules, pos.x, pos.y, b.gacc);
      world.bullets.push(b);
      ship.ammo--;
      ship.cooldown = w.cooldown;
      ship.heat += w.heatPerShot;
      if (ship.heat >= w.overheatAt) ship.lock = w.overheatLock;
      ship.stats.shots++;
      emit(world, { type: 'fire', tick: world.tick, ship: ship.index, pos: { ...pos } });
    }
  }

  // Bullets: integrate, planet hits, ship hits (swept segment vs circle).
  const keep: Bullet[] = [];
  for (const b of world.bullets) {
    const px = b.pos.x;
    const py = b.pos.y;
    const hitPlanet = integrate(world, b, 0, 0, 0, subFor(px, py));
    b.ttl -= dt;
    if (hitPlanet >= 0 || b.ttl <= 0) continue;
    let consumed = false;
    for (const ship of world.ships) {
      if (!ship.alive || ship.index === b.owner) continue;
      const sx = b.pos.x - px;
      const sy = b.pos.y - py;
      const l2 = sx * sx + sy * sy;
      let u = l2 > 0 ? ((ship.pos.x - px) * sx + (ship.pos.y - py) * sy) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = px + sx * u - ship.pos.x;
      const qy = py + sy * u - ship.pos.y;
      if (qx * qx + qy * qy <= sr * sr) {
        world.ships[b.owner].stats.hits++;
        emit(world, { type: 'hit', tick: world.tick, ship: ship.index, by: b.owner, pos: { ...b.pos }, damage: w.damage });
        damage(world, ship, w.damage, b.owner, 'bullet');
        consumed = true;
        break;
      }
    }
    if (!consumed) keep.push(b);
  }
  world.bullets = keep;

  // Ship × ship collisions.
  const ships = world.ships;
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i];
      const b = ships[j];
      if (!a.alive || !b.alive) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 4 * sr * sr || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const vn = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
      if (vn < 0) {
        // Equal-mass elastic bounce along the normal.
        a.vel.x += vn * nx;
        a.vel.y += vn * ny;
        b.vel.x -= vn * nx;
        b.vel.y -= vn * ny;
        const dmg = -vn * rules.ship.collisionDamage;
        damage(world, a, dmg, b.index, 'collision');
        damage(world, b, dmg, a.index, 'collision');
      }
      // Separate overlapping hulls.
      const push = (2 * sr - d) / 2;
      a.pos.x -= nx * push;
      a.pos.y -= ny * push;
      b.pos.x += nx * push;
      b.pos.y += ny * push;
    }
  }

  // Arena boundary.
  const R = rules.arenaRadius;
  for (const ship of ships) {
    if (!ship.alive) continue;
    if (ship.pos.x * ship.pos.x + ship.pos.y * ship.pos.y > R * R) {
      damage(world, ship, rules.outOfBoundsDps * dt, null, 'bounds');
    }
  }

  world.tick++;
  if (hasOrbits) updatePlanets(world, world.tick * dt);
}

/** Bit-exact hash of the complete dynamic state. */
export function hashWorld(world: World): string {
  const h = new StateHasher();
  h.num(world.tick).num(world.nextBulletId);
  for (const s of world.ships) {
    h.num(s.pos.x).num(s.pos.y).num(s.vel.x).num(s.vel.y).num(s.angle).num(s.angVel);
    h.num(s.hp).num(s.fuel).num(s.ammo).num(s.heat).num(s.cooldown).num(s.lock).num(s.alive ? 1 : 0).num(s.deathTick);
  }
  for (const b of world.bullets) h.num(b.id).num(b.owner).num(b.pos.x).num(b.pos.y).num(b.vel.x).num(b.vel.y).num(b.ttl);
  return h.hex();
}

/** Total specific mechanical energy (kinetic + potential) of a body, for tests and overlays. */
export function specificEnergy(world: World, pos: Vec, vel: Vec): number {
  let pot = 0;
  for (const p of world.planets) {
    const dx = p.pos.x - pos.x;
    const dy = p.pos.y - pos.y;
    const eps = world.rules.softeningFactor * p.radius;
    pot -= (world.rules.G * p.mass) / Math.sqrt(dx * dx + dy * dy + eps * eps);
  }
  return 0.5 * (vel.x * vel.x + vel.y * vel.y) + pot;
}
