import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLlmClient, llmConfigFromEnv, llmStatus, requestBody } from '../server/homemind/llm';
import type { LlmConfig, LlmRequest } from '../server/homemind/llm';
import { fakeCompletion } from '../server/homemind/llmFake';

const KEY = 'sk-test-secret-key-123';
const REQUEST: LlmRequest = { purpose: 'intent', system: 'Job: chat-intent\nToday is Wednesday 2026-11-04, 10:00 local time, time zone Asia/Shanghai (UTC+08:00).', user: 'private message text', maxTokens: 100 };
const live = (over: Partial<LlmConfig> = {}): LlmConfig => ({ mode: 'live', baseUrl: 'http://model.test/v1/', apiKey: KEY, model: 'deepseek-flash', timeoutMs: 5000, debug: 0, ...over });

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const completion = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

describe('llmConfigFromEnv', () => {
  it('defaults to the fake model, with no key needed', () => {
    const config = llmConfigFromEnv({});
    expect(config.mode).toBe('fake');
    expect(llmStatus(config)).toBe('fake');
    expect(config.timeoutMs).toBe(30_000);
    expect(config.debug).toBe(0);
  });

  it('reads live settings, trims them, and clamps the timeout', () => {
    const config = llmConfigFromEnv({ HOMEMIND_LLM: 'live', HOMEMIND_LLM_BASE_URL: ' http://x/v1 ', HOMEMIND_LLM_API_KEY: ' k ', HOMEMIND_LLM_MODEL: 'm', HOMEMIND_LLM_TIMEOUT_MS: '999999', HOMEMIND_DEBUG: '2' });
    expect(config).toMatchObject({ mode: 'live', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', timeoutMs: 30_000, debug: 2 });
    expect(llmStatus(config)).toBe('live');
    expect(llmConfigFromEnv({ HOMEMIND_LLM_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8000);
  });

  it('says not_configured for live mode without a base URL or model', () => {
    expect(llmStatus(llmConfigFromEnv({ HOMEMIND_LLM: 'live' }))).toBe('not_configured');
    expect(llmStatus(llmConfigFromEnv({ HOMEMIND_LLM: 'live', HOMEMIND_LLM_BASE_URL: 'http://x' }))).toBe('not_configured');
  });
});

describe('createLlmClient, live', () => {
  it('posts JSON mode with reasoning off to /chat/completions, with the key only in the header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createLlmClient(live(), {
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return reply(200, completion('{"intent":"ask"}'));
      }) as typeof fetch
    });
    const result = await client.complete(REQUEST);
    expect(result).toMatchObject({ ok: true, content: '{"intent":"ask"}', usage: { prompt_tokens: 10 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://model.test/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ model: 'deepseek-flash', max_tokens: 100, response_format: { type: 'json_object' }, thinking: { type: 'disabled' } });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(String(calls[0].init.body)).not.toContain(KEY);
  });

  it('adds follow-up turns after the user message (the retry)', () => {
    const body = requestBody({ ...REQUEST, followUp: [{ role: 'assistant', content: 'bad' }, { role: 'user', content: 'fix it' }] }, 'm');
    expect((body.messages as Array<{ role: string }>).map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it.each([
    [500, 'http'],
    [429, 'http'],
    [401, 'auth'],
    [403, 'auth']
  ])('maps HTTP %i to %s', async (status, code) => {
    const client = createLlmClient(live(), { fetch: (async () => reply(status, { error: { message: 'no' } })) as unknown as typeof fetch });
    expect(await client.complete(REQUEST)).toMatchObject({ ok: false, code, status });
  });

  it('treats empty content as a failure (reasoning used the whole budget in the T0.4 spike)', async () => {
    const client = createLlmClient(live(), { fetch: (async () => reply(200, completion('   '))) as unknown as typeof fetch });
    expect(await client.complete(REQUEST)).toMatchObject({ ok: false, code: 'empty' });
    const noChoices = createLlmClient(live(), { fetch: (async () => reply(200, {})) as unknown as typeof fetch });
    expect(await noChoices.complete(REQUEST)).toMatchObject({ ok: false, code: 'empty' });
  });

  it('maps a timeout and a network failure', async () => {
    const timeout = createLlmClient(live(), { fetch: (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch });
    expect(await timeout.complete(REQUEST)).toMatchObject({ ok: false, code: 'timeout' });
    const down = createLlmClient(live(), { fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    expect(await down.complete(REQUEST)).toMatchObject({ ok: false, code: 'network' });
  });

  it('times out a slow endpoint through AbortSignal.timeout', async () => {
    const client = createLlmClient(live({ timeoutMs: 50 }), {
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch
    });
    expect(await client.complete(REQUEST)).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('does not call anything when live mode is not configured', async () => {
    let called = false;
    const client = createLlmClient(live({ baseUrl: undefined }), { fetch: (async () => { called = true; return reply(200, {}); }) as unknown as typeof fetch });
    expect(client.status).toBe('not_configured');
    expect(await client.complete(REQUEST)).toMatchObject({ ok: false, code: 'not_configured' });
    expect(called).toBe(false);
  });
});

describe('debug logging', () => {
  const run = async (debug: 0 | 1 | 2) => {
    const lines: string[] = [];
    const client = createLlmClient(live({ debug }), { fetch: (async () => reply(200, completion('{"answer":"reply text"}'))) as unknown as typeof fetch, log: l => lines.push(l) });
    await client.complete(REQUEST);
    return lines.join('\n');
  };

  it('logs nothing when off', async () => {
    expect(await run(0)).toBe('');
  });

  it('level 1 logs purpose, status, latency and sizes, never the key or any text', async () => {
    const out = await run(1);
    expect(out).toMatch(/\[homemind llm\] intent live ok \d+ ms, in \d+ chars, out \d+ chars, tokens 10\/5/);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('private message text');
    expect(out).not.toContain('reply text');
  });

  it('level 2 also logs the reply, still not the key', async () => {
    const out = await run(2);
    expect(out).toContain('reply text');
    expect(out).not.toContain(KEY);
  });
});

describe('fake mode', () => {
  it('answers in process without any network call', async () => {
    let called = false;
    const client = createLlmClient(llmConfigFromEnv({ HOMEMIND_LLM: 'fake' }), { fetch: (async () => { called = true; return reply(200, {}); }) as unknown as typeof fetch });
    expect(client.status).toBe('fake');
    const result = await client.complete({ ...REQUEST, user: '<<<BEGIN BOARD>>>\n{"me":{"id":"mom"},"members":[],"items":[]}\n<<<END BOARD>>>\n\n<<<BEGIN MESSAGE>>>\nwhat is on today?\n<<<END MESSAGE>>>' });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.content)).toEqual({ intent: 'ask', answer: 'Nothing on the board for today.', itemIds: [] });
  });

  it('gives an OpenAI-shaped completion', () => {
    const body = fakeCompletion(requestBody(REQUEST, 'm'));
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(() => JSON.parse(body.choices[0].message.content)).not.toThrow();
  });
});

describe('live client against the fake endpoint over HTTP (what scripts/fake-llm.mjs serves)', () => {
  let base = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const ok = req.method === 'POST' && req.url === '/v1/chat/completions' && req.headers.authorization === `Bearer ${KEY}`;
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? fakeCompletion(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : { error: 'no' }));
    });
  });
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('round-trips a request', async () => {
    const client = createLlmClient(live({ baseUrl: base }));
    const result = await client.complete(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.content).intent).toBe('ask');
  });
});
