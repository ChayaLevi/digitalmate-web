#!/usr/bin/env node
/**
 * A canned OpenAI-compatible endpoint for tests and rehearsals: POST /v1/chat/completions (and
 * /chat/completions), GET /health. No model, no key, no network. The replies come from
 * server/homemind/llmFake.ts, the same canned logic as HOMEMIND_LLM=fake, so this exercises the
 * live HTTP client without paid calls. Point the bridge at it with:
 *
 *   HOMEMIND_LLM=live HOMEMIND_LLM_BASE_URL=http://127.0.0.1:8031/v1 HOMEMIND_LLM_MODEL=fake
 *
 *   npm run llm:fake                      # listens on 127.0.0.1:8031
 *   FAKE_LLM_DELAY_MS=1500 npm run llm:fake   # slower, to see loading states
 *   FAKE_LLM_FAIL=invalid|500|empty npm run llm:fake   # every reply broken that way, to see the error path
 *
 * Runs through tsx (it imports TypeScript).
 */
import { createServer } from 'node:http';
import { fakeCompletion } from '../server/homemind/llmFake.ts';

const port = Number(process.env.FAKE_LLM_PORT ?? 8031);
const delayMs = Number(process.env.FAKE_LLM_DELAY_MS ?? 300);
const failMode = process.env.FAKE_LLM_FAIL ?? '';
const MAX_BODY = 10 * 1024 * 1024;

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, fake: true });
  if (req.method !== 'POST' || !/^(\/v1)?\/chat\/completions$/.test(path)) return send(res, 404, { error: { message: 'not found' } });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return send(res, 413, { error: { message: 'too large' } });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, { error: { message: 'bad JSON' } });
  }
  await new Promise(resolve => setTimeout(resolve, delayMs));
  if (failMode === '500') return send(res, 500, { error: { message: 'simulated failure' } });
  const completion = fakeCompletion(body);
  if (failMode === 'invalid') completion.choices[0].message.content = '{"intent": "launch_rockets"}';
  if (failMode === 'empty') completion.choices[0].message.content = '';
  // Purpose and size only: no message text in the log.
  console.log(`${new Date().toISOString()} completion ${size} bytes in, ${completion.choices[0].message.content.length} chars out`);
  send(res, 200, completion);
});

server.listen(port, '127.0.0.1', () => console.log(`fake LLM (simulated model) on http://127.0.0.1:${port}/v1`));
