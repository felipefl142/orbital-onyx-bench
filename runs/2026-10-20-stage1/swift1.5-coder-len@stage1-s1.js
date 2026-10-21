// ORBITAL ONYX control program.
// Improved strategy:
// - Stronger arena containment and planet-escape logic.
// - Better curved-bullet evasion using predicted self/bullet paths.
// - More accurate gravity-corrected aiming with iterative local search.
// - More disciplined heat/fuel management and endgame risk control.

function clamp(x, a, b) {
  if (!isFinite(x)) return a;
  return x < a ? a : x > b ? b : x;
}

function normSafe(L, v) {
  const l = L.len(v);
  if (!isFinite(l) || l < 1e-6) return { x: 1, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

function burn(L, me, dv, tolerance, scale, minThrust, gain) {
  const mag = L.len(dv);
  let turn = 0;
  let ang = 0;

  if (mag > 0.5) {
    ang = Math.atan2(dv.y, dv.x);
    const err = L.wrapAngle(ang - me.angle);
    turn = clamp(err * (gain || 4) - me.angVel * 0.3, -1, 1);
  }

  let thrust = 0;
  if (me.fuel > 0 && mag > 1 && Math.abs(L.wrapAngle(ang - me.angle)) < tolerance) {
    thrust = clamp(mag / scale, minThrust || 0, 1);
  }

  return { thrust, turn, fire: false };
}

function safeDir(obs, L, dir) {
  const me = obs.self;
  let d = dir;

  for (let i = 0; i < obs.planets.length; i++) {
    const p = obs.planets[i];
    const rel = L.sub(me.pos, p.pos);
    const dist = L.len(rel);
    const minD = p.radius + 110;

    if (dist < minD + 80) {
      const radial = normSafe(L, rel);
      if (L.dot(d, radial) < 0) {
        d = L.add(d, L.scale(radial, 1.6));
      }
    }
  }

  const r = L.len(me.pos);
  if (r > obs.arena.radius - 250) {
    const inward = L.scale(L.norm(me.pos), -1);
    if (L.dot(d, inward) < 0) {
      d = L.add(d, L.scale(inward, 1.6));
    }
  }

  return normSafe(L, d);
}

function survivalDanger(obs) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;

  // Immediate planet proximity override.
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
      const outW = d < p.radius + 70 ? 1.8 : 1.0;
      const dir = normSafe(L, L.add(L.scale(tang, sgn), L.scale(radial, outW)));
      return { planet: { dir, t: 0 }, arena: null };
    }
  }

  const path = L.predict(me, 4, { step: 1 / 20, radius: R + 22 });

  let planet = null;
  if (path.hit) {
    const p = obs.planets[path.hit.planet];
    if (p) {
      const rel = L.sub(me.pos, p.pos);
      const radial = normSafe(L, rel);
      const relVel = L.sub(me.vel, p.vel);
      const tang = { x: -radial.y, y: radial.x };
      const sgn = L.dot(relVel, tang) >= 0 ? 1 : -1;
      const d = L.len(rel);
      const outW = d < p.radius + 80 ? 1.8 : 0.9;
      const dir = normSafe(L, L.add(L.scale(tang, sgn), L.scale(radial, outW)));
      planet = { dir, t: path.hit.t };
    }
  }

  let arena = null;
  const r = L.len(me.pos);
  if (r > 1) {
    const posN = L.norm(me.pos);
    const inward = L.scale(posN, -1);
    const outward = L.dot(me.vel, posN);

    if (path.leavesArena || r > 1750 || (r > 1650 && outward > -10)) {
      const tang = { x: -inward.y, y: inward.x };
      const sgn = L.dot(me.vel, tang) >= 0 ? 1 : -1;
      const dir = normSafe(L, L.add(inward, L.scale(tang, 0.35 * sgn)));
      arena = { dir, t: path.leavesArena ? 2 : 3 };
    }
  }

  return { planet, arena };
}

