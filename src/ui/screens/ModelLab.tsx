import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { tournamentSummary } from '../../bench/summary';
import type { ValidationReport } from '../../bench/validate';
import { generateStrategy, type GenerationEvent, type GenerationRecord } from '../../llm/generate';
import { listModels, type ModelConfig, type ProviderConfig, type ProviderKind } from '../../llm/providers';
import { sha256 } from '../../sim/hash';
import { db, getSetting, nextVersion, setSetting, uid, type StrategyRecord } from '../../store/db';
import { validateInWorker } from '../../workers/client';
import { CodeEditor, Diff, fmt, Panel, pickFiles } from '../components/ui';
import { useApp } from '../state';

const PRESETS: Record<string, { kind: ProviderKind; baseUrl: string }> = {
  'local (llama.cpp / llama-swap)': { kind: 'openai', baseUrl: 'http://localhost:8080/v1' },
  Ollama: { kind: 'openai', baseUrl: 'http://localhost:11434/v1' },
  OpenAI: { kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  OpenRouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  Anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
};

const emptyProvider = (): ProviderConfig => ({ id: '', name: '', kind: 'openai', baseUrl: 'http://localhost:8080/v1', apiKey: '', useProxy: false });

interface GenSettings {
  temperature: number;
  maxTokens: number;
  maxRepairs: number;
  seed: string;
}

const DEFAULT_GEN: GenSettings = { temperature: 0.2, maxTokens: 16000, maxRepairs: 3, seed: '' };

export function ModelLabScreen() {
  const { ruleset } = useApp();
  const providers = useLiveQuery(() => db.providers.toArray(), []) ?? [];
  const models = useLiveQuery(() => db.models.toArray(), []) ?? [];
  const strategies = useLiveQuery(() => db.strategies.orderBy('createdAt').reverse().toArray(), []) ?? [];

  const [pForm, setPForm] = useState<ProviderConfig>(emptyProvider());
  const [available, setAvailable] = useState<string[]>([]);
  const [mForm, setMForm] = useState<{ providerId: string; model: string; label: string }>({ providerId: '', model: '', label: '' });
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [gen, setGen] = useState<GenSettings>(DEFAULT_GEN);
  const [busy, setBusy] = useState(false);
  const [term, setTerm] = useState<Array<{ cls: string; text: string }>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    getSetting<GenSettings>('gen', DEFAULT_GEN).then((g) => setGen({ ...DEFAULT_GEN, ...g }));
  }, []);

  const print = (cls: string, text: string) => setTerm((t) => [...t, { cls, text }].slice(-400));

  const saveProvider = async () => {
    const rec = { ...pForm, id: pForm.id || uid(), name: pForm.name || pForm.baseUrl };
    await db.providers.put(rec);
    setPForm(emptyProvider());
  };

  const fetchModels = async (p: ProviderConfig) => {
    try {
      const list = await listModels(p);
      setAvailable(list);
      print('ok', `✓ ${p.name}: ${list.length} modelos`);
    } catch (e) {
      print('err', `✗ ${p.name}: ${(e as Error).message} (CORS? marque "via proxy")`);
    }
  };

  const addModel = async () => {
    if (!mForm.providerId || !mForm.model) return;
    const m: ModelConfig = { id: uid(), providerId: mForm.providerId, model: mForm.model, label: mForm.label || mForm.model };
    await db.models.put(m);
    setMForm({ ...mForm, model: '', label: '' });
  };

  const runGeneration = async (targets: ModelConfig[], improve?: { from: StrategyRecord; summary: string }) => {
    if (!ruleset) return;
    setBusy(true);
    await setSetting('gen', gen);
    const ac = new AbortController();
    abortRef.current = ac;
    for (const m of targets) {
      const p = providers.find((x) => x.id === m.providerId);
      if (!p) continue;
      print('gold', `\n╭─ ${m.label} (${p.name}) ${improve ? `· melhorando ${improve.from.name}` : ''}`);
      const onEvent = (e: GenerationEvent) => {
        if (e.type === 'request') print('dim', `│ ❯ tentativa ${e.attempt + 1}: enviando ${e.attempt ? 'pedido de correção' : 'prompt'}…`);
        if (e.type === 'response') print('dim', `│ ← resposta em ${(e.latencyMs / 1000).toFixed(1)} s, ${e.text.length} caracteres`);
        if (e.type === 'validation') print(e.report.ok ? 'ok' : 'warn', `│ ${e.report.ok ? '✓' : '✗'} validação: ${e.report.text.split('\n').slice(0, 4).join(' | ')}`);
        if (e.type === 'error') print('err', `│ ✗ ${e.message}`);
      };
      const rec = await generateStrategy({
        provider: p,
        model: m.model,
        rules: ruleset.rules,
        params: { temperature: gen.temperature, maxTokens: gen.maxTokens, seed: gen.seed ? Number(gen.seed) : undefined },
        maxRepairs: gen.maxRepairs,
        validate: (code) => validateInWorker(code, ruleset.rules),
        onEvent,
        signal: ac.signal,
        improve: improve ? { code: improve.from.code, summary: improve.summary } : undefined,
      });
      if (rec.code) {
        const version = await nextVersion(m.label);
        const s: StrategyRecord = {
          id: uid(),
          name: `${m.label}@v${version}${rec.ok ? '' : '-falhou'}`,
          source: 'llm',
          model: m.label,
          version,
          parentId: improve?.from.id ?? null,
          code: rec.code,
          sha256: await sha256(rec.code),
          createdAt: new Date().toISOString(),
          generation: rec,
          archived: !rec.ok,
        };
        await db.strategies.put(s);
        print(rec.ok ? 'ok' : 'err', `╰─ ${rec.ok ? '✓ salva' : '✗ falhou (guardada arquivada)'} como ${s.name} · ${rec.repairs} reparo(s) · ${rec.inputTokens}+${rec.outputTokens} tokens`);
        if (rec.ok) setSelected(s.id);
      } else {
        print('err', `╰─ ✗ sem código: ${rec.error}`);
      }
      if (ac.signal.aborted) break;
    }
    setBusy(false);
  };

  /** Imports strategies written by `npm run generate` (or any .js), with their .gen.json generation records. */
  const importFiles = async () => {
    if (!ruleset) return;
    const files = await pickFiles('.js,.json');
    const gens = new Map(files.filter((f) => f.name.endsWith('.gen.json')).map((f) => [f.name.replace(/\.gen\.json$/, ''), f.text]));
    for (const f of files.filter((x) => x.name.endsWith('.js') && !x.name.endsWith('.failed.js'))) {
      const base = f.name.replace(/\.js$/, '');
      const report = await validateInWorker(f.text, ruleset.rules);
      if (!report.ok) {
        print('err', `✗ ${f.name}: ${report.text.split('\n')[0]}`);
        continue;
      }
      let generation: GenerationRecord | null = null;
      try {
        generation = gens.has(base) ? JSON.parse(gens.get(base)!) : null;
      } catch {
        generation = null;
      }
      const label = generation?.model ?? base;
      const version = await nextVersion(label);
      await db.strategies.put({
        id: uid(),
        name: `${label}@v${version}`,
        source: generation ? 'llm' : 'manual',
        model: label,
        version,
        parentId: null,
        code: f.text,
        sha256: await sha256(f.text),
        createdAt: new Date().toISOString(),
        generation,
      });
      print('ok', `✓ importada ${label}@v${version}${generation ? ' (com registro de geração)' : ''}`);
    }
  };

  const sel = strategies.find((s) => s.id === selected) ?? null;
  const visible = strategies.filter((s) => showArchived || !s.archived);

  return (
    <div className="col">
      <div className="split">
        <Panel title="provedores">
          <table>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td className="gold">{p.name}</td>
                  <td className="muted">{p.kind}</td>
                  <td className="muted" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.baseUrl}
                  </td>
                  <td className="muted">{p.apiKey ? '•••• ' + p.apiKey.slice(-4) : 'sem chave'}</td>
                  <td>
                    <button onClick={() => fetchModels(p)} disabled={p.kind !== 'openai'}>
                      /models
                    </button>{' '}
                    <button onClick={() => setPForm(p)}>editar</button>{' '}
                    <button className="danger" onClick={() => db.providers.delete(p.id)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="col edit-only" style={{ marginTop: 8 }}>
            <div className="row">
              <select
                value=""
                onChange={(e) => {
                  const pr = PRESETS[e.target.value];
                  if (pr) setPForm({ ...pForm, ...pr, name: pForm.name || e.target.value });
                }}
              >
                <option value="">predefinição…</option>
                {Object.keys(PRESETS).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <input placeholder="nome" value={pForm.name} onChange={(e) => setPForm({ ...pForm, name: e.target.value })} />
              <select value={pForm.kind} onChange={(e) => setPForm({ ...pForm, kind: e.target.value as ProviderKind })}>
                <option value="openai">OpenAI-compatível</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div className="row">
              <input className="grow" placeholder="base URL" value={pForm.baseUrl} onChange={(e) => setPForm({ ...pForm, baseUrl: e.target.value })} />
              <input type="password" placeholder="API key (fica só neste navegador)" value={pForm.apiKey} onChange={(e) => setPForm({ ...pForm, apiKey: e.target.value })} />
              <label title="usa o /proxy do servidor de desenvolvimento para endpoints que bloqueiam CORS">
                <input type="checkbox" checked={pForm.useProxy} onChange={(e) => setPForm({ ...pForm, useProxy: e.target.checked })} /> via proxy
              </label>
              <button className="primary" onClick={saveProvider}>
                {pForm.id ? 'salvar' : '+ adicionar'}
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="modelos">
          <table>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedModels.includes(m.id)}
                      onChange={(e) => setSelectedModels(e.target.checked ? [...selectedModels, m.id] : selectedModels.filter((x) => x !== m.id))}
                    />
                  </td>
                  <td className="gold">{m.label}</td>
                  <td className="muted">{m.model}</td>
                  <td className="muted">{providers.find((p) => p.id === m.providerId)?.name ?? '?'}</td>
                  <td>
                    <button className="danger" onClick={() => db.models.delete(m.id)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row edit-only" style={{ marginTop: 8 }}>
            <select value={mForm.providerId} onChange={(e) => setMForm({ ...mForm, providerId: e.target.value })}>
              <option value="">provedor…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input list="avail-models" placeholder="id do modelo" value={mForm.model} onChange={(e) => setMForm({ ...mForm, model: e.target.value })} />
            <datalist id="avail-models">
              {available.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <input placeholder="rótulo" value={mForm.label} onChange={(e) => setMForm({ ...mForm, label: e.target.value })} style={{ width: '10em' }} />
            <button className="primary" onClick={addModel}>
              + modelo
            </button>
          </div>
        </Panel>
      </div>

      <Panel
        title="gerar estratégias"
        actions={
          <>
            <button onClick={() => setTerm([])}>limpar</button>
          </>
        }
      >
        <div className="row edit-only">
          <label>
            temperatura <input type="number" step={0.05} min={0} max={2} value={gen.temperature} onChange={(e) => setGen({ ...gen, temperature: Number(e.target.value) })} style={{ width: '5em' }} />
          </label>
          <label>
            máx. tokens <input type="number" step={1000} value={gen.maxTokens} onChange={(e) => setGen({ ...gen, maxTokens: Number(e.target.value) })} />
          </label>
          <label>
            reparos <input type="number" min={0} max={10} value={gen.maxRepairs} onChange={(e) => setGen({ ...gen, maxRepairs: Number(e.target.value) })} style={{ width: '4em' }} />
          </label>
          <label>
            seed (opcional) <input value={gen.seed} onChange={(e) => setGen({ ...gen, seed: e.target.value })} style={{ width: '6em' }} />
          </label>
          <button className="primary" disabled={busy || !selectedModels.length} onClick={() => runGeneration(models.filter((m) => selectedModels.includes(m.id)))}>
            ▶ gerar ({selectedModels.length})
          </button>
          <button disabled={!busy} onClick={() => abortRef.current?.abort()}>
            ■ parar
          </button>
        </div>
        <p className="muted" style={{ margin: '6px 0' }}>
          Mesmo prompt, temperatura, limite de tokens e número de reparos para todos os modelos. O registro de cada geração (prompt, resposta, tokens, latência) fica salvo com a estratégia.
        </p>
        <div className="term">
          {term.length === 0 && <span className="muted">❯ aguardando…</span>}
          {term.map((l, i) => (
            <div key={i} className={l.cls}>
              {l.text}
            </div>
          ))}
        </div>
      </Panel>

      <div className="split">
        <Panel
          title="estratégias"
          actions={
            <>
              <button onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'esconder arquivadas' : 'mostrar arquivadas'}</button>
              <button onClick={importFiles}>⤒ importar .js</button>
              <button onClick={() => setSelected('new')}>+ colar manual</button>
            </>
          }
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>nome</th>
                  <th>origem</th>
                  <th className="num">reparos</th>
                  <th className="num">tokens</th>
                  <th>sha256</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id} className={s.id === selected ? 'sel' : ''} onClick={() => setSelected(s.id)} style={{ cursor: 'pointer' }}>
                    <td className={s.archived ? 'muted' : 'gold'}>{s.name}</td>
                    <td className="muted">{s.source}</td>
                    <td className="num">{s.generation ? s.generation.repairs : '—'}</td>
                    <td className="num">{s.generation ? s.generation.inputTokens + s.generation.outputTokens : '—'}</td>
                    <td className="muted">{s.sha256.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        {selected === 'new' ? (
          <ManualPaste onSaved={(id) => setSelected(id)} />
        ) : sel ? (
          <StrategyEditor
            key={sel.id}
            s={sel}
            parent={strategies.find((x) => x.id === sel.parentId) ?? null}
            busy={busy}
            onImprove={async (summary) => {
              const m = models.find((x) => x.label === sel.model);
              if (!m) {
                print('err', `✗ modelo "${sel.model}" não está cadastrado`);
                return;
              }
              await runGeneration([m], { from: sel, summary });
            }}
            onSelect={setSelected}
          />
        ) : (
          <Panel title="editor">
            <span className="muted">Selecione uma estratégia.</span>
          </Panel>
        )}
      </div>
    </div>
  );
}

