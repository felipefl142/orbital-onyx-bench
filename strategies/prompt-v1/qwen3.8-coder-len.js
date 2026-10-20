export default function control(obs, mem) {
  try {
    const L = obs.lib;
    const me = obs.self;
    const rules = obs.rules;
    const arenaR = obs.arena.radius;
    const bulletSpeed = (rules.weapon && rules.weapon.bulletSpeed) || 600;

    if (!mem.init) {
      mem.init = true;
      mem.burstCount = 0;
      mem.burstPause = 0;
      mem.strafeDir = 1;
      mem.strafeTimer = 0;
    }

    // Find nearest alive enemy
    let best = null;
    let bestD = Infinity;
    for (const e of obs.enemies) {
      if (!e.alive) continue;
      const d = L.len(L.sub(e.pos, me.pos));
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return { thrust: 0, turn: 0, fire: false };

    // === DODGE INCOMING BULLETS ===
    let dodgeAngle = null;
    let dodgeUrgency = 0;
    for (const b of obs.bullets) {
      if (b.owner === me.id) continue;
      const toMe = L.sub(me.pos, b.pos);
      const dist = L.len(toMe);
      if (dist > 350 || dist < 1) continue;
      const bSpeed = L.len(b.vel);
      if (bSpeed < 50) continue;
      const bDir = L.norm(b.vel);
      const toMeNorm = L.norm(toMe);
      const dot = L.dot(bDir, toMeNorm);
      if (dot > 0.5) {
        const timeToHit = dist / bSpeed;
        if (timeToHit < 0.7) {
          const urgency = 1 - timeToHit / 0.7;
          if (urgency > dodgeUrgency) {
            dodgeUrgency = urgency;
            const perp = { x: -bDir.y, y: bDir.x };
            const cross = L.cross(bDir, toMeNorm);
            dodgeAngle = cross > 0
              ? Math.atan2(perp.y, perp.x)
              : Math.atan2(-perp.y, -perp.x);
          }
        }
      }
    }

    // === PLANET AVOIDANCE (proximity) ===
    let avoidAngle = null;
    let avoidUrgency = 0;
    for (const p of obs.planets) {
      const toPlanet = L.sub(p.pos, me.pos);
      const dist = L.len(toPlanet);
      if (dist < 1) continue;
      const dangerR = p.radius + 30;
      if (dist < dangerR * 5) {
        const urgency = Math.max(0, 1 - dist / (dangerR * 5));
        if (urgency > avoidUrgency) {
          avoidUrgency = urgency;
          avoidAngle = Math.atan2(-toPlanet.y, -toPlanet.x);
        }
      }
    }

    // === PLANET AVOIDANCE (velocity heading) ===
    const mySpeed = L.len(me.vel);
    if (mySpeed > 30) {
      const velDir = L.norm(me.vel);
      for (const p of obs.planets) {
        const toPlanet = L.sub(p.pos, me.pos);
        const dist = L.len(toPlanet);
        if (dist < 1) continue;
        const dangerR = p.radius + 20;
        if (dist < dangerR * 6) {
          const toPlanetNorm = L.norm(toPlanet);
          const dot = L.dot(velDir, toPlanetNorm);
          if (dot > 0.6) {
            const timeToHit = dist / (mySpeed * dot);
            if (timeToHit < 2.0) {
              const urgency = Math.max(0, 1 - timeToHit / 2.0);
              if (urgency > avoidUrgency) {
                avoidUrgency = urgency;
                avoidAngle = Math.atan2(-toPlanet.y, -toPlanet.x);
              }
            }
          }
        }
      }
    }

    // === ARENA BOUNDARY ===
    const myDist = L.len(me.pos);
    let arenaAngle = null;
    let arenaUrgency = 0;
    if (myDist > arenaR - 120) {
      arenaUrgency = Math.min(1, (myDist - (arenaR - 120)) / 120);
      arenaAngle = Math.atan2(-me.pos.y, -me.pos.x);
    }

    // === AIM WITH GRAVITY CORRECTION ===
    const effBulletSpeed = bulletSpeed + L.len(me.vel);
    const lead = L.leadTarget(me, best, effBulletSpeed);
    let aimAngle = lead ? lead.angle : L.angleTo(me.pos, best.pos);

    if (lead && lead.time > 0.3 && bestD > 200) {
      const midX = me.pos.x + (lead.point.x - me.pos.x) * 0.5;
      const midY = me.pos.y + (lead.point.y - me.pos.y) * 0.5;
      const grav = L.gravityAt({ x: midX, y: midY });
      const t = lead.time;
      const corrX = (lead.point.x - 0.5 * grav.x * t * t) - me.pos.x;
      const corrY = (lead.point.y - 0.5 * grav.y * t * t) - me.pos.y;
      aimAngle = Math.atan2(corrY, corrX);
    }

    const aimErr = L.wrapAngle(aimAngle - me.angle);

    // === MOVEMENT DECISION (priority cascade) ===
    let moveAngle = aimAngle;
    let moveThrust = 0;
    let isEmergency = false;

    if (dodgeUrgency > 0.3) {
      moveAngle = dodgeAngle;
      moveThrust = Math.min(1, 0.5 + dodgeUrgency * 0.5);
      isEmergency = true;
    } else if (avoidUrgency > 0.2) {
      moveAngle = avoidAngle;
      moveThrust = Math.min(1, 0.3 + avoidUrgency * 0.7);
      isEmergency = true;
    } else if (arenaUrgency > 0.2) {
      moveAngle = arenaAngle;
      moveThrust = Math.min(1, 0.3 + arenaUrgency * 0.7);
      isEmergency = true;
    } else if (bestD > 800) {
      moveAngle = L.angleTo(me.pos, best.pos);
      moveThrust = 0.5;
    } else if (bestD < 180) {
      moveAngle = L.angleTo(best.pos, me.pos);
      moveThrust = 0.5;
    } else {
      // Combat: strafe with compromise angle
      mem.strafeTimer++;
      if (mem.strafeTimer > 60) {
        mem.strafeTimer = 0;
        mem.strafeDir *= -1;
      }
      const toEnemy = L.sub(best.pos, me.pos);
      const toEnemyNorm = L.norm(toEnemy);
      const perp = { x: -toEnemyNorm.y * mem.strafeDir, y: toEnemyNorm.x * mem.strafeDir };
      const blendX = toEnemyNorm.x * 0.7 + perp.x * 0.3;
      const blendY = toEnemyNorm.y * 0.7 + perp.y * 0.3;
      moveAngle = Math.atan2(blendY, blendX);
      moveThrust = 0.12;
    }

    // === TURN ===
    const turnErr = L.wrapAngle(moveAngle - me.angle);
    let turn;
    if (Math.abs(turnErr) > 0.02) {
      turn = Math.max(-1, Math.min(1, turnErr * 3 - me.angVel * 0.2));
    } else {
      turn = 0;
    }

    // === THRUST ===
    let thrust = 0;
    if (me.fuel > 2) {
      const alignFactor = Math.max(0, 1 - Math.abs(turnErr) / 0.5);
      thrust = moveThrust * alignFactor;
      if (me.fuel < 10) thrust *= 0.4;
      if (me.fuel < 3) thrust = 0;
    }

    // === FIRE (burst with heat management) ===
    let fire = false;
    if (!isEmergency && bestD < 1500 && !me.overheated && me.ammo > 0 && me.cooldown <= 0) {
      if (Math.abs(aimErr) < 0.03) {
        if (mem.burstPause <= 0) {
          if (me.heat < 50) {
            fire = true;
            mem.burstCount++;
            if (mem.burstCount >= 3) {
              mem.burstPause = 6;
              mem.burstCount = 0;
            }
          } else if (me.heat < 70) {
            fire = true;
            mem.burstCount++;
            if (mem.burstCount >= 2) {
              mem.burstPause = 10;
              mem.burstCount = 0;
            }
          }
        }
      }
    }
    if (mem.burstPause > 0) {
      mem.burstPause--;
      fire = false;
    }

    return {
      thrust: Math.max(0, Math.min(1, thrust)),
      turn: Math.max(-1, Math.min(1, turn)),
      fire
    };
  } catch (e) {
    return { thrust: 0, turn: 0, fire: false };
  }
}