function bulletThreat(obs) {
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
    if (t <= 0.02 || t > 1.5 || t > b.ttl) continue;

    const miss = L.add(d, L.scale(u, t));
    const ml = L.len(miss);
    const dist = L.len(d);

    if (ml < R * 5 || dist < 350) {
      cands.push({ b, t, miss, ml, u, dist });
    }
  }

  if (!cands.length) return null;

  cands.sort((a, b) => a.t - b.t);

  const selfPath = L.predict(me, 1.5, { step: 1 / 40, radius: 0 }).points;

  const fallback = () => {
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (c.ml < R * 2.5 && c.t < 0.8) {
        return { t: c.t, miss: c.miss, u: c.u, ml: c.ml };
      }
    }
    return null;
  };

  if (!selfPath || selfPath.length < 2) return fallback();

  let best = null;

  for (let i = 0; i < cands.length && i < 8; i++) {
    const c = cands[i];
    if (best && c.t > best.t + 0.15) break;

    const horizon = Math.min(1.5, c.t + 0.2);
    const bp = L.predict(c.b, horizon, { step: 1 / 40, radius: 0 }).points;
    if (!bp || bp.length < 1) continue;

    let minD = 1e9;
    let atT = 0;
    let missVec = c.miss;

    const n = Math.min(bp.length, selfPath.length);
    for (let j = 0; j < n; j++) {
      const dd = L.len(L.sub(bp[j].pos, selfPath[j].pos));
      if (dd < minD) {
        minD = dd;
        atT = bp[j].t;
        missVec = L.sub(bp[j].pos, selfPath[j].pos);
      }
    }

    if (minD < R * 1.8 && atT < 1.0) {
      best = { t: atT, miss: missVec, u: c.u, ml: minD };
      break;
    }
  }

  if (!best) return fallback();
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

function chooseTarget(obs, mem, enemies) {
  const L = obs.lib;
  const me = obs.self;

  let best = null;
  let bestScore = 1e9;

  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const dist = L.len(L.sub(e.pos, me.pos));
    let s = dist + e.hp * 1.5;

    if (e.hp <= 10) s -= 300;
    else if (e.hp <= 30) s -= 100;

    if (s < bestScore) {
      bestScore = s;
      best = e;
    }
  }

  // Sticky target to avoid jitter.
  if (mem.targetId) {
    for (let i = 0; i < enemies.length; i++) {
      if (enemies[i].id === mem.targetId) {
        const e = enemies[i];
        const dist = L.len(L.sub(e.pos, me.pos));
        let s = dist + e.hp * 1.5;

        if (e.hp <= 10) s -= 300;
        else if (e.hp <= 30) s -= 100;

        if (s < bestScore * 1.15 + 80) best = e;
        break;
      }
    }
  }

  mem.targetId = best ? best.id : null;
  return best;
}

function desiredRange(obs, L, me, target, t, dist) {
  let r = 650;

  if (target.hp <= 10) r = 450;
  else if (target.hp <= 30) r = 550;

  if (me.hp < 30) r = Math.max(r, 850);
  else if (me.hp < 50) r = Math.max(r, 750);

  if (me.fuel < 20) r = Math.max(r, 950);

  if (t > 105) {
    if (me.hp > target.hp + 8) r = 1150;
    else if (me.hp <= target.hp) r = Math.min(r, 550);
    else r = Math.max(r, 850);
  }

  const tspeed = L.len(target.vel);
  if (tspeed < 25 && target.hp > 10) r = Math.min(r, 550);

  const toT = normSafe(L, L.sub(target.pos, me.pos));
  const closing = L.dot(L.sub(target.vel, me.vel), toT);
  if (closing > 50) r = Math.min(1100, r + 150);

  return clamp(r, 380, 1200);
}

function desiredPoint(obs, L, me, target, range) {
  const tau = 0.6;
  const grav = L.gravityAt(target.pos);
  const pred = L.add(
    L.add(target.pos, L.scale(target.vel, tau)),
    L.scale(grav, 0.5 * tau * tau)
  );

  const rel = L.sub(me.pos, pred);
  const away = normSafe(L, rel);
  let point = L.add(pred, L.scale(away, range));

  // Keep the desired point away from planets.
  for (let i = 0; i < obs.planets.length; i++) {
    const p = obs.planets[i];
    const rp = L.sub(point, p.pos);
    const dp = L.len(rp);
    const minD = p.radius + 90;

    if (dp < minD) {
      const radial = normSafe(L, rp);
      point = L.add(p.pos, L.scale(radial, minD));
    }
  }

  // Keep it well inside the arena.
  const maxR = obs.arena.radius - 350;
  const rp = L.len(point);
  if (rp > maxR && rp > 1) {
    point = L.scale(point, maxR / rp);
  }

  return point;
}

function desiredDv(obs, L, me, point) {
  const grav = L.gravityAt(me.pos);
  const tau = 1.2;

  const desiredVel = L.add(
    L.scale(L.sub(point, me.pos), 1 / tau),
    L.scale(grav, -0.5 * tau)
  );

  return L.sub(desiredVel, me.vel);
}

