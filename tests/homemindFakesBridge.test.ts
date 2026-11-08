import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime, setHomemindAdaptersForTests } from '../server/homemind';
import { prepareCard } from '../server/homemind/actions';
import { GROUP_FIXTURE, createSimulatedAdapters, draftBabysitterMessage } from '../server/homemind/fakes';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';

const SECRET = 'test-secret-0123456789';
const ENV_KEYS = ['HOMEMIND_ENABLED', 'HOMEMIND_SECRET', 'HOMEMIND_DEMO', 'HOMEMIND_DATA_FILE', 'HOMEMIND_LLM'] as const;
const HOUR = 60 * 60 * 1000;

let server: Server;
let base = '';
let dir = '';
const saved: Record<string, string | undefined> = {};

async function login(memberId: string): Promise<string> {
  const res = await fetch(`${base}/api/homemind/session`, { method: 'POST', body: JSON.stringify({ memberId }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function as(token: string | undefined) {
  const headers = (extra: Record<string, string> = {}) => ({ ...(token ? { [SESSION_HEADER]: token } : {}), ...extra });
  return {
    get: (path: string) => fetch(`${base}/api/homemind${path}`, { headers: headers() }),
    send: (method: string, path: string, body?: unknown, extra?: Record<string, string>) =>
      fetch(`${base}/api/homemind${path}`, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) })
  };
}
const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;
const debugState = async () => json<HomemindState>(await as(undefined).get('/debug/state'));

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  server = createServer((req, res) => {
    handleHomemindRequest(req, res).then(handled => {
      if (!handled) {
        res.statusCode = 418;
        res.end('not homemind');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'homemind-fakes-'));
  process.env.HOMEMIND_ENABLED = '1';
  process.env.HOMEMIND_SECRET = SECRET;
  process.env.HOMEMIND_DEMO = '1';
  process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
  process.env.HOMEMIND_LLM = 'fake';
  // The built-in adapters: the simulated services.
  setHomemindAdaptersForTests(undefined);
  resetHomemindRuntime();
});

afterEach(async () => {
  resetHomemindRuntime();
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('POST /demo/post-group-message', () => {
  it('posts the sample messages in order, saves them, and says when there are no more', async () => {
    const dad = as(await login('dad'));
    for (let n = 0; n < GROUP_FIXTURE.length; n++) {
      const res = await dad.send('POST', '/demo/post-group-message', {});
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ ok: true, message: { id: GROUP_FIXTURE[n].id, simulated: true }, remaining: GROUP_FIXTURE.length - n - 1 });
    }
    expect((await debugState()).services?.group.messages.map(m => m.id)).toEqual(GROUP_FIXTURE.map(m => m.id));
    const done = await dad.send('POST', '/demo/post-group-message', {});
    expect(done.status).toBe(409);
    expect((await json(done)).error).toBe('no_more_messages');

    // A demo reset empties the group again.
    expect((await dad.send('POST', '/demo/reset', {})).status).toBe(200);
    expect((await debugState()).services?.group.messages).toEqual([]);
  });

  it('is refused signed out, cross-origin, with a body, and absent without HOMEMIND_DEMO=1', async () => {
    const mom = as(await login('mom'));
    expect((await as(undefined).send('POST', '/demo/post-group-message', {})).status).toBe(401);
    expect((await mom.send('POST', '/demo/post-group-message', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await mom.send('POST', '/demo/post-group-message', { text: 'anything' })).status).toBe(400);
    process.env.HOMEMIND_DEMO = '0';
    expect((await mom.send('POST', '/demo/post-group-message', {})).status).toBe(404);
    expect((await debugStateWithDemo()).services?.group.messages).toEqual([]);
  });
});

async function debugStateWithDemo() {
  process.env.HOMEMIND_DEMO = '1';
  return debugState();
}

describe('GET /screen/services', () => {
  it("shows the group and the member's own inbox, every card labelled simulated", async () => {
    const mom = as(await login('mom'));
    const maya = as(await login('maya'));
    await mom.send('POST', '/demo/post-group-message', {});
    const res = await mom.get('/screen/services?lang=zh');
    expect(res.status).toBe(200);
    const body = await json<{ jsonl: string; screen: string }>(res);
    expect(body.screen).toBe('services');
    expect(body.jsonl).toContain('各位家长好');
    expect(body.jsonl).toContain('模拟');
    expect(body.jsonl).toContain('您借的书明天到期');
    expect(body.jsonl).toContain('post-group-message');
    const teen = await json<{ jsonl: string }>(await maya.get('/screen/services'));
    expect(teen.jsonl).toContain('Simulated');
    expect(teen.jsonl).not.toContain('Your books are due tomorrow');
  });
});

describe('the simulated adapters are registered', () => {
  it("a babysitter card runs on a parent's tap and the simulated sitter's answer is saved", async () => {
    const now = Date.now();
    const state = seedState({ now });
    const validateOnly = createSimulatedAdapters({ get: () => state, set: () => undefined, now: () => now });
    const payload = { sitterId: 'sitter-zhang', date: '2026-11-10', from: '18:30', to: '22:00', text: draftBabysitterMessage('sitter-zhang', '2026-11-10', '18:30', '22:00', 'en') };
    const prepared = prepareCard(state, { id: 'card-sitter', adapter: 'babysitter', payload, expiresAt: new Date(now + HOUR).toISOString(), whyId: 'why-sitter' }, validateOnly, now);
    if (!prepared.ok) throw new Error(prepared.message);
    await writeFile(process.env.HOMEMIND_DATA_FILE as string, JSON.stringify(prepared.state));

    const mom = as(await login('mom'));
    const screen = await json<{ confirmations?: Record<string, { token: string }> }>(await mom.get('/screen/my-day'));
    const token = screen.confirmations?.['card-sitter']?.token;
    expect(token).toBeTruthy();
    expect((await mom.send('POST', '/actions/card-sitter/confirm', {})).status).toBe(400);
    const res = await mom.send('POST', '/actions/card-sitter/confirm', { token });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ card: { status: 'executed', mode: 'simulated', result: { messageId: 'sit-1', reply: 'yes', simulated: true } } });
    const after = await debugState();
    expect(after.services?.babysitterMessages).toEqual([expect.objectContaining({ id: 'sit-1', sitterId: 'sitter-zhang', reply: 'yes', simulated: true })]);
    expect(after.actionCards[0].status).toBe('executed');
  });
});