function ValidationLine({ r }: { r: ValidationReport | null }) {
  if (!r) return null;
  return <pre className={`mono-pre ${r.ok ? 'ok' : 'err'}`}>{(r.ok ? '✓ ' : '✗ ') + r.text}</pre>;
}

function ManualPaste({ onSaved }: { onSaved: (id: string) => void }) {
  const { ruleset } = useApp();
  const [name, setName] = useState('');
  const [code, setCode] = useState('export default function control(obs, mem) {\n  return { thrust: 0, turn: 0, fire: false };\n}\n');
  const [report, setReport] = useState<ValidationReport | null>(null);
  const save = async () => {
    if (!ruleset) return;
    const r = await validateInWorker(code, ruleset.rules);
    setReport(r);
    if (!r.ok) return;
    const label = name || 'manual';
    const version = await nextVersion(label);
    const id = uid();
    await db.strategies.put({
      id,
      name: `${label}@v${version}`,
      source: 'manual',
      model: label,
      version,
      parentId: null,
      code,
      sha256: await sha256(code),
      createdAt: new Date().toISOString(),
      generation: null,
    });
    onSaved(id);
  };
  return (
    <Panel title="colar estratégia">
      <div className="row" style={{ marginBottom: 6 }}>
        <input placeholder="nome (ex.: modelo-x)" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={async () => ruleset && setReport(await validateInWorker(code, ruleset.rules))}>validar</button>
        <button className="primary" onClick={save}>
          validar e salvar
        </button>
      </div>
      <CodeEditor value={code} onChange={setCode} />
      <ValidationLine r={report} />
    </Panel>
  );
}

