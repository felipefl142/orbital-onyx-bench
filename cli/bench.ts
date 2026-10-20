/**
 * Headless tournament runner.
 *
 *   npm run bench -- --strategies ./strategies --seeds 20 --out results.json
 *
 * Every *.js file in --strategies is one strategy (its id is the file name without .js). The four reference
 * strategies are added unless --no-refs is given.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildLeaderboard, leaderboardCsv } from '../src/bench/metrics';
import { runJob, StrategyPool, type MatchSummary } from '../src/bench/runner';
import { buildSchedule, DEFAULT_TOURNAMENT, seedList, type TournamentConfig } from '../src/bench/schedule';
import { hardenRealm } from '../src/sandbox/harden';
import { sha256 } from '../src/sim/hash';
import { APP_VERSION, replayFromSummary } from '../src/sim/replay';
import { DEFAULT_RULESET, RULESET_V1, rulesetHash, type RuleSet } from '../src/sim/ruleset';
import { REFERENCE_STRATEGIES } from '../src/strategies/refs';
import { REFERENCE_STRATEGIES_V1 } from '../src/strategies/refsV1';

function usage(): never {
  console.log(`usage: npm run bench -- [options]
  --strategies DIR     folder with *.js strategies (optional)
  --no-refs            leave out idle/orbiter/turret/hunter
  --seeds N            seeds per pairing (default ${DEFAULT_TOURNAMENT.seeds})
  --base-seed N        base seed (default ${DEFAULT_TOURNAMENT.baseSeed})
  --planets 1,3,6,10   planet counts
  --format 1v1|ffa     (default 1v1)
  --ffa-size N         ships per FFA match (3-8, default 4)
  --orbits             planets rotate around the centre
  --ruleset FILE       RuleSet JSON (default: built-in ${DEFAULT_RULESET.id})
  --v1                 ruleset onyx-v1 and the v1 reference strategies (reproduces the 2026-10-19 runs)
  --replays            keep action tracks for every match in the output
  --save-replay ID:FILE  write match ID as a replay file (repeatable; import it in the app's Replays tab)
  --resamples N        bootstrap resamples (default 1000)
  --out FILE           results JSON (default results.json)
  --csv FILE           leaderboard CSV (optional)`);
  process.exit(0);
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
if (flag('--help') || flag('-h')) usage();

const rules: RuleSet = opt('--ruleset') ? JSON.parse(readFileSync(opt('--ruleset')!, 'utf8')) : flag('--v1') ? RULESET_V1 : DEFAULT_RULESET;
const cfg: TournamentConfig = {
  ...DEFAULT_TOURNAMENT,
  format: opt('--format', '1v1') === 'ffa' ? 'ffa' : '1v1',
  ffaSize: Number(opt('--ffa-size', '4')),
  seeds: Number(opt('--seeds', String(DEFAULT_TOURNAMENT.seeds))),
  baseSeed: Number(opt('--base-seed', String(DEFAULT_TOURNAMENT.baseSeed))),
  planetCounts: (opt('--planets') ?? DEFAULT_TOURNAMENT.planetCounts.join(',')).split(',').map(Number),
  orbits: flag('--orbits'),
  keepReplays: flag('--replays'),
};

const sources: Record<string, string> = {};
if (!flag('--no-refs')) for (const r of flag('--v1') ? REFERENCE_STRATEGIES_V1 : REFERENCE_STRATEGIES) sources[r.name] = r.code;
const dir = opt('--strategies');
if (dir) {
  if (!existsSync(dir)) throw new Error(`no such folder: ${dir}`);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    sources[basename(f, '.js')] = readFileSync(join(dir, f), 'utf8');
  }
}
const ids = Object.keys(sources);
if (ids.length < 2) throw new Error('need at least two strategies');

const hashes: Record<string, string> = {};
for (const id of ids) hashes[id] = await sha256(sources[id]);
const rHash = await rulesetHash(rules);

// Lock the realm down before any strategy code runs.
hardenRealm();
const pool = new StrategyPool(rules, sources);
for (const id of ids) {
  const e = pool.compileError(id);
  if (e) console.error(`! ${id}: ${e}`);
}

const jobs = buildSchedule(cfg, ids);
const replayOut = new Map<number, string>();
args.forEach((a, i) => {
  if (a !== '--save-replay') return;
  const [id, file] = (args[i + 1] ?? '').split(/:(.*)/s);
  if (!file || !Number.isInteger(Number(id))) throw new Error('usage: --save-replay ID:FILE');
  replayOut.set(Number(id), file);
});
console.log(`${ids.length} strategies, ${jobs.length} matches, ruleset ${rules.id} (${rHash})`);
const t0 = Date.now();
const results: MatchSummary[] = [];
for (const job of jobs) {
  const summary = runJob(job, pool, rules, cfg.keepReplays || replayOut.has(job.id));
  const file = replayOut.get(job.id);
  if (file) {
    writeFileSync(file, JSON.stringify(replayFromSummary(summary, rules, rHash, job.strategies, job.strategies.map((s) => hashes[s]))));
    if (!cfg.keepReplays) delete summary.actions;
  }
  results.push(summary);
  if (results.length % 100 === 0 || results.length === jobs.length) {
    const rate = results.length / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r  ${results.length}/${jobs.length}  ${rate.toFixed(0)} matches/s   `);
  }
}
process.stdout.write('\n');

const anchor = ids.includes('idle') ? 'idle' : null;
const lb = buildLeaderboard(ids, results, anchor, Number(opt('--resamples', '1000')));
const fmt = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
console.log('\n  #  strategy              Elo  (95% CI)          win%   surv  planet%  acc%  faults/1k');
lb.rows.forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(3)}  ${r.strategy.padEnd(18)} ${fmt(r.elo).padStart(6)}  [${fmt(r.eloLo)}, ${fmt(r.eloHi)}]`.padEnd(52) +
      `${fmt(r.winRate * 100, 1).padStart(6)} ${fmt(r.survivalMean, 1).padStart(6)} ${fmt(r.planetDeathRate * 100, 1).padStart(7)} ${fmt(r.accuracy * 100, 1).padStart(5)} ${fmt(r.faultsPer1k, 2).padStart(9)}`,
  );
});

const out = opt('--out', 'results.json')!;
writeFileSync(
  out,
  JSON.stringify(
    {
      format: 'orbital-onyx-results',
      app: APP_VERSION,
      createdAt: new Date().toISOString(),
      ruleset: rules,
      rulesetHash: rHash,
      tournament: cfg,
      seeds: seedList(cfg),
      anchor,
      strategies: ids.map((id) => ({ id, sha256: hashes[id] })),
      leaderboard: lb,
      matches: results,
    },
    null,
    1,
  ),
);
for (const [id, file] of replayOut) console.log(`replay of match ${id} → ${file}`);
console.log(`\nresults → ${out}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const csv = opt('--csv');
if (csv) {
  writeFileSync(csv, leaderboardCsv(lb, (s) => ({ sha256: hashes[s] })));
  console.log(`csv → ${csv}`);
}
