import type { Leaderboard } from '../bench/metrics';
import type { MatchSummary } from '../bench/runner';
import type { MatchJob } from '../bench/schedule';
import type { ValidationReport } from '../bench/validate';
import type { Replay } from '../sim/replay';
import type { RuleSet } from '../sim/ruleset';
import { spawnSimWorker, type WorkerIn, type WorkerOut } from './protocol';

/** Wall-clock watchdog for one message round-trip. The op budget stops loops; this catches anything else (OOM, huge allocations). */
const JOB_TIMEOUT_MS = 30_000;

function request(worker: Worker, msg: WorkerIn, match: (o: WorkerOut) => boolean, timeoutMs = JOB_TIMEOUT_MS): Promise<WorkerOut> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker watchdog: no answer in ${timeoutMs / 1000} s`));
    }, timeoutMs);
    const onMsg = (ev: MessageEvent<WorkerOut>) => {
      if (ev.data.type === 'error') {
        cleanup();
        reject(new Error(ev.data.message));
      } else if (match(ev.data)) {
        cleanup();
        resolve(ev.data);
      }
    };
    const onErr = (ev: ErrorEvent) => {
      cleanup();
      reject(new Error(ev.message || 'worker crashed'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage(msg);
  });
}

let validator: Worker | null = null;
let validateSeq = 0;

/** Runs the smoke validation in a dedicated worker (re-created if it hangs). */
export async function validateInWorker(code: string, rules: RuleSet): Promise<ValidationReport> {
  validator ??= spawnSimWorker();
  const id = ++validateSeq;
  try {
    const out = await request(validator, { type: 'validate', id, code, rules }, (o) => o.type === 'validated' && o.id === id);
    return (out as Extract<WorkerOut, { type: 'validated' }>).report;
  } catch (e) {
    validator.terminate();
    validator = null;
    const msg = (e as Error).message;
    return { ok: false, compileError: null, decisions: 0, errors: 1, timeouts: 0, disabled: true, messages: [msg], text: `Validation crashed: ${msg}` };
  }
}

/** Re-simulates a replay in a worker and compares the final state hash. */
export async function verifyInWorker(replay: Replay): Promise<{ ok: boolean; error?: string }> {
  validator ??= spawnSimWorker();
  const id = ++validateSeq;
  try {
    const out = await request(validator, { type: 'verify', id, replay }, (o) => o.type === 'verified' && o.id === id, 120_000);
    return { ok: (out as Extract<WorkerOut, { type: 'verified' }>).ok };
  } catch (e) {
    validator.terminate();
    validator = null;
    return { ok: false, error: (e as Error).message };
  }
}

/** Bradley-Terry + bootstrap off the UI thread. */
export async function leaderboardInWorker(strategies: string[], matches: MatchSummary[], anchor: string | null, resamples = 1000): Promise<Leaderboard> {
  const w = spawnSimWorker();
  try {
    const out = await request(w, { type: 'leaderboard', id: 0, strategies, matches, anchor, resamples }, (o) => o.type === 'leaderboard-done', 300_000);
    return (out as Extract<WorkerOut, { type: 'leaderboard-done' }>).leaderboard;
  } finally {
    w.terminate();
  }
}

export interface BenchProgress {
  done: number;
  total: number;
  failed: number;
}

/** Runs tournament jobs on a pool of workers. */
export class BenchPool {
  private workers: Worker[] = [];
  private cancelled = false;

  constructor(private size = Math.max(1, (navigator.hardwareConcurrency || 4) - 1)) {}

  cancel() {
    this.cancelled = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  async run(
    jobs: MatchJob[],
    rules: RuleSet,
    sources: Record<string, string>,
    keepActions: boolean,
    onResult: (s: MatchSummary) => void,
    onProgress: (p: BenchProgress) => void,
  ): Promise<{ failed: Array<{ job: MatchJob; error: string }> }> {
    const queue = [...jobs];
    const failed: Array<{ job: MatchJob; error: string }> = [];
    let done = 0;
    const init = async () => {
      const w = spawnSimWorker();
      await request(w, { type: 'bench-init', rules, sources }, (o) => o.type === 'bench-ready');
      return w;
    };
    const lane = async (slot: number) => {
      let w = await init();
      this.workers[slot] = w;
      while (queue.length && !this.cancelled) {
        const job = queue.shift()!;
        try {
          const out = await request(w, { type: 'bench-job', job, keepActions }, (o) => o.type === 'bench-result');
          onResult((out as Extract<WorkerOut, { type: 'bench-result' }>).summary);
        } catch (e) {
          if (this.cancelled) break;
          failed.push({ job, error: (e as Error).message });
          w.terminate();
          w = await init();
          this.workers[slot] = w;
        }
        done++;
        onProgress({ done, total: jobs.length, failed: failed.length });
      }
      w.terminate();
    };
    await Promise.all(Array.from({ length: Math.min(this.size, jobs.length) }, (_, i) => lane(i)));
    return { failed };
  }
}

/** Live arena match in its own worker. */
export class ArenaClient {
  private worker = spawnSimWorker();

  start(msg: Extract<WorkerIn, { type: 'arena-start' }>) {
    return request(this.worker, msg, (o) => o.type === 'arena-ready') as Promise<Extract<WorkerOut, { type: 'arena-ready' }>>;
  }

  step(ticks: number) {
    return request(this.worker, { type: 'arena-step', ticks }, (o) => o.type === 'arena-frame') as Promise<Extract<WorkerOut, { type: 'arena-frame' }>>;
  }

  dispose() {
    this.worker.terminate();
  }
}
