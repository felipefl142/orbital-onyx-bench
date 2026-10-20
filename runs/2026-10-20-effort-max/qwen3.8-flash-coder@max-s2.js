// ORBITAL ONYX control:
// - survival first: avoid planets and arena edge
// - dodge incoming bullets when safe
// - gravity-corrected shooting against the best target
// - conservative heat/fuel management

function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

function safeFinite(x) {
  return Number.isFinite(x) ? x : 0;
}

function steer(L, me, target, gain) {
  const err = L.wrapAngle(target - me.angle);
  const turn = clamp(err * gain - me.angVel * 0.15, -1, 1);
  return { err, turn };
}

function heaviestSafePlanet(obs) {
  const L = obs.lib;
  let best = null;
  let bestScore = -1;

  for (const p of obs.planets) {
    if (!p || !Number.isFinite(p.mass) || p.mass <= 0) continue;
    const r = L.len(L.sub(obs.self.pos, p.pos));
    if (r < p.radius + 80) continue;

    // Prefer heavy planets, but not too close.
    const score = p.mass / Math.max(1, r / 1000);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

function danger(obs, horizon) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  const path = L.predict(me, horizon, {
    step: 1 / 20,
    radius: R + 25
  });

  if (path.hit) {
    const p = obs.planets[path.hit.planet];
    if (!p) return null;

    const rel = L.sub(me.pos, p.pos);
    const r = Math.max(L.len(rel), 1);
    const radial = L.norm(rel);
    const tang = { x: -radial.y, y: radial.x };

    const relVel = L.sub(me.vel, p.vel);
    const sign = L.dot(relVel, tang) >= 0 ? 1 : -1;

    // If impact is very close, burn more radially outward.
    // If impact is later, raise periapsis by adding tangential velocity.
    const radialWeight = path.hit.t < 1.2 ? 1.35 : 0.85;
    const dir = L.norm(L.add(L.scale(tang, sign), L.scale(radial, radialWeight)));

    return { dir, t: path.hit.t, planet: p };
  }

  const r = L.len(me.pos);
  const outward = L.dot(me.vel, L.norm(me.pos));

  if (path.leavesArena || (r > obs.arena.radius * 0.86 && outward > -20)) {
    return { dir: L.scale(L.norm(me.pos), -1), t: 3, edge: true };
  }

  return null;
}

function incoming(obs, window) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  let threat = null;

  for (const b of obs.bullets) {
    if (!b || b.owner === me.id) continue;

    const d = L.sub(b.pos, me.pos);
    const u = L.sub(b.vel, me.vel);
    const uu = L.dot(u, u);

    if (uu < 1) continue;

    const t = -L.dot(d, u) / uu;
    if (t <= 0 || t > window || t > b.ttl) continue;

    const miss = L.add(d, L.scale(u, t));
    const missLen = L.len(miss);

    if (missLen < R * 3 && (!threat || t < threat.t)) {
      threat = { t, miss, u, bullet: b };
    }
  }

  return threat;
}

function dodgeDir(L, threat, me) {
  const side = L.norm({ x: -threat.u.y, y: -threat.u.x * 0 + threat.u.x });
  // Correct sign: point away from the side the bullet will pass on.
  const sideSign = L.dot(side, threat.miss) > 0 ? -1 : 1;
  let dir = L.scale(side, sideSign);

  // Add safety bias: away from nearest planet, inward if near edge.
  let nearest = null;
  let nearestDist = Infinity;

  for (const p of obs.planets) {
    const d = L.len(L.sub(me.pos, p.pos));
    if (d < nearestDist) {
      nearestDist = d;
      nearest = p;
    }
  }

  if (nearest) {
    const radial = L.norm(L.sub(me.pos, nearest.pos));
    dir = L.norm(L.add(dir, L.scale(radial, 0.35)));
  }

  const r = L.len(me.pos);
  if (r > obs.arena.radius * 0.82) {
    dir = L.norm(L.add(dir, L.scale(L.norm(me.pos), -0.35)));
  }

  return dir;
}

function gravityAim(obs, target, maxTime) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const W = obs.rules.weapon;

  const lead = L.leadTarget(me, target, W.bulletSpeed);
  if (!lead || lead.time > maxTime) return null;

  const horizon = Math.min(W.bulletLife, lead.time + 0.4);
  const step = 1 / 30;

  const ePath = L.predict(target, horizon, { step, radius: R }).points;
  if (!ePath.length) return null;

  const evaluate = (angle) => {
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };

    const bullet = {
      pos: L.add(me.pos, L.scale(dir, R + 3)),
      vel: L.add(me.vel, L.scale(dir, W.bulletSpeed))
    };

    const bp = L.predict(bullet, horizon, { step, radius: 1 });

    let best = Infinity;
    let at = -1;

    const n = Math.min(bp.points.length, ePath.length);
    for (let i = 0; i < n; i++) {
      const dd = L.len(L.sub(bp.points[i].pos, ePath[i].pos));
      if (dd < best) {
        best = dd;
        at = i;
      }
    }

    if (at < 0) {
      return { angle, miss: Infinity, blocked: true, corr: 0, t: lead.time };
    }

    const off = L.sub(ePath[at].pos, bp.points[at].pos);
    const range = Math.max(1, L.len(L.sub(ePath[at].pos, me.pos)));
    const blocked = !!bp.hit && bp.hit.t <= bp.points[at].t;

    return {
      angle,
      miss: best,
      blocked,
      corr: L.cross(dir, off) / range,
      t: bp.points[at].t
    };
  };

  let ev = evaluate(lead.angle);

  for (let k = 0; k < 2 && ev.miss > R * 0.5; k++) {
    const next = evaluate(ev.angle + ev.corr);
    if (next.miss >= ev.miss) break;
    ev = next;
  }

  return ev;
}

