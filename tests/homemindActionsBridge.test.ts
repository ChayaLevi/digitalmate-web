import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime, setHomemindAdaptersForTests } from '../server/homemind';
import { prepareCard } from '../server/homemind/actions';
import type { ActionAdapter, AdapterRegistry } from '../server/homemind/actions';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';

const SECRET = 'test-secret-0123456789';
const ENV_KEYS = ['HOMEMIND_ENABLED', 'HOMEMIND_SECRET', 'HOMEMIND_DEMO', 'HOMEMIND_DATA_FILE', 'HOMEMIND_LLM'] as const;
const HOUR = 60 * 60 * 1000;

let server: Server;
let base = '';
let dir = '';
const saved: Record<string, string | undefined> = {};
let calls: Array<Record<string, unknown>> = [];

const adapter = (id: string, mode: 'real' | 'simulated'): ActionAdapter => ({
  id,
  mode,
  area: 'food',
  validate: payload => (typeof payload.item === 'string' ? null : 'item is required'),
  execute: async payload => {
    calls.push(payload);
    return { ok: true, result: { confirmation: 'SIM-1' } };
  }
});
const ADAPTERS: AdapterRegistry = { 'order-real': adapter('order-real', 'real'), 'order-sim': adapter('order-sim', 'simulated') };

/** Writes a seeded state with one pending card per entry before the bridge first loads it. */
async function plant(cards: Array<{ id: string; adapter: string; expiresInMs?: number }>): Promise<void> {
  const now = Date.now();
  let state: HomemindState = seedState({ now });
  for (const card of cards) {
    const prepared = prepareCard(state, { id: card.id, adapter: card.adapter, payload: { item: 'pizza', size: 'small' }, expiresAt: new Date(now + (card.expiresInMs ?? HOUR)).toISOString(), whyId: `why-${card.id}` }, ADAPTERS, now);
    if (!prepared.ok) throw new Error(prepared.message);
    state = prepared.state;
  }
  await writeFile(process.env.HOMEMIND_DATA_FILE as string, JSON.stringify(state));
}

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
type Api = ReturnType<typeof as>;
const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;
const confirmations = async (api: Api) => (await json<{ confirmations?: Record<string, { token: string; expiresAt: string }> }>(await api.get('/screen/my-day'))).confirmations;
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
  dir = await mkdtemp(join(tmpdir(), 'homemind-actions-'));
  process.env.HOMEMIND_ENABLED = '1';
  process.env.HOMEMIND_SECRET = SECRET;
  process.env.HOMEMIND_DEMO = '1';
  process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
  process.env.HOMEMIND_LLM = 'fake';
  calls = [];
  setHomemindAdaptersForTests(ADAPTERS);
  resetHomemindRuntime();
});

