import type { Leaderboard } from '../bench/metrics';
import type { MatchSummary } from '../bench/runner';
import type { MatchJob } from '../bench/schedule';
import type { ValidationReport } from '../bench/validate';
import type { DecisionLog, MatchResult } from '../sim/match';
import type { MapDef, MapParams } from '../sim/mapgen';
import type { Action, DeathCause, SimEvent } from '../sim/physics';
import type { Replay } from '../sim/replay';
import type { RuleSet } from '../sim/ruleset';
import type { Vec } from '../sim/vec';

export type WorkerIn =
  | { type: 'validate'; id: number; code: string; rules: RuleSet }
  | { type: 'bench-init'; rules: RuleSet; sources: Record<string, string> }
  | { type: 'bench-job'; job: MatchJob; keepActions: boolean }
  | {
      type: 'arena-start';
      rules: RuleSet;
      map: MapParams;
      names: string[];
      sources: string[];
      rulesetHash: string;
      strategyHashes: string[];
      replay?: Replay;
    }
  | { type: 'arena-step'; ticks: number }
  | { type: 'verify'; id: number; replay: Replay }
  | { type: 'leaderboard'; id: number; strategies: string[]; matches: MatchSummary[]; anchor: string | null; resamples: number };

export interface ShipFrame {
  pos: Vec;
  vel: Vec;
  angle: number;
  hp: number;
  fuel: number;
  ammo: number;
  heat: number;
  overheated: boolean;
  alive: boolean;
  action: Action;
  shots: number;
  hits: number;
  errors: number;
  timeouts: number;
  disabled: boolean;
  lastError: string | null;
  deathCause: DeathCause | null;
}

export interface ArenaFrame {
  tick: number;
  t: number;
  ships: ShipFrame[];
  bullets: Array<{ x: number; y: number; owner: number }>;
  planets: Array<{ pos: Vec; radius: number; mass: number }>;
  events: SimEvent[];
  log: DecisionLog[];
  result: MatchResult | null;
  replay: Replay | null;
}

export type WorkerOut =
  | { type: 'validated'; id: number; report: ValidationReport }
  | { type: 'bench-ready' }
  | { type: 'bench-result'; summary: MatchSummary }
  | { type: 'arena-ready'; map: MapDef; rules: RuleSet; frame: ArenaFrame }
  | { type: 'arena-frame'; frame: ArenaFrame }
  | { type: 'verified'; id: number; ok: boolean; result: MatchResult }
  | { type: 'leaderboard-done'; id: number; leaderboard: Leaderboard }
  | { type: 'error'; message: string };

export function spawnSimWorker(): Worker {
  return new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
}
