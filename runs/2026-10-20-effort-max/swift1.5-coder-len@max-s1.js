const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function safeNorm(v, L) {
  const l = L.len(v);
  if (!Number.isFinite(l) || l < 1e-6) return { x: 0, y: 0 };
  return L.scale(v, 1 / l);
}

function isSafeDv(obs, L, me, dv, R) {
  const mag = L.len(dv);
  if (!Number.isFinite(mag) || mag < 8) return true;
  const vel = L.add(me.vel, dv);
  const path = L.predict({ pos: me.pos, vel }, 1.8, { step: 1 / 20, radius: R + 10 });
  if (path.hit) return false;
  if (path.leavesArena) return false;
  return true;
}

function actionForDv(L, me, dv, aimAngle, fire) {
  const mag = L.len(dv);
  let targetAngle = aimAngle;
  if (Number.isFinite(mag) && mag > 6) targetAngle = Math.atan2(dv.y, dv.x);
  if (targetAngle == null || !Number.isFinite(targetAngle)) targetAngle = me.angle;

  const av = Number.isFinite(me.angVel) ? me.angVel : 0;
  const err = L.wrapAngle(targetAngle - me.angle);
  if (!Number.isFinite(err)) return { thrust: 0, turn: 0, fire: !!fire };

  const turn = clamp(err * 3 - av * 0.2, -1, 1);
  let thrust = 0;
  if (Number.isFinite(mag) && me.fuel > 0 && mag > 6 && Math.abs(err) < 0.4) {
    thrust = clamp(mag / 30, 0, 1);
    if (me.fuel < 10) thrust = Math.min(thrust, 0.5);
  }
  return { thrust, turn, fire: !!fire };
}

function computeDanger(obs, L, me, arenaR, R) {
  const horizon = 4;
  const path = L.predict(me, horizon, { step: 1 / 20, radius: R + 12 });

  if (path.hit) {
    const t = path.hit.t;
    if (t < 2.5) {
      const p = obs.planets[path.hit.planet];
      const rel = L.sub(me.pos, p.pos);
      const radial = safeNorm(rel, L);
      const tang = { x: -radial.y, y: radial.x };
      const sgn = L.dot(L.sub(me.vel, p.vel), tang) >= 0 ? 1 : -1;
      const dir = safeNorm(L.add(L.scale(tang, sgn), L.scale(radial, 0.8)), L);

      const cands = [
        L.scale(dir, 150),
        L.scale(tang, sgn * 150),
        L.scale(radial, 150)
      ];
      let dv = cands[0];
      if (me.fuel > 0) {
        for (const c of cands) {
          if (isSafeDv(obs, L, me, c, R)) {
            dv = c;
            break;
          }
        }
      }
      return { t, dv };
    }
  }

  const margin = R + 25;
  const r0 = L.len(me.pos);
  const radial0 = safeNorm(me.pos, L);
  const outward = L.dot(me.vel, radial0);

  for (let i = 0; i < path.points.length; i++) {
    const pt = path.points[i];
    const r = L.len(pt.pos);
    if (r > arenaR - margin) {
      if (outward > -15 || r > arenaR - 40) {
        const tang = { x: -radial0.y, y: radial0.x };
        const vt = L.dot(me.vel, tang);
        const sgn = vt >= 0 ? 1 : -1;
        const dir = safeNorm(L.add(L.scale(radial0, -1), L.scale(tang, 0.5 * sgn)), L);

        const cands = [
          L.scale(dir, 140),
          L.scale(radial0, -140),
          L.scale(tang, sgn * 140)
        ];
        let dv = cands[0];
        if (me.fuel > 0) {
          for (const c of cands) {
            if (isSafeDv(obs, L, me, c, R)) {
              dv = c;
              break;
            }
          }
        }
        return { t: pt.t, dv };
      }
    }
  }

  if (path.leavesArena) {
    const dir = L.scale(radial0, -1);
    return { t: 3, dv: L.scale(dir, 140) };
  }

  return null;
}

