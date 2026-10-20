import type { Controller } from '../sandbox/controller';
import type { MapParams } from './mapgen';
import { buildObservation, makeLib, type StrategyLib } from './observation';
import { createWorld, hashWorld, stepWorld, worldTime, type DeathCause, type ShipStats, type World } from './physics';
import { deriveSeed, mulberry32 } from './prng';
import type { RuleSet } from './ruleset';

export interface MatchConfig {
  rules: RuleSet;
  map: MapParams;
  /** Display names, one per ship (same order as controllers / spawns). */
  names: string[];
  recordActions?: boolean;
  recordEvents?: boolean;
}

export interface ShipResult {
  index: number;
  name: string;
  placement: number;
  alive: boolean;
  hp: number;
  survival: number;
  deathCause: DeathCause | null;
  killer: number | null;
  stats: ShipStats;
}

export type EndReason = 'elimination' | 'allDead' | 'timeLimit';

export interface MatchResult {
  winner: number | null;
  reason: EndReason;
  ticks: number;
  duration: number;
  finalHash: string;
  ships: ShipResult[];
}

/** Recorded decision: [thrust, turn, fire ? 1 : 0]. */
export type ActionTuple = [number, number, number];

export interface DecisionLog {
  tick: number;
  ship: number;
  status: string;
  error?: string;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export class Match {
  readonly world: World;
  readonly actions: ActionTuple[][];
  readonly log: DecisionLog[] = [];
  result: MatchResult | null = null;
  private libs: StrategyLib[];
  private rngs: Array<() => number>;
  private rulesCopy: RuleSet;
  private errorsLogged: number[];
  /** Tick at which only one ship was left (start of the victory hold), or null. */
  private holdStart: number | null = null;
  /** Death tick of the last enemy eliminated when the hold began. */
  private holdDeathTick = -1;

  constructor(
    readonly config: MatchConfig,
    readonly controllers: Controller[],
  ) {
    if (controllers.length !== config.map.ships) throw new Error('controllers.length must equal map.ships');
    this.world = createWorld(config.rules, config.map, !!config.recordEvents);
    this.actions = controllers.map(() => []);
    this.errorsLogged = controllers.map(() => 0);
    this.rulesCopy = deepFreeze(structuredClone(config.rules));
    this.rngs = controllers.map((_, i) => mulberry32(deriveSeed(config.map.seed, `ship-rng-${i}`)));
    this.libs = controllers.map((c) => makeLib(this.world, c.charge ?? (() => {})));
    for (const c of controllers) c.begin();
  }

  get done(): boolean {
    return this.result !== null;
  }

  get time(): number {
    return worldTime(this.world);
  }

  /** One physics step (with decisions on decision ticks). Returns true when the match has ended. */
  step(): boolean {
    if (this.result) return true;
    const w = this.world;
    if (w.tick % w.rules.decisionEvery === 0) {
      for (let i = 0; i < w.ships.length; i++) {
        const ship = w.ships[i];
        if (!ship.alive) continue;
        const obs = buildObservation(w, i, this.rngs[i], this.libs[i], this.rulesCopy);
        const d = this.controllers[i].decide(obs);
        ship.action = d.action;
        ship.stats.decisions++;
        if (d.status === 'timeout') ship.stats.timeouts++;
        else if (d.status === 'error') ship.stats.errors++;
        else if (d.status === 'disabled') ship.stats.disabled = true;
        if (d.status !== 'ok' && d.status !== 'disabled') {
          if (d.error) ship.stats.lastError = d.error;
          if (this.errorsLogged[i] < 8) {
            this.errorsLogged[i]++;
            this.log.push({ tick: w.tick, ship: i, status: d.status, error: d.error });
          }
        } else if (d.status === 'disabled' && this.errorsLogged[i] < 8 && !ship.stats.lastError?.startsWith('[disabled]')) {
          this.errorsLogged[i]++;
          ship.stats.lastError = `[disabled] ${d.error ?? 'too many consecutive timeouts'}`;
          this.log.push({ tick: w.tick, ship: i, status: 'disabled', error: ship.stats.lastError });
        }
        if (this.config.recordActions) this.actions[i].push([d.action.thrust, d.action.turn, d.action.fire ? 1 : 0]);
      }
    }
    stepWorld(w);
    const alive = w.ships.filter((s) => s.alive).length;
    const timeUp = worldTime(w) >= w.rules.timeLimit - 1e-9;
    // The last ship standing must stay alive `victoryHold` seconds more (no crashing into a planet or the edge).
    if (alive === 1 && this.holdStart === null) {
      this.holdStart = w.tick;
      this.holdDeathTick = Math.max(...w.ships.filter((s) => !s.alive).map((s) => s.deathTick));
    }
    const holdTicks = Math.round((w.rules.victoryHold ?? 0) / w.rules.dt);
    const held = alive === 1 && this.holdStart !== null && w.tick - this.holdStart >= holdTicks;
    if (alive === 0) this.finish('allDead');
    else if (held) this.finish('elimination');
    else if (timeUp) this.finish(alive === 1 ? 'elimination' : 'timeLimit');
    return this.result !== null;
  }

  run(): MatchResult {
    while (!this.step()) {
      /* keep stepping */
    }
    return this.result!;
  }

  private finish(reason: EndReason) {
    const w = this.world;
    const margin = w.rules.drawHpMargin;
    // Score: survivors beat the dead; survivors rank by HP (ties within margin), the dead by how long they lasted.
    // A ship that dies during its victory hold did not hold: it ranks as if it died with the last ship it outlived.
    const deathKey = (t: number) => (this.holdStart !== null && t > this.holdDeathTick ? this.holdDeathTick : t);
    const order = [...w.ships].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.alive) return b.hp - a.hp;
      return deathKey(b.deathTick) - deathKey(a.deathTick);
    });
    const placement = new Array<number>(w.ships.length);
    let groupTop = order[0];
    let groupPlace = 1;
    order.forEach((s, rank) => {
      const tied = s.alive === groupTop.alive && (s.alive ? groupTop.hp - s.hp < margin : deathKey(s.deathTick) === deathKey(groupTop.deathTick));
      if (!tied) {
        groupTop = s;
        groupPlace = rank + 1;
      }
      placement[s.index] = groupPlace;
    });
    const firsts = placement.filter((p) => p === 1).length;
    const winner = firsts === 1 ? placement.indexOf(1) : null;
    this.result = {
      winner,
      reason,
      ticks: w.tick,
      duration: worldTime(w),
      finalHash: hashWorld(w),
      ships: w.ships.map((s) => ({
        index: s.index,
        name: this.config.names[s.index] ?? s.id,
        placement: placement[s.index],
        alive: s.alive,
        hp: Math.max(0, s.hp),
        survival: s.alive ? worldTime(w) : s.deathTick * w.rules.dt,
        deathCause: s.deathCause,
        killer: s.killer,
        stats: { ...s.stats },
      })),
    };
  }
}
