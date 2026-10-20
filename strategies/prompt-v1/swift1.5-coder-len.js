export default function control(obs, mem) {
  const L = obs.lib;
  const me = obs.self;
  const rules = obs.rules;
  const arenaR = obs.arena.radius;
  const bulletSpeed = rules.weapon.bulletSpeed;

  if (!mem.init) {
    mem.init = true;
    mem.strafeDir = 1;
    mem.strafeTimer = 0;
    mem.lastFire = 0;
    mem.dodgeAngle = null;
  }

  // --- Find nearest alive enemy ---
  let best = null, bestD = Infinity;
  for (const e of obs.enemies) {
    if (!e.alive) continue;
    const d = L.len(L.sub(e.pos, me.pos));
    if (d < bestD) { bestD = d; best = e; }
  }

  // --- DODGE INCOMING BULLETS ---
  let dodgeAngle = null;
  let dodgePriority = 0;
  for (const b of obs.bullets) {
    if (b.owner === me.id) continue;
    const dToMe = L.len(L.sub(me.pos, b.pos));
    if (dToMe > 400) continue;
    // Check if bullet is heading toward me
    const bDir = L.norm(b.vel);
    const toMe = L.norm(L.sub(me.pos, b.pos));
    const dot = L.dot(bDir, toMe);
    if (dot > 0.7) {
      // Bullet is coming at us - dodge perpendicular
      const perp = { x: -bDir.y, y: bDir.x };
      const dPerp = L.dot(perp, L.norm(L.sub(me.pos, { x: 0, y: 0 })));
      const dodgeA = dPerp > 0 ? Math.atan2(perp.y, perp.x) : Math.atan2(-perp.y, -perp.x);
      const urgency = dot * (1 - dToMe / 400);
      if (urgency > dodgePriority) {
        dodgePriority = urgency;
        dodgeAngle = dodgeA;
      }
    }
  }

  // --- PLANET AVOIDANCE ---
  let avoidAngle = null;
  let avoidPriority = 0;

  for (const p of obs.planets) {
    const d = L.len(L.sub(p.pos, me.pos));
    const safeDist = p.radius + 25;
    if (d < safeDist * 3) {
      const away = L.angleTo(p.pos, me.pos);
      const urgency = 1 - d / (safeDist * 3);
      if (urgency > avoidPriority) {
        avoidPriority = urgency;
        avoidAngle = away;
      }
    }
  }

  // Arena boundary
  const distC = L.len(me.pos);
  if (distC > arenaR - 150) {
    const toC = L.angleTo(me.pos, { x: 0, y: 0 });
    const urg = (distC - (arenaR - 150)) / 150;
    if (urg > avoidPriority) { avoidPriority = urg; avoidAngle = toC; }
  }

  // Predict trajectory hit (only if not already in danger)
  if (avoidPriority < 0.4 && me.fuel > 5) {
    const pred = L.predict({ pos: me.pos, vel: me.vel }, 2.5, { step: 1/20 });
    if (pred.hit) {
      const p = obs.planets[pred.hit.planet];
      avoidAngle = L.angleTo(p.pos, me.pos);
      avoidPriority = 0.85;
    }
    if (pred.leavesArena) {
      avoidAngle = L.angleTo(me.pos, { x: 0, y: 0 });
      avoidPriority = Math.max(avoidPriority, 0.75);
    }
  }

  // --- GRAVITY-CORRECTED AIMING ---
  let aimAngle = me.angle;
  let canFire = false;

  if (best && bestD < 2000) {
    // Initial lead
    const lead = L.leadTarget(me, best, bulletSpeed);
    aimAngle = lead ? lead.angle : L.angleTo(me.pos, best.pos);

    // Iterative gravity correction (3 iterations)
    for (let iter = 0; iter < 3; iter++) {
      const dir = { x: Math.cos(aimAngle), y: Math.sin(aimAngle) };
      const bVel = L.add(L.scale(dir, bulletSpeed), me.vel);
      const flightT = Math.min(bestD / bulletSpeed + 0.3, 2.5);
      const bPred = L.predict({ pos: me.pos, vel: bVel }, flightT, { step: 1/25 });

      // Find closest point to enemy
      let minD = Infinity, closestPt = null;
      for (const pt of bPred.points) {
        const dd = L.len(L.sub(pt.pos, best.pos));
        if (dd < minD) { minD = dd; closestPt = pt.pos; }
      }

      if (closestPt && minD > 15) {
        // Correct: aim at where enemy is vs where bullet goes
        const errVec = L.sub(best.pos, closestPt);
        const errAngle = Math.atan2(errVec.y, errVec.x);
        const distToErr = L.len(errVec);
        const correction = (errAngle - aimAngle) * Math.min(1, distToErr / (flightT * bulletSpeed + 1));
        aimAngle += correction * 0.8;
      }
      if (minD < 15) break; // Good enough
    }

    canFire = !me.overheated && me.ammo > 0 && me.cooldown <= 0 && me.heat < 85;
  }

  // --- DECIDE ACTIONS ---
  let thrust = 0, turn = 0, fire = false;

  // Priority 1: Critical planet avoidance
  for (const p of obs.planets) {
    const d = L.len(L.sub(p.pos, me.pos));
    if (d < p.radius + 18) {
      const away = L.angleTo(p.pos, me.pos);
      const err = L.wrapAngle(away - me.angle);
      turn = Math.max(-1, Math.min(1, err * 6));
      thrust = 1;
      fire = false;
      return { thrust, turn, fire };
    }
  }

  // Priority 2: Dodge
  if (dodgeAngle !== null && dodgePriority > 0.4) {
    const err = L.wrapAngle(dodgeAngle - me.angle);
    turn = Math.max(-1, Math.min(1, err * 5 - me.angVel * 0.3));
    thrust = Math.min(1, dodgePriority * 1.2);
    fire = false;
    return { thrust, turn, fire };
  }

  // Priority 3: General avoidance
  if (avoidAngle !== null && avoidPriority > 0.3) {
    const err = L.wrapAngle(avoidAngle - me.angle);
    turn = Math.max(-1, Math.min(1, err * 4 - me.angVel * 0.2));
    thrust = Math.min(1, avoidPriority * 1.3);
    return { thrust, turn, fire };
  }

  // Priority 4: Combat
  if (best && bestD < 2000) {
    const err = L.wrapAngle(aimAngle - me.angle);
    turn = Math.max(-1, Math.min(1, err * 3.5 - me.angVel * 0.2));

    // Fire when well-aligned
    if (Math.abs(err) < 0.04 && canFire && bestD < 1600) {
      fire = true;
      mem.lastFire = obs.t;
    }

    // Movement: maintain range + strafe
    mem.strafeTimer -= obs.dtDecision;
    if (mem.strafeTimer <= 0) {
      mem.strafeDir = -mem.strafeDir;
      mem.strafeTimer = 1.0 + obs.rng() * 1.5;
    }

    const toEnemy = L.angleTo(me.pos, best.pos);
    const strafeA = toEnemy + (Math.PI / 2) * mem.strafeDir;

    let moveAngle;
    const idealDist = 550;
    if (bestD < idealDist * 0.5) {
      moveAngle = L.angleTo(best.pos, me.pos);
    } else if (bestD > idealDist * 1.8) {
      moveAngle = toEnemy;
    } else {
      moveAngle = strafeA;
    }

    const moveErr = L.wrapAngle(moveAngle - me.angle);
    if (Math.abs(moveErr) > 0.4) {
      thrust = 0.35;
      turn = turn * 0.65 + Math.max(-1, Math.min(1, moveErr * 2.5)) * 0.35;
    } else if (bestD > idealDist * 1.3) {
      thrust = 0.2;
    }

    // Fuel management
    if (me.fuel < 15) thrust *= 0.4;
    if (me.fuel < 5) thrust = 0;
  } else {
    // No enemy in range: reposition toward center/enemy
    let target = { x: 0, y: 0 };
    if (best) target = best.pos;
    const toT = L.angleTo(me.pos, target);
    const err = L.wrapAngle(toT - me.angle);
    turn = Math.max(-1, Math.min(1, err * 2 - me.angVel * 0.1));
    thrust = me.fuel > 10 ? 0.25 : 0;
  }

  // Final clamp
  thrust = Math.max(0, Math.min(1, thrust));
  turn = Math.max(-1, Math.min(1, turn));

  return { thrust, turn, fire };
}