afterEach(async () => {
  setHomemindAdaptersForTests(undefined);
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

describe('POST /actions/:id/confirm', () => {
  it('gives tokens to parents only, and a parent tap runs the card once', async () => {
    await plant([{ id: 'card-1', adapter: 'order-real' }]);
    const mom = as(await login('mom'));
    const maya = as(await login('maya'));
    expect(await confirmations(maya)).toBeUndefined();
    const tokens = await confirmations(mom);
    expect(Object.keys(tokens ?? {})).toEqual(['card-1']);
    const token = tokens!['card-1'].token;

    const res = await mom.send('POST', '/actions/card-1/confirm', { token });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, card: { status: 'executed', executedBy: 'mom', result: { confirmation: 'SIM-1' } } });
    expect(calls).toHaveLength(1);
    const state = await debugState();
    expect(state.actionCards[0]).toMatchObject({ status: 'executed' });
    expect(state.activity.at(-1)).toMatchObject({ kind: 'action', ref: 'card-1', note: 'executed', actor: 'mom' });

    const again = await mom.send('POST', '/actions/card-1/confirm', { token });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toBe('token_used');
    expect(await confirmations(mom)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('refuses no token, a teen, another parent’s token and a forged one', async () => {
    await plant([{ id: 'card-1', adapter: 'order-real' }]);
    const mom = as(await login('mom'));
    const dad = as(await login('dad'));
    const maya = as(await login('maya'));
    const token = (await confirmations(mom))!['card-1'].token;

    const none = await mom.send('POST', '/actions/card-1/confirm', {});
    expect([none.status, (await json(none)).error]).toEqual([400, 'no_token']);
    const teen = await maya.send('POST', '/actions/card-1/confirm', { token });
    expect([teen.status, (await json(teen)).error]).toEqual([403, 'not_parent']);
    const other = await dad.send('POST', '/actions/card-1/confirm', { token });
    expect([other.status, (await json(other)).error]).toEqual([403, 'wrong_member']);
    const forged = await mom.send('POST', '/actions/card-1/confirm', { token: `${token.split('.')[0]}.forged` });
    expect([forged.status, (await json(forged)).error]).toEqual([403, 'bad_token']);
    // A session token is not a confirmation token, even though both come from the same secret.
    const session = await login('mom');
    const swapped = await mom.send('POST', '/actions/card-1/confirm', { token: session });
    expect([swapped.status, (await json(swapped)).error]).toEqual([403, 'bad_token']);
    expect(calls).toHaveLength(0);
  });

  it('checks the request itself: ids, fields, origin, sign-in', async () => {
    await plant([{ id: 'card-1', adapter: 'order-real' }]);
    const mom = as(await login('mom'));
    expect((await mom.send('POST', '/actions/Bad_Id/confirm', {})).status).toBe(404);
    expect((await mom.send('POST', '/actions/nope/confirm', { token: 'x.y' })).status).toBe(404);
    expect((await mom.send('POST', '/actions/card-1/confirm', { token: 'a', extra: 1 })).status).toBe(400);
    expect((await mom.send('POST', '/actions/card-1/confirm', { token: 5 })).status).toBe(400);
    expect((await mom.send('POST', '/actions/card-1/confirm', { token: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await as(undefined).send('POST', '/actions/card-1/confirm', { token: 'x' })).status).toBe(401);
    expect((await mom.get('/actions/card-1/confirm')).status).toBe(404);
  });

  it('an untapped card expires visibly when the demo clock passes it', async () => {
    await plant([{ id: 'card-1', adapter: 'order-sim', expiresInMs: 30 * 60 * 1000 }]);
    const mom = as(await login('mom'));
    const token = (await confirmations(mom))!['card-1'].token;
    expect((await mom.send('POST', '/demo/clock', { minutes: 31 })).status).toBe(200);
    const state = await debugState();
    expect(state.actionCards[0].status).toBe('expired');
    expect(state.activity.at(-1)).toMatchObject({ kind: 'action', note: 'expired', actor: 'homemind' });
    const late = await mom.send('POST', '/actions/card-1/confirm', { token });
    expect([late.status, (await json(late)).error]).toEqual([409, 'not_pending']);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /actions/:id/cancel', () => {
  it('a parent cancels; a teen cannot; the old token is then refused', async () => {
    await plant([{ id: 'card-1', adapter: 'order-sim' }]);
    const mom = as(await login('mom'));
    const maya = as(await login('maya'));
    const token = (await confirmations(mom))!['card-1'].token;
    expect((await maya.send('POST', '/actions/card-1/cancel', {})).status).toBe(403);
    const res = await as(await login('dad')).send('POST', '/actions/card-1/cancel', {});
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ card: { status: 'cancelled' } });
    expect((await mom.send('POST', '/actions/card-1/cancel', {})).status).toBe(409);
    const late = await mom.send('POST', '/actions/card-1/confirm', { token });
    expect((await json(late)).error).toBe('not_pending');
    expect(calls).toHaveLength(0);
  });
});
