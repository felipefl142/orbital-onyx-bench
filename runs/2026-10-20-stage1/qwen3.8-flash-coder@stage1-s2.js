// ORBITAL ONYX improved control:
// - survival first: planets and arena edge
// - safer bullet dodging
// - better gravity-corrected aim with candidate angles
// - target hysteresis and heat/fuel management
// - victory-hold survival when no enemies remain

function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

function safeFinite(x) {
  return Number.isFinite(x) ? x : 0;
}

function steer(L, me, target, gain) {
  const err = L.wrapAngle(safeFinite(target) - me.angle);
  const turn = clamp(err * gain - me.angVel * 0.15, -1, 1);
  return { err, turn };
}

function chooseHome(obs, L, me) {
  let best = null;
  let bestScore = -1;

  for (const p of obs.planets) {
    if (!p || !Number.isFinite(p.mass) || p.mass <= 0) continue;

    const r = L.len(L.sub(me.pos, p.pos));
    if (r < p.radius + 100) continue;

    // Prefer heavy planets, but not too close.
    const score = p.mass / Math.max(1, r / 1000);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

function danger(obs, L, me, horizon) {
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

    // Very close impact: burn outward. Later impact: raise periapsis.
    const radialWeight = path.hit.t < 1.2 ? 1.35 : 0.85;
    const dir = L.norm(L.add(L.scale(tang, sign), L.scale(radial, radialWeight)));

    return { dir, t: path.hit.t, planet: p };
  }

  const r = L.len(me.pos);
  const outward = L.dot(me.vel, L.norm(me.pos));

  if (path.leavesArena || (r > obs.arena.radius * 0.82 && outward > -20)) {
    const inward = L.norm(L.scale(L.norm(me.pos), -1));
    return { dir: inward, t: 1.5, edge: true };
  }

  return null;
}

function incoming(obs, L, me, window) {
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

function dodgeDir(obs, L, me, threat) {
  const side = L.norm({ x: -threat.u.y, y: threat.u.x });

  // Move away from the side the bullet will pass on.
  const sideSign = L.dot(side, threat.miss) > 0 ? -1 : 1;
  let dir = L.scale(side, sideSign);

  // Bias away from nearest planet.
  let nearest = null;
  let nearestDist = Infinity;

  for (const p of obs.planets) {
    if (!p) continue;
    const d = L.len(L.sub(me.pos, p.pos));
    if (d < nearestDist) {
      nearestDist = d;
      nearest = p;
    }
  }

  if (nearest) {
    const radial = L.norm(L.sub(me.pos, nearest.pos));
    dir = L.norm(L.add(dir, L.scale(radial, 0.45)));
  }

  // Bias inward if near arena edge.
  const r = L.len(me.pos);
  if (r > obs.arena.radius * 0.82) {
    dir = L.norm(L.add(dir, L.scale(L.norm(me.pos), -0.45)));
  }

  if (L.len(dir) < 0.01) {
    dir = L.norm(L.scale(L.norm(me.pos), -1));
  }

  return dir;
}

function gravityAim(obs, L, me, target, maxTime) {
  const R = obs.rules.ship.radius;
  const W = obs.rules.weapon;

  const lead = L.leadTarget(me, target, W.bulletSpeed);
  if (!lead || !Number.isFinite(lead.angle) || !Number.isFinite(lead.time)) return null;
  if (lead.time > maxTime) return null;

  const horizon = Math.min(W.bulletLife, lead.time + 0.4);
  const step = 1 / 30;

  const ePred = L.predict(target, horizon, { step, radius: R });
  const ePath = ePred.points;
  if (!ePath.length) return null;

  const targetHit = ePred.hit ? ePred.hit.t : null;

  const evaluate = (angle) => {
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };

    const bullet = {
      pos: L.add(me.pos, L.scale(dir, R + 3)),
      vel: L.add(me.vel, L.scale(dir, W.bulletSpeed))
    };

    const bp = L.predict(bullet, horizon, { step, radius: 1 });

    if (!bp.points.length) {
      return {
        angle,
        miss: Infinity,
        blocked: true,
        corr: 0,
        t: lead.time,
        score: Infinity
      };
    }

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
      return {
        angle,
        miss: Infinity,
        blocked: true,
        corr: 0,
        t: lead.time,
        score: Infinity
      };
    }

    const off = L.sub(ePath[at].pos, bp.points[at].pos);
    const range = Math.max(1, L.len(L.sub(ePath[at].pos, me.pos)));
    const blocked = !!bp.hit && bp.hit.t <= bp.points[at].t;

    const corr = L.cross(dir, off) / range;
    const score = best + (blocked ? 1000 : 0);

    return {
      angle,
      miss: best,
      blocked,
      corr,
      t: bp.points[at].t,
      score
    };
  };

  let best = evaluate(lead.angle);

  // Try a few nearby angles; gravity can make the straight-line lead slightly wrong.
  const offsets = [-0.12, -0.06, -0.03, 0.03, 0.06, 0.12];
  for (const off of offsets) {
    const ev = evaluate(lead.angle + off);
    if (ev && ev.score < best.score) best = ev;
  }

  // Refine using the observed miss.
  for (let k = 0; k < 3 && best.miss > R * 0.5; k++) {
    const next = evaluate(best.angle + best.corr);
    if (!next || next.score >= best.score) break;
    best = next;
  }

  // Small penalty if the target itself is predicted to hit a planet soon.
  if (targetHit && targetHit < 2.0) best.score += 20;

  return best;
}

