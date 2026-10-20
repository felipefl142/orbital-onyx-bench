import type { ValidationReport } from '../bench/validate';
import type { RuleSet } from '../sim/ruleset';
import { extractCode } from './extract';
import { improvePrompt, PROMPT_ID, promptHash, repairPrompt, systemPrompt, USER_PROMPT } from './prompt';
import { chat, type ChatMessage, type ChatParams, type ChatResult, type ProviderConfig } from './providers';

export interface GenerationAttempt {
  index: number;
  request: string;
  response: string;
  code: string | null;
  validation: ValidationReport | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  stopReason: string | null;
}

export interface GenerationRecord {
  ok: boolean;
  code: string | null;
  promptId: string;
  promptHash: string;
  params: ChatParams & { maxRepairs: number };
  provider: { kind: string; baseUrl: string; note?: string };
  model: string;
  attempts: GenerationAttempt[];
  /** Repair rounds used (0 = first answer passed). */
  repairs: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  startedAt: string;
}

export type GenerationEvent =
  | { type: 'request'; attempt: number; text: string }
  | { type: 'response'; attempt: number; text: string; latencyMs: number }
  | { type: 'validation'; attempt: number; report: ValidationReport }
  | { type: 'error'; message: string };

export interface GenerateOptions {
  provider: ProviderConfig;
  model: string;
  rules: RuleSet;
  params: ChatParams;
  maxRepairs: number;
  /** Runs the sandboxed smoke test (in the browser this goes to a Worker). */
  validate: (code: string) => Promise<ValidationReport>;
  onEvent?: (e: GenerationEvent) => void;
  signal?: AbortSignal;
  /** Replaces the HTTP call (e.g. the Claude Code CLI provider). */
  chatFn?: (system: string, messages: ChatMessage[], params: ChatParams) => Promise<ChatResult>;
  /** Free-text note stored with the record (e.g. which parameters the provider could not honour). */
  providerNote?: string;
  /** Iterative mode: previous code + tournament summary. */
  improve?: { code: string; summary: string };
}

export async function generateStrategy(o: GenerateOptions): Promise<GenerationRecord> {
  const system = systemPrompt(o.rules);
  const rec: GenerationRecord = {
    ok: false,
    code: null,
    promptId: PROMPT_ID,
    promptHash: await promptHash(o.rules),
    params: { ...o.params, maxRepairs: o.maxRepairs },
    provider: { kind: o.provider.kind, baseUrl: o.provider.baseUrl, ...(o.providerNote ? { note: o.providerNote } : {}) },
    model: o.model,
    attempts: [],
    repairs: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    error: null,
    startedAt: new Date().toISOString(),
  };
  const messages: ChatMessage[] = [{ role: 'user', content: o.improve ? improvePrompt(o.improve.code, o.improve.summary) : USER_PROMPT }];

  for (let attempt = 0; attempt <= o.maxRepairs; attempt++) {
    const request = messages[messages.length - 1].content;
    o.onEvent?.({ type: 'request', attempt, text: request });
    let reply;
    try {
      reply = o.chatFn ? await o.chatFn(system, messages, o.params) : await chat(o.provider, o.model, system, messages, o.params, o.signal);
    } catch (e) {
      rec.error = (e as Error).message;
      o.onEvent?.({ type: 'error', message: rec.error });
      return rec;
    }
    o.onEvent?.({ type: 'response', attempt, text: reply.text, latencyMs: reply.latencyMs });
    rec.inputTokens += reply.inputTokens ?? 0;
    rec.outputTokens += reply.outputTokens ?? 0;
    rec.latencyMs += reply.latencyMs;
    const code = extractCode(reply.text);
    const validation: ValidationReport = code
      ? await o.validate(code)
      : {
          ok: false,
          compileError: 'no code block found',
          decisions: 0,
          errors: 0,
          timeouts: 0,
          disabled: true,
          messages: [],
          text:
            reply.stopReason === 'length' || reply.stopReason === 'max_tokens'
              ? 'Your reply was cut off by the output token limit before the code block ended. Return a shorter module.'
              : 'No ```js code block with `export default function control` was found in your reply.',
        };
    o.onEvent?.({ type: 'validation', attempt, report: validation });
    rec.attempts.push({
      index: attempt,
      request,
      response: reply.text,
      code,
      validation,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      latencyMs: reply.latencyMs,
      stopReason: reply.stopReason,
    });
    rec.repairs = attempt;
    if (validation.ok) {
      rec.ok = true;
      rec.code = code;
      return rec;
    }
    messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: repairPrompt(validation.text) });
  }
  rec.error = `failed validation after ${o.maxRepairs} repair round(s)`;
  // Keep the last code so the user can inspect or fix it by hand.
  rec.code = rec.attempts[rec.attempts.length - 1]?.code ?? null;
  return rec;
}
