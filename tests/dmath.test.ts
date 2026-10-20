import { describe, expect, it } from 'vitest';
import { compileStrategy } from '../src/sandbox/controller';
import { instrument } from '../src/sandbox/instrument';
import * as D from '../src/sim/dmath';
import { mulberry32 } from '../src/sim/prng';

// The deterministic versions must agree with the engine's Math to within a few ulp (relative 1e-14 or so).
const near = (a: number, b: number, rel = 4e-15) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

describe('deterministic math', () => {
  const rng = mulberry32(99);
  const xs = [0, -0, 1e-12, 0.5, 1, Math.PI / 4, Math.PI / 2, Math.PI, 2, 10, 123.456, 1000, -7.25, ...Array.from({ length: 4000 }, () => (rng() - 0.5) * 200)];

  it('sin and cos', () => {
    for (const x of xs) {
      expect(near(D.sin(x), Math.sin(x))).toBe(true);
      expect(near(D.cos(x), Math.cos(x))).toBe(true);
    }
  });

  it('atan2 over all quadrants and special values', () => {
    for (const y of xs.slice(0, 600)) for (const x of [1, -1, 3.5, -0.25, 1e-9, -1e9]) expect(near(D.atan2(y, x), Math.atan2(y, x))).toBe(true);
    for (const [y, x] of [
      [0, 0],
      [-0, 0],
      [0, -0],
      [-0, -0],
      [1, 0],
      [-1, 0],
      [0, -1],
      [-0, -1],
      [Infinity, Infinity],
      [-Infinity, -Infinity],
      [1, -Infinity],
      [-1, Infinity],
    ])
      expect(Object.is(D.atan2(y, x), Math.atan2(y, x)) || near(D.atan2(y, x), Math.atan2(y, x))).toBe(true);
  });

  it('exp, log, pow, hypot', () => {
    for (const x of xs) {
      expect(near(D.exp(x / 4), Math.exp(x / 4))).toBe(true);
      const a = Math.abs(x) + 1e-3;
      expect(near(D.log(a), Math.log(a), 1e-14)).toBe(true);
      expect(near(D.pow(a, 0.37), Math.pow(a, 0.37), 1e-13)).toBe(true);
      expect(near(D.hypot(x, 3), Math.hypot(x, 3))).toBe(true);
    }
    expect(D.pow(2, 10)).toBe(1024);
    expect(D.pow(-2, 3)).toBe(-8);
    expect(D.log(1)).toBe(0);
    expect(D.exp(0)).toBe(1);
    expect(D.log(5e-324)).toBeCloseTo(Math.log(5e-324), 10);
  });
});

describe('strategy ** operator', () => {
  it('is rewritten to the deterministic pow', () => {
    const r = instrument('export default function control(){ return 2 ** (1 + 1) ** 2 + (3) ** 2; }');
    expect(r.ok && r.code.includes('__pow(')).toBe(true);
    const c = compileStrategy('let v = 0; export default function control(){ v = 2 ** 3 ** 2 + (1 + 2) ** 2; return { thrust: v, turn: 0, fire: false }; }');
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const inst = c.factory({ ops: 0, budget: 1e6 });
    expect((inst.control({} as never, {}) as { thrust: number }).thrust).toBe(2 ** 9 + 9);
  });

  it('rejects **=', () => {
    expect(compileStrategy('export default function control(){ let x = 2; x **= 2; return {}; }').ok).toBe(false);
  });
});

describe('sha256 fallback', () => {
  it('matches WebCrypto', async () => {
    const { sha256, sha256Js } = await import('../src/sim/hash');
    for (const t of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000), 'ação ☤ 🚀']) {
      expect(sha256Js(new TextEncoder().encode(t))).toBe(await sha256(t));
    }
  });
});
