export type ProviderKind = 'openai' | 'anthropic' | 'claude-code';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  /** OpenAI-compatible: up to and including /v1 (e.g. http://localhost:8080/v1). Anthropic: https://api.anthropic.com */
  baseUrl: string;
  apiKey: string;
  /** Route through the dev server's /proxy (for endpoints that block browser CORS). */
  useProxy: boolean;
}

export interface ModelConfig {
  id: string;
  providerId: string;
  model: string;
  label: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  /** null = provider default (not settable, e.g. Claude Code). */
  temperature: number | null;
  /** 0 = provider default. */
  maxTokens: number;
  seed?: number;
  /** Reasoning effort, for providers that take one (Claude Code `--effort`). */
  effort?: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  stopReason: string | null;
}

async function post(provider: ProviderConfig, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal };
  const res = provider.useProxy
    ? await fetch('/proxy', { ...init, headers: { ...(init.headers as Record<string, string>), 'x-target-url': url } })
    : await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export async function chat(
  provider: ProviderConfig,
  model: string,
  system: string,
  messages: ChatMessage[],
  params: ChatParams,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const t0 = performance.now();
  if (provider.kind === 'anthropic') {
    const json = await post(
      provider,
      `${trimSlash(provider.baseUrl || 'https://api.anthropic.com')}/v1/messages`,
      {
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      { model, system, messages, max_tokens: params.maxTokens, ...(params.temperature !== null ? { temperature: params.temperature } : {}) },
      signal,
    );
    const text = (json.content ?? [])
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text)
      .join('');
    return {
      text,
      inputTokens: json.usage?.input_tokens ?? null,
      outputTokens: json.usage?.output_tokens ?? null,
      latencyMs: performance.now() - t0,
      stopReason: json.stop_reason ?? null,
    };
  }
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: params.maxTokens,
  };
  if (params.temperature !== null) body.temperature = params.temperature;
  if (params.effort) {
    // OpenRouter takes a nested `reasoning` object (effort none…max); OpenAI-style servers take `reasoning_effort`.
    if (/openrouter\.ai/.test(provider.baseUrl)) body.reasoning = { effort: params.effort };
    else {
      // llama.cpp / Strata chat templates know low, medium and xhigh only; "max" and "high" mean their top level.
      const level = params.effort === 'max' || params.effort === 'high' ? 'xhigh' : params.effort;
      body.reasoning_effort = level;
      if (!/api\.openai\.com/.test(provider.baseUrl)) body.chat_template_kwargs = { reasoning_effort: level };
    }
  }
  if (params.seed !== undefined) body.seed = params.seed;
  const json = await post(provider, `${trimSlash(provider.baseUrl || 'https://api.openai.com/v1')}/chat/completions`, headers, body, signal);
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    inputTokens: json.usage?.prompt_tokens ?? null,
    outputTokens: json.usage?.completion_tokens ?? null,
    latencyMs: performance.now() - t0,
    stopReason: choice?.finish_reason ?? null,
  };
}

/** Lists model ids from an OpenAI-compatible /models endpoint (handy for llama-swap, vLLM, Ollama). */
export async function listModels(provider: ProviderConfig): Promise<string[]> {
  if (provider.kind !== 'openai') return [];
  const url = `${trimSlash(provider.baseUrl)}/models`;
  const headers: Record<string, string> = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  const res = provider.useProxy ? await fetch('/proxy', { method: 'GET', headers: { ...headers, 'x-target-url': url } }) : await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((m: { id: string }) => m.id).sort();
}
