import { sha256 } from '../sim/hash';
import type { RuleSet } from '../sim/ruleset';
import { TURRET } from '../strategies/refs';

/** Bump when the wording changes; results record `PROMPT_ID` + hash so runs with different prompts never mix. */
export const PROMPT_ID = 'onyx-prompt-v3';

export function systemPrompt(rules: RuleSet): string {
  return `You are competing in ORBITAL ONYX, a benchmark where language models write the control program for a
spaceship. Ships duel inside a 2D arena with N planets whose gravity bends every trajectory, including bullets.
Your program is run by a deterministic simulator against programs written by other models.

# Physics
- Fixed physics step dt = ${rules.dt.toFixed(6)} s. Your function is called every ${rules.decisionEvery} steps
  (every ${(rules.dt * rules.decisionEvery).toFixed(3)} s); the last action is held in between.
- Gravity from each planet: a = G·M·d / (|d|² + ε²)^(3/2), ε = ${rules.softeningFactor} × planet radius, G = ${rules.G}.
  Gravity acts on ships and bullets. Planets may move on circular tracks around the arena centre (planet.vel is given).
- Touching a planet destroys the ship. Bullets that touch a planet disappear.
- Circular arena of radius ${rules.arenaRadius} centred at (0, 0). Outside it the ship loses ${rules.outOfBoundsDps} HP/s.
- Ship: radius ${rules.ship.radius}, ${rules.ship.hp} HP, ${rules.ship.fuelMax} fuel. The main engine pushes along the nose
  (direction = angle, radians, 0 = +x, counter-clockwise positive). Acceleration = ${rules.ship.thrustForce} × thrust / mass, with
  mass = ${rules.ship.dryMass} + ${rules.ship.fuelMass} × fuel / ${rules.ship.fuelMax}. Thrust 1 burns ${rules.ship.fuelBurn} fuel per second; no fuel = no thrust.
- Turning: turn ∈ [-1, 1] sets the target angular velocity (turn × ${rules.ship.maxAngVel} rad/s), reached with angular
  acceleration ≤ ${rules.ship.angAccel} rad/s². Turning is free.
- Weapon: a bullet leaves the nose at ${rules.weapon.bulletSpeed} u/s PLUS the ship's velocity, lives ${rules.weapon.bulletLife} s,
  does ${rules.weapon.damage} damage. Cooldown ${rules.weapon.cooldown} s, ${rules.weapon.ammo} rounds. Each shot adds ${rules.weapon.heatPerShot} heat; heat cools
  ${rules.weapon.coolRate}/s; at ${rules.weapon.overheatAt} the gun locks for ${rules.weapon.overheatLock} s. Bullets never hit their owner.
- Ships that collide bounce and both take ${rules.ship.collisionDamage} × closing speed damage.
- The last ship alive wins${rules.victoryHold ? `, but only if it then stays alive ${rules.victoryHold} s more (rules.victoryHold): dying
  in that time (planet, arena edge) counts as dying together with the last enemy, a draw` : ''}. At ${rules.timeLimit} s the ship with more HP wins
  (a difference under ${rules.drawHpMargin} HP is a draw).
- Matches are 1v1 or free-for-all, on maps with 1 to 12 planets. Spawns are symmetric.

# Program contract
Write ONE JavaScript (ES2022) module with a default export:

\`\`\`js
export default function control(obs, mem) {
  return { thrust: 0, turn: 0, fire: false };   // thrust ∈ [0,1], turn ∈ [-1,1], fire: boolean
}
\`\`\`

- \`mem\` is a plain object you own for the whole match (keep it JSON-serializable, ≤ ${rules.memLimit} bytes).
  Module-level variables also persist for one match.
- Out-of-range numbers are clamped. NaN, a missing object or an exception = no action for that tick.
- Budget: ${rules.opBudget} ops per call, where one op = one loop iteration or one function call in your code
  (helper calls below are charged too). Over budget = no action; ${rules.maxConsecutiveTimeouts} overruns in a row disable the ship
  for the rest of the match.
- Not available: imports, network, timers, Date, performance, globalThis, eval, Function, Math.random
  (use obs.rng() instead; it is seeded and deterministic).

# obs (fresh copy every call)
\`\`\`ts
type Vec = { x: number; y: number };
obs = {
  tick: number; t: number; dtDecision: number;
  rules: RuleSet;                          // exactly the JSON shown below (same field names)
  arena: { radius: number };
  self: { id: string; pos: Vec; vel: Vec; angle: number; angVel: number; hp: number; fuel: number;
          ammo: number; heat: number; cooldown: number; overheated: boolean };
  enemies: { id: string; pos: Vec; vel: Vec; angle: number; hp: number; alive: boolean }[];
  bullets: { pos: Vec; vel: Vec; owner: string; ttl: number }[];   // up to ${rules.obsBullets}, nearest first, incl. yours
  planets: { pos: Vec; vel: Vec; radius: number; mass: number }[];
  G: number;
  rng: () => number;                       // seeded uniform [0, 1)
  lib: {
    gravityAt(pos: Vec, t?: number): Vec;  // acceleration from all planets
    predict(body: {pos, vel}, seconds: number, opts?: { step?: number; radius?: number }):
      { points: { t, pos, vel }[]; hit: { planet: number; t: number } | null; leavesArena: boolean };
      // free fall under gravity (no thrust), horizon ≤ 10 s, default step 1/30 s; cost ≈ steps × (planets + 2) ops
    leadTarget(shooter: {pos, vel}, target: {pos, vel}, bulletSpeed: number):
      { angle: number; time: number; point: Vec } | null;    // straight-line intercept, ignores gravity
    angleTo(from: Vec, to: Vec): number; wrapAngle(a: number): number;
    add, sub, scale, len, norm, dot, cross;  // 2D vector helpers
  };
}
\`\`\`

# obs.rules (the RuleSet for this match, exact field names)
\`\`\`json
${JSON.stringify(rules, null, 2)}
\`\`\`

# Example (a weak baseline: it never moves)
\`\`\`js
${TURRET.trim()}
\`\`\`

# What to return
Return the complete module in a single \`\`\`js code block. You may add a short explanation before the block.
Do not leave placeholders: the code is run as-is.`;
}

export const USER_PROMPT =
  'Write the strongest control program you can. It must survive the gravity field (do not crash into planets or leave the arena) and destroy the enemy ships.';

export function repairPrompt(report: string): string {
  return `Your program failed validation. Fix it and return the complete corrected module in one \`\`\`js block.

Validation report:
${report}`;
}

export function improvePrompt(previousCode: string, summary: string): string {
  return `Here is your previous program and how it did in the tournament. Write an improved version.
Return the complete module in one \`\`\`js block.

## Previous program
\`\`\`js
${previousCode}
\`\`\`

## Results
${summary}`;
}

export async function promptHash(rules: RuleSet): Promise<string> {
  return (await sha256(`${PROMPT_ID}\n${systemPrompt(rules)}\n${USER_PROMPT}`)).slice(0, 16);
}
