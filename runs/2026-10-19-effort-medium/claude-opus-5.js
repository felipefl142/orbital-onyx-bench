// ORBITAL ONYX entry: gravity-aware gunnery + layered safety steering.

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

// Gravity accel at (x,y) at relative time t (planets drift linearly).
function gravAt(planets, G, x, y, t) {
  let ax = 0, ay = 0;
  for (let k = 0; k < planets.length; k++) {
    const p = planets[k];
    const pv = p.vel || { x: 0, y: 0 };
    const px = p.pos.x + pv.x * t, py = p.pos.y + pv.y * t;
    const dx = px - x, dy = py - y;
    const eps = 0.5 * p.radius;
    const s = dx * dx + dy * dy + eps * eps;
    const f = G * p.mass / (s * Math.sqrt(s));
    ax += dx * f; ay += dy * f;
  }
  return [ax, ay];
}

// Predict enemy path (free fall + decaying estimate of their thrust).
function enemyPath(planets, G, e, h, N, eax, eay) {
  const arr = new Array(N * 4);
  let x = e.pos.x, y = e.pos.y, vx = e.vel.x, vy = e.vel.y;
  for (let i = 0; i < N; i++) {
    const t = i * h;
    arr[i * 4] = x; arr[i * 4 + 1] = y; arr[i * 4 + 2] = vx; arr[i * 4 + 3] = vy;
    const g = gravAt(planets, G, x, y, t);
    let w = 1 - t / 1.4; if (w < 0) w = 0;
    vx += (g[0] + eax * w) * h; vy += (g[1] + eay * w) * h;
    x += vx * h; y += vy * h;
  }
  return arr;
}

// Simulate a bullet fired at `angle`; return closest approach to enemy path.
function simBullet(obs, angle, epath, h, N) {
  const me = obs.self, planets = obs.planets, G = obs.G;
  const bs = obs.rules.weapon.bulletSpeed;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  let x = me.pos.x + ca * 13, y = me.pos.y + sa * 13;
  let vx = me.vel.x + ca * bs, vy = me.vel.y + sa * bs;
  let best = 1e9, bt = 0;
  const AR = obs.arena.radius + 60;
  for (let i = 0; i < N; i++) {
    const t = i * h;
    const ex = epath[i * 4], ey = epath[i * 4 + 1];
    const rpx = x - ex, rpy = y - ey;
    const rvx = vx - epath[i * 4 + 2], rvy = vy - epath[i * 4 + 3];
    const rv2 = rvx * rvx + rvy * rvy;
    let tc = rv2 > 1e-9 ? -(rpx * rvx + rpy * rvy) / rv2 : 0;
    if (tc < 0) tc = 0; else if (tc > h) tc = h;
    const mx = rpx + rvx * tc, my = rpy + rvy * tc;
    const d = Math.sqrt(mx * mx + my * my);
    if (d < best) { best = d; bt = t + tc; }
    let ax = 0, ay = 0, dead = false;
    for (let k = 0; k < planets.length; k++) {
      const p = planets[k];
      const pv = p.vel || { x: 0, y: 0 };
      const px = p.pos.x + pv.x * t, py = p.pos.y + pv.y * t;
      const dx = px - x, dy = py - y;
      const r2 = dx * dx + dy * dy;
      if (r2 < p.radius * p.radius) { dead = true; break; }
      const eps = 0.5 * p.radius;
      const s = r2 + eps * eps;
      const f = G * p.mass / (s * Math.sqrt(s));
      ax += dx * f; ay += dy * f;
    }
    if (dead) break;
    vx += ax * h; vy += ay * h; x += vx * h; y += vy * h;
    if (x * x + y * y > AR * AR) break;
  }
  return { miss: best, t: bt };
}

