import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { Replay } from '../../sim/replay';
import { db, uid, type ReplayRecord } from '../../store/db';
import { verifyInWorker } from '../../workers/client';
import { download, fmt, Panel, pickFile } from '../components/ui';
import { useApp } from '../state';

export function ReplaysScreen() {
  const app = useApp();
  const replays = useLiveQuery(() => db.replays.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const importReplay = async () => {
    const text = await pickFile();
    if (!text) return;
    try {
      const r = JSON.parse(text) as Replay;
      if (r.format !== 'orbital-onyx-replay') throw new Error('não é um replay do Orbital Onyx');
      await db.replays.add({
        id: uid(),
        createdAt: new Date().toISOString(),
        title: `${r.names.join(' vs ')} · seed ${r.map.seed} · ${r.map.planets}p (importado)`,
        replay: r,
        verified: null,
      });
      setMsg('✓ replay importado');
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const verify = async (rec: ReplayRecord) => {
    setBusy(rec.id);
    const v = await verifyInWorker(rec.replay);
    await db.replays.update(rec.id, { verified: v.ok });
    setBusy(null);
    if (v.error) setMsg(`✗ ${v.error}`);
  };

  const open = (rec: ReplayRecord) => {
    app.setTab('arena');
    app.signalArena({ kind: 'replay', replay: rec.replay, title: rec.title });
  };

  return (
    <Panel
      title="replays"
      actions={
        <>
          <button onClick={importReplay}>⤒ importar</button>
        </>
      }
    >
      {msg && <div className={msg.startsWith('✓') ? 'ok' : 'err'}>{msg}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        Um replay guarda ruleset, mapa e todas as ações. Re-simular deve chegar ao mesmo hash final: ✓ = determinístico neste navegador. Replays exportados pela CLI (
        <code>--save-replay</code>) servem para comparar navegador e Node.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>data</th>
              <th>partida</th>
              <th>vencedor</th>
              <th className="num">t</th>
              <th>hash</th>
              <th>verificado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {replays.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nenhum replay. Salve um na Arena ao fim de uma partida, ou importe.
                </td>
              </tr>
            )}
            {replays.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td className="gold">{r.title}</td>
                <td>{r.replay.result.winner === null ? <span className="warn">empate</span> : r.replay.names[r.replay.result.winner]}</td>
                <td className="num">{fmt(r.replay.result.ticks * r.replay.rules.dt, 1)}</td>
                <td className="muted">{r.replay.result.finalHash}</td>
                <td className={r.verified === null ? 'muted' : r.verified ? 'ok' : 'err'}>{busy === r.id ? '…' : r.verified === null ? '—' : r.verified ? '✓' : '✗'}</td>
                <td>
                  <button onClick={() => open(r)}>▶ abrir</button> <button onClick={() => verify(r)}>verificar</button>{' '}
                  <button onClick={() => download(`replay-${r.replay.map.seed}-${r.id.slice(0, 6)}.json`, JSON.stringify(r.replay))}>⤓</button>{' '}
                  <button className="danger" onClick={() => db.replays.delete(r.id)}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
