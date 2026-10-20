// ORBITAL ONYX control program.
// Strategy: survive first (planet/arena/bullet avoidance), then maintain a safe
// mid-range orbit around the chosen enemy, fire with gravity-corrected aim,
// and conserve fuel/heat while finishing low-HP targets.

function clamp(x, a, b) {
  if (!isFinite(x)) return a;
  return x < a ? a : x > b ? b : x;
}

function normSafe(L, v) {
  const l = L.len(v);
  if (!isFinite(l) || l < 1e-6) return { x: 1, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

function burn(L, me, dv, tolerance, scale, minThrust) {
  const mag = L.len(dv);
  if (!isFinite(mag) || mag < 1e-3 || me.fuel <= 0) {
    return { thrust: 0, turn: 0, fire: false };
  }
  const ang = Math.atan2(dv.y, dv.x);
  const err = L.wrapAngle(ang - me.angle);
  const turn = clamp(err * 4 - me.angVel * 0.25, -1, 1);
  const mt = isFinite(minThrust) ? minThrust : 0;
  const thrust = Math.abs(err) < tolerance ? clamp(mag / scale, mt, 1) : 0;
  return { thrust, turn, fire: false };
}

function dangerFn(obs, horizon) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  // Immediate proximity override.
  for (let i = 0; i < obs.planets.length; i++) {
    const p = obs.planets[i];
    const rel = L.sub(me.pos, p.pos);
    const d = L.len(rel);
    const minD = p.radius + R + 25;
    if (d < minD) {
      const radial = normSafe(L, rel);
      const relVel = L.sub(me.vel, p.vel);
      const tang = { x: -radial.y, y: radial.x };
      const sgn = L.dot(relVel, tang) >= 0 ? 1 : -1;
      const dir = normSafe(L, L.add(L.scale(tang, sgn), L.scale(radial, 1.3)));
      return { dir, t: 0, type: "planet" };
    }
  }

  const path = L.predict(me, horizon, { step: 1 / 20, radius: R + 20 });

  if (path.hit) {
    const p = obs.planets[path.hit.planet];
    if (!p) return null;
    const rel = L.sub(me.pos, p.pos);
    const radial = normSafe(L, rel);
    const relVel = L.sub(me.vel, p.vel);
    const tang = { x: -radial.y, y: radial.x };
    const sgn = L.dot(relVel, tang) >= 0 ? 1 : -1;
    const d = L.len(rel);
    const outWeight = d < p.radius + 80 ? 1.6 : 0.8;
    const dir = normSafe(L, L.add(L.scale(tang, sgn), L.scale(radial, outWeight)));
    return { dir, t: path.hit.t, type: "planet" };
  }

  const r = L.len(me.pos);
  if (r > 1) {
    const outward = L.dot(me.vel, L.norm(me.pos));
    if (path.leavesArena || (r > obs.arena.radius * 0.85 && outward > -15)) {
      const inward = L.scale(L.norm(me.pos), -1);
      const tang = { x: -inward.y, y: inward.x };
      const sgn = L.dot(me.vel, tang) >= 0 ? 1 : -1;
      const dir = normSafe(L, L.add(inward, L.scale(tang, 0.35 * sgn)));
      return { dir, t: 3, type: "arena" };
    }
  }

  return null;
}

function incomingThreat(obs, window) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const cands = [];

  for (let i = 0; i < obs.bullets.length; i++) {
    const b = obs.bullets[i];
    if (b.owner === me.id) continue;

    const d = L.sub(b.pos, me.pos);
    const u = L.sub(b.vel, me.vel);
    const uu = L.dot(u, u);
    if (uu < 1) continue;

    const t = -L.dot(d, u) / uu;
    if (t <= 0 || t > window || t > b.ttl) continue;

    const miss = L.add(d, L.scale(u, t));
    const ml = L.len(miss);
    if (ml < R * 4) cands.push({ b, t, miss, u, ml });
  }

  if (!cands.length) return null;
  cands.sort((a, b) => a.t - b.t);

  const selfHorizon = Math.min(2, window);
  const selfPath = L.predict(me, selfHorizon, { step: 1 / 40, radius: 0 }).points;
  if (!selfPath.length) {
    return { t: cands[0].t, miss: cands[0].miss, u: cands[0].u, ml: cands[0].ml };
  }

  let best = null;

  // Refine the nearest few candidates with a short curved-bullet prediction.
  for (let i = 0; i < cands.length && i < 3; i++) {
    const c = cands[i];
    if (best && c.t > best.t + 0.05) break;

    const horizon = Math.min(2, c.t + 0.25);
    const bp = L.predict(c.b, horizon, { step: 1 / 40, radius: 0 }).points;

    let minD = 1e9;
    let atT = 0;
    let missVec = c.miss;

    for (let j = 0; j < bp.length && j < selfPath.length; j++) {
      const dd = L.len(L.sub(bp[j].pos, selfPath[j].pos));
      if (dd < minD) {
        minD = dd;
        atT = bp[j].t;
        missVec = L.sub(bp[j].pos, selfPath[j].pos);
      }
    }

    if (minD < R * 1.6 && atT < c.t + 0.35) {
      best = { t: atT, miss: missVec, u: c.u, ml: minD };
    } else if (!best && c.ml < R * 2.2) {
      best = { t: c.t, miss: c.miss, u: c.u, ml: c.ml };
    }
  }

  if (!best) {
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (c.ml < R * 2.2 && c.t < 0.9) {
        best = { t: c.t, miss: c.miss, u: c.u, ml: c.ml };
        break;
      }
    }
  }

  return best;
}

