import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_COOKIE,
  ACCESS_TTL_MS,
  accessKey,
  accessStartupErrors,
  accessWarnings,
  codeMatches,
  gatePage,
  handleAccessGate,
  readCookie,
  resetAccessGateForTests,
  signAccess,
  verifyAccess
} from '../server/accessGate';
import { cloudGate } from '../server/cloud';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime } from '../server/homemind';

// T10.3: the access code gate. Every request but /healthz needs the cookie; POST /access sets it.

const SECRET = 'test-secret-0123456789';
const CODE = 'family-demo-2026';
const ENV_KEYS = [
  'HOMEMIND_ENABLED',
  'HOMEMIND_SECRET',
  'HOMEMIND_DEMO',
  'HOMEMIND_DATA_FILE',
  'HOMEMIND_LLM',
  'HOMEMIND_TIMEZONE',
  'HOMEMIND_CLOUD',
  'HOMEMIND_ACCESS_CODE',
  'DATABASE_URL'
] as const;
const saved: Record<string, string | undefined> = {};

let server: Server;
let base = '';
let host = '';
let dir = '';

/** The same order as `services/bridge/index.ts`. */
async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path === '/healthz') {
    response.setHeader('content-type', 'application/json');
    return void response.end('{"ok":true}');
  }
  if (cloudGate(request, response)) return;
  if (await handleAccessGate(request, response)) return;
  if (path.startsWith('/api/homemind/') && (await handleHomemindRequest(request, response))) return;
  response.statusCode = 418;
  response.end('static');
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'homemind-access-'));
  process.env.HOMEMIND_ENABLED = '1';
  process.env.HOMEMIND_SECRET = SECRET;
  process.env.HOMEMIND_DEMO = '1';
  process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
  process.env.HOMEMIND_LLM = 'fake';
  process.env.HOMEMIND_TIMEZONE = 'Asia/Shanghai';
  process.env.HOMEMIND_ACCESS_CODE = CODE;
  delete process.env.HOMEMIND_CLOUD;
  delete process.env.DATABASE_URL;
  resetAccessGateForTests();
  resetHomemindRuntime();
});

afterEach(async () => {
  resetHomemindRuntime();
  await rm(dir, { recursive: true, force: true });
});