function incomingThreat(obs, L, me, R, window) {
  let best = null;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const d = L.sub(b.pos, me.pos);
    const u = L.sub(b.vel, me.vel);
    const uu = L.dot(u, u);
    if (uu < 1) continue;

    const t = -L.dot(d, u) / uu;
    const ttl = Number.isFinite(b.ttl) ? b.ttl : Infinity;
    if (t <= 0.02 || t > window || t > ttl) continue;

    const miss = L.add(d, L.scale(u, t));
    const ml = L.len(miss);
    if (ml < R * 3 && (!best || t < best.t)) {
      best = { t, miss, u, ml, b };
    }
  }
  return best;
}

function refineThreat(obs, L, me, best, R) {
  if (!best) return null;
  const b = best.b;
  const ttl = Number.isFinite(b.ttl) ? b.ttl : 1.5;
  const horizon = Math.min(1.5, best.t + 0.3, ttl);
  if (horizon <= 0.05) return best;

  const bp = L.predict(b, horizon, { step: 1 / 20, radius: 0 }).points;
  const mp = L.predict(me, horizon, { step: 1 / 20, radius: 0 }).points;
  const n = Math.min(bp.length, mp.length);
  if (n === 0) return best;

  let minD = Infinity;
  let minVec = best.miss;
  let minT = best.t;

  for (let i = 0; i < n; i++) {
    const d = L.sub(bp[i].pos, mp[i].pos);
    const dl = L.len(d);
    if (dl < minD) {
      minD = dl;
      minVec = d;
      minT = bp[i].t;
    }
  }

  if (minD > R * 3) return null;
  return { t: minT, miss: minVec, u: best.u, ml: minD, b };
}

function makeDodgeDv(obs, L, me, threat, R) {
  const u = threat.u;
  const ul = L.len(u);
  let side = { x: 0, y: 0 };
  if (Number.isFinite(ul) && ul > 1) {
    side = { x: -u.y / ul, y: u.x / ul };
  } else {
    side = safeNorm(L.sub(me.pos, threat.b.pos), L);
  }

  if (L.dot(side, threat.miss) > 0) side = L.scale(side, -1);
  const away = safeNorm(L.sub(me.pos, threat.b.pos), L);
  const dir = safeNorm(L.add(side, L.scale(away, 0.3)), L);

  let dv = L.scale(dir, 130);
  if (!isSafeDv(obs, L, me, dv, R)) {
    dv = L.scale(L.scale(dir, -1), 130);
    if (!isSafeDv(obs, L, me, dv, R)) {
      dv = L.scale(away, 130);
    }
  }
  return dv;
}

function enemyThreat(obs, L, me, R) {
  let best = null;
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    const d = L.sub(e.pos, me.pos);
    const dist = L.len(d);
    if (dist < 160) {
      const u = L.sub(e.vel, me.vel);
      const closing = -L.dot(d, u) / Math.max(dist, 1);
      if (closing > 5) {
        const dir = L.scale(d, -1 / Math.max(dist, 1));
        const strength = dist < 80 ? 150 : 100;
        if (!best || dist < best.dist) {
          best = { dist, e, dv: L.scale(dir, strength) };
        }
      }
    }
  }
  return best;
}

function makeEnemyDv(obs, L, me, e, R) {
  const d = L.sub(e.pos, me.pos);
  const dist = Math.max(L.len(d), 1);
  const dir = L.scale(d, -1 / dist);

  let dv = L.scale(dir, 140);
  if (!isSafeDv(obs, L, me, dv, R)) {
    const side = { x: -dir.y, y: dir.x };
    dv = L.scale(side, 140);
    if (!isSafeDv(obs, L, me, dv, R)) {
      dv = L.scale(L.scale(side, -1), 140);
    }
  }
  return dv;
}

