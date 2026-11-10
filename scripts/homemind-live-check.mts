#!/usr/bin/env node
// T9.1: the stage checks with the LIVE model, through the real bridge code (in process, no browser):
// each scene preset, then the messages the presenter sends, timed. Results feed docs/homemind-stats.md.
//
//   npx tsx scripts/homemind-live-check.mts [--runs 3]
//
// Reads HOMEMIND_LLM_BASE_URL, HOMEMIND_LLM_API_KEY and HOMEMIND_LLM_MODEL from .env.local and never
// prints them. Makes paid model calls (7 per run). PPMA is off (PPMA_URL is cleared). The state
// lives in a temp folder, so the dev server's board is not touched.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime } from '../server/homemind';
import { localParts } from '../server/homemind/clock';
import type { HomemindState } from '../server/homemind/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > 0 ? Math.max(1, Number(process.argv[runsArg + 1]) || 1) : 1;

function readEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = readEnv(await readFile(resolve(ROOT, '.env.local'), 'utf8').catch(() => ''));
for (const key of ['HOMEMIND_LLM_BASE_URL', 'HOMEMIND_LLM_API_KEY', 'HOMEMIND_LLM_MODEL', 'HOMEMIND_LLM_TIMEOUT_MS']) if (env[key]) process.env[key] = env[key];
if (!process.env.HOMEMIND_LLM_BASE_URL || !process.env.HOMEMIND_LLM_MODEL) {
  console.error('.env.local needs HOMEMIND_LLM_BASE_URL and HOMEMIND_LLM_MODEL');
  process.exit(2);
}
const dir = await mkdtemp(join(tmpdir(), 'homemind-live-'));
Object.assign(process.env, {
  HOMEMIND_ENABLED: '1',
  HOMEMIND_DEMO: '1',
  HOMEMIND_LLM: 'live',
  HOMEMIND_SECRET: 'live-check-only-secret-0123456789',
  HOMEMIND_DATA_FILE: join(dir, 'state.json')
});
delete process.env.PPMA_URL;
resetHomemindRuntime();

