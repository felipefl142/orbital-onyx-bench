import { canonicalJson, sha256 } from './hash';

/**
 * Every tunable of the simulation. A ruleset is immutable once created: editing produces a new ruleset with a new
 * hash, and results are only comparable inside one ruleset hash.
 */
export interface RuleSet {
  id: string;
  /** Physics step (s). */
  dt: number;
  /** Strategy decisions happen every `decisionEvery` physics steps (default 6 → 20 Hz at dt = 1/120). */
  decisionEvery: number;
  /** Match time limit in simulated seconds. */
  timeLimit: number;
  /**
   * Seconds the last ship standing must stay alive after the final enemy dies (onyx-v2+). Dying in that time counts
   * as dying together with the last ship it outlived (a draw between them). Absent / 0 = immediate win (onyx-v1).
   */
  victoryHold?: number;
  G: number;
  arenaRadius: number;
  /** HP lost per second while outside the arena. */
  outOfBoundsDps: number;
  /** Bodies closer than `substepRadiusFactor × planet radius` to a planet's surface region use `substeps` sub-steps. */
  substepRadiusFactor: number;
  substeps: number;
  /** Gravity softening ε = softeningFactor × planet radius. */
  softeningFactor: number;
  ship: {
    radius: number;
    hp: number;
    dryMass: number;
    /** Extra mass at full tank: m = dryMass + fuelMass × fuel / fuelMax. */
    fuelMass: number;
    fuelMax: number;
    /** Fuel per second at thrust = 1. */
    fuelBurn: number;
    /** Main engine force; acceleration = thrustForce / m. */
    thrustForce: number;
    maxAngVel: number;
    angAccel: number;
    /** Collision damage per unit of closing speed (ship × ship). */
    collisionDamage: number;
  };
  weapon: {
    bulletSpeed: number;
    cooldown: number;
    damage: number;
    bulletLife: number;
    ammo: number;
    heatPerShot: number;
    coolRate: number;
    overheatAt: number;
    overheatLock: number;
  };
  /** Time limit tie threshold in HP. */
  drawHpMargin: number;
  /** Deterministic op budget per decision (loop iterations + function calls in strategy code). */
  opBudget: number;
  /** Consecutive budget overruns before the ship is disabled for the rest of the match. */
  maxConsecutiveTimeouts: number;
  /** Max serialized size of the strategy `mem` object (bytes). */
  memLimit: number;
  /** Max bullets reported in an observation (nearest first). */
  obsBullets: number;
}

/** First ruleset (2026-10-19 runs). Kept so old results and replays stay reproducible. */
export const RULESET_V1: RuleSet = {
  id: 'onyx-v1',
  dt: 1 / 120,
  decisionEvery: 6,
  timeLimit: 120,
  G: 1000,
  arenaRadius: 2000,
  outOfBoundsDps: 10,
  substepRadiusFactor: 2,
  substeps: 4,
  softeningFactor: 0.5,
  ship: {
    radius: 12,
    hp: 100,
    dryMass: 1,
    fuelMass: 0.5,
    fuelMax: 100,
    fuelBurn: 1,
    thrustForce: 60,
    maxAngVel: 3,
    angAccel: 12,
    collisionDamage: 0.15,
  },
  weapon: {
    bulletSpeed: 600,
    cooldown: 0.25,
    damage: 10,
    bulletLife: 3,
    ammo: 60,
    heatPerShot: 8,
    coolRate: 10,
    overheatAt: 100,
    overheatLock: 2,
  },
  drawHpMargin: 1,
  opBudget: 200_000,
  maxConsecutiveTimeouts: 3,
  memLimit: 64 * 1024,
  obsBullets: 64,
};

/** onyx-v2: 5 s victory hold, 15 % less fuel, twice the ammo. */
export const RULESET_V2: RuleSet = {
  ...RULESET_V1,
  id: 'onyx-v2',
  victoryHold: 5,
  ship: { ...RULESET_V1.ship, fuelMax: 85 },
  weapon: { ...RULESET_V1.weapon, ammo: 120 },
};

export const BUILTIN_RULESETS: RuleSet[] = [RULESET_V1, RULESET_V2];

export const DEFAULT_RULESET: RuleSet = RULESET_V2;

export async function rulesetHash(r: RuleSet): Promise<string> {
  return (await sha256(canonicalJson(r))).slice(0, 16);
}
