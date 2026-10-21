function cl(x, a, b) { return x < a ? a : x > b ? b : x; }

export default function control(obs, mem) {
  const L = obs.lib, me = obs.self, r = obs.rules, R = r.ship.radius, W = r.weapon;
  const wrap = L.wrapAngle;
  const px = me.pos.x, py = me.pos.y, vx = me.vel.x, vy = me.vel.y;

  // ---------- target ----------
  let tgt = null, td = 1e9, nA = 0;
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    nA++;
    const d = Math.hypot(e.pos.x - px, e.pos.y - py);
    if (d < td) { td = d; tgt = e; }
  }

  // ---------- 1. escape planet impact / arena exit ----------
  const fp = L.predict(me, 3, { step: 0.05, radius: nA ? R + 40 : R + 160 });
  let esc = null;
  if (fp.hit) {
    const p = obs.planets[fp.hit.planet];
    const nx = px - p.pos.x, ny = py - p.pos.y, nl = Math.max(1, Math.hypot(nx, ny));
    const ux = nx / nl, uy = ny / nl;
    const sg = (-uy * (vx - p.vel.x) + ux * (vy - p.vel.y)) >= 0 ? 1 : -1;
    const ex = -uy * sg + ux * 1.2, ey = ux * sg + uy * 1.2, el = Math.max(1, Math.hypot(ex, ey));
    esc = { x: ex / el, y: ey / el };
  } else if (fp.leavesArena) {
    const rl = Math.max(1, Math.hypot(px, py));
    esc = { x: -px / rl, y: -py / rl };
  }
  if (esc && me.fuel > 0.5) {
    const e = wrap(Math.atan2(esc.y, esc.x) - me.angle);
    return { thrust: Math.abs(e) < 0.9 ? 1 : 0, turn: cl(e * 5 - me.angVel * 0.3, -1, 1), fire: false };
  }

  // ---------- 2. incoming bullet threat ----------
  let th = null;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const dx = b.pos.x - px, dy = b.pos.y - py;
    const ux = b.vel.x - vx, uy = b.vel.y - vy;
    const uu = ux * ux + uy * uy;
    if (uu < 1) continue;
    const tt = -(dx * ux + dy * uy) / uu;
    if (tt <= 0 || tt > 0.85 || tt > b.ttl) continue;
    const mx = dx + ux * tt, my = dy + uy * tt;
    if (mx * mx + my * my < R * R * 6.8 && (!th || tt < th.t)) th = { t: tt, mx, my, ux, uy };
  }
  let dodge = null;
  if (th) {
    const ul = Math.max(1, Math.hypot(th.ux, th.uy));
    const sx = -th.uy / ul, sy = th.ux / ul;
    const sg = (sx * th.mx + sy * th.my) > 0 ? -1 : 1;
    dodge = { x: sx * sg, y: sy * sg, t: th.t };
  }

  // ---------- 3. gravity-corrected aim ----------
  let aimA = tgt ? Math.atan2(tgt.pos.y - py, tgt.pos.x - px) : me.angle;
  let miss = 1e9, blocked = true;
  if (tgt) {
    const lead = L.leadTarget(me, tgt, W.bulletSpeed);
    if (lead && lead.time < 2.6) {
      aimA = lead.angle; blocked = false;
      const hz = Math.min(3, lead.time + 0.35);
      const ep = L.predict(tgt, hz, { step: 1 / 60 }).points;
      const ev = (ang) => {
        const c = Math.cos(ang), s = Math.sin(ang);
        const bp = L.predict({
          pos: { x: px + c * (R + 2), y: py + s * (R + 2) },
          vel: { x: vx + c * W.bulletSpeed, y: vy + s * W.bulletSpeed }
        }, hz, { step: 1 / 60, radius: 0 });
        const n = Math.min(bp.points.length, ep.length);
        let bs = 1e18, at = -1;
        for (let i = 0; i < n; i++) {
          const dx = bp.points[i].pos.x - ep[i].pos.x, dy = bp.points[i].pos.y - ep[i].pos.y;
          const dd = dx * dx + dy * dy;
          if (dd < bs) { bs = dd; at = i; }
        }
        if (at < 0) return { ang, miss: 1e9, corr: 0, blk: true };
        const ex = ep[at].pos.x - bp.points[at].pos.x, ey = ep[at].pos.y - bp.points[at].pos.y;
        const rx = ep[at].pos.x - px, ry = ep[at].pos.y - py;
        const rg = Math.max(1, Math.hypot(rx, ry));
        return { ang, miss: Math.sqrt(bs), corr: (c * ey - s * ex) / rg, blk: !!(bp.hit && bp.hit.t <= bp.points[at].t) };
      };
      let cur = ev(aimA);
      for (let k = 0; k < 3 && cur.miss > R * 0.4; k++) {
        const nx = ev(cur.ang + cl(cur.corr, -0.35, 0.35));
        if (nx.miss >= cur.miss) break;
        cur = nx;
      }
      aimA = cur.ang; miss = cur.miss; blocked = cur.blk;
    }
  }

  // ---------- 4. fire control ----------
  const aimErr = Math.abs(wrap(aimA - me.angle));
  const tol = Math.atan2(R * 0.7, Math.max(td, 1)) + 0.012;
  const fire = !!tgt && !blocked && aimErr < tol && me.cooldown <= 0 && !me.overheated && me.ammo > 0 &&
    (me.heat < 62 ? miss < R * 1.25 : (me.heat < 90 && miss < R * 0.75));

  // ---------- 5. movement desire ----------
  let wx = 0, wy = 0;
  if (tgt) {
    const inv = 1 / Math.max(1, td);
    const ux = (tgt.pos.x - px) * inv, uy = (tgt.pos.y - py) * inv;
    const want = cl((td - 780) / 450, -1, 1) * 130;
    wx += ux * want; wy += uy * want;
    const tx = -uy, ty = ux;
    const sg = (tx * (vx - tgt.vel.x) + ty * (vy - tgt.vel.y)) >= 0 ? 1 : -1;
    const orb = cl((1100 - td) / 1100, 0, 1) * cl((td - 250) / 250, 0, 1) * 80;
    wx += tx * sg * orb; wy += ty * sg * orb;
  } else {
    const rl = Math.max(1, Math.hypot(px, py));
    const want = cl((rl - obs.arena.radius * 0.45) / 400, 0, 1) * 140;
    wx -= px / rl * want; wy -= py / rl * want;
  }
  const ps = nA ? 3 : 4.5;
  for (const p of obs.planets) {
    const dx = px - p.pos.x, dy = py - p.pos.y;
    const dd = Math.max(1, Math.hypot(dx, dy));
    const safe = p.radius * ps + 180;
    if (dd < safe) { const w = (1 - dd / safe) * 280; wx += dx / dd * w; wy += dy / dd * w; }
  }
  const rl2 = Math.max(1, Math.hypot(px, py));
  const band = obs.arena.radius * 0.76;
  if (rl2 > band) {
    const w = cl((rl2 - band) / (obs.arena.radius - band), 0, 1) * 320;
    wx -= px / rl2 * w; wy -= py / rl2 * w;
  }

  // ---------- 6. steer / thrust ----------
  const dvx = wx - vx, dvy = wy - vy;
  const dvm = Math.hypot(dvx, dvy);
  const ang = dvm > 1 ? Math.atan2(dvy, dvx) : me.angle;
  let turn, thrust;
  if (dodge && me.fuel > 0.5 && dodge.t < 0.8) {
    const e = wrap(Math.atan2(dodge.y, dodge.x) - me.angle);
    turn = cl(e * 6 - me.angVel * 0.3, -1, 1);
    thrust = Math.abs(e) < 1.1 ? 1 : 0;
  } else if (dvm > 150 && me.fuel > 0.5 && td > 300) {
    const e = wrap(ang - me.angle);
    turn = cl(e * 4 - me.angVel * 0.3, -1, 1);
    thrust = Math.abs(e) < 0.9 ? cl(dvm / 90, 0, 1) : 0;
  } else {
    turn = cl(wrap(aimA - me.angle) * 4 - me.angVel * 0.3, -1, 1);
    thrust = (dvm > 25 && Math.abs(wrap(ang - aimA)) < 1.0 && me.fuel > 0.5) ? cl(dvm / 90, 0, 1) : 0;
  }
  if (me.fuel <= 0) thrust = 0;
  return { thrust, turn, fire };
}
