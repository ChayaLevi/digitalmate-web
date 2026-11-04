#!/usr/bin/env node
// T0.3 spike: run PPMA with a real OpenAI-compatible model, post one family message, and report what
// PPMA did with it (memory, commands, model calls, latency). See docs/homemind-spikes.md.
//
//   node scripts/ppma-model-spike.mjs [--model deepseek-flash] [--inference live|record|replay]
//        [--cassette <file outside this repo>] [--port 18766] [--wait 900] [--text "..."]
//
// Reads HOMEMIND_LLM_BASE_URL, HOMEMIND_LLM_API_KEY and HOMEMIND_LLM_MODEL from .env.local and hands
// them to PPMA as PPMA_LLM_*. PPMA runs with --profile fake (in memory, nothing kept), strict auth,
// --agent openai and --agent-clear personal. Never prints the key. Makes paid model calls unless
// --inference replay.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const args = parseArgs(process.argv.slice(2));
const env = readEnvFile(resolve(ROOT, '.env.local'));
const model = args.model ?? env.HOMEMIND_LLM_MODEL;
const port = Number(args.port ?? 18766);
const waitSeconds = Number(args.wait ?? 900);
const inference = args.inference ?? 'live';
const text = args.text ?? 'Kindergarten party on Thursday, bring cut fruit.';
const ppmaDir = resolve(process.env.PPMA_DIR ?? resolve(ROOT, '..', 'ppma'));
const BASE = `http://127.0.0.1:${port}`;
const SPACE = 'me';

if (!env.HOMEMIND_LLM_BASE_URL || !model) fail('.env.local needs HOMEMIND_LLM_BASE_URL and HOMEMIND_LLM_MODEL');
if (inference !== 'live' && !args.cassette) fail(`--inference ${inference} needs --cassette`);
if (!existsSync(resolve(ppmaDir, 'pyproject.toml'))) fail(`no PPMA clone at ${ppmaDir} (set PPMA_DIR)`);

const ownerToken = randomBytes(32).toString('base64url');
const serveArgs = ['run', 'ppma', 'serve', '--profile', 'fake', '--agent', 'openai', '--agent-clear', 'personal',
  '--auth', 'strict', '--port', String(port), '--inference', inference];
