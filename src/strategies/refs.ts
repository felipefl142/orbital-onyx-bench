/**
 * Reference strategies (v2). Plain JS source strings, compiled through the same sandbox as LLM strategies, so the
 * anchors play under exactly the same rules. They form a ladder:
 *
 *   idle    does nothing (it only falls)
 *   orbiter never shoots; survives: escapes planets and the arena edge, dodges bullets, holds an orbit
 *   turret  stays put and shoots with a gravity-corrected aim; thrusts only to escape a crash
 *   hunter  orbiter's survival + turret's gun + dodging + positioning
 *
 * The v1 versions used for the 2026-10-19 runs are in refsV1.ts.
 */

/** Helpers shared by orbiter, turret and hunter (prepended to each; every strategy stays one self-contained file). */
const COMMON = `
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

function steer(L, me, target, gain) {
  const err = L.wrapAngle(target - me.angle);
  return { err, turn: clamp(err * gain - me.angVel * 0.15, -1, 1) };
}

function heaviest(obs) {
  let best = null;
  for (const p of obs.planets) if (!best || p.mass > best.mass) best = p;
  return best;
}

function enemiesAlive(obs) {
  return obs.enemies.filter((e) => e.alive);
}

// Free-fall prediction says we hit a planet or leave the arena: escape direction and time to impact.
function danger(obs, horizon) {
  const L = obs.lib;
  const me = obs.self;
  const path = L.predict(me, horizon, { step: 1 / 20, radius: obs.rules.ship.radius + 25 });
  if (path.hit) {
    const p = obs.planets[path.hit.planet];
    const radial = L.norm(L.sub(me.pos, p.pos));
    const tang = { x: -radial.y, y: radial.x };
    const sgn = L.dot(L.sub(me.vel, p.vel), tang) >= 0 ? 1 : -1;
    // Raise the periapsis: burn along the current direction of travel around the planet, and partly outward.
    return { dir: L.norm(L.add(L.scale(tang, sgn), L.scale(radial, 0.8))), t: path.hit.t };
  }
  const r = L.len(me.pos);
  const outward = L.dot(me.vel, L.norm(me.pos));
  if (path.leavesArena || (r > obs.arena.radius * 0.86 && outward > -20)) {
    return { dir: L.scale(L.norm(me.pos), -1), t: 3 };
  }
  return null;
}

// Nearest enemy bullet that will pass close to us within \`window\` seconds (straight-line estimate).
function incoming(obs, window) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  let threat = null;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const d = L.sub(b.pos, me.pos);
    const u = L.sub(b.vel, me.vel);
    const uu = L.dot(u, u);
    if (uu < 1) continue;
    const t = -L.dot(d, u) / uu;
    if (t <= 0 || t > window || t > b.ttl) continue;
    const miss = L.add(d, L.scale(u, t));
    if (L.len(miss) < R * 3 && (!threat || t < threat.t)) threat = { t, miss, u };
  }
  return threat;
}

// Sideways direction away from the side the bullet will pass on.
function dodgeDir(L, threat) {
  const side = L.norm({ x: -threat.u.y, y: threat.u.x });
  return L.scale(side, L.dot(side, threat.miss) > 0 ? -1 : 1);
}

// Gravity-corrected aim: simulate the curved bullet path against the enemy's free-fall path and correct the angle by
// the miss. Returns the angle, the predicted closest approach (miss) and whether a planet is in the way.
function gravityAim(obs, target, maxTime) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const speed = obs.rules.weapon.bulletSpeed;
  const lead = L.leadTarget(me, target, speed);
  if (!lead || lead.time > maxTime) return null;
  const horizon = Math.min(3, lead.time + 0.4);
  const ePath = L.predict(target, horizon, { step: 1 / 30 }).points;
  if (!ePath.length) return null;
  const evaluate = (angle) => {
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const bullet = { pos: L.add(me.pos, L.scale(dir, R + 3)), vel: L.add(me.vel, L.scale(dir, speed)) };
    const bp = L.predict(bullet, horizon, { step: 1 / 30, radius: 0 });
    let best = Infinity;
    let at = -1;
    for (let i = 0; i < bp.points.length && i < ePath.length; i++) {
      const dd = L.len(L.sub(bp.points[i].pos, ePath[i].pos));
      if (dd < best) { best = dd; at = i; }
    }
    if (at < 0) return { angle, miss: Infinity, blocked: true, corr: 0, t: lead.time };
    const off = L.sub(ePath[at].pos, bp.points[at].pos);
    const range = Math.max(1, L.len(L.sub(ePath[at].pos, me.pos)));
    const blocked = !!bp.hit && bp.hit.t <= bp.points[at].t;
    return { angle, miss: best, blocked, corr: L.cross(dir, off) / range, t: bp.points[at].t };
  };
  let ev = evaluate(lead.angle);
  for (let k = 0; k < 2 && ev.miss > R * 0.5; k++) {
    const next = evaluate(ev.angle + ev.corr);
    if (next.miss >= ev.miss) break;
    ev = next;
  }
  return ev;
}

// Thrust toward a circular orbit of radius \`wantR\` around planet \`home\`, keeping the current direction of travel.
function orbitBurn(obs, home, wantR, gain) {
  const L = obs.lib;
  const me = obs.self;
  const rel = L.sub(me.pos, home.pos);
  const r = Math.max(L.len(rel), 1);
  const radial = L.norm(rel);
  const tangent = { x: -radial.y, y: radial.x };
  const dirSign = L.dot(L.sub(me.vel, home.vel), tangent) >= 0 ? 1 : -1;
  const vCirc = Math.sqrt((obs.G * home.mass) / r);
  const want = L.add(L.add(home.vel, L.scale(tangent, vCirc * dirSign)), L.scale(radial, (wantR - r) * gain));
  return L.sub(want, me.vel);
}

// Burn along \`dv\`: turn toward it and thrust once roughly aligned.
function burn(L, me, dv, tolerance, scale) {
  const mag = L.len(dv);
  const s = steer(L, me, Math.atan2(dv.y, dv.x), 3);
  return { thrust: Math.abs(s.err) < tolerance ? clamp(mag / scale, 0, 1) : 0, turn: s.turn, fire: false };
}
`;

