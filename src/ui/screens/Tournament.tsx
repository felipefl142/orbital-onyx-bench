import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { leaderboardCsv } from '../../bench/metrics';
import type { MatchSummary } from '../../bench/runner';
import { buildSchedule, DEFAULT_TOURNAMENT, seedList, type TournamentConfig } from '../../bench/schedule';
import { APP_VERSION, replayFromSummary } from '../../sim/replay';
import { db, getSetting, setSetting, uid, type StrategyRecord, type TournamentRecord } from '../../store/db';
import { BenchPool, leaderboardInWorker } from '../../workers/client';
import { download, fmt, Panel, pct, pickFile } from '../components/ui';
import { useApp } from '../state';

export function TournamentScreen() {
  const app = useApp();
  const { ruleset } = app;
  const strategies = useLiveQuery(() => db.strategies.orderBy('createdAt').filter((s) => !s.archived).toArray(), []) ?? [];
  const history = useLiveQuery(() => db.tournaments.orderBy('createdAt').reverse().toArray(), []) ?? [];

  const [cfg, setCfg] = useState<TournamentConfig>(DEFAULT_TOURNAMENT);
  const [planetText, setPlanetText] = useState(DEFAULT_TOURNAMENT.planetCounts.join(','));
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [anchor, setAnchor] = useState<string>('ref:idle');
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number; startedAt: number } | null>(null);
  const [phase, setPhase] = useState<'idle' | 'running' | 'rating'>('idle');
  const [viewId, setViewId] = useState<string | null>(null);
  const poolRef = useRef<BenchPool | null>(null);

  useEffect(() => {
    getSetting<TournamentConfig>('tournament', DEFAULT_TOURNAMENT).then((c) => {
      setCfg({ ...DEFAULT_TOURNAMENT, ...c });
      setPlanetText((c.planetCounts ?? DEFAULT_TOURNAMENT.planetCounts).join(','));
    });
  }, []);

  const ids = chosen ?? strategies.map((s) => s.id);
  const jobsCount = useMemo(() => (ids.length >= 2 ? buildSchedule(cfg, ids).length : 0), [cfg, ids]);

  const start = async () => {
    if (!ruleset || ids.length < 2 || phase !== 'idle') return;
    await setSetting('tournament', cfg);
    const sel = ids.map((id) => strategies.find((s) => s.id === id)!).filter(Boolean);
    const jobs = buildSchedule(cfg, sel.map((s) => s.id));
    const rec: TournamentRecord = {
      id: uid(),
      createdAt: new Date().toISOString(),
      status: 'running',
      config: cfg,
      rulesetHash: ruleset.hash,
      strategies: sel.map((s) => ({ id: s.id, name: s.name, sha256: s.sha256 })),
      anchor: sel.some((s) => s.id === anchor) ? anchor : null,
      totalJobs: jobs.length,
      matches: [],
      leaderboard: null,
    };
    await db.tournaments.put(rec);
    setViewId(rec.id);
    setPhase('running');
    const pool = new BenchPool();
    poolRef.current = pool;
    const results: MatchSummary[] = [];
    const t0 = Date.now();
    setProgress({ done: 0, total: jobs.length, failed: 0, startedAt: t0 });
    const { failed } = await pool.run(
      jobs,
      ruleset.rules,
      Object.fromEntries(sel.map((s) => [s.id, s.code])),
      cfg.keepReplays,
      (s) => results.push(s),
      (p) => {
        setProgress({ ...p, startedAt: t0 });
        app.patchStatus({ queue: p.total - p.done });
      },
    );
    app.patchStatus({ queue: 0 });
    const cancelled = poolRef.current === null;
    results.sort((a, b) => a.jobId - b.jobId);
    setPhase('rating');
    const leaderboard = results.length ? await leaderboardInWorker(rec.strategies.map((s) => s.id), results, rec.anchor, 1000) : null;
    await db.tournaments.update(rec.id, { status: cancelled ? 'cancelled' : 'done', matches: results, leaderboard });
    if (failed.length) console.warn('failed jobs', failed);
    setPhase('idle');
    poolRef.current = null;
  };

  // `/bench` from the command line.
  useEffect(() => {
    if (app.benchNonce > 0) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.benchNonce]);

  const cancel = () => {
    const p = poolRef.current;
    poolRef.current = null;
    p?.cancel();
  };

  const view = history.find((t) => t.id === viewId) ?? history.find((t) => t.status !== 'running') ?? null;
  const elapsed = progress ? (Date.now() - progress.startedAt) / 1000 : 0;
  const eta = progress && progress.done ? (elapsed / progress.done) * (progress.total - progress.done) : NaN;

  const importResults = async () => {
    const text = await pickFile();
    if (!text) return;
    try {
      const j = JSON.parse(text);
      if (j.format !== 'orbital-onyx-results') throw new Error('não é um arquivo de resultados do Orbital Onyx');
      const rec: TournamentRecord = {
        id: uid(),
        createdAt: j.createdAt ?? new Date().toISOString(),
        status: 'done',
        config: j.tournament,
        rulesetHash: j.rulesetHash,
        strategies: j.strategies.map((s: { id: string; sha256: string }) => ({ id: s.id, name: s.id, sha256: s.sha256 })),
        anchor: j.anchor ?? null,
        totalJobs: j.matches.length,
        matches: j.matches,
        leaderboard: j.leaderboard,
      };
      if (!(await db.rulesets.get(j.rulesetHash))) await db.rulesets.put({ hash: j.rulesetHash, rules: j.ruleset, createdAt: new Date().toISOString() });
      await db.tournaments.put(rec);
      setViewId(rec.id);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="col">
      <Panel title="torneio">
        <div className="row edit-only">
          <label>
            formato{' '}
            <select value={cfg.format} onChange={(e) => setCfg({ ...cfg, format: e.target.value as '1v1' | 'ffa' })}>
              <option value="1v1">1v1 round-robin</option>
              <option value="ffa">FFA</option>
            </select>
          </label>
          {cfg.format === 'ffa' && (
            <label>
              naves <input type="number" min={3} max={8} value={cfg.ffaSize} onChange={(e) => setCfg({ ...cfg, ffaSize: Number(e.target.value) })} style={{ width: '4em' }} />
            </label>
          )}
          <label>
            seeds <input type="number" min={1} value={cfg.seeds} onChange={(e) => setCfg({ ...cfg, seeds: Math.max(1, Number(e.target.value) | 0) })} style={{ width: '5em' }} />
          </label>
          <label>
            seed base <input type="number" value={cfg.baseSeed} onChange={(e) => setCfg({ ...cfg, baseSeed: Number(e.target.value) | 0 })} style={{ width: '9em' }} />
          </label>
          <label>
            planetas{' '}
            <input
              value={planetText}
              onChange={(e) => {
                setPlanetText(e.target.value);
                const list = e.target.value
                  .split(',')
                  .map((x) => Number(x.trim()))
                  .filter((x) => x >= 1 && x <= 12);
                if (list.length) setCfg({ ...cfg, planetCounts: list });
              }}
              style={{ width: '9em' }}
            />
          </label>
          <label>
            <input type="checkbox" checked={cfg.orbits} onChange={(e) => setCfg({ ...cfg, orbits: e.target.checked })} /> órbitas
          </label>
          <label title="guarda as ações de todas as partidas para abrir qualquer uma como replay (arquivo maior)">
            <input type="checkbox" checked={cfg.keepReplays} onChange={(e) => setCfg({ ...cfg, keepReplays: e.target.checked })} /> guardar replays
          </label>
          <label>
            âncora (Elo 0){' '}
            <select value={anchor} onChange={(e) => setAnchor(e.target.value)}>
              <option value="">média</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {strategies.map((s) => (
            <label key={s.id}>
              <input
                type="checkbox"
                checked={ids.includes(s.id)}
                onChange={(e) => setChosen(e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))}
              />{' '}
              <span className={s.source === 'ref' ? 'dim' : 'gold'}>{s.name}</span>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" onClick={start} disabled={phase !== 'idle' || ids.length < 2}>
            ▶ rodar {jobsCount} partidas
          </button>
          <button onClick={cancel} disabled={phase !== 'running'}>
            ■ cancelar
          </button>
          <button onClick={importResults} className="edit-only">
            ⤒ importar resultados (CLI)
          </button>
          {progress && (
            <span>
              <ProgressBar done={progress.done} total={progress.total} /> {progress.done}/{progress.total}{' '}
              <span className="muted">
                · {fmt(progress.done / Math.max(elapsed, 0.001), 0)} partidas/s · ETA {Number.isFinite(eta) ? `${fmt(eta)} s` : '—'}
                {progress.failed > 0 && <span className="err"> · {progress.failed} falharam</span>}
                {phase === 'rating' && <span className="gold"> · calculando ranking (bootstrap)…</span>}
              </span>
            </span>
          )}
        </div>
      </Panel>

      {view && <TournamentView t={view} strategies={strategies} />}

      <Panel title="histórico">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>data</th>
                <th>formato</th>
                <th className="num">estratégias</th>
                <th className="num">partidas</th>
                <th>ruleset</th>
                <th>status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {history.map((t) => (
                <tr key={t.id} className={t.id === view?.id ? 'sel' : ''}>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                  <td>
                    {t.config.format} · {t.config.seeds} seeds · [{t.config.planetCounts.join(',')}]
                  </td>
                  <td className="num">{t.strategies.length}</td>
                  <td className="num">{t.matches.length || t.totalJobs}</td>
                  <td className="muted">{t.rulesetHash.slice(0, 10)}</td>
                  <td className={t.status === 'done' ? 'ok' : 'warn'}>{t.status}</td>
                  <td>
                    <button onClick={() => setViewId(t.id)}>ver</button>{' '}
                    <button className="danger" onClick={() => confirm('Apagar este torneio?') && db.tournaments.delete(t.id)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function ProgressBar({ done, total, width = 24 }: { done: number; total: number; width?: number }) {
  const n = total ? Math.round((done / total) * width) : 0;
  return (
    <span className="bar gold">
      {'█'.repeat(n)}
      <span className="muted">{'░'.repeat(width - n)}</span>
    </span>
  );
}

function TournamentView({ t, strategies }: { t: TournamentRecord; strategies: StrategyRecord[] }) {
  const app = useApp();
  const lb = t.leaderboard;
  const name = (id: string) => t.strategies.find((s) => s.id === id)?.name ?? id;
  const strat = (id: string) => strategies.find((s) => s.id === id);
  const [showMatches, setShowMatches] = useState(false);

  const exportJson = async () => {
    const rules = (await db.rulesets.get(t.rulesetHash))?.rules ?? null;
    const payload = {
      format: 'orbital-onyx-results',
      app: APP_VERSION,
      createdAt: t.createdAt,
      ruleset: rules,
      rulesetHash: t.rulesetHash,
      tournament: t.config,
      seeds: seedList(t.config),
      anchor: t.anchor,
      strategies: t.strategies.map((s) => {
        const g = strat(s.id)?.generation;
        return {
          id: s.id,
          name: s.name,
          sha256: s.sha256,
          source: strat(s.id)?.source ?? null,
          generation: g
            ? { model: g.model, provider: g.provider.kind, promptId: g.promptId, promptHash: g.promptHash, params: g.params, repairs: g.repairs, inputTokens: g.inputTokens, outputTokens: g.outputTokens, latencyMs: g.latencyMs }
            : null,
        };
      }),
      leaderboard: lb,
      matches: t.matches,
    };
    download(`orbital-onyx-${t.createdAt.slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(payload, null, 1));
  };

  const exportCsv = () => {
    if (!lb) return;
    const csv = leaderboardCsv(lb, (id) => {
      const g = strat(id)?.generation;
      return { name: name(id), sha256: t.strategies.find((s) => s.id === id)?.sha256 ?? '', repairs: g?.repairs ?? '', tokens: g ? g.inputTokens + g.outputTokens : '' };
    });
    download(`orbital-onyx-${t.createdAt.slice(0, 10)}.csv`, csv, 'text/csv');
  };

  const openMatch = async (m: MatchSummary) => {
    const rules = (await db.rulesets.get(t.rulesetHash))?.rules;
    if (!rules || !m.actions) return;
    const replay = replayFromSummary(
      m,
      rules,
      t.rulesetHash,
      m.ships.map((s) => name(s.strategy)),
      m.ships.map((s) => t.strategies.find((x) => x.id === s.strategy)?.sha256 ?? ''),
      t.createdAt,
    );
    app.setTab('arena');
    app.signalArena({ kind: 'replay', replay, title: `${replay.names.join(' vs ')} · seed ${m.map.seed} · ${m.map.planets}p` });
  };

  if (!lb) {
    return (
      <Panel title="resultado">
        <span className="muted">{t.status === 'running' ? 'rodando…' : 'sem resultado'}</span>
      </Panel>
    );
  }

  const ids = lb.rows.map((r) => r.strategy);
  return (
    <>
      <Panel
        title={`ranking · ${lb.matches} partidas · ruleset ${t.rulesetHash.slice(0, 10)}`}
        actions={
          <>
            <button onClick={exportJson}>⤓ JSON</button>
            <button onClick={exportCsv}>⤓ CSV</button>
          </>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>estratégia</th>
                <th className="num">Elo</th>
                <th>IC 95%</th>
                <th className="num">vitória</th>
                <th>IC 95%</th>
                <th className="num">V/E/D</th>
                <th className="num">sobrev. s</th>
                <th className="num">morte planeta</th>
                <th className="num">precisão</th>
                <th className="num">dano/fuel</th>
                <th className="num">falhas/1k</th>
                <th className="num">desligada</th>
                <th className="num">reparos</th>
                <th className="num">tokens</th>
              </tr>
            </thead>
            <tbody>
              {lb.rows.map((r, i) => {
                const g = strat(r.strategy)?.generation;
                return (
                  <tr key={r.strategy}>
                    <td className="num gold">{i + 1}</td>
                    <td className={strat(r.strategy)?.source === 'ref' ? 'dim' : 'gold'}>{name(r.strategy)}</td>
                    <td className="num gold">{fmt(r.elo)}</td>
                    <td className="muted">
                      [{fmt(r.eloLo)}, {fmt(r.eloHi)}]
                    </td>
                    <td className="num">{pct(r.winRate)}</td>
                    <td className="muted">
                      [{pct(r.winLo, 0)}, {pct(r.winHi, 0)}]
                    </td>
                    <td className="num">
                      {r.wins}/{r.draws}/{r.losses}
                    </td>
                    <td className="num">{fmt(r.survivalMean, 1)}</td>
                    <td className="num">{pct(r.planetDeathRate)}</td>
                    <td className="num">{pct(r.accuracy)}</td>
                    <td className="num">{fmt(r.efficiency, 2)}</td>
                    <td className={`num ${r.faultsPer1k > 0 ? 'warn' : ''}`}>{fmt(r.faultsPer1k, 2)}</td>
                    <td className="num">{pct(r.disabledRate, 0)}</td>
                    <td className="num">{g ? g.repairs : '—'}</td>
                    <td className="num">{g ? g.inputTokens + g.outputTokens : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Elo = Bradley-Terry (escala 400·log10), {t.anchor ? `âncora ${name(t.anchor)} = 0` : 'média = 0'}, IC por bootstrap de 1000 reamostras por partida. Vitória conta empate como meia vitória (IC de
          Wilson). Seeds: base {t.config.baseSeed}, {t.config.seeds} por confronto, planetas [{t.config.planetCounts.join(', ')}]{t.config.orbits ? ', órbitas' : ''}.
        </p>
      </Panel>

      <div className="split">
        <Panel title="confronto direto (pontuação da linha contra a coluna)">
          <div className="table-wrap">
            <table className="heat">
              <thead>
                <tr>
                  <th></th>
                  {ids.map((id) => (
                    <th key={id} className="num" title={name(id)}>
                      {name(id).slice(0, 8)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ids.map((a) => (
                  <tr key={a}>
                    <th>{name(a)}</th>
                    {ids.map((b) => {
                      if (a === b) return <td key={b} className="cell muted">·</td>;
                      const c = lb.headToHead[a]?.[b];
                      const s = c && c.games ? c.score / c.games : NaN;
                      const bg = Number.isNaN(s)
                        ? 'transparent'
                        : s >= 0.5
                          ? `color-mix(in srgb, var(--ok) ${Math.round((s - 0.5) * 200)}%, var(--muted))`
                          : `color-mix(in srgb, var(--error) ${Math.round((0.5 - s) * 200)}%, var(--muted))`;
                      return (
                        <td key={b} className="cell" style={{ background: bg }} title={`${c?.games ?? 0} jogos`}>
                          {Number.isNaN(s) ? '—' : s.toFixed(2)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="parâmetros de geração">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>estratégia</th>
                  <th>prompt</th>
                  <th className="num">temp</th>
                  <th className="num">máx tok</th>
                  <th className="num">reparos máx</th>
                  <th>sha256</th>
                </tr>
              </thead>
              <tbody>
                {t.strategies.map((s) => {
                  const g = strat(s.id)?.generation;
                  return (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td className="muted">{g ? `${g.promptId} · ${g.promptHash.slice(0, 8)}` : '—'}</td>
                      <td className="num">{g?.params.temperature ?? '—'}</td>
                      <td className="num">{g?.params.maxTokens ?? '—'}</td>
                      <td className="num">{g?.params.maxRepairs ?? '—'}</td>
                      <td className="muted">{s.sha256.slice(0, 12)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel title="partidas" actions={<button onClick={() => setShowMatches(!showMatches)}>{showMatches ? 'esconder' : 'mostrar'}</button>}>
        {!showMatches ? (
          <span className="muted">
            {t.matches.length} partidas{t.config.keepReplays ? ' (com replays)' : ' (sem replays: marque “guardar replays” para abrir partidas na Arena)'}
          </span>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 400 }}>
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>naves</th>
                  <th className="num">seed</th>
                  <th className="num">planetas</th>
                  <th>vencedor</th>
                  <th>fim</th>
                  <th className="num">t</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {t.matches.slice(0, 500).map((m) => (
                  <tr key={m.jobId}>
                    <td className="num muted">{m.jobId}</td>
                    <td>{m.ships.map((s) => name(s.strategy)).join(' vs ')}</td>
                    <td className="num">{m.map.seed}</td>
                    <td className="num">{m.map.planets}</td>
                    <td className={m.winner === null ? 'warn' : 'gold'}>{m.winner === null ? 'empate' : name(m.ships[m.winner].strategy)}</td>
                    <td className="muted">{m.reason}</td>
                    <td className="num">{fmt(m.duration, 1)}</td>
                    <td>{m.actions && <button onClick={() => openMatch(m)}>▶ ver</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