function chooseTarget(obs, L, me, mem, alive) {
  const R = obs.rules.ship.radius;
  const W = obs.rules.weapon;

  // Clear dead target.
  let currentAlive = false;
  for (const e of alive) {
    if (e && e.id === mem.targetId) {
      currentAlive = true;
      break;
    }
  }
  if (!currentAlive) mem.targetId = null;

  const maxRange = W.bulletLife * W.bulletSpeed;
  const candidates = [];

  for (const e of alive) {
    if (!e || !e.alive) continue;

    const dist = L.len(L.sub(e.pos, me.pos));

    let score = dist * 0.01 + e.hp * 0.05;

    if (e.hp < 30) score -= 10;

    // Prefer enemies that are facing us: they are more dangerous and often easier to hit.
    const toMe = L.angleTo(e.pos, me.pos);
    const facing = Math.abs(L.wrapAngle(toMe - e.angle));
    if (facing < 0.35) score -= 10;

    // Hysteresis.
    if (mem.targetId === e.id) score -= 20;

    candidates.push({ e, dist, score });
  }

  if (!candidates.length) return null;

  // Pick top simple candidates, plus current target for hysteresis.
  const top = [];

  for (const c of candidates) {
    if (top.length < 3) {
      top.push(c);
    } else {
      let worst = 0;
      for (let i = 1; i < top.length; i++) {
        if (top[i].score > top[worst].score) worst = i;
      }
      if (c.score < top[worst].score) top[worst] = c;
    }
  }

  if (mem.targetId) {
    let found = false;
    for (const c of top) {
      if (c.e.id === mem.targetId) {
        found = true;
        break;
      }
    }

    if (!found) {
      for (const c of candidates) {
        if (c.e.id === mem.targetId) {
          top.push(c);
          break;
        }
      }
    }
  }

  let best = null;
  let bestScore = Infinity;

  for (const c of top) {
    const kill = c.e.hp <= W.damage;

    // Do not spend aim budget when heat is already bad, unless this shot can kill.
    const canAim =
      (!mem.heatStop && me.heat < 80) ||
      kill ||
      me.heat < 50;

    const aim = canAim ? gravityAim(obs, L, me, c.e, 3.0) : null;

    let score = c.score;

    if (aim) {
      score += aim.score;
      if (aim.score < R) score -= 10;
    } else {
      score += 1000;
    }

    if (score < bestScore) {
      bestScore = score;
      best = { e: c.e, aim, dist: c.dist, score };
    }
  }

  if (best) mem.targetId = best.e.id;

  return best;
}

function orbitBurn(obs, L, me, home, wantR, gain) {
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

function canFire(obs, mem, target, aligned) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const W = obs.rules.weapon;

  if (!target || !target.aim || target.aim.blocked || target.aim.miss > R * 0.75) return false;
  if (!aligned) return false;

  if (me.overheated || me.ammo <= 0 || me.cooldown > 0) return false;

  const kill = target.e.hp <= W.damage;

  if (!kill) {
    if (mem.heatStop) {
      if (me.heat < 50) {
        mem.heatStop = false;
      } else {
        return false;
      }
    }

    if (me.heat >= 80) {
      mem.heatStop = true;
      return false;
    }

    if (me.heat + W.heatPerShot >= W.overheatAt) {
      mem.heatStop = true;
      return false;
    }

    if (me.ammo < 10) return false;
  } else {
    // A killing shot can be worth taking even if it causes an overheat lock.
    if (me.heat + W.heatPerShot >= W.overheatAt) {
      mem.heatStop = true;
    }
  }

  return true;
}

