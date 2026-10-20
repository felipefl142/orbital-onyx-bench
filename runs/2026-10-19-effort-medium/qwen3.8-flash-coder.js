export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const rules = obs.rules;
  const w = rules.weapon;
  const ship = rules.ship;
  const arena = obs.arena;
  const planets = obs.planets;
  const enemies = obs.enemies;
  const bullets = obs.bullets;

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const wrap = L.wrapAngle;
  const add = L.add;
  const sub = L.sub;
  const scale = L.scale;
  const len = L.len;
  const dot = L.dot;
  const cross = L.cross;
  const angleTo = L.angleTo;
  const gravityAt = L.gravityAt;
  const predict = L.predict;
  const leadTarget = L.leadTarget;

  if (!mem || typeof mem !== "object") mem = {};
  if (mem.targetId == null) mem.targetId = null;
  if (mem.safeAngle == null) mem.safeAngle = null;
  if (mem.dangerTicks == null) mem.dangerTicks = 0;

  // Choose a target: weakest/closest, with stickiness.
  let target = null;
  let bestTargetScore = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = len(sub(e.pos, me.pos));
    let score = e.hp + d * 0.05;
    if (e.hp < 25) score -= 25;
    if (e.id === mem.targetId) score -= 8;
    if (score < bestTargetScore) {
      bestTargetScore = score;
      target = e;
    }
  }
  if (target) mem.targetId = target.id;

  // Gravity-corrected intercept aim.
  function computeAim() {
    if (!target) return null;

    const s = w.bulletSpeed;
    let lead = null;
    try {
      lead = leadTarget(me, target, s);
    } catch (_) {
      lead = null;
    }

    let angle = lead ? lead.angle : angleTo(me.pos, target.pos);
    let T = lead ? lead.time : len(sub(target.pos, me.pos)) / s;
    if (!Number.isFinite(T) || T < 0.05) T = 0.05;
    if (T > w.bulletLife) T = w.bulletLife;

    let bestAngle = angle;
    let bestErr = Infinity;
    let bestHit = false;

    for (let iter = 0; iter < 4; iter++) {
      const u = { x: Math.cos(angle), y: Math.sin(angle) };
      const bulletVel = add(scale(u, s), me.vel);

      let bp = null;
      let tp = null;
      try {
        bp = predict({ pos: me.pos, vel: bulletVel }, T, { step: 0.05 });
        tp = predict(target, T, { step: 0.05 });
      } catch (_) {
        break;
      }

      if (!bp || !tp || !bp.points || !tp.points) break;

      let minD = Infinity;
      let minIdx = 0;
      const n = Math.min(bp.points.length, tp.points.length);
      for (let i = 0; i < n; i++) {
        const d = len(sub(bp.points[i].pos, tp.points[i].pos));
        if (d < minD) {
          minD = d;
          minIdx = i;
        }
      }

      if (minD < bestErr) {
        bestErr = minD;
        bestAngle = angle;
        bestHit = !!bp.hit;
      }

      if (minD < 20) break;

      const time = Math.max(0.05, minIdx * 0.05);
      const err = sub(tp.points[minIdx].pos, bp.points[minIdx].pos);
      const delta = cross(u, err) / (s * time);
      angle = wrap(angle + delta);

      const newT = len(err) / s;
      if (Number.isFinite(newT) && newT > 0.05 && newT < w.bulletLife) T = newT;

      if (Math.abs(delta) < 0.001) break;
    }

    return { angle: bestAngle, time: T, err: bestErr, hit: bestHit };
  }

  const aim = computeAim();

  // Base action: aim at target, manage distance.
  let baseAngle = aim ? aim.angle : null;
  let baseThrust = 0;

  if (target && baseAngle != null) {
    const dist = len(sub(target.pos, me.pos));
    const desiredDist = 900;
    const closing = dot(sub(target.pos, me.pos), me.vel);

    if (dist > desiredDist) {
      baseThrust = clamp((dist - desiredDist) / 400, 0, 1);
    } else {
      baseThrust = 0;
    }

    if (dist < 300 && closing > 50) baseThrust = 0;
    if (me.fuel < 10) baseThrust *= me.fuel / 10;
  } else {
    baseAngle = mem.safeAngle != null ? mem.safeAngle : angleTo(me.pos, { x: 0, y: 0 });
    baseThrust = len(me.pos) > arena.radius - 300 ? 0.5 : 0;
  }

  // Precompute dangerous enemy bullet paths.
  const bulletPaths = [];
  const bulletLimit = Math.min(bullets.length, 12);
  const bulletSteps = 10;
  const step = 0.05;

  for (let i = 0; i < bulletLimit; i++) {
    const b = bullets[i];
    if (b.owner === me.id) continue;

    let pos = { x: b.pos.x, y: b.pos.y };
    let vel = { x: b.vel.x, y: b.vel.y };
    const pts = [];

    for (let j = 0; j <= bulletSteps; j++) {
      pts.push({ x: pos.x, y: pos.y });

      let hit = false;
      const tt = j * step;
      for (const p of planets) {
        const px = p.pos.x + p.vel.x * tt;
        const py = p.pos.y + p.vel.y * tt;
        const d = len({ x: px - pos.x, y: py - pos.y });
        if (d < p.radius + 1) {
          hit = true;
          break;
        }
      }
      if (hit) break;

      const g = gravityAt(pos, obs.t + tt);
      pos = add(pos, scale(vel, step));
      vel = add(vel, scale(g, step));
    }

    if (pts.length > 1) bulletPaths.push(pts);
  }

  // Safety score for an action.
  function evaluateAction(angle, thrust) {
    if (!Number.isFinite(angle)) angle = me.angle;
    thrust = clamp(thrust, 0, 1);

    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const mass = 1 + 0.5 * me.fuel / 100;
    const accel = 60 * thrust / mass;

    let pos = { x: me.pos.x, y: me.pos.y };
    let vel = { x: me.vel.x, y: me.vel.y };

    let minPlanet = 1000;
    let minBoundary = 1000;
    let minBullet = 1000;
    let minEnemy = 1000;

    for (let j = 0; j <= bulletSteps; j++) {
      const tt = j * step;

      for (const p of planets) {
        const px = p.pos.x + p.vel.x * tt;
        const py = p.pos.y + p.vel.y * tt;
        const d = len({ x: px - pos.x, y: py - pos.y });
        const margin = d - p.radius - ship.radius;
        if (margin < minPlanet) minPlanet = margin;
      }

      const r = len(pos);
      const bm = arena.radius - r - ship.radius;
      if (bm < minBoundary) minBoundary = bm;

      for (const pts of bulletPaths) {
        if (j < pts.length) {
          const d = len({ x: pts[j].x - pos.x, y: pts[j].y - pos.y });
          const margin = d - ship.radius - 10;
          if (margin < minBullet) minBullet = margin;
        }
      }

      for (const e of enemies) {
        if (!e.alive) continue;
        const ex = e.pos.x + e.vel.x * tt;
        const ey = e.pos.y + e.vel.y * tt;
        const d = len({ x: ex - pos.x, y: ey - pos.y });
        const margin = d - ship.radius - 12;
        if (margin < minEnemy) minEnemy = margin;
      }

      const g = gravityAt(pos, obs.t + tt);
      const a = add(g, scale(dir, accel));
      pos = add(pos, scale(vel, step));
      vel = add(vel, scale(a, step));
    }

    let safety = Math.min(minPlanet, minBoundary, minBullet, minEnemy);
    if (safety < 0) safety *= 10;

    safety += Math.min(100, minPlanet) + Math.min(100, minBoundary) +
              Math.min(100, minBullet) + Math.min(100, minEnemy);

    if (aim && aim.angle != null) {
      const err = Math.abs(wrap(aim.angle - angle));
      safety += Math.max(0, 0.1 - err) * 100;
    }

    return safety;
  }

  const baseScore = evaluateAction(baseAngle, baseThrust);
  const dangerThreshold = 35;

  if (baseScore >= dangerThreshold) {
    mem.dangerTicks = 0;
    mem.safeAngle = baseAngle;

    const err = wrap(baseAngle - me.angle);
    const turn = clamp(err * 3 - me.angVel * 0.15, -1, 1);

    let fire = false;
    if (target && aim && aim.angle != null) {
      const aimErr = Math.abs(wrap(aim.angle - me.angle));
      const dist = len(sub(target.pos, me.pos));

      if (
        me.cooldown <= 0 &&
        me.ammo > 0 &&
        !me.overheated &&
        me.heat <= 91 &&
        aimErr < 0.05 &&
        aim.time < w.bulletLife &&
        dist < 1600 &&
        !aim.hit
      ) {
        fire = true;
      }
    }

    return { thrust: baseThrust, turn, fire };
  }

  // Danger: choose safest escape direction.
  mem.dangerTicks = 3;

  let bestAngle = baseAngle;
  let bestThrust = baseThrust;
  let bestScore = baseScore;

  const maxThrust = me.fuel > 1 ? 1 : 0;

  for (let i = 0; i < 16; i++) {
    const angle = wrap(baseAngle + i * Math.PI / 8);
    const thrust = maxThrust;
    const score = evaluateAction(angle, thrust);

    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
      bestThrust = thrust;
    }
  }

  mem.safeAngle = bestAngle;

  const err = wrap(bestAngle - me.angle);
  const turn = clamp(err * 3 - me.angVel * 0.15, -1, 1);

  return { thrust: bestThrust, turn, fire: false };
}
