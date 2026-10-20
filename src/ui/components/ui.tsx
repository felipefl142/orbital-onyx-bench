import { useMemo, useRef, type ReactNode } from 'react';

export function Panel(props: { title: string; actions?: ReactNode; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <section className={`panel ${props.className ?? ''}`} style={props.style}>
      <div className="panel-title">{props.title}</div>
      {props.actions && <div className="panel-actions">{props.actions}</div>}
      {props.children}
    </section>
  );
}

/** ASCII meter: ▰▰▰▱▱ */
export function Bar({ value, max = 1, width = 10, color }: { value: number; max?: number; width?: number; color?: string }) {
  const f = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const n = Math.round(f * width);
  return (
    <span className="bar" style={{ color }}>
      {'▰'.repeat(n)}
      <span className="muted">{'▱'.repeat(width - n)}</span>
    </span>
  );
}

/** Signed meter for turn ∈ [-1, 1]: ▱▱▰▰|▱▱▱▱ */
export function SignedBar({ value, width = 5 }: { value: number; width?: number }) {
  const n = Math.round(Math.min(1, Math.abs(value)) * width);
  const left = value < 0 ? '▱'.repeat(width - n) + '▰'.repeat(n) : '▱'.repeat(width);
  const right = value > 0 ? '▰'.repeat(n) + '▱'.repeat(width - n) : '▱'.repeat(width);
  return (
    <span className="bar">
      <span className={value < 0 ? 'gold' : 'muted'}>{left}</span>
      <span className="muted">│</span>
      <span className={value > 0 ? 'gold' : 'muted'}>{right}</span>
    </span>
  );
}

export const fmt = (x: number | null | undefined, d = 0): string =>
  x === null || x === undefined || Number.isNaN(x) ? '—' : !Number.isFinite(x) ? '∞' : x.toFixed(d);

export const pct = (x: number | null | undefined, d = 1): string =>
  x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`;

export const shipColor = (i: number) => `var(--ship-${i % 8})`;

export function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept = '.json,application/json'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null);
    input.click();
  });
}

/** Several files at once: [{ name, text }]. */
export function pickFiles(accept: string): Promise<Array<{ name: string; text: string }>> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = accept;
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, text: await f.text() }))));
    input.click();
  });
}

/** Plain textarea editor with a line-number gutter; Tab inserts two spaces. */
export function CodeEditor({ value, onChange, readOnly }: { value: string; onChange?: (v: string) => void; readOnly?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lines = value.split('\n').length;
  const gutter = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join('\n'), [lines]);
  return (
    <div className="editor">
      <div className="gutter">{gutter}</div>
      <textarea
        ref={ref}
        spellCheck={false}
        value={value}
        readOnly={readOnly}
        rows={lines + 1}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && !readOnly) {
            e.preventDefault();
            const t = e.currentTarget;
            const s = t.selectionStart;
            const next = value.slice(0, s) + '  ' + value.slice(t.selectionEnd);
            onChange?.(next);
            requestAnimationFrame(() => {
              t.selectionStart = t.selectionEnd = s + 2;
            });
          }
          e.stopPropagation();
        }}
      />
    </div>
  );
}

/** Line diff (LCS). Fine for strategy-sized files. */
export function Diff({ a, b }: { a: string; b: string }) {
  const rows = useMemo(() => {
    const x = a.split('\n');
    const y = b.split('\n');
    const n = x.length;
    const m = y.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: Array<{ k: ' ' | '+' | '-'; t: string }> = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push({ k: ' ', t: x[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ k: '-', t: x[i++] });
      else out.push({ k: '+', t: y[j++] });
    }
    while (i < n) out.push({ k: '-', t: x[i++] });
    while (j < m) out.push({ k: '+', t: y[j++] });
    return out;
  }, [a, b]);
  return (
    <pre className="term diff mono-pre">
      {rows.map((r, i) => (
        <div key={i} className={r.k === '+' ? 'add' : r.k === '-' ? 'del' : 'muted'}>
          {r.k} {r.t}
        </div>
      ))}
    </pre>
  );
}