function dodgeDir(L, threat) {
  const u = threat.u;
  const ul = L.len(u);
  if (!isFinite(ul) || ul < 1e-3) return { x: 1, y: 0 };

  const side = { x: -u.y / ul, y: u.x / ul };
  const s = L.dot(side, threat.miss) > 0 ? -1 : 1;
  return { x: side.x * s, y: side.y * s };
}

function safeDir(obs, L, dir) {
  const me = obs.self;
  let d = dir;

  for (let i = 0; i < obs.planets.length; i++) {
    const p = obs.planets[i];
    const rel = L.sub(me.pos, p.pos);
    const dist = L.len(rel);
    const minD = p.radius + 70;
    if (dist < minD + 100) {
      const radial = normSafe(L, rel);
      if (L.dot(d, radial) < 0) {
        d = normSafe(L, L.add(d, L.scale(radial, 1.6)));
      }
    }
  }

  const r = L.len(me.pos);
  if (r > obs.arena.radius * 0.78) {
    const inward = L.scale(L.norm(me.pos), -1);
    if (L.dot(d, inward) < 0) {
      d = normSafe(L, L.add(d, L.scale(inward, 1.6)));
    }
  }

  return normSafe(L, d);
}

function chooseTarget(obs, mem, enemies) {
  if (!enemies.length) return null;

  const L = obs.lib;
  const me = obs.self;

  const score = (e, dist) => {
    let s = dist + e.hp * 2;
    if (e.hp <= 10) s -= 250;
    else if (e.hp <= 30) s -= 80;
    return s;
  };

  let best = null;
  let bestScore = 1e9;
  let current = null;

  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const dist = L.len(L.sub(e.pos, me.pos));
    const s = score(e, dist);
    if (e.id === mem.targetId) current = e;
    if (s < bestScore) {
      bestScore = s;
      best = e;
    }
  }

  // Keep target somewhat sticky to avoid jitter.
  if (current) {
    const dist = L.len(L.sub(current.pos, me.pos));
    const cs = score(current, dist);
    if (cs < bestScore * 1.2 + 100) best = current;
  }

  mem.targetId = best.id;
  return best;
}

