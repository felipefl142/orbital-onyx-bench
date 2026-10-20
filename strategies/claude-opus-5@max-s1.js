/* ===================== ORBITAL ONYX  —  "Keplerian Sniper" =====================
   Short-horizon MPC over a moving-planet gravity table (survival dominant)
   + gravity-corrected, thrust-compensated gunnery.
   ============================================================================ */

const DT    = 1 / 12;   // ship-sim step
const KTAB  = 48;       // planet table entries
const STEPS = 44;       // ship sim steps  (~3.67 s horizon)
const NDIR  = 16;       // candidate thrust directions
const NBS   = 16;       // steps over which incoming bullets are tracked (~1.33 s)
const MAXB  = 6;        // tracked enemy bullets
const ASTEP = 1 / 40;   // aiming prediction step
const TAU   = Math.PI * 2;

const PX = new Array(STEPS), PY = new Array(STEPS);
const EX = new Array(STEPS), EY = new Array(STEPS);
const BB = new Array(MAXB * 4), BM = new Array(MAXB);

function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

/* ---------- planet position table (circular tracks, incremental rotation) ---------- */
function buildTable(obs) {
  const ps = obs.planets || [];
  const P = ps.length, K = KTAB;
  const X = new Array((K + 1) * P), Y = new Array((K + 1) * P);
  const M = new Array(P), E2 = new Array(P), H2 = new Array(P), S2 = new Array(P), RD = new Array(P);
  const cc = new Array(P), sn = new Array(P);
  const rs = obs.rules.ship.radius;
  for (let i = 0; i < P; i++) {
    const p = ps[i];
    const pv = p.vel || { x: 0, y: 0 };
    X[i] = p.pos.x; Y[i] = p.pos.y;
    M[i] = p.mass; RD[i] = p.radius;
    const e = 0.5 * p.radius; E2[i] = e * e;
    const h = p.radius + rs + 5; H2[i] = h * h;
    const s = p.radius + rs + 85; S2[i] = s * s;
    const r2 = p.pos.x * p.pos.x + p.pos.y * p.pos.y;
    let w = 0;
    if (r2 > 1) w = (p.pos.x * pv.y - p.pos.y * pv.x) / r2;
    cc[i] = Math.cos(w * DT); sn[i] = Math.sin(w * DT);
  }
  for (let k = 1; k <= K; k++) {
    const o = k * P, q = o - P;
    for (let i = 0; i < P; i++) {
      const c = cc[i], s = sn[i], x = X[q + i], y = Y[q + i];
      X[o + i] = x * c - y * s; Y[o + i] = x * s + y * c;
    }
  }
  return { P: P, X: X, Y: Y, M: M, E2: E2, H2: H2, S2: S2, RD: RD };
}

/* ---------- simulate one control candidate ---------- */
function simCand(tab, G, x, y, vx, vy, dirx, diry, a, delay, AR, nb) {
  const P = tab.P, dt = DT, AR2 = AR * AR;
  let tHit = -1, minR = 1e9, outT = 0, maxR2 = 0, gE = 0, t = 0;
  for (let j = 0; j < nb; j++) BM[j] = 1e18;
  for (let k = 0; k < STEPS; k++) {
    if (k < NBS) {
      for (let j = 0; j < nb; j++) {
        const o = j * 4;
        const bvx = BB[o + 2], bvy = BB[o + 3];
        const rx = x - (BB[o] + bvx * t), ry = y - (BB[o + 1] + bvy * t);
        const rvx = vx - bvx, rvy = vy - bvy;
        const vv = rvx * rvx + rvy * rvy;
        let tc = 0;
        if (vv > 1e-9) tc = -(rx * rvx + ry * rvy) / vv;
        if (tc < 0) tc = 0; else if (tc > dt) tc = dt;
        const cx = rx + rvx * tc, cy = ry + rvy * tc;
        const d2 = cx * cx + cy * cy;
        if (d2 < BM[j]) BM[j] = d2;
      }
    }
    const o = k * P;
    let gx = 0, gy = 0;
    const vv = vx * vx + vy * vy;
    const iv = vv > 1e-9 ? 1 / vv : 0;
    for (let i = 0; i < P; i++) {
      const dx = tab.X[o + i] - x, dy = tab.Y[o + i] - y;
      const d2 = dx * dx + dy * dy;
      const s = Math.sqrt(d2 + tab.E2[i]);
      const f = G * tab.M[i] / (s * s * s);
      gx += dx * f; gy += dy * f;
      let tc = (dx * vx + dy * vy) * iv;
      if (tc < 0) tc = 0; else if (tc > dt) tc = dt;
      const cx = vx * tc - dx, cy = vy * tc - dy;
      const cd2 = cx * cx + cy * cy;
      if (cd2 < tab.H2[i] && tHit < 0) tHit = t + tc;
      const rr = cd2 / tab.S2[i];
      if (rr < minR) minR = rr;
    }
    gE = gx * gx + gy * gy;
    let ax = gx, ay = gy;
    if (t >= delay) { ax += dirx * a; ay += diry * a; }
    vx += ax * dt; vy += ay * dt;
    x += vx * dt; y += vy * dt;
    t += dt;
    const r2 = x * x + y * y;
    if (r2 > maxR2) maxR2 = r2;
    if (r2 > AR2) outT += dt;
    PX[k] = x; PY[k] = y;
  }
  return { tHit: tHit, minR: minR, outT: outT, maxR2: maxR2, gE: gE, evx: vx, evy: vy };
}

