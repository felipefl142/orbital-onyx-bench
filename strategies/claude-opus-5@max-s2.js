/* ===== ORBITAL ONYX — "Kepler" ===== */

function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

const _g = { x: 0, y: 0 };
function gravAcc(obs, x, y) {
  let ax = 0, ay = 0;
  const ps = obs.planets, G = obs.G;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const dx = p.pos.x - x, dy = p.pos.y - y;
    const e = 0.5 * p.radius;
    const r2 = dx * dx + dy * dy + e * e;
    const f = (G * p.mass) / (r2 * Math.sqrt(r2));
    ax += dx * f; ay += dy * f;
  }
  _g.x = ax; _g.y = ay;
  return _g;
}

/* forward simulation with constant applied accel (after `delay` s of turning) */
const _sc = { t: -1, r: 0, oob: 0 };
function simRun(obs, px, py, vx, vy, ax, ay, T, h, shipR, delay) {
  const ps = obs.planets, G = obs.G, Rar = obs.arena.radius;
  let t = 0, oob = 0;
  while (t < T) {
    const live = t >= delay;
    const apx = live ? ax : 0, apy = live ? ay : 0;
    const spd = Math.sqrt(vx * vx + vy * vy);
    const marg = shipR + spd * h * 0.6 + 2;
    let gx = 0, gy = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const qx = p.pos.x + p.vel.x * t, qy = p.pos.y + p.vel.y * t;
      const dx = qx - px, dy = qy - py;
      const dsq = dx * dx + dy * dy;
      const rr = p.radius + marg;
      if (dsq < rr * rr) {
        _sc.t = t; _sc.r = Math.sqrt(px * px + py * py); _sc.oob = oob;
        return _sc;
      }
      const e = 0.5 * p.radius;
      const r2 = dsq + e * e;
      const f = (G * p.mass) / (r2 * Math.sqrt(r2));
      gx += dx * f; gy += dy * f;
    }
    vx += (gx + apx) * h; vy += (gy + apy) * h;
    px += vx * h; py += vy * h;
    t += h;
    if (px * px + py * py > Rar * Rar) oob += h;
  }
  _sc.t = -1; _sc.r = Math.sqrt(px * px + py * py); _sc.oob = oob;
  return _sc;
}

function resScore(tt, rr, oob, Rar) {
  const a = tt < 0 ? 12 : tt;
  return a * 12 - oob * 45 - Math.max(0, rr - Rar * 0.9) * 0.08;
}

function losBlk(obs, ax, ay, bx, by, pad) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1) return false;
  const ps = obs.planets;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    let u = ((p.pos.x - ax) * dx + (p.pos.y - ay) * dy) / l2;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    const qx = ax + dx * u - p.pos.x, qy = ay + dy * u - p.pos.y;
    const rr = p.radius + pad;
    if (qx * qx + qy * qy < rr * rr) return true;
  }
  return false;
}

function scoreStation(obs, cx, cy, tgt, wantRange) {
  const Rar = obs.arena.radius;
  const me = obs.self;
  const rc = Math.sqrt(cx * cx + cy * cy);
  let s = 0;
  if (rc > Rar * 0.84) s -= 40000 + (rc - Rar * 0.84) * 60;
  const ps = obs.planets;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const need = p.radius + 95;
    let dx = cx - p.pos.x, dy = cy - p.pos.y;
    let d = Math.sqrt(dx * dx + dy * dy);
    const ex = cx - (p.pos.x + p.vel.x * 3), ey = cy - (p.pos.y + p.vel.y * 3);
    const d2 = Math.sqrt(ex * ex + ey * ey);
    if (d2 < d) d = d2;
    if (d < need) s -= 50000 + (need - d) * 80;
    else if (d < need + 150) s -= (need + 150 - d) * 1.6;
  }
  const g = gravAcc(obs, cx, cy);
  s -= Math.sqrt(g.x * g.x + g.y * g.y) * 9;
  if (tgt) {
    const dx = cx - tgt.pos.x, dy = cy - tgt.pos.y;
    const dr = Math.sqrt(dx * dx + dy * dy);
    s -= Math.abs(dr - wantRange) * 0.5;
    if (losBlk(obs, cx, cy, tgt.pos.x, tgt.pos.y, 26)) s -= 450;
  }
  const mx = cx - me.pos.x, my = cy - me.pos.y;
  s -= Math.sqrt(mx * mx + my * my) * 0.28;
  s -= Math.max(0, rc - Rar * 0.6) * 0.3;
  return s;
}