function gravityAim(obs, target, maxTime) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const speed = obs.rules.weapon.bulletSpeed;

  const lead = L.leadTarget(me, target, speed);
  if (!lead) return null;
  if (lead.time > maxTime) return null;

  const horizon = Math.max(0.2, Math.min(3, lead.time + 0.35));
  const ePred = L.predict(target, horizon, { step: 1 / 80, radius: R });
  const ePath = ePred.points;
  if (!ePath.length) return null;

  // If the target is about to die to a planet before our bullet arrives, skip it.
  if (ePred.hit && ePred.hit.t < lead.time + 0.05) return null;

  const evaluate = (angle) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dir = { x: c, y: s };

    const pos = L.add(me.pos, L.scale(dir, R + 3));
    const vel = L.add(me.vel, L.scale(dir, speed));

    const bp = L.predict({ pos, vel }, horizon, { step: 1 / 80, radius: 0 });

    let best = 1e9;
    let at = 0;
    let bestT = 0;
    const n = Math.min(bp.points.length, ePath.length);

    for (let i = 0; i < n; i++) {
      const dd = L.len(L.sub(bp.points[i].pos, ePath[i].pos));
      if (dd < best) {
        best = dd;
        at = i;
        bestT = bp.points[i].t;
      }
    }

    if (n === 0) {
      return { angle, miss: 1e9, blocked: true, corr: 0, t: lead.time };
    }

    const off = L.sub(ePath[at].pos, bp.points[at].pos);
    const tHit = Math.max(0.08, bestT);
    const blocked = !!bp.hit && bp.hit.t <= bestT + 0.05;
    const corr = L.cross(dir, off) / (tHit * speed);

    return { angle, miss: best, blocked, corr, t: bestT };
  };

  let ev = evaluate(lead.angle);

  // Iteratively correct for gravity bend.
  for (let k = 0; k < 5; k++) {
    if (ev.miss < R * 0.55) break;
    if (ev.blocked) break;

    const corr = clamp(ev.corr, -0.4, 0.4);
    if (Math.abs(corr) < 1e-4) break;

    const next = evaluate(ev.angle + corr);
    if (next.miss >= ev.miss - 1e-3) break;
    ev = next;
  }

  return ev;
}

function desiredPoint(obs, L, me, target, desiredRange) {
  const pred = L.add(target.pos, L.scale(target.vel, 0.5));
  const rel = L.sub(me.pos, pred);
  const d = Math.max(L.len(rel), 1);
  const away = normSafe(L, rel);

  let point = L.add(pred, L.scale(away, desiredRange));

  // Push the desired point away from planets.
  for (let i = 0; i < obs.planets.length; i++) {
    const p = obs.planets[i];
    const rp = L.sub(point, p.pos);
    const dp = L.len(rp);
    const minD = p.radius + 80;
    if (dp < minD) {
      const radial = normSafe(L, rp);
      point = L.add(p.pos, L.scale(radial, minD));
    }
  }

  // Keep it inside the arena with margin.
  const rp = L.len(point);
  const maxR = obs.arena.radius - 130;
  if (rp > maxR) point = L.scale(point, maxR / rp);

  return point;
}

function desiredDv(obs, L, me, point) {
  const grav = L.gravityAt(me.pos);
  const tau = 1.1;
  const desiredVel = L.add(
    L.scale(L.sub(point, me.pos), 1 / tau),
    L.scale(grav, -tau / 2)
  );
  return L.sub(desiredVel, me.vel);
}

function desiredRange(obs, me, target, t) {
  let r = 700;
  if (target.hp <= 20) r = 520;
  if (me.hp < 40) r = 900;
  if (me.fuel < 25) r = 1000;
  if (t > 105 && me.hp > target.hp + 8) r = 1100;
  if (t > 105 && me.hp <= target.hp) r = 600;
  if (me.hp < 25) r = 1100;
  return r;
}