/* ---------- is a planet (at table index k) blocking the segment? ---------- */
function blockedAt(tab, k, x1, y1, x2, y2) {
  const P = tab.P, o = k * P;
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1) return false;
  for (let i = 0; i < P; i++) {
    const px = tab.X[o + i] - x1, py = tab.Y[o + i] - y1;
    let tt = (px * dx + py * dy) / l2;
    if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
    const cx = px - dx * tt, cy = py - dy * tt;
    const rr = tab.RD[i] + 14;
    if (cx * cx + cy * cy < rr * rr) return true;
  }
  return false;
}

/* ---------- fly a bullet through gravity and measure the miss ---------- */
function evalShot(obs, me, ePath, angle, R, BS) {
  const L = obs.lib;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const body = {
    pos: { x: me.pos.x + dx * (R + 2), y: me.pos.y + dy * (R + 2) },
    vel: { x: me.vel.x + dx * BS, y: me.vel.y + dy * BS }
  };
  const H = ePath[ePath.length - 1].t;
  const bp = L.predict(body, H, { step: ASTEP, radius: 0 });
  const pts = bp.points;
  const n = Math.min(pts.length, ePath.length);
  if (n < 2) return { angle: angle, miss: 1e9, corr: 0, blocked: true, t: 0 };
  let best = 1e18, bi = 0, bt = 0;
  for (let i = 0; i < n - 1; i++) {
    const q = pts[i], e = ePath[i];
    const rx = q.pos.x - e.x, ry = q.pos.y - e.y;
    const rvx = q.vel.x - e.vx, rvy = q.vel.y - e.vy;
    const vv = rvx * rvx + rvy * rvy;
    let tc = 0;
    if (vv > 1e-9) tc = -(rx * rvx + ry * rvy) / vv;
    const ds = pts[i + 1].t - q.t;
    if (tc < 0) tc = 0; else if (tc > ds) tc = ds;
    const cx = rx + rvx * tc, cy = ry + rvy * tc;
    const d2 = cx * cx + cy * cy;
    if (d2 < best) { best = d2; bi = i; bt = q.t + tc; }
  }
  const miss = Math.sqrt(best);
  const offx = ePath[bi].x - pts[bi].pos.x, offy = ePath[bi].y - pts[bi].pos.y;
  const den = BS * (bt > 0.03 ? bt : 0.03);
  let corr = (dx * offy - dy * offx) / den;
  if (corr > 0.5) corr = 0.5; else if (corr < -0.5) corr = -0.5;
  const blocked = !!bp.hit && bp.hit.t <= bt + 0.02;
  return { angle: angle, miss: miss, corr: corr, blocked: blocked, t: bt };
}

/* ---------- small safety net if anything goes wrong ---------- */
function fallback(obs) {
  try {
    const L = obs.lib, me = obs.self;
    const pr = L.predict(me, 3, { step: 1 / 15, radius: obs.rules.ship.radius + 30 });
    if (pr.hit) {
      const p = obs.planets[pr.hit.planet];
      const ang = Math.atan2(me.pos.y - p.pos.y, me.pos.x - p.pos.x);
      const err = L.wrapAngle(ang - me.angle);
      return { thrust: (err < 0.6 && err > -0.6) ? 1 : 0, turn: clamp(err * 2, -1, 1), fire: false };
    }
    const r = Math.sqrt(me.pos.x * me.pos.x + me.pos.y * me.pos.y);
    if (r > obs.arena.radius * 0.95) {
      const ang = Math.atan2(-me.pos.y, -me.pos.x);
      const err = L.wrapAngle(ang - me.angle);
      return { thrust: (err < 0.6 && err > -0.6) ? 1 : 0, turn: clamp(err * 2, -1, 1), fire: false };
    }
    return { thrust: 0, turn: 0, fire: false };
  } catch (e) { return { thrust: 0, turn: 0, fire: false }; }
}

