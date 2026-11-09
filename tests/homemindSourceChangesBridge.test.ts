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

/** The next Monday at 10:00 (Shanghai), at least an hour away: the party on Thursday and its Wednesday deadline are ahead. */
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
  dir = await mkdtemp(join(tmpdir(), 'homemind-source-'));
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

const postTwo = async (api: ReturnType<typeof as>) => {
  expect((await api.send('POST', '/demo/post-group-message', {})).status).toBe(200);
  return json(await api.send('POST', '/demo/post-group-message', {}));
};

const claimApples = async () => {
  const mom = as(await login('mom'));
  expect((await mom.send('POST', '/rules', { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto: true })).status).toBe(200);
  await postTwo(mom);
  return mom;
};

describe('changed messages through the bridge (T7.5)', () => {
  it('the update control marks what depends on it, and Apply posts a correction through the guard at level 4', async () => {
    await seedAt(nextMonday());
    const mom = await claimApples();
    const updated = await mom.send('POST', '/demo/update-group-message', {});
    expect(updated.status).toBe(200);
    const body = await json(updated);
    expect(body.messages).toEqual([{ id: 'grp-msg-1', version: 2 }, { id: 'grp-msg-2', version: 2 }]);
    expect(body.changes).toHaveLength(1);
    expect((await mom.send('POST', '/demo/update-group-message', {})).status).toBe(409);
    let state = await debugState();
    expect(state.items.filter(i => i.stale)).toHaveLength(3);

    // The screen shows the card; a teen can't decide; generic Undo is not offered for the marking.
    const screen = await json<{ jsonl: string }>(await mom.get('/screen/my-day'));
    expect(screen.jsonl).toContain('3 items depend on it');
    const maya = as(await login('maya'));
    expect((await maya.send('POST', `/source-changes/${body.changes[0]}/apply`, {})).status).toBe(403);
    expect((await mom.send('POST', `/source-changes/${body.changes[0]}/apply`, { extra: 1 })).status).toBe(400);
    expect((await mom.send('POST', `/source-changes/${body.changes[0]}/nope`, {})).status).toBe(404);

    const applied = await mom.send('POST', `/source-changes/${body.changes[0]}/apply`, {});
    expect(applied.status).toBe(200);
    expect(await json(applied)).toMatchObject({ ok: true, change: { status: 'applied' }, correction: { posted: true } });
    state = await debugState();
    expect(state.items.filter(i => i.stale)).toHaveLength(0);
    expect(state.services!.group.messages.at(-1)).toMatchObject({ replyKind: 'correction', text: '更正：诺娅妈妈认领改为橙子（原来是苹果，苹果已不需要）' });
    expect(state.groupClaims![0]).toMatchObject({ choice: 'oranges', messageVersion: 2 });
    // The correction was posted, so Undo is refused.
    expect((await mom.send('POST', `/source-changes/${body.changes[0]}/undo`, {})).status).toBe(409);
  });

  it('Keep, then Undo, through the bridge', async () => {
    await seedAt(nextMonday());
    const mom = await claimApples();
    const { changes } = await json(await mom.send('POST', '/demo/update-group-message', {}));
    expect((await mom.send('POST', `/source-changes/${changes[0]}/keep`, {})).status).toBe(200);
    expect((await debugState()).items.filter(i => i.stale)).toHaveLength(0);
    expect((await mom.send('POST', `/source-changes/${changes[0]}/undo`, {})).status).toBe(200);
    const state = await debugState();
    expect(state.items.filter(i => i.stale)).toHaveLength(3);
    expect(state.sourceChanges![0].status).toBe('pending');
  });

  it('the update control is demo only', async () => {
    await seedAt(nextMonday());
    const mom = await claimApples();
    process.env.HOMEMIND_DEMO = '0';
    expect((await mom.send('POST', '/demo/update-group-message', {})).status).toBe(404);
  });
});