export default function control(obs, mem) {
  const safe = { thrust: 0, turn: 0, fire: false };
  try {
    const L = obs.lib;
    const me = obs.self;
    const planets = obs.planets || [];
    const G = obs.G;
    const AR = obs.arena.radius;
    if (!mem.init) {
      mem.init = 1; mem.sgn = 1; mem.ev = {}; mem.ea = {}; mem.flip = 0;
    }

    // ---- target selection ----
    let tgt = null, tgtD = Infinity;
    for (let i = 0; i < obs.enemies.length; i++) {
      const e = obs.enemies[i];
      if (!e.alive) continue;
      const dx = e.pos.x - me.pos.x, dy = e.pos.y - me.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const score = d - (100 - e.hp) * 2.0;
      if (score < tgtD) { tgtD = score; tgt = e; }
    }
    let dist = 0;
    if (tgt) {
      const dx = tgt.pos.x - me.pos.x, dy = tgt.pos.y - me.pos.y;
      dist = Math.sqrt(dx * dx + dy * dy);
    }

    // ---- estimate enemy thrust accel (smoothed) ----
    let eax = 0, eay = 0;
    if (tgt) {
      const id = tgt.id;
      const prev = mem.ev[id];
      const dt = obs.dtDecision > 0 ? obs.dtDecision : 0.05;
      if (prev) {
        const g = gravAt(planets, G, tgt.pos.x, tgt.pos.y, 0);
        let ax = (tgt.vel.x - prev[0]) / dt - g[0];
        let ay = (tgt.vel.y - prev[1]) / dt - g[1];
        const m = Math.sqrt(ax * ax + ay * ay);
        if (!isFinite(m)) { ax = 0; ay = 0; }
        else if (m > 45) { ax = ax * 45 / m; ay = ay * 45 / m; }
        const old = mem.ea[id] || [0, 0];
        eax = old[0] * 0.55 + ax * 0.45;
        eay = old[1] * 0.55 + ay * 0.45;
        mem.ea[id] = [eax, eay];
      }
      mem.ev[id] = [tgt.vel.x, tgt.vel.y];
    }

    // ---- gunnery ----
    let aimAngle = me.angle;
    let bestMiss = 1e9;
    let fireMiss = 1e9;
    const h = 0.025;
    if (tgt && dist < 1500) {
      let N = Math.ceil((dist / 560) / h) + 16;
      if (N < 36) N = 36; if (N > 104) N = 104;
      const epath = enemyPath(planets, G, tgt, h, N, eax, eay);
      const lead = L.leadTarget(me, tgt, obs.rules.weapon.bulletSpeed);
      const base = lead ? lead.angle : L.angleTo(me.pos, tgt.pos);
      // coarse scan
      let bA = base;
      for (let i = -4; i <= 4; i++) {
        const a = base + i * 0.075;
        const r = simBullet(obs, a, epath, h, N);
        if (r.miss < bestMiss) { bestMiss = r.miss; bA = a; }
      }
      // fine scan
      for (let i = -2; i <= 2; i++) {
        if (i === 0) continue;
        const a = bA + i * 0.019;
        const r = simBullet(obs, a, epath, h, N);
        if (r.miss < bestMiss) { bestMiss = r.miss; aimAngle = a; }
      }
      if (aimAngle === me.angle) aimAngle = bA;
      if (bestMiss < 1e8 && Math.abs(L.wrapAngle(aimAngle - bA)) > 0.2) aimAngle = bA;
      // honest check from the current nose direction
      const cur = simBullet(obs, me.angle, epath, h, N);
      fireMiss = cur.miss;
    } else if (tgt) {
      aimAngle = L.angleTo(me.pos, tgt.pos);
    }

    // ---- desired acceleration field ----
    let ax = 0, ay = 0;
    let emergency = false;

    // planet repulsion
    let nearSurf = 1e9;
    for (let k = 0; k < planets.length; k++) {
      const p = planets[k];
      const dx = me.pos.x - p.pos.x, dy = me.pos.y - p.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const surf = d - p.radius - 12;
      if (surf < nearSurf) nearSurf = surf;
      const vr = (me.vel.x * dx + me.vel.y * dy) / d;
      const lim = p.radius * 1.6 + 220;
      if (surf < lim) {
        let w = (lim - surf) / lim;
        w = w * w;
        ax += (dx / d) * w * 700;
        ay += (dy / d) * w * 700;
        // add tangential (orbital) component to escape radial fall
        if (vr < -5) {
          const tx = -dy / d, ty = dx / d;
          const s = (me.vel.x * tx + me.vel.y * ty) >= 0 ? 1 : -1;
          ax += tx * s * w * 500;
          ay += ty * s * w * 500;
        }
        if (surf < 110 || (vr < 0 && surf / (-vr) < 2.2)) emergency = true;
      }
    }

    // free-fall collision check
    try {
      const pr = L.predict({ pos: me.pos, vel: me.vel }, 3.2, { step: 0.05, radius: 12 });
      if (pr && pr.hit) {
        const p = planets[pr.hit.planet];
        if (p) {
          const dx = me.pos.x - p.pos.x, dy = me.pos.y - p.pos.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          const w = clamp((3.2 - pr.hit.t) / 3.2, 0, 1);
          ax += (dx / d) * w * 900;
          ay += (dy / d) * w * 900;
          const tx = -dy / d, ty = dx / d;
          const s = (me.vel.x * tx + me.vel.y * ty) >= 0 ? 1 : -1;
          ax += tx * s * w * 700;
          ay += ty * s * w * 700;
          if (pr.hit.t < 1.8) emergency = true;
        }
      }
    } catch (e) { /* ignore */ }

    // arena containment
    const r = Math.sqrt(me.pos.x * me.pos.x + me.pos.y * me.pos.y) || 1e-6;
    const vrad = (me.vel.x * me.pos.x + me.vel.y * me.pos.y) / r;
    const future = r + vrad * 2.5;
    if (r > AR * 0.62 || future > AR - 120) {
      let w = Math.max((r - AR * 0.62) / (AR * 0.38), (future - (AR - 120)) / 400);
      w = clamp(w, 0, 1.6);
      ax -= (me.pos.x / r) * w * 800;
      ay -= (me.pos.y / r) * w * 800;
      if (r > AR - 60 || future > AR + 60) emergency = true;
    }

    // bullet dodging
    const bl = obs.bullets || [];
    for (let i = 0; i < bl.length; i++) {
      const b = bl[i];
      if (b.owner === me.id) continue;
      const rpx = b.pos.x - me.pos.x, rpy = b.pos.y - me.pos.y;
      const rvx = b.vel.x - me.vel.x, rvy = b.vel.y - me.vel.y;
      const rv2 = rvx * rvx + rvy * rvy;
      if (rv2 < 1) continue;
      let tc = -(rpx * rvx + rpy * rvy) / rv2;
      const horizon = Math.min(b.ttl, 1.4);
      if (tc < 0 || tc > horizon) continue;
      const mx = rpx + rvx * tc, my = rpy + rvy * tc;
      const miss = Math.sqrt(mx * mx + my * my);
      if (miss > 75) continue;
      let dx, dy;
      if (miss > 1e-3) { dx = -mx / miss; dy = -my / miss; }
      else { const n = Math.sqrt(rv2); dx = -rvy / n; dy = rvx / n; }
      const w = ((75 - miss) / 75) * clamp(1.5 - tc, 0.2, 1.5);
      ax += dx * w * 900;
      ay += dy * w * 900;
    }

    // range keeping / strafing
    if (tgt) {
      const ux = (tgt.pos.x - me.pos.x) / (dist || 1), uy = (tgt.pos.y - me.pos.y) / (dist || 1);
      let want = 470;
      if (me.hp < tgt.hp - 12) want = 650;
      else if (me.hp > tgt.hp + 12) want = 400;
      if (me.ammo < 8) want = 820;
      const k = clamp((dist - want) * 0.9, -260, 220);
      ax += ux * k;
      ay += uy * k;
      // ship-ship separation
      if (dist < 110) { ax -= ux * 500; ay -= uy * 500; }
      // strafe: pick the tangential sign that agrees with the safety field
      const tx = -uy, ty = ux;
      const score = tx * ax + ty * ay + 140 * mem.sgn;
      mem.sgn = score >= 0 ? 1 : -1;
      const sw = (dist < 950 ? 150 : 60);
      ax += tx * mem.sgn * sw;
      ay += ty * mem.sgn * sw;
    }

    const amag = Math.sqrt(ax * ax + ay * ay);

    // ---- choose heading ----
    const goodShot = fireMiss < 60 || bestMiss < 25;
    let headAngle;
    if (emergency) headAngle = Math.atan2(ay, ax);
    else if (amag > 150 && !(goodShot && amag < 420)) headAngle = Math.atan2(ay, ax);
    else headAngle = aimAngle;

    const err = L.wrapAngle(headAngle - me.angle);
    const ae = Math.abs(err);
    let w = Math.sqrt(24 * ae) * 0.88;
    if (w > 3) w = 3;
    const turn = clamp((err >= 0 ? w : -w) / 3, -1, 1);

    // ---- thrust ----
    let thrust = 0;
    if (amag > 1e-3 && me.fuel > 0.3) {
      const nx = Math.cos(me.angle), ny = Math.sin(me.angle);
      const align = (nx * ax + ny * ay) / amag;
      let want = clamp(amag / 320, 0, 1);
      if (emergency) want = 1;
      if (align > 0.3) {
        thrust = want * clamp(align, 0, 1);
      }
      if (!emergency) {
        if (me.fuel < 25) thrust *= 0.55;
        if (me.fuel < 10) thrust *= 0.4;
        if (thrust < 0.08) thrust = 0;
      }
      if (emergency && align < 0.2) thrust = 0;
    }

    // ---- fire ----
    let fire = false;
    if (me.ammo > 0 && !me.overheated && me.cooldown <= 0 && me.heat + 8 <= 97) {
      if (fireMiss < 13.5 && dist < 1450) fire = true;
    }

    return { thrust: clamp(thrust, 0, 1), turn: turn, fire: fire };
  } catch (e) {
    return safe;
  }
}