function gravityAim(obs, target, maxTime) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const speed = obs.rules.weapon.bulletSpeed;

  const lead = L.leadTarget(me, target, speed);
  if (!lead || lead.time > maxTime) return null;

  const horizon = Math.max(0.25, Math.min(3, lead.time + 0.3));

  const ePred = L.predict(target, horizon, { step: 1 / 100, radius: R });
  if (ePred.hit && ePred.hit.t < lead.time + 0.08) return null;

  const ePath = ePred.points;
  if (!ePath || ePath.length < 2) return null;

  const evaluate = (angle) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dir = { x: c, y: s };

    const pos = L.add(me.pos, L.scale(dir, R + 2));
    const vel = L.add(me.vel, L.scale(dir, speed));

    const bp = L.predict({ pos, vel }, horizon, { step: 1 / 100, radius: 0 });

    let best = 1e9;
    let bestIdx = 0;
    let bestT = 0;

    const n = Math.min(bp.points.length, ePath.length);
    for (let i = 0; i < n; i++) {
      const dd = L.len(L.sub(bp.points[i].pos, ePath[i].pos));
      if (dd < best) {
        best = dd;
        bestIdx = i;
        bestT = bp.points[i].t;
      }
    }

    if (n === 0) {
      return { angle, miss: 1e9, blocked: true, corr: 0, t: lead.time };
    }

    const off = L.sub(ePath[bestIdx].pos, bp.points[bestIdx].pos);
    const range = Math.max(1, L.len(L.sub(ePath[bestIdx].pos, me.pos)));
    const blocked = !!bp.hit && bp.hit.t <= bestT + 0.06;
    const corr = L.cross(dir, off) / range;

    return { angle, miss: best, blocked, corr, t: bestT };
  };

  let ev = evaluate(lead.angle);

  // Iteratively correct for gravity bend.
  for (let k = 0; k < 6; k++) {
    if (ev.miss < 9 || ev.blocked) break;

    const corr = clamp(ev.corr, -0.35, 0.35);
    if (Math.abs(corr) < 1e-4) break;

    let next = evaluate(ev.angle + corr);
    if (next.miss < ev.miss - 0.5) {
      ev = next;
      continue;
    }

    next = evaluate(ev.angle + corr * 0.5);
    if (next.miss < ev.miss - 0.5) {
      ev = next;
      continue;
    }

    next = evaluate(ev.angle - corr * 0.25);
    if (next.miss < ev.miss - 0.5) {
      ev = next;
      continue;
    }

    break;
  }

  return ev;
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

    const surv = survivalDanger(obs);
    const threat = bulletThreat(obs);

    // Victory hold / no enemies: just survive.
    if (enemies.length === 0) {
      if (surv.planet && surv.planet.t < 3.5) {
        const dir = safeDir(obs, L, surv.planet.dir);
        return burn(L, me, L.scale(dir, 110), 0.6, 28, 0.35);
      }

      if (surv.arena) {
        return burn(L, me, L.scale(surv.arena.dir, 110), 0.6, 28, 0.35);
      }

      if (threat && threat.t < 0.8) {
        const dir = safeDir(obs, L, dodgeDir(L, threat));
        return burn(L, me, L.scale(dir, 100), 0.55, 26, 0.35);
      }

      return { thrust: 0, turn: 0, fire: false };
    }

    // Hard survival overrides.
    if (surv.planet && surv.planet.t < 2.4) {
      const dir = safeDir(obs, L, surv.planet.dir);
      return burn(L, me, L.scale(dir, 120), 0.6, 28, 0.4);
    }

    if (surv.arena) {
      return burn(L, me, L.scale(surv.arena.dir, 115), 0.6, 28, 0.4);
    }

    if (threat && threat.t < 0.55 && threat.ml < R * 2.0) {
      const dir = safeDir(obs, L, dodgeDir(L, threat));
      return burn(L, me, L.scale(dir, 110), 0.55, 26, 0.45);
    }

    const target = chooseTarget(obs, mem, enemies);
    if (!target) return { thrust: 0, turn: 0, fire: false };

    const dist = L.len(L.sub(target.pos, me.pos));
    const toT = normSafe(L, L.sub(target.pos, me.pos));
    const closing = L.dot(L.sub(target.vel, me.vel), toT);

    // Very close enemy: back away.
    if (dist < 80 && closing > -20) {
      const dir = safeDir(obs, L, L.scale(toT, -1));
      return burn(L, me, L.scale(dir, 95), 0.55, 26, 0.4);
    }

    const range = desiredRange(obs, L, me, target, t, dist);
    const point = desiredPoint(obs, L, me, target, range);
    let dv = desiredDv(obs, L, me, point);

    // Bullet evasion bias.
    if (threat) {
      const dir = safeDir(obs, L, dodgeDir(L, threat));
      const w = threat.t < 0.6 ? 110 : Math.max(0, 70 * (1 - threat.t));
      dv = L.add(dv, L.scale(dir, w));
    }

    // Planet avoidance bias.
    if (surv.planet && surv.planet.t < 3.5) {
      const w = surv.planet.t < 2 ? 60 : 30;
      dv = L.add(dv, L.scale(surv.planet.dir, w));
    }

    // Arena containment bias.
    const r = L.len(me.pos);
    if (r > 1400) {
      const inward = L.scale(L.norm(me.pos), -1);
      dv = L.add(dv, L.scale(inward, Math.min(90, (r - 1400) * 0.25)));
    }

    // Avoid being rammed.
    if (dist < 350 && closing > 20) {
      const away = L.scale(toT, -1);
      dv = L.add(dv, L.scale(away, Math.min(90, closing * 0.6)));
    }

    // Cap desired delta-v to avoid wasteful full-thrust corrections.
    const dvMag0 = L.len(dv);
    if (dvMag0 > 250) {
      dv = L.scale(dv, 250 / dvMag0);
    }

    const aimMax = Math.min(2.8, Math.max(0.3, dist / 600 + 0.35));
    const aim = gravityAim(obs, target, aimMax);
    const aimAngle = aim ? aim.angle : L.angleTo(me.pos, target.pos);

    const aimGood = aim
      ? !aim.blocked && aim.miss < 10 && aim.t < 2.6
      : dist < 250;

    const dvMag = L.len(dv);
    const dvAngle = dvMag > 1 ? Math.atan2(dv.y, dv.x) : aimAngle;

    const priorityMove =
      (threat && threat.t < 0.9) ||
      (surv.planet && surv.planet.t < 3.0) ||
      (dist < 350 && closing > 40) ||
      r > 1600;

    let turnAngle = aimAngle;
    let fireAllowed = true;

    if (dist < 90) {
      turnAngle = Math.atan2(-toT.y, -toT.x);
      fireAllowed = false;
    } else if (priorityMove && dvMag > 15) {
      turnAngle = dvAngle;
    } else if (dist < range - 70) {
      turnAngle = dvAngle;
    } else if (!aimGood && dvMag > 12) {
      turnAngle = dvAngle;
    } else {
      turnAngle = aimAngle;
    }

    const err = L.wrapAngle(turnAngle - me.angle);
    const turn = clamp(err * 4 - me.angVel * 0.3, -1, 1);

    const reserve =
      8 +
      (surv.planet ? 4 : 0) +
      (surv.arena ? 4 : 0) +
      (threat && threat.t < 0.8 ? 3 : 0) +
      (r > 1600 ? 3 : 0);

    const canBurn = me.fuel > reserve;
    let thrust = 0;

    if (canBurn) {
      if (
        !priorityMove &&
        dist > range + 70 &&
        aimGood &&
        Math.abs(L.wrapAngle(aimAngle - me.angle)) < 0.4
      ) {
        thrust = Math.max(thrust, clamp((dist - range) / 350, 0.25, 0.85));
      } else if (dvMag > 14 && Math.abs(err) < 0.5) {
        thrust = clamp(dvMag / 45, 0.15, 1);
      }
    }

    let fire = false;

    if (
      fireAllowed &&
      me.ammo > 0 &&
      !me.overheated &&
      me.cooldown <= 0 &&
      t >= mem.noFireUntil &&
      !(threat && threat.t < 0.5)
    ) {
      let heatOk = me.heat < 78;
      if (me.heat >= 78 && me.heat < 90 && target.hp <= 25) heatOk = true;
      if (me.heat >= 90) heatOk = false;

      if (heatOk && aimGood && Math.abs(me.angVel) < 1.2) {
        const alignTol = Math.max(0.008, Math.atan2(5, Math.max(50, dist)));

        if (Math.abs(L.wrapAngle(aimAngle - me.angle)) < alignTol) {
          fire = true;

          if (me.heat > 65) mem.noFireUntil = t + 0.5;
          if (me.heat > 80) mem.noFireUntil = t + 0.9;
        }
      }
    }

    // Endgame risk control.
    if (t > 105) {
      if (me.hp > target.hp + 6 && target.hp > 15) fire = false;
      if (me.hp < 20 && target.hp > 20) fire = false;
      if (t > 112 && me.hp > target.hp + 3) fire = false;
    }

    return {
      thrust: clamp(thrust, 0, 1),
      turn: clamp(turn, -1, 1),
      fire
    };
  } catch (e) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