function StrategyEditor({
  s,
  parent,
  busy,
  onImprove,
  onSelect,
}: {
  s: StrategyRecord;
  parent: StrategyRecord | null;
  busy: boolean;
  onImprove: (summary: string) => void;
  onSelect: (id: string | null) => void;
}) {
  const { ruleset } = useApp();
  const [code, setCode] = useState(s.code);
  const [view, setView] = useState<'code' | 'diff' | 'log'>('code');
  const [report, setReport] = useState<ValidationReport | null>(null);
  const tournaments = useLiveQuery(() => db.tournaments.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const lastT = tournaments.find((t) => t.status === 'done' && t.leaderboard && t.strategies.some((x) => x.id === s.id));
  const dirty = code !== s.code;
  const isRef = s.source === 'ref';

  const saveVersion = async () => {
    if (!ruleset) return;
    const r = await validateInWorker(code, ruleset.rules);
    setReport(r);
    if (!r.ok) return;
    const label = s.model ?? s.name;
    const version = await nextVersion(label);
    const id = uid();
    await db.strategies.put({
      id,
      name: `${label}@v${version}`,
      source: 'manual',
      model: label,
      version,
      parentId: s.id,
      code,
      sha256: await sha256(code),
      createdAt: new Date().toISOString(),
      generation: null,
    });
    onSelect(id);
  };

  return (
    <Panel
      title={s.name}
      actions={
        <>
          <button onClick={() => setView('code')} className={view === 'code' ? 'primary' : ''}>
            código
          </button>
          <button onClick={() => setView('diff')} disabled={!parent && !dirty} className={view === 'diff' ? 'primary' : ''}>
            diff
          </button>
          <button onClick={() => setView('log')} disabled={!s.generation} className={view === 'log' ? 'primary' : ''}>
            geração
          </button>
        </>
      }
    >
      <div className="row edit-only" style={{ marginBottom: 6 }}>
        <button onClick={async () => ruleset && setReport(await validateInWorker(code, ruleset.rules))}>validar</button>
        <button className="primary" onClick={saveVersion} disabled={!dirty}>
          salvar como nova versão
        </button>
        {s.source === 'llm' && (
          <button disabled={!lastT || busy} title={lastT ? '' : 'rode um torneio com esta estratégia primeiro'} onClick={() => lastT && onImprove(tournamentSummary({ config: lastT.config, leaderboard: lastT.leaderboard!, matches: lastT.matches, name: (sid) => lastT.strategies.find((x) => x.id === sid)?.name ?? sid }, s.id))}>
            ✦ v{s.version + 1} com feedback
          </button>
        )}
        {!isRef && (
          <>
            <button onClick={() => db.strategies.update(s.id, { archived: !s.archived })}>{s.archived ? 'desarquivar' : 'arquivar'}</button>
            <button
              className="danger"
              onClick={async () => {
                if (confirm(`Apagar ${s.name}? Não dá para desfazer.`)) {
                  await db.strategies.delete(s.id);
                  onSelect(null);
                }
              }}
            >
              apagar
            </button>
          </>
        )}
      </div>
      {view === 'code' && <CodeEditor value={code} onChange={isRef ? undefined : setCode} readOnly={isRef} />}
      {view === 'diff' && <Diff a={dirty ? s.code : (parent?.code ?? '')} b={code} />}
      {view === 'log' && s.generation && (
        <div className="col">
          <div className="muted">
            prompt {s.generation.promptId} ({s.generation.promptHash}) · {s.generation.model} · temp {s.generation.params.temperature} · máx {s.generation.params.maxTokens} tokens ·{' '}
            {s.generation.repairs} reparo(s) · {s.generation.inputTokens}+{s.generation.outputTokens} tokens · {fmt(s.generation.latencyMs / 1000, 1)} s
          </div>
          {s.generation.attempts.map((a) => (
            <details key={a.index}>
              <summary className={a.validation?.ok ? 'ok' : 'warn'}>
                tentativa {a.index + 1} · {a.validation?.ok ? '✓' : '✗'} · {fmt(a.latencyMs / 1000, 1)} s · stop={a.stopReason ?? '?'}
              </summary>
              <div className="term">
                <div className="label">❯ pedido</div>
                {a.request}
                {'\n\n'}
                <div className="label">← resposta</div>
                {a.response}
                {a.validation && (
                  <>
                    {'\n\n'}
                    <div className="label">validação</div>
                    {a.validation.text}
                  </>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
      <ValidationLine r={report} />
    </Panel>
  );
}