/* ================================ main brain ================================ */
function brain(obs, mem) {
  const L = obs.lib, me = obs.self;
  const R = obs.rules.ship.radius, G = obs.G, AR = obs.arena.radius;
  const BS = obs.rules.weapon.bulletSpeed;
  const FMAX = obs.rules.ship.fuelMax || 85;
  const mass = obs.rules.ship.dryMass + obs.rules.ship.fuelMass * me.fuel / FMAX;
  const acc = obs.rules.ship.thrustForce / (mass > 0.2 ? mass : 0.2);
  const HOR = STEPS * DT;

  if (!mem.es) mem.es = {};
  if (mem.jsgn === undefined) { mem.jsgn = 1; mem.jt = -10; mem.lastTh = 0; mem.lastAng = me.angle; }

  /* ---- alive enemies ---- */
  const foes = [];
  const en = obs.enemies || [];
  for (let i = 0; i < en.length; i++) { const e = en[i]; if (e && e.alive && e.pos && e.vel) foes.push(e); }

  /* ---- estimate each enemy's thrust acceleration (measured minus gravity) ---- */
  const es = mem.es;
  for (let i = 0; i < foes.length; i++) {
    const e = foes[i];
    const st = es[e.id];
    if (!st) {
      es[e.id] = { px: e.pos.x, py: e.pos.y, vx: e.vel.x, vy: e.vel.y, t: obs.t, ax: 0, ay: 0 };
    } else {
      const d = obs.t - st.t;
      if (d > 0.005 && d < 0.5) {
        const g = L.gravityAt({ x: st.px, y: st.py }, st.t);
        let tx = (e.vel.x - st.vx) / d - g.x, ty = (e.vel.y - st.vy) / d - g.y;
        const m2 = tx * tx + ty * ty;
        if (m2 > 4900) { const s = 70 / Math.sqrt(m2); tx *= s; ty *= s; }
        st.ax = st.ax * 0.55 + tx * 0.45;
        st.ay = st.ay * 0.55 + ty * 0.45;
      }
      st.px = e.pos.x; st.py = e.pos.y; st.vx = e.vel.x; st.vy = e.vel.y; st.t = obs.t;
    }
  }

  /* ---- pick a target: close and weak ---- */
  let target = null, bsc = 1e18, trange = 0;
  for (let i = 0; i < foes.length; i++) {
    const e = foes[i];
    const dx = e.pos.x - me.pos.x, dy = e.pos.y - me.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const sc = d + e.hp * 2.5;
    if (sc < bsc) { bsc = sc; target = e; trange = d; }
  }

  const tab = buildTable(obs);

  /* ---- incoming enemy bullets worth dodging ---- */
  let nb = 0;
  const bl = obs.bullets || [];
  for (let i = 0; i < bl.length && nb < MAXB; i++) {
    const b = bl[i];
    if (!b || b.owner === me.id || b.ttl <= 0.05) continue;
    const dx = b.pos.x - me.pos.x, dy = b.pos.y - me.pos.y;
    const rvx = b.vel.x - me.vel.x, rvy = b.vel.y - me.vel.y;
    if (dx * rvx + dy * rvy >= 0) continue;
    if (dx * dx + dy * dy > 1440000) continue;
    const o = nb * 4;
    BB[o] = b.pos.x; BB[o + 1] = b.pos.y; BB[o + 2] = b.vel.x; BB[o + 3] = b.vel.y;
    nb++;
  }

  /* ---- coarse enemy future path (for positioning) ---- */
  let haveE = false, evEx = 0, evEy = 0;
  if (target) {
    const pr = L.predict(target, DT * (STEPS + 1), { step: DT });
    const pts = pr.points;
    const np = pts.length;
    if (np > 1) {
      const st = es[target.id];
      const fx = st ? st.ax * 0.6 : 0, fy = st ? st.ay * 0.6 : 0;
      for (let k = 0; k < STEPS; k++) {
        let idx = k + 1; if (idx > np - 1) idx = np - 1;
        const q = pts[idx], h = 0.5 * q.t * q.t;
        EX[k] = q.pos.x + fx * h; EY[k] = q.pos.y + fy * h;
      }
      const q = pts[np - 1];
      evEx = q.vel.x + fx * q.t; evEy = q.vel.y + fy * q.t;
      haveE = true;
    }
  }

  /* ---- gunnery: fine enemy path + iterated gravity aim ---- */
  let ePath = null, aim = null;
  if (target) {
    const H = clamp(trange / BS * 1.3 + 0.35, 0.5, 2.8);
    const pr = L.predict(target, H, { step: ASTEP });
    const pts = pr.points;
    if (pts.length > 2) {
      const st = es[target.id];
      const fx = st ? st.ax * 0.65 : 0, fy = st ? st.ay * 0.65 : 0;
      ePath = [];
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i], t = q.t, h = 0.5 * t * t;
        ePath.push({ t: t, x: q.pos.x + fx * h, y: q.pos.y + fy * h, vx: q.vel.x + fx * t, vy: q.vel.y + fy * t });
      }
      const lead = L.leadTarget(me, target, BS);
      const a0 = lead ? lead.angle : L.angleTo(me.pos, target.pos);
      let ev = evalShot(obs, me, ePath, a0, R, BS);
      for (let it = 0; it < 3; it++) {
        if (ev.miss < R * 0.3) break;
        const nx = evalShot(obs, me, ePath, L.wrapAngle(ev.angle + ev.corr), R, BS);
        if (nx.miss < ev.miss) ev = nx; else break;
      }
      aim = ev;
    }
  }
  const aimOk = !!(aim && !aim.blocked && aim.miss < 150);

  /* ---- engagement policy ---- */
  let rLo = 240, rHi = 640, wR = 0.05;
  const tl = obs.rules.timeLimit - obs.t;
  const hpd = me.hp - (target ? target.hp : 0);
  if (target && target.hp <= 25) { rLo = 200; rHi = 520; wR = 0.07; }
  if (hpd < -10) { rLo = 200; rHi = 560; wR = 0.065; }
  if (hpd > 10 && tl < 40) { rLo = 450; rHi = 1400; wR = 0.022; }
  if (me.fuel < 20) { if (rHi < 1000) rHi = 1000; wR *= 0.45; }
  if (me.ammo < 5) { rLo = 700; rHi = 1800; wR = 0.02; }
  const fuelVal = 1.3 + 13 * Math.max(0, (22 - me.fuel) / 22);

  /* ---- lateral weave when we are in someone's firing line ---- */
  let jx = 0, jy = 0, jink = false;
  if (target && trange < 1000 && trange > 1 && me.fuel > 28 && aimOk) {
    if (obs.t - mem.jt > 0.7) { mem.jt = obs.t; if (obs.rng() < 0.72) mem.jsgn = -mem.jsgn; }
    const ux = (target.pos.x - me.pos.x) / trange, uy = (target.pos.y - me.pos.y) / trange;
    jx = -uy * mem.jsgn; jy = ux * mem.jsgn; jink = true;
  }

  /* ---- candidate scoring ---- */
  const evalCand = function (th, ang, dxv, dyv, delay) {
    const r = simCand(tab, G, me.pos.x, me.pos.y, me.vel.x, me.vel.y, dxv, dyv, acc * th, delay, AR, nb);
    let s = 0;
    if (r.tHit >= 0) s -= 420 / (0.55 + r.tHit);
    if (r.minR < 1) s -= 75 * (1 - Math.sqrt(r.minR));
    if (r.outT > 0) s -= 15 * r.outT;
    const mr = Math.sqrt(r.maxR2);
    if (mr > AR * 0.92) s -= 0.06 * (mr - AR * 0.92);
    const gm = Math.sqrt(r.gE);
    if (gm > 24) s -= 0.9 * (gm - 24);
    for (let j = 0; j < nb; j++) {
      const d = Math.sqrt(BM[j]);
      if (d < R + 3) s -= 11;
      else if (d < 50) s -= 8 * (50 - d) / (47 - R);
    }
    if (haveE) {
      let minD2 = 1e18;
      for (let k = 0; k < STEPS; k++) {
        const ax = PX[k] - EX[k], ay = PY[k] - EY[k];
        const d2 = ax * ax + ay * ay;
        if (d2 < minD2) minD2 = d2;
      }
      const md = Math.sqrt(minD2);
      if (md < 110) s -= (110 - md) * 0.5;
      const fx = PX[STEPS - 1] - EX[STEPS - 1], fy = PY[STEPS - 1] - EY[STEPS - 1];
      const de = Math.sqrt(fx * fx + fy * fy);
      if (de > rHi) s -= (de - rHi) * wR;
      else if (de < rLo) s -= (rLo - de) * wR * 1.5;
      const rvx = r.evx - evEx, rvy = r.evy - evEy;
      const rsp = Math.sqrt(rvx * rvx + rvy * rvy);
      if (rsp > 230) s -= 0.012 * (rsp - 230);
      if (blockedAt(tab, 18, PX[18], PY[18], EX[18], EY[18])) s -= 14;
    }
    if (aimOk) {
      if (th <= 0) s += 8;
      else { const c = Math.cos(ang - aim.angle); if (c > 0) s += 8 * c; }
    }
    if (jink && th > 0) { const c = dxv * jx + dyv * jy; if (c > 0) s += 6 * c; }
    if (th > 0) { const bt = HOR - delay; if (bt > 0) s -= fuelVal * th * bt; }
    if (th > 0 && mem.lastTh > 0) {
      const da = L.wrapAngle(ang - mem.lastAng);
      if (da < 0.35 && da > -0.35) s += 4;
    }
    if (th <= 0 && mem.lastTh <= 0) s += 3;
    return { s: s, th: th, ang: ang, dx: dxv, dy: dyv, r: r };
  };

  const coast = evalCand(0, me.angle, 0, 0, 1e9);
  let best = coast, bestThrust = null;
  if (me.fuel > 0.25) {
    for (let ci = 0; ci < NDIR; ci++) {
      const ang = me.angle + ci * (TAU / NDIR);
      const ae = Math.abs(L.wrapAngle(ang - me.angle));
      const c = evalCand(1, ang, Math.cos(ang), Math.sin(ang), ae / 2.7 + 0.06);
      if (!bestThrust || c.s > bestThrust.s) bestThrust = c;
    }
    if (bestThrust && bestThrust.s > best.s) best = bestThrust;
    if (best.th > 0) {
      const ae = Math.abs(L.wrapAngle(best.ang - me.angle));
      const dly = ae / 2.7 + 0.06;
      for (let li = 0; li < 2; li++) {
        const c = evalCand(li === 0 ? 0.5 : 0.25, best.ang, best.dx, best.dy, dly);
        if (c.s > best.s) best = c;
      }
    }
  }

  const urgent = (coast.r.tHit >= 0 && coast.r.tHit < 2.1) || coast.r.outT > 0.3 || coast.r.minR < 0.3;

  /* ---- where to point the nose ---- */
  let nose;
  if (best.th > 0) nose = best.ang;
  else if (aimOk) nose = aim.angle;
  else if (bestThrust) nose = bestThrust.ang;
  else if (target) nose = L.angleTo(me.pos, target.pos);
  else nose = me.angle;

  /* ---- throttle, gated on alignment ---- */
  let thrustOut = 0;
  if (best.th > 0) {
    const ae = Math.abs(L.wrapAngle(best.ang - me.angle));
    if (urgent) { if (ae < 1.05) { const c = Math.cos(ae); thrustOut = best.th * (c > 0.4 ? c : 0.4); } }
    else if (ae < 0.3) thrustOut = best.th;
    else if (ae < 0.65) thrustOut = best.th * 0.45;
  }
  mem.lastTh = best.th; mem.lastAng = best.ang;

  /* ---- near time-optimal turn to the nose target ---- */
  const err = L.wrapAngle(nose - me.angle);
  const mag = err >= 0 ? err : -err;
  const wdes = (err >= 0 ? 1 : -1) * Math.min(3, Math.sqrt(19.2 * mag));
  let turn = clamp(wdes / 3, -1, 1);

  /* ---- trigger: evaluated at the real current nose angle ---- */
  let fire = false;
  if (aim && !aim.blocked && me.ammo > 0 && !me.overheated && aim.t > 0.01 && aim.t < 2.7 && ePath) {
    const ea = Math.abs(L.wrapAngle(aim.angle - me.angle));
    let m, tof = aim.t;
    if (ea < 0.14) {
      const ev2 = evalShot(obs, me, ePath, me.angle, R, BS);
      m = ev2.blocked ? 1e9 : ev2.miss;
      tof = ev2.t;
    } else {
      const sh = ea * BS * aim.t;
      m = Math.sqrt(aim.miss * aim.miss + sh * sh);
    }
    let thr = tof < 1.0 ? 13.5 : (tof < 1.9 ? 11 : 8.5);
    if (trange < 200) thr = 15;
    const hc = m < 8 ? 84 : 66;
    if (m < thr && me.heat <= hc) fire = true;
  }

  if (!(thrustOut >= 0)) thrustOut = 0;
  if (thrustOut > 1) thrustOut = 1;
  if (!(turn >= -1 && turn <= 1)) turn = 0;
  return { thrust: thrustOut, turn: turn, fire: fire };
}

export default function control(obs, mem) {
  try {
    return brain(obs, mem);
  } catch (e) {
    return fallback(obs);
  }
}
