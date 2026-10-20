export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const rules = obs.rules;
  const W = rules.weapon;
  const S = rules.ship;

  if (!mem.init) {
    mem.init = true;
    mem.strafeDir = obs.rng() > 0.5 ? 1 : -1;
    mem.strafeTimer = 0;
  }

  // Find nearest alive enemy
  let target = null;
  let targetDist = Infinity;
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    const d = L.len(L.sub(e.pos, me.pos));
    if (d < targetDist) { targetDist = d; target = e; }
  }
  if (!target) return { thrust: 0, turn: 0, fire: false };

  const toTarget = L.sub(target.pos, me.pos);
  const dist = targetDist;

  // === SURVIVAL: immediate danger checks ===
  let emergencyAngle = null;

  // Planet proximity
  for (const p of obs.planets) {
    const d = L.len(L.sub(p.pos, me.pos));
    if (d < p.radius + S.radius + 50) {
      emergencyAngle = L.angleTo(p.pos, me.pos);
      break;
    }
  }

  // Arena boundary
  const myDist = L.len(me.pos);
  if (myDist > rules.arenaRadius - 100) {
    emergencyAngle = L.angleTo(me.pos, { x: 0, y: 0 });
  }

  // Trajectory prediction (if no immediate danger)
  if (emergencyAngle === null) {
    const myPred = L.predict({ pos: me.pos, vel: me.vel }, 2.5, { step: 1 / 20, radius: S.radius });
    if (myPred.hit) {
      const p = obs.planets[myPred.hit.planet];
      if (p) emergencyAngle = L.angleTo(p.pos, me.pos);
    } else if (myPred.leavesArena) {
      emergencyAngle = L.angleTo(me.pos, { x: 0, y: 0 });
    }
  }

  // === AIMING with gravity correction ===
  const lead = L.leadTarget(me, target, W.bulletSpeed);
  let aimAngle = lead ? lead.angle : L.angleTo(me.pos, target.pos);
  let bulletBlocked = false;

  const simTime = Math.min(3, Math.max(0.5, dist / W.bulletSpeed + 0.2));
  for (let i = 0; i < 3; i++) {
    const nx = me.pos.x + Math.cos(aimAngle) * S.radius;
    const ny = me.pos.y + Math.sin(aimAngle) * S.radius;
    const bvx = me.vel.x + Math.cos(aimAngle) * W.bulletSpeed;
    const bvy = me.vel.y + Math.sin(aimAngle) * W.bulletSpeed;
    const pred = L.predict({ pos: { x: nx, y: ny }, vel: { x: bvx, y: bvy } }, simTime, { step: 1 / 25 });
    if (pred.hit) { bulletBlocked = true; break; }
    const last = pred.points[pred.points.length - 1];
    const errDist = L.len(L.sub(target.pos, last.pos));
    if (errDist < 15) break;
    const angleToTarget = L.angleTo(last.pos, target.pos);
    const angleErr = L.wrapAngle(angleToTarget - aimAngle);
    aimAngle += angleErr * 0.5;
  }

  const aimErr = L.wrapAngle(aimAngle - me.angle);

  // === BULLET DODGE ===
  let dodgeAngle = null;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const bSpeed = L.len(b.vel);
    if (bSpeed < 1) continue;
    const toB = L.sub(me.pos, b.pos);
    const tToMe = L.len(toB) / bSpeed;
    if (tToMe < 0.7) {
      const bPred = L.predict({ pos: b.pos, vel: b.vel }, tToMe, { step: 1 / 12 });
      const bEnd = bPred.points[bPred.points.length - 1].pos;
      const dToMe = L.len(L.sub(bEnd, me.pos));
      if (dToMe < 35) {
        const bDir = L.norm(b.vel);
        const perp = { x: -bDir.y, y: bDir.x };
        const dot = L.dot(perp, L.sub(me.pos, bEnd));
        const away = dot > 0 ? perp : { x: -perp.x, y: -perp.y };
        dodgeAngle = Math.atan2(away.y, away.x);
        break;
      }
    }
  }

  // === DECIDE ACTION ===
  let thrust = 0;
  let turn = 0;
  let fire = false;

  const canFire = me.ammo > 0 && !me.overheated && me.cooldown <= 0 && me.fuel > 0;

  if (emergencyAngle !== null) {
    const eErr = L.wrapAngle(emergencyAngle - me.angle);
    turn = Math.max(-1, Math.min(1, eErr * 5 - me.angVel * 0.3));
    thrust = 1.0;
  } else if (dodgeAngle !== null) {
    const dErr = L.wrapAngle(dodgeAngle - me.angle);
    turn = Math.max(-1, Math.min(1, dErr * 5 - me.angVel * 0.3));
    thrust = 0.9;
  } else {
    // Normal combat movement
    let moveAngle;
    let moveThrust;

    const desiredDist = 600;
    const toTargetDir = L.norm(toTarget);

    if (dist < 100) {
      // Too close - back off hard
      moveAngle = L.angleTo(target.pos, me.pos);
      moveThrust = 0.9;
    } else if (dist > desiredDist + 200) {
      moveAngle = L.angleTo(me.pos, target.pos);
      moveThrust = 0.8;
    } else if (dist < desiredDist - 200) {
      moveAngle = L.angleTo(target.pos, me.pos);
      moveThrust = 0.5;
    } else {
      // Strafe
      mem.strafeTimer += obs.dtDecision;
      if (mem.strafeTimer > 2.0 + obs.rng() * 2.0) {
        mem.strafeTimer = 0;
        mem.strafeDir *= -1;
      }
      const perp = { x: -toTargetDir.y * mem.strafeDir, y: toTargetDir.x * mem.strafeDir };
      moveAngle = Math.atan2(perp.y, perp.x);
      moveThrust = 0.35;
    }

    // Blend aim and movement via vector averaging
    const aimW = canFire ? 0.65 : 0.35;
    const moveW = 1 - aimW;
    const cx = Math.cos(aimAngle) * aimW + Math.cos(moveAngle) * moveW;
    const cy = Math.sin(aimAngle) * aimW + Math.sin(moveAngle) * moveW;
    const desiredAngle = Math.atan2(cy, cx);

    const aErr = L.wrapAngle(desiredAngle - me.angle);
    turn = Math.max(-1, Math.min(1, aErr * 3.5 - me.angVel * 0.2));
    thrust = moveThrust;

    // Fire when aligned and safe
    if (canFire && Math.abs(aimErr) < 0.06 && dist < 1500 && me.heat < 80 && !bulletBlocked) {
      fire = true;
      thrust *= 0.4;
    }
  }

  // Fuel conservation
  if (me.fuel < 15) thrust = Math.min(thrust, 0.15);

  // Final clamp
  thrust = Math.max(0, Math.min(1, thrust));
  turn = Math.max(-1, Math.min(1, turn));

  return { thrust, turn, fire };
}
