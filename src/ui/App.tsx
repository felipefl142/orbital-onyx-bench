import { useEffect, useRef, useState } from 'react';
import { ArenaScreen } from './screens/Arena';
import { ModelLabScreen } from './screens/ModelLab';
import { ReplaysScreen } from './screens/Replays';
import { RulesScreen } from './screens/Rules';
import { TournamentScreen } from './screens/Tournament';
import { useApp, type Tab } from './state';

const BANNER = String.raw` ██████╗ ██████╗ ██████╗ ██╗████████╗ █████╗ ██╗          ██████╗ ███╗   ██╗██╗   ██╗██╗  ██╗
██╔═══██╗██╔══██╗██╔══██╗██║╚══██╔══╝██╔══██╗██║         ██╔═══██╗████╗  ██║╚██╗ ██╔╝╚██╗██╔╝
██║   ██║██████╔╝██████╔╝██║   ██║   ███████║██║         ██║   ██║██╔██╗ ██║ ╚████╔╝  ╚███╔╝
██║   ██║██╔══██╗██╔══██╗██║   ██║   ██╔══██║██║         ██║   ██║██║╚██╗██║  ╚██╔╝   ██╔██╗
╚██████╔╝██║  ██║██████╔╝██║   ██║   ██║  ██║███████╗    ╚██████╔╝██║ ╚████║   ██║   ██╔╝ ██╗
 ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝     ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝`;

const TABS: Array<{ id: Tab; label: string; cmd: string }> = [
  { id: 'arena', label: 'ARENA', cmd: '/arena' },
  { id: 'lab', label: 'MODEL LAB', cmd: '/lab' },
  { id: 'bench', label: 'TORNEIO', cmd: '/torneio' },
  { id: 'replays', label: 'REPLAYS', cmd: '/replays' },
  { id: 'rules', label: 'REGRAS', cmd: '/regras' },
];

const HELP =
  '/run · /bench · /seed N · /planets N · /orbits on|off · /replay · /arena /lab /torneio /replays /regras · /theme light|dark · teclas: espaço . + − /';

function readTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem('onyx-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function App() {
  const app = useApp();
  const [theme, setTheme] = useState<'dark' | 'light'>(readTheme);
  const [cmd, setCmd] = useState('');
  const [feedback, setFeedback] = useState(HELP);
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const cmdRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('onyx-theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  // "/" focuses the command line from anywhere outside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
        e.preventDefault();
        cmdRef.current?.focus();
        setCmd('/');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = (line: string) => {
    const [name, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    const tab = TABS.find((t) => t.cmd === name);
    if (tab) {
      app.setTab(tab.id);
      return `→ ${tab.label}`;
    }
    switch (name) {
      case '/run':
        app.setTab('arena');
        app.signalArena({ kind: 'run' });
        return '▶ nova partida';
      case '/bench':
        app.setTab('bench');
        app.signalBench();
        return '▶ torneio iniciado';
      case '/seed': {
        const n = Number(arg);
        if (!Number.isInteger(n)) return '✗ uso: /seed 42';
        app.setArena({ seed: n });
        return `seed = ${n}`;
      }
      case '/planets': {
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 1 || n > 12) return '✗ uso: /planets 1..12';
        app.setArena({ planets: n });
        return `planetas = ${n}`;
      }
      case '/orbits':
        app.setArena({ orbits: arg === 'on' });
        return `órbitas ${arg === 'on' ? 'ligadas' : 'desligadas'}`;
      case '/replay':
        app.setTab('replays');
        return '→ REPLAYS';
      case '/theme':
        setTheme(arg === 'light' ? 'light' : 'dark');
        return `tema ${arg === 'light' ? 'claro' : 'escuro'}`;
      case '/help':
      case '/':
        return HELP;
      default:
        return `✗ comando desconhecido: ${name} — /help`;
    }
  };

  const s = app.status;
  return (
    <div className="app">
      <header className="banner">
        <pre aria-label="Orbital Onyx">{BANNER}</pre>
        <div className="sub">
          <b>benchmark de combate gravitacional</b>
          <br />
          LLMs escrevem o controlador · a física decide
        </div>
        <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="alternar tema">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={app.tab === t.id ? 'active' : ''} onClick={() => app.setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="screen">
        {/* Arena stays mounted so a running match keeps going while other tabs are open. */}
        <div style={{ display: app.tab === 'arena' ? 'block' : 'none' }}>
          <ArenaScreen />
        </div>
        {app.tab === 'lab' && <ModelLabScreen />}
        <div style={{ display: app.tab === 'bench' ? 'block' : 'none' }}>
          <TournamentScreen />
        </div>
        {app.tab === 'replays' && <ReplaysScreen />}
        {app.tab === 'rules' && <RulesScreen />}
      </main>
      <div className="cmdline">
        <span className="prompt">❯</span>
        <input
          ref={cmdRef}
          value={cmd}
          placeholder="digite um comando (/help)"
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && cmd.trim()) {
              setFeedback(run(cmd));
              setHistory((h) => [cmd, ...h].slice(0, 50));
              setHIdx(-1);
              setCmd('');
            } else if (e.key === 'ArrowUp' && history.length) {
              const i = Math.min(history.length - 1, hIdx + 1);
              setHIdx(i);
              setCmd(history[i]);
            } else if (e.key === 'ArrowDown') {
              const i = Math.max(-1, hIdx - 1);
              setHIdx(i);
              setCmd(i >= 0 ? history[i] : '');
            } else if (e.key === 'Escape') {
              setCmd('');
              cmdRef.current?.blur();
            }
          }}
        />
        <span className="feedback">{feedback}</span>
      </div>
      <footer className="statusbar">
        <span>
          modo <b>{TABS.find((t) => t.id === app.tab)?.label}</b>
        </span>
        <span>
          seed <b>{app.arena.seed}</b>
        </span>
        <span>
          planetas <b>{app.arena.planets}</b>
          {app.arena.orbits ? ' ⟳' : ''}
        </span>
        <span>
          tick <b>{s.tick ?? '—'}</b> {s.t !== undefined && <>({s.t.toFixed(1)} s)</>}
        </span>
        <span>
          {s.running ? <span className="ok">● rodando</span> : <span>○ parado</span>} <b>{s.speed ?? 1}×</b>
        </span>
        <span>
          fps <b>{s.fps ?? '—'}</b>
        </span>
        <span>
          fila <b>{s.queue ?? 0}</b>
        </span>
        <span>
          ruleset <b>{app.ruleset?.rules.id}</b> {app.ruleset?.hash.slice(0, 8)}
        </span>
        <span>
          workers <b>{Math.max(1, (navigator.hardwareConcurrency || 4) - 1)}</b>
        </span>
      </footer>
    </div>
  );
}