const _st = { x: 0, y: 0 };
function pickStation(obs, mem, tgt, wantRange) {
  const me = obs.self;
  const Rar = obs.arena.radius;
  const cur = mem.stok ? scoreStation(obs, mem.stx, mem.sty, tgt, wantRange) : -1e18;
  if (mem.stok && obs.tick - mem.stt < 12 && cur > -3e4) {
    _st.x = mem.stx; _st.y = mem.sty;
    return _st;
  }
  let bx = me.pos.x, by = me.pos.y;
  let bs = scoreStation(obs, bx, by, tgt, wantRange);
  if (tgt) {
    for (let k = 0; k < 12; k++) {
      const a = k * (Math.PI / 6);
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let j = 0; j < 3; j++) {
        const rr = wantRange * (j === 0 ? 0.68 : (j === 1 ? 1 : 1.42));
        const px = tgt.pos.x + ca * rr, py = tgt.pos.y + sa * rr;
        const s = scoreStation(obs, px, py, tgt, wantRange);
        if (s > bs) { bs = s; bx = px; by = py; }
      }
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = k * (Math.PI / 4);
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j < 2; j++) {
      const rr = j === 0 ? 240 : 540;
      const px = me.pos.x + ca * rr, py = me.pos.y + sa * rr;
      const s = scoreStation(obs, px, py, tgt, wantRange);
      if (s > bs) { bs = s; bx = px; by = py; }
    }
  }
  for (let k = 0; k < 6; k++) {
    const a = k * (Math.PI / 3);
    const px = Math.cos(a) * Rar * 0.42, py = Math.sin(a) * Rar * 0.42;
    const s = scoreStation(obs, px, py, tgt, wantRange);
    if (s > bs) { bs = s; bx = px; by = py; }
  }
  if (!(cur > -3e4 && bs < cur + 80)) {
    mem.stx = bx; mem.sty = by;
  }
  mem.stok = 1; mem.stt = obs.tick;
  _st.x = mem.stx; _st.y = mem.sty;
  return _st;
}

/* --- gunnery --- */
const _ev = { miss: 0, blocked: false, corr: 0, t: 0 };
function evalShot(obs, angle, horizon, ex, ey, n) {
  const L = obs.lib, me = obs.self;
  const SR = obs.rules.ship.radius;
  const bs = obs.rules.weapon.bulletSpeed;
  const cx = Math.cos(angle), cy = Math.sin(angle);
  const b = {
    pos: { x: me.pos.x + cx * (SR + 2), y: me.pos.y + cy * (SR + 2) },
    vel: { x: me.vel.x + cx * bs, y: me.vel.y + cy * bs }
  };
  const bp = L.predict(b, horizon, { step: 1 / 30, radius: 0 });
  const pts = bp.points;
  const m = pts.length < n ? pts.length : n;
  let best = 1e18, at = -1;
  for (let i = 1; i < m; i++) {
    const dx = pts[i].pos.x - ex[i], dy = pts[i].pos.y - ey[i];
    const dd = dx * dx + dy * dy;
    if (dd < best) { best = dd; at = i; }
  }
  if (at < 0) { _ev.miss = 1e9; _ev.blocked = true; _ev.corr = 0; _ev.t = 0; return _ev; }
  const bxp = pts[at].pos.x, byp = pts[at].pos.y;
  const offx = ex[at] - bxp, offy = ey[at] - byp;
  const rx = ex[at] - me.pos.x, ry = ey[at] - me.pos.y;
  const rng = Math.max(50, Math.sqrt(rx * rx + ry * ry));
  _ev.miss = Math.sqrt(best);
  _ev.t = pts[at].t;
  _ev.blocked = !!bp.hit && bp.hit.t <= pts[at].t + 1e-6;
  _ev.corr = (cx * offy - cy * offx) / rng;
  return _ev;
}

