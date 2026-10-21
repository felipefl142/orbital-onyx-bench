// ORBITAL ONYX control:
// - survival first: avoid planets and arena edge
// - predicted bullet dodge
// - better gravity-corrected aim with small angular search
// - target hysteresis and heat management
// - conservative fuel use, but closes distance when useful

function clamp(x, a, b) {
  x = Number.isFinite(x) ? x : 0;
  return x < a ? a : x > b ? b : x;
}

function safeFinite(x) {
  return Number.isFinite(x) ? x : 0;
}

function steer(L, me, targetAngle, gain) {
  const err = L.wrapAngle(safeFinite(targetAngle) - me.angle);
  const turn = clamp(err * gain - me.angVel * 0.2, -1, 1);
  return { err, turn };
}

function heaviestSafePlanet(obs) {
  const L = obs.lib;
  const me = obs.self;

  let best = null;
  let bestScore = -1;

  for (const p of obs.planets) {
    if (!p || !Number.isFinite(p.mass) || p.mass <= 0) continue;

    const r = L.len(L.sub(me.pos, p.pos));
    if (r < p.radius + 80) continue;

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
    radius: R + 30
  });

  if (!path) return null;

  if (path.hit) {
    const p = obs.planets[path.hit.planet];
    if (!p) return null;

    const rel = L.sub(me.pos, p.pos);
    const r = Math.max(L.len(rel), 1);
    const radial = L.norm(rel);
    const tang = { x: -radial.y, y: radial.x };

    const relVel = L.sub(me.vel, p.vel);
    const sign = L.dot(relVel, tang) >= 0 ? 1 : -1;

    const radialWeight = path.hit.t < 1.2 ? 1.35 : 0.85;
    const dir = L.norm(L.add(L.scale(tang, sign), L.scale(radial, radialWeight)));

    return {
      dir,
      t: safeFinite(path.hit.t),
      planet: true,
      planetObj: p
    };
  }

  const r = L.len(me.pos);
  const outward = L.dot(me.vel, L.norm(me.pos));

  if (path.leavesArena || (r > obs.arena.radius * 0.82 && outward > -20)) {
    return {
      dir: L.scale(L.norm(me.pos), -1),
      t: path.leavesArena ? 2 : 3,
      edge: true
    };
  }

  return null;
}

function incoming(obs, window, mem) {
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
    const ttl = safeFinite(b.ttl);

    if (t <= 0 || t > window || t > ttl) continue;

    const miss = L.add(d, L.scale(u, t));
    const missLen = L.len(miss);

    if (missLen < R * 3 && (!threat || t < threat.t)) {
      threat = { t, miss, u, bullet: b };
    }
  }

  if (!threat) {
    if (mem) {
      mem.lastThreatOwner = null;
      mem.lastThreatT = null;
      mem.lastThreatMiss = null;
    }
    return null;
  }

  // Refine the nearest threat with gravity prediction.
  const horizon = Math.min(window, safeFinite(threat.bullet.ttl));
  if (horizon <= 0) {
    if (mem) {
      mem.lastThreatOwner = threat.bullet.owner;
      mem.lastThreatT = threat.t;
      mem.lastThreatMiss = L.len(threat.miss);
    }
    return threat;
  }

  const path = L.predict(threat.bullet, horizon, {
    step: 1 / 20,
    radius: 1
  });

  if (path && path.points && path.points.length) {
    if (path.hit) {
      const hitT = safeFinite(path.hit.t);
      if (hitT < threat.t) {
        if (mem) {
          mem.lastThreatOwner = null;
          mem.lastThreatT = null;
          mem.lastThreatMiss = null;
        }
        return null;
      }
    }

    let best = Infinity;
    let at = -1;

    for (let i = 0; i < path.points.length; i++) {
      const dd = L.len(L.sub(path.points[i].pos, me.pos));
      if (dd < best) {
        best = dd;
        at = i;
      }
    }

    if (at >= 0 && best < R * 3) {
      const p = path.points[at];
      threat = {
        t: safeFinite(p.t),
        miss: L.sub(p.pos, me.pos),
        u: L.sub(p.vel, me.vel),
        bullet: threat.bullet
      };
    }
  }

  if (mem) {
    mem.lastThreatOwner = threat.bullet.owner;
    mem.lastThreatT = threat.t;
    mem.lastThreatMiss = L.len(threat.miss);
  }

  return threat;
}

