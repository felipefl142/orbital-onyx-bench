import { compileStrategy, StrategyController, type Factory } from '../sandbox/controller';
import { Match, type ActionTuple, type DecisionLog, type EndReason } from '../sim/match';
import type { MapParams } from '../sim/mapgen';
import type { DeathCause, ShipStats } from '../sim/physics';
import type { RuleSet } from '../sim/ruleset';
import type { MatchJob } from './schedule';

export interface ShipSummary {
  strategy: string;
  placement: number;
  alive: boolean;
  hp: number;
  survival: number;
  deathCause: DeathCause | null;
  stats: ShipStats;
}

export interface MatchSummary {
  jobId: number;
  map: MapParams;
  winner: number | null;
  reason: EndReason;
  duration: number;
  finalHash: string;
  ships: ShipSummary[];
  log: DecisionLog[];
  actions?: ActionTuple[][];
}

/** Compiles each strategy once; every match gets a fresh controller instance (fresh module state and mem). */
export class StrategyPool {
  private factories = new Map<string, Factory | string>();

  constructor(
    private rules: RuleSet,
    sources: Record<string, string>,
  ) {
    for (const [id, code] of Object.entries(sources)) {
      const c = compileStrategy(code);
      this.factories.set(id, c.ok ? c.factory : c.error);
    }
  }

  compileError(id: string): string | null {
    const f = this.factories.get(id);
    return typeof f === 'string' ? f : f ? null : 'unknown strategy';
  }

  controller(id: string): StrategyController {
    const f = this.factories.get(id);
    const factory: Factory =
      typeof f === 'function'
        ? f
        : () => {
            throw new Error(`compile error: ${f ?? 'unknown strategy'}`);
          };
    return new StrategyController(factory, {
      opBudget: this.rules.opBudget,
      maxConsecutiveTimeouts: this.rules.maxConsecutiveTimeouts,
      memLimit: this.rules.memLimit,
    });
  }
}

export function runJob(job: MatchJob, pool: StrategyPool, rules: RuleSet, keepActions: boolean): MatchSummary {
  const match = new Match(
    { rules, map: job.map, names: job.strategies, recordActions: keepActions },
    job.strategies.map((id) => pool.controller(id)),
  );
  const r = match.run();
  return {
    jobId: job.id,
    map: job.map,
    winner: r.winner,
    reason: r.reason,
    duration: r.duration,
    finalHash: r.finalHash,
    ships: r.ships.map((s, i) => ({
      strategy: job.strategies[i],
      placement: s.placement,
      alive: s.alive,
      hp: s.hp,
      survival: s.survival,
      deathCause: s.deathCause,
      stats: s.stats,
    })),
    log: match.log,
    actions: keepActions ? match.actions : undefined,
  };
}
