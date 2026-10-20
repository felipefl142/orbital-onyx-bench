/** Reference strategies as used for the onyx-v1 runs of 2026-10-19 (kept so those results can be reproduced). */

const IDLE = `// idle: does nothing. Baseline: it only falls.
export default function control(obs, mem) {
  return { thrust: 0, turn: 0, fire: false };
}
`;

const ORBITER = `// orbiter: holds a circular orbit around the most massive planet, dodges bullets and never shoots.
function steer(obs, target) {
  const err = obs.lib.wrapAngle(target - obs.self.angle);
  return { err, turn: Math.max(-1, Math.min(1, err * 2.5 - obs.self.angVel * 0.15)) };
}

export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  if (obs.planets.length === 0) return { thrust: 0, turn: 0, fire: false };
  let home = obs.planets[0];
  for (const p of obs.planets) if (p.mass > home.mass) home = p;
  const rel = L.sub(me.pos, home.pos);
  const r = L.len(rel);
  const radial = L.norm(rel);
  const tangent = { x: -radial.y, y: radial.x };
  const wantR = home.radius + 420;
  const vCirc = Math.sqrt((obs.G * home.mass) / Math.max(r, 1));
  // Keep the current direction of travel around the planet.
  const relVel = L.sub(me.vel, home.vel);
  const dirSign = L.dot(relVel, tangent) >= 0 ? 1 : -1;
  const want = L.add(L.add(home.vel, L.scale(tangent, vCirc * dirSign)), L.scale(radial, (wantR - r) * 0.25));
  // Safety: escape planets and the arena edge first, then dodge incoming bullets.
  const path = L.predict(me, 3);
  let dv = L.sub(want, me.vel);
  let threat = null;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const d = L.sub(b.pos, me.pos);
    const u = L.sub(b.vel, me.vel);
    const uu = L.dot(u, u);
    if (uu < 1) continue;
    const t = -L.dot(d, u) / uu;
    if (t <= 0 || t > 1.2) continue;
    const miss = L.add(d, L.scale(u, t));
    if (L.len(miss) < 45 && (!threat || t < threat.t)) threat = { t, miss, u };
  }
  if (path.hit) {
    const p = obs.planets[path.hit.planet];
    dv = L.scale(L.norm(L.sub(me.pos, p.pos)), 100);
  } else if (L.len(me.pos) > obs.arena.radius * 0.9) {
    dv = L.scale(L.norm(me.pos), -100);
  } else if (threat) {
    // Move sideways, away from the side the bullet will pass on.
    const side = L.norm({ x: -threat.u.y, y: threat.u.x });
    const sign = L.dot(side, threat.miss) > 0 ? -1 : 1;
    dv = L.scale(side, 100 * sign);
  }
  const mag = L.len(dv);
  if (mag < 4) return { thrust: 0, turn: steer(obs, me.angle).turn, fire: false };
  const s = steer(obs, Math.atan2(dv.y, dv.x));
  const thrust = Math.abs(s.err) < (threat ? 0.9 : 0.35) ? Math.min(1, mag / 40) : 0;
  return { thrust, turn: s.turn, fire: false };
}
`;

const TURRET = `// turret: never thrusts; turns toward the nearest enemy with a straight-line lead and fires when aligned.
export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  let best = null;
  let bestD = Infinity;
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    const d = L.len(L.sub(e.pos, me.pos));
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return { thrust: 0, turn: 0, fire: false };
  const lead = L.leadTarget(me, best, obs.rules.weapon.bulletSpeed);
  const aim = lead ? lead.angle : L.angleTo(me.pos, best.pos);
  const err = L.wrapAngle(aim - me.angle);
  const turn = Math.max(-1, Math.min(1, err * 3 - me.angVel * 0.15));
  const fire = Math.abs(err) < 0.06 && bestD < 1500 && !me.overheated;
  return { thrust: 0, turn, fire };
}
`;

