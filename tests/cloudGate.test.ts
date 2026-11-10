import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cloudConfigWarnings, cloudGate, cloudMode, isClosedInCloud } from '../server/cloud';
import { handleEpicRequest } from '../server/epic';
import { handleFridgeRequest } from '../server/fridge';
import { handleHomemindRequest, resetHomemindRuntime } from '../server/homemind';
import { handleOrbitRequest } from '../server/orbit';
import { handleRssRequest } from '../server/rss';

// T10.1: in cloud mode the Orbit, Epic and Fridge bridges answer 404 before they are reached, and the
// unauthenticated Homemind routes show less. Without HOMEMIND_CLOUD nothing changes.

const ENV_KEYS = [
  'HOMEMIND_CLOUD',
  'HOMEMIND_ENABLED',
  'HOMEMIND_SECRET',
  'HOMEMIND_DEMO',
  'HOMEMIND_DATA_FILE',
  'HOMEMIND_LLM',
  'ORBIT_GATEWAY_URL',
  'ORBIT_TOKEN',
  'ORBIT_BINDING_ID',
  'EPIC_REPLAY_URL',
  'EPIC_REPLAY_TOKEN',
  'FRIDGE2TABLE_URL'
] as const;
const saved: Record<string, string | undefined> = {};

let upstream: Server;
let upstreamUrl = '';
let upstreamHits: string[] = [];
let bridge: Server;
let base = '';
let dir = '';

/** The same order as `services/bridge/index.ts`. */
async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (cloudGate(request, response)) return;
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path === '/api/rss') return void (await handleRssRequest(request, response));
  if (path.startsWith('/api/epic/')) return void (await handleEpicRequest(request, response));
  if (path.startsWith('/api/fridge/')) return void (await handleFridgeRequest(request, response));
  if (path.startsWith('/api/homemind/') && (await handleHomemindRequest(request, response))) return;
  if (path.startsWith('/api/orbit/')) return void (await handleOrbitRequest(request, response));
  response.statusCode = 418;
  response.end('static');
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  upstream = createServer((req, res) => {
    upstreamHits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  bridge = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>(r => bridge.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'homemind-cloud-'));
  upstreamHits = [];
  process.env.HOMEMIND_ENABLED = '1';
  process.env.HOMEMIND_SECRET = 'test-secret-0123456789';
  process.env.HOMEMIND_DEMO = '1';
  process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
  process.env.HOMEMIND_LLM = 'fake';
  // Every other bridge points at the fake upstream, as if someone set them on the service by mistake.
  process.env.ORBIT_GATEWAY_URL = upstreamUrl;
  process.env.ORBIT_TOKEN = 'not-a-real-token';
  process.env.ORBIT_BINDING_ID = 'binding';
  process.env.EPIC_REPLAY_URL = upstreamUrl;
  process.env.EPIC_REPLAY_TOKEN = 'not-a-real-token';
  process.env.FRIDGE2TABLE_URL = upstreamUrl;
  resetHomemindRuntime();
});

afterEach(async () => {
  delete process.env.HOMEMIND_CLOUD;
  resetHomemindRuntime();
  await rm(dir, { recursive: true, force: true });
});

