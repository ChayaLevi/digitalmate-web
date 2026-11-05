/**
 * The model client: one OpenAI-compatible `POST {base}/chat/completions` with JSON output.
 *
 * Two modes (`HOMEMIND_LLM`):
 *   live  calls `HOMEMIND_LLM_BASE_URL` with `HOMEMIND_LLM_MODEL` and `HOMEMIND_LLM_API_KEY`
 *   fake  canned replies from llmFake.ts, in process, no network, no key ("Simulated model" on screen)
 *
 * This file only moves text. It never parses a reply into state: intents.ts validates every reply
 * and retries once (CLAUDE.md, "Model safety"). Debug logging (`HOMEMIND_DEBUG`): 1 logs purpose,
 * latency, status and sizes; 2 also logs the reply text. The key is never logged.
 *
 * No imports from src/ or Vite: `fetch` and `AbortSignal.timeout` are standard in Node 18+.
 */
import { fakeCompletion } from './llmFake';

export type LlmMode = 'live' | 'fake';

export interface LlmConfig {
  mode: LlmMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Per call. */
  timeoutMs: number;
  /** 0 off, 1 metadata, 2 also the reply text. */
  debug: 0 | 1 | 2;
}

/** What a screen shows about the model: `not_configured` is live mode without a base URL or model. */
export type LlmStatus = 'live' | 'fake' | 'not_configured';

export const LLM_DEFAULT_TIMEOUT_MS = 30_000;

export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  const debug = env.HOMEMIND_DEBUG === '2' ? 2 : env.HOMEMIND_DEBUG === '1' ? 1 : 0;
  const timeout = Number(env.HOMEMIND_LLM_TIMEOUT_MS);
  return {
    mode: env.HOMEMIND_LLM === 'live' ? 'live' : 'fake',
    baseUrl: env.HOMEMIND_LLM_BASE_URL?.trim() || undefined,
    apiKey: env.HOMEMIND_LLM_API_KEY?.trim() || undefined,
    model: env.HOMEMIND_LLM_MODEL?.trim() || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 120_000 ? timeout : LLM_DEFAULT_TIMEOUT_MS,
    debug
  };
}

export function llmStatus(config: LlmConfig): LlmStatus {
  if (config.mode === 'fake') return 'fake';
  return config.baseUrl && config.model ? 'live' : 'not_configured';
}

/** OpenAI-style content: plain text, or parts with images as data URLs. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface LlmRequest {
  /** For logs only: `intent`, `extract`. */
  purpose: string;
  system: string;
  user: string | ContentPart[];
  /** Earlier turns of the same call, for the one retry ("your reply was invalid because..."). */
  followUp?: Array<{ role: 'assistant' | 'user'; content: string }>;
  maxTokens: number;
}

export type LlmErrorCode = 'not_configured' | 'timeout' | 'network' | 'http' | 'auth' | 'empty';

export type LlmResult =
  | { ok: true; content: string; ms: number; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  | { ok: false; code: LlmErrorCode; message: string; status?: number; ms: number };

export interface LlmClient {
  readonly mode: LlmMode;
  readonly status: LlmStatus;
  complete(request: LlmRequest): Promise<LlmResult>;
}

export interface LlmDeps {
  fetch?: typeof fetch;
  /** Wall time for latency only (never for dates: those come from the injected clock). */
  now?: () => number;
  log?: (line: string) => void;
}

/** The JSON body sent to `/chat/completions`. Exported for the fake endpoint and tests. */
export function requestBody(request: LlmRequest, model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: request.maxTokens,
    temperature: 0,
    response_format: { type: 'json_object' },
    // deepseek-flash reasons by default and counts it against max_tokens, which gave empty replies
    // in the T0.4 spike. Off halves the time with the same result.
    thinking: { type: 'disabled' },
    messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }, ...(request.followUp ?? [])]
  };
}

const sizeOf = (user: LlmRequest['user']) =>
  typeof user === 'string' ? user.length : user.reduce((n, p) => n + (p.type === 'text' ? p.text.length : p.image_url.url.length), 0);

export function createLlmClient(config: LlmConfig, deps: LlmDeps = {}): LlmClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  const status = llmStatus(config);

  const debugLine = (request: LlmRequest, result: LlmResult) => {
    if (!config.debug) return;
    const head = `[homemind llm] ${request.purpose} ${config.mode} ${result.ok ? 'ok' : `fail ${result.code}${result.status ? ` ${result.status}` : ''}`} ${result.ms} ms, in ${request.system.length + sizeOf(request.user)} chars`;
    const tail = result.ok ? `, out ${result.content.length} chars${result.usage ? `, tokens ${result.usage.prompt_tokens ?? '?'}/${result.usage.completion_tokens ?? '?'}` : ''}` : '';
    log(head + tail);
    if (config.debug === 2 && result.ok) log(`[homemind llm] reply: ${result.content.slice(0, 2000)}`);
  };

  async function complete(request: LlmRequest): Promise<LlmResult> {
    const t0 = now();
    const done = (result: LlmResult) => {
      debugLine(request, result);
      return result;
    };
    if (config.mode === 'fake') {
      const body = fakeCompletion(requestBody(request, 'homemind-fake'));
      const content = body.choices[0].message.content;
      return done(content.trim() ? { ok: true, content, ms: now() - t0 } : { ok: false, code: 'empty', message: 'The model gave an empty reply', ms: now() - t0 });
    }
    if (status !== 'live') return done({ ok: false, code: 'not_configured', message: 'The model is not set up (HOMEMIND_LLM_BASE_URL, HOMEMIND_LLM_MODEL)', ms: 0 });
    let response: Response;
    try {
      response = await doFetch(`${(config.baseUrl as string).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify(requestBody(request, config.model as string)),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch (error) {
      const name = (error as Error)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      return done({ ok: false, code: timedOut ? 'timeout' : 'network', message: timedOut ? 'The model did not answer in time' : 'The model could not be reached', ms: now() - t0 });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const auth = response.status === 401 || response.status === 403;
      return done({ ok: false, code: auth ? 'auth' : 'http', status: response.status, message: auth ? 'The model refused the key' : `The model answered ${response.status}`, ms: now() - t0 });
    }
    const choice = (body as { choices?: Array<{ message?: { content?: unknown } }> } | undefined)?.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!content.trim()) return done({ ok: false, code: 'empty', message: 'The model gave an empty reply', ms: now() - t0 });
    const usage = (body as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    return done({ ok: true, content, ms: now() - t0, usage });
  }

  return { mode: config.mode, status, complete };
}
