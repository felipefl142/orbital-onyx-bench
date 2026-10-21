// ORBITAL ONYX control program.
// Priorities:
// 1) survive planets / arena edge / incoming bullets,
// 2) keep a safe firing range,
// 3) fire only with gravity-corrected, planet-unblocked aim,
// 4) play conservatively late if leading, aggressively if trailing.

function clamp(x, a, b) {
  if (!isFinite(x)) return a;
  return x < a ? a : x > b ? b : x;
}

function clampTurn(x) {
  if (!isFinite(x)) return 0;
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

function clampThrust(x) {
  if (!isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function normSafe(L, v) {
  const l = L.len(v);
  if (!isFinite(l) || l < 1e-6) return { x: 1, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

function burnAction(L, me, dir, strength, tolerance, scale, minThrust) {
  const d = normSafe(L, dir);
  const ang = Math.atan2(d.y, d.x);
  const err = L.wrapAngle(ang - me.angle);
  const turn = clampTurn(err * 4 - me.angVel * 0.25);
  let thrust = 0;
  if (me.fuel > 0 && Math.abs(err) < tolerance) {
    thrust = clampThrust(clamp(strength / scale, minThrust, 1));
  }
  return { thrust, turn, fire: false };
}

function dangerFn(obs) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const planets = obs.planets;

  // Immediate planet proximity.
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const rel = L.sub(me.pos, p.pos);
    const d = L.len(rel);
    const minD = p.radius + R + 30;
    if (d < minD) {
      const radial = normSafe(L, rel);
      const relVel = L.sub(me.vel, p.vel);
      const tang = { x: -radial.y, y: radial.x };
      const sgn = L.dot(relVel, tang) >= 0 ? 1 : -1;
      const weight = d < p.radius + 70 ? 1.6 : 0.9;
      const dir = normSafe(L, L.add(L.scale(tang, sgn), L.scale(radial, weight)));
      return { dir, t: 0, type: "planet" };
    }
  }

  const path = L.predict(me, 4.5, { step: 1 / 20, radius: R + 15 });

  if (path.hit) {
    const p = planets[path.hit.planet];
    if (p) {
      const rel = L.sub(me.pos, p.pos);
      const radial = normSafe(L, rel);
      const relVel = L.sub(me.vel, p.vel);
      const tang = { x: -radial.y, y: radial.x };
      const sgn = L.dot(relVel, tang) >= 0 ? 1 : -1;
      const d = L.len(rel);
      const weight = d < p.radius + 80 ? 1.6 : 0.9;
      const dir = normSafe(L, L.add(L.scale(tang, sgn), L.scale(radial, weight)));
      return { dir, t: path.hit.t, type: "planet" };
    }
  }

  const r = L.len(me.pos);
  if (r > 1) {
    const radial = L.norm(me.pos);
    const outward = L.dot(me.vel, radial);
    const edge = obs.arena.radius;

    if (
      path.leavesArena ||
      r > edge - 150 ||
      (r > edge - 280 && outward > -10) ||
      (r > edge - 400 && outward > 30)
    ) {
      const inward = L.scale(radial, -1);
      const tang = { x: -radial.y, y: radial.x };
      const sgn = L.dot(me.vel, tang) >= 0 ? 1 : -1;
      const dir = normSafe(L, L.add(inward, L.scale(tang, 0.35 * sgn)));
      return { dir, t: path.leavesArena ? 2 : 3, type: "arena" };
    }
  }

  return null;
}

function incomingThreat(obs) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const window = 1.4;
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
    if (ml < R * 3.5) cands.push({ b, t, miss, u, ml });
  }

  if (!cands.length) return null;
  cands.sort((a, b) => a.t - b.t);

  const selfHorizon = Math.min(1.6, window);
  const selfPath = L.predict(me, selfHorizon, { step: 1 / 40, radius: 0 }).points;

  let best = null;

  for (let i = 0; i < cands.length && i < 4; i++) {
    const c = cands[i];
    if (best && c.t > best.t + 0.08) break;
    if (c.ml > R * 3.2) continue;

    const horizon = Math.min(1.6, c.t + 0.25, c.b.ttl);
    const bPred = L.predict(c.b, horizon, { step: 1 / 40, radius: 0 });
    const bp = bPred.points;

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

    const blocked = !!bPred.hit && bPred.hit.t < atT + 0.05;

    if (!blocked && minD < R * 1.8 && atT < c.t + 0.35) {
      best = { t: atT, miss: missVec, u: c.u, ml: minD };
    } else if (!best && c.ml < R * 2.2 && c.t < 0.9) {
      best = { t: c.t, miss: c.miss, u: c.u, ml: c.ml };
    }
  }

  if (!best) {
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (c.ml < R * 2.2 && c.t < 0.85) {
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
  let d = normSafe(L, dir);

  for (let i = 0; i < obs.planets.length; i++) {
    const p = obs.planets[i];
    const rel = L.sub(me.pos, p.pos);
    const dist = L.len(rel);
    const minD = p.radius + 110;
    if (dist < minD + 80) {
      const radial = normSafe(L, rel);
      if (L.dot(d, radial) < 0) {
        d = normSafe(L, L.add(d, L.scale(radial, 1.6)));
      }
    }
  }

  const r = L.len(me.pos);
  if (r > obs.arena.radius - 220) {
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
    let s = dist + e.hp * 2.5;
    if (e.hp <= 15) s -= 300;
    else if (e.hp <= 30) s -= 100;
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

  if (current) {
    const dist = L.len(L.sub(current.pos, me.pos));
    const cs = score(current, dist);
    if (cs < bestScore * 1.15 + 100) best = current;
  }

  mem.targetId = best.id;
  return best;
}

function updateTargetAccel(obs, mem, target) {
  const L = obs.lib;
  const t = obs.t;

  if (mem.lastId === target.id && isFinite(mem.lastT) && t > mem.lastT + 0.01) {
    const dt = t - mem.lastT;

    if (dt > 0.2) {
      mem.accX = 0;
      mem.accY = 0;
    } else {
      const ax = (target.vel.x - mem.lastVel.x) / dt;
      const ay = (target.vel.y - mem.lastVel.y) / dt;
      const grav = L.gravityAt(target.pos);

      let tx = ax - grav.x;
      let ty = ay - grav.y;

      const mag = L.len({ x: tx, y: ty });
      const maxA = 70;
      if (mag > maxA) {
        tx *= maxA / mag;
        ty *= maxA / mag;
      }

      mem.accX = isFinite(mem.accX) ? 0.6 * mem.accX + 0.4 * tx : tx;
      mem.accY = isFinite(mem.accY) ? 0.6 * mem.accY + 0.4 * ty : ty;
    }
  } else {
    mem.accX = 0;
    mem.accY = 0;
  }

  mem.lastId = target.id;
  mem.lastT = t;
  mem.lastVel = { x: target.vel.x, y: target.vel.y };
}

function gravityAim(obs, target, maxTime, accX, accY) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const speed = obs.rules.weapon.bulletSpeed;

  const dist = L.len(L.sub(target.pos, me.pos));
  if (dist < 60) return null;

  const lead = L.leadTarget(me, target, speed);
  let initAngle = (lead && isFinite(lead.angle)) ? lead.angle : L.angleTo(me.pos, target.pos);
  let maxT = (lead && isFinite(lead.time)) ? lead.time : dist / speed;

  if (!isFinite(initAngle)) initAngle = L.angleTo(me.pos, target.pos);
  if (!isFinite(maxT) || maxT > maxTime) return null;

  const horizon = clamp(maxT + 0.4, 0.3, 3.0);
  const step = dist < 700 ? 1 / 100 : dist < 1200 ? 1 / 80 : 1 / 60;

  const ePred = L.predict(target, horizon, { step, radius: R });
  const ePath = ePred.points;
  if (!ePath.length) return null;

  if (ePred.hit && ePred.hit.t < maxT + 0.1) return null;

  const useAcc = isFinite(accX) && isFinite(accY) && (Math.abs(accX) > 0.5 || Math.abs(accY) > 0.5);

  const evaluate = (angle) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dir = { x: c, y: s };

    const startPos = L.add(me.pos, L.scale(dir, R + 2));
    const startVel = L.add(me.vel, L.scale(dir, speed));

    const bPred = L.predict({ pos: startPos, vel: startVel }, horizon, { step, radius: 0 });
    const bPath = bPred.points;

    let best = 1e9;
    let at = 0;
    let bestT = 0;

    const n = Math.min(bPath.length, ePath.length);
    for (let i = 0; i < n; i++) {
      const bp = bPath[i].pos;
      const ep = ePath[i];

      let ex = ep.pos.x;
      let ey = ep.pos.y;
      if (useAcc) {
        const k = 0.5 * ep.t * ep.t;
        ex += accX * k;
        ey += accY * k;
      }

      const dx = bp.x - ex;
      const dy = bp.y - ey;
      const dd = Math.sqrt(dx * dx + dy * dy);

      if (dd < best) {
        best = dd;
        at = i;
        bestT = bPath[i].t;
      }
    }

    if (n === 0) {
      return { angle, miss: 1e9, blocked: true, corr: 0, t: maxT };
    }

    const bPos = bPath[at].pos;
    const epAt = ePath[at];

    let ex = epAt.pos.x;
    let ey = epAt.pos.y;
    if (useAcc) {
      const k = 0.5 * epAt.t * epAt.t;
      ex += accX * k;
      ey += accY * k;
    }

    const toTarget = { x: ex - startPos.x, y: ey - startPos.y };
    const dot = L.dot(dir, toTarget);
    const cross = L.cross(dir, toTarget);
    const corr = Math.atan2(cross, dot);
    const blocked = !!bPred.hit && bPred.hit.t <= bestT + 0.05;

    return { angle, miss: best, blocked, corr, t: bestT };
  };

  let bestEv = evaluate(initAngle);

  const idx = Math.min(ePath.length - 1, Math.max(0, Math.floor(maxT / step)));
  if (idx >= 0) {
    const ep = ePath[idx];
    let ex = ep.pos.x;
    let ey = ep.pos.y;
    if (useAcc) {
      const k = 0.5 * ep.t * ep.t;
      ex += accX * k;
      ey += accY * k;
    }

    const ang2 = L.angleTo(me.pos, { x: ex, y: ey });
    if (isFinite(ang2)) {
      const ev2 = evaluate(ang2);
      if (ev2.miss < bestEv.miss && (!ev2.blocked || bestEv.blocked)) bestEv = ev2;
    }
  }

  const ang3 = L.angleTo(me.pos, target.pos);
  if (isFinite(ang3) && Math.abs(L.wrapAngle(ang3 - initAngle)) > 0.05) {
    const ev3 = evaluate(ang3);
    if (ev3.miss < bestEv.miss && (!ev3.blocked || bestEv.blocked)) bestEv = ev3;
  }

  for (let k = 0; k < 6; k++) {
    if (bestEv.miss < R * 0.6) break;
    if (bestEv.blocked) break;

    const corr = clamp(bestEv.corr, -0.45, 0.45);
    if (Math.abs(corr) < 0.003) break;

    const next = evaluate(bestEv.angle + corr);
    if (next.miss < bestEv.miss - 0.25) bestEv = next;
    else break;
  }

  return bestEv;
}

function desiredPoint(obs, L, me, target, range) {
  const targetPred = L.add(target.pos, L.scale(target.vel, 0.35));

  let rel = L.sub(me.pos, targetPred);
  let d = L.len(rel);
  let away = d > 1 ? { x: rel.x / d, y: rel.y / d } : { x: 1, y: 0 };

  let point = L.add(targetPred, L.scale(away, range));

  const edge = obs.arena.radius;
  const r = L.len(me.pos);

  if (r > edge - 350) {
    const inwardPoint = L.scale(me.pos, Math.max(0.4, (edge - 450) / r));
    point = L.add(L.scale(point, 0.3), L.scale(inwardPoint, 0.7));
  }

  if (r > edge - 200) {
    point = L.scale(me.pos, Math.max(0.3, (edge - 500) / r));
  }

  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < obs.planets.length; i++) {
      const p = obs.planets[i];
      const rp = L.sub(point, p.pos);
      const dp = L.len(rp);
      const minD = p.radius + 90;

      if (dp < minD) {
        const radial = dp > 1 ? { x: rp.x / dp, y: rp.y / dp } : { x: 1, y: 0 };
        point = L.add(p.pos, L.scale(radial, minD));
      }
    }
  }

  const rp = L.len(point);
  const maxR = edge - 250;
  if (rp > maxR) point = L.scale(point, maxR / rp);

  return point;
}