function chooseHome(obs, L, me, mem, arenaR, R, target) {
  const planets = obs.planets;

  const valid = (p) => {
    const wantR = p.radius + 100;
    if (L.len(p.pos) + wantR > arenaR - 60) return false;
    for (const q of planets) {
      if (q === p) continue;
      const d = L.len(L.sub(p.pos, q.pos));
      if (d < wantR + q.radius + 60) return false;
    }
    return true;
  };

  if (mem.homeIdx >= 0 && mem.homeIdx < planets.length && valid(planets[mem.homeIdx])) {
    return planets[mem.homeIdx];
  }

  let bestIdx = -1;
  let bestScore = Infinity;

  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    if (!valid(p)) continue;

    let score = -p.mass * 0.001;
    score += L.len(p.pos) * 0.02;
    if (target) score += L.len(L.sub(target.pos, p.pos)) * 0.05;

    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  mem.homeIdx = bestIdx;
  mem.orbitSign = 0;
  return bestIdx >= 0 ? planets[bestIdx] : null;
}

function orbitDv(obs, L, me, home, mem, R) {
  if (!home) {
    const r = L.len(me.pos);
    let dv = L.scale(me.vel, -0.2);
    if (r > 1200) {
      const dir = L.scale(safeNorm(me.pos, L), -1);
      dv = L.add(dv, L.scale(dir, 40));
    }
    return dv;
  }

  const p = home;
  const rel = L.sub(me.pos, p.pos);
  const r = Math.max(L.len(rel), 1);
  const radial = L.scale(rel, 1 / r);
  const tang = { x: -radial.y, y: radial.x };

  let sign = mem.orbitSign;
  if (sign !== 1 && sign !== -1) {
    const dot = L.dot(L.sub(me.vel, p.vel), tang);
    if (Math.abs(dot) > 5) {
      sign = dot >= 0 ? 1 : -1;
    } else {
      const v0 = Math.sqrt((obs.G * p.mass) / Math.max(r, 1));
      const pos1a = L.add(L.add(p.pos, L.scale(p.vel, 1)), L.scale(tang, v0));
      const pos1b = L.add(L.add(p.pos, L.scale(p.vel, 1)), L.scale(tang, -v0));
      sign = L.len(pos1a) < L.len(pos1b) ? 1 : -1;
    }
    mem.orbitSign = sign;
  }

  const wantR = p.radius + 100;
  const vCirc = Math.sqrt((obs.G * p.mass) / Math.max(wantR, 1));
  const desired = L.add(
    L.add(p.vel, L.scale(tang, vCirc * sign)),
    L.scale(radial, (wantR - r) * 0.6)
  );
  return L.sub(desired, me.vel);
}

function gravityAim(obs, L, me, target, maxTime) {
  const W = obs.rules.weapon;
  const R = obs.rules.ship.radius;
  const speed = W.bulletSpeed;

  const lead = L.leadTarget(me, target, speed);
  if (!lead || !Number.isFinite(lead.time) || !Number.isFinite(lead.angle) || lead.time > maxTime) {
    return null;
  }

  const dist = L.len(L.sub(target.pos, me.pos));
  if (dist < 60) {
    const angle = L.angleTo(me.pos, target.pos);
    return { angle, miss: 0, blocked: false, t: 0 };
  }

  const horizon = Math.min(3, lead.time + 0.35);
  const step = 1 / 30;
  const ePath = L.predict(target, horizon, { step, radius: 0 }).points;
  if (!ePath.length) return null;

  const evaluate = (angle) => {
    if (!Number.isFinite(angle)) {
      return { angle, miss: Infinity, blocked: true, corr: 0, t: lead.time };
    }

    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const bullet = {
      pos: L.add(me.pos, L.scale(dir, R + 3)),
      vel: L.add(me.vel, L.scale(dir, speed))
    };

    const bp = L.predict(bullet, horizon, { step, radius: 0 });
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
    const corr = clamp(L.cross(dir, off) / range, -0.5, 0.5);

    return { angle, miss: best, blocked, corr, t: bp.points[at].t };
  };

  let ev = evaluate(lead.angle);
  for (let k = 0; k < 3 && ev.miss > R * 0.5; k++) {
    const next = evaluate(ev.angle + ev.corr);
    if (next.miss >= ev.miss) break;
    ev = next;
  }

  return ev;
}

