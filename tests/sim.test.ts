import { describe, expect, it } from 'vitest';
import { buildLeaderboard } from '../src/bench/metrics';
import { runJob, StrategyPool } from '../src/bench/runner';
import { buildSchedule, DEFAULT_TOURNAMENT } from '../src/bench/schedule';
import { compileStrategy, StrategyController } from '../src/sandbox/controller';
import { Match } from '../src/sim/match';
import { createWorld, gravityInto, specificEnergy, stepWorld } from '../src/sim/physics';
import { makeReplay, verifyReplay } from '../src/sim/replay';
import { DEFAULT_RULESET as R } from '../src/sim/ruleset';
import { REFERENCE_STRATEGIES } from '../src/strategies/refs';

const ref = (name: string) => REFERENCE_STRATEGIES.find((s) => s.name === name)!.code;

function controllerFor(code: string) {
  const c = compileStrategy(code);
  if (!c.ok) throw new Error(c.error);
  return new StrategyController(c.factory, { opBudget: R.opBudget, maxConsecutiveTimeouts: R.maxConsecutiveTimeouts, memLimit: R.memLimit });
}

function play(codes: string[], seed = 7, planets = 3, recordActions = false) {
  const m = new Match(
    { rules: R, map: { seed, planets, ships: codes.length, orbits: false }, names: codes.map((_, i) => `s${i}`), recordActions },
    codes.map(controllerFor),
  );
  m.run();
  return m;
}

describe('determinism', () => {
  it('same seed and strategies give a bit-identical final state', () => {
    const hashes = [0, 1, 2].map(() => play([ref('turret'), ref('hunter')]).result!.finalHash);
    expect(new Set(hashes).size).toBe(1);
  });

  it('different seeds give different states', () => {
    expect(play([ref('turret'), ref('hunter')], 1).result!.finalHash).not.toBe(play([ref('turret'), ref('hunter')], 2).result!.finalHash);
  });

  it('orbiting planets stay deterministic', () => {
    const run = () =>
      new Match({ rules: R, map: { seed: 3, planets: 6, ships: 4, orbits: true }, names: ['a', 'b', 'c', 'd'] }, [
        controllerFor(ref('hunter')),
        controllerFor(ref('turret')),
        controllerFor(ref('orbiter')),
        controllerFor(ref('idle')),
      ]).run().finalHash;
    expect(run()).toBe(run());
  });

  it('a replay re-simulates to the same final hash', () => {
    const m = play([ref('orbiter'), ref('hunter')], 11, 6, true);
    const replay = makeReplay(m, 'test', ['a', 'b']);
    const roundTrip = JSON.parse(JSON.stringify(replay));
    expect(verifyReplay(roundTrip).ok).toBe(true);
  });
});

describe('physics', () => {
  it('a free body orbiting one planet keeps its energy within 1 % over 60 s', () => {
    const w = createWorld(R, { seed: 5, planets: 1, ships: 2, orbits: false });
    const planet = w.planets[0];
    expect(planet.pos).toEqual({ x: 0, y: 0 });
    const [ship, other] = w.ships;
    other.alive = false;
    const r = planet.radius + 500;
    const v = Math.sqrt((R.G * planet.mass) / r);
    ship.pos = { x: r, y: 0 };
    ship.vel = { x: 0, y: v * 0.9 };
    gravityInto(w.planets, R, ship.pos.x, ship.pos.y, ship.gacc);
    const e0 = specificEnergy(w, ship.pos, ship.vel);
    let worst = 0;
    for (let i = 0; i < 60 / R.dt; i++) {
      stepWorld(w);
      worst = Math.max(worst, Math.abs((specificEnergy(w, ship.pos, ship.vel) - e0) / e0));
    }
    expect(ship.alive).toBe(true);
    expect(worst).toBeLessThan(0.01);
  });

  it('touching a planet destroys the ship', () => {
    const w = createWorld(R, { seed: 5, planets: 1, ships: 2, orbits: false });
    const ship = w.ships[0];
    ship.pos = { x: w.planets[0].radius + 20, y: 0 };
    ship.vel = { x: -200, y: 0 };
    for (let i = 0; i < 60; i++) stepWorld(w);
    expect(ship.alive).toBe(false);
    expect(ship.deathCause).toBe('planet');
  });
});