function dodgeDir(L, threat, me, obs) {
  const u = threat.u;
  const uu = L.dot(u, u);

  if (uu < 1) {
    const r = L.len(me.pos);
    if (r > obs.arena.radius * 0.82) {
      return L.norm(L.scale(L.norm(me.pos), -1));
    }
    return L.norm(me.vel);
  }

  const side = L.norm({ x: -u.y, y: u.x });
  const sign = L.dot(side, threat.miss) > 0 ? -1 : 1;
  let dir = L.scale(side, sign);

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

  if (L.len(dir) < 1e-6) {
    dir = L.norm(L.scale(L.norm(me.pos), -1));
  }

  return dir;
}

function gravityAim(obs, target, maxTime, mem) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const W = obs.rules.weapon;

  const speed = W.bulletSpeed;

  const lead = L.leadTarget(me, target, speed);
  const baseAngle = lead ? lead.angle : L.angleTo(me.pos, target.pos);
  const baseTime = lead ? lead.time : Math.max(0.1, L.len(L.sub(target.pos, me.pos)) / speed);

  if (!Number.isFinite(baseAngle) || baseTime > maxTime) return null;

  const horizon = Math.min(W.bulletLife, baseTime + 0.4, maxTime);
  const step = 1 / 30;

  const targetPath = L.predict(target, horizon, {
    step,
    radius: R
  });

  if (!targetPath || !targetPath.points || !targetPath.points.length) return null;

  const ePath = targetPath.points;
  const targetHit = targetPath.hit || null;
  const targetHitTime = targetHit ? safeFinite(targetHit.t) : null;

  const evaluate = (angle) => {
    angle = safeFinite(angle);
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };

    const bullet = {
      pos: L.add(me.pos, L.scale(dir, R + 3)),
      vel: L.add(me.vel, L.scale(dir, speed))
    };

    const bp = L.predict(bullet, horizon, {
      step,
      radius: 1
    });

    if (!bp || !bp.points || !bp.points.length) {
      return {
        angle,
        miss: Infinity,
        blocked: true,
        corr: 0,
        t: baseTime,
        targetHit,
        targetHitTime
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
        t: baseTime,
        targetHit,
        targetHitTime
      };
    }

    const off = L.sub(ePath[at].pos, bp.points[at].pos);
    const range = Math.max(1, L.len(L.sub(ePath[at].pos, me.pos)));
    const blocked = !!bp.hit && safeFinite(bp.hit.t) <= safeFinite(bp.points[at].t);

    return {
      angle,
      miss: best,
      blocked,
      corr: L.cross(dir, off) / range,
      t: safeFinite(bp.points[at].t),
      targetHit,
      targetHitTime
    };
  };

  let start = baseAngle;
  if (mem && mem.targetId === target.id && Number.isFinite(mem.lastAim)) {
    start = mem.lastAim;
  }

  let ev = evaluate(start);
  let bestEv = ev;

  const candidates = [
    start,
    baseAngle,
    start + ev.corr,
    start + 0.02,
    start - 0.02,
    start + 0.04,
    start - 0.04
  ];

  for (const a of candidates) {
    const e = evaluate(a);
    if (e.blocked) continue;
    if (e.miss < bestEv.miss) bestEv = e;
  }

  for (let k = 0; k < 3 && bestEv.miss > R * 0.5; k++) {
    const next = evaluate(bestEv.angle + bestEv.corr);
    if (next.blocked) break;
    if (next.miss >= bestEv.miss) break;
    bestEv = next;
  }

  if (mem && mem.targetId === target.id) {
    mem.lastAim = bestEv.angle;
    mem.lastMiss = bestEv.miss;
  }

  return bestEv;
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

    if (dist > 1800 && mem.targetId !== e.id) continue;

    const aim = gravityAim(obs, e, 3.0, mem);
    if (!aim) continue;

    if (aim.miss > R * 3) continue;

    let score = aim.miss;

    if (aim.blocked) score += 1000;

    if (aim.targetHit && aim.targetHitTime !== null && aim.t > aim.targetHitTime) {
      score += 100;
    }

    score += dist * 0.02;
    score += aim.t * 5;

    if (aim.miss < R * 0.5) score -= 15;
    else if (aim.miss < R * 0.75) score -= 8;

    if (e.hp < 30) score -= 15;
    if (e.hp < 15) score -= 25;

    if (mem.targetId === e.id) score -= 20;

    const toMe = L.angleTo(e.pos, me.pos);
    const facing = Math.abs(L.wrapAngle(toMe - e.angle));
    if (facing < 0.35) score += 10;

    if (score < bestScore) {
      bestScore = score;
      best = { e, aim, dist, score };
    }
  }

  if (!best && nearest) {
    best = { e: nearest, aim: null, dist: nearestDist, score: 0 };
  }

  if (best) {
    mem.targetId = best.e.id;
    mem.lastAim = best.aim ? best.aim.angle : null;
    mem.lastMiss = best.aim ? best.aim.miss : null;
    mem.lastTargetScore = best.score;
    mem.lastTargetDist = best.dist;
    mem.lastTargetHp = best.e.hp;
  }

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

