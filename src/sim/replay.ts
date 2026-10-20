import { ReplayController } from '../sandbox/controller';
import type { MatchSummary } from '../bench/runner';
import type { MapParams } from './mapgen';
import { Match, type ActionTuple, type MatchResult } from './match';
import type { RuleSet } from './ruleset';

export const APP_VERSION = '0.1.0';

/** Self-contained replay: rules + map + every decision. Physics is a pure function of these. */
export interface Replay {
  format: 'orbital-onyx-replay';
  version: 1;
  app: string;
  rulesetHash: string;
  rules: RuleSet;
  map: MapParams;
  names: string[];
  strategyHashes: string[];
  actions: ActionTuple[][];
  result: { winner: number | null; finalHash: string; ticks: number; reason: string };
  createdAt: string;
}

export function makeReplay(match: Match, rulesetHash: string, strategyHashes: string[]): Replay {
  const r = match.result;
  if (!r) throw new Error('match not finished');
  if (!match.config.recordActions) throw new Error('match was run without recordActions');
  return {
    format: 'orbital-onyx-replay',
    version: 1,
    app: APP_VERSION,
    rulesetHash,
    rules: match.config.rules,
    map: match.config.map,
    names: match.config.names,
    strategyHashes,
    actions: match.actions,
    result: { winner: r.winner, finalHash: r.finalHash, ticks: r.ticks, reason: r.reason },
    createdAt: new Date().toISOString(),
  };
}

export function replayMatch(replay: Replay, recordEvents = false): Match {
  return new Match(
    { rules: replay.rules, map: replay.map, names: replay.names, recordEvents },
    replay.actions.map((t) => new ReplayController(t)),
  );
}

/** Re-simulates the replay and checks the final state hash matches the recorded one. */
export function verifyReplay(replay: Replay): { ok: boolean; result: MatchResult } {
  const result = replayMatch(replay).run();
  return { ok: result.finalHash === replay.result.finalHash && result.ticks === replay.result.ticks, result };
}

/** Builds a replay from a tournament match that kept its action tracks. */
export function replayFromSummary(m: MatchSummary, rules: RuleSet, rulesetHash: string, names: string[], strategyHashes: string[], createdAt = new Date().toISOString()): Replay {
  if (!m.actions) throw new Error('match has no action tracks (run the tournament with replays kept)');
  return {
    format: 'orbital-onyx-replay',
    version: 1,
    app: APP_VERSION,
    rulesetHash,
    rules,
    map: m.map,
    names,
    strategyHashes,
    actions: m.actions,
    result: { winner: m.winner, finalHash: m.finalHash, ticks: Math.round(m.duration / rules.dt), reason: m.reason },
    createdAt,
  };
}