afterAll(() => {
  server?.close();
  resetAccessGateForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function postCode(code: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/access`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code }) });
}

async function cookieFor(code = CODE): Promise<string> {
  const res = await postCode(code);
  expect(res.status).toBe(200);
  const set = res.headers.get('set-cookie') ?? '';
  return set.split(';')[0];
}

describe('access code gate (T10.3)', () => {
  it('with the code unset there is no gate and nothing changes', async () => {
    delete process.env.HOMEMIND_ACCESS_CODE;
    expect((await fetch(`${base}/`)).status).toBe(418);
    const health = await fetch(`${base}/api/homemind/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('set-cookie')).toBeNull();
    // /access is just another path then.
    expect((await fetch(`${base}/access`)).status).toBe(418);
  });

  it('without the cookie: a page gets the gate page, the API gets 401, /healthz stays open', async () => {
    const page = await fetch(`${base}/family`);
    expect(page.status).toBe(401);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Access code');
    expect(html).toContain('访问码');
    expect(html).toContain('action="/access"');
    expect(html).not.toMatch(/<script|https?:\/\//);
    // Under `no-referrer` a browser posts the form with `Origin: null` (found in the T10.4 dry run).
    expect(page.headers.get('referrer-policy')).toBe('same-origin');

    const api = await fetch(`${base}/api/homemind/health`);
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: 'access_code_required' });
    const post = await fetch(`${base}/api/homemind/session`, { method: 'POST', body: '{"memberId":"mom"}' });
    expect(post.status).toBe(401);

    const healthz = await fetch(`${base}/healthz`);
    expect(healthz.status).toBe(200);
    expect((await fetch(`${base}/access`)).status).toBe(200);
  });

  it('a wrong code is refused, as JSON and from the form', async () => {
    const res = await postCode('not-the-code');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toMatchObject({ error: 'wrong_code' });

    const form = await fetch(`${base}/access`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=nope', redirect: 'manual' });
    expect(form.status).toBe(401);
    expect(await form.text()).toContain('role="alert"');
  });

  it('the right code sets an HttpOnly, SameSite=Lax, 7-day cookie, and it opens the app', async () => {
    const res = await postCode(CODE);
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(new RegExp(`^${ACCESS_COOKIE}=`));
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Path=/');
    expect(set).toContain(`Max-Age=${ACCESS_TTL_MS / 1000}`);
    expect(set).not.toContain('Secure');

    const cookie = set.split(';')[0];
    expect((await fetch(`${base}/family`, { headers: { cookie } })).status).toBe(418);
    expect((await fetch(`${base}/api/homemind/health`, { headers: { cookie } })).status).toBe(200);
  });

  it('the cookie is Secure behind https, and the form redirects home', async () => {
    const secure = await postCode(` ${CODE} `, { 'x-forwarded-proto': 'https' });
    expect(secure.headers.get('set-cookie')).toContain('Secure');

    const form = await fetch(`${base}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: `code=${encodeURIComponent(CODE)}`,
      redirect: 'manual'
    });
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/');
    expect(form.headers.get('set-cookie')).toContain(`${ACCESS_COOKIE}=`);
  });

  it('refuses an expired cookie, one signed with another key, and one made for an old code', async () => {
    const key = accessKey(SECRET, CODE);
    const expired = `${ACCESS_COOKIE}=${signAccess(key, Date.now() - ACCESS_TTL_MS - 60_000)}`;
    expect((await fetch(`${base}/api/homemind/health`, { headers: { cookie: expired } })).status).toBe(401);

    const otherKey = `${ACCESS_COOKIE}=${signAccess(accessKey('another-secret-0123456789', CODE))}`;
    expect((await fetch(`${base}/api/homemind/health`, { headers: { cookie: otherKey } })).status).toBe(401);

    const cookie = await cookieFor();
    process.env.HOMEMIND_ACCESS_CODE = 'a-new-code-2026';
    expect((await fetch(`${base}/api/homemind/health`, { headers: { cookie } })).status).toBe(401);

    const tampered = cookie.replace(/\.(.)/, (_m, c: string) => `.${c === 'A' ? 'B' : 'A'}`);
    process.env.HOMEMIND_ACCESS_CODE = CODE;
    expect((await fetch(`${base}/api/homemind/health`, { headers: { cookie: tampered } })).status).toBe(401);
    expect((await fetch(`${base}/api/homemind/health`, { headers: { cookie } })).status).toBe(200);
  });

  it('gives 429 after 10 wrong codes, even for the right one, per address', async () => {
    for (let i = 0; i < 10; i++) expect((await postCode(`wrong-${i}`)).status).toBe(401);
    const blocked = await postCode(CODE);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('900');
    expect(await blocked.json()).toMatchObject({ error: 'too_many_attempts' });
    const form = await fetch(`${base}/access`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${CODE}` });
    expect(form.status).toBe(429);
  });

  it('in cloud mode the address is the last x-forwarded-for entry, which a client cannot forge', async () => {
    process.env.HOMEMIND_CLOUD = '1';
    for (let i = 0; i < 10; i++) {
      // A client that rotates the first entry still lands in the same bucket.
      expect((await postCode(`wrong-${i}`, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` })).status).toBe(401);
    }
    expect((await postCode(CODE, { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })).status).toBe(429);
    expect((await postCode(CODE, { 'x-forwarded-for': '203.0.113.8' })).status).toBe(200);
  });

  it('refuses a cross-origin POST /access, and an opaque (null) origin', async () => {
    const res = await postCode(CODE, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await postCode(CODE, { origin: 'null' })).status).toBe(403);
  });

  it('the live stream without the cookie gets 401; with it, it opens', async () => {
    const without = await fetch(`${base}/api/homemind/events`);
    expect(without.status).toBe(401);
    expect(await without.json()).toMatchObject({ error: 'access_code_required' });

    const cookie = await cookieFor();
    const session = await fetch(`${base}/api/homemind/session`, { method: 'POST', headers: { cookie }, body: '{"memberId":"mom"}' });
    const { token } = (await session.json()) as { token: string };
    const abort = new AbortController();
    const stream = await fetch(`${base}/api/homemind/events`, { headers: { cookie, [SESSION_HEADER]: token }, signal: abort.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    abort.abort();
  });
});

describe('the member picker in cloud mode (P10)', () => {
  it('is served behind the access code', async () => {
    process.env.HOMEMIND_CLOUD = '1';
    const cookie = await cookieFor();
    expect((await fetch(`${base}/api/homemind/members`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/homemind/session`, { method: 'POST', headers: { cookie }, body: '{"memberId":"dad"}' })).status).toBe(200);
  });

  it('is not served in cloud mode without a code, nor once accounts exist', async () => {
    process.env.HOMEMIND_CLOUD = '1';
    delete process.env.HOMEMIND_ACCESS_CODE;
    expect((await fetch(`${base}/api/homemind/members`)).status).toBe(404);
    expect((await fetch(`${base}/api/homemind/session`, { method: 'POST', body: '{"memberId":"mom"}' })).status).toBe(404);

    process.env.HOMEMIND_ACCESS_CODE = CODE;
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    const cookie = await cookieFor();
    expect((await fetch(`${base}/api/homemind/members`, { headers: { cookie } })).status).toBe(404);
  });

  it('stays as before locally without a code', async () => {
    delete process.env.HOMEMIND_ACCESS_CODE;
    expect((await fetch(`${base}/api/homemind/members`)).status).toBe(200);
  });
});