describe('sandbox', () => {
  it('an infinite loop times out, gets disabled and does not hang', () => {
    const t0 = Date.now();
    const m = play([`export default function control(){ while(true){} }`, ref('idle')]);
    const s = m.result!.ships[0].stats;
    expect(s.timeouts).toBe(R.maxConsecutiveTimeouts);
    expect(s.disabled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('infinite recursion and loops hidden in try/catch still stop', () => {
    const m = play([
      `function f(){ try { f(); } catch (e) {} f(); }
       export default function control(){ for(;;){ try { f(); } catch (e) {} } }`,
      ref('idle'),
    ]);
    expect(m.result!.ships[0].stats.disabled).toBe(true);
  });

  it.each([
    ['fetch', `export default function control(){ fetch('http://x'); return {thrust:0,turn:0,fire:false}; }`],
    ['Date.now', `export default function control(){ Date.now(); return {thrust:0,turn:0,fire:false}; }`],
    ['Math.random', `export default function control(){ Math.random(); return {thrust:0,turn:0,fire:false}; }`],
    ['globalThis', `export default function control(){ globalThis.fetch('x'); return {thrust:0,turn:0,fire:false}; }`],
  ])('%s is unavailable and fails in a controlled way', (_name, code) => {
    const m = play([code, ref('idle')]);
    const s = m.result!.ships[0].stats;
    expect(s.errors).toBeGreaterThan(0);
    expect(s.lastError).toBeTruthy();
  });

  it('imports are rejected at compile time', () => {
    const c = compileStrategy(`import x from 'y'; export default function control(){}`);
    expect(c.ok).toBe(false);
  });

  it('accepts arrow default exports and a bare control function', () => {
    expect(compileStrategy(`export default (obs) => ({ thrust: 1, turn: 0, fire: false });`).ok).toBe(true);
    const c = compileStrategy(`function control(obs){ return { thrust: 0, turn: 0, fire: false }; }`);
    expect(c.ok).toBe(true);
    if (c.ok) expect(() => c.factory({ ops: 0, budget: 1e6 })).not.toThrow();
  });

  it('bad return values become a zero action and count as errors', () => {
    const m = play([`export default function control(){ return { thrust: NaN, turn: 0 }; }`, ref('idle')]);
    expect(m.result!.ships[0].stats.errors).toBeGreaterThan(0);
  });

  it('mem persists between calls of one match', () => {
    const m = play([
      `export default function control(obs, mem){ mem.n = (mem.n || 0) + 1; if (obs.tick > 600 && mem.n < 10) throw new Error('lost'); return { thrust: 0, turn: 0, fire: false }; }`,
      ref('idle'),
    ]);
    expect(m.result!.ships[0].stats.errors).toBe(0);
  });
});

describe('benchmark', () => {
  it('reference strategies rank hunter > turret > orbiter > idle', () => {
    const sources = Object.fromEntries(REFERENCE_STRATEGIES.map((s) => [s.name, s.code]));
    const ids = Object.keys(sources);
    const pool = new StrategyPool(R, sources);
    const jobs = buildSchedule({ ...DEFAULT_TOURNAMENT, seeds: 20 }, ids);
    expect(jobs.length).toBe(6 * 4 * 20 * 2);
    const results = jobs.map((j) => runJob(j, pool, R, false));
    const lb = buildLeaderboard(ids, results, 'idle', 200);
    expect(lb.rows.map((r) => r.strategy)).toEqual(['hunter', 'turret', 'orbiter', 'idle']);
  });
});

describe('validation', () => {
  it('fails a strategy that silently never acts, and passes one that does', async () => {
    const { validateStrategy } = await import('../src/bench/validate');
    const silent = validateStrategy(`export default function control(obs){ try { return { thrust: obs.rules.engine.x, turn: 0, fire: false }; } catch (e) { return { thrust: 0, turn: 0, fire: false }; } }`, R);
    expect(silent.ok).toBe(false);
    expect(silent.text).toContain('never acted');
    expect(validateStrategy(ref('turret'), R).ok).toBe(true);
    expect(validateStrategy(ref('hunter'), R).ok).toBe(true);
  });
});

describe('victory hold (onyx-v2)', () => {
  const crashInto = (m: Match) => {
    const p = m.world.planets[0];
    const s = m.world.ships[0];
    s.pos = { x: p.pos.x + p.radius + 300, y: p.pos.y };
    s.vel = { x: -150, y: 0 };
  };

  it('the survivor wins only after holding for victoryHold seconds', () => {
    const m = new Match({ rules: R, map: { seed: 5, planets: 1, ships: 2, orbits: false }, names: ['a', 'b'] }, [controllerFor(ref('orbiter')), controllerFor(ref('idle'))]);
    m.world.ships[1].hp = 0.001;
    m.world.ships[1].pos = { x: 1900, y: 1900 }; // outside the arena: dies on the first step
    while (!m.step());
    const r = m.result!;
    expect(r.winner).toBe(0);
    expect(r.duration).toBeGreaterThanOrEqual(R.victoryHold!);
  });

  it('dying during the hold is a draw with the last enemy', () => {
    const m = new Match({ rules: R, map: { seed: 5, planets: 1, ships: 2, orbits: false }, names: ['a', 'b'] }, [controllerFor(ref('idle')), controllerFor(ref('idle'))]);
    m.world.ships[1].hp = 0.001;
    m.world.ships[1].pos = { x: 1900, y: 1900 };
    crashInto(m);
    while (!m.step());
    const r = m.result!;
    expect(r.reason).toBe('allDead');
    expect(r.ships[0].deathCause).toBe('planet');
    expect(r.winner).toBeNull();
    expect(r.ships.map((s) => s.placement)).toEqual([1, 1]);
  });
});
