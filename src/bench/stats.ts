import { mulberry32 } from '../sim/prng';

/** One pairwise game: `score` is 1 if `a` won, 0 if `b` won, 0.5 for a draw. */
export interface PairGame {
  a: number;
  b: number;
  score: number;
}

/**
 * Bradley-Terry strengths by the MM algorithm (Hunter 2004). Each player also gets one win and one loss against a
 * virtual opponent of strength 1, a weak prior that keeps winless or unbeaten players finite.
 */
export function fitBradleyTerry(n: number, games: PairGame[], iters = 200, init?: number[]): number[] {
  const wins = new Float64Array(n).fill(1);
  const pairs = new Map<number, number>();
  for (const g of games) {
    wins[g.a] += g.score;
    wins[g.b] += 1 - g.score;
    const key = g.a < g.b ? g.a * n + g.b : g.b * n + g.a;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const plist = [...pairs.entries()].map(([k, c]) => [Math.floor(k / n), k % n, c] as const);
  let p = init ? Float64Array.from(init) : new Float64Array(n).fill(1);
  for (let it = 0; it < iters; it++) {
    const denom = new Float64Array(n);
    for (let i = 0; i < n; i++) denom[i] = 2 / (p[i] + 1);
    for (const [i, j, c] of plist) {
      const d = c / (p[i] + p[j]);
      denom[i] += d;
      denom[j] += d;
    }
    const next = new Float64Array(n);
    let maxRel = 0;
    for (let i = 0; i < n; i++) {
      next[i] = wins[i] / denom[i];
      maxRel = Math.max(maxRel, Math.abs(next[i] - p[i]) / p[i]);
    }
    p = next;
    if (maxRel < 1e-9) break;
  }
  return [...p];
}

/** Elo-scale ratings (400·log10), anchored so `anchor` = 0 (or the geometric mean when anchor < 0). */
export function toElo(p: number[], anchor: number): number[] {
  const ref = anchor >= 0 ? Math.log10(p[anchor]) : p.reduce((s, x) => s + Math.log10(x), 0) / p.length;
  return p.map((x) => 400 * (Math.log10(x) - ref));
}

export interface RatingCI {
  elo: number;
  lo: number;
  hi: number;
}

/**
 * Ratings with 95 % bootstrap intervals. Resampling unit = match (`groups`), so the pairwise games of one FFA match
 * stay together.
 */
export function bootstrapRatings(n: number, groups: PairGame[][], anchor: number, resamples = 1000, seed = 1): RatingCI[] {
  const all = groups.flat();
  const point = fitBradleyTerry(n, all);
  const elo = toElo(point, anchor);
  const rng = mulberry32(seed);
  const samples: number[][] = Array.from({ length: n }, () => []);
  for (let r = 0; r < resamples; r++) {
    const games: PairGame[] = [];
    for (let i = 0; i < groups.length; i++) games.push(...groups[Math.floor(rng() * groups.length)]);
    const e = toElo(fitBradleyTerry(n, games, 60, point), anchor);
    e.forEach((x, i) => samples[i].push(x));
  }
  return elo.map((x, i) => {
    const s = samples[i].sort((a, b) => a - b);
    return { elo: x, lo: quantile(s, 0.025), hi: quantile(s, 0.975) };
  });
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Wilson score interval for a proportion (95 %). */
export function wilson(successes: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: NaN, lo: NaN, hi: NaN };
  const p = successes / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
