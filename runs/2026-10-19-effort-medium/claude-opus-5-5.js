export default function control(obs, mem) {
  const L = obs.lib, me = obs.self;
  const P = obs.planets || [], np = P.length;
  const R = obs.arena.radius, BS = obs.rules.weapon.bulletSpeed;
  const DT = 1 / 30, NS = 120, NB = 84;
  const mx = me.pos.x, my = me.pos.y, mvx = me.vel.x, mvy = me.vel.y;
  const PI = Math.PI, TWO_PI = PI * 2;
  const wrap = (a) => { while (a > PI) a -= TWO_PI; while (a < -PI) a += TWO_PI; return a; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---- planet position tables over time ----
  const PX = new Array((NS + 1) * np), PY = new Array((NS + 1) * np);
  const pgm = [], pe2 = [], pr = [];
  for (let i = 0; i < np; i++) {
    const p = P[i];
    pgm.push(obs.G * p.mass); pe2.push((0.5 * p.radius) * (0.5 * p.radius)); pr.push(p.radius);
    let x = p.pos.x, y = p.pos.y;
    const r2 = x * x + y * y;
    const w = r2 > 1 ? (x * p.vel.y - y * p.vel.x) / r2 : 0;
    const c = Math.cos(w * DT), s = Math.sin(w * DT);
    for (let k = 0; k <= NS; k++) {
      PX[k * np + i] = x; PY[k * np + i] = y;
      const nx = x * c - y * s; y = x * s + y * c; x = nx;
    }
  }
  let GX = 0, GY = 0, GC = 1e9;
  function grav(x, y, k) {
    let ax = 0, ay = 0, mc = 1e9;
    const b = k * np;
    for (let i = 0; i < np; i++) {
      const dx = PX[b + i] - x, dy = PY[b + i] - y;
      const dd = dx * dx + dy * dy;
      const d2 = dd + pe2[i];
      const f = pgm[i] / (d2 * Math.sqrt(d2));
      ax += f * dx; ay += f * dy;
      const c = Math.sqrt(dd) - pr[i];
      if (c < mc) mc = c;
    }
    GX = ax; GY = ay; GC = mc;
  }

  function traj(e) {
    const xs = [e.pos.x], ys = [e.pos.y];
    let x = e.pos.x, y = e.pos.y, vx = e.vel.x, vy = e.vel.y, dead = false;
    for (let k = 0; k < NB; k++) {
      if (!dead) {
        grav(x, y, k);
        if (GC < 12) dead = true;
        else { vx += GX * DT; vy += GY * DT; x += vx * DT; y += vy * DT; }
      }
      xs.push(x); ys.push(y);
    }
    return { xs, ys, e };
  }

  function simBullet(ang, tgts, N) {
    const c = Math.cos(ang), s = Math.sin(ang);
    let x = mx + c * 14, y = my + s * 14, vx = c * BS + mvx, vy = s * BS + mvy;
    let best = 1e9, bt = -1, bx = 0, by = 0, ex = 0, ey = 0;
    for (let k = 0; k < N; k++) {
      grav(x, y, k);
      if (GC < 2) break;
      vx += GX * DT; vy += GY * DT;
      const nx = x + vx * DT, ny = y + vy * DT;
      for (let j = 0; j < tgts.length; j++) {
        const tr = tgts[j];
        const e0x = tr.xs[k], e0y = tr.ys[k], e1x = tr.xs[k + 1], e1y = tr.ys[k + 1];
        const rx0 = x - e0x, ry0 = y - e0y, rx1 = nx - e1x, ry1 = ny - e1y;
        const dx = rx1 - rx0, dy = ry1 - ry0;
        const dd = dx * dx + dy * dy;
        let u = dd > 1e-9 ? -(rx0 * dx + ry0 * dy) / dd : 0;
        u = clamp(u, 0, 1);
        const qx = rx0 + dx * u, qy = ry0 + dy * u;
        const d = Math.sqrt(qx * qx + qy * qy);
        if (d < best) {
          best = d; bt = (k + u) * DT;
          bx = x + (nx - x) * u; by = y + (ny - y) * u;
          ex = e0x + (e1x - e0x) * u; ey = e0y + (e1y - e0y) * u;
        }
      }
      x = nx; y = ny;
    }
    return { miss: best, t: bt, bx, by, ex, ey };
  }

  function simSelf(th, delay, dur, acc) {
    let x = mx, y = my, vx = mvx, vy = mvy, minc = 1e9;
    const c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < NS; k++) {
      grav(x, y, k);
      const t = k * DT;
      let cl = GC - 22;
      const rr = Math.sqrt(x * x + y * y);
      const ca = R - 100 - rr;
      if (ca < cl) cl = ca;
      cl += t * 8;
      if (cl < minc) minc = cl;
      if (GC < 12) { minc -= 50; break; }
      let ax = GX, ay = GY;
      if (acc > 0 && t >= delay && t < delay + dur) { ax += c * acc; ay += s * acc; }
      vx += ax * DT; vy += ay * DT; x += vx * DT; y += vy * DT;
    }
    return minc;
  }

  const turnTime = (D) => (D < 0.75 ? 2 * Math.sqrt(D / 12) : 0.5 + (D - 0.75) / 3);
  const acc = me.fuel > 0 ? 60 / (1 + 0.5 * me.fuel / 100) : 0;

  // ---- side-strafe randomisation ----
  if (!mem.sideT || obs.t > mem.sideT) {
    mem.side = obs.rng() < 0.5 ? 1 : -1;
    mem.sideT = obs.t + 2.5 + obs.rng() * 3;
  }

  // ---- enemies ----
  const foes = [];
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    foes.push({ e, d: Math.hypot(e.pos.x - mx, e.pos.y - my) });
  }
  foes.sort((a, b) => a.d - b.d);
  const near = foes.slice(0, 3);
  let tg = null, tgScore = Infinity;
  for (const f of near) {
    const sc = f.d + f.e.hp * 4;
    if (sc < tgScore) { tgScore = sc; tg = f; }
  }
  const trs = near.map((f) => traj(f.e));
  let tgTr = null;
  for (const t of trs) if (tg && t.e === tg.e) tgTr = t;

  // ---- aim solve ----
  let aimAng = me.angle, sol = null;
  if (tg) {
    const lead = L.leadTarget(me, tg.e, BS);
    let a = lead ? lead.angle : Math.atan2(tg.e.pos.y - my, tg.e.pos.x - mx);
    for (let it = 0; it < 4; it++) {
      sol = simBullet(a, [tgTr], NB);
      if (sol.t < 0) break;
      const corr = wrap(Math.atan2(sol.ey - my, sol.ex - mx) - Math.atan2(sol.by - my, sol.bx - mx));
      a = wrap(a + corr);
      if (Math.abs(corr) < 0.003) break;
    }
    aimAng = a;
  }

  // ---- fire check (at current nose) ----
  let fire = false;
  if (trs.length && me.ammo > 0 && !me.overheated && me.heat < 90 && me.cooldown <= 0.02) {
    const fa = me.angle + me.angVel * 0.02;
    const fs = simBullet(fa, trs, NB);
    const tol = me.ammo < 15 ? 11 : 13;
    if (fs.t >= 0 && fs.t < 2.6 && fs.miss < tol) fire = true;
  }

  // ---- desired velocity ----
  let dvx = 0, dvy = 0;
  {
    let wx = 0, wy = 0;
    if (tg) {
      const ex = tg.e.pos.x - mx, ey = tg.e.pos.y - my, d = Math.max(1, tg.d);
      const ux = ex / d, uy = ey / d;
      const range = me.ammo > 0 ? 450 : 1100;
      const radial = clamp((d - range) * 0.4, -150, 150);
      const tang = 70 * mem.side;
      wx = tg.e.vel.x * 0.5 + ux * radial - uy * tang;
      wy = tg.e.vel.y * 0.5 + uy * radial + ux * tang;
    }
    for (let i = 0; i < np; i++) {
      const dx = mx - P[i].pos.x, dy = my - P[i].pos.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const clr = dist - pr[i];
      if (clr < 300) { const push = (300 - clr) * 0.6; wx += dx / dist * push; wy += dy / dist * push; }
    }
    const rr = Math.hypot(mx, my);
    if (rr > 1400) { const push = (rr - 1400) * 0.5; wx -= mx / rr * push; wy -= my / rr * push; }
    const wm = Math.hypot(wx, wy);
    if (wm > 220) { wx *= 220 / wm; wy *= 220 / wm; }
    dvx = wx - mvx; dvy = wy - mvy;
  }
  const dvMag = Math.hypot(dvx, dvy);

  // ---- mode selection ----
  let mode = "aim", tgtAng = aimAng, thrust = 0;

  // planet / arena emergency
  if (acc > 0) {
    const s0 = simSelf(0, 0, 0, 0);
    if (s0 < 20) {
      let best = s0, bth = null;
      for (let j = 0; j < 13; j++) {
        const th = j < 12 ? (j * PI) / 6 : me.angle;
        const delay = turnTime(Math.abs(wrap(th - me.angle)));
        const sc = simSelf(th, delay, 1.0, acc);
        if (sc > best) { best = sc; bth = th; }
      }
      if (bth !== null && best > s0 + 3) { mode = "emerg"; tgtAng = bth; }
    }
  }

  // bullet dodge
  if (mode === "aim" && acc > 0) {
    let thr = null;
    for (const b of obs.bullets) {
      if (b.owner === me.id) continue;
      const px = b.pos.x - mx, py = b.pos.y - my;
      const vx = b.vel.x - mvx, vy = b.vel.y - mvy;
      const vv = vx * vx + vy * vy;
      if (vv < 1) continue;
      const tca = -(px * vx + py * vy) / vv;
      if (tca <= 0.05 || tca > 1.2 || tca > b.ttl) continue;
      const qx = px + vx * tca, qy = py + vy * tca;
      const m = Math.hypot(qx, qy);
      if (m < 16 && (!thr || tca < thr.tca)) thr = { tca, qx, qy, vx, vy };
    }
    if (thr) {
      const vm = Math.hypot(thr.vx, thr.vy);
      const nx = -thr.vy / vm, ny = thr.vx / vm;
      let best = Math.abs(thr.qx * nx + thr.qy * ny), bth = null;
      for (let j = 0; j < 12; j++) {
        const th = (j * PI) / 6;
        const delay = turnTime(Math.abs(wrap(th - me.angle)));
        const T = Math.max(0, thr.tca - delay);
        const disp = 0.5 * acc * T * T;
        const rx = thr.qx - Math.cos(th) * disp, ry = thr.qy - Math.sin(th) * disp;
        const nm = Math.abs(rx * nx + ry * ny);
        if (nm > best) { best = nm; bth = th; }
      }
      if (bth !== null && best > 18) { mode = "dodge"; tgtAng = bth; }
    }
  }

  if (mode === "aim") {
    const gunReady = me.ammo > 0 && !me.overheated && me.heat < 88;
    const goodShot = sol && sol.t >= 0 && sol.t < 2.2 && sol.miss < 40;
    const canBurn = me.fuel > 20;
    let man = false;
    if (canBurn) {
      if (mem.man && dvMag > 40) man = true;
      else if (dvMag > 130 || (dvMag > 50 && (!gunReady || !goodShot || !tg))) man = true;
    }
    mem.man = man;
    if (man) {
      mode = "man";
      tgtAng = Math.atan2(dvy, dvx);
    } else if (canBurn && dvMag > 40) {
      const dot = (Math.cos(me.angle) * dvx + Math.sin(me.angle) * dvy) / dvMag;
      if (dot > 0.75) thrust = Math.min(1, dvMag / 60) * dot;
    }
  } else {
    mem.man = false;
  }

  const err = wrap(tgtAng - me.angle);
  if (mode === "emerg") thrust = Math.abs(err) < 0.5 ? 1 : 0;
  else if (mode === "dodge") thrust = Math.abs(err) < 0.35 ? 1 : 0;
  else if (mode === "man") thrust = Math.abs(err) < 0.35 ? Math.min(1, dvMag / 50) : 0;

  // ---- turn controller with feed-forward ----
  let ff = 0;
  if (mode === "aim" && typeof mem.prevAim === "number" && mem.prevMode === "aim") {
    ff = clamp(wrap(aimAng - mem.prevAim) / obs.dtDecision, -3, 3);
  }
  mem.prevAim = aimAng; mem.prevMode = mode;
  const ae = Math.abs(err);
  let want = Math.sign(err) * Math.min(3, Math.sqrt(20 * ae), ae * 10) + ff;
  const turn = clamp(want / 3, -1, 1);

  if (acc <= 0) thrust = 0;
  return { thrust: clamp(thrust, 0, 1), turn, fire };
}
