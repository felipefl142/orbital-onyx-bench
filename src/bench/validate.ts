import { runJob, StrategyPool } from './runner';
import type { RuleSet } from '../sim/ruleset';
import { IDLE, TURRET } from '../strategies/refs';

export interface ValidationReport {
  ok: boolean;
  compileError: string | null;
  decisions: number;
  errors: number;
  timeouts: number;
  disabled: boolean;
  messages: string[];
  /** Human/model-readable summary, used as the repair prompt. */
  text: string;
}

const SMOKE_SECONDS = 10;

/** Compiles and runs 10 simulated seconds against idle and turret. Passing = compiles, no exceptions, not disabled. */
export function validateStrategy(code: string, rules: RuleSet): ValidationReport {
  const smokeRules: RuleSet = { ...rules, timeLimit: SMOKE_SECONDS };
  const pool = new StrategyPool(smokeRules, { candidate: code, idle: IDLE, turret: TURRET });
  const compileError = pool.compileError('candidate');
  if (compileError) {
    return {
      ok: false,
      compileError,
      decisions: 0,
      errors: 0,
      timeouts: 0,
      disabled: true,
      messages: [compileError],
      text: `Compile error:\n${compileError}`,
    };
  }
  const runs = [
    runJob({ id: 0, map: { seed: 101, planets: 3, ships: 2, orbits: false }, strategies: ['candidate', 'idle'] }, pool, smokeRules, true),
    runJob({ id: 1, map: { seed: 202, planets: 6, ships: 2, orbits: true }, strategies: ['turret', 'candidate'] }, pool, smokeRules, true),
  ];
  let decisions = 0;
  let errors = 0;
  let timeouts = 0;
  let disabled = false;
  let acted = false;
  const messages: string[] = [];
  runs.forEach((r) => {
    const idx = r.ships.findIndex((s) => s.strategy === 'candidate');
    const s = r.ships[idx].stats;
    decisions += s.decisions;
    errors += s.errors;
    timeouts += s.timeouts;
    disabled ||= s.disabled;
    acted ||= s.shots > 0 || s.fuelUsed > 0 || (r.actions?.[idx] ?? []).some((a) => a[1] !== 0);
    for (const l of r.log) if (l.ship === idx && l.error && !messages.includes(l.error) && messages.length < 5) messages.push(l.error);
    if (s.disabled && !messages.length) messages.push('ship was disabled after repeated op-budget overruns');
  });
  if (!acted && errors === 0 && !disabled) {
    messages.push(
      'The ship never acted: every decision returned thrust 0, turn 0, fire false. Check for a try/catch that hides an exception (for example a field that does not exist in obs or obs.rules) or a condition that is never true.',
    );
  }
  const ok = errors === 0 && !disabled && acted;
  const text = ok
    ? `OK: ${decisions} decisions, ${timeouts} budget overruns, no errors.`
    : [
        `${decisions} decisions over two ${SMOKE_SECONDS}-second smoke matches.`,
        `Exceptions or invalid return values: ${errors}. Op-budget overruns: ${timeouts}. Disabled: ${disabled ? 'yes' : 'no'}. Acted: ${acted ? 'yes' : 'no'}.`,
        ...messages.map((m, i) => `--- error ${i + 1} ---\n${m}`),
      ].join('\n');
  return { ok, compileError: null, decisions, errors, timeouts, disabled, messages, text };
}