export default function control(obs, mem) {
  try {
    const L = obs.lib;
    const me = obs.self;
    const rules = obs.rules;
    const R = rules.ship.radius;
    const arenaR = obs.arena.radius;
    if (!mem) mem = {};

    let target = null;
    let bestScore = Infinity;
    for (const e of obs.enemies) {
      if (!e.alive) continue;
      const dist = L.len(L.sub(e.pos, me.pos));
      const score = dist - 0.5 * e.hp;
      if (score < bestScore) {
        bestScore = score;
        target = e;
      }
    }

    const danger = computeDanger(obs, L, me, arenaR, R);
    if (danger && danger.t < 2.2 && me.fuel > 0) {
      return actionForDv(L, me, danger.dv, null, false);
    }

    const et = enemyThreat(obs, L, me, R);
    if (et && me.fuel > 0) {
      const dv = makeEnemyDv(obs, L, me, et.e, R);
      return actionForDv(L, me, dv, null, false);
    }

    let threat = incomingThreat(obs, L, me, R, 1.2);
    if (threat) threat = refineThreat(obs, L, me, threat, R);
    if (threat && threat.t < 1.0 && me.fuel > 0) {
      const dv = makeDodgeDv(obs, L, me, threat, R);
      return actionForDv(L, me, dv, null, false);
    }

    const home = chooseHome(obs, L, me, mem, arenaR, R, target);

    let aimAngle = null;
    let aimInfo = null;
    if (target) {
      const dist = L.len(L.sub(target.pos, me.pos));
      if (dist < 1900) {
        aimInfo = gravityAim(obs, L, me, target, 3.0);
        if (aimInfo) aimAngle = aimInfo.angle;
        else aimAngle = L.angleTo(me.pos, target.pos);
      } else {
        aimAngle = L.angleTo(me.pos, target.pos);
      }
    }

    let bestDv = orbitDv(obs, L, me, home, mem, R);

    if (target && me.fuel > 15) {
      const dist = L.len(L.sub(target.pos, me.pos));
      let cand = null;

      if (dist > 1000) {
        const toT = safeNorm(L.sub(target.pos, me.pos), L);
        const closing = L.dot(me.vel, toT);
        const adj = clamp(80 - closing, 0, 80);
        if (adj > 10) cand = L.scale(toT, adj);
      } else if (dist < 350) {
        const toT = safeNorm(L.sub(target.pos, me.pos), L);
        const closing = L.dot(me.vel, toT);
        const adj = clamp(60 + closing, 0, 60);
        if (adj > 10) cand = L.scale(toT, -adj);
      }

      if (cand && isSafeDv(obs, L, me, cand, R)) {
        bestDv = cand;
      }
    }

    if (target && aimInfo && aimInfo.blocked && me.fuel > 15) {
      const dist = L.len(L.sub(target.pos, me.pos));
      if (dist < 1200) {
        const toT = safeNorm(L.sub(target.pos, me.pos), L);
        const side = { x: -toT.y, y: toT.x };
        let cand = L.scale(side, 70);
        if (!isSafeDv(obs, L, me, cand, R)) {
          cand = L.scale(L.scale(side, -1), 70);
        }
        if (isSafeDv(obs, L, me, cand, R)) {
          bestDv = cand;
        }
      }
    }

    let fire = false;
    if (target && aimAngle != null && !me.overheated && me.cooldown <= 0 && me.ammo > 0) {
      const dist = L.len(L.sub(target.pos, me.pos));
      const heatLimit = target.hp <= 10 ? 90 : 80;

      if (me.heat < heatLimit) {
        const tol = Math.atan2(R * 0.8, Math.max(1, dist)) + 0.02;
        const aligned = Math.abs(L.wrapAngle(aimAngle - me.angle)) < tol;

        if (aligned) {
          if (aimInfo) {
            fire = !aimInfo.blocked && aimInfo.miss < R * 0.9;
          } else {
            fire = dist < 300;
          }
        }
      }
    }

    return actionForDv(L, me, bestDv, aimAngle, fire);
  } catch (err) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
