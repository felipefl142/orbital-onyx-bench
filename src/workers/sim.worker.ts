/// <reference lib="webworker" />
/**
 * Simulation worker: runs matches, tournaments jobs and smoke validation. Strategy code only ever runs here, in a
 * realm with no network and frozen intrinsics.
 */
import { buildLeaderboard } from '../bench/metrics';
import { runJob, StrategyPool } from '../bench/runner';
import type { MatchJob } from '../bench/schedule';
import { validateStrategy } from '../bench/validate';
import { hardenRealm } from '../sandbox/harden';
import { Match } from '../sim/match';
import type { MapParams } from '../sim/mapgen';
import { makeReplay, replayMatch, verifyReplay, type Replay } from '../sim/replay';
import type { RuleSet } from '../sim/ruleset';
import type { ArenaFrame, WorkerIn } from './protocol';

const send = self.postMessage.bind(self);
hardenRealm();

let pool: StrategyPool | null = null;
let poolRules: RuleSet | null = null;
let arena: { match: Match; rulesetHash: string; strategyHashes: string[]; replay: Replay | null } | null = null;

function frame(): ArenaFrame {
  const m = arena!.match;
  const w = m.world;
  const f: ArenaFrame = {
    tick: w.tick,
    t: m.time,
    ships: w.ships.map((s) => ({
      pos: { ...s.pos },
      vel: { ...s.vel },
      angle: s.angle,
      hp: s.hp,
      fuel: s.fuel,
      ammo: s.ammo,
      heat: s.heat,
      overheated: s.lock > 0,
      alive: s.alive,
      action: { ...s.action },
      shots: s.stats.shots,
      hits: s.stats.hits,
      errors: s.stats.errors,
      timeouts: s.stats.timeouts,
      disabled: s.stats.disabled,
      lastError: s.stats.lastError,
      deathCause: s.deathCause,
    })),
    bullets: w.bullets.map((b) => ({ x: b.pos.x, y: b.pos.y, owner: b.owner })),
    planets: w.planets.map((p) => ({ pos: { ...p.pos }, radius: p.radius, mass: p.mass })),
    events: w.events.splice(0),
    log: m.log.splice(0),
    result: m.result,
    replay: null,
  };
  return f;
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'validate': {
        send({ type: 'validated', id: msg.id, report: validateStrategy(msg.code, msg.rules) });
        break;
      }
      case 'bench-init': {
        pool = new StrategyPool(msg.rules, msg.sources);
        poolRules = msg.rules;
        send({ type: 'bench-ready' });
        break;
      }
      case 'bench-job': {
        if (!pool || !poolRules) throw new Error('bench-init first');
        const job: MatchJob = msg.job;
        send({ type: 'bench-result', summary: runJob(job, pool, poolRules, msg.keepActions) });
        break;
      }
      case 'arena-start': {
        let match: Match;
        if (msg.replay) {
          match = replayMatch(msg.replay, true);
        } else {
          const p = new StrategyPool(msg.rules, Object.fromEntries(msg.sources.map((s, i) => [`s${i}`, s])));
          const map: MapParams = msg.map;
          match = new Match(
            { rules: msg.rules, map, names: msg.names, recordActions: true, recordEvents: true },
            msg.sources.map((_, i) => p.controller(`s${i}`)),
          );
        }
        arena = { match, rulesetHash: msg.rulesetHash, strategyHashes: msg.strategyHashes, replay: null };
        send({ type: 'arena-ready', map: match.world.map, rules: match.config.rules, frame: frame() });
        break;
      }
      case 'leaderboard': {
        send({ type: 'leaderboard-done', id: msg.id, leaderboard: buildLeaderboard(msg.strategies, msg.matches, msg.anchor, msg.resamples) });
        break;
      }
      case 'verify': {
        const v = verifyReplay(msg.replay);
        send({ type: 'verified', id: msg.id, ok: v.ok, result: v.result });
        break;
      }
      case 'arena-step': {
        if (!arena) throw new Error('arena-start first');
        const m = arena.match;
        for (let i = 0; i < msg.ticks && !m.done; i++) m.step();
        const f = frame();
        if (m.done && !arena.replay && m.config.recordActions) {
          arena.replay = makeReplay(m, arena.rulesetHash, arena.strategyHashes);
          f.replay = arena.replay;
        }
        send({ type: 'arena-frame', frame: f });
        break;
      }
    }
  } catch (e) {
    send({ type: 'error', message: `${(e as Error).name}: ${(e as Error).message}` });
  }
};
