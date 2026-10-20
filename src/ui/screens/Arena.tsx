import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecisionLog } from '../../sim/match';
import type { Replay } from '../../sim/replay';
import type { Vec } from '../../sim/vec';
import { db, uid } from '../../store/db';
import { ArenaClient, verifyInWorker } from '../../workers/client';
import type { ArenaFrame } from '../../workers/protocol';
import { Bar, fmt, Panel, shipColor, SignedBar } from '../components/ui';
import { ArenaRenderer, type Overlays } from '../render/arenaRenderer';
import { useApp } from '../state';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8, 16];
const DEFAULT_SPEED = SPEEDS.indexOf(1.5);
const TRAIL_SECONDS = 2;

export function ArenaScreen() {
  const app = useApp();
  const { arena, setArena, ruleset } = app;
  const strategies = useLiveQuery(() => db.strategies.orderBy('createdAt').filter((s) => !s.archived).toArray(), []) ?? [];

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ArenaRenderer | null>(null);
  const clientRef = useRef<ArenaClient | null>(null);
  const frames = useRef<{ cur: ArenaFrame | null; prev: ArenaFrame | null }>({ cur: null, prev: null });
  const trails = useRef<Vec[][]>([]);
  const acc = useRef(0);
  const pending = useRef(false);
  const stepOnce = useRef(0);
  const namesRef = useRef<string[]>([]);

  const [names, setNames] = useState<string[]>([]);
  const [frame, setFrame] = useState<ArenaFrame | null>(null);
  const [running, setRunning] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(DEFAULT_SPEED);
  const [ov, setOv] = useState<Overlays>({ trails: true, prediction: false, field: false, contours: true, labels: true });
  const [log, setLog] = useState<DecisionLog[]>([]);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [mode, setMode] = useState<{ kind: 'live' } | { kind: 'replay'; title: string; verified: boolean | null }>({ kind: 'live' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const runningRef = useRef(running);
  runningRef.current = running;
  const speedRef = useRef(SPEEDS[speedIdx]);
  speedRef.current = SPEEDS[speedIdx];
  const ovRef = useRef(ov);
  ovRef.current = ov;

  const resetView = (f: ArenaFrame) => {
    frames.current = { cur: f, prev: null };
    trails.current = f.ships.map(() => []);
    acc.current = 0;
    setFrame(f);
    setLog([]);
    setReplay(null);
    setSaved(false);
  };

  const start = useCallback(
    async (opts?: { replay?: Replay; title?: string }) => {
      if (!ruleset) return;
      setError(null);
      clientRef.current?.dispose();
      const client = new ArenaClient();
      clientRef.current = client;
      pending.current = false;
      try {
        let ready;
        if (opts?.replay) {
          const r = opts.replay;
          namesRef.current = r.names;
          ready = await client.start({ type: 'arena-start', rules: r.rules, map: r.map, names: r.names, sources: [], rulesetHash: r.rulesetHash, strategyHashes: r.strategyHashes, replay: r });
          setMode({ kind: 'replay', title: opts.title ?? 'replay', verified: null });
        } else {
          const chosen = arena.strategyIds.map((id) => strategies.find((s) => s.id === id)).filter((s) => !!s);
          if (chosen.length < 2) throw new Error('escolha pelo menos 2 estratégias');
          namesRef.current = chosen.map((s) => s.name);
          ready = await client.start({
            type: 'arena-start',
            rules: ruleset.rules,
            map: { seed: arena.seed, planets: arena.planets, ships: chosen.length, orbits: arena.orbits },
            names: chosen.map((s) => s.name),
            sources: chosen.map((s) => s.code),
            rulesetHash: ruleset.hash,
            strategyHashes: chosen.map((s) => s.sha256),
          });
          setMode({ kind: 'live' });
        }
        if (clientRef.current !== client) return;
        setNames(namesRef.current);
        rendererRef.current?.setRules(ready.rules);
        resetView(ready.frame);
        setRunning(true);
      } catch (e) {
        setError((e as Error).message);
        setRunning(false);
      }
    },
    [arena, ruleset, strategies],
  );

  // Command-line / other-screen requests.
  useEffect(() => {
    const s = app.arenaSignal;
    if (!s || !ruleset) return;
    if (s.kind === 'run') start();
    else start({ replay: s.replay, title: s.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.arenaSignal?.nonce, ruleset?.hash]);

  useEffect(() => () => clientRef.current?.dispose(), []);

  // Render + stepping loop.
  useEffect(() => {
    const canvas = canvasRef.current!;
    rendererRef.current = new ArenaRenderer(canvas);
    if (ruleset) rendererRef.current.setRules(ruleset.rules);
    let raf = 0;
    let last = performance.now();
    let fpsCount = 0;
    let fpsT = last;
    let statusT = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dtReal = Math.min(0.1, (now - last) / 1000);
      last = now;
      fpsCount++;
      const { cur, prev } = frames.current;
      const client = clientRef.current;
      const rulesDt = 1 / 120;
      if (client && cur && !cur.result) {
        if (runningRef.current) acc.current += (dtReal * speedRef.current) / rulesDt;
        let want = Math.floor(acc.current);
        if (stepOnce.current > 0) {
          want = Math.max(want, stepOnce.current);
          stepOnce.current = 0;
        }
        if (!pending.current && want >= 1) {
          acc.current -= want;
          if (acc.current > 4) acc.current = 4;
          pending.current = true;
          client
            .step(Math.min(want, 2400))
            .then(({ frame: f }) => {
              if (clientRef.current !== client) return;
              pending.current = false;
              frames.current = { prev: frames.current.cur, cur: f };
              const keep = Math.round(TRAIL_SECONDS * 30);
              f.ships.forEach((s, i) => {
                const tr = (trails.current[i] ??= []);
                if (s.alive) tr.push({ x: s.pos.x, y: s.pos.y });
                else tr.length = 0;
                if (tr.length > keep) tr.splice(0, tr.length - keep);
              });
              rendererRef.current?.addEvents(f.events, f.t);
              if (f.log.length) setLog((l) => [...l, ...f.log].slice(-60));
              if (f.replay) setReplay(f.replay);
              if (f.result) {
                setRunning(false);
                app.patchStatus({ running: false, tick: f.tick, t: f.t });
              }
              setFrame(f);
            })
            .catch((e) => {
              pending.current = false;
              setError((e as Error).message);
              setRunning(false);
            });
        }
      }
      if (cur) {
        const alpha = speedRef.current < 1 ? Math.min(1, acc.current) : 1;
        rendererRef.current?.draw(cur, prev, alpha, trails.current, namesRef.current, ovRef.current);
      }
      if (now - fpsT > 1000) {
        const fps = (fpsCount * 1000) / (now - fpsT);
        fpsCount = 0;
        fpsT = now;
        if (now - statusT > 900) {
          statusT = now;
          app.patchStatus({ fps: Math.round(fps), tick: frames.current.cur?.tick, t: frames.current.cur?.t, speed: speedRef.current, running: runningRef.current });
        }
      }
    };
    raf = requestAnimationFrame(loop);
    const mq = new MutationObserver(() => rendererRef.current?.refreshPalette());
    mq.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      cancelAnimationFrame(raf);
      mq.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ruleset && !frames.current.cur) rendererRef.current?.setRules(ruleset.rules);
  }, [ruleset]);

  // Keyboard: space = play/pause, . = step, +/- = speed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (!frames.current.cur || frames.current.cur.result) start();
        else setRunning((r) => !r);
      } else if (e.key === '.') {
        setRunning(false);
        stepOnce.current = 6;
      } else if (e.key === '+' || e.key === '=') setSpeedIdx((i) => Math.min(SPEEDS.length - 1, i + 1));
      else if (e.key === '-') setSpeedIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start]);

  const setShip = (i: number, id: string) => {
    const ids = [...arena.strategyIds];
    ids[i] = id;
    setArena({ strategyIds: ids });
  };

  const saveReplay = async () => {
    if (!replay) return;
    const title = `${replay.names.join(' vs ')} · seed ${replay.map.seed} · ${replay.map.planets}p`;
    await db.replays.add({ id: uid(), createdAt: new Date().toISOString(), title, replay, verified: null });
    setSaved(true);
  };

  const res = frame?.result;
  return (
    <div className="arena-layout">
      <div className="col" style={{ minWidth: 0 }}>
        <div className="row edit-only">
          {mode.kind === 'replay' ? (
            <span className="label">
              ⟲ replay: <span className="gold">{mode.title}</span>
            </span>
          ) : (
            arena.strategyIds.map((id, i) => (
              <span key={i} className="row" style={{ gap: 4 }}>
                <span style={{ color: shipColor(i) }}>▲</span>
                <select value={id} onChange={(e) => setShip(i, e.target.value)}>
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {arena.strategyIds.length > 2 && (
                  <button title="remover nave" onClick={() => setArena({ strategyIds: arena.strategyIds.filter((_, k) => k !== i) })}>
                    ×
                  </button>
                )}
              </span>
            ))
          )}
          {mode.kind === 'live' && arena.strategyIds.length < 8 && (
            <button onClick={() => setArena({ strategyIds: [...arena.strategyIds, strategies[0]?.id ?? 'ref:idle'] })}>+ nave</button>
          )}
        </div>
        <div className="row">
          <label className="edit-only">
            seed <input type="number" value={arena.seed} onChange={(e) => setArena({ seed: Number(e.target.value) | 0 })} />
          </label>
          <button className="edit-only" title="seed aleatória" onClick={() => setArena({ seed: Math.floor(Math.random() * 1e6) })}>
            ⚄
          </button>
          <label className="edit-only">
            planetas{' '}
            <input type="number" min={1} max={12} value={arena.planets} onChange={(e) => setArena({ planets: Math.max(1, Math.min(12, Number(e.target.value) | 0)) })} style={{ width: '4em' }} />
          </label>
          <label className="edit-only">
            <input type="checkbox" checked={arena.orbits} onChange={(e) => setArena({ orbits: e.target.checked })} /> órbitas
          </label>
          <button className="primary" onClick={() => start()}>
            ▶ nova partida
          </button>
          <button onClick={() => setRunning((r) => !r)} disabled={!frame || !!res}>
            {running ? '❚❚ pausa' : '▶ continuar'}
          </button>
          <button
            onClick={() => {
              setRunning(false);
              stepOnce.current = 6;
            }}
            disabled={!frame || !!res}
            title="avança uma decisão (tecla .)"
          >
            ⇥ passo
          </button>
          <span className="row" style={{ gap: 4 }}>
            <button onClick={() => setSpeedIdx((i) => Math.max(0, i - 1))}>−</button>
            <span className="gold" style={{ minWidth: '3.5em', textAlign: 'center' }}>
              {SPEEDS[speedIdx]}×
            </span>
            <button onClick={() => setSpeedIdx((i) => Math.min(SPEEDS.length - 1, i + 1))}>+</button>
          </span>
        </div>
        <div className="row edit-only">
          {(
            [
              ['trails', 'rastros'],
              ['prediction', 'trajetória prevista'],
              ['contours', 'curvas de nível'],
              ['field', 'campo'],
              ['labels', 'rótulos'],
            ] as Array<[keyof Overlays, string]>
          ).map(([k, label]) => (
            <label key={k}>
              <input type="checkbox" checked={ov[k]} onChange={(e) => setOv({ ...ov, [k]: e.target.checked })} /> {label}
            </label>
          ))}
        </div>
        <div className="arena-canvas-wrap">
          <canvas ref={canvasRef} />
          {!frame && <div className="arena-overlay-msg">[ espaço ] para começar</div>}
          {res && (
            <div className="arena-overlay-msg">
              {res.winner !== null ? `★ ${names[res.winner]} venceu` : '═ empate ═'}
            </div>
          )}
        </div>
        {error && <div className="err">✗ {error}</div>}
      </div>

      <div className="col" style={{ minWidth: 0 }}>
        {frame?.ships.map((s, i) => (
          <Panel key={i} title={names[i] ?? `ship${i}`} className="ship-card" style={{ borderColor: shipColor(i) }}>
            <div>
              <span className="label">HP   </span>
              <Bar value={s.hp} max={ruleset?.rules.ship.hp ?? 100} color={s.hp > 30 ? 'var(--ok)' : 'var(--error)'} /> {fmt(Math.max(0, s.hp))}
            </div>
            <div>
              <span className="label">fuel </span>
              <Bar value={s.fuel} max={ruleset?.rules.ship.fuelMax ?? 100} color="var(--accent)" /> {fmt(s.fuel)}
            </div>
            <div>
              <span className="label">heat </span>
              <Bar value={s.heat} max={ruleset?.rules.weapon.overheatAt ?? 100} color={s.overheated ? 'var(--error)' : 'var(--warn)'} /> {s.overheated ? <span className="err">LOCK</span> : fmt(s.heat)}
            </div>
            <div>
              <span className="label">ammo </span>
              <span className="gold">{s.ammo}</span> <span className="muted">tiros {s.shots} · acertos {s.hits}</span>
            </div>
            <div>
              <span className="label">thr  </span>
              <Bar value={s.action.thrust} width={5} color="var(--title)" /> <span className="label">turn </span>
              <SignedBar value={s.action.turn} /> <span className={s.action.fire ? 'gold' : 'muted'}>{s.action.fire ? '●' : '○'}</span>
            </div>
            {!s.alive && <div className="err">✗ destruída ({s.deathCause})</div>}
            {(s.errors > 0 || s.timeouts > 0 || s.disabled) && (
              <div className="warn">
                erros {s.errors} · timeouts {s.timeouts} {s.disabled && <span className="err">· DESLIGADA</span>}
              </div>
            )}
          </Panel>
        ))}
        {res && (
          <Panel title="resultado">
            <div>
              {res.winner !== null ? (
                <span className="gold">★ {names[res.winner]}</span>
              ) : (
                <span className="warn">empate</span>
              )}{' '}
              <span className="muted">
                · {res.reason} · {fmt(res.duration, 1)} s
              </span>
            </div>
            <div className="muted">hash {res.finalHash}</div>
            <div className="row" style={{ marginTop: 6 }}>
              {mode.kind === 'live' && replay && (
                <button onClick={saveReplay} disabled={saved}>
                  {saved ? '✓ replay salvo' : '⤓ salvar replay'}
                </button>
              )}
              {mode.kind === 'replay' && (
                <ReplayCheck
                  expected={app.arenaSignal?.kind === 'replay' ? app.arenaSignal.replay : null}
                  hash={res.finalHash}
                />
              )}
            </div>
          </Panel>
        )}
        {log.length > 0 && (
          <Panel title="log de decisões">
            <div className="term" style={{ maxHeight: 220 }}>
              {log.map((l, i) => (
                <div key={i}>
                  <span style={{ color: shipColor(l.ship) }}>{names[l.ship]}</span> <span className="muted">t{l.tick}</span>{' '}
                  <span className={l.status === 'timeout' ? 'warn' : 'err'}>{l.status}</span> {l.error?.split('\n')[0]}
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

/** Shows whether a replayed match ended on the recorded hash; offers a full worker re-simulation too. */
function ReplayCheck({ expected, hash }: { expected: Replay | null; hash: string }) {
  const [full, setFull] = useState<string | null>(null);
  if (!expected) return null;
  const ok = expected.result.finalHash === hash;
  return (
    <span className="row">
      <span className={ok ? 'ok' : 'err'}>{ok ? '✓ determinístico (hash confere)' : `✗ hash diferente (esperado ${expected.result.finalHash})`}</span>
      <button
        onClick={async () => {
          setFull('…');
          const v = await verifyInWorker(expected);
          setFull(v.ok ? '✓' : `✗ ${v.error ?? ''}`);
        }}
      >
        re-simular {full}
      </button>
    </span>
  );
}
