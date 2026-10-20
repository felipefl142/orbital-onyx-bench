// ORBITAL ONYX controller: gravity-aware evasion + lead-aim combat.

const PI = Math.PI;
const TAU = 2 * Math.PI;

function wrap(a) {
  let x = (a + PI) % TAU;
  if (x < 0) x += TAU;
  return x - PI;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// Turn the nose toward a desired world angle.
function steerTo(me, desired) {
  const err = wrap(desired - me.angle);
  return { err, turn: clamp(err * 4 - me.angVel * 0.4, -1, 1) };
}

// Distance from a point to the nearest planet surface, minus ship radius.
function clearanceAt(x, y, planets) {
  let c = 1e9;
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const d = Math.hypot(x - p.pos.x, y - p.pos.y) - p.radius - 12;
    if (d < c) c = d;
  }
  return c;
}

// Score a free-fall trajectory from pos with velocity vel over ~2.5 s.
// Higher is better. Hits and arena exits are strongly negative,
// later hits are less bad than early ones.
function pathScore(L, pos, vel, planets) {
  const r = L.predict(
    { pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y } },
    2.5,
    { step: 0.05 }
  );
  if (r.leavesArena) return -1e6;
  if (r.hit) return -1e5 + r.hit.t;
  let minC = 1e9;
  const pts = r.points;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i].pos;
    if (Math.hypot(p.x, p.y) > 1960) return -5e5;
    const c = clearanceAt(p.x, p.y, planets);
    if (c < minC) minC = c;
  }
  return minC;
}

function decide(obs) {
  const L = obs.lib;
  const me = obs.self;
  const planets = obs.planets || [];
  const idle = { thrust: 0, turn: 0, fire: false };
  if (!me || !me.pos || !me.vel) return idle;

  const r = Math.hypot(me.pos.x, me.pos.y);

  // ---------- 1. Safety: avoid planets and the arena edge ----------
  const base = pathScore(L, me.pos, me.vel, planets);
  if (base < 90) {
    const accel = 60 / (1 + (0.5 * me.fuel) / 100);
    const burn = 0.5;
    let best = base;
    let bestA = null;
    for (let k = 0; k < 16; k++) {
      const a = (k * TAU) / 16;
      const v = {
        x: me.vel.x + Math.cos(a) * accel * burn,
        y: me.vel.y + Math.sin(a) * accel * burn,
      };
      const s = pathScore(L, me.pos, v, planets);
      if (s > best) {
        best = s;
        bestA = a;
      }
    }
    if (bestA !== null && me.fuel > 0.5) {
      const s = steerTo(me, bestA);
      return {
        thrust: Math.abs(s.err) < 0.4 ? 1 : 0,
        turn: s.turn,
        fire: false,
      };
    }
  }

  // Soft arena limit: head back toward the centre.
  if (r > 1500) {
    const toCenter = Math.atan2(-me.pos.y, -me.pos.x);
    const s = steerTo(me, toCenter);
    return {
      thrust: Math.abs(s.err) < 0.4 && me.fuel > 0.5 ? 1 : 0,
      turn: s.turn,
      fire: false,
    };
  }

  // ---------- 2. Target selection ----------
  let target = null;
  let bestD = Infinity;
  for (const e of obs.enemies || []) {
    if (!e.alive || e.hp <= 0) continue;
    const d = Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y);
    if (d < bestD) {
      bestD = d;
      target = e;
    }
  }

  if (!target) {
    // Nothing to fight: drift, keep turning slowly so the nose is not stale.
    return { thrust: 0, turn: 0, fire: false };
  }

  // ---------- 3. Combat ----------
  const rel = { x: target.pos.x - me.pos.x, y: target.pos.y - me.pos.y };
  const d = bestD;
  const lead = L.leadTarget(me, target, obs.rules.weapon.bulletSpeed);
  const aim = lead ? lead.angle : Math.atan2(rel.y, rel.x);
  const speed = Math.hypot(me.vel.x, me.vel.y);

  let mode;
  let desired;
  if (d < 260) {
    // Too close: back away while keeping the nose pointed away.
    mode = "back";
    desired = Math.atan2(-rel.y, -rel.x);
  } else if (speed > 480 && d < 700) {
    // Moving too fast in the fight zone: brake against our velocity.
    mode = "brake";
    desired = Math.atan2(-me.vel.y, -me.vel.x);
  } else {
    mode = "aim";
    desired = aim;
  }

  const s = steerTo(me, desired);
  let thrust = 0;
  if (me.fuel > 0.5) {
    if (mode === "aim" && d > 500 && Math.abs(s.err) < 0.3) thrust = 1;
    if (mode === "back" && Math.abs(s.err) < 0.4) thrust = 1;
    if (mode === "brake" && Math.abs(s.err) < 0.3) thrust = 1;
  }

  const aimErr = wrap(aim - me.angle);
  const fire =
    mode === "aim" &&
    Math.abs(aimErr) < 0.05 &&
    d < 1100 &&
    me.cooldown <= 0 &&
    !me.overheated &&
    me.ammo > 0 &&
    me.heat < 90;

  return { thrust, turn: s.turn, fire };
}

export default function control(obs, mem) {
  try {
    const out = decide(obs);
    return {
      thrust: clamp(Number(out.thrust) || 0, 0, 1),
      turn: clamp(Number(out.turn) || 0, -1, 1),
      fire: !!out.fire,
    };
  } catch (e) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