describe('access gate helpers', () => {
  it('signs and verifies', () => {
    const key = accessKey(SECRET, CODE);
    const now = Date.parse('2026-11-10T12:00:00Z');
    const value = signAccess(key, now);
    expect(verifyAccess(value, key, now)).toBe(true);
    expect(verifyAccess(value, key, now + ACCESS_TTL_MS - 1)).toBe(true);
    expect(verifyAccess(value, key, now + ACCESS_TTL_MS + 1)).toBe(false);
    expect(verifyAccess(`${value}.x`, key, now)).toBe(false);
    expect(verifyAccess(undefined, key, now)).toBe(false);
    expect(verifyAccess(value, accessKey(SECRET, 'other-code-1'), now)).toBe(false);
  });

  it('compares codes exactly', () => {
    expect(codeMatches(CODE, CODE)).toBe(true);
    expect(codeMatches(CODE.toUpperCase(), CODE)).toBe(false);
    expect(codeMatches('', CODE)).toBe(false);
  });

  it('reads one cookie among others', () => {
    expect(readCookie('a=1; hm_access=xyz.abc; b=2', ACCESS_COOKIE)).toBe('xyz.abc');
    expect(readCookie('hm_accessx=1', ACCESS_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, ACCESS_COOKIE)).toBeUndefined();
  });

  it('refuses a short code or a missing secret at startup, by name only', () => {
    expect(accessStartupErrors({})).toEqual([]);
    expect(accessStartupErrors({ HOMEMIND_ACCESS_CODE: CODE, HOMEMIND_SECRET: SECRET })).toEqual([]);
    const short = accessStartupErrors({ HOMEMIND_ACCESS_CODE: 'short', HOMEMIND_SECRET: SECRET });
    expect(short).toHaveLength(1);
    expect(short[0]).toContain('HOMEMIND_ACCESS_CODE');
    expect(short[0]).not.toContain('short');
    expect(accessStartupErrors({ HOMEMIND_ACCESS_CODE: CODE })[0]).toContain('HOMEMIND_SECRET');
  });

  it('warns in cloud mode without a code', () => {
    expect(accessWarnings({ HOMEMIND_CLOUD: '1' })[0]).toContain('HOMEMIND_ACCESS_CODE');
    expect(accessWarnings({ HOMEMIND_CLOUD: '1', HOMEMIND_ACCESS_CODE: CODE })).toEqual([]);
    expect(accessWarnings({})).toEqual([]);
  });

  it('the gate page shows the right notice', () => {
    expect(gatePage()).not.toContain('role="alert"');
    expect(gatePage('wrong')).toContain('访问码不正确');
    expect(gatePage('too_many')).toContain('15');
  });

  it('is registered right after the cloud gate, in both places', async () => {
    const root = resolve(__dirname, '..');
    const index = await readFile(join(root, 'services', 'bridge', 'index.ts'), 'utf8');
    const cloudAt = index.indexOf('if (cloudGate(request, response)) return;');
    const accessAt = index.indexOf('if (await handleAccessGate(request, response)) return;');
    expect(accessAt).toBeGreaterThan(cloudAt);
    expect(index.indexOf("url.pathname === '/api/rss'")).toBeGreaterThan(accessAt);
    expect(index.indexOf("url.pathname === '/healthz'")).toBeLessThan(cloudAt);
    const vite = await readFile(join(root, 'vite.config.ts'), 'utf8');
    expect(vite).toMatch(/plugins:\s*\[cloudGatePlugin\(\),\s*accessGatePlugin\(\),/);
  });
});
