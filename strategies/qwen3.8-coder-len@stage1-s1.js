const TAU = Math.PI * 2;

function fin(x) { return Number.isFinite(x); }
function clamp(x, a, b) { x = +x; return fin(x) ? (x < a ? a : x > b ? b : x) : a; }
function wrap(a) {
  a = +a;
  if (!fin(a)) return 0;
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
function len(x, y) {
  const l = Math.sqrt(x * x + y * y);
  return fin(l) ? l : 0;
}
function norm(x, y) {
  const l = Math.sqrt(x * x + y * y);
  if (!fin(l) || l < 1e-9) return [1, 0];
  return [x / l, y / l];
}
function steer(me, angle) {
  const err = wrap(angle - (me.angle || 0));
  const turn = clamp(err * 3 - (me.angVel || 0) * 0.4, -1, 1);
  return [err, turn];
}
function burnDv(me, fuel, dvx, dvy, scale, minMag, maxThrust) {
  const mag = len(dvx, dvy);
  if (mag < minMag) return { thrust: 0, turn: 0, fire: false };
  const ang = Math.atan2(dvy, dvx);
  const s = steer(me, ang);
  const thrust = (fuel > 0 && Math.abs(s[0]) < 0.6) ? clamp(mag / scale, 0, maxThrust) : 0;
  return { thrust: clamp(thrust, 0, 1), turn: clamp(s[1], -1, 1), fire: false };
}

function danger(obs, me, fuel, R, AR, L) {
  if (fuel <= 0) return null;
  const p = me.pos, v = me.vel;
  let pr = null;
  try {
    pr = L.predict(
      { pos: { x: p.x, y: p.y }, vel: { x: v.x, y: v.y } },
      6,
      { step: 0.05, radius: R + 20 }
    );
  } catch (e) {}
  if (!pr) return null;

  if (pr.hit && fin(pr.hit.t) && pr.hit.t < 4.5) {
    const pl = (obs.planets || [])[pr.hit.planet];
    if (!pl || !pl.pos) return null;
    const n = norm(p.x - pl.pos.x, p.y - pl.pos.y);
    const tang = [-n[1], n[0]];
    const plv = pl.vel || { x: 0, y: 0 };
    const rvx = v.x - plv.x, rvy = v.y - plv.y;
    const sg = (rvx * tang[0] + rvy * tang[1] >= 0) ? 1 : -1;
    let d = norm(n[0] + tang[0] * sg * 0.8, n[1] + tang[1] * sg * 0.8);
    const r = len(p.x, p.y);
    if (r > AR - 300) {
      const c = norm(-p.x, -p.y);
      d = norm(d[0] + c[0] * 0.8, d[1] + c[1] * 0.8);
    }
    return { dx: d[0] * 160, dy: d[1] * 160 };
  }

  const r = len(p.x, p.y) || 1;
  const outward = (v.x * p.x + v.y * p.y) / r;
  if (pr.leavesArena || r > AR * 0.95 || (r > AR * 0.88 && outward > -20)) {
    const d = norm(-p.x, -p.y);
    return { dx: d[0] * 160, dy: d[1] * 160 };
  }
  return null;
}

function incoming(obs, me, R) {
  const p = me.pos, v = me.vel, id = me.id || '';
  let th = null;
  for (const b of (obs.bullets || [])) {
    if (!b || b.owner === id || !b.pos || !b.vel) continue;
    const dx = b.pos.x - p.x, dy = b.pos.y - p.y;
    const ux = b.vel.x - v.x, uy = b.vel.y - v.y;
    const uu = ux * ux + uy * uy;
    if (uu < 1) continue;
    const tt = -(dx * ux + dy * uy) / uu;
    if (!fin(tt) || tt <= 0 || tt > 1.25 || tt > (b.ttl || 0)) continue;
    const mx = dx + ux * tt, my = dy + uy * tt;
    const miss = len(mx, my);
    if (miss < R * 3 && (!th || tt < th.tt)) {
      th = { tt, mx, my, ux, uy, bx: b.pos.x, by: b.pos.y };
    }
  }
  return th;
}

function dodgeDv(me, th, AR) {
  const p = me.pos;
  const n = norm(-th.uy, th.ux);
  const sg = (n[0] * th.mx + n[1] * th.my > 0) ? -1 : 1;
  let dx = n[0] * sg, dy = n[1] * sg;
  const away = norm(p.x - th.bx, p.y - th.by);
  dx += away[0] * 0.6;
  dy += away[1] * 0.6;
  const r = len(p.x, p.y);
  if (r > AR - 300) {
    const c = norm(-p.x, -p.y);
    dx += c[0] * 0.8;
    dy += c[1] * 0.8;
  }
  const d = norm(dx, dy);
  return { dx: d[0] * 140, dy: d[1] * 140 };
}

function aimAt(obs, target, R, BS, maxLife) {
  const L = obs.lib, me = obs.self, p = me.pos, v = me.vel;
  let direct = Math.atan2(target.pos.y - p.y, target.pos.x - p.x);
  if (!fin(direct)) direct = 0;

  let lead = null;
  try {
    lead = L.leadTarget(
      { pos: { x: p.x, y: p.y }, vel: { x: v.x, y: v.y } },
      target,
      BS
    );
  } catch (e) {}

  let angle = (lead && fin(lead.angle)) ? lead.angle : direct;
  let time = (lead && fin(lead.time)) ? lead.time : len(target.pos.x - p.x, target.pos.y - p.y) / Math.max(1, BS);
  if (!fin(angle)) angle = direct;
  if (!fin(time)) time = 0;
  if (time < 0) time = 0;
  if (time > maxLife) return { angle, miss: 1e9, blocked: true, t: time };

  const horizon = clamp(time + 0.4, 0.2, maxLife);
  const step = 1 / 120;
  const tv = target.vel || { x: 0, y: 0 };

  let ep = [];
  try {
    ep = (L.predict(
      { pos: { x: target.pos.x, y: target.pos.y }, vel: { x: tv.x, y: tv.y } },
      horizon,
      { step }
    ).points) || [];
  } catch (e) {}
  if (!ep.length) return { angle, miss: 1e9, blocked: false, t: time };

  const evaluate = (ang) => {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const bullet = {
      pos: { x: p.x + dx * (R + 2), y: p.y + dy * (R + 2) },
      vel: { x: v.x + dx * BS, y: v.y + dy * BS }
    };
    let bp = null;
    try {
      bp = L.predict(bullet, horizon, { step, radius: 0 });
    } catch (e) {}
    if (!bp) return { a: ang, miss: 1e9, blocked: true, corr: 0, t: 0 };

    const bps = bp.points || [];
    let best = 1e9, at = -1;
    const n = Math.min(bps.length, ep.length);
    for (let i = 0; i < n; i++) {
      const ddx = bps[i].pos.x - ep[i].pos.x;
      const ddy = bps[i].pos.y - ep[i].pos.y;
      const dd = len(ddx, ddy);
      if (dd < best) { best = dd; at = i; }
    }
    if (at < 0) return { a: ang, miss: 1e9, blocked: true, corr: 0, t: 0 };

    const offx = ep[at].pos.x - bps[at].pos.x;
    const offy = ep[at].pos.y - bps[at].pos.y;
    const range = Math.max(1, len(ep[at].pos.x - p.x, ep[at].pos.y - p.y));
    const blocked = !!(bp.hit && fin(bp.hit.t) && bp.hit.t <= (bps[at].t || 0));
    const corr = (dx * offy - dy * offx) / range;
    return { a: ang, miss: best, blocked, corr: fin(corr) ? corr : 0, t: bps[at].t || 0 };
  };

  let ev = evaluate(angle);
  if (Math.abs(wrap(direct - angle)) > 0.02) {
    const ev2 = evaluate(direct);
    if (ev2.miss < ev.miss) ev = ev2;
  }

  for (let k = 0; k < 3 && ev.miss > R * 0.6; k++) {
    const c = clamp(ev.corr, -0.4, 0.4);
    if (Math.abs(c) < 1e-4) break;
    const nv = evaluate(ev.a + c);
    if (nv.miss >= ev.miss) break;
    ev = nv;
  }

  return { angle: ev.a, miss: ev.miss, blocked: ev.blocked, t: ev.t };
}

export default function control(obs, mem) {
  try {
    if (!mem) mem = {};
    if (!obs || !obs.lib || !obs.self) return { thrust: 0, turn: 0, fire: false };

    const L = obs.lib;
    const me = obs.self;
    const p = me.pos || { x: 0, y: 0 };
    const v = me.vel || { x: 0, y: 0 };

    const rules = obs.rules || {};
    let R = +((rules.ship || {}).radius) || 12;
    let AR = +((obs.arena || {}).radius) || 2000;
    let BS = +((rules.weapon || {}).bulletSpeed) || 600;
    let maxLife = +((rules.weapon || {}).bulletLife) || 3;
    let timeLimit = +rules.timeLimit || 120;
    if (!fin(R) || R <= 0) R = 12;
    if (!fin(AR) || AR <= 0) AR = 2000;
    if (!fin(BS) || BS <= 0) BS = 600;
    if (!fin(maxLife) || maxLife <= 0) maxLife = 3;
    if (!fin(timeLimit) || timeLimit <= 0) timeLimit = 120;

    const fuel = fin(+me.fuel) ? +me.fuel : 0;
    const hp = fin(+me.hp) ? +me.hp : 0;
    const heat = fin(+me.heat) ? +me.heat : 0;
    const ammo = fin(+me.ammo) ? +me.ammo : 0;
    const overheated = !!me.overheated;
    const cooldown = fin(+me.cooldown) ? +me.cooldown : 0;
    const t = fin(+obs.t) ? +obs.t : 0;

    if (fin(mem.lastT) && t < mem.lastT - 1) {
      mem.aimUntil = 0;
      mem.nextAim = 0;
      mem.blockedCount = 0;
    }
    mem.lastT = t;

    if (mem.side !== 1 && mem.side !== -1) {
      let s = 1;
      try { if (obs.rng) s = obs.rng() < 0.5 ? 1 : -1; } catch (e) {}
      mem.side = s;
    }
    if (!fin(mem.aimUntil)) mem.aimUntil = 0;
    if (!fin(mem.nextAim)) mem.nextAim = 0;
    if (!fin(mem.blockedCount)) mem.blockedCount = 0;

    const dg = danger(obs, me, fuel, R, AR, L);
    if (dg) return burnDv(me, fuel, dg.dx, dg.dy, 160, 10, 1);

    const th = incoming(obs, me, R);
    if (th) {
      const dd = dodgeDv(me, th, AR);
      return burnDv(me, fuel, dd.dx, dd.dy, 140, 10, 1);
    }

    let target = null, td = 1e9, bestScore = 1e9;
    for (const e of (obs.enemies || [])) {
      if (!e || !e.alive || !e.pos) continue;
      const d = len(e.pos.x - p.x, e.pos.y - p.y);
      const hpE = fin(+e.hp) ? +e.hp : 0;
      let sc = d;
      if (hpE < 30 && d < 1000) sc -= 400;
      if (hpE < 10 && d < 1500) sc -= 800;
      if (sc < bestScore) { bestScore = sc; target = e; td = d; }
    }

    if (!target) {
      if (fuel > 15) {
        const r = len(p.x, p.y);
        const speed = len(v.x, v.y);
        if (r > AR * 0.7 || speed > 150) {
          let dvx = -v.x * 0.5, dvy = -v.y * 0.5;
          if (r > AR * 0.7) {
            const c = norm(-p.x, -p.y);
            dvx += c[0] * 100;
            dvy += c[1] * 100;
          }
          return burnDv(me, fuel, dvx, dvy, 150, 10, 0.6);
        }
      }
      return { thrust: 0, turn: 0, fire: false };
    }

    const directAngle = Math.atan2(target.pos.y - p.y, target.pos.x - p.x);
    if (!fin(directAngle)) directAngle = 0;

    const fireRange = 1700;
    let aim;
    if (td > fireRange || ammo <= 0 || overheated) {
      aim = { angle: directAngle, miss: 1e9, blocked: true, t: 0 };
    } else {
      aim = aimAt(obs, target, R, BS, maxLife);
    }

    const targetHp = fin(+target.hp) ? +target.hp : 0;
    const evel = target.vel || { x: 0, y: 0 };
    const eSpeed = len(evel.x, evel.y);
    const radial = norm(p.x - target.pos.x, p.y - target.pos.y);
    const tangent = [-radial[1] * mem.side, radial[0] * mem.side];

    let desiredDist = 650;
    if (eSpeed < 30) desiredDist = 500;
    else if (eSpeed > 120) desiredDist = 850;
    if (hp < 40) desiredDist += 150;
    if (targetHp < 30) desiredDist -= 80;
    if (fuel < 20) desiredDist = 900;

    const endSafe = t > timeLimit - 10 && hp > targetHp + 10;
    if (endSafe) desiredDist = 1200;
    if (hp < 25) desiredDist = 1100;
    desiredDist = clamp(desiredDist, 350, 1200);

    let strafeSpeed = 110;
    if (fuel < 20) strafeSpeed = 40;
    if (hp < 30) strafeSpeed = 70;
    if (eSpeed > 120) strafeSpeed = 150;
    if (td < 400) strafeSpeed = 60;
    if (endSafe) strafeSpeed = 50;

    const radialVel = clamp((td - desiredDist) * 0.8, -200, 200);
    let dvx = evel.x + radial[0] * radialVel + tangent[0] * strafeSpeed;
    let dvy = evel.y + radial[1] * radialVel + tangent[1] * strafeSpeed;

    const r = len(p.x, p.y);
    if (r > AR * 0.8) {
      const c = norm(-p.x, -p.y);
      const push = (r - AR * 0.8) * 2;
      dvx += c[0] * push;
      dvy += c[1] * push;
    }

    for (const pl of (obs.planets || [])) {
      if (!pl || !pl.pos) continue;
      const dx = p.x - pl.pos.x, dy = p.y - pl.pos.y;
      const d = len(dx, dy);
      const min = (pl.radius || 0) + 180;
      if (d < min) {
        const n = norm(dx, dy);
        const push = (min - d) * 1.5;
        dvx += n[0] * push;
        dvy += n[1] * push;
      }
    }

    let sp = len(dvx, dvy);
    if (sp > 300) {
      const s = 300 / sp;
      dvx *= s;
      dvy *= s;
    }

    const dvx2 = dvx - v.x, dvy2 = dvy - v.y;
    const dvMag = len(dvx2, dvy2);

    let heatLimit = 55;
    if (targetHp < 30) heatLimit = 80;
    if (targetHp < 15) heatLimit = 95;

    let aimHeat = 45;
    if (targetHp < 30) aimHeat = 70;
    if (targetHp < 15) aimHeat = 85;

    if (endSafe) {
      heatLimit = 0;
      aimHeat = 0;
    }
    if (hp < 25 && targetHp > 20) {
      heatLimit = Math.min(heatLimit, 40);
      aimHeat = Math.min(aimHeat, 30);
    }

    let canFireBase =
      ammo > 0 &&
      !overheated &&
      cooldown <= 0 &&
      heat < heatLimit &&
      td < fireRange &&
      aim.miss < R * 1.3 &&
      !aim.blocked;

    if (ammo < 10 && targetHp > 20) canFireBase = false;

    if (!canFireBase) mem.aimUntil = 0;
    if (td > 220 && td > desiredDist - 80 && canFireBase && heat < aimHeat && t >= mem.nextAim) {
      mem.aimUntil = t + 0.6;
      mem.nextAim = t + 1.1;
    }
    const aimMode = t < mem.aimUntil && td > 220 && td > desiredDist - 80;

    if (aim.blocked && td < fireRange) {
      mem.blockedCount += 1;
      if (mem.blockedCount > 6) {
        mem.side = -mem.side;
        mem.blockedCount = 0;
      }
    } else {
      mem.blockedCount = 0;
    }

    const errAim = wrap(aim.angle - (me.angle || 0));
    const alignTol = Math.atan2(R * 0.9, Math.max(50, td)) + 0.05;
    let fire = canFireBase && Math.abs(errAim) < alignTol && td > 200;

    const reserve = 10;
    let turn = 0, thrust = 0;

    if (aimMode) {
      const s = steer(me, aim.angle);
      turn = s[1];
      if (fuel > reserve && td > desiredDist + 80 && Math.abs(s[0]) < 0.4) {
        thrust = clamp((td - desiredDist) / 400, 0.2, 0.6);
      }
    } else {
      if (dvMag > 15 && fuel > reserve) {
        const s = steer(me, Math.atan2(dvy2, dvx2));
        turn = s[1];
        if (Math.abs(s[0]) < 0.5) thrust = clamp(dvMag / 180, 0, 0.8);
      } else {
        const s = steer(me, aim.angle);
        turn = s[1];
      }
    }

    return { thrust: clamp(thrust, 0, 1), turn: clamp(turn, -1, 1), fire: !!fire };
  } catch (e) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
