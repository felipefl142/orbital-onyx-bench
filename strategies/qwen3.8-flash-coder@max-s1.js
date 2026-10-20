function clamp(x, a, b) {
  if (!Number.isFinite(x)) return 0;
  if (x < a) return a;
  if (x > b) return b;
  return x;
}

function finite(x) {
  return Number.isFinite(x) ? x : 0;
}

function finiteOr(x, fallback) {
  return Number.isFinite(x) ? x : fallback;
}

function safeVec(v) {
  if (!v || typeof v !== "object") return { x: 0, y: 0 };
  return { x: finite(v.x), y: finite(v.y) };
}

function add(a, b) {
  a = safeVec(a);
  b = safeVec(b);
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a, b) {
  a = safeVec(a);
  b = safeVec(b);
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(v, k) {
  v = safeVec(v);
  k = finite(k);
  return { x: v.x * k, y: v.y * k };
}

function len(v) {
  v = safeVec(v);
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function norm(v) {
  v = safeVec(v);
  const l = len(v);
  if (l < 1e-6) return { x: 0, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

function dot(a, b) {
  a = safeVec(a);
  b = safeVec(b);
  return a.x * b.x + a.y * b.y;
}

function cross(a, b) {
  a = safeVec(a);
  b = safeVec(b);
  return a.x * b.y - a.y * b.x;
}

function wrapAngle(a) {
  a = finite(a);
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function angleTo(from, to) {
  const d = sub(to, from);
  return Math.atan2(d.y, d.x);
}

function safeMemGet(mem, key, fallback) {
  try {
    if (!mem || typeof mem !== "object") return fallback;
    const value = mem[key];
    return value === undefined ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function safeMemSet(mem, key, value) {
  try {
    if (mem && typeof mem === "object") mem[key] = value;
  } catch (e) {
    // ignore
  }
}

function safePredict(ctx, body, seconds, opts) {
  try {
    const horizon = Math.min(10, Math.max(0, finiteOr(seconds, Infinity)));
    const p = ctx.lib.predict(safeVec(body.pos) && body, horizon, opts);
    if (!p || typeof p !== "object") return null;

    if (!Array.isArray(p.points)) return null;

    const points = [];
    for (let i = 0; i < p.points.length; i++) {
      const pt = p.points[i];
      if (!pt || typeof pt !== "object") continue;
      points.push({
        t: finiteOr(pt.t, Infinity),
        pos: safeVec(pt.pos),
        vel: safeVec(pt.vel)
      });
    }

    let hit = null;
    if (p.hit && typeof p.hit === "object" && p.hit.planet != null) {
      const idx = Number(p.hit.planet);
      if (Number.isInteger(idx) && idx >= 0 && idx < ctx.planets.length) {
        hit = {
          planet: idx,
          t: finiteOr(p.hit.t, Infinity)
        };
      }
    }

    return {
      points,
      hit,
      leavesArena: !!p.leavesArena
    };
  } catch (e) {
    return null;
  }
}

function safeLead(ctx, shooter, target, bulletSpeed) {
  try {
    const lead = ctx.lib.leadTarget(shooter, target, bulletSpeed);
    if (!lead || typeof lead !== "object") return null;

    const time = finiteOr(lead.time, Infinity);
    if (time < 0) return null;

    return {
      angle: finiteOr(lead.angle, 0),
      time,
      point: safeVec(lead.point)
    };
  } catch (e) {
    return null;
  }
}

function safeGravityAt(ctx, pos, time) {
  try {
    return safeVec(ctx.lib.gravityAt(pos, time));
  } catch (e) {
    return { x: 0, y: 0 };
  }
}

function heaviest(ctx) {
  let best = null;
  for (const p of ctx.planets) {
    if (!best || finiteOr(p.mass, 0) > finiteOr(best.mass, 0)) best = p;
  }
  return best;
}

function nearestPlanet(ctx) {
  let best = null;
  for (const p of ctx.planets) {
    const dist = len(sub(ctx.self.pos, p.pos));
    if (!best || dist < best.dist) best = { p, dist };
  }
  return best;
}

function orbitBurn(ctx, home, wantR, gain) {
  const rel = sub(ctx.self.pos, home.pos);
  const r = Math.max(len(rel), 1);
  const radial = norm(rel);
  const tangent = { x: -radial.y, y: radial.x };
  const dirSign = dot(sub(ctx.self.vel, home.vel), tangent) >= 0 ? 1 : -1;

  const mass = Math.max(0, finiteOr(home.mass, 0));
  const vCirc = Math.sqrt((ctx.G * mass) / r);

  const want = add(
    add(home.vel, scale(tangent, vCirc * dirSign)),
    scale(radial, (wantR - r) * gain)
  );

  return sub(want, ctx.self.vel);
}

function danger(ctx, horizon) {
  const path = safePredict(ctx, ctx.self, horizon, {
    step: 1 / 20,
    radius: ctx.ship.radius + 20
  });

  if (!path) return null;

  if (path.hit) {
    const p = ctx.planets[path.hit.planet];
    if (!p) return null;

    const rel = sub(ctx.self.pos, p.pos);
    const r = Math.max(len(rel), 1);
    const radial = norm(rel);
    const tangent = { x: -radial.y, y: radial.x };
    const sgn = dot(sub(ctx.self.vel, p.vel), tangent) >= 0 ? 1 : -1;

    const dir = norm(add(scale(tangent, sgn), scale(radial, 0.8)));

    return {
      dir,
      t: finiteOr(path.hit.t, Infinity),
      type: "planet",
      planet: p
    };
  }

  const r = len(ctx.self.pos);
  const outward = dot(ctx.self.vel, norm(ctx.self.pos));

  if (path.leavesArena || (r > ctx.arenaRadius * 0.85 && outward > -20)) {
    return {
      dir: norm(scale(norm(ctx.self.pos), -1)),
      t: 3,
      type: "edge"
    };
  }

  return null;
}

function incoming(ctx, window) {
  const selfPath = safePredict(ctx, ctx.self, window, {
    step: 1 / 30,
    radius: 0
  });

  if (!selfPath || !selfPath.points.length) return null;

  let top = [];

  for (const b of ctx.bullets) {
    if (b.owner === ctx.self.id) continue;

    const d = sub(b.pos, ctx.self.pos);
    const u = sub(b.vel, ctx.self.vel);
    const uu = dot(u, u);

    if (uu < 1) continue;

    const t = -dot(d, u) / uu;
    if (t <= 0 || t > window || t > b.ttl) continue;

    const miss = len(add(d, scale(u, t)));
    if (miss < ctx.ship.radius * 4) top.push({ b, t, miss, u });
  }

  top.sort((a, b) => a.t - b.t);
  top = top.slice(0, 6);

  let threat = null;

  for (const item of top) {
    const bp = safePredict(ctx, item.b, Math.min(window, item.b.ttl), {
      step: 1 / 30,
      radius: 0
    });

    if (!bp) continue;
    if (bp.hit && bp.hit.t <= item.t) continue;

    let best = Infinity;
    let bestT = 0;
    let bestBulletPos = null;
    let bestSelfPos = null;
    let bestRelVel = null;

    for (let i = 0; i < bp.points.length && i < selfPath.points.length; i++) {
      const dd = len(sub(bp.points[i].pos, selfPath.points[i].pos));
      if (dd < best) {
        best = dd;
        bestT = bp.points[i].t;
        bestBulletPos = bp.points[i].pos;
        bestSelfPos = selfPath.points[i].pos;
        bestRelVel = sub(bp.points[i].vel, selfPath.points[i].vel);
      }
    }

    if (best < ctx.ship.radius * 3 && (!threat || bestT < threat.t)) {
      let side = norm({ x: -bestRelVel.y, y: bestRelVel.x });

      if (len(side) < 1e-6) side = norm(ctx.self.vel);
      if (len(side) < 1e-6) side = { x: Math.cos(ctx.self.angle), y: Math.sin(ctx.self.angle) };

      const offset = sub(bestBulletPos, bestSelfPos);
      const dir = norm(scale(side, dot(side, offset) > 0 ? -1 : 1));

      threat = {
        t: bestT,
        miss: best,
        dir,
        bullet: item.b
      };
    }
  }

  return threat;
}

function collisionThreat(ctx, window) {
  let best = null;

  for (const e of ctx.enemies) {
    const d = sub(e.pos, ctx.self.pos);
    const u = sub(e.vel, ctx.self.vel);
    const uu = dot(u, u);

    if (uu < 1) continue;

    const t = -dot(d, u) / uu;
    if (t <= 0 || t > window) continue;

    const miss = len(add(d, scale(u, t)));
    if (miss < ctx.ship.radius * 3) {
      const side = norm({ x: -u.y, y: u.x });
      if (len(side) < 1e-6) continue;

      const toEnemy = norm(d);
      const dir = norm(scale(side, dot(side, toEnemy) > 0 ? -1 : 1));

      if (!best || t < best.t) {
        best = { t, miss, dir, enemy: e };
      }
    }
  }

  return best;
}

function gravityAim(ctx, target, maxTime) {
  const lead = safeLead(ctx, ctx.self, target, ctx.weapon.bulletSpeed);
  if (!lead || lead.time > maxTime) return null;

  const horizon = Math.min(3, lead.time + 0.4);
  const ePred = safePredict(ctx, target, horizon, {
    step: 1 / 30,
    radius: 0
  });

  if (!ePred || !ePred.points.length) return null;

  const ePath = ePred.points;

  const evaluate = (angle) => {
    angle = finiteOr(angle, 0);

    const dir = { x: Math.cos(angle), y: Math.sin(angle) };

    const bullet = {
      pos: add(ctx.self.pos, scale(dir, ctx.ship.radius + 3)),
      vel: add(ctx.self.vel, scale(dir, ctx.weapon.bulletSpeed))
    };

    const bp = safePredict(ctx, bullet, horizon, {
      step: 1 / 30,
      radius: 0
    });

    if (!bp || !bp.points.length) {
      return {
        angle,
        miss: Infinity,
        blocked: true,
        corr: 0,
        t: lead.time
      };
    }

    let best = Infinity;
    let at = -1;

    for (let i = 0; i < bp.points.length && i < ePath.length; i++) {
      const dd = len(sub(bp.points[i].pos, ePath[i].pos));
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
        t: lead.time
      };
    }

    const atTime = bp.points[at].t;

    const blocked =
      (!!bp.hit && bp.hit.t <= atTime) ||
      (!!ePred.hit && ePred.hit.t <= ePath[at].t);

    const off = sub(ePath[at].pos, bp.points[at].pos);
    const range = Math.max(1, len(sub(ePath[at].pos, ctx.self.pos)));

    return {
      angle,
      miss: best,
      blocked,
      corr: cross(dir, off) / range,
      t: atTime
    };
  };

  let ev = evaluate(lead.angle);

  for (let k = 0; k < 2 && ev.miss > ctx.ship.radius * 0.5; k++) {
    const next = evaluate(ev.angle + ev.corr);
    if (next.miss >= ev.miss) break;
    ev = next;
  }

  for (const delta of [-0.04, 0.04, -0.08, 0.08]) {
    const next = evaluate(ev.angle + delta);
    if (next.miss < ev.miss && !next.blocked) ev = next;
  }

  return ev;
}

function chooseTarget(ctx, mem, enemies) {
  const top = [];

  for (const e of enemies) {
    const dist = len(sub(e.pos, ctx.self.pos));
    top.push({ e, dist });

    if (top.length > 3) {
      top.sort((a, b) => a.dist - b.dist);
      top.pop();
    }
  }

  top.sort((a, b) => a.dist - b.dist);

  let best = null;

  for (const item of top) {
    const aim = gravityAim(ctx, item.e, 2.5);

    let score = item.dist;

    if (aim) {
      if (aim.blocked) score += 1000;
      else score += finiteOr(aim.miss, Infinity) * 100 + finiteOr(aim.t, Infinity) * 50;
    } else {
      score += 500;
    }

    score += finiteOr(item.e.hp, 0) * 2;

    const targetId = safeMemGet(mem, "targetId", null);
    if (targetId && item.e.id === targetId) score -= 150;

    if (!best || score < best.score) {
      best = {
        e: item.e,
        dist: item.dist,
        aim,
        score
      };
    }
  }

  if (best) safeMemSet(mem, "targetId", best.e.id);

  return best;
}

function simulateSafety(ctx, dir, horizon, step, thrust) {
  const pos = safeVec(ctx.self.pos);
  const vel = safeVec(ctx.self.vel);

  const fuelMax = Math.max(1, finiteOr(ctx.ship.fuelMax, 85));
  const mass = 1 + 0.5 * finiteOr(ctx.self.fuel, 0) / fuelMax;
  const accel = finiteOr(ctx.ship.thrustForce, 60) * finiteOr(thrust, 0) / mass;

  const planets = ctx.planets.map((p) => ({
    pos: safeVec(p.pos),
    vel: safeVec(p.vel),
    radius: finiteOr(p.radius, 0)
  }));

  const enemies = ctx.enemies.map((e) => ({
    pos: safeVec(e.pos),
    vel: safeVec(e.vel)
  }));

  let minPlanet = Infinity;
  let minEdge = finiteOr(ctx.arenaRadius, 2000);
  let minEnemy = Infinity;

  let hit = false;
  let edgeHit = false;
  let enemyHit = false;

  const R = finiteOr(ctx.ship.radius, 12);

  const check = () => {
    for (const p of planets) {
      const dx = pos.x - p.pos.x;
      const dy = pos.y - p.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);

      if (d < minPlanet) minPlanet = d;
      if (d < R + p.radius) hit = true;
    }

    const r = Math.sqrt(pos.x * pos.x + pos.y * pos.y);
    const edge = finiteOr(ctx.arenaRadius, 2000) - r;

    if (edge < minEdge) minEdge = edge;
    if (edge < 0) edgeHit = true;

    for (const e of enemies) {
      const dx = pos.x - e.pos.x;
      const dy = pos.y - e.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);

      if (d < minEnemy) minEnemy = d;
      if (d < R + R) enemyHit = true;
    }
  };

  check();

  const maxHorizon = Math.max(0, finiteOr(horizon, 3));
  const maxStep = Math.max(1e-6, finiteOr(step, 0.025));

  let t = 0;

  while (t < maxHorizon) {
    const g = safeGravityAt(ctx, pos, ctx.t + t);

    vel.x += g.x * maxStep;
    vel.y += g.y * maxStep;

    if (thrust > 0) {
      vel.x += dir.x * accel * maxStep;
      vel.y += dir.y * accel * maxStep;
    }

    pos.x += vel.x * maxStep;
    pos.y += vel.y * maxStep;

    for (const p of planets) {
      p.pos.x += p.vel.x * maxStep;
      p.pos.y += p.vel.y * maxStep;
    }

    for (const e of enemies) {
      e.pos.x += e.vel.x * maxStep;
      e.pos.y += e.vel.y * maxStep;
    }

    t += maxStep;
    check();
  }

  return {
    hit,
    edgeHit,
    enemyHit,
    minPlanet,
    minEdge,
    minEnemy
  };
}

function threatMissForDir(ctx, threat, dir, horizon, thrust) {
  if (!threat || !threat.bullet) return Infinity;

  const pos = safeVec(ctx.self.pos);
  const vel = safeVec(ctx.self.vel);

  const bpos = safeVec(threat.bullet.pos);
  const bvel = safeVec(threat.bullet.vel);

  const fuelMax = Math.max(1, finiteOr(ctx.ship.fuelMax, 85));
  const mass = 1 + 0.5 * finiteOr(ctx.self.fuel, 0) / fuelMax;
  const accel = finiteOr(ctx.ship.thrustForce, 60) * finiteOr(thrust, 0) / mass;

  const step = 0.02;
  const tMax = Math.min(
    finiteOr(threat.t, Infinity),
    finiteOr(horizon, 3),
    finiteOr(threat.bullet.ttl, Infinity)
  );

  if (tMax <= 0) return Infinity;

  let best = Infinity;
  let t = 0;

  while (t <= tMax) {
    const gSelf = safeGravityAt(ctx, pos, ctx.t + t);
    const gBullet = safeGravityAt(ctx, bpos, ctx.t + t);

    vel.x += gSelf.x * step;
    vel.y += gSelf.y * step;

    bvel.x += gBullet.x * step;
    bvel.y += gBullet.y * step;

    if (thrust > 0) {
      vel.x += dir.x * accel * step;
      vel.y += dir.y * accel * step;
    }

    pos.x += vel.x * step;
    pos.y += vel.y * step;

    bpos.x += bvel.x * step;
    bpos.y += bvel.y * step;

    const dx = bpos.x - pos.x;
    const dy = bpos.y - pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d < best) best = d;
    if (d < finiteOr(ctx.ship.radius, 12)) break;

    t += step;
  }

  return best;
}

function addCandidate(candidates, dir, priority, thrustNeeded, aimMiss, threatMiss) {
  if (!candidates || !Array.isArray(candidates)) return;

  dir = safeVec(dir);
  const l = len(dir);
  if (l < 1e-6) return;

  candidates.push({
    dir: { x: dir.x / l, y: dir.y / l },
    priority: finiteOr(priority, 0),
    thrustNeeded: finiteOr(thrustNeeded, 0),
    aimMiss: finiteOr(aimMiss, Infinity),
    threatMiss: finiteOr(threatMiss, Infinity)
  });
}

function chooseBest(ctx, candidates, horizon, thrustCap, threat) {
  if (!Array.isArray(candidates) || !candidates.length) {
    const angle = finiteOr(ctx.self.angle, 0);
    candidates = [{
      dir: { x: Math.cos(angle), y: Math.sin(angle) },
      priority: 0,
      thrustNeeded: 0,
      aimMiss: Infinity,
      threatMiss: Infinity
    }];
  }

  candidates = candidates.slice(0, 10);

  let best = null;

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;

    const dir = norm(c.dir);
    if (len(dir) < 1e-6) continue;

    const angle = Math.atan2(dir.y, dir.x);
    const err = wrapAngle(angle - ctx.self.angle);

    if (!Number.isFinite(err)) continue;

    const turn = clamp(err * 3 - ctx.self.angVel * 0.15, -1, 1);
    if (!Number.isFinite(turn)) continue;

    const aligned = Math.abs(err) < 0.45;
    const thrust = thrustCap > 0 && aligned ? clamp(c.thrustNeeded, 0, thrustCap) : 0;

    if (!Number.isFinite(thrust)) thrust = 0;

    const safety = simulateSafety(ctx, dir, horizon, 0.025, thrust);

    let score = finiteOr(c.priority, 0);

    if (safety.hit) score += 10000;
    if (safety.edgeHit) score += 5000;
    if (safety.enemyHit) score += 2000;

    score -= Math.min(finiteOr(safety.minPlanet, Infinity), 500) * 10;
    score -= Math.min(finiteOr(safety.minEdge, Infinity), 500) * 10;
    score -= Math.min(finiteOr(safety.minEnemy, Infinity), 300) * 5;

    score += Math.abs(err) * 200;
    score += thrust * 30;

    if (threat) {
      const tm = threatMissForDir(
        ctx,
        threat,
        dir,
        Math.min(horizon, finiteOr(threat.t, Infinity)),
        thrust
      );

      if (Number.isFinite(tm)) score -= Math.min(tm, 500) * 10;
    }

    score += finiteOr(c.aimMiss, Infinity) * 10;

    if (!Number.isFinite(score)) score = Infinity;

    if (!best || score < best.score) {
      best = {
        score,
        dir,
        turn,
        thrust,
        aligned,
        aimMiss: c.aimMiss
      };
    }
  }

  if (!best) {
    const angle = finiteOr(ctx.self.angle, 0);
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const err = wrapAngle(angle - ctx.self.angle);
    const turn = clamp(err * 3 - ctx.self.angVel * 0.15, -1, 1);

    best = {
      score: Infinity,
      dir,
      turn: Number.isFinite(turn) ? turn : 0,
      thrust: 0,
      aligned: true,
      aimMiss: Infinity
    };
  }

  return best;
}

function buildSurvivalCandidates(ctx, mem, d, threat, collision) {
  const candidates = [];

  if (d) addCandidate(candidates, d.dir, 0, 1, Infinity, Infinity);
  if (threat) addCandidate(candidates, threat.dir, 10, 1, Infinity, Infinity);
  if (collision) addCandidate(candidates, collision.dir, 20, 1, Infinity, Infinity);

  const edgeDir = norm(scale(norm(ctx.self.pos), -1));
  if (edgeDir) addCandidate(candidates, edgeDir, 30, 1, Infinity, Infinity);

  const home = heaviest(ctx);
  if (home) {
    const r = Math.max(len(sub(ctx.self.pos, home.pos)), finiteOr(home.radius, 0) + 100);
    const dv = orbitBurn(ctx, home, r, 0.2);
    addCandidate(candidates, dv, 40, 0.5, Infinity, Infinity);
  }

  const nearest = nearestPlanet(ctx);
  if (nearest) addCandidate(candidates, norm(sub(ctx.self.pos, nearest.p.pos)), 45, 0.5, Infinity, Infinity);

  addCandidate(candidates, norm(ctx.self.vel), 50, 0.2, Infinity, Infinity);
  addCandidate(candidates, { x: Math.cos(ctx.self.angle), y: Math.sin(ctx.self.angle) }, 60, 0.2, Infinity, Infinity);

  return candidates;
}

function buildCombatCandidates(ctx, mem, target, aim, d, threat, collision) {
  const candidates = [];

  if (d) addCandidate(candidates, d.dir, 0, 1, Infinity, Infinity);
  if (threat) addCandidate(candidates, threat.dir, 10, 1, Infinity, Infinity);
  if (collision) addCandidate(candidates, collision.dir, 20, 1, Infinity, Infinity);

  if (aim) {
    addCandidate(
      candidates,
      { x: Math.cos(aim.angle), y: Math.sin(aim.angle) },
      30,
      0.2,
      aim.miss,
      Infinity
    );
  }

  if (target) {
    const targetDir = norm(sub(target.pos, ctx.self.pos));
    addCandidate(candidates, targetDir, 40, target.dist > 1200 ? 0.5 : 0.2, Infinity, Infinity);
  }

  const home = heaviest(ctx);
  if (home) {
    const r = Math.max(len(sub(ctx.self.pos, home.pos)), finiteOr(home.radius, 0) + 100);
    const dv = orbitBurn(ctx, home, r, 0.2);
    addCandidate(candidates, dv, 50, 0.3, Infinity, Infinity);
  }

  const nearest = nearestPlanet(ctx);
  if (nearest) addCandidate(candidates, norm(sub(ctx.self.pos, nearest.p.pos)), 45, 0.5, Infinity, Infinity);

  const edgeDir = norm(scale(norm(ctx.self.pos), -1));
  if (edgeDir) addCandidate(candidates, edgeDir, 35, 0.5, Infinity, Infinity);

  addCandidate(candidates, norm(ctx.self.vel), 60, 0.2, Infinity, Infinity);
  addCandidate(candidates, { x: Math.cos(ctx.self.angle), y: Math.sin(ctx.self.angle) }, 70, 0.2, Infinity, Infinity);

  return candidates;
}

function canFire(ctx, mem, aim, target, best, threat, d, collision) {
  if (!aim || aim.blocked) return false;

  const R = finiteOr(ctx.ship.radius, 12);
  const aimMiss = finiteOr(aim.miss, Infinity);

  if (aimMiss > R * 0.8) return false;

  if (ctx.self.overheated || ctx.self.ammo <= 0 || ctx.self.cooldown > 0) return false;

  let heatLimit = safeMemGet(mem, "heatLimit", 75);
  if (!Number.isFinite(heatLimit)) heatLimit = 75;
  safeMemSet(mem, "heatLimit", heatLimit);

  if (ctx.self.heat > heatLimit) return false;

  if (threat && finiteOr(threat.t, Infinity) < 1.0) return false;
  if (d && finiteOr(d.t, Infinity) < 1.5) return false;
  if (collision && finiteOr(collision.t, Infinity) < 0.8) return false;

  if (!target) return false;

  const dist = Math.max(1, len(sub(target.pos, ctx.self.pos)));
  const err = Math.abs(wrapAngle(aim.angle - ctx.self.angle));
  const aligned = err < Math.max(0.015, R * 0.6 / dist) + 0.01;

  if (!aligned) return false;

  const bestMiss = finiteOr(best && best.aimMiss, Infinity);
  if (bestMiss > R * 0.8) return false;

  return true;
}

function steer(ctx, targetAngle, gain) {
  const err = wrapAngle(targetAngle - ctx.self.angle);
  const turn = clamp(err * gain - ctx.self.angVel * 0.15, -1, 1);
  return { err, turn };
}

export default function control(obs, mem) {
  try {
    if (!mem || typeof mem !== "object") mem = {};

    if (!obs || typeof obs !== "object") {
      return { thrust: 0, turn: 0, fire: false };
    }

    const lib = obs.lib;
    if (!lib || typeof lib !== "object") {
      return { thrust: 0, turn: 0, fire: false };
    }

    if (
      typeof lib.predict !== "function" ||
      typeof lib.gravityAt !== "function" ||
      typeof lib.leadTarget !== "function"
    ) {
      return { thrust: 0, turn: 0, fire: false };
    }

    const rules = obs.rules && typeof obs.rules === "object" ? obs.rules : {};
    const ship = rules.ship && typeof rules.ship === "object" ? rules.ship : {};
    const weapon = rules.weapon && typeof rules.weapon === "object" ? rules.weapon : {};

    const arenaRadius = finiteOr(obs.arena && obs.arena.radius, 2000);
    const G = finiteOr(obs.G, 1000);
    const t = finiteOr(obs.t, 0);

    const self = {
      id: obs.self && obs.self.id != null ? String(obs.self.id) : "self",
      pos: safeVec(obs.self && obs.self.pos),
      vel: safeVec(obs.self && obs.self.vel),
      angle: finiteOr(obs.self && obs.self.angle, 0),
      angVel: finiteOr(obs.self && obs.self.angVel, 0),
      hp: finiteOr(obs.self && obs.self.hp, 0),
      fuel: finiteOr(obs.self && obs.self.fuel, 0),
      ammo: finiteOr(obs.self && obs.self.ammo, 0),
      heat: finiteOr(obs.self && obs.self.heat, 0),
      cooldown: finiteOr(obs.self && obs.self.cooldown, 0),
      overheated: !!(obs.self && obs.self.overheated)
    };

    const planets = Array.isArray(obs.planets)
      ? obs.planets.map((p) => ({
          pos: safeVec(p && p.pos),
          vel: safeVec(p && p.vel),
          radius: finiteOr(p && p.radius, 0),
          mass: finiteOr(p && p.mass, 0)
        }))
      : [];

    const enemies = Array.isArray(obs.enemies)
      ? obs.enemies
          .filter((e) => e && e.alive)
          .map((e) => ({
            id: e.id != null ? String(e.id) : "",
            pos: safeVec(e.pos),
            vel: safeVec(e.vel),
            angle: finiteOr(e.angle, 0),
            hp: finiteOr(e.hp, 0),
            alive: true
          }))
      : [];

    const bullets = Array.isArray(obs.bullets)
      ? obs.bullets.map((b) => ({
          pos: safeVec(b && b.pos),
          vel: safeVec(b && b.vel),
          owner: b && b.owner != null ? String(b.owner) : "",
          ttl: finiteOr(b && b.ttl, 0)
        }))
      : [];

    const ctx = {
      lib,
      t,
      arenaRadius,
      G,
      self,
      planets,
      enemies,
      bullets,
      ship: {
        radius: finiteOr(ship.radius, 12),
        fuelMax: finiteOr(ship.fuelMax, 85),
        thrustForce: finiteOr(ship.thrustForce, 60)
      },
      weapon: {
        bulletSpeed: finiteOr(weapon.bulletSpeed, 600)
      }
    };

    const fuelReserve = 15;
    let thrustCap = ctx.self.fuel > fuelReserve ? 1 : ctx.self.fuel > 5 ? 0.5 : 0;

    const d = danger(ctx, 3);
    const threat = incoming(ctx, 1.5);
    const collision = collisionThreat(ctx, 1.0);

    if (
      (d && finiteOr(d.t, Infinity) < 2.5) ||
      (threat && finiteOr(threat.t, Infinity) < 0.8) ||
      (collision && finiteOr(collision.t, Infinity) < 0.8)
    ) {
      thrustCap = ctx.self.fuel > 0 ? 1 : 0;
    }

    if (!enemies.length) {
      const candidates = buildSurvivalCandidates(ctx, mem, d, threat, collision);
      const best = chooseBest(ctx, candidates, 3, thrustCap, threat);

      return {
        thrust: clamp(best.thrust, 0, 1),
        turn: clamp(best.turn, -1, 1),
        fire: false
      };
    }

    const target = chooseTarget(ctx, mem, enemies);

    if (!target) {
      const candidates = buildSurvivalCandidates(ctx, mem, d, threat, collision);
      const best = chooseBest(ctx, candidates, 3, thrustCap, threat);

      return {
        thrust: clamp(best.thrust, 0, 1),
        turn: clamp(best.turn, -1, 1),
        fire: false
      };
    }

    const aim = target.aim;

    const candidates = buildCombatCandidates(ctx, mem, target, aim, d, threat, collision);
    const best = chooseBest(ctx, candidates, 3, thrustCap, threat);

    const fire = canFire(ctx, mem, aim, target, best, threat, d, collision);

    if (fire) {
      const turn = clamp(steer(ctx, aim.angle, 3).turn, -1, 1);

      let thrust = 0;

      if (best && best.thrust > 0) {
        const bestAngle = Math.atan2(best.dir.y, best.dir.x);
        if (Math.abs(wrapAngle(bestAngle - aim.angle)) < 0.25) {
          thrust = clamp(best.thrust, 0, 1);
        }
      }

      return {
        thrust,
        turn,
        fire: true
      };
    }

    return {
      thrust: clamp(best.thrust, 0, 1),
      turn: clamp(best.turn, -1, 1),
      fire: false
    };
  } catch (e) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