function desiredDv(obs, L, me, point) {
  const grav = L.gravityAt(me.pos);
  const tau = me.fuel > 30 ? 1.1 : 1.4;

  const desiredVel = L.add(
    L.scale(L.sub(point, me.pos), 1 / tau),
    L.scale(grav, -tau / 2)
  );

  return L.sub(desiredVel, me.vel);
}

export default function control(obs, mem) {
  try {
    const L = obs.lib;
    const me = obs.self;
    const R = obs.rules.ship.radius;
    const t = obs.t;
    const bulletSpeed = obs.rules.weapon.bulletSpeed;

    if (!mem) mem = {};
    if (typeof mem.targetId !== "string") mem.targetId = null;
    if (!isFinite(mem.noFireUntil)) mem.noFireUntil = 0;
    if (typeof mem.lastId !== "string") mem.lastId = null;
    if (!isFinite(mem.lastT)) mem.lastT = 0;
    if (!isFinite(mem.accX)) mem.accX = 0;
    if (!isFinite(mem.accY)) mem.accY = 0;
    if (!mem.lastVel || typeof mem.lastVel.x !== "number") mem.lastVel = { x: 0, y: 0 };

    const enemies = [];
    for (let i = 0; i < obs.enemies.length; i++) {
      if (obs.enemies[i].alive) enemies.push(obs.enemies[i]);
    }

    const danger = dangerFn(obs);
    const threat = incomingThreat(obs);

    // Victory hold / no enemies: survive.
    if (enemies.length === 0) {
      if (danger && (danger.type === "arena" || danger.t <= 4.0) && me.fuel > 0) {
        return burnAction(L, me, danger.dir, 100, 0.6, 30, 0.3);
      }

      if (threat && threat.t < 0.9 && me.fuel > 0) {
        const dir = safeDir(obs, L, dodgeDir(L, threat));
        return burnAction(L, me, dir, 90, 0.55, 28, 0.3);
      }

      const r = L.len(me.pos);
      if (r > 1200 && me.fuel > 5) {
        const point = L.scale(me.pos, 800 / r);
        const dv = desiredDv(obs, L, me, point);
        const dvMag = L.len(dv);
        const ang = dvMag > 1 ? Math.atan2(dv.y, dv.x) : me.angle;
        const err = L.wrapAngle(ang - me.angle);
        const turn = clampTurn(err * 4 - me.angVel * 0.25);
        const thrust = Math.abs(err) < 0.5 ? clampThrust(clamp(dvMag / 35, 0.1, 0.5)) : 0;
        return { thrust, turn, fire: false };
      }

      return { thrust: 0, turn: 0, fire: false };
    }

    // Hard survival overrides.
    if (danger && (danger.type === "arena" || danger.t <= 3.0) && me.fuel > 0) {
      return burnAction(L, me, danger.dir, 120, 0.6, 28, 0.4);
    }

    if (threat && threat.t < 0.75 && threat.ml < R * 2.8 && me.fuel > 0) {
      const dir = safeDir(obs, L, dodgeDir(L, threat));
      return burnAction(L, me, dir, 110, 0.7, 26, 0.45);
    }

    const r0 = L.len(me.pos);
    if (r0 > obs.arena.radius - 180 && me.fuel > 0) {
      const inward = L.scale(L.norm(me.pos), -1);
      return burnAction(L, me, inward, 130, 0.6, 28, 0.45);
    }

    const target = chooseTarget(obs, mem, enemies);
    if (!target) return { thrust: 0, turn: 0, fire: false };

    updateTargetAccel(obs, mem, target);

    const dist = L.len(L.sub(target.pos, me.pos));
    const maxTime = Math.min(2.8, Math.max(0.25, dist / bulletSpeed + 0.35));

    const accX = mem.lastId === target.id ? mem.accX : 0;
    const accY = mem.lastId === target.id ? mem.accY : 0;

    const aim = gravityAim(obs, target, maxTime, accX, accY);

    let aimAngle = aim ? aim.angle : me.angle;
    if (!isFinite(aimAngle) && dist > 1) aimAngle = L.angleTo(me.pos, target.pos);
    if (!isFinite(aimAngle)) aimAngle = me.angle;

    const fireAngle = me.angle + me.angVel * 0.025;
    const aimErr = L.wrapAngle(aimAngle - fireAngle);

    let dRange = 700;
    if (target.hp <= 20) dRange = 520;
    if (me.hp < 40) dRange = 900;
    if (me.fuel < 25) dRange = 1000;

    if (t > 105) {
      if (me.hp > target.hp + 8) dRange = 1100;
      else if (me.hp <= target.hp) dRange = 600;
    }

    if (me.hp < 25) dRange = 1100;
    dRange = clamp(dRange, 350, 1200);

    const point = desiredPoint(obs, L, me, target, dRange);
    let dv = desiredDv(obs, L, me, point);

    if (danger && danger.t < 3.5) {
      const w = danger.t < 2 ? 1 : 0.5;
      dv = L.add(dv, L.scale(danger.dir, 50 * w));
    }

    if (threat && threat.t < 1.2) {
      const dir = safeDir(obs, L, dodgeDir(L, threat));
      dv = L.add(dv, L.scale(dir, threat.t < 0.8 ? 60 : 25));
    }

    if (dist < 250) {
      const away = normSafe(L, L.sub(me.pos, target.pos));
      dv = L.add(dv, L.scale(away, 30));
    }

    const r = L.len(me.pos);
    if (r > obs.arena.radius - 350) {
      const radial = L.norm(me.pos);

      const outwardDv = L.dot(dv, radial);
      if (outwardDv > 0) {
        dv = L.sub(dv, L.scale(radial, outwardDv + 20));
      }

      const outwardVel = L.dot(me.vel, radial);
      if (outwardVel > 0) {
        dv = L.sub(dv, L.scale(radial, outwardVel * 0.5));
      }
    }

    const dvMag = L.len(dv);
    const dvAngle = dvMag > 1 ? Math.atan2(dv.y, dv.x) : aimAngle;

    let turnAngle = aimAngle;
    let fireAllowed = true;

    const inRange = dist > dRange - 120 && dist < dRange + 120;
    const aimGood = aim && !aim.blocked && aim.miss < R * 1.3;

    if (dist < 90) {
      const away = normSafe(L, L.sub(me.pos, target.pos));
      turnAngle = Math.atan2(away.y, away.x);
      fireAllowed = false;
    } else if (!inRange && dvMag > 8) {
      turnAngle = dvAngle;
    } else if (!aimGood && dvMag > 10) {
      turnAngle = dvAngle;
    } else {
      turnAngle = aimAngle;
    }

    const err = L.wrapAngle(turnAngle - me.angle);
    const turn = clampTurn(err * 4 - me.angVel * 0.25);

    const reserve = 8 + (danger ? 5 : 0) + (threat && threat.t < 0.8 ? 4 : 0);
    const canBurn = me.fuel > reserve;

    let thrust = 0;
    if (canBurn && dvMag > 8 && Math.abs(err) < 0.5) {
      thrust = clampThrust(clamp(dvMag / 32, 0.12, 1));
    }

    if (canBurn && aimGood && dist > dRange + 80 && Math.abs(aimErr) < 0.4) {
      thrust = Math.max(thrust, 0.35);
    }

    if (canBurn && dist < dRange - 80 && Math.abs(err) < 0.5) {
      thrust = Math.max(thrust, 0.25);
    }

    let fire = false;
    if (
      fireAllowed &&
      me.ammo > 0 &&
      !me.overheated &&
      me.cooldown <= 0 &&
      t >= mem.noFireUntil
    ) {
      const heatLimit = target.hp <= 15 ? 90 : 86;

      if (
        me.heat < heatLimit &&
        aim &&
        !aim.blocked &&
        aim.miss < R * 1.05 &&
        aim.t < 2.6 &&
        dist > 60 &&
        dist < 1700
      ) {
        const alignTol = Math.max(0.025, Math.atan2(R * 0.85, Math.max(60, dist)) + 0.008);
        if (Math.abs(aimErr) < alignTol) {
          fire = true;
          if (me.heat > 72) mem.noFireUntil = t + 0.6;
        }
      }
    }

    // Endgame: avoid unnecessary risk when leading.
    if (t > 112 && me.hp > target.hp + 5 && target.hp > 10) fire = false;
    if (me.hp < 20 && target.hp > 20) fire = false;
    if (t > 116 && me.hp > target.hp + 2) fire = false;
    if (t > 115 && me.hp > target.hp + 5) thrust = Math.min(thrust, 0.3);

    return {
      thrust: clampThrust(thrust),
      turn: clampTurn(turn),
      fire
    };
  } catch (e) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
