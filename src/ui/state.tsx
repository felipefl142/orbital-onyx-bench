import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Replay } from '../sim/replay';
import { activeRuleset, getSetting, setSetting, type RulesetRecord } from '../store/db';

export type Tab = 'arena' | 'lab' | 'bench' | 'replays' | 'rules';

export interface ArenaSettings {
  seed: number;
  planets: number;
  orbits: boolean;
  strategyIds: string[];
}

export interface Status {
  tick?: number;
  t?: number;
  fps?: number;
  queue?: number;
  speed?: number;
  running?: boolean;
}

/** One-shot requests from the command line to a screen; `nonce` changes on every request. */
export type ArenaRequest = { kind: 'run' } | { kind: 'replay'; replay: Replay; title: string };
export type ArenaSignal = ArenaRequest & { nonce: number };

interface Ctx {
  tab: Tab;
  setTab: (t: Tab) => void;
  arena: ArenaSettings;
  setArena: (p: Partial<ArenaSettings>) => void;
  status: Status;
  patchStatus: (p: Partial<Status>) => void;
  ruleset: RulesetRecord | null;
  reloadRuleset: () => Promise<void>;
  arenaSignal: ArenaSignal | null;
  signalArena: (s: ArenaRequest) => void;
  benchNonce: number;
  signalBench: () => void;
}

const AppContext = createContext<Ctx | null>(null);

const DEFAULT_ARENA: ArenaSettings = { seed: 42, planets: 3, orbits: false, strategyIds: ['ref:turret', 'ref:hunter'] };

export function AppProvider({ children }: { children: ReactNode }) {
  const [tab, setTabState] = useState<Tab>('arena');
  const [arena, setArenaState] = useState<ArenaSettings>(DEFAULT_ARENA);
  const [status, setStatus] = useState<Status>({});
  const [ruleset, setRuleset] = useState<RulesetRecord | null>(null);
  const [arenaSignal, setArenaSignal] = useState<ArenaSignal | null>(null);
  const [benchNonce, setBenchNonce] = useState(0);

  useEffect(() => {
    getSetting<ArenaSettings>('arena', DEFAULT_ARENA).then((a) => setArenaState({ ...DEFAULT_ARENA, ...a }));
    getSetting<Tab>('tab', 'arena').then(setTabState);
  }, []);

  const reloadRuleset = useCallback(async () => setRuleset(await activeRuleset()), []);
  useEffect(() => {
    reloadRuleset();
  }, [reloadRuleset]);

  const value = useMemo<Ctx>(
    () => ({
      tab,
      setTab: (t) => {
        setTabState(t);
        setSetting('tab', t);
      },
      arena,
      setArena: (p) =>
        setArenaState((cur) => {
          const next = { ...cur, ...p };
          setSetting('arena', next);
          return next;
        }),
      status,
      patchStatus: (p) => setStatus((s) => ({ ...s, ...p })),
      ruleset,
      reloadRuleset,
      arenaSignal,
      signalArena: (s) => setArenaSignal({ ...s, nonce: Date.now() + Math.random() }),
      benchNonce,
      signalBench: () => setBenchNonce((n) => n + 1),
    }),
    [tab, arena, status, ruleset, reloadRuleset, arenaSignal, benchNonce],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}
