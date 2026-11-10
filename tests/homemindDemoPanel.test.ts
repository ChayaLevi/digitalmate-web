import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime } from '../server/homemind';
import { localParts } from '../server/homemind/clock';
import { machineTimezone } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';
import { FIXED_DEMO_START, useFixedTime, useRealTime } from './homemindFixedTime';

// T9.1: the demo panel's controls through the bridge: scene presets, "Jump to next reminder", the
// panel's "Prepare the next card now" (no rule named), and a rule's details, edits, delete and Undo.

const SECRET = 'test-secret-0123456789';
const ENV_KEYS = ['HOMEMIND_ENABLED', 'HOMEMIND_SECRET', 'HOMEMIND_DEMO', 'HOMEMIND_DATA_FILE', 'HOMEMIND_LLM'] as const;
const ZONE = machineTimezone();

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
  const headers = () => (token ? { [SESSION_HEADER]: token } : {});
  return {
    get: (path: string) => fetch(`${base}/api/homemind${path}`, { headers: headers() }),
    send: (method: string, path: string, body?: unknown) => fetch(`${base}/api/homemind${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) })
  };
}
const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;
const debugState = async () => json<HomemindState>(await as(undefined).get('/debug/state'));
const demoNow = (state: HomemindState) => Date.now() + state.clockOffsetMs;

/** The surface's components and data model, from a screen's JSONL. */
async function screen(api: ReturnType<typeof as>, path: string) {
  const body = await json<{ jsonl: string }>(await api.get(path));
  const lines = body.jsonl.split(/\r?\n/).map(l => JSON.parse(l) as Record<string, any>);
  const components = lines.flatMap(l => (l.updateComponents?.components ?? []) as Array<Record<string, any>>);
  const data = lines.find(l => l.updateDataModel)?.updateDataModel.value as Record<string, any>;
  return { components, data, text: body.jsonl };
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
  dir = await mkdtemp(join(tmpdir(), 'homemind-panel-'));
  process.env.HOMEMIND_ENABLED = '1';
  process.env.HOMEMIND_SECRET = SECRET;
  process.env.HOMEMIND_DEMO = '1';
  process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
  process.env.HOMEMIND_LLM = 'fake';
  // A late Tuesday evening: the hour when the old reset left "today's pickup" after midnight.
  useFixedTime(FIXED_DEMO_START - 16 * 3600 * 1000 - 30 * 60_000);
  resetHomemindRuntime();
});

afterEach(async () => {
  useRealTime();
  resetHomemindRuntime();
  await rm(dir, { recursive: true, force: true });
});

afterAll(() => {
  server?.close();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('scene presets (POST /demo/reset {preset})', () => {
  it('the real time is a Tuesday after 21:30', () => {
    expect(localParts(Date.now(), ZONE)).toMatchObject({ weekday: 2, time: '22:00' });
  });

  it('Scene 1 and 3: the next weekday 14:30, with today’s pickup at 16:30 and nobody owning it', async () => {
    const mom = as(await login('mom'));
    for (const preset of ['scene-1', 'scene-3']) {
      const res = await mom.send('POST', '/demo/reset', { preset });
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ ok: true, preset, timezone: ZONE });
      const state = await debugState();
      const now = localParts(demoNow(state), ZONE);
      expect(now).toMatchObject({ weekday: 3, time: '14:30' });
      const pickup = state.items.find(i => i.id === 'pickup-today');
      expect(localParts(Date.parse(pickup?.start as string), ZONE)).toMatchObject({ date: now.date, time: '16:30' });
      expect(pickup?.ownership.state).toBe('none');
      expect(state.groupPolicies ?? []).toEqual([]);
    }
  });

  it('Scene 2: Monday 10:00 with claims on (posting on its own), and the two messages claim apples', async () => {
    const mom = as(await login('mom'));
    expect((await mom.send('POST', '/demo/reset', { preset: 'scene-2' })).status).toBe(200);
    let state = await debugState();
    expect(localParts(demoNow(state), ZONE)).toMatchObject({ weekday: 1, time: '10:00' });
    expect(state.groupPolicies?.[0]).toMatchObject({ enabled: true, approvedBy: 'mom' });
    expect(Object.values(state.family.autonomy.byArea ?? {})).toEqual([4]);
    expect(state.services?.group.messages ?? []).toHaveLength(0);
    for (let i = 0; i < 2; i++) expect((await mom.send('POST', '/demo/post-group-message', {})).status).toBe(200);
    state = await debugState();
    expect(state.groupClaims?.[0]).toMatchObject({ status: 'claimed' });
  });

  it('Scene 4: Sunday 12:00; the panel’s "Prepare the next card now" (no rule named) prepares Friday’s card, and a tap orders at once (the shop is open)', async () => {
    const momToken = await login('mom');
    const mom = as(momToken);
    expect((await mom.send('POST', '/demo/reset', { preset: 'scene-4' })).status).toBe(200);
    const state = await debugState();
    expect(localParts(demoNow(state), ZONE)).toMatchObject({ weekday: 0, time: '12:00' });
    const run = await mom.send('POST', '/demo/run-rule', {});
    expect(run.status).toBe(200);
    expect((await json(run)).run).toMatchObject({ ruleId: 'rule-friday-pizza', outcome: 'prepared' });
    const card = (await debugState()).actionCards.find(c => c.adapter === 'pizza' && c.status === 'pending');
    expect(card).toBeDefined();
    const body = await json<{ confirmations?: Record<string, { token: string }> }>(await mom.get('/screen/my-day'));
    const token = body.confirmations?.[card?.id as string]?.token;
    expect(token).toBeTruthy();
    const confirmed = await mom.send('POST', `/actions/${card?.id}/confirm`, { token });
    expect(confirmed.status).toBe(200);
    expect((await debugState()).services?.pizzaOrders).toHaveLength(1);
  });

  it('Scene 5: Monday 19:30, claims on, the party and the 接龙 already in; the next message waits for the 20:00 summary, and "Jump to next reminder" goes there', async () => {
    const mom = as(await login('mom'));
    expect((await mom.send('POST', '/demo/reset', { preset: 'scene-5' })).status).toBe(200);
    let state = await debugState();
    expect(localParts(demoNow(state), ZONE)).toMatchObject({ weekday: 1, time: '19:30' });
    // The teacher's message, the 接龙, and Homemind's claim posted in the simulated group.
    expect(state.services?.group.messages.map(m => m.id).filter(id => id.startsWith('grp-msg-'))).toEqual(['grp-msg-1', 'grp-msg-2']);
    expect(state.groupClaims?.[0]).toMatchObject({ status: 'claimed' });
    const posted = await json(await mom.send('POST', '/demo/post-group-message', {}));
    expect(posted.judgment).toMatchObject({ tier: 'summary' });
    const jump = await mom.send('POST', '/demo/next-reminder', {});
    expect(jump.status).toBe(200);
    state = await debugState();
    const now = localParts(demoNow(state), ZONE);
    // The claim's preparations may have a reminder before 20:00; jump until the summary is sent.
    for (let i = 0; i < 5 && !(state.summaries ?? []).length; i++) {
      expect((await mom.send('POST', '/demo/next-reminder', {})).status).toBe(200);
      state = await debugState();
    }
    expect(now.weekday).toBe(1);
    expect((state.summaries ?? []).length).toBeGreaterThan(0);
  });

  it('refuses an unknown preset, a preset with a time, and a bad weekday; a weekday and time reset works', async () => {
    const mom = as(await login('mom'));
    expect((await mom.send('POST', '/demo/reset', { preset: 'scene-9' })).status).toBe(400);
    expect((await mom.send('POST', '/demo/reset', { preset: 'scene-1', time: '10:00' })).status).toBe(400);
    expect((await mom.send('POST', '/demo/reset', { weekday: 7, time: '10:00' })).status).toBe(400);
    expect((await mom.send('POST', '/demo/reset', { weekday: 3, time: '25:00' })).status).toBe(400);
    expect((await mom.send('POST', '/demo/reset', { extra: 1 })).status).toBe(400);
    expect((await mom.send('POST', '/demo/reset', { weekday: 3, time: '14:30' })).status).toBe(200);
    expect(localParts(demoNow(await debugState()), ZONE)).toMatchObject({ weekday: 3, time: '14:30' });
    // A plain reset is at the real time, as before.
    expect((await mom.send('POST', '/demo/reset', {})).status).toBe(200);
    expect((await debugState()).clockOffsetMs).toBe(0);
  });

  it('is demo-only', async () => {
    const mom = as(await login('mom'));
    process.env.HOMEMIND_DEMO = '0';
    expect((await mom.send('POST', '/demo/reset', { preset: 'scene-1' })).status).toBe(404);
    expect((await mom.send('POST', '/demo/next-reminder', {})).status).toBe(404);
  });
});

describe('"Jump to next reminder" (POST /demo/next-reminder)', () => {
  it('says so when nothing is due, and jumps to Dad’s reminder after Mom assigns him the pickup', async () => {
    const mom = as(await login('mom'));
    await mom.send('POST', '/demo/reset', { preset: 'scene-1' });
    const none = await mom.send('POST', '/demo/next-reminder', {});
    expect(none.status).toBe(409);
    expect((await json(none)).error).toBe('nothing_due');
    const pickup = (await debugState()).items.find(i => i.id === 'pickup-today');
    expect((await mom.send('POST', '/items/pickup-today/assign', { version: pickup?.version, ownerId: 'dad' })).status).toBe(200);
    const reminder = (await debugState()).reminders.find(r => r.itemId === 'pickup-today' && r.status === 'scheduled');
    expect(reminder?.fireAt).toBeTruthy();
    const jump = await json(await mom.send('POST', '/demo/next-reminder', {}));
    expect(jump).toMatchObject({ ok: true, kind: 'reminder' });
    expect(jump.delivered).toBeGreaterThan(0);
    expect(Date.parse(jump.now)).toBeGreaterThanOrEqual(Date.parse(reminder?.fireAt as string));
  });
});

describe('rule details and edits (T9.1)', () => {
  it('a parent opens a rule: trigger, limits, area, on, last and next run, Why, and the edit fields', async () => {
    const mom = as(await login('mom'));
    await mom.send('POST', '/demo/reset', { preset: 'scene-4' });
    await mom.send('POST', '/demo/run-rule', {});
    const list = await screen(mom, '/screen/rules?lang=en');
    expect(list.data.rules[0].open.args).toEqual({ verb: 'open-rule', ruleId: 'rule-friday-pizza' });
    const detail = await screen(mom, '/screen/rules?lang=en&id=rule-friday-pizza');
    const rows = Object.fromEntries((detail.data.details as Array<{ label: string; value: string }>).map(r => [r.label, r.value]));
    expect(rows.When).toBe('Every Fri at 18:30 · card prepared 30 min before');
    expect(rows.Limits).toBe('Price cap 250 CNY. Over it, no card is prepared.');
    expect(rows.Area).toBe('Food');
    expect(rows.Status).toBe('On');
    expect(rows['Last run']).toContain('card prepared');
    expect(rows['Next run']).toMatch(/^Fri \d\d-\d\d 18:30: the card is prepared at 18:00/);
    expect(detail.data.why[0].value).toContain('From the Homemind rule');
    expect(detail.text).toContain('Source: a Homemind rule, not PPMA');
    expect(detail.components.map(c => c.name).filter(Boolean)).toEqual(['ruleMaxPrice', 'ruleTime']);
    const zh = await screen(mom, '/screen/rules?lang=zh&id=rule-friday-pizza');
    expect(zh.text).toContain('每周五 18:30');
    expect((await mom.get('/screen/rules?id=Bad!')).status).toBe(400);
    expect((await screen(mom, '/screen/rules?lang=en&id=no-such-rule')).text).toContain('This rule is not here any more');
  });

  it('a teen sees the details with no edit fields and cannot change the rule', async () => {
    const maya = as(await login('maya'));
    const detail = await screen(maya, '/screen/rules?lang=en&id=rule-friday-pizza');
    expect(detail.components.some(c => c.name === 'ruleMaxPrice')).toBe(false);
    expect(detail.text).toContain('Only a parent can turn a rule');
    expect((await maya.send('POST', '/rules', { action: 'update', id: 'rule-friday-pizza', maxPrice: 100 })).status).toBe(403);
    expect((await maya.send('POST', '/rules', { action: 'delete', id: 'rule-friday-pizza' })).status).toBe(403);
  });

  it('a new cap below the order stops the card; a new time withdraws the waiting card and prepares one for the new time', async () => {
    const mom = as(await login('mom'));
    await mom.send('POST', '/demo/reset', { preset: 'scene-4' });
    await mom.send('POST', '/demo/run-rule', {});
    const first = (await debugState()).actionCards.find(c => c.adapter === 'pizza' && c.status === 'pending');
    expect((await mom.send('POST', '/rules', { action: 'update', id: 'rule-friday-pizza', time: '19:00' })).status).toBe(200);
    let state = await debugState();
    expect(state.rules[0].trigger.time).toBe('19:00');
    expect(state.actionCards.find(c => c.id === first?.id)?.status).toBe('cancelled');
    // Friday is days away (outside the lead time): the panel prepares the new card.
    await mom.send('POST', '/demo/run-rule', {});
    state = await debugState();
    const second = state.actionCards.find(c => c.adapter === 'pizza' && c.status === 'pending');
    expect(localParts(Date.parse(second?.payload.deliverAt as string), ZONE).time).toBe('19:00');
    expect((await mom.send('POST', '/rules', { action: 'update', id: 'rule-friday-pizza', maxPrice: 100 })).status).toBe(200);
    await mom.send('POST', '/demo/run-rule', {});
    state = await debugState();
    expect(state.actionCards.some(c => c.adapter === 'pizza' && c.status === 'pending')).toBe(false);
    expect(state.ruleRuns?.[state.ruleRuns.length - 1]).toMatchObject({ outcome: 'stopped', reason: 'over_cap' });
    const activity = await screen(mom, '/screen/activity?lang=en');
    expect(activity.text).toContain('Mom changed the rule “Friday pizza night”');
    expect((await mom.send('POST', '/rules', { action: 'update', id: 'rule-friday-pizza', maxPrice: 0 })).status).toBe(400);
    expect((await mom.send('POST', '/rules', { action: 'update', id: 'rule-friday-pizza', time: '7pm' })).status).toBe(400);
    expect((await mom.send('POST', '/rules', { action: 'update', id: 'rule-friday-pizza' })).status).toBe(400);
  });

  it('delete withdraws the waiting card and Undo puts the rule back, once', async () => {
    const mom = as(await login('mom'));
    await mom.send('POST', '/demo/reset', { preset: 'scene-4' });
    await mom.send('POST', '/demo/run-rule', {});
    const deleted = await mom.send('POST', '/rules', { action: 'delete', id: 'rule-friday-pizza' });
    expect(deleted.status).toBe(200);
    const { activityId } = await json(deleted);
    let state = await debugState();
    expect(state.rules).toHaveLength(0);
    expect(state.actionCards.some(c => c.status === 'pending')).toBe(false);
    expect((await screen(mom, '/screen/activity?lang=en')).text).toContain('Mom deleted the rule “Friday pizza night”');
    expect((await mom.send('POST', '/demo/run-rule', {})).status).toBe(409);
    const restored = await mom.send('POST', '/rules', { action: 'restore', activityId });
    expect(restored.status).toBe(200);
    state = await debugState();
    expect(state.rules.map(r => r.id)).toEqual(['rule-friday-pizza']);
    expect((await mom.send('POST', '/rules', { action: 'restore', activityId })).status).toBe(409);
    expect((await screen(mom, '/screen/activity?lang=zh')).text).toContain('恢复了规则');
  });
});
