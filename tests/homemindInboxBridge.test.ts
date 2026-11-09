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
  const headers = (): Record<string, string> => (token ? { [SESSION_HEADER]: token } : {});
  return {
    get: (path: string) => fetch(`${base}/api/homemind${path}`, { headers: headers() }),
    post: (path: string, body: unknown = {}) => fetch(`${base}/api/homemind${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  };
}
const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;
const debugState = async () => json<HomemindState>(await as(undefined).get('/debug/state'));

/** The next Monday at 10:00 (Shanghai), at least an hour away. */
function nextMonday(): number {
  const today = localParts(Date.now(), ZONE).date;
  for (let d = 0; d <= 8; d++) {
    const date = addDays(today, d);
    const ms = zonedToUtc(date, '10:00', ZONE);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1 && ms > Date.now() + HOUR) return ms;
  }
  throw new Error('no Monday');
}

async function seedAt(demoNow: number): Promise<void> {
  const state = seedState({ now: demoNow, timezone: ZONE });
  await writeFile(process.env.HOMEMIND_DATA_FILE as string, JSON.stringify({ ...state, clockOffsetMs: Math.max(0, demoNow - Date.now()) }));
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
  dir = await mkdtemp(join(tmpdir(), 'homemind-inbox-'));
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

describe('adding an email to the board through the bridge (T8.3)', () => {
  it('is private to the mailbox owner until approved, and one item when both parents got the mail', async () => {
    await seedAt(nextMonday());
    const mom = as(await login('mom'));
    const dad = as(await login('dad'));
    const maya = as(await login('maya'));

    // The library mail is Mom's alone: Dad gets "no such message", and nothing is created.
    expect((await dad.post('/inbox/mail-2/add')).status).toBe(404);
    expect((await mom.post('/inbox/mail-4/add')).status).toBe(404); // sender not approved
    expect((await mom.post('/inbox/mail-2/add', { extra: 1 })).status).toBe(400);

    const added = await json(await mom.post('/inbox/mail-2/add'));
    expect(added).toMatchObject({ ok: true, duplicate: false });
    const item = added.items[0];
    expect(item).toMatchObject({ status: 'proposed', title: 'Return the library books' });
    expect((await mom.post('/inbox/mail-2/add')).status).toBe(200); // the same mail again: no second item

    // Only Mom's screens know it (Services, search).
    const services = await json<{ jsonl: string }>(await mom.get('/screen/services'));
    expect(services.jsonl).toContain('On your board');
    for (const other of [dad, maya]) {
      const search = await json<{ jsonl: string }>(await other.get('/screen/search?q=Two%20books'));
      expect(search.jsonl).toContain('No matches');
    }
    // The query matches only the mail's quote, so Mom (the mailbox owner) finds exactly this one.
    const momSearch = await json<{ jsonl: string }>(await mom.get('/screen/search?q=Two%20books'));
    expect(momSearch.jsonl).not.toContain('No matches');
    expect((await dad.post(`/items/${item.id}/approve`, { version: item.version })).status).toBe(404);

    // Both parents got the class-photo mail: one proposal, in both mailboxes.
    const first = await json(await mom.post('/inbox/mail-1/add'));
    expect(first.duplicate).toBe(false);
    const second = await json(await dad.post('/inbox/mail-1/add'));
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(second.items[0].id).toBe(first.items[0].id);
    const state = await debugState();
    expect(state.items.filter(i => i.sourceRefs?.some(r => r.id === 'mail-1'))).toHaveLength(1);

    // Dad approves it: now Maya sees it too.
    const approved = await dad.post(`/items/${first.items[0].id}/approve`, { version: first.items[0].version });
    expect(approved.status).toBe(200);
    const mayaSearch = await json<{ jsonl: string }>(await maya.get('/screen/search?q=T-shirt'));
    expect(mayaSearch.jsonl).toContain('Class T-shirt');
  });
});
