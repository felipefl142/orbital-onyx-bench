export default function control(obs, mem) {
  try {
    const L = obs.lib;
    const me = obs.self;
    const rules = obs.rules;

    const shipR = rules.ship.radius || 12;
    const bulletR = 1;
    const hitR = shipR + 2;

    const bulletSpeed = rules.weapon.bulletSpeed || 600;
    const cooldown = rules.weapon.cooldown || 0.25;
    const heatPerShot = rules.weapon.heatPerShot || 8;
    const maxHeat = rules.weapon.maxHeat || 100;

    const engineAcc = rules.engine.acceleration || 60;
    const maxTurn = rules.turn.maxAngularVelocity || 3;
    const angAcc = rules.turn.angularAcceleration || 12;

    const arenaR = obs.arena.radius || 2000;
    const planets = obs.planets || [];
    const enemies = obs.enemies || [];
    const bullets = obs.bullets || [];

    if (!mem) mem = {};

    const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
    const wrap = (a) => {
      a = ((a + Math.PI) % (Math.PI * 2));
      if (a < 0) a += Math.PI * 2;
      return a - Math.PI;
    };
    const angleOf = (x, y) => Math.atan2(y, x);

    // ------------------------------------------------------------------
    // Target selection.
    // Prefer low HP, reasonably close, and stable targets.
    // ------------------------------------------------------------------
    let target = null;
    let targetScore = -Infinity;

    for (const e of enemies) {
      if (!e.alive) continue;

      const dx = e.pos.x - me.pos.x;
      const dy = e.pos.y - me.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);

      let s = -e.hp * 10 - d * 0.15;

      if (d < 1200) s += 40;
      if (d < 500) s += 20;
      if (d < 250) s -= 30;

      if (mem.targetId === e.id) s += 50;

      if (s > targetScore) {
        targetScore = s;
        target = e;
      }
    }

    if (target) mem.targetId = target.id;

    // ------------------------------------------------------------------
    // Gravity-aware aim.
    // Sample bullet trajectories and compare them with the target's
    // predicted free-fall trajectory.
    // ------------------------------------------------------------------
    let aimAngle = me.angle;
    let aimHit = false;
    let aimHitTime = 0;
    let targetPred = null;

    if (target) {
      const targetDist = Math.sqrt(
        (target.pos.x - me.pos.x) ** 2 +
        (target.pos.y - me.pos.y) ** 2
      );

      const aimHorizon = Math.min(3, Math.max(0.5, targetDist / bulletSpeed + 0.3));
      const aimStep = 0.05;

      targetPred = L.predict(target, aimHorizon, { step: aimStep, radius: shipR });

      const base = L.leadTarget(me, target, bulletSpeed);
      const center = base
        ? base.angle
        : angleOf(target.pos.x - me.pos.x, target.pos.y - me.pos.y);

      const targetPoints = targetPred ? targetPred.points : [{ pos: target.pos, vel: target.vel }];

      let bestAimScore = -Infinity;

      for (let i = 0; i < 32; i++) {
        const a = wrap(center + i * (Math.PI * 2 / 32));
        const cx = Math.cos(a);
        const cy = Math.sin(a);

        const bulletVel = {
          x: me.vel.x + bulletSpeed * cx,
          y: me.vel.y + bulletSpeed * cy
        };

        const bp = L.predict(
          { pos: me.pos, vel: bulletVel },
          aimHorizon,
          { step: aimStep, radius: bulletR }
        );

        if (!bp) continue;

        let score = 0;
        let minD2 = Infinity;
        let hitTime = aimHorizon;

        for (let j = 0; j < bp.points.length && j < targetPoints.length; j++) {
          const bpj = bp.points[j];
          const tpj = targetPoints[j];

          const dx = bpj.pos.x - tpj.pos.x;
          const dy = bpj.pos.y - tpj.pos.y;
          const d2 = dx * dx + dy * dy;

          if (d2 < minD2) minD2 = d2;

          if (d2 <= hitR * hitR) {
            hitTime = j * aimStep;

            if (!bp.hit || bp.hit.t >= hitTime) {
              score += 1000 - hitTime * 100;
              break;
            }
          }
        }

        if (bp.hit && bp.hit.t < hitTime) score -= 500;

        if (score <= 0) score = -Math.sqrt(minD2) * 2;

        score -= Math.abs(wrap(a - me.angle)) * 20;

        if (score > bestAimScore) {
          bestAimScore = score;
          aimAngle = a;
          aimHit = score > 0;
          aimHitTime = hitTime;
        }
      }
    }

    // ------------------------------------------------------------------
    // Predict nearby threats for safety scoring.
    // ------------------------------------------------------------------
    const safetyHorizon = 1.0;
    const safetyStep = 0.05;
    const safetySteps = Math.round(safetyHorizon / safetyStep);

    const enemyPreds = [];
    for (const e of enemies) {
      if (!e.alive) continue;

      const p = L.predict(e, safetyHorizon, { step: safetyStep, radius: shipR });
      if (p) enemyPreds.push({ points: p.points, hit: p.hit });
    }

    const bulletPreds = [];
    const maxBulletPreds = 32;

    for (let i = 0; i < bullets.length && bulletPreds.length < maxBulletPreds; i++) {
      const b = bullets[i];
      if (b.owner === me.id) continue;

      const h = Math.min(safetyHorizon, b.ttl || safetyHorizon);
      const p = L.predict(b, h, { step: safetyStep, radius: bulletR });

      if (p) bulletPreds.push({ points: p.points, hit: p.hit });
    }

    // ------------------------------------------------------------------
    // Choose a safe, tactical thrust/turn action by scoring candidates.
    // Fire is decided separately below.
    // ------------------------------------------------------------------
    const turnCandidates = [-1, -0.7, -0.4, -0.15, 0, 0.15, 0.4, 0.7, 1];
    const thrustCandidates = [0, 0.25, 0.5, 0.75, 1];

    let bestAction = { thrust: 0, turn: 0, fire: false };
    let bestScore = -Infinity;

    const desiredDist = 900;

    for (const turn of turnCandidates) {
      for (const thrust of thrustCandidates) {
        let score = 0;

        let px = me.pos.x;
        let py = me.pos.y;
        let vx = me.vel.x;
        let vy = me.vel.y;
        let ang = me.angle;
        let av = me.angVel;
        let fuel = me.fuel;

        for (let s = 0; s <= safetySteps; s++) {
          const time = obs.t + s * safetyStep;

          // Planet safety.
          for (const pl of planets) {
            const dx = px - pl.pos.x;
            const dy = py - pl.pos.y;
            const d2 = dx * dx + dy * dy;

            const minSafe = pl.radius + shipR;

            if (d2 <= minSafe * minSafe) {
              score -= 10000;
            } else if (d2 < (minSafe + 150) * (minSafe + 150)) {
              score -= (minSafe + 150 - Math.sqrt(d2)) * 50;
            }
          }

          // Arena safety.
          const r2 = px * px + py * py;
          const edgeLimit = arenaR - shipR;

          if (r2 > edgeLimit * edgeLimit) {
            score -= 5000;
          } else if (r2 > (arenaR - 150) * (arenaR - 150)) {
            score -= (Math.sqrt(r2) - (arenaR - 150)) * 30;
          }

          // Enemy collision safety.
          for (const ep of enemyPreds) {
            if (s >= ep.points.length) continue;
            if (ep.hit && time > ep.hit.t) continue;

            const epj = ep.points[s];
            const dx = px - epj.pos.x;
            const dy = py - epj.pos.y;
            const d2 = dx * dx + dy * dy;

            const collide = shipR * 2;

            if (d2 <= collide * collide) {
              score -= 5000;
            } else if (d2 < 250 * 250) {
              score -= (250 - Math.sqrt(d2)) * 20;
            }
          }

          // Incoming bullet safety.
          for (const bp of bulletPreds) {
            if (s >= bp.points.length) continue;
            if (bp.hit && time > bp.hit.t) continue;

            const bpj = bp.points[s];
            const dx = px - bpj.pos.x;
            const dy = py - bpj.pos.y;
            const d2 = dx * dx + dy * dy;

            if (d2 <= hitR * hitR) {
              score -= 5000;
            } else if (d2 < 150 * 150) {
              score -= (150 - Math.sqrt(d2)) * 30;
            }
          }

          // Aim alignment.
          const aimErr = Math.abs(wrap(ang - aimAngle));
          score -= aimErr * 80;
          if (aimErr < 0.05) score += 20;

          // Positioning relative to target.
          if (target) {
            let tp = target.pos;

            if (targetPred && s < targetPred.points.length) {
              tp = targetPred.points[s].pos;
            }

            const dx = tp.x - px;
            const dy = tp.y - py;
            const d = Math.sqrt(dx * dx + dy * dy);

            score -= Math.abs(d - desiredDist) * 8;

            let desiredMoveAngle = aimAngle;

            if (d > 1200) {
              desiredMoveAngle = angleOf(dx, dy);
            } else if (d < 350) {
              desiredMoveAngle = angleOf(-dx, -dy);
            }

            const moveErr = Math.abs(wrap(ang - desiredMoveAngle));
            score -= moveErr * 40;
          }

          // Fuel management.
          if (fuel > 50) {
            score -= thrust * 5;
          } else if (fuel > 30) {
            score -= thrust * 20;
          } else if (fuel > 10) {
            score -= thrust * 100;
          } else {
            score -= thrust * 300;
          }

          // Simulate one decision step.
          const targetAv = turn * maxTurn;
          const maxDelta = angAcc * safetyStep;
          const dAv = clamp(targetAv - av, -maxDelta, maxDelta);
          av += dAv;
          ang = wrap(ang + av * safetyStep);

          const effectiveThrust = fuel > 0 ? thrust : 0;
          const mass = 1 + 0.5 * fuel / 100;
          const acc = engineAcc * effectiveThrust / mass;

          const grav = L.gravityAt({ x: px, y: py }, time);

          vx += grav.x * safetyStep + acc * Math.cos(ang) * safetyStep;
          vy += grav.y * safetyStep + acc * Math.sin(ang) * safetyStep;

          px += vx * safetyStep;
          py += vy * safetyStep;

          fuel -= effectiveThrust * safetyStep;
          if (fuel < 0) fuel = 0;
        }

        if (score > bestScore) {
          bestScore = score;
          bestAction = { thrust, turn, fire: false };
        }
      }
    }

    // ------------------------------------------------------------------
    // Fire decision.
    // Only fire when aligned, able to fire, and likely to hit.
    // ------------------------------------------------------------------
    let fire = false;

    if (target && !me.overheated && me.ammo > 0 && me.cooldown <= 0.001) {
      const dx = target.pos.x - me.pos.x;
      const dy = target.pos.y - me.pos.y;
      const targetDist = Math.sqrt(dx * dx + dy * dy);

      const aimErr = Math.abs(wrap(me.angle - aimAngle));

      let heatLimit = 85;
      if (aimHit && targetDist < 800) heatLimit = 91;
      if (target.hp <= 10) heatLimit = 95;

      if (me.heat < heatLimit && aimErr < 0.06) {
        if (aimHit || targetDist < 1000) {
          fire = true;
        }
      }
    }

    let thrust = bestAction.thrust;
    if (me.fuel <= 0) thrust = 0;

    return {
      thrust,
      turn: bestAction.turn,
      fire
    };
  } catch {
    return { thrust: 0, turn: 0, fire: false };
  }
}
