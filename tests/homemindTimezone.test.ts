import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, homemindStartupErrors, resetHomemindRuntime } from '../server/homemind';
import { localParts } from '../server/homemind/clock';
import { PRESETS, PRESET_IDS } from '../server/homemind/presets';
import { isValidTimezone, machineTimezone, timezoneSetting } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';

// T10.2: the family's zone comes from HOMEMIND_TIMEZONE. Render runs in UTC, so the test runs the bridge
// with the process in UTC and checks that the seed's "today" and every preset are on the Shanghai day.

const ENV_KEYS = ['TZ', 'HOMEMIND_ENABLED', 'HOMEMIND_SECRET', 'HOMEMIND_DEMO', 'HOMEMIND_DATA_FILE', 'HOMEMIND_LLM', 'HOMEMIND_TIMEZONE', 'HOMEMIND_CLOUD'] as const;
const saved: Record<string, string | undefined> = {};
const SHANGHAI = 'Asia/Shanghai';
/** Wednesday 18:30 in UTC is already Thursday 02:30 in Shanghai: the two zones disagree on "today". */
const WED_EVENING_UTC = Date.parse('2026-11-11T18:30:00Z');

let server: Server;
let base = '';
let dir = '';

async function login(memberId: string): Promise<string> {
  const res = await fetch(`${base}/api/homemind/session`, { method: 'POST', body: JSON.stringify({ memberId }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function state(): Promise<HomemindState> {
  const res = await fetch(`${base}/api/homemind/debug/state`);
  expect(res.status).toBe(200);
  return (await res.json()) as HomemindState;
}

const startOf = (s: HomemindState, id: string) => Date.parse(s.items.find(i => i.id === id)?.start ?? 'missing');

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  server = createServer((req, res) => {
    handleHomemindRequest(req, res).then(handled => {
      if (!handled) {
        res.statusCode = 418;
        res.end();
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'homemind-tz-'));
  process.env.TZ = 'UTC';
  process.env.HOMEMIND_ENABLED = '1';
  process.env.HOMEMIND_SECRET = 'test-secret-0123456789';
  process.env.HOMEMIND_DEMO = '1';
  process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
  process.env.HOMEMIND_LLM = 'fake';
  delete process.env.HOMEMIND_TIMEZONE;
  delete process.env.HOMEMIND_CLOUD;
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(WED_EVENING_UTC);
  resetHomemindRuntime();
});

afterEach(async () => {
  vi.useRealTimers();
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

describe('the family time zone on a UTC machine (T10.2)', () => {
  it('the process really runs in UTC here', () => {
    expect(machineTimezone()).toBe('UTC');
  });

  it('without HOMEMIND_TIMEZONE (local mode) the seed uses the machine zone, as before', async () => {
    const s = await state();
    expect(s.family.timezone).toBe('UTC');
    // "Tomorrow's piano" is tomorrow in UTC: Thursday the 12th.
    expect(localParts(startOf(s, 'piano-tomorrow'), 'UTC')).toMatchObject({ date: '2026-11-12', time: '17:00' });
  });

  it("with HOMEMIND_TIMEZONE=Asia/Shanghai the seed's today is the Shanghai day", async () => {
    process.env.HOMEMIND_TIMEZONE = SHANGHAI;
    const s = await state();
    expect(s.family.timezone).toBe(SHANGHAI);
    expect(localParts(Date.now(), SHANGHAI).date).toBe('2026-11-12');
    // Today's pickup is on Thursday in Shanghai, and tomorrow's piano is Friday 17:00 there.
    expect(localParts(startOf(s, 'pickup-today'), SHANGHAI).date).toBe('2026-11-12');
    expect(localParts(startOf(s, 'piano-tomorrow'), SHANGHAI)).toMatchObject({ date: '2026-11-13', time: '17:00' });
  });

  it('every preset lands on its weekday and time in Shanghai', async () => {
    process.env.HOMEMIND_TIMEZONE = SHANGHAI;
    const token = await login('mom');
    for (const id of PRESET_IDS) {
      const res = await fetch(`${base}/api/homemind/demo/reset`, { method: 'POST', headers: { [SESSION_HEADER]: token }, body: JSON.stringify({ preset: id }) });
      expect(res.status, id).toBe(200);
      const body = (await res.json()) as { now: string; timezone: string; offsetMs: number };
      expect(body.timezone).toBe(SHANGHAI);
      const s = await state();
      const target = s.seededAt ? Date.parse(s.seededAt) + s.clockOffsetMs : Date.parse(body.now);
      const local = localParts(target, SHANGHAI);
      expect(PRESETS[id].weekdays, id).toContain(local.weekday);
      expect(local.time, id).toBe(PRESETS[id].time);
      // The seed made at that moment is on that Shanghai day too.
      expect(localParts(startOf(s, 'pickup-today'), SHANGHAI).date, id).toBe(local.date);
    }
  });

  it('a plain reset keeps the family zone', async () => {
    process.env.HOMEMIND_TIMEZONE = SHANGHAI;
    const token = await login('mom');
    expect((await fetch(`${base}/api/homemind/demo/reset`, { method: 'POST', headers: { [SESSION_HEADER]: token }, body: '{}' })).status).toBe(200);
    expect((await state()).family.timezone).toBe(SHANGHAI);
  });

  it('a saved family in another zone keeps its own and logs one warning', async () => {
    await state(); // seeded in UTC
    resetHomemindRuntime();
    process.env.HOMEMIND_TIMEZONE = SHANGHAI;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await state()).family.timezone).toBe('UTC');
      await state();
      const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('time zone'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('UTC');
      expect(lines[0]).toContain(SHANGHAI);
    } finally {
      warn.mockRestore();
    }
  });

  it('an invalid zone is refused with the variable named', async () => {
    process.env.HOMEMIND_TIMEZONE = 'Mars/Olympus';
    const res = await fetch(`${base}/api/homemind/members`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain('HOMEMIND_TIMEZONE');
  });

  it('cloud mode without a zone is refused, never a silent UTC', async () => {
    process.env.HOMEMIND_CLOUD = '1';
    const res = await fetch(`${base}/api/homemind/members`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain('HOMEMIND_TIMEZONE');
  });
});

describe('timezoneSetting and the startup check', () => {
  it('reads, defaults and refuses', () => {
    expect(isValidTimezone(SHANGHAI)).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(timezoneSetting(' Asia/Shanghai ', true)).toEqual({ ok: true, zone: SHANGHAI, source: 'env' });
    expect(timezoneSetting(undefined, false)).toEqual({ ok: true, zone: machineTimezone(), source: 'machine' });
    expect(timezoneSetting('', true)).toMatchObject({ ok: false });
    expect(timezoneSetting('Nowhere', false)).toMatchObject({ ok: false });
  });

  it('stops the start only when Homemind or cloud mode is on', () => {
    expect(homemindStartupErrors({})).toEqual([]);
    expect(homemindStartupErrors({ HOMEMIND_TIMEZONE: 'Nowhere' })).toEqual([]);
    expect(homemindStartupErrors({ HOMEMIND_ENABLED: '1' })).toEqual([]);
    expect(homemindStartupErrors({ HOMEMIND_ENABLED: '1', HOMEMIND_TIMEZONE: 'Nowhere' })[0]).toContain('HOMEMIND_TIMEZONE');
    expect(homemindStartupErrors({ HOMEMIND_ENABLED: '1', HOMEMIND_CLOUD: '1' })[0]).toContain('HOMEMIND_TIMEZONE');
    expect(homemindStartupErrors({ HOMEMIND_ENABLED: '1', HOMEMIND_CLOUD: '1', HOMEMIND_TIMEZONE: SHANGHAI })).toEqual([]);
  });
});
