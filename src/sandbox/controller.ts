import type { Observation } from '../sim/observation';
import type { Action } from '../sim/physics';
import { ZERO_ACTION } from '../sim/physics';
import { clamp } from '../sim/vec';
import { DETERMINISTIC_MATH, pow as dpow } from '../sim/dmath';
import { instrument } from './instrument';

export type DecisionStatus = 'ok' | 'timeout' | 'error' | 'disabled';

export interface Decision {
  action: Action;
  status: DecisionStatus;
  error?: string;
}

/** Anything that turns an observation into an action: a sandboxed strategy, or a recorded replay track. */
export interface Controller {
  /** Called once per match, before the first decision. */
  begin(): void;
  decide(obs: Observation): Decision;
  /** Op meter for helper-library calls; absent for controllers that do not run code. */
  charge?: (n: number) => void;
}

/** Unique token thrown when the op budget runs out; strategies cannot forge it. */
const BUDGET = Object.freeze({ budgetExceeded: true });

/** Names hidden from strategy code (shadowed by `undefined` parameters). */
const SHADOWED = [
  'globalThis',
  'self',
  'window',
  'global',
  'process',
  'require',
  'module',
  'exports',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'postMessage',
  'close',
  'indexedDB',
  'caches',
  'navigator',
  'location',
  'Worker',
  'SharedArrayBuffer',
  'Atomics',
  'WebAssembly',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'Date',
  'performance',
  'crypto',
  'eval',
  'Function',
  'Buffer',
];

/**
 * A copy of Math for strategies: transcendental functions replaced by the engine-independent versions (so the same
 * strategy makes the same decisions in Node, Chrome and Firefox), and `random` throws: use the seeded `obs.rng`.
 */
const SAFE_MATH: Math = (() => {
  const m: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(Math)) m[k] = (Math as unknown as Record<string, unknown>)[k];
  Object.assign(m, DETERMINISTIC_MATH);
  m.random = () => {
    throw new Error('Math.random is disabled: use obs.rng() (seeded, deterministic)');
  };
  return Object.freeze(m) as unknown as Math;
})();

const FunctionCtor = Function;

export type Factory = (meter: Meter) => { control: (obs: Observation, mem: Record<string, unknown>) => unknown };

export interface Meter {
  ops: number;
  budget: number;
}

export type CompileResult = { ok: true; factory: Factory; instrumented: string } | { ok: false; error: string };

