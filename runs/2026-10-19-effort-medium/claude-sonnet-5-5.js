export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const W = obs.rules.weapon;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- target selection ----------
  let tgt = null, td = Infinity;
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    const d = Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y);
    if (d < td) { td = d; tgt = e; }
  }

  // ---------- safety evaluation ----------
  const planets = obs.planets;
  function evalTraj(vel) {
    const r = L.predict({ pos: me.pos, vel }, 3, { step: 0.1, radius: 35 });
    let clear = 1e9;
    for (const p of r.points) {
      for (const pl of planets) {
        const d = Math.hypot(p.pos.x - pl.pos.x, p.pos.y - pl.pos.y) - pl.radius;
        if (d < clear) clear = d;
      }
    }
    let score = clear;
    if (r.hit) score = -1000 + r.hit.t;
    if (r.leavesArena) score -= 500;
    const r0 = Math.hypot(me.pos.x, me.pos.y);
    return { score, bad: !!r.hit || r.leavesArena || clear < 50, clear };
  }

  let danger = false;
  let escAngle = 0;
  const cur = evalTraj(me.vel);
  const rr = Math.hypot(me.pos.x, me.pos.y);
  if (cur.bad || (rr > 1750 && (me.pos.x * me.vel.x + me.pos.y * me.vel.y) > 0)) {
    danger = true;
    let best = -Infinity;
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const v = { x: me.vel.x + Math.cos(a) * 25, y: me.vel.y + Math.sin(a) * 25 };
      const ev = evalTraj(v);
      let s = ev.score;
      // mild preference for pointing toward the arena centre when far out
      if (rr > 1500) s += 0.1 * (-(Math.cos(a) * me.pos.x + Math.sin(a) * me.pos.y) / rr) * 100;
      if (s > best) { best = s; escAngle = a; }
    }
  }

  // ---------- aiming ----------
  let aim = me.angle, aimErr = 0, tHit = 99, haveAim = false;
  if (tgt) {
    const px = tgt.pos.x - me.pos.x, py = tgt.pos.y - me.pos.y;
    const vx = tgt.vel.x - me.vel.x, vy = tgt.vel.y - me.vel.y;
    const s = W.bulletSpeed;
    const a = vx * vx + vy * vy - s * s;
    const b = 2 * (px * vx + py * vy);
    const c = px * px + py * py;
    let t = -1;
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) > 1e-9) t = -c / b;
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
        const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
        t = lo > 0 ? lo : hi;
      }
    }
    if (!(t > 0) || t > 3) t = Math.sqrt(c) / s;
    tHit = t;
    aim = Math.atan2(py + vy * t, px + vx * t);
    haveAim = true;
  }

  // ---------- turn control ----------
  const desired = danger ? escAngle : (haveAim ? aim : me.angle);
  const err = L.wrapAngle(desired - me.angle);
  function turnFor(e) {
    const sgn = e >= 0 ? 1 : -1;
    let w = Math.min(3, 0.8 * Math.sqrt(24 * Math.abs(e)));
    if (Math.abs(e) < 0.08) w = Math.min(w, Math.abs(e) * 12);
    return clamp(sgn * w / 3 - 0 * me.angVel, -1, 1);
  }
  let turn = turnFor(err);
  // damp using current angular velocity when near target
  if (Math.abs(err) < 0.15) turn = clamp((err * 10 - me.angVel) / 3, -1, 1);

  // ---------- thrust ----------
  let thrust = 0;
  if (danger) {
    if (Math.abs(err) < 0.6 && me.fuel > 0) thrust = 1;
  } else if (tgt && me.fuel > 25 && td > 1000 && Math.abs(err) < 0.2) {
    const rel = Math.hypot(tgt.vel.x - me.vel.x, tgt.vel.y - me.vel.y);
    if (rel < 120) thrust = 0.5;
  }

  // ---------- fire ----------
  let fire = false;
  if (tgt && haveAim && !me.overheated && me.ammo > 0 && me.heat < 84 && me.cooldown <= 0.06) {
    const aerr = Math.abs(L.wrapAngle(aim - me.angle));
    const tol = Math.max(0.012, Math.atan(14 / Math.max(td, 1)));
    if (aerr < tol && td < 1600 && tHit < 2.8) fire = true;
  }

  return { thrust, turn, fire };
}