if (args.cassette) serveArgs.push('--cassette', resolve(args.cassette));
const log = [];
const server = spawn('uv', serveArgs, {
  cwd: ppmaDir,
  env: {
    ...process.env,
    VIRTUAL_ENV: '',
    PPMA_OWNER_TOKEN: ownerToken,
    PPMA_LLM_BASE_URL: env.HOMEMIND_LLM_BASE_URL,
    PPMA_LLM_API_KEY: env.HOMEMIND_LLM_API_KEY ?? '',
    PPMA_LLM_MODEL: model,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const s of [server.stdout, server.stderr]) s.on('data', (d) => log.push(...d.toString().split(/\r?\n/).filter(Boolean)));
process.on('exit', stopServer);
process.on('SIGINT', () => process.exit(130));

try {
  console.log(`PPMA: model ${model}, inference ${inference}${args.cassette ? `, cassette ${resolve(args.cassette)}` : ''}, port ${port}`);
  await waitReady();

  const manifest = JSON.parse(readFileSync(resolve(HERE, 'ppma-homemind-manifest.json'), 'utf8'));
  await call('PUT', '/v0/apps/homemind/manifest', ownerToken, manifest, 200);
  const { token: appToken } = await call('POST', '/v0/apps/homemind/token', ownerToken, { revoke_previous: false }, 200);

  const frames = [];
  const streamAbort = new AbortController();
  const streaming = readStream(appToken, streamAbort.signal, frames);

  // Fixed id and time, so a replay sees the same message as the recording.
  const message = {
    id: args.id ?? '01KA0000000000000000000000',
    kind: 'event',
    type: 'homemind.message_received',
    space: SPACE,
    source: { app: 'homemind', app_version: '0.0.1' },
    occurred_at: args.at ?? '2026-11-03T08:00:00Z',
    payload: { channel: 'kindergarten_group', from: 'Kindergarten teacher', member_id: 'mom', text, simulated: true },
  };
  const t0 = Date.now();
  const ingest = await call('POST', `/v0/spaces/${SPACE}/messages`, appToken, { messages: [message] }, 202);
  console.log(`posted ${ingest.accepted?.length ?? 0} event: "${text}"`);

  // Answer every command, so settle does not wait on an outcome we owe.
  const answered = new Set();
  const answerCommands = async () => {
    for (const f of frames) {
      const m = f.data;
      if (m?.kind !== 'command' || answered.has(m.id)) continue;
      answered.add(m.id);
      const known = m.type === 'homemind.get_board';
      const outcome = known
        ? { status: 'executed', path: 'auto', result: { items: [] } }
        : { status: 'dismissed', path: 'asked', detail: 'spike: recorded, not executed' };
      await call('POST', `/v0/spaces/${SPACE}/messages`, appToken, {
        messages: [{ id: ulid(), kind: 'event', type: 'command.outcome', space: SPACE,
          source: { app: 'homemind', app_version: '0.0.1' }, occurred_at: new Date().toISOString(),
          causation_id: m.id, payload: outcome }],
      }, 202);
    }
  };
  const answering = setInterval(() => answerCommands().catch(() => {}), 500);

  let settled = null;
  try {
    settled = await call('POST', `/_local/settle?space=${SPACE}`, ownerToken, { timeout: waitSeconds }, 200, waitSeconds + 30);
  } catch (err) {
    console.log(`settle did not finish: ${err.message}`);
  }
  const seconds = (Date.now() - t0) / 1000;
  clearInterval(answering);
  await answerCommands().catch(() => {});

  const views = await call('GET', `/v0/spaces/${SPACE}/memory/views`, ownerToken, null, 200);
  const statements = [];
  for (const v of views.views ?? []) {
    const view = await call('GET', `/v0/spaces/${SPACE}/memory/views/${encodeURIComponent(v.view)}`, ownerToken, null, 200);
    for (const s of view.statements ?? []) statements.push({ view: v.view, text: s.text, origin: s.origin, confidence: s.confidence });
  }
  const status = await call('GET', `/_local/status?space=${SPACE}`, ownerToken, null, 200);
  streamAbort.abort();
  await streaming.catch(() => {});

  const commands = frames.filter((f) => f.data?.kind === 'command').map((f) => f.data);
  let explanation = null;
  if (commands[0]?.decision_id) {
    explanation = await call('GET', `/v0/spaces/${SPACE}/decisions/${commands[0].decision_id}/explain`, ownerToken, null, 200).catch(() => null);
  }

  const inf = status.inference ?? {};
  console.log(`\nPPMA idle: ${settled ? 'yes' : 'NO'} after ${seconds.toFixed(1)} s (state ${status.state})`);
  console.log(`model use: live ${fmtUse(inf.live)} | replay hits ${fmtUse(inf.hits)} | misses ${JSON.stringify(inf.misses ?? null)} | failures ${JSON.stringify(inf.failures ?? null)}`);
  const s2 = inf.classes?.system2, s1 = inf.classes?.system1;
  if (s1 || s2) console.log(`mean latency per ask: system1 ${s1?.mean_latency_ms ?? '-'} ms, system2 ${s2?.mean_latency_ms ?? '-'} ms`);
  if (inf.tasks) console.log(`asks by task: ${Object.entries(inf.tasks).map(([k, v]) => `${k}=${v.asks ?? v.calls ?? JSON.stringify(v)}`).join(', ')}`);
  console.log(`\nmemory statements (${statements.length}):`);
  for (const s of statements) console.log(`  [${s.view}] (${s.origin} ${s.confidence}) ${s.text}`);
  console.log(`\nPPMA messages on the stream (${frames.length}): ${[...new Set(frames.map((f) => f.data?.type))].join(', ') || 'none'}`);
  console.log(`commands (${commands.length}):`);
  for (const c of commands) console.log(`  ${c.type} confidence ${c.confidence} -> ${JSON.stringify(c.payload)}\n    rationale: ${c.rationale}`);
  if (explanation) console.log(`\nexplain(first command): ${explanation.summary ?? explanation.rationale}\n  basis: ${explanation.basis.map((b) => `${b.kind}:${b.ref}`).join(', ')}`);
  const failures = log.filter((l) => /ERROR|Traceback|refus|NotCleared|miss/i.test(l));
  if (failures.length) console.log(`\nPPMA log lines worth reading:\n  ${failures.slice(-15).join('\n  ')}`);
  const failed = (inf.failures?.transient ?? 0) + (inf.failures?.permanent ?? 0) + (inf.failures?.not_cleared ?? 0);
  const asks = (inf.live?.asks ?? 0) + (inf.hits?.asks ?? 0);
  const ok = settled && failed === 0 && asks > 0;
  if (!ok) console.log(`\nFAIL: ${!settled ? 'PPMA did not settle' : failed ? `${failed} model call(s) failed` : 'the model was never asked'}`);
  else console.log('\nPASS: the model answered every ask');
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  console.log(`--- last PPMA log lines\n${log.slice(-20).join('\n')}`);
  process.exit(1);
}

function fmtUse(u) {
  if (!u) return '-';
  return `asks ${u.asks} calls ${u.calls} tokens in ${u.input_tokens} out ${u.output_tokens}`;
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`PPMA exited with ${server.exitCode}`);
    try {
      await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('PPMA did not start in 120 s');
}

async function call(method, path, token, body, expect, timeoutSeconds = 30) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  const textBody = await res.text();
  if (res.status !== expect) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${textBody.slice(0, 300)}`);
  return textBody ? JSON.parse(textBody) : {};
}

async function readStream(token, signal, frames) {
  const res = await fetch(`${BASE}/v0/spaces/${SPACE}/stream?app=homemind`, { headers: { Authorization: `Bearer ${token}` }, signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
      const frame = {};
      for (const line of block.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) frame[line.slice(0, i)] = line.slice(i + 1).trim();
      }
      if (frame.data) {
        try { frames.push({ id: frame.id, data: JSON.parse(frame.data) }); } catch { /* heartbeat or partial */ }
      }
    }
  }
}

function stopServer() {
  if (server.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
  else server.kill();
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') ? 'true' : list[++i];
  return out;
}

function ulid() {
  const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = Date.now(), s = '';
  for (let i = 0; i < 10; i++) { s = C[t % 32] + s; t = Math.floor(t / 32); }
  for (const b of randomBytes(16)) s += C[b % 32];
  return s;
}

function fail(msg) {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
}