export default function control(obs, mem) {
  if (!mem || typeof mem !== "object") mem = {};

  if (typeof mem.heatStop !== "boolean") mem.heatStop = false;
  if (!mem.targetId) mem.targetId = null;
  if (!Number.isFinite(mem.lastAim)) mem.lastAim = obs.self.angle;

  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  const alive = [];
  for (const e of obs.enemies) {
    if (e && e.alive) alive.push(e);
  }

  const d = danger(obs, L, me, 4.5);
  const threat = incoming(obs, L, me, 1.2);

  // Victory hold / no enemies: survive, do not fire.
  if (!alive.length) {
    if (d && me.fuel > 0) {
      const s = steer(L, me, Math.atan2(d.dir.y, d.dir.x), 3);
      const thrust = Math.abs(s.err) < 0.75 ? clamp(L.len(d.dir) / 25, 0, 1) : 0;
      return {
        thrust: clamp(thrust, 0, 1),
        turn: clamp(s.turn, -1, 1),
        fire: false
      };
    }

    const home = chooseHome(obs, L, me);
    if (home && me.fuel > 10) {
      const dv = orbitBurn(obs, L, me, home, Math.max(home.radius + 180, 500), 0.08);
      if (L.len(dv) > 20) {
        const s = steer(L, me, Math.atan2(dv.y, dv.x), 3);
        const thrust = Math.abs(s.err) < 0.35 ? clamp(L.len(dv) / 60, 0, 1) : 0;
        return {
          thrust: clamp(thrust, 0, 1),
          turn: clamp(s.turn, -1, 1),
          fire: false
        };
      }
    }

    return { thrust: 0, turn: 0, fire: false };
  }

  const target = chooseTarget(obs, L, me, mem, alive);

  let turnAngle = me.angle;
  let thrustVec = { x: 0, y: 0 };
  let priority = 0;
  let fire = false;

  // 1. Immediate survival.
  if (d && d.t < 3.0 && me.fuel > 0) {
    turnAngle = Math.atan2(d.dir.y, d.dir.x);
    thrustVec = L.scale(d.dir, 100);
    priority = 100;
  }

  // 2. Bullet dodge.
  if (!priority && threat && threat.t < 0.8 && me.fuel > 0) {
    const dir = dodgeDir(obs, L, me, threat);
    turnAngle = Math.atan2(dir.y, dir.x);
    thrustVec = L.scale(dir, 80);
    priority = 80;
  }

  // 3. Combat aim.
  if (!priority && target) {
    if (target.aim) {
      turnAngle = target.aim.angle;

      // Close distance only when useful and fuel is available.
      if (me.fuel > 20 && target.dist > 1200) {
        thrustVec = L.scale({ x: Math.cos(turnAngle), y: Math.sin(turnAngle) }, 40);
      } else if (me.fuel > 10 && target.dist > 800) {
        thrustVec = L.scale({ x: Math.cos(turnAngle), y: Math.sin(turnAngle) }, 20);
      }

      priority = 50;
    } else {
      const dir = L.norm(L.sub(target.e.pos, me.pos));
      turnAngle = Math.atan2(dir.y, dir.x);

      if (me.fuel > 20 && target.dist > 1200) {
        thrustVec = L.scale(dir, 40);
      }

      priority = 40;
    }
  }

  // 4. Safe orbit fallback.
  if (!priority) {
    const home = chooseHome(obs, L, me);
    if (home && me.fuel > 10) {
      const dv = orbitBurn(obs, L, me, home, Math.max(home.radius + 180, 500), 0.08);
      if (L.len(dv) > 20) {
        turnAngle = Math.atan2(dv.y, dv.x);
        thrustVec = dv;
        priority = 20;
      }
    }
  }

  const s = steer(L, me, turnAngle, 3);

  let thrust = 0;
  if (me.fuel > 0) {
    const mag = L.len(thrustVec);

    if (mag > 1) {
      const aligned = Math.abs(s.err) < 0.35;
      const emergencyAligned = Math.abs(s.err) < 0.75;

      if (priority >= 80 && emergencyAligned) {
        thrust = clamp(mag / 25, 0, 1);
      } else if (priority >= 50 && aligned) {
        thrust = clamp(mag / 30, 0, 1);
      } else if (priority >= 20 && aligned) {
        thrust = clamp(mag / 60, 0, 1);
      }
    }
  }

  // Fire only when the gravity-corrected aim is good and the nose is aligned.
  if (target && target.aim && priority < 80) {
    const aimErr = Math.abs(L.wrapAngle(target.aim.angle - me.angle));
    const range = Math.max(1, target.dist);

    const alignedForFire =
      aimErr < Math.atan2(R * 1.0, range) + 0.02 &&
      Math.abs(me.angVel) < 0.5;

    fire = canFire(obs, mem, target, alignedForFire);
  }

  return {
    thrust: clamp(thrust, 0, 1),
    turn: clamp(s.turn, -1, 1),
    fire
  };
}
