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
  dir = await mkdtemp(join(tmpdir(), 'homemind-group-'));
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

describe('sign-up claims through the bridge (T7.4)', () => {
  it('off by default: the sign-up arrives and nothing is claimed', async () => {
    await seedAt(nextMonday());
    const mom = as(await login('mom'));
    const second = await postTwo(mom);
    expect(second.claims).toEqual([]);
    const state = await debugState();
    expect(state.groupClaims ?? []).toEqual([]);
    expect(state.actionCards).toEqual([]);
  });

  it('a teen cannot turn it on; a parent turns it on at level 4, the sign-up is claimed at once, and Change posts a correction', async () => {
    await seedAt(nextMonday());
    const maya = as(await login('maya'));
    expect((await maya.send('POST', '/rules', { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto: true })).status).toBe(403);
    expect((await maya.send('POST', '/rules', { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, extra: 1 })).status).toBe(400);
    const mom = as(await login('mom'));
    const on = await mom.send('POST', '/rules', { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto: true });
    expect(on.status).toBe(200);
    expect(await json(on)).toMatchObject({ ok: true, changed: true, policy: { enabled: true, approvedBy: 'mom' }, claims: [] });

    const second = await postTwo(mom);
    expect(second.claims).toEqual([{ id: 'claim-grp-msg-2', status: 'claimed', choice: 'apples' }]);
    let state = await debugState();
    const claim = state.groupClaims!.find(c => c.id === 'claim-grp-msg-2')!;
    expect(state.services!.group.messages.at(-1)).toMatchObject({ from: 'family', replyKind: 'claim' });
    expect(claim.preparationIds).toHaveLength(2);
    expect(state.items.find(i => i.id === claim.eventId)).toMatchObject({ titleZh: '幼儿园秋季美食派对', status: 'open' });

    // My day carries the claim and the Change buttons; a teen's does not have the buttons.
    const momDay = await json<{ jsonl: string }>(await mom.get('/screen/my-day'));
    expect(momDay.jsonl).toContain('"verb":"group-change"');
    const mayaDay = await json<{ jsonl: string }>(await maya.get('/screen/my-day'));
    expect(mayaDay.jsonl).toContain('Signed up');
    expect(mayaDay.jsonl).not.toContain('"verb":"group-change"');

    expect((await maya.send('POST', '/group-claims/claim-grp-msg-2/change', { option: 'cake' })).status).toBe(403);
    expect((await mom.send('POST', '/group-claims/claim-grp-msg-2/change', { option: 'Bad Id!' })).status).toBe(400);
    expect((await mom.send('POST', '/group-claims/claim-grp-msg-2/change', { option: 'bananas' })).status).toBe(409);
    expect((await mom.send('POST', '/group-claims/nope/change', { option: 'cake' })).status).toBe(404);
    const dad = as(await login('dad'));
    const changed = await dad.send('POST', '/group-claims/claim-grp-msg-2/change', { option: 'cake' });
    expect(changed.status).toBe(200);
    expect(await json(changed)).toMatchObject({ ok: true, posted: true, claim: { choice: 'cake' } });
    state = await debugState();
    expect(state.services!.group.messages.at(-1)).toMatchObject({ replyKind: 'correction', text: '更正：诺娅妈妈认领改为蛋糕（原来是苹果）' });
    const after = state.groupClaims!.find(c => c.id === 'claim-grp-msg-2')!;
    expect(after.preparationIds).toHaveLength(3);
    for (const id of claim.preparationIds!) expect(state.items.find(i => i.id === id)?.status).toBe('cancelled');
  });

  it('at level 3 the claim waits; the Confirm button carries the token, and the tap posts it and fills the board', async () => {
    await seedAt(nextMonday());
    const mom = as(await login('mom'));
    expect((await mom.send('POST', '/rules', { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto: false })).status).toBe(200);
    const second = await postTwo(mom);
    expect(second.claims).toEqual([{ id: 'claim-grp-msg-2', status: 'waiting', choice: 'apples' }]);
    let state = await debugState();
    const cardId = state.groupClaims![0].cardId!;
    expect(state.actionCards.find(c => c.id === cardId)?.status).toBe('pending');
    const dad = as(await login('dad'));
    const args = await confirmArgs(dad, cardId);
    expect(typeof args?.token).toBe('string');
    const tapped = await dad.send('POST', `/actions/${cardId}/confirm`, { token: args!.token });
    expect(tapped.status).toBe(200);
    state = await debugState();
    expect(state.groupClaims![0]).toMatchObject({ status: 'claimed', choice: 'apples' });
    expect(state.groupClaims![0].preparationIds).toHaveLength(2);
  });

  it('a sign-up posted before the setting was turned on is looked at when it is turned on', async () => {
    await seedAt(nextMonday());
    const mom = as(await login('mom'));
    await postTwo(mom);
    const on = await json(await mom.send('POST', '/rules', { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto: true }));
    expect(on.claims).toEqual([{ id: 'claim-grp-msg-2', status: 'claimed', choice: 'apples' }]);
  });
});