function aimPlan(obs, mem, tgt, tgtD) {
  const L = obs.lib, me = obs.self;
  const SR = obs.rules.ship.radius;
  const bs = obs.rules.weapon.bulletSpeed;
  const pa = mem.pa[tgt.id];
  const aex = pa ? pa.x * 0.7 : 0, aey = pa ? pa.y * 0.7 : 0;
  let ft = tgtD / bs;
  const lead = L.leadTarget(me, tgt, bs);
  if (lead && lead.time > 0) ft = lead.time;
  const horizon = clamp(ft * 1.3 + 0.35, 0.5, 2.7);
  const ep = L.predict(tgt, horizon, { step: 1 / 30 }).points;
  const n = ep.length;
  if (n < 2) return null;
  const ex = [], ey = [];
  for (let i = 0; i < n; i++) {
    const t = ep[i].t, c = 0.5 * t * t;
    ex.push(ep[i].pos.x + aex * c);
    ey.push(ep[i].pos.y + aey * c);
  }
  let r = evalShot(obs, me.angle, horizon, ex, ey, n);
  const cMiss = r.miss, cBlk = r.blocked, cT = r.t;
  const a0 = lead ? lead.angle : L.angleTo(me.pos, tgt.pos);
  r = evalShot(obs, a0, horizon, ex, ey, n);
  let bAng = a0, bMiss = r.miss, bBlk = r.blocked, bT = r.t, bCorr = r.corr;
  for (let it = 0; it < 2; it++) {
    if (bMiss < 3 && !bBlk) break;
    const na = bAng + bCorr;
    r = evalShot(obs, na, horizon, ex, ey, n);
    if ((bBlk && !r.blocked) || (r.miss < bMiss && !(r.blocked && !bBlk))) {
      bAng = na; bMiss = r.miss; bBlk = r.blocked; bT = r.t; bCorr = r.corr;
    } else break;
  }
  if (bBlk || bMiss > SR * 1.5) {
    const offs = [0.13, -0.13, 0.33, -0.33];
    for (let k = 0; k < 4; k++) {
      const na = a0 + offs[k];
      r = evalShot(obs, na, horizon, ex, ey, n);
      if ((bBlk && !r.blocked) || (!r.blocked && r.miss < bMiss)) {
        bAng = na; bMiss = r.miss; bBlk = r.blocked; bT = r.t; bCorr = r.corr;
      }
    }
    if (!bBlk && bMiss > 3) {
      const na = bAng + bCorr;
      r = evalShot(obs, na, horizon, ex, ey, n);
      if (!r.blocked && r.miss < bMiss) { bAng = na; bMiss = r.miss; bT = r.t; }
    }
  }
  return { ang: bAng, miss: bMiss, blocked: bBlk, t: bT, cMiss: cMiss, cBlk: cBlk, cT: cT };
}