export const IDLE = `// idle: does nothing. Baseline: it only falls.
export default function control(obs, mem) {
  return { thrust: 0, turn: 0, fire: false };
}
`;

export const ORBITER =
  `// orbiter: never shoots. Survives: escapes planets and the arena edge, dodges bullets, holds a wide orbit.
` +
  COMMON +
  `
export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const d = danger(obs, 5);
  if (d && me.fuel > 0) return burn(L, me, L.scale(d.dir, 100), 0.7, 30);
  const threat = incoming(obs, 1.2);
  if (threat && me.fuel > 3) return burn(L, me, L.scale(dodgeDir(L, threat), 100), 1.0, 30);
  const home = heaviest(obs);
  if (!home) return { thrust: 0, turn: 0, fire: false };
  const dv = orbitBurn(obs, home, home.radius + 450, 0.2);
  if (L.len(dv) < 6 || me.fuel < 8) return { thrust: 0, turn: 0, fire: false };
  return burn(L, me, dv, 0.3, 40);
}
`;

export const TURRET =
  `// turret: stays put and shoots with a gravity-corrected aim. Thrusts only to escape a crash.
` +
  COMMON +
  `
export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const d = danger(obs, 4);
  if (d && d.t < 2.5 && me.fuel > 0) return burn(L, me, L.scale(d.dir, 100), 0.7, 30);
  let best = null;
  for (const e of enemiesAlive(obs)) {
    const dist = L.len(L.sub(e.pos, me.pos));
    if (!best || dist < best.dist) best = { e, dist };
  }
  if (!best) return { thrust: 0, turn: 0, fire: false };
  // Out of reach: just track the nearest enemy.
  if (best.dist > 2000) return { thrust: 0, turn: steer(L, me, L.angleTo(me.pos, best.e.pos), 3).turn, fire: false };
  const aim = gravityAim(obs, best.e, 3.0);
  const angle = aim ? aim.angle : L.angleTo(me.pos, best.e.pos);
  const s = steer(L, me, angle, 3);
  const aligned = Math.abs(s.err) < Math.atan2(R * 0.8, best.dist) + 0.01;
  const fire = !!aim && !aim.blocked && aim.miss < R && aligned && !me.overheated && me.heat < 80;
  return { thrust: 0, turn: s.turn, fire };
}
`;

