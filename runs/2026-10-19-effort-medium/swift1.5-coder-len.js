export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const R = obs.rules;
  const W = R.weapon;
  const S = R.ship;
  const aR = R.arenaRadius;

  if (!mem.init) {
    mem.init = true;
    mem.fuelReserve = 12;
    mem.heatLimit = 72;
  }

  // Late-game conservatism
  if (obs.t > 90) { mem.fuelReserve = 20; mem.heatLimit = 60; }
  else { mem.fuelReserve = 12; mem.heatLimit = 72; }

  // Find nearest alive enemy
  let best = null, bestD = Infinity;
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    const d = L.len(L.sub(e.pos, me.pos));
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return { thrust: 0, turn: 0, fire: false };

  const toE = L.sub(best.pos, me.pos);
  const eDir = L.norm(toE);
  const mySpeed = L.len(me.vel);
  const myR = L.len(me.pos);

  // Adaptive ideal range based on HP differential
  const hpDiff = me.hp - best.hp;
  const idealR = hpDiff > 20 ? 700 : hpDiff < -20 ? 350 : 500;

  // === PLANET AVOIDANCE (reactive repulsion) ===
  let pVec = { x: 0, y: 0 }, pW = 0;
  for (const p of obs.planets) {
    const dp = L.sub(p.pos, me.pos);
    const dist = L.len(dp);
    const safe = p.radius + S.radius + 60;
    if (dist > safe * 5) continue;
    const repel = L.scale(dp, -1 / (dist || 1));
    const w = Math.pow(Math.max(0, 1 - dist / (safe * 5)), 2);
    pVec = L.add(pVec, L.scale(repel, w));
    pW += w;
  }

  // Predictive planet collision check
  const pred = L.predict({ pos: me.pos, vel: me.vel }, 1.5, { step: 1 / 10 });
  if (pred.hit) {
    const hp = obs.planets[pred.hit.planet];
    const away = L.norm(L.sub(me.pos, hp.pos));
    pVec = L.add(pVec, L.scale(away, 3));
    pW = Math.max(pW, 1.5);
  }

  // === ARENA BOUNDARY ===
  let aVec = { x: 0, y: 0 };
  if (myR > aR - 300) {
    const inward = L.scale(me.pos, -1 / (myR || 1));
    const w = (myR - (aR - 300)) / 300;
    aVec = L.scale(inward, w * w * 4);
  }
  if (pred.leavesArena) {
    const inward = L.norm(L.scale(me.pos, -1));
    aVec = L.add(aVec, L.scale(inward, 2));
  }

  // === BULLET EVASION ===
  let bVec = { x: 0, y: 0 }, bW = 0;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const tb = L.sub(b.pos, me.pos);
    const dist = L.len(tb);
    if (dist > 600) continue;
    const bSpd = L.len(b.vel);
    if (bSpd < 1) continue;
    const bDir = L.scale(b.vel, 1 / bSpd);
    const toMe = L.scale(tb, -1 / dist);
    const heading = L.dot(bDir, toMe);
    if (heading < 0.4) continue;
    const tti = dist / bSpd;
    if (tti > 2.5) continue;
    let perp = { x: -bDir.y, y: bDir.x };
    if (L.dot(perp, toMe) < 0) perp = L.scale(perp, -1);
    const w = (1 - tti / 2.5) * (1 - dist / 600) * heading;
    bVec = L.add(bVec, L.scale(perp, w));
    bW += w;
  }

  // === APPROACH / STRAFE ===
  let mVec = { x: 0, y: 0 };
  if (bestD > idealR + 200) {
    mVec = eDir;
  } else if (bestD < idealR - 200) {
    mVec = L.scale(eDir, -1);
  } else {
    const perp = { x: -eDir.y, y: eDir.x };
    const cr = L.cross(eDir, me.vel);
    const s = cr >= 0 ? 1 : -1;
    mVec = L.scale(perp, s);
  }

  // === COMBINE FORCES ===
  let des = L.scale(mVec, 1.0);
  if (bW > 0) des = L.add(des, L.scale(bVec, 3.0));
  if (pW > 0) des = L.add(des, L.scale(pVec, 5.0));
  des = L.add(des, aVec);

  const dLen = L.len(des);
  if (dLen < 0.01) return { thrust: 0, turn: 0, fire: false };
  des = L.scale(des, 1 / dLen);

  // === TURNING (PD controller) ===
  const dAng = Math.atan2(des.y, des.x);
  const aErr = L.wrapAngle(dAng - me.angle);
  let turn = aErr * 3 - me.angVel * 0.5;
  turn = Math.max(-1, Math.min(1, turn));

  // === THRUST ===
  let thrust = 0;
  const aligned = Math.cos(aErr);
  if (me.fuel > mem.fuelReserve && aligned > 0.2) {
    thrust = 0.4;
    if (mySpeed > 250) thrust *= 0.4;
    if (mySpeed > 450) thrust *= 0.15;
    if (bW > 0.3) thrust = Math.max(thrust, 0.6);
    if (pW > 0.3) thrust = Math.max(thrust, 0.7);
    if (L.len(aVec) > 0.3) thrust = Math.max(thrust, 0.8);
  }

  // === FIRING ===
  let fire = false;
  if (!me.overheated && me.ammo > 3 && me.cooldown <= 0 &&
      bestD < 1500 && bestD > 80 && me.heat < mem.heatLimit) {

    // Line-of-sight check
    let losOk = true;
    for (const p of obs.planets) {
      const toP = L.sub(p.pos, me.pos);
      const proj = L.dot(toP, eDir);
      if (proj < 0 || proj > bestD) continue;
      const perpDist = L.len(L.sub(toP, L.scale(eDir, proj)));
      if (perpDist < p.radius + S.radius) { losOk = false; break; }
    }

    if (losOk) {
      const lead = L.leadTarget(me, best, W.bulletSpeed);
      if (lead) {
        let aim = lead.angle;
        // Gravity correction: compensate for bullet curvature
        const mid = L.scale(L.add(me.pos, best.pos), 0.5);
        const grav = L.gravityAt(mid);
        const tF = bestD / W.bulletSpeed;
        const gDisp = L.scale(grav, 0.5 * tF * tF);
        const aimD = L.norm(L.sub(best.pos, me.pos));
        const perpG = L.sub(gDisp, L.scale(aimD, L.dot(gDisp, aimD)));
        const pMag = L.len(perpG);
        if (pMag > 0.5) {
          const cr = L.cross(aimD, perpG);
          aim += (cr < 0 ? 1 : -1) * pMag / bestD;
        }
        const aE = L.wrapAngle(aim - me.angle);
        if (Math.abs(aE) < 0.08) fire = true;
      }
    }
  }

  return { thrust: Math.max(0, Math.min(1, thrust)), turn, fire };
}
