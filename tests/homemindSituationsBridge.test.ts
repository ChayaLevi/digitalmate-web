import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime, setHomemindAdaptersForTests } from '../server/homemind';
import { addDays, localParts, zonedToUtc } from '../server/homemind/clock';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';

const SECRET = 'test-secret-0123456789';
const ZONE = 'Asia/Shanghai';
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

/** The next Monday at 10:00 (Shanghai), at least an hour away: a weekday (the teacher message), the seeded pickup at 12:00. */
function nextMonday(): number {
  const today = localParts(Date.now(), ZONE).date;
  for (let d = 0; d <= 8; d++) {
    const date = addDays(today, d);
    const ms = zonedToUtc(date, '10:00', ZONE);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1 && ms > Date.now() + HOUR) return ms;
  }
  throw new Error('no Monday');
}

/** Writes a seed whose demo clock stands at `demoNow`, so the test does not depend on the wall clock. */
async function seedAt(demoNow: number): Promise<void> {
  const state = seedState({ now: demoNow, timezone: ZONE });
  await writeFile(process.env.HOMEMIND_DATA_FILE as string, JSON.stringify({ ...state, clockOffsetMs: Math.max(0, demoNow - Date.now()) }));
}

/** The Confirm button of a card on a parent's My day surface: its args carry the card's own token. */
async function confirmArgs(api: ReturnType<typeof as>, cardId: string): Promise<Record<string, unknown> | undefined> {
  const screen = await json<{ jsonl: string }>(await api.get('/screen/my-day'));
  type Component = { id: string; actions?: Array<{ args?: Record<string, unknown> }> };
  const components = screen.jsonl
    .split(/\r?\n/)
    .map(line => JSON.parse(line) as { updateComponents?: { components: Component[] } })
    .flatMap(line => line.updateComponents?.components ?? []);
  const card = components.find(c => c.id === `card-${cardId}`);
  return card?.actions?.find(a => a.args?.verb === 'confirm-card')?.args;
}

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
  dir = await mkdtemp(join(tmpdir(), 'homemind-situations-'));
  process.env.HOMEMIND_ENABLED = '1';
  process.env.HOMEMIND_SECRET = SECRET;
  process.env.HOMEMIND_DEMO = '1';
  process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
  process.env.HOMEMIND_LLM = 'fake';
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

describe('a day gone wrong through the bridge (T8.1)', () => {
  it('Mom says Noa is sick in chat: Dad sees who could stay home and the suggestions, applies one, and Undo works', async () => {
    await seedAt(nextMonday());
    const mom = as(await login('mom'));
    const dad = as(await login('dad'));
    const said = await mom.send('POST', '/chat', { text: 'Noa is sick today' });
    expect(said.status).toBe(200);
    const turn = await json(said);
    expect(turn).toMatchObject({ ok: true, outcome: 'situation', intent: 'report_situation' });
    expect(turn.jsonl).toContain('Noa is sick today');
    expect(turn.jsonl).toContain('Undo the stay-home task');

    let state = await debugState();
    const situation = state.situations?.[0];
    expect(situation?.proposals.map(p => p.itemId)).toEqual(['pickup-today', 'swim-today']);
    const task = state.items.find(i => i.id === situation?.stayHomeItemId);
    expect(task?.ownership).toEqual({ state: 'open', candidateIds: ['mom', 'dad'] });
    expect(state.actionCards.find(c => c.id === `${situation?.id}-teacher`)?.status).toBe('pending');

    // Saying it again does not make a second task.
    expect(await json(await mom.send('POST', '/chat', { text: 'Noa is sick today' }))).toMatchObject({ outcome: 'situation' });
    expect((await debugState()).items.filter(i => i.title === 'Stay home with Noa')).toHaveLength(1);

    const screen = await json<{ jsonl: string }>(await dad.get('/screen/my-day?lang=zh'));
    expect(screen.jsonl).toContain('诺娅今天生病了');
    expect(screen.jsonl).toContain('谁可以留在家');

    // Bad requests.
    expect((await dad.send('POST', `/situations/${situation?.id}/apply`, {})).status).toBe(400);
    expect((await dad.send('POST', `/situations/${situation?.id}/apply`, { proposalId: 'p1', extra: 1 })).status).toBe(400);
    expect((await dad.send('POST', `/situations/${situation?.id}/nope`, { proposalId: 'p1' })).status).toBe(404);
    expect((await dad.send('POST', '/situations/BAD!/apply', { proposalId: 'p1' })).status).toBe(404);
    expect((await dad.send('POST', '/situations/sit-none/apply', { proposalId: 'p1' })).status).toBe(404);

    const applied = await dad.send('POST', `/situations/${situation?.id}/apply`, { proposalId: 'p1' });
    expect(applied.status).toBe(200);
    expect(await json(applied)).toMatchObject({ applied: ['p1'], situation: { proposals: [{ id: 'p1', status: 'applied' }, { id: 'p2', status: 'pending' }] } });
    state = await debugState();
    expect(state.items.find(i => i.id === 'pickup-today')?.status).toBe('cancelled');
    expect((await dad.send('POST', `/situations/${situation?.id}/apply`, { proposalId: 'p1' })).status).toBe(409);

    const undone = await mom.send('POST', `/situations/${situation?.id}/undo`, { proposalId: 'p1' });
    expect(undone.status).toBe(200);
    expect((await debugState()).items.find(i => i.id === 'pickup-today')?.status).toBe('open');

    // Dad takes the stay-home task from his board.
    const taken = await dad.send('POST', `/items/${task?.id}/claim`, { version: task?.version });
    expect(taken.status).toBe(200);
    expect((await debugState()).items.find(i => i.id === task?.id)?.ownership).toMatchObject({ state: 'assigned', ownerId: 'dad' });
  });

  it("the teacher message goes out only on a parent's Confirm, to the simulated teacher", async () => {
    await seedAt(nextMonday());
    const mom = as(await login('mom'));
    await mom.send('POST', '/chat', { text: 'Noa is sick today' });
    const cardId = `${(await debugState()).situations?.[0].id}-teacher`;
    const maya = as(await login('maya'));
    expect((await maya.send('POST', `/actions/${cardId}/confirm`, {})).status).toBe(403);
    const args = await confirmArgs(mom, cardId);
    expect(args?.token).toBeTruthy();
    const confirmed = await mom.send('POST', `/actions/${cardId}/confirm`, { token: args?.token });
    expect(confirmed.status).toBe(200);
    const services = await json<{ jsonl: string }>(await mom.get('/screen/services'));
    expect(services.jsonl).toContain('Messages to the class teacher');
    expect(services.jsonl).toContain('不来幼儿园了');
  });
});