afterAll(() => {
  bridge?.close();
  upstream?.close();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const CLOSED_REQUESTS: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/orbit/health' },
  { method: 'GET', path: '/api/orbit/snapshot' },
  { method: 'POST', path: '/api/orbit/reset' },
  { method: 'GET', path: '/api/epic/health' },
  { method: 'GET', path: '/api/epic/past' },
  { method: 'POST', path: '/api/epic/runs' },
  { method: 'GET', path: '/api/fridge/health' },
  { method: 'POST', path: '/api/fridge/turn' },
  { method: 'GET', path: '/api/orbit' }
];

describe('cloud mode closes the other bridges (T10.1)', () => {
  it('the fake upstream is reachable when cloud mode is off (so the next test means something)', async () => {
    const fridge = await fetch(`${base}/api/fridge/health`);
    expect(fridge.status).toBe(200);
    expect(await fridge.json()).toMatchObject({ configured: true, reachable: true });
    await fetch(`${base}/api/epic/health`);
    expect(upstreamHits.length).toBeGreaterThanOrEqual(2);
  });

  it('every closed prefix answers 404 not_available and the upstream is never called', async () => {
    process.env.HOMEMIND_CLOUD = '1';
    for (const { method, path } of CLOSED_REQUESTS) {
      const res = await fetch(`${base}${path}`, { method, body: method === 'POST' ? '{}' : undefined });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_available' });
    }
    expect(upstreamHits).toEqual([]);
  });

  it('debug/state is 404 in cloud mode even with HOMEMIND_DEMO=1, and 200 without it', async () => {
    expect((await fetch(`${base}/api/homemind/debug/state`)).status).toBe(200);
    process.env.HOMEMIND_CLOUD = '1';
    const res = await fetch(`${base}/api/homemind/debug/state`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('health shows no model or PPMA detail in cloud mode', async () => {
    const local = (await (await fetch(`${base}/api/homemind/health`)).json()) as Record<string, unknown>;
    expect(local).toMatchObject({ enabled: true, ready: true, llm: 'fake', ppma: 'off', demo: true });
    process.env.HOMEMIND_CLOUD = '1';
    const cloud = (await (await fetch(`${base}/api/homemind/health`)).json()) as Record<string, unknown>;
    expect(cloud).toEqual({ enabled: true, ready: true, demo: true, cloud: true });
  });

  it('leaves Discover, Homemind and pages alone', async () => {
    process.env.HOMEMIND_CLOUD = '1';
    const rss = await fetch(`${base}/api/rss`);
    expect(rss.status).not.toBe(404);
    expect((await fetch(`${base}/api/homemind/members`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBe(418);
    expect((await fetch(`${base}/api/orbitx`)).status).toBe(418);
    expect(upstreamHits).toEqual([]);
  });
});

describe('cloud helpers', () => {
  it('cloudMode needs exactly 1', () => {
    expect(cloudMode({})).toBe(false);
    expect(cloudMode({ HOMEMIND_CLOUD: 'true' })).toBe(false);
    expect(cloudMode({ HOMEMIND_CLOUD: '1' })).toBe(true);
  });

  it('isClosedInCloud matches whole path segments only', () => {
    expect(isClosedInCloud('/api/orbit/health')).toBe(true);
    expect(isClosedInCloud('/api/fridge')).toBe(true);
    expect(isClosedInCloud('/api/fridgeX')).toBe(false);
    expect(isClosedInCloud('/api/rss')).toBe(false);
    expect(isClosedInCloud('/api/homemind/health')).toBe(false);
  });

  it('warns by name for each variable that should not be set, never with its value', () => {
    const env = { HOMEMIND_CLOUD: '1', ORBIT_TOKEN: 'sk-secret', PPMA_URL: 'http://x', FRIDGE2TABLE_URL: '', EPIC_REPLAY_URL: 'http://y', HOME: '/root' };
    const warnings = cloudConfigWarnings(env);
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain('ORBIT_TOKEN');
    expect(warnings.join('\n')).toContain('PPMA_URL');
    expect(warnings.join('\n')).toContain('EPIC_REPLAY_URL');
    expect(warnings.join('\n')).not.toContain('sk-secret');
    expect(cloudConfigWarnings({ ORBIT_TOKEN: 'x' })).toEqual([]);
  });

  it('the gate is registered before every other bridge, in both places', async () => {
    const root = resolve(__dirname, '..');
    const index = await readFile(join(root, 'services', 'bridge', 'index.ts'), 'utf8');
    const gateAt = index.indexOf('if (cloudGate(request, response)) return;');
    expect(gateAt).toBeGreaterThan(0);
    for (const branch of ["'/api/rss'", "'/api/epic/'", "'/api/fridge/'", "'/api/homemind/'", "'/api/orbit/'"]) {
      expect(index.indexOf(`url.pathname${branch === "'/api/rss'" ? ' === ' : '.startsWith('}${branch}`), branch).toBeGreaterThan(gateAt);
    }
    const vite = await readFile(join(root, 'vite.config.ts'), 'utf8');
    expect(vite).toMatch(/plugins:\s*\[cloudGatePlugin\(\),/);
  });
});
