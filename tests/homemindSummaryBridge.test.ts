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
  dir = await mkdtemp(join(tmpdir(), 'homemind-summary-'));
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

describe('judgment and the evening summary through the bridge (T8.2)', () => {
  it('the "不着急" note waits for 20:00 with its reason; the clock crosses 20:00 and the summary carries it', async () => {
    const monday = nextMonday();
    await seedAt(monday);
    const mom = as(await login('mom'));
    const maya = as(await login('maya'));

    const posted = [];
    for (let n = 0; n < 3; n++) posted.push(await json(await mom.post('/demo/post-group-message')));
    expect(posted.map(p => p.judgment)).toEqual([
      { tier: 'timed', reason: 'soon' },
      { tier: 'timed', reason: 'sign-up' },
      { tier: 'summary', reason: 'not-urgent', summaryAt: new Date(zonedToUtc(localParts(monday, ZONE).date, '20:00', ZONE)).toISOString() }
    ]);
    const state = await debugState();
    expect(state.messageJudgments?.map(j => [j.messageId, j.tier, j.alertedIds ?? null])).toEqual([
      ['grp-msg-1', 'timed', ['mom', 'dad']],
      ['grp-msg-2', 'timed', ['mom', 'dad']],
      ['grp-msg-3', 'summary', null]
    ]);

    // Mom's My day says it waits, and why; Maya's says nothing about the parents' group.
    const momDay = await json<{ jsonl: string }>(await mom.get('/screen/my-day'));
    expect(momDay.jsonl).toContain("Waiting for tonight's summary");
    expect(momDay.jsonl).toContain('the sender wrote “不着急” (not urgent)');
    const mayaDay = await json<{ jsonl: string }>(await maya.get('/screen/my-day'));
    expect(mayaDay.jsonl).not.toContain('不着急');

    // A preview before 20:00.
    const preview = await json<{ jsonl: string }>(await mom.get('/screen/summary'));
    expect(preview.jsonl).toContain('Preview: it goes out at 20:00 tonight.');
    expect(preview.jsonl).toContain('Messages waiting for tonight');

    // The clock crosses 20:00: the summary goes out once, and the note is in it.
    const jumped = await json(await mom.post('/demo/clock', { minutes: 10 * 60 + 1 }));
    expect(jumped.delivered).toBeGreaterThanOrEqual(3);
    const after = await debugState();
    const date = localParts(monday, ZONE).date;
    expect(after.summaries?.map(s => s.id)).toEqual([`sum-${date}`]);
    expect(after.messageJudgments?.find(j => j.messageId === 'grp-msg-3')?.deliveredIn).toBe(`sum-${date}`);
    const summary = await json<{ jsonl: string }>(await mom.get('/screen/summary?lang=zh'));
    expect(summary.jsonl).toContain('已于今天 20:01送达');
    expect(summary.jsonl).toContain('等到摘要再看的消息');
    expect(summary.jsonl).toContain('秋游回执');
    const momDayAfter = await json<{ jsonl: string }>(await mom.get('/screen/my-day'));
    expect(momDayAfter.jsonl).not.toContain("Waiting for tonight's summary");
    const mayaSummary = await json<{ jsonl: string }>(await maya.get('/screen/summary'));
    expect(mayaSummary.jsonl).not.toContain('秋游');
    expect(mayaSummary.jsonl).toContain('What you need to do');

    // The week ahead: a teen gets no trace of the Parents-only meeting.
    const week = await json<{ jsonl: string }>(await maya.get('/screen/summary?period=week'));
    expect(week.jsonl).toContain('The week ahead');
    expect(week.jsonl).not.toContain('counselor');
    const momWeek = await json<{ jsonl: string }>(await mom.get('/screen/summary?period=week'));
    expect(momWeek.jsonl).toContain("Meeting with Maya's school counselor");
  });

  it('Scene 5 correction: the Memory form for one preference, saved by id, changes what the claim choices show', async () => {
    await seedAt(nextMonday());
    const mom = as(await login('mom'));
    const form = await json<{ jsonl: string }>(await mom.get('/screen/memory?id=pref-noa-cake'));
    expect(form.jsonl).toContain('Correct a saved preference');
    expect(form.jsonl).toContain('"default":"For kindergarten parties, bake a cake"');
    expect((await mom.get('/screen/memory?id=BAD!')).status).toBe(400);
    const saved = await mom.post('/preferences', { id: 'pref-noa-cake', text: 'For kindergarten parties, bring cookies', reason: 'Noa likes to pick them herself', strength: 'soft', aboutMemberId: 'noa', scope: 'kindergarten-party' });
    expect(saved.status).toBe(200);
    const prefs = (await debugState()).preferences;
    expect(prefs.find(p => p.id === 'pref-noa-cake')).toMatchObject({ text: 'For kindergarten parties, bring cookies', reason: 'Noa likes to pick them herself' });
    expect(prefs.find(p => p.id === 'pref-noa-cake')?.textZh).toBeUndefined();
    // The next sign-up (T7.4) reads the preferences: with claims on, Homemind now claims cookies, not apples.
    expect((await mom.post('/rules', { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto: true })).status).toBe(200);
    for (let n = 0; n < 2; n++) await mom.post('/demo/post-group-message');
    const day = await json<{ jsonl: string }>(await mom.get('/screen/my-day'));
    expect(day.jsonl).toContain('Signed up: 饼干 (cookies)');
    expect(day.jsonl).not.toContain('bake a cake');
    // The claim's "Why?" names the corrected preference.
    const whys = (await debugState()).whys;
    expect(whys.some(w => w.summary.includes('A saved preference points to it: “For kindergarten parties, bring cookies”'))).toBe(true);
  });

  it('the summary screen needs a session, and with the flag off it does not exist', async () => {
    await seedAt(nextMonday());
    expect((await as(undefined).get('/screen/summary')).status).toBe(401);
    process.env.HOMEMIND_ENABLED = '';
    resetHomemindRuntime();
    const res = await fetch(`${base}/api/homemind/screen/summary`);
    expect(res.status).toBe(418);
  });
});
