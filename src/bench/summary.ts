import type { Leaderboard } from './metrics';
import type { MatchSummary } from './runner';
import type { TournamentConfig } from './schedule';

const f = (x: number | null | undefined, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '—' : !Number.isFinite(x) ? '∞' : x.toFixed(d));
const p = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(1)}%`);

export interface SummaryInput {
  config: TournamentConfig;
  leaderboard: Leaderboard;
  matches: MatchSummary[];
  name: (id: string) => string;
}

/**
 * Results summary given back to a model in improvement rounds: its own numbers, how its ship died, and its score
 * against each opponent. Never the opponents' code.
 */
export function tournamentSummary(t: SummaryInput, id: string): string {
  const lb = t.leaderboard;
  const rank = lb.rows.findIndex((r) => r.strategy === id);
  const r = lb.rows[rank];
  const deaths: Record<string, number> = { alive: 0, planet: 0, bounds: 0, bullet: 0, collision: 0 };
  let games = 0;
  let wonThenLost = 0;
  for (const m of t.matches) {
    const s = m.ships.find((x) => x.strategy === id);
    if (!s) continue;
    games++;
    deaths[s.deathCause ?? 'alive']++;
    // Outlived every enemy but died during the victory hold.
    if (!s.alive && m.ships.every((o) => o === s || (!o.alive && o.survival <= s.survival)) && m.winner === null) wonThenLost++;
  }
  const lines = [
    `Tournament: ${t.config.format}, ${t.config.seeds} seeds × planet counts [${t.config.planetCounts.join(', ')}]${t.config.orbits ? ', orbiting planets' : ''}, ${lb.matches} matches.`,
    `Your rank: ${rank + 1} of ${lb.rows.length}. Rating ${f(r.elo)} (95% CI ${f(r.eloLo)}..${f(r.eloHi)}); the idle ship (never acts) is rated 0.`,
    `Win rate ${p(r.winRate)} (${r.wins} W / ${r.draws} D / ${r.losses} L). Mean survival ${f(r.survivalMean, 1)} s.`,
    `How your ship ended its ${games} matches: alive ${deaths.alive}, hit a planet ${deaths.planet}, left the arena ${deaths.bounds}, shot down ${deaths.bullet}, rammed ${deaths.collision}.`,
    ...(wonThenLost ? [`${wonThenLost} times you outlived every enemy but then died during the victory hold.`] : []),
    `Shot accuracy ${p(r.accuracy)}. Damage per unit of fuel ${f(r.efficiency, 2)}.`,
    `Faults (budget overruns + errors) per 1000 decisions: ${f(r.faultsPer1k, 2)}. Disabled in ${p(r.disabledRate)} of matches.`,
    '',
    'Score against each opponent (1 = always won, 0.5 = even):',
    ...Object.entries(lb.headToHead[id] ?? {}).map(([o, v]) => `- ${t.name(o)}: ${v.games ? (v.score / v.games).toFixed(2) : '—'} over ${v.games} games`),
  ];
  const errs = new Set<string>();
  for (const m of t.matches) {
    const idx = m.ships.findIndex((s) => s.strategy === id);
    for (const l of m.log) if (l.ship === idx && l.error && errs.size < 3) errs.add(l.error.split('\n')[0]);
  }
  if (errs.size) lines.push('', 'Errors seen:', ...[...errs].map((e) => `- ${e}`));
  return lines.join('\n');
}
