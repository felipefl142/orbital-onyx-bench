function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

export default function control(obs, mem) {
  const L = obs.lib, me = obs.self, r = obs.rules, R = r.ship.radius, W = r.weapon;
  const wrap = L.wrapAngle;

  // ---------- 1. escape imminent planet impact / arena exit ----------
  const fp = L.predict(me, 3, { step: 0.05, radius: R + 45 });
  let esc = null;
  if (fp.hit) {
    const p = obs.planets[fp.hit.planet];
    const n = L.norm(L.sub(me.pos, p.pos));            // outward from planet
    const tg = { x: -n.y, y: n.x };                    // prograde-ish tangent
    const sg = L.dot(L.sub(me.vel, p.vel), tg) >= 0 ? 1 : -1;
    esc = { dir: L.norm(L.add(L.scale(tg, sg), n)), t: fp.hit.t };
  } else if (fp.leavesArena) {
    const rr = Math.max(1, L.len(me.pos));
    esc = { dir: L.scale(me.pos, -1 / rr), t: 2.5 };
  }
  if (esc && me.fuel > 0.5) {
    const a = Math.atan2(esc.dir.y, esc.dir.x);
    const e = Math.abs(wrap(a - me.angle));
    return { thrust: e < 0.9 ? 1 : 0, turn: clamp(wrap(a - me.angle) * 5 - me.angVel * 0.3, -1, 1), fire: false };
  }

  // ---------- 2. incoming bullet threat ----------
  let th = null;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const dx = b.pos.x - me.pos.x, dy = b.pos.y - me.pos.y;
    const ux = b.vel.x - me.vel.x, uy = b.vel.y - me.vel.y;
    const uu = ux * ux + uy * uy;
    if (uu < 1) continue;
    const tt = -(dx * ux + dy * uy) / uu;
    if (tt <= 0 || tt > 0.75 || tt > b.ttl) continue;
    const mx = dx + ux * tt, my = dy + uy * tt;
    if (Math.hypot(mx, my) < R * 2.6 && (!th || tt < th.t)) th = { t: tt, mx, my, ux, uy };
  }

  // ---------- 3. pick target ----------
  let tgt = null, td = Infinity;
  for (const en of obs.enemies) {
    if (!en.alive) continue;
    const d = Math.hypot(en.pos.x - me.pos.x, en.pos.y - me.pos.y);
    if (d < td) { td = d; tgt = en; }
  }

  // ---------- 4. gravity-corrected aim ----------
  let aimA = tgt ? L.angleTo(me.pos, tgt.pos) : me.angle;
  let miss = 1e9, blocked = true;
  if (tgt) {
    const lead = L.leadTarget(me, tgt, W.bulletSpeed);
    if (lead && lead.time < 2.9) {
      aimA = lead.angle; blocked = false;
      const hz = Math.min(3, lead.time + 0.3);
      const ep = L.predict(tgt, hz, { step: 1 / 30 }).points;
      const ev = (ang) => {
        const c = Math.cos(ang), s = Math.sin(ang);
        const bp = L.predict({
          pos: { x: me.pos.x + c * (R + 2), y: me.pos.y + s * (R + 2) },
          vel: { x: me.vel.x + c * W.bulletSpeed, y: me.vel.y + s * W.bulletSpeed }
        }, hz, { step: 1 / 30, radius: 0 });
        const n = Math.min(bp.points.length, ep.length);
        let bs = 1e18, at = -1;
        for (let i = 0; i < n; i++) {
          const dx = bp.points[i].pos.x - ep[i].pos.x, dy = bp.points[i].pos.y - ep[i].pos.y;
          const dd = dx * dx + dy * dy;
          if (dd < bs) { bs = dd; at = i; }
        }
        if (at < 0) return { ang, miss: 1e9, corr: 0, blk: true };
        const ex = ep[at].pos.x - bp.points[at].pos.x, ey = ep[at].pos.y - bp.points[at].pos.y;
        const rx = ep[at].pos.x - me.pos.x, ry = ep[at].pos.y - me.pos.y;
        const rg = Math.max(1, Math.hypot(rx, ry));
        return {
          ang, miss: Math.sqrt(bs),
          corr: (c * ey - s * ex) / rg,
          blk: !!(bp.hit && bp.hit.t <= bp.points[at].t)
        };
      };
      let cur = ev(aimA);
      for (let k = 0; k < 2 && cur.miss > R * 0.5; k++) {
        const nx = ev(cur.ang + clamp(cur.corr, -0.3, 0.3));
        if (nx.miss >= cur.miss) break;
        cur = nx;
      }
      aimA = cur.ang; miss = cur.miss; blocked = cur.blk;
    }
  }

  // ---------- 5. heat management ----------
  if (me.heat > 72) mem.hold = true;
  else if (me.heat < 42) mem.hold = false;
  const aimErr = Math.abs(wrap(aimA - me.angle));
  const tol = Math.atan2(R * 0.75, Math.max(td, 1)) + 0.012;
  const fire = !!tgt && !blocked && miss < R * 1.35 && aimErr < tol &&
               me.cooldown <= 0 && !me.overheated && !mem.hold && me.ammo > 0;

  // ---------- 6. movement desire: keep range, avoid planets and edge ----------
  let wx = 0, wy = 0;
  if (tgt) {
    const inv = 1 / Math.max(1, td);
    const want = clamp((td - 800) / 500, -0.5, 1) * 110;
    wx += (tgt.pos.x - me.pos.x) * inv * want;
    wy += (tgt.pos.y - me.pos.y) * inv * want;
  }
  for (const p of obs.planets) {
    const dx = me.pos.x - p.pos.x, dy = me.pos.y - p.pos.y;
    const dd = Math.max(1, Math.hypot(dx, dy));
    const safe = p.radius * 3 + 150;
    if (dd < safe) { const w = (1 - dd / safe) * 220; wx += dx / dd * w; wy += dy / dd * w; }
  }
  const rr = Math.max(1, L.len(me.pos));
  const band = obs.arena.radius * 0.78;
  if (rr > band) {
    const w = clamp((rr - band) / (obs.arena.radius - band), 0, 1) * 260;
    wx -= me.pos.x / rr * w; wy -= me.pos.y / rr * w;
  }
  const dvx = wx - me.vel.x, dvy = wy - me.vel.y;
  const dvm = Math.hypot(dvx, dvy);
  const ang = dvm > 1 ? Math.atan2(dvy, dvx) : me.angle;

  let turn, thrust;
  if (th && me.fuel > 0.5) {
    const sg = (-th.uy * th.mx + th.ux * th.my) > 0 ? -1 : 1;   // away from the miss side
    const a = Math.atan2(th.ux * sg, -th.uy * sg);
    const e = wrap(a - me.angle);
    turn = clamp(e * 5 - me.angVel * 0.3, -1, 1);
    thrust = Math.abs(e) < 1.0 ? 1 : 0;
  } else if (dvm > 160) {                                        // repositioning burn
    const e = wrap(ang - me.angle);
    turn = clamp(e * 4 - me.angVel * 0.3, -1, 1);
    thrust = Math.abs(e) < 0.9 ? clamp(dvm / 90, 0, 1) : 0;
  } else {                                                       // gunner stance
    turn = clamp(wrap(aimA - me.angle) * 4 - me.angVel * 0.3, -1, 1);
    thrust = (dvm > 20 && Math.abs(wrap(ang - aimA)) < 1.0) ? clamp(dvm / 90, 0, 1) : 0;
  }
  if (me.fuel <= 0) thrust = 0;
  return { thrust, turn, fire };
}