function centerBurn(obs) {
  const L = obs.lib;
  const me = obs.self;

  const speed = L.len(me.vel);
  if (speed > 50) {
    return L.norm(L.scale(me.vel, -1));
  }

  const r = L.len(me.pos);
  if (r > obs.arena.radius * 0.7) {
    return L.norm(L.scale(L.norm(me.pos), -1));
  }

  return null;
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
    if (me.heat >= 85) {
      mem.heatStop = true;
      return false;
    }
  } else {
    if (me.heat < 55) {
      mem.heatStop = false;
    } else {
      return false;
    }
  }

  if (me.heat + W.heatPerShot >= W.overheatAt) {
    mem.heatStop = true;
    return false;
  }

  return true;
}

export default function control(obs, mem) {
  if (!mem || typeof mem !== "object") mem = {};

  if (!Number.isFinite(mem.heatStop)) mem.heatStop = false;
  if (!mem.targetId) mem.targetId = null;
  if (!Number.isFinite(mem.lastAim)) mem.lastAim = null;
  if (!Number.isFinite(mem.lastMiss)) mem.lastMiss = null;
  if (!Number.isFinite(mem.lastTargetScore)) mem.lastTargetScore = null;
  if (!Number.isFinite(mem.lastTargetDist)) mem.lastTargetDist = null;
  if (!Number.isFinite(mem.lastTargetHp)) mem.lastTargetHp = null;
  if (!Number.isFinite(mem.lastThreatT)) mem.lastThreatT = null;
  if (!Number.isFinite(mem.lastThreatMiss)) mem.lastThreatMiss = null;
  if (!mem.lastThreatOwner) mem.lastThreatOwner = null;

  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  const d = danger(obs, 5.0);
  const threat = incoming(obs, 1.5, mem);
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
    desired = dodgeDir(L, threat, me, obs);
    priority = 80;
    thrustScale = 30;
  }

  // 3. Combat aim.
  if (!desired && target) {
    if (target.aim) {
      desired = {
        x: Math.cos(target.aim.angle),
        y: Math.sin(target.aim.angle)
      };
      priority = 50;
    } else {
      desired = L.norm(L.sub(target.e.pos, me.pos));
      priority = 40;
    }
  }

  // 4. If no target, keep a safe orbit or slow down.
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

    if (!desired) {
      const center = centerBurn(obs);
      if (center) {
        desired = center;
        priority = 10;
        thrustScale = 40;
      }
    }
  }

  let thrust = 0;
  let turn = 0;
  let fire = false;

  if (desired && L.len(desired) > 1e-6) {
    const targetAngle = Math.atan2(desired.y, desired.x);
    const s = steer(L, me, targetAngle, 3);
    turn = s.turn;

    if (me.fuel > 0) {
      const aligned = Math.abs(s.err) < 0.35;
      const emergencyAligned = Math.abs(s.err) < 0.75;

      if (priority >= 80 && emergencyAligned) {
        thrust = 1;
      } else if (priority >= 50 && aligned) {
        if (target && target.dist > 1200 && me.fuel > 30) {
          thrust = 0.4;
        } else if (target && target.dist > 800 && me.fuel > 25) {
          thrust = 0.25;
        } else if (target && target.dist > 500 && me.fuel > 20) {
          thrust = 0.15;
        } else if (me.fuel > 15) {
          thrust = 0.1;
        }
      } else if (priority >= 20 && aligned && me.fuel > 15) {
        thrust = 0.2;
      } else if (priority >= 10 && aligned && me.fuel > 10) {
        thrust = 0.1;
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