const server = createServer((req, res) => {
  void handleHomemindRequest(req, res).then(handled => {
    if (!handled) {
      res.statusCode = 404;
      res.end();
    }
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/homemind`;

const post = async (path: string, body: unknown, token?: string) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { [SESSION_HEADER]: token } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const state = async () => (await (await fetch(`${base}/debug/state`)).json()) as HomemindState;
const mom = (await post('/session', { memberId: 'mom' })).body.token as string;
const image = `data:image/png;base64,${(await readFile(resolve(ROOT, 'e2e/fixtures/homemind/jielong-sample.png'))).toString('base64')}`;

type Row = { check: string; ok: boolean; ms: number; note: string };
const rows: Row[] = [];

async function chat(check: string, preset: string, payload: { text?: string; image?: string }, verify: (s: HomemindState, reply: Record<string, any>) => string | true) {
  await post('/demo/reset', { preset }, mom);
  const started = Date.now();
  const reply = await post('/chat?lang=en', payload, mom);
  const wall = Date.now() - started;
  const s = await state();
  const verdict0 = reply.status === 200 && reply.body.ok ? verify(s, reply.body) : `HTTP ${reply.status} ${reply.body.outcome ?? reply.body.error ?? ''}`;
  // On a failure, what Homemind answered (the reply text holds no key and no state the presenter did not type).
  const verdict = verdict0 === true ? true : `${verdict0} · reply (${reply.body.outcome}): ${String(reply.body.message ?? '').slice(0, 160)}`;
  rows.push({ check, ok: verdict === true, ms: wall, note: verdict === true ? `model ${reply.body.ms} ms` : verdict });
}

const zone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

for (let run = 1; run <= RUNS; run++) {
  // Scene 2: the 接龙 screenshot on Monday 10:00. Everything must be proposed and still ahead.
  await chat('screenshot (Scene 2, Monday 10:00)', 'scene-2', { image }, s => {
    const now = Date.now() + s.clockOffsetMs;
    const fromShot = s.items.filter(i => i.source.kind === 'screenshot');
    const party = fromShot.find(i => i.type === 'event' && /派对|party/i.test(i.title));
    if (!party?.start) return `no party event (${fromShot.length} items)`;
    if (fromShot.some(i => i.status !== 'proposed')) return 'an item is not proposed';
    if (Date.parse(party.start) <= now) return `party is in the past: ${party.start}`;
    const p = localParts(Date.parse(party.start), zone());
    return p.weekday === 4 && p.time === '15:00' ? true : `party on weekday ${p.weekday} at ${p.time}`;
  });
  // Scene 3: "Noa is sick today" on a weekday 14:30.
  await chat('sick report (Scene 3)', 'scene-3', { text: 'Noa is sick today' }, (s, r) => {
    const sit = (s.situations ?? [])[0];
    if (r.outcome !== 'situation' || !sit) return `outcome ${r.outcome}`;
    return sit.proposals.length >= 2 ? true : `${sit.proposals.length} proposals`;
  });
  // Scene 4: the wedding on Sunday 12:00.
  await chat('wedding (Scene 4)', 'scene-4', { text: "I'm at my cousin's wedding from Tuesday to Saturday" }, s => {
    const pickup = s.items.find(i => i.id === 'pickup-tuesday');
    if (pickup?.ownership.state === 'open') return true;
    const made = s.items.filter(i => i.source.kind === 'chat').map(i => `${i.title} ${i.start ?? '-'}..${i.end ?? '-'} away=[${i.unavailableMemberIds.join(',')}]`);
    return `Tuesday pickup (${pickup?.start}) is ${pickup?.ownership.state}; made: ${made.join(' | ') || 'nothing'}`;
  });
  // The same sentence on the Monday 10:00 before the pickup (the e2e test's moment), for comparison.
  await chat('wedding (Monday 10:00)', 'scene-2', { text: "I'm at my cousin's wedding from Tuesday to Saturday" }, s => {
    const pickup = s.items.find(i => i.id === 'pickup-tuesday');
    return pickup?.ownership.state === 'open' ? true : `Tuesday pickup is ${pickup?.ownership.state}`;
  });
  // Plain chat: a question, an add, an assignment.
  await chat('question', 'scene-1', { text: "What's on today?" }, (_s, r) => (r.outcome === 'answer' ? true : `outcome ${r.outcome}`));
  await chat('add a task', 'scene-1', { text: 'Add a task: buy milk tomorrow' }, (s, r) => (s.items.some(i => /milk/i.test(i.title)) ? true : `outcome ${r.outcome}`));
  await chat('assign', 'scene-1', { text: 'Dad takes the kindergarten pickup today' }, s => {
    const pickup = s.items.find(i => i.id === 'pickup-today');
    return pickup?.ownership.state === 'assigned' && 'ownerId' in pickup.ownership && pickup.ownership.ownerId === 'dad' ? true : `pickup is ${pickup?.ownership.state}`;
  });
}

server.close();
resetHomemindRuntime();
await rm(dir, { recursive: true, force: true }).catch(() => undefined);

console.log(`model ${process.env.HOMEMIND_LLM_MODEL}, ${RUNS} run(s), zone ${zone()}, ${new Date().toISOString()}`);
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check.padEnd(36)} ${String(r.ms).padStart(6)} ms  ${r.note}`);
const by = new Map<string, number[]>();
for (const r of rows) by.set(r.check, [...(by.get(r.check) ?? []), r.ms]);
console.log('\nper check: min / median / max (wall time through the bridge, ms)');
for (const [check, list] of by) {
  const sorted = [...list].sort((a, b) => a - b);
  console.log(`  ${check.padEnd(36)} ${sorted[0]} / ${sorted[Math.floor(sorted.length / 2)]} / ${sorted[sorted.length - 1]}`);
}
const failed = rows.filter(r => !r.ok).length;
console.log(failed ? `\n${failed} of ${rows.length} FAILED` : `\nall ${rows.length} passed`);
process.exit(failed ? 1 : 0);