function brain(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const SR = obs.rules.ship.radius;
  const Rar = obs.arena.radius;
  const fm = obs.rules.ship.fuelMax || 85;
  const maxA = 60 / (1 + 0.5 * me.fuel / fm);
  const fuel = me.fuel;

  if (!mem.ini) {
    mem.ini = 1; mem.pv = {}; mem.pa = {};
    mem.stx = me.pos.x; mem.sty = me.pos.y; mem.stok = 0; mem.stt = -999;
    mem.jsign = 1; mem.jt = -9; mem.sb = 0;
  }

  /* ---------- enemies + thrust estimation ---------- */
  const al = [];
  const ens = obs.enemies || [];
  for (let i = 0; i < ens.length; i++) {
    const e = ens[i];
    if (!e || !e.alive) continue;
    al.push(e);
    const pv = mem.pv[e.id];
    let ax = 0, ay = 0;
    if (pv) {
      const h = obs.t - pv.t;
      if (h > 1e-3 && h < 0.3) {
        const g = gravAcc(obs, e.pos.x, e.pos.y);
        ax = (e.vel.x - pv.vx) / h - g.x;
        ay = (e.vel.y - pv.vy) / h - g.y;
        const mm = Math.sqrt(ax * ax + ay * ay);
        if (mm > 62) { ax = ax * 62 / mm; ay = ay * 62 / mm; }
      }
    }
    const old = mem.pa[e.id];
    mem.pa[e.id] = old
      ? { x: old.x * 0.55 + ax * 0.45, y: old.y * 0.55 + ay * 0.45 }
      : { x: ax, y: ay };
    mem.pv[e.id] = { vx: e.vel.x, vy: e.vel.y, t: obs.t };
  }

  /* ---------- target ---------- */
  let tgt = null, tgtD = 0, bestS = -1e18;
  for (let i = 0; i < al.length; i++) {
    const e = al[i];
    const dx = e.pos.x - me.pos.x, dy = e.pos.y - me.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    let s = -d * 0.5 - e.hp * 1.5;
    if (losBlk(obs, me.pos.x, me.pos.y, e.pos.x, e.pos.y, 24)) s -= 600;
    if (s > bestS) { bestS = s; tgt = e; tgtD = d; }
  }

  /* ---------- engagement range policy ---------- */
  let wantRange = 560;
  if (tgt) {
    const remain = (obs.rules.timeLimit || 120) - obs.t;
    const adv = me.hp - tgt.hp;
    if (me.ammo <= 0) wantRange = adv > 2 ? 1150 : 150;
    else if (adv > 12 && remain < 55) wantRange = 950;
    else if (adv < -12 && remain < 35) wantRange = 340;
    else if (fuel < 15) wantRange = 650;
    if (al.length > 1) wantRange = Math.max(wantRange, 780);
  } else {
    wantRange = 0;
  }

  /* ---------- gunnery ---------- */
  let aim = null;
  if (tgt && tgtD < 1750) aim = aimPlan(obs, mem, tgt, tgtD);
  let fire = false;
  if (aim && me.ammo > 0 && !me.overheated && me.cooldown <= 0.03) {
    const th = aim.cT < 0.5 ? 14.5 : (aim.cT < 1.1 ? 12.5 : (aim.cT < 1.9 ? 10.5 : 8.5));
    const hc = (aim.cMiss < 7 && aim.cT < 1.2) ? 86 : 58;
    if (!aim.cBlk && aim.cMiss < th && me.heat <= hc) fire = true;
  }

  /* ---------- desired acceleration field ---------- */
  let accx = 0, accy = 0, urg = 0;

  /* (A) engine predictor: early planet warning */
  const pp = L.predict(me, 4.0, { step: 1 / 18, radius: SR + 14 });
  if (pp && pp.hit) {
    const p = obs.planets[pp.hit.planet];
    if (p) {
      const th = pp.hit.t;
      const rx = me.pos.x - p.pos.x, ry = me.pos.y - p.pos.y;
      const d = Math.sqrt(rx * rx + ry * ry) || 1;
      const nx = rx / d, ny = ry / d;
      let tx = -ny, ty = nx;
      const rvx = me.vel.x - p.vel.x, rvy = me.vel.y - p.vel.y;
      if (tx * rvx + ty * rvy < 0) { tx = -tx; ty = -ty; }
      const w = th < 1.2 ? 1 : (th < 2.2 ? 0.7 : 0.35);
      const a = maxA * w * 0.78;
      accx += (tx + nx * 0.85) * a;
      accy += (ty + ny * 0.85) * a;
      if (w > urg) urg = w;
    }
  }

  /* (A2) close-range planet repulsion */
  const ps = obs.planets;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const rx = me.pos.x - p.pos.x, ry = me.pos.y - p.pos.y;
    const d = Math.sqrt(rx * rx + ry * ry) || 1;
    const surf = d - p.radius - SR;
    if (surf > 175) continue;
    const nx = rx / d, ny = ry / d;
    const rvx = me.vel.x - p.vel.x, rvy = me.vel.y - p.vel.y;
    const vr = nx * rvx + ny * rvy;
    let a = (175 - surf) * 0.10;
    if (vr < -5) a += (-vr - 5) * (surf < 90 ? 0.9 : 0.3);
    if (a > maxA * 1.5) a = maxA * 1.5;
    let tx = -ny, ty = nx;
    if (tx * rvx + ty * rvy < 0) { tx = -tx; ty = -ty; }
    const w2 = surf < 120 ? 0.7 : 0.4;
    accx += nx * a + tx * a * w2;
    accy += ny * a + ty * a * w2;
    const uu = clamp(a / maxA, 0, 1);
    if (uu > urg) urg = uu;
  }

  /* (B) arena containment */
  const rr0 = Math.sqrt(me.pos.x * me.pos.x + me.pos.y * me.pos.y);
  if (rr0 > 1) {
    const nx = me.pos.x / rr0, ny = me.pos.y / rr0;
    const vr = me.vel.x * nx + me.vel.y * ny;
    const soft = Rar * 0.78;
    let a = 0;
    if (rr0 > soft) a += (rr0 - soft) * 0.09;
    if (rr0 > Rar) a += maxA;
    if (vr > 1) {
      const tHit = (Rar * 0.97 - rr0) / vr;
      if (tHit < 3) a += vr * (tHit < 1.5 ? 0.9 : 0.3);
    }
    if (pp && pp.leavesArena) a += maxA * 0.35;
    if (a > maxA * 1.5) a = maxA * 1.5;
    if (a > 0.2) {
      accx -= nx * a; accy -= ny * a;
      const uu = clamp(a / maxA, 0, 1);
      if (uu > urg) urg = uu;
    }
  }

  /* (C) incoming bullet dodge */
  const bl = obs.bullets || [];
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    if (b.owner === me.id) continue;
    const dx = b.pos.x - me.pos.x, dy = b.pos.y - me.pos.y;
    if (dx * dx + dy * dy > 1440000) continue;
    const ux = b.vel.x - me.vel.x, uy = b.vel.y - me.vel.y;
    const uu = ux * ux + uy * uy;
    if (uu < 100) continue;
    const tc = -(dx * ux + dy * uy) / uu;
    if (tc <= 0.02) continue;
    const lim = b.ttl < 1.5 ? b.ttl : 1.5;
    if (tc > lim) continue;
    const mx = dx + ux * tc, my = dy + uy * tc;
    const mm = Math.sqrt(mx * mx + my * my);
    const dang = SR + 16;
    if (mm > dang + 30) continue;
    const need = (dang + 26) - mm;
    let a = 2 * need / (tc * tc);
    if (a > maxA) a = maxA;
    let ex2, ey2;
    if (mm > 1) { ex2 = -mx / mm; ey2 = -my / mm; }
    else { const ul = Math.sqrt(uu); ex2 = -uy / ul; ey2 = ux / ul; }
    accx += ex2 * a; accy += ey2 * a;
    const uu2 = clamp(a / maxA, 0, 1);
    if (uu2 > urg) urg = uu2;
  }

  /* (D) keep off the enemy hull (unless ramming) */
  if (tgt && wantRange > 200) {
    for (let i = 0; i < al.length; i++) {
      const e = al[i];
      const dx = me.pos.x - e.pos.x, dy = me.pos.y - e.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      if (d > 130) continue;
      const nx = dx / d, ny = dy / d;
      const clos = -((me.vel.x - e.vel.x) * nx + (me.vel.y - e.vel.y) * ny);
      let a = (130 - d) * 0.3 + (clos > 0 ? clos * 0.5 : 0);
      if (a > maxA) a = maxA;
      accx += nx * a; accy += ny * a;
      const uu = clamp(a / maxA * 0.8, 0, 0.8);
      if (uu > urg) urg = uu;
    }
  }

  /* (E) station keeping */
  let needS = 0;
  if (fuel > 1.5) {
    const st = pickStation(obs, mem, tgt, wantRange);
    const sx = st.x - me.pos.x, sy = st.y - me.pos.y;
    const sd = Math.sqrt(sx * sx + sy * sy) || 1;
    const vm = clamp(sd * 0.75, 0, 175);
    const dvx = (sx / sd) * vm - me.vel.x;
    const dvy = (sy / sd) * vm - me.vel.y;
    const g = gravAcc(obs, me.pos.x, me.pos.y);
    let kx = dvx * 1.5 - g.x;
    let ky = dvy * 1.5 - g.y;
    needS = Math.sqrt(kx * kx + ky * ky);
    let scale = 1;
    if (fuel < 20) scale = 0.6;
    if (fuel < 9) scale = 0.3;
    const thr = (mem.sb ? 0.07 : 0.22) * maxA / scale;
    if (needS < thr) { mem.sb = 0; kx = 0; ky = 0; needS = 0; }
    else {
      mem.sb = 1;
      const cap = maxA * (scale > 0.9 ? 1 : scale);
      if (needS > cap) { kx = kx * cap / needS; ky = ky * cap / needS; needS = cap; }
      accx += kx; accy += ky;
      const uu = clamp(needS / maxA * 0.85, 0, 0.85);
      if (uu > urg) urg = uu;
    }
  }

  /* (F) jink while the gun is hot (no shots lost) */
  const gunIdle = me.overheated || me.heat > 62 || me.ammo <= 0;
  if (tgt && gunIdle && fuel > 28 && urg < 0.3 && tgtD < 1200 && tgtD > 170) {
    if (obs.t - mem.jt > 0.55) { mem.jt = obs.t; mem.jsign = -mem.jsign; }
    const lx = tgt.pos.x - me.pos.x, ly = tgt.pos.y - me.pos.y;
    const ll = Math.sqrt(lx * lx + ly * ly) || 1;
    const a = maxA * 0.7;
    accx += (-ly / ll) * mem.jsign * a;
    accy += (lx / ll) * mem.jsign * a;
    if (urg < 0.5) urg = 0.5;
  }

  /* ---------- mode: burn vs aim ---------- */
  const aMag = Math.sqrt(accx * accx + accy * accy);
  let aimAng = me.angle;
  if (aim) aimAng = aim.ang;
  else if (tgt) aimAng = L.angleTo(me.pos, tgt.pos);
  else if (aMag > 1) aimAng = Math.atan2(accy, accx);

  let desAng, thrust;
  const wantBurn = fuel > 0.05 && aMag > 0.12 * maxA && urg > 0.17;
  if (wantBurn) {
    desAng = Math.atan2(accy, accx);
    const er = L.wrapAngle(desAng - me.angle);
    const cs = Math.cos(er);
    thrust = cs > 0.3 ? clamp(aMag / maxA, 0, 1) * cs : 0;
  } else {
    desAng = aimAng;
    const nx = Math.cos(me.angle), ny = Math.sin(me.angle);
    const comp = (accx * nx + accy * ny) / maxA;
    thrust = (comp > 0.3 && fuel > 0.05) ? clamp(comp, 0, 1) : 0;
  }

  /* ---------- hard safety override ---------- */
  const T = 2.6, h = 1 / 15;
  let dly = Math.abs(L.wrapAngle(desAng - me.angle)) / 3 + 0.05;
  const ca0 = Math.cos(desAng) * thrust * maxA, sa0 = Math.sin(desAng) * thrust * maxA;
  let r = simRun(obs, me.pos.x, me.pos.y, me.vel.x, me.vel.y, ca0, sa0, T, h, SR, dly);
  let bad = (r.t >= 0) || (r.oob > 0.45);
  if (bad && fuel > 0.05) {
    const ux = aMag > 1 ? accx / aMag : 0, uy = aMag > 1 ? accy / aMag : 0;
    r = simRun(obs, me.pos.x, me.pos.y, me.vel.x, me.vel.y, 0, 0, T, h, SR, 0);
    let bSc = resScore(r.t, r.r, r.oob, Rar) + 10;
    let bAng = me.angle, bThr = 0, bCrash = r.t;
    for (let k = 0; k < 16; k++) {
      const a = k * (Math.PI / 8);
      const cx = Math.cos(a), cy = Math.sin(a);
      const dl = Math.abs(L.wrapAngle(a - me.angle)) / 3 + 0.05;
      r = simRun(obs, me.pos.x, me.pos.y, me.vel.x, me.vel.y, cx * maxA, cy * maxA, T, h, SR, dl);
      const sc = resScore(r.t, r.r, r.oob, Rar) + 9 * (cx * ux + cy * uy)
        + 6 * Math.cos(a - me.angle);
      if (sc > bSc) { bSc = sc; bAng = a; bThr = 1; bCrash = r.t; }
    }
    if (bThr > 0) {
      desAng = bAng;
      const er = L.wrapAngle(desAng - me.angle);
      const cs = Math.cos(er);
      const lvl = (bCrash >= 0 && bCrash > 1.5) ? 0.65 : 1;
      thrust = cs > 0.12 ? lvl * Math.max(cs, 0.4) : 0;
    } else {
      thrust = 0;
      desAng = aimAng;
    }
  }

  /* ---------- turn (near time-optimal) ---------- */
  const er = L.wrapAngle(desAng - me.angle);
  const ae = Math.abs(er);
  let wd = Math.sqrt(24 * ae) * 0.9;
  const slow = ae / 0.09;
  if (slow < wd) wd = slow;
  if (wd > 3) wd = 3;
  if (er < 0) wd = -wd;
  let turn = wd / 3;

  if (!Number.isFinite(thrust)) thrust = 0;
  if (!Number.isFinite(turn)) turn = 0;
  if (fuel <= 0.02) thrust = 0;
  return { thrust: clamp(thrust, 0, 1), turn: clamp(turn, -1, 1), fire: !!fire };
}

export default function control(obs, mem) {
  try {
    return brain(obs, mem);
  } catch (e) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
