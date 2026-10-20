import { DEFAULT_RULESET } from '../sim/ruleset';
import { REFERENCE_STRATEGIES } from '../strategies/refs';
import { runJob, StrategyPool } from './runner';
import { buildSchedule, DEFAULT_TOURNAMENT } from './schedule';

/** Final hashes of a small fixed tournament (1v1 + FFA, fixed and orbiting planets). Same list on every engine = deterministic. */
export function crossEngineHashes(): string[] {
  const sources = Object.fromEntries(REFERENCE_STRATEGIES.map((s) => [s.name, s.code]));
  const ids = Object.keys(sources);
  const pool = new StrategyPool(DEFAULT_RULESET, sources);
  const base = { ...DEFAULT_TOURNAMENT, seeds: 1, baseSeed: 7 };
  const jobs = [
    ...buildSchedule({ ...base, planetCounts: [3, 10] }, ids),
    ...buildSchedule({ ...base, planetCounts: [6], orbits: true }, ids),
    ...buildSchedule({ ...base, format: 'ffa', ffaSize: 4, planetCounts: [5, 12], orbits: true }, ids),
  ];
  return jobs.map((j) => runJob(j, pool, DEFAULT_RULESET, false).finalHash);
}
