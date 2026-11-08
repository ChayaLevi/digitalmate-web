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

/** The next Friday at `time` (Shanghai), at least an hour away, as a demo clock time. */
function nextFriday(time: string): { date: string; ms: number } {
  const today = localParts(Date.now(), ZONE).date;
  for (let d = 0; d <= 8; d++) {
    const date = addDays(today, d);
    const ms = zonedToUtc(date, time, ZONE);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 5 && ms > Date.now() + HOUR) return { date, ms };
  }
  throw new Error('no Friday');
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
  dir = await mkdtemp(join(tmpdir(), 'homemind-rules-'));
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

describe('the Friday pizza rule through the bridge (T7.3)', () => {
  it('prepares the card in its lead time, resizes it when Mom becomes away, and a tap with the button token orders once', async () => {
    const friday = nextFriday('18:30');
    await seedAt(friday.ms - 25 * 60_000);
    const dad = as(await login('dad'));
    // The first request loads the state; the clock jump ticks, and the tick runs the rules.
    expect((await dad.send('POST', '/demo/clock', { minutes: 1 })).status).toBe(200);
    let state = await debugState();
    const first = state.actionCards.find(c => c.adapter === 'pizza' && c.status === 'pending');
    expect(first).toMatchObject({ id: `rule-friday-pizza-${friday.date}`, payload: { total: 178 } });

    // Mom adds a wedding that makes her away on Friday evening: the card is replaced at once.
    const mom = as(await login('mom'));
    const created = await mom.send('POST', '/items', {
      type: 'event',
      title: "Cousin's wedding",
      start: new Date(friday.ms - 6 * HOUR).toISOString(),
      end: new Date(friday.ms + 18 * HOUR).toISOString(),
      unavailableMemberIds: ['mom']
    });
    expect(created.status).toBe(200);
    state = await debugState();
    expect(state.actionCards.find(c => c.id === first!.id)).toMatchObject({ status: 'cancelled', executedBy: 'homemind' });
    const card = state.actionCards.find(c => c.adapter === 'pizza' && c.status === 'pending')!;
    expect(card.payload).toMatchObject({ total: 154 });
    expect(state.whys.find(w => w.id === card.whyId)).toMatchObject({ source: 'rule' });
    const why = await json(await dad.get(`/why/${card.whyId}`));
    expect(why.why.summary).toContain("Mom is away (Cousin's wedding)");
    expect(why.why.summaryZh).toContain('来自 Homemind 规则');

    // A teen sees no card and no button token.
    const maya = as(await login('maya'));
    expect(await confirmArgs(maya, card.id)).toBeUndefined();
    expect((await maya.send('POST', `/actions/${card.id}/confirm`, {})).status).toBe(403);

    // The button carries the token; without it the server refuses.
    const args = await confirmArgs(dad, card.id);
    expect(typeof args?.token).toBe('string');
    expect((await dad.send('POST', `/actions/${card.id}/confirm`, {})).status).toBe(400);
    const ok = await dad.send('POST', `/actions/${card.id}/confirm`, { token: args!.token });
    expect(ok.status).toBe(200);
    expect((await debugState()).services?.pizzaOrders).toMatchObject([{ total: 154, simulated: true }]);
    expect((await dad.send('POST', `/actions/${card.id}/confirm`, { token: args!.token })).status).toBe(409);
  });

  it('the demo control prepares the next card days ahead; parents only; and the card expires visibly', async () => {
    const friday = nextFriday('18:30');
    await seedAt(friday.ms - 3 * 24 * HOUR);
    const maya = as(await login('maya'));
    expect((await maya.send('POST', '/demo/run-rule', { ruleId: 'rule-friday-pizza' })).status).toBe(403);
    const mom = as(await login('mom'));
    expect((await mom.send('POST', '/demo/run-rule', { ruleId: 'Bad Id' })).status).toBe(400);
    expect((await mom.send('POST', '/demo/run-rule', { ruleId: 'nope' })).status).toBe(404);
    const run = await mom.send('POST', '/demo/run-rule', { ruleId: 'rule-friday-pizza' });
    expect(run.status).toBe(200);
    expect(await json(run)).toMatchObject({ ok: true, existing: false, run: { trigger: 'demo', outcome: 'prepared', date: friday.date } });
    expect(await json(await mom.send('POST', '/demo/run-rule', { ruleId: 'rule-friday-pizza' }))).toMatchObject({ existing: true });

    const rules = await json<{ jsonl: string }>(await mom.get('/screen/rules'));
    expect(rules.jsonl).toContain('Prepare the next card now (demo)');
    expect(rules.jsonl).toContain('card prepared');

    // Jump past the occurrence: the card expires, and My day says so.
    expect((await mom.send('POST', '/demo/clock', { minutes: 3 * 24 * 60 + 5 })).status).toBe(200);
    const state = await debugState();
    expect(state.actionCards[0]).toMatchObject({ status: 'expired' });
    expect((await json<{ jsonl: string }>(await mom.get('/screen/my-day'))).jsonl).toContain('expired: nobody tapped');
  });

  it('POST /rules: parents turn a rule off (its waiting card is withdrawn) and on; a teen cannot; create checks the order', async () => {
    const friday = nextFriday('18:30');
    await seedAt(friday.ms - 3 * 24 * HOUR);
    const mom = as(await login('mom'));
    await mom.send('POST', '/demo/run-rule', { ruleId: 'rule-friday-pizza' });
    const maya = as(await login('maya'));
    expect((await maya.send('POST', '/rules', { action: 'disable', id: 'rule-friday-pizza' })).status).toBe(403);
    expect((await mom.send('POST', '/rules', { action: 'disable', id: 'nope' })).status).toBe(404);
    expect((await mom.send('POST', '/rules', { action: 'disable', id: 'rule-friday-pizza', extra: 1 })).status).toBe(400);
    const off = await mom.send('POST', '/rules', { action: 'disable', id: 'rule-friday-pizza' });
    expect(await json(off)).toMatchObject({ ok: true, changed: true, rule: { enabled: false } });
    let state = await debugState();
    expect(state.actionCards[0]).toMatchObject({ status: 'cancelled', error: 'The rule was turned off' });
    expect(state.activity.at(-1)).toMatchObject({ kind: 'rule', note: 'disabled', actor: 'mom' });
    expect((await mom.send('POST', '/demo/run-rule', { ruleId: 'rule-friday-pizza' })).status).toBe(409);
    expect(await json(await mom.send('POST', '/rules', { action: 'enable', id: 'rule-friday-pizza' }))).toMatchObject({ changed: true, rule: { enabled: true } });
    expect((await mom.send('POST', '/rules', { action: 'create', title: 'Sushi', weekday: 0, time: '12:00', leadMinutes: 30, items: [{ id: 'sushi', qty: 1 }], maxPrice: 100 })).status).toBe(400);
    const made = await mom.send('POST', '/rules', { action: 'create', title: 'Sunday lunch', weekday: 0, time: '12:00', leadMinutes: 30, items: [{ id: 'veggie-m', qty: 1 }], maxPrice: 100 });
    expect(await json(made)).toMatchObject({ ok: true, rule: { id: 'rule-2', enabled: true } });
    state = await debugState();
    expect(state.rules).toHaveLength(2);
    const activity = await json<{ jsonl: string }>(await mom.get('/screen/activity'));
    expect(activity.jsonl).toContain('Mom created the rule');
    expect(activity.jsonl).toContain('Mom turned off the rule');
  });
});