export default function control(obs, mem) {
  try {
    const L = obs.lib;
    const me = obs.self;
    const R = obs.rules.ship.radius;
    const t = obs.t;

    if (!mem) mem = {};
    if (typeof mem.targetId !== "string") mem.targetId = null;
    if (!isFinite(mem.noFireUntil)) mem.noFireUntil = 0;

    const enemies = [];
    for (let i = 0; i < obs.enemies.length; i++) {
      if (obs.enemies[i].alive) enemies.push(obs.enemies[i]);
    }

    const danger = dangerFn(obs, 5);
    const threat = incomingThreat(obs, 1.1);

    // Victory hold / no enemies: just survive.
    if (enemies.length === 0) {
      if (danger && (danger.type === "arena" || danger.t < 3.0) && me.fuel > 0) {
        return burn(L, me, L.scale(danger.dir, 90), 0.65, 30, 0.25);
      }
      if (threat && threat.t < 0.8 && me.fuel > 0) {
        const dir = safeDir(obs, L, dodgeDir(L, threat));
        return burn(L, me, L.scale(dir, 80), 0.6, 28, 0.25);
      }
      return { thrust: 0, turn: 0, fire: false };
    }

    // Hard survival overrides.
    if (danger && (danger.type === "arena" || danger.t < 2.8) && me.fuel > 0) {
      return burn(L, me, L.scale(danger.dir, 110), 0.6, 28, 0.35);
    }

    if (threat && threat.t < 0.85 && threat.ml < R * 2.6 && me.fuel > 0) {
      const dir = safeDir(obs, L, dodgeDir(L, threat));
      return burn(L, me, L.scale(dir, 95), 0.55, 26, 0.35);
    }

    const target = chooseTarget(obs, mem, enemies);
    if (!target) return { thrust: 0, turn: 0, fire: false };

    const dist = L.len(L.sub(target.pos, me.pos));

    const maxTime = Math.min(2.9, Math.max(0.25, dist / 600 + 0.35));
    const aim = gravityAim(obs, target, maxTime);
    const aimAngle = aim ? aim.angle : L.angleTo(me.pos, target.pos);
    const aimErr = L.wrapAngle(aimAngle - me.angle);

    const dRange = desiredRange(obs, me, target, t);
    const point = desiredPoint(obs, L, me, target, dRange);
    let dv = desiredDv(obs, L, me, point);

    // Bias movement away from non-urgent dangers.
    if (danger && danger.t < 3.5) {
      const w = danger.t < 2 ? 1 : 0.5;
      dv = L.add(dv, L.scale(danger.dir, 50 * w));
    }
    if (threat && threat.t < 1.2) {
      const dir = safeDir(obs, L, dodgeDir(L, threat));
      dv = L.add(dv, L.scale(dir, 30));
    }

    const dvMag = L.len(dv);
    const dvAngle = dvMag > 1 ? Math.atan2(dv.y, dv.x) : aimAngle;

    let turnAngle = aimAngle;
    let fireAllowed = true;

    if (dist < 90) {
      const away = normSafe(L, L.sub(me.pos, target.pos));
      turnAngle = Math.atan2(away.y, away.x);
      fireAllowed = false;
    } else if (dist < dRange - 80 && dvMag > 5) {
      turnAngle = dvAngle;
    } else if (!aim || aim.blocked || aim.miss > R * 2.5) {
      if (dvMag > 5) turnAngle = dvAngle;
    }

    const err = L.wrapAngle(turnAngle - me.angle);
    const turn = clamp(err * 4 - me.angVel * 0.25, -1, 1);

    const reserve = 8 + (danger ? 5 : 0) + (threat && threat.t < 0.8 ? 4 : 0);
    const canBurn = me.fuel > reserve;

    let thrust = 0;
    if (canBurn && dvMag > 8 && Math.abs(err) < 0.5) {
      thrust = clamp(dvMag / 35, 0.12, 1);
    }

    // If we need to close range and are roughly aimed, add a small approach burn.
    if (canBurn && aim && !aim.blocked && dist > dRange + 80 && Math.abs(aimErr) < 0.4) {
      thrust = Math.max(thrust, 0.35);
    }

    let fire = false;
    if (
      fireAllowed &&
      me.ammo > 0 &&
      !me.overheated &&
      me.cooldown <= 0 &&
      me.heat < 88 &&
      t >= mem.noFireUntil
    ) {
      if (aim && !aim.blocked && aim.miss < R * 1.15 && dist > 60 && dist < 1750) {
        const alignTol = Math.max(0.025, Math.atan2(R * 0.8, Math.max(60, dist)));
        if (Math.abs(aimErr) < alignTol) {
          fire = true;
          if (me.heat > 76) mem.noFireUntil = t + 0.55;
        }
      }
    }

    // Endgame: if we are leading, avoid unnecessary risk.
    if (t > 112 && me.hp > target.hp + 5 && target.hp > 10) fire = false;
    if (me.hp < 20 && target.hp > 20) fire = false;

    return {
      thrust: clamp(thrust, 0, 1),
      turn: clamp(turn, -1, 1),
      fire
    };
  } catch (e) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