export const HUNTER =
  `// hunter: orbiter's survival + turret's gun + dodging + positioning (picks the weakest nearby enemy).
` +
  COMMON +
  `
export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  // 1) Never crash: planets and the arena edge come first.
  const d = danger(obs, 5);
  if (d && d.t < 3.5 && me.fuel > 0) return burn(L, me, L.scale(d.dir, 100), 0.7, 30);

  // 2) Dodge a bullet that will pass within a few ship radii in the next 1.2 s.
  const threat = incoming(obs, 1.2);
  if (threat && me.fuel > 6) return burn(L, me, L.scale(dodgeDir(L, threat), 100), 1.1, 30);

  // 3) Shoot when the predicted curved shot actually connects.
  let target = null;
  for (const e of enemiesAlive(obs)) {
    const dist = L.len(L.sub(e.pos, me.pos));
    const score = dist + e.hp * 6;
    if (!target || score < target.score) target = { e, dist, score };
  }
  if (target && target.dist < 1700) {
    const aim = gravityAim(obs, target.e, 2.8);
    if (aim && !aim.blocked && aim.miss < R * 2) {
      const s = steer(L, me, aim.angle, 3);
      const aligned = Math.abs(s.err) < Math.atan2(R * 0.8, target.dist) + 0.01;
      const fire = aim.miss < R * 1.5 && aligned && !me.overheated && me.heat < 75;
      // Keep the orbit while aiming: a short burn when the nose happens to point the right way.
      const home = heaviest(obs);
      const keep = home ? orbitBurn(obs, home, home.radius + 380, 0.2) : { x: 0, y: 0 };
      const along = Math.cos(Math.atan2(keep.y, keep.x) - me.angle);
      const thrust = !fire && along > 0.7 && L.len(keep) > 10 && me.fuel > 15 ? 0.5 : 0;
      return { thrust, turn: s.turn, fire };
    }
  }

  // 4) Position: hold an orbit, drift toward a far target, back off from a close one.
  const home = heaviest(obs);
  if (!home) return { thrust: 0, turn: 0, fire: false };
  let dv = orbitBurn(obs, home, home.radius + 380, 0.2);
  if (target && target.dist > 1700) dv = L.add(dv, L.scale(L.norm(L.sub(target.e.pos, me.pos)), 15));
  if (target && target.dist < 800) dv = L.add(dv, L.scale(L.norm(L.sub(me.pos, target.e.pos)), 20));
  if (L.len(dv) < 8 || me.fuel < 10) {
    const face = target ? L.angleTo(me.pos, target.e.pos) : me.angle;
    return { thrust: 0, turn: steer(L, me, face, 3).turn, fire: false };
  }
  return burn(L, me, dv, 0.3, 40);
}
`;

export interface RefStrategy {
  id: string;
  name: string;
  code: string;
}

export const REFERENCE_STRATEGIES: RefStrategy[] = [
  { id: 'ref:idle', name: 'idle', code: IDLE },
  { id: 'ref:orbiter', name: 'orbiter', code: ORBITER },
  { id: 'ref:turret', name: 'turret', code: TURRET },
  { id: 'ref:hunter', name: 'hunter', code: HUNTER },
];
