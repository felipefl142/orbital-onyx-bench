import type { MapParams } from '../sim/mapgen';
import { deriveSeed } from '../sim/prng';

export interface TournamentConfig {
  format: '1v1' | 'ffa';
  /** Ships per FFA match (3–8). Ignored for 1v1. */
  ffaSize: number;
  seeds: number;
  baseSeed: number;
  planetCounts: number[];
  orbits: boolean;
  /** Keep full action tracks for every match (bigger results; enables replays of any match). */
  keepReplays: boolean;
}

export const DEFAULT_TOURNAMENT: TournamentConfig = {
  format: '1v1',
  ffaSize: 4,
  seeds: 20,
  baseSeed: 20261019,
  planetCounts: [1, 3, 6, 10],
  orbits: false,
  keepReplays: false,
};

export interface MatchJob {
  id: number;
  map: MapParams;
  /** Strategy ids in spawn order. */
  strategies: string[];
}

export function seedList(cfg: TournamentConfig): number[] {
  return Array.from({ length: cfg.seeds }, (_, i) => deriveSeed(cfg.baseSeed, `seed-${i}`));
}

/**
 * 1v1: every pair × every planet count × every seed × both spawn orders.
 * FFA: every planet count × every seed × `ffaSize` rotations of a seeded line-up (each strategy takes each spawn).
 */
export function buildSchedule(cfg: TournamentConfig, strategyIds: string[]): MatchJob[] {
  const jobs: MatchJob[] = [];
  const seeds = seedList(cfg);
  let id = 0;
  if (cfg.format === '1v1') {
    for (let i = 0; i < strategyIds.length; i++) {
      for (let j = i + 1; j < strategyIds.length; j++) {
        for (const planets of cfg.planetCounts) {
          for (const seed of seeds) {
            for (const order of [
              [strategyIds[i], strategyIds[j]],
              [strategyIds[j], strategyIds[i]],
            ]) {
              jobs.push({ id: id++, map: { seed, planets, ships: 2, orbits: cfg.orbits }, strategies: order });
            }
          }
        }
      }
    }
    return jobs;
  }
  const k = Math.max(3, Math.min(8, cfg.ffaSize, strategyIds.length));
  for (const planets of cfg.planetCounts) {
    for (const seed of seeds) {
      // Pick k strategies for this seed deterministically, then rotate spawns.
      const pool = [...strategyIds];
      let h = seed;
      for (let i = pool.length - 1; i > 0; i--) {
        h = deriveSeed(h, i);
        const r = h % (i + 1);
        [pool[i], pool[r]] = [pool[r], pool[i]];
      }
      const lineup = pool.slice(0, k);
      for (let rot = 0; rot < k; rot++) {
        const order = lineup.map((_, s) => lineup[(s + rot) % k]);
        jobs.push({ id: id++, map: { seed, planets, ships: k, orbits: cfg.orbits }, strategies: order });
      }
    }
  }
  return jobs;
}