/** Compiles strategy source into a factory that creates fresh instances (fresh module state) per match. */
export function compileStrategy(source: string): CompileResult {
  const inst = instrument(source);
  if (!inst.ok) return inst;
  let outer: (...args: unknown[]) => void;
  try {
    // Sloppy outer wrapper (so a parameter may be named `eval`), strict inner body for the strategy itself.
    outer = new FunctionCtor(
      '__b',
      '__pow',
      '__exports',
      'Math',
      ...SHADOWED,
      `return (function () { "use strict";\n${inst.code}\n})();`,
    ) as (...args: unknown[]) => void;
  } catch (e) {
    return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` };
  }
  const factory: Factory = (meter) => {
    const b = () => {
      if (++meter.ops > meter.budget) throw BUDGET;
    };
    const exportsObj: { default?: unknown } = {};
    outer(b, dpow, exportsObj, SAFE_MATH, ...SHADOWED.map(() => undefined));
    if (typeof exportsObj.default !== 'function') {
      throw new Error('strategy must "export default function control(obs, mem) { … }"');
    }
    return { control: exportsObj.default as (obs: Observation, mem: Record<string, unknown>) => unknown };
  };
  return { ok: true, factory, instrumented: inst.code };
}

export function isBudgetError(e: unknown): boolean {
  return e === BUDGET;
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const stack = (e.stack ?? '').split('\n').slice(0, 4).join('\n');
    return stack.includes(e.message) ? stack : `${e.name}: ${e.message}\n${stack}`;
  }
  try {
    return `thrown: ${JSON.stringify(e)}`;
  } catch {
    return 'thrown: <unserializable>';
  }
}

/** Validates and clamps a raw strategy return value. */
export function sanitizeAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const thrust = typeof r.thrust === 'number' ? r.thrust : 0;
  const turn = typeof r.turn === 'number' ? r.turn : 0;
  if (!Number.isFinite(thrust) || !Number.isFinite(turn)) return null;
  return { thrust: clamp(thrust, 0, 1), turn: clamp(turn, -1, 1), fire: r.fire === true };
}

export interface StrategyControllerOptions {
  opBudget: number;
  maxConsecutiveTimeouts: number;
  memLimit: number;
}

/**
 * Runs one strategy instance for one match. All budget accounting is op-count based (deterministic).
 * The meter is shared with `makeLib` so helper calls count against the same budget.
 */
export class StrategyController implements Controller {
  readonly meter: Meter = { ops: 0, budget: 0 };
  private instance: ReturnType<Factory> | null = null;
  private mem: Record<string, unknown> = {};
  private consecutiveTimeouts = 0;
  private disabled = false;
  private initError: string | null = null;
  private calls = 0;

  constructor(
    private factory: Factory,
    private opts: StrategyControllerOptions,
  ) {}

  /** Op charge used by the helper library. */
  charge = (n: number) => {
    this.meter.ops += n;
    if (this.meter.ops > this.meter.budget) throw BUDGET;
  };

  begin(): void {
    this.meter.ops = 0;
    this.meter.budget = this.opts.opBudget * 5;
    try {
      this.instance = this.factory(this.meter);
    } catch (e) {
      this.initError = isBudgetError(e) ? 'top-level code exceeded the op budget' : errText(e);
      this.disabled = true;
    }
  }

  decide(obs: Observation): Decision {
    if (this.disabled || !this.instance) {
      return { action: ZERO_ACTION, status: 'disabled', error: this.initError ?? undefined };
    }
    this.meter.ops = 0;
    this.meter.budget = this.opts.opBudget;
    this.calls++;
    let raw: unknown;
    try {
      raw = this.instance.control(obs, this.mem);
    } catch (e) {
      if (isBudgetError(e)) {
        this.consecutiveTimeouts++;
        if (this.consecutiveTimeouts >= this.opts.maxConsecutiveTimeouts) this.disabled = true;
        return { action: ZERO_ACTION, status: 'timeout' };
      }
      this.consecutiveTimeouts = 0;
      return { action: ZERO_ACTION, status: 'error', error: errText(e) };
    }
    this.consecutiveTimeouts = 0;
    if (this.calls % 20 === 0) {
      let size = 0;
      try {
        size = JSON.stringify(this.mem)?.length ?? 0;
      } catch {
        size = Infinity;
      }
      if (size > this.opts.memLimit) {
        this.mem = {};
        return { action: ZERO_ACTION, status: 'error', error: `mem exceeded ${this.opts.memLimit} bytes (or is not JSON-serializable); it was reset` };
      }
    }
    const action = sanitizeAction(raw);
    if (!action) return { action: ZERO_ACTION, status: 'error', error: `invalid return value: ${safePreview(raw)}` };
    return { action, status: 'ok' };
  }
}

function safePreview(x: unknown): string {
  try {
    return JSON.stringify(x)?.slice(0, 120) ?? String(x);
  } catch {
    return String(x);
  }
}

/** Plays back a recorded action track (replays). */
export class ReplayController implements Controller {
  private i = 0;
  constructor(private track: Array<[number, number, number]>) {}
  begin(): void {
    this.i = 0;
  }
  decide(): Decision {
    const a = this.track[this.i++];
    if (!a) return { action: ZERO_ACTION, status: 'ok' };
    return { action: { thrust: a[0], turn: a[1], fire: a[2] === 1 }, status: 'ok' };
  }
}
