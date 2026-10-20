import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { DEFAULT_RULESET, rulesetHash, type RuleSet } from '../../sim/ruleset';
import { db, setSetting } from '../../store/db';
import { CodeEditor, Panel } from '../components/ui';
import { useApp } from '../state';

/** Rulesets are immutable: editing saves a new one under a new hash. */
export function RulesScreen() {
  const { ruleset, reloadRuleset } = useApp();
  const all = useLiveQuery(() => db.rulesets.orderBy('createdAt').toArray(), []) ?? [];
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (ruleset) setText(JSON.stringify(ruleset.rules, null, 2));
  }, [ruleset]);

  const saveNew = async () => {
    let rules: RuleSet;
    try {
      rules = JSON.parse(text);
    } catch (e) {
      setMsg(`✗ JSON inválido: ${(e as Error).message}`);
      return;
    }
    const missing = Object.keys(DEFAULT_RULESET).filter((k) => k !== 'victoryHold' && !(k in rules));
    if (missing.length) {
      setMsg(`✗ faltam campos: ${missing.join(', ')}`);
      return;
    }
    const hash = await rulesetHash(rules);
    if (await db.rulesets.get(hash)) {
      setMsg(`= ruleset idêntico já existe (${hash}); ativado`);
    } else {
      await db.rulesets.put({ hash, rules, createdAt: new Date().toISOString() });
      setMsg(`✓ novo ruleset ${hash} salvo e ativado`);
    }
    await setSetting('activeRuleset', hash);
    await reloadRuleset();
  };

  const activate = async (hash: string) => {
    await setSetting('activeRuleset', hash);
    await reloadRuleset();
  };

  return (
    <div className="split">
      <Panel title={`ruleset ativo · ${ruleset?.rules.id ?? ''} · ${ruleset?.hash ?? ''}`}>
        <p className="muted" style={{ marginTop: 0 }}>
          Editar aqui cria um ruleset novo com hash novo. Nenhum ruleset existente muda. Resultados só se comparam dentro do mesmo hash.
        </p>
        <CodeEditor value={text} onChange={setText} />
        <div className="row edit-only" style={{ marginTop: 6 }}>
          <button className="primary" onClick={saveNew} disabled={!ruleset || text === JSON.stringify(ruleset.rules, null, 2)}>
            salvar como novo ruleset
          </button>
          <button onClick={() => ruleset && setText(JSON.stringify(ruleset.rules, null, 2))}>descartar</button>
          <button onClick={() => setText(JSON.stringify(DEFAULT_RULESET, null, 2))}>carregar padrão</button>
          {msg && <span className={msg.startsWith('✗') ? 'err' : 'ok'}>{msg}</span>}
        </div>
      </Panel>
      <Panel title="rulesets">
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>hash</th>
              <th>criado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {all.map((r) => (
              <tr key={r.hash} className={r.hash === ruleset?.hash ? 'sel' : ''}>
                <td className="gold">{r.rules.id}</td>
                <td className="muted">{r.hash}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.hash === ruleset?.hash ? <span className="ok">ativo</span> : <button onClick={() => activate(r.hash)}>ativar</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
