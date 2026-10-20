/**
 * Node-only provider: runs models through the Claude Code CLI (`claude -p`), which uses the user's Claude
 * subscription. Isolation, measured with a probe prompt: in an empty working directory, with `--setting-sources ""`,
 * `--strict-mcp-config` and `--tools ""`, no user settings, hooks, CLAUDE.md or MCP servers reach the context. Claude
 * Code still adds about 560 tokens of its own context. Temperature and max output tokens cannot be set.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ChatResult } from './providers';

export interface ClaudeCodeOptions {
  model: string;
  effort: string;
  /** Empty directory the CLI runs in (no project files or CLAUDE.md). */
  cwd?: string;
}

function run(args: string[], input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 || out.trim().startsWith('{') ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`))));
    p.stdin.end(input);
  });
}

/**
 * Returns a chat function bound to one conversation. Repair rounds continue the same session with `--resume`, so the
 * model sees its earlier answer exactly as with the HTTP providers.
 */
export function claudeCodeChat(o: ClaudeCodeOptions) {
  const cwd = o.cwd ?? join(tmpdir(), 'orbital-onyx-claude-code');
  mkdirSync(cwd, { recursive: true });
  let session: string | null = null;
  return async (system: string, messages: ChatMessage[]): Promise<ChatResult> => {
    const last = messages[messages.length - 1];
    const args = [
      '-p',
      '--model',
      o.model,
      '--effort',
      o.effort,
      '--system-prompt',
      system,
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--output-format',
      'json',
    ];
    if (session) args.push('--resume', session);
    else if (messages.length !== 1) throw new Error('claude-code chat must start with a single user message');
    const t0 = performance.now();
    const raw = await run(args, last.content, cwd);
    let d: Record<string, any>;
    try {
      d = JSON.parse(raw);
    } catch {
      throw new Error(`unexpected claude output: ${raw.slice(0, 300)}`);
    }
    if (d.is_error) throw new Error(`claude error: ${String(d.result ?? d.subtype).slice(0, 500)}`);
    session = d.session_id ?? session;
    const u = d.usage ?? {};
    return {
      text: String(d.result ?? ''),
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? null,
      latencyMs: d.duration_ms ?? performance.now() - t0,
      stopReason: d.stop_reason ?? d.subtype ?? null,
    };
  };
}