const HUNTER = `// hunter: avoids planets and the arena edge, keeps a stable orbit, and shoots with a gravity-corrected lead.
function steer(L, me, target, gain) {
  const err = L.wrapAngle(target - me.angle);
  return { err, turn: Math.max(-1, Math.min(1, err * gain - me.angVel * 0.15)) };
}

function nearestEnemy(obs) {
  let best = null;
  let bestD = Infinity;
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    const d = obs.lib.len(obs.lib.sub(e.pos, obs.self.pos));
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? { e: best, d: bestD } : null;
}

// Gravity-aware aim: straight-line lead, then one correction using predicted enemy and bullet paths.
function aimAt(obs, target) {
  const L = obs.lib;
  const me = obs.self;
  const speed = obs.rules.weapon.bulletSpeed;
  const lead = L.leadTarget(me, target, speed);
  if (!lead || lead.time > 2.5) return null;
  let angle = lead.angle;
  const t = lead.time;
  const enemyPath = L.predict(target, t, { step: 1 / 30 });
  const enemyAt = enemyPath.points.length ? enemyPath.points[enemyPath.points.length - 1].pos : lead.point;
  angle = L.angleTo(me.pos, L.sub(enemyAt, L.scale(me.vel, t)));
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const bullet = { pos: L.add(me.pos, L.scale(dir, 15)), vel: L.add(me.vel, L.scale(dir, speed)) };
  const bPath = L.predict(bullet, t, { step: 1 / 30, radius: 0 });
  if (bPath.hit || !bPath.points.length) return { angle, time: t, blocked: !!bPath.hit };
  const miss = L.sub(enemyAt, bPath.points[bPath.points.length - 1].pos);
  const fixed = L.add(L.sub(enemyAt, L.scale(me.vel, t)), miss);
  return { angle: L.angleTo(me.pos, fixed), time: t, blocked: false };
}

export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;

  // 1) Survival: predicted planet contact or leaving the arena.
  const path = L.predict(me, 4);
  let escape = null;
  if (path.hit && path.hit.t < 4) {
    const p = obs.planets[path.hit.planet];
    const away = L.norm(L.sub(me.pos, p.pos));
    const side = L.norm(L.sub(me.vel, p.vel));
    escape = L.norm(L.add(L.scale(away, 1.2), side));
  } else if (L.len(me.pos) > obs.arena.radius * 0.88 || path.leavesArena) {
    escape = L.scale(L.norm(me.pos), -1);
  }
  if (escape) {
    const s = steer(L, me, Math.atan2(escape.y, escape.x), 3);
    return { thrust: Math.abs(s.err) < 0.6 ? 1 : 0, turn: s.turn, fire: false };
  }

  // 2) Attack when there is a shot.
  const target = nearestEnemy(obs);
  if (target && target.d < 1600) {
    const aim = aimAt(obs, target.e);
    if (aim && !aim.blocked) {
      const s = steer(L, me, aim.angle, 3);
      const fire = Math.abs(s.err) < 0.05 && !me.overheated && (me.heat < 80 || target.d < 500);
      return { thrust: 0, turn: s.turn, fire };
    }
  }

  // 3) Otherwise drift toward a safe orbit around the heaviest planet.
  if (!obs.planets.length) return { thrust: 0, turn: 0, fire: false };
  let home = obs.planets[0];
  for (const p of obs.planets) if (p.mass > home.mass) home = p;
  const rel = L.sub(me.pos, home.pos);
  const r = L.len(rel);
  const radial = L.norm(rel);
  const tangent = { x: -radial.y, y: radial.x };
  const relVel = L.sub(me.vel, home.vel);
  const dirSign = L.dot(relVel, tangent) >= 0 ? 1 : -1;
  const wantR = home.radius + 350;
  const vCirc = Math.sqrt((obs.G * home.mass) / Math.max(r, 1));
  const want = L.add(L.add(home.vel, L.scale(tangent, vCirc * dirSign)), L.scale(radial, (wantR - r) * 0.2));
  const dv = L.sub(want, me.vel);
  const mag = L.len(dv);
  if (mag < 8 || me.fuel < 10) {
    const face = target ? L.angleTo(me.pos, target.e.pos) : me.angle;
    return { thrust: 0, turn: steer(L, me, face, 3).turn, fire: false };
  }
  const s = steer(L, me, Math.atan2(dv.y, dv.x), 3);
  return { thrust: Math.abs(s.err) < 0.3 ? Math.min(1, mag / 40) : 0, turn: s.turn, fire: false };
}
`;

interface RefStrategyV1 {
  id: string;
  name: string;
  code: string;
}

export const REFERENCE_STRATEGIES_V1: RefStrategyV1[] = [
  { id: 'ref:idle', name: 'idle', code: IDLE },
  { id: 'ref:orbiter', name: 'orbiter', code: ORBITER },
  { id: 'ref:turret', name: 'turret', code: TURRET },
  { id: 'ref:hunter', name: 'hunter', code: HUNTER },
];
