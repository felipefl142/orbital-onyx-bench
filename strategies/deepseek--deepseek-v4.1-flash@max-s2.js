function cl(x, a, b) { return x < a ? a : x > b ? b : x; }

export default function control(obs, mem) {
  const L = obs.lib, me = obs.self, R = obs.rules.ship.radius, W = obs.rules.weapon, A = obs.arena.radius;

  // ---- nearest enemy ----
  let tg = null, td = 1e9;
  for (const e of obs.enemies) { if (!e.alive) continue; const d = L.len(L.sub(e.pos, me.pos)); if (d < td) { td = d; tg = e; } }

  // ---- incoming bullet threat ----
  let bt = 9, bm = null, bu = null;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const d = L.sub(b.pos, me.pos), u = L.sub(b.vel, me.vel), uu = L.dot(u, u);
    if (uu < 1) continue;
    const t = -L.dot(d, u) / uu;
    if (t <= 0 || t > 1.3) continue;
    const m = L.add(d, L.scale(u, t));
    if (L.len(m) < R * 3.2 && t < bt) { bt = t; bm = m; bu = u; }
  }

  // ---- crash / ring-out avoidance ----
  const path = L.predict(me, 3, { step: 1 / 30, radius: R + 30 });
  let esc = null;
  if (path.hit) {
    const p = obs.planets[path.hit.planet];
    const rel = L.sub(me.pos, p.pos), r = Math.max(L.len(rel), 1);
    const rad = L.scale(rel, 1 / r), tn = { x: -rad.y, y: rad.x };
    const sg = L.dot(L.sub(me.vel, p.vel), tn) >= 0 ? 1 : -1;
    if (path.hit.t < 2.2) esc = L.norm(L.add(L.scale(tn, sg), L.scale(rad, 1.3)));
  }
  if (!esc) {
    const r = Math.max(L.len(me.pos), 1), rad = L.scale(me.pos, 1 / r);
    if (path.leavesArena || (r > A * 0.85 && L.dot(me.vel, rad) > -25)) esc = L.scale(rad, -1);
  }

  // ---- gravity-corrected aim ----
  const aimE = (e, H) => {
    const ld = L.leadTarget(me, e, W.bulletSpeed);
    if (!ld || ld.time > H) return null;
    const hz = Math.min(3, ld.time + 0.4), ep = L.predict(e, hz, { step: 1 / 30 }).points;
    if (ep.length < 3) return null;
    const ev = (a) => {
      const d = { x: Math.cos(a), y: Math.sin(a) };
      const bp = L.predict({ pos: L.add(me.pos, L.scale(d, R + 4)), vel: L.add(me.vel, L.scale(d, W.bulletSpeed)) }, hz, { step: 1 / 30, radius: 0 });
      let bs = 1e9, at = -1; const n = Math.min(bp.points.length, ep.length);
      for (let i = 0; i < n; i++) { const dd = L.len(L.sub(bp.points[i].pos, ep[i].pos)); if (dd < bs) { bs = dd; at = i; } }
      if (at < 0) return { a, miss: 1e9, blk: 1, t: hz };
      const off = L.sub(ep[at].pos, bp.points[at].pos), rg = Math.max(1, L.len(L.sub(ep[at].pos, me.pos)));
      return { a, miss: bs, blk: !!(bp.hit && bp.hit.t <= bp.points[at].t), c: L.cross(d, off) / rg, t: bp.points[at].t };
    };
    let r0 = ev(ld.angle);
    for (let k = 0; k < 2 && r0.miss > R * 0.6; k++) { const r1 = ev(r0.a + r0.c); if (r1.miss >= r0.miss) break; r0 = r1; }
    return r0;
  };

  const MF = Math.atan2(R * 0.85, Math.max(td, 50)) + 0.02;
  const res = (tg && td < 1750) ? aimE(tg, 2.8) : null;
  const wantA = (res && !res.blk) ? res.a : (tg ? L.angleTo(me.pos, tg.pos) : me.angle);
  const err = L.wrapAngle(wantA - me.angle);
  let turn = cl(err * 4 - me.angVel * 0.2, -1, 1), thr = 0, f = false;

  if (me.heat > 85) mem.hold = 1; else if (me.heat < 45) mem.hold = 0;
  if (res && !res.blk && res.miss < R * 1.15 && Math.abs(err) < MF && !me.overheated && !mem.hold && me.ammo > 0 && me.cooldown <= 0) f = true;

  if (esc) {                                    // survival has absolute priority
    const es = L.wrapAngle(Math.atan2(esc.y, esc.x) - me.angle);
    turn = cl(es * 5 - me.angVel * 0.2, -1, 1);
    thr = Math.abs(es) < 0.9 ? 1 : 0;
  } else if (bm && bt < 1.1 && me.fuel > 4) {   // dodge
    const sd = L.norm({ x: -bu.y, y: bu.x }), sg = L.dot(sd, bm) > 0 ? -1 : 1;
    const da = L.wrapAngle(Math.atan2(sd.y * sg, sd.x * sg) - me.angle);
    if (Math.abs(da) < 1.3) { turn = cl(da * 6, -1, 1); thr = 1; f = false; }
  } else if (tg) {
    if (td < 220) mem.ret = obs.t + 0.45;       // too close: back off briefly
    if (mem.ret && obs.t < mem.ret && me.fuel > 2) {
      const ea = L.wrapAngle(L.angleTo(tg.pos, me.pos) - me.angle);
      turn = cl(ea * 5 - me.angVel * 0.2, -1, 1);
      thr = Math.abs(ea) < 0.8 ? 1 : 0;
      if (td > 420) mem.ret = 0;
    } else if (td > 620 && me.fuel > 4 && Math.abs(err) < 0.5) {
      thr = Math.min(1, (td - 550) / 300 + 0.3); // close the distance, nose on target
    }
  }

  return { thrust: thr, turn, fire: f };
}