function chooseTarget(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  let best = null;
  let bestScore = Infinity;

  let nearest = null;
  let nearestDist = Infinity;

  for (const e of obs.enemies) {
    if (!e || !e.alive) continue;

    const dist = L.len(L.sub(e.pos, me.pos));

    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = e;
    }

    if (dist > 1800) continue;

    const aim = gravityAim(obs, e, 3.0);
    if (!aim) continue;

    let score = aim.miss;

    if (aim.blocked) score += 1000;

    // Prefer closer targets.
    score += dist * 0.01;

    // Prefer low HP targets.
    if (e.hp < 30) score -= 10;

    // Prefer enemies that are facing us, because they are more dangerous.
    const toMe = L.angleTo(e.pos, me.pos);
    const facing = Math.abs(L.wrapAngle(toMe - e.angle));
    if (facing < 0.35) score += 15;

    // Hysteresis: avoid target switching unless clearly better.
    if (mem.targetId === e.id) score -= 20;

    if (score < bestScore) {
      bestScore = score;
      best = { e, aim, dist, score };
    }
  }

  if (!best && nearest) {
    best = { e: nearest, aim: null, dist: nearestDist, score: 0 };
  }

  if (best) mem.targetId = best.e.id;

  return best;
}

function orbitBurn(obs, home, wantR, gain) {
  const L = obs.lib;
  const me = obs.self;

  const rel = L.sub(me.pos, home.pos);
  const r = Math.max(L.len(rel), 1);
  const radial = L.norm(rel);
  const tangent = { x: -radial.y, y: radial.x };

  const relVel = L.sub(me.vel, home.vel);
  const dirSign = L.dot(relVel, tangent) >= 0 ? 1 : -1;

  const vCirc = Math.sqrt((obs.G * home.mass) / r);

  const want = L.add(
    L.add(home.vel, L.scale(tangent, vCirc * dirSign)),
    L.scale(radial, (wantR - r) * gain)
  );

  return L.sub(want, me.vel);
}

function canFire(obs, mem, aim, aligned) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const W = obs.rules.weapon;

  if (!aim || aim.blocked || aim.miss > R * 0.75) return false;
  if (!aligned) return false;

  if (me.overheated || me.ammo <= 0 || me.cooldown > 0) return false;

  if (!mem.heatStop) {
    if (me.heat >= 75) {
      mem.heatStop = true;
      return false;
    }
  } else {
    if (me.heat < 50) {
      mem.heatStop = false;
    } else {
      return false;
    }
  }

  // Do not fire if this shot would reach the overheat threshold.
  if (me.heat + W.heatPerShot >= W.overheatAt) {
    mem.heatStop = true;
    return false;
  }

  return true;
}

export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  if (!mem) mem = {};

  if (!Number.isFinite(mem.heatStop)) mem.heatStop = false;
  if (!mem.targetId) mem.targetId = null;

  const d = danger(obs, 4.5);
  const threat = incoming(obs, 1.2);
  const target = chooseTarget(obs, mem);

  let desired = null;
  let priority = 0;
  let thrustScale = 30;

  // 1. Immediate survival.
  if (d && d.t < 2.5 && me.fuel > 0) {
    desired = d.dir;
    priority = 100;
    thrustScale = 25;
  }

  // 2. Bullet dodge, if not already in survival mode.
  if (!desired && threat && threat.t < 0.8 && me.fuel > 0) {
    desired = dodgeDir(L, threat, me);
    priority = 80;
    thrustScale = 30;
  }

  // 3. Combat aim.
  if (!desired && target) {
    if (target.aim) {
      desired = { x: Math.cos(target.aim.angle), y: Math.sin(target.aim.angle) };
      priority = 50;
    } else {
      desired = L.norm(L.sub(target.e.pos, me.pos));
      priority = 40;
    }
  }

  // 4. If no target, keep a safe orbit around a heavy planet.
  if (!desired) {
    const home = heaviestSafePlanet(obs);
    if (home && me.fuel > 12) {
      const dv = orbitBurn(obs, home, Math.max(home.radius + 180, 500), 0.08);
      if (L.len(dv) > 20) {
        desired = L.norm(dv);
        priority = 20;
        thrustScale = 60;
      }
    }
  }

  let thrust = 0;
  let turn = 0;
  let fire = false;

  if (desired) {
    const targetAngle = Math.atan2(desired.y, desired.x);
    const s = steer(L, me, targetAngle, 3);
    turn = s.turn;

    if (me.fuel > 0) {
      const aligned = Math.abs(s.err) < 0.35;
      const emergencyAligned = Math.abs(s.err) < 0.75;

      if (priority >= 80 && emergencyAligned) {
        thrust = 1;
      } else if (priority >= 50 && aligned) {
        // Only thrust toward the target when far enough, otherwise conserve fuel.
        if (target && target.dist > 1000 && me.fuel > 25) {
          thrust = 0.35;
        }
      } else if (priority >= 20 && aligned) {
        thrust = 0.25;
      }
    }

    if (target && target.aim) {
      const aimAngle = target.aim.angle;
      const aimErr = Math.abs(L.wrapAngle(aimAngle - me.angle));
      const alignedForFire = aimErr < Math.atan2(R * 0.8, target.dist) + 0.01;

      fire = canFire(obs, mem, target.aim, alignedForFire);
    }
  }

  return {
    thrust: clamp(thrust, 0, 1),
    turn: clamp(turn, -1, 1),
    fire
  };
}
