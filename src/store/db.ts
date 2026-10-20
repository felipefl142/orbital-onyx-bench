import Dexie, { type Table } from 'dexie';
import type { Leaderboard } from '../bench/metrics';
import type { MatchSummary } from '../bench/runner';
import type { TournamentConfig } from '../bench/schedule';
import type { GenerationRecord } from '../llm/generate';
import type { ModelConfig, ProviderConfig } from '../llm/providers';
import { sha256 } from '../sim/hash';
import type { Replay } from '../sim/replay';
import { BUILTIN_RULESETS, DEFAULT_RULESET, rulesetHash, type RuleSet } from '../sim/ruleset';
import { BUNDLED_STRATEGIES } from '../strategies/bundled';
import { REFERENCE_STRATEGIES } from '../strategies/refs';

export interface StrategyRecord {
  id: string;
  /** Display name, e.g. "qwen3-coder@v2". */
  name: string;
  source: 'ref' | 'llm' | 'manual';
  /** Model label for llm strategies. */
  model: string | null;
  version: number;
  parentId: string | null;
  code: string;
  sha256: string;
  createdAt: string;
  generation: GenerationRecord | null;
  archived?: boolean;
}

export interface RulesetRecord {
  hash: string;
  rules: RuleSet;
  createdAt: string;
}

export interface TournamentRecord {
  id: string;
  createdAt: string;
  status: 'running' | 'done' | 'cancelled';
  config: TournamentConfig;
  rulesetHash: string;
  strategies: Array<{ id: string; name: string; sha256: string }>;
  anchor: string | null;
  totalJobs: number;
  matches: MatchSummary[];
  leaderboard: Leaderboard | null;
}

export interface ReplayRecord {
  id: string;
  createdAt: string;
  title: string;
  replay: Replay;
  verified: boolean | null;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

class OnyxDB extends Dexie {
  strategies!: Table<StrategyRecord, string>;
  providers!: Table<ProviderConfig, string>;
  models!: Table<ModelConfig, string>;
  rulesets!: Table<RulesetRecord, string>;
  tournaments!: Table<TournamentRecord, string>;
  replays!: Table<ReplayRecord, string>;
  settings!: Table<SettingRecord, string>;

  constructor() {
    super('orbital-onyx-bench');
    this.version(1).stores({
      strategies: 'id, name, source, model, createdAt',
      providers: 'id, name',
      models: 'id, providerId, label',
      rulesets: 'hash, createdAt',
      tournaments: 'id, createdAt, status',
      replays: 'id, createdAt',
      settings: 'key',
    });
  }
}

export const db = new OnyxDB();

/** UUID v4. `crypto.randomUUID` is missing on plain-http non-localhost pages; `getRandomValues` is not. */
export const uid = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export async function getSetting<T>(key: string, def: T): Promise<T> {
  const r = await db.settings.get(key);
  return r ? (r.value as T) : def;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

/** Seeds reference strategies and the default ruleset; refreshes reference code if it changed. */
export async function initDb(): Promise<void> {
  for (const r of REFERENCE_STRATEGIES) {
    const hash = await sha256(r.code);
    const cur = await db.strategies.get(r.id);
    if (!cur || cur.sha256 !== hash) {
      await db.strategies.put({
        id: r.id,
        name: r.name,
        source: 'ref',
        model: null,
        version: 1,
        parentId: null,
        code: r.code,
        sha256: hash,
        createdAt: cur?.createdAt ?? new Date().toISOString(),
        generation: null,
      });
    }
  }
  // Strategies from the repository's strategies/ folder: one record per file, refreshed when the file changes.
  for (const b of BUNDLED_STRATEGIES) {
    const id = `file:${b.file}`;
    const hash = await sha256(b.code);
    const cur = await db.strategies.get(id);
    if (cur && cur.sha256 === hash) continue;
    await db.strategies.put({
      id,
      name: b.file,
      source: b.generation ? 'llm' : 'manual',
      model: b.generation?.model ?? b.file,
      version: 1,
      parentId: null,
      code: b.code,
      sha256: hash,
      createdAt: cur?.createdAt ?? new Date().toISOString(),
      generation: b.generation,
      archived: cur?.archived,
    });
  }
  for (const r of BUILTIN_RULESETS) {
    const hash = await rulesetHash(r);
    if (!(await db.rulesets.get(hash))) await db.rulesets.put({ hash, rules: r, createdAt: new Date().toISOString() });
  }
  // Move users still on an older built-in ruleset to the current default (once); custom rulesets are left alone.
  const h = await rulesetHash(DEFAULT_RULESET);
  const active = await getSetting<string>('activeRuleset', '');
  const builtinHashes = await Promise.all(BUILTIN_RULESETS.map(rulesetHash));
  if (!active || (builtinHashes.includes(active) && active !== h && !(await getSetting<boolean>(`migrated:${h}`, false)))) {
    await setSetting('activeRuleset', h);
    await setSetting(`migrated:${h}`, true);
  }
}

export async function activeRuleset(): Promise<RulesetRecord> {
  const h = await getSetting<string>('activeRuleset', '');
  const r = (h && (await db.rulesets.get(h))) || null;
  if (r) return r;
  const hash = await rulesetHash(DEFAULT_RULESET);
  return { hash, rules: DEFAULT_RULESET, createdAt: '' };
}

/** Next version number for a model's strategies. */
export async function nextVersion(model: string): Promise<number> {
  const all = await db.strategies.where('model').equals(model).toArray();
  return all.reduce((m, s) => Math.max(m, s.version), 0) + 1;
}
