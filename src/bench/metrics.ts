import type { MatchSummary } from './runner';
import { bootstrapRatings, wilson, type PairGame } from './stats';

export interface LeaderboardRow {
  strategy: string;
  elo: number;
  eloLo: number;
  eloHi: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** Win rate counting a draw as half a win, with Wilson 95 % interval. */
  winRate: number;
  winLo: number;
  winHi: number;
  survivalMean: number;
  /** Share of matches in which the ship died by touching a planet. */
  planetDeathRate: number;
  /** Hits / shots (NaN when it never fired). */
  accuracy: number;
  /** Damage dealt per unit of fuel (Infinity when it dealt damage without burning fuel). */
  efficiency: number;
  /** (timeouts + errors) per 1000 decisions. */
  faultsPer1k: number;
  disabledRate: number;
}

export interface Leaderboard {
  rows: LeaderboardRow[];
  /** headToHead[a][b] = score of a against b (draw = 0.5) over their games, with game count. */
  headToHead: Record<string, Record<string, { score: number; games: number }>>;
  matches: number;
}

/** Pairwise games implied by an n-ship result: lower placement wins, equal placement is a draw. */
export function pairGames(m: MatchSummary, index: Map<string, number>): PairGame[] {
  const out: PairGame[] = [];
  for (let i = 0; i < m.ships.length; i++) {
    for (let j = i + 1; j < m.ships.length; j++) {
      const a = m.ships[i];
      const b = m.ships[j];
      if (a.strategy === b.strategy) continue;
      const score = a.placement < b.placement ? 1 : a.placement > b.placement ? 0 : 0.5;
      out.push({ a: index.get(a.strategy)!, b: index.get(b.strategy)!, score });
    }
  }
  return out;
}

export function buildLeaderboard(strategies: string[], matches: MatchSummary[], anchor: string | null, resamples = 1000): Leaderboard {
  const index = new Map(strategies.map((s, i) => [s, i]));
  const groups = matches.map((m) => pairGames(m, index));
  const ratings = bootstrapRatings(strategies.length, groups, anchor ? (index.get(anchor) ?? -1) : -1, resamples);

  const h2h: Leaderboard['headToHead'] = {};
  for (const s of strategies) {
    h2h[s] = {};
    for (const t of strategies) if (s !== t) h2h[s][t] = { score: 0, games: 0 };
  }
  for (const g of groups.flat()) {
    const a = strategies[g.a];
    const b = strategies[g.b];
    h2h[a][b].score += g.score;
    h2h[a][b].games++;
    h2h[b][a].score += 1 - g.score;
    h2h[b][a].games++;
  }

  const rows: LeaderboardRow[] = strategies.map((s, i) => {
    let games = 0;
    let wins = 0;
    let draws = 0;
    let survival = 0;
    let planetDeaths = 0;
    let shots = 0;
    let hits = 0;
    let dmg = 0;
    let fuel = 0;
    let faults = 0;
    let decisions = 0;
    let disabled = 0;
    for (const m of matches) {
      for (const ship of m.ships) {
        if (ship.strategy !== s) continue;
        games++;
        const firsts = m.ships.filter((x) => x.placement === 1).length;
        if (ship.placement === 1 && firsts === 1) wins++;
        else if (ship.placement === 1) draws++;
        survival += ship.survival;
        if (ship.deathCause === 'planet') planetDeaths++;
        shots += ship.stats.shots;
        hits += ship.stats.hits;
        dmg += ship.stats.damageDealt;
        fuel += ship.stats.fuelUsed;
        faults += ship.stats.timeouts + ship.stats.errors;
        decisions += ship.stats.decisions;
        if (ship.stats.disabled) disabled++;
      }
    }
    const w = wilson(wins + draws / 2, games);
    return {
      strategy: s,
      elo: ratings[i].elo,
      eloLo: ratings[i].lo,
      eloHi: ratings[i].hi,
      games,
      wins,
      draws,
      losses: games - wins - draws,
      winRate: w.p,
      winLo: w.lo,
      winHi: w.hi,
      survivalMean: games ? survival / games : NaN,
      planetDeathRate: games ? planetDeaths / games : NaN,
      accuracy: shots ? hits / shots : NaN,
      efficiency: fuel > 0 ? dmg / fuel : dmg > 0 ? Infinity : NaN,
      faultsPer1k: decisions ? (faults / decisions) * 1000 : NaN,
      disabledRate: games ? disabled / games : NaN,
    };
  });
  rows.sort((a, b) => b.elo - a.elo);
  return { rows, headToHead: h2h, matches: matches.length };
}

export function leaderboardCsv(lb: Leaderboard, extra: (s: string) => Record<string, string | number> = () => ({})): string {
  const cols: Array<keyof LeaderboardRow> = [
    'strategy',
    'elo',
    'eloLo',
    'eloHi',
    'games',
    'wins',
    'draws',
    'losses',
    'winRate',
    'winLo',
    'winHi',
    'survivalMean',
    'planetDeathRate',
    'accuracy',
    'efficiency',
    'faultsPer1k',
    'disabledRate',
  ];
  const extraCols = lb.rows.length ? Object.keys(extra(lb.rows[0].strategy)) : [];
  const esc = (v: unknown) => {
    const s = typeof v === 'number' ? (Number.isFinite(v) ? String(+v.toFixed(4)) : String(v)) : String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [[...cols, ...extraCols].join(',')];
  for (const r of lb.rows) {
    const ex = extra(r.strategy);
    lines.push([...cols.map((c) => esc(r[c])), ...extraCols.map((c) => esc(ex[c]))].join(','));
  }
  return lines.join('\n');
}
