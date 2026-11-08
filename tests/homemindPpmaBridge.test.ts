import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime } from '../server/homemind';
import type { PpmaMessage } from '../server/homemind/ppma';
import type { Item } from '../server/homemind/types';
import { createFakePpma } from '../scripts/fake-ppma.mjs';

const SECRET = 'test-secret-0123456789';
const OWNER = 'bridge-owner-token-0123456789abcdef01';
const ENV_KEYS = ['HOMEMIND_ENABLED', 'HOMEMIND_SECRET', 'HOMEMIND_DEMO', 'HOMEMIND_DATA_FILE', 'HOMEMIND_LLM', 'PPMA_URL', 'PPMA_OWNER_TOKEN', 'PPMA_OWNER_TOKEN_FILE', 'PPMA_SPACE', 'PPMA_TIMEOUT_MS'] as const;

let server: Server;
let base = '';
let dir = '';
let fake: ReturnType<typeof createFakePpma> | undefined;
const saved: Record<string, string | undefined> = {};

async function until<T>(check: () => T | undefined | false | null | Promise<T | undefined | false | null>, timeoutMs = 6000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 25));
  }
}

async function login(memberId: string): Promise<string> {
  const res = await fetch(`${base}/api/homemind/session`, { method: 'POST', body: JSON.stringify({ memberId }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const get = (token: string | undefined, path: string) => fetch(`${base}/api/homemind${path}`, { headers: token ? { [SESSION_HEADER]: token } : {} });
const send = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}/api/homemind${path}`, { method, headers: { [SESSION_HEADER]: token }, body: body === undefined ? undefined : JSON.stringify(body) });
const health = async () => (await (await get(undefined, '/health')).json()) as { ppma: string; ppmaQueued?: number };

async function item(token: string, id: string): Promise<Item> {
  const body = (await (await get(token, '/screen/family')).json()) as { view: { items: Item[] } };
  return body.view.items.find(i => i.id === id) as Item;
}

const received = (): PpmaMessage[] => (fake ? fake.received() : []);

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
  dir = await mkdtemp(join(tmpdir(), 'homemind-ppma-bridge-'));
  process.env.HOMEMIND_ENABLED = '1';
  process.env.HOMEMIND_SECRET = SECRET;
  process.env.HOMEMIND_DEMO = '1';
  process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
  process.env.HOMEMIND_LLM = 'fake';
  for (const key of ['PPMA_URL', 'PPMA_OWNER_TOKEN', 'PPMA_OWNER_TOKEN_FILE', 'PPMA_SPACE', 'PPMA_TIMEOUT_MS'] as const) delete process.env[key];
  resetHomemindRuntime();
});

afterEach(async () => {
  resetHomemindRuntime();
  // Let the dropped client stop before its server goes.
  await new Promise(r => setTimeout(r, 50));
  await fake?.close();
  fake = undefined;
  await rm(dir, { recursive: true, force: true });
});

afterAll(() => {
  server?.close();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function withFake(): Promise<void> {
  fake = createFakePpma({ ownerToken: OWNER, heartbeatMs: 500 });
  process.env.PPMA_URL = await fake.listen(0);
  process.env.PPMA_OWNER_TOKEN = OWNER;
}

describe('PPMA off', () => {
  it('says off, and nothing about PPMA changes the board', async () => {
    expect((await health()).ppma).toBe('off');
    const mom = await login('mom');
    const screen = (await (await get(mom, '/screen/my-day')).json()) as { ppma: string };
    expect(screen.ppma).toBe('off');
  });
});

describe('PPMA through the bridge (fake PPMA)', () => {
  it('connects, and reports a board change with names', async () => {
    await withFake();
    await until(async () => (await health()).ppma === 'ok');
    const mom = await login('mom');
    const pickup = await item(mom, 'pickup-today');
    expect((await send(mom, 'POST', '/items/pickup-today/assign', { version: pickup.version, ownerId: 'dad' })).status).toBe(200);
    const report = await until(() => received().find(m => m.type === 'homemind.item_changed' && m.payload.item_id === 'pickup-today'));
    expect(report.payload).toMatchObject({ change: 'changed', owner_id: 'dad', owner_name: 'Dad', actor_id: 'mom' });
    expect(report.source.app).toBe('homemind');
  });

  it('never sends a Parents-only item to PPMA', async () => {
    await withFake();
    await until(async () => (await health()).ppma === 'ok');
    const mom = await login('mom');
    const meeting = await item(mom, 'counselor-meeting');
    expect((await send(mom, 'PATCH', '/items/counselor-meeting', { version: meeting.version, patch: { notes: 'Ask about the exam' } })).status).toBe(200);
    expect((await send(mom, 'POST', '/items', { type: 'event', title: 'Parents night out', start: '2026-12-01T12:00:00Z', end: '2026-12-01T15:00:00Z', visibility: 'parents' })).status).toBe(200);
    // A marker change afterwards: once it arrives, everything before it has been sent.
    const books = await item(mom, 'library-books');
    await send(mom, 'POST', '/items/library-books/claim', { version: books.version });
    await until(() => received().some(m => m.payload.item_id === 'library-books'));
    const all = JSON.stringify(received());
    expect(all).not.toContain('counselor');
    expect(all).not.toContain('Parents night out');
    expect(all).not.toContain('Ask about the exam');
  });

  it('reports a saved preference with its reason', async () => {
    await withFake();
    const mom = await login('mom');
    const res = await send(mom, 'POST', '/preferences', { text: 'Maya prefers rice to noodles', reason: 'she says noodles upset her stomach', aboutMemberId: 'maya', strength: 'soft' });
    expect(res.status).toBe(200);
    const report = await until(() => received().find(m => m.type === 'homemind.preference_stated'));
    expect(report.payload).toMatchObject({ change: 'added', about_member_id: 'maya', reason: 'she says noodles upset her stomach', strength: 'soft', actor_id: 'mom' });
  });

  it('answers get_board from PPMA with the family-wide board and a proposal with a plain rejection', async () => {
    await withFake();
    await until(async () => (await health()).ppma === 'ok');
    const board = fake!.issueCommand('homemind.get_board', {});
    const proposal = fake!.issueCommand('homemind.propose_item', { title: 'Buy cut fruit' });
    const outcomes = await until(() => {
      const list = received().filter(m => m.type === 'command.outcome');
      return list.length >= 2 ? list : null;
    });
    const boardOutcome = outcomes.find(o => o.causation_id === board.message.id)!;
    expect(boardOutcome.payload.status).toBe('executed');
    expect(JSON.stringify(boardOutcome.payload.result)).toContain('pickup-today');
    expect(JSON.stringify(boardOutcome.payload.result)).not.toContain('counselor');
    const proposalOutcome = outcomes.find(o => o.causation_id === proposal.message.id)!;
    expect(proposalOutcome.payload).toMatchObject({ status: 'rejected', path: 'auto' });
    // Nothing was added to the board.
    const mom = await login('mom');
    const view = (await (await get(mom, '/screen/family')).json()) as { view: { items: Item[] } };
    expect(view.view.items.some(i => i.title === 'Buy cut fruit')).toBe(false);
  });

  it('keeps the PPMA queue and position beside the state file, and a demo reset leaves them', async () => {
    await withFake();
    await until(async () => (await health()).ppma === 'ok');
    fake!.issueCommand('homemind.get_board', {});
    await until(() => received().some(m => m.type === 'command.outcome'));
    const file = join(dir, 'state.ppma.json');
    const syncState = await until(async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        return parsed.handled?.length === 1 && parsed.lastStreamId ? parsed : null;
      } catch {
        return null;
      }
    });
    const mom = await login('mom');
    expect((await send(mom, 'POST', '/demo/reset', {})).status).toBe(200);
    const after = JSON.parse(await readFile(file, 'utf8'));
    expect(after.handled).toEqual(syncState.handled);
    expect(JSON.stringify(after)).not.toContain(OWNER);
  });
});

describe('PPMA down', () => {
  it('a user action still works at once; PPMA shows offline and the report waits in the queue', async () => {
    process.env.PPMA_URL = 'http://127.0.0.1:9';
    process.env.PPMA_OWNER_TOKEN = OWNER;
    process.env.PPMA_TIMEOUT_MS = '1000';
    const mom = await login('mom');
    const pickup = await item(mom, 'pickup-today');
    const t0 = Date.now();
    const res = await send(mom, 'POST', '/items/pickup-today/assign', { version: pickup.version, ownerId: 'dad' });
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(800);
    expect((await item(mom, 'pickup-today')).ownership).toMatchObject({ state: 'assigned', ownerId: 'dad' });
    await until(async () => (await health()).ppma === 'offline');
    expect((await health()).ppmaQueued).toBeGreaterThanOrEqual(1);
    const screen = (await (await get(mom, '/screen/my-day')).json()) as { ppma: string };
    expect(screen.ppma).toBe('offline');
  });

  it('tells open streams when the status changes, and says it in hello', async () => {
    process.env.PPMA_URL = 'http://127.0.0.1:9';
    process.env.PPMA_OWNER_TOKEN = OWNER;
    process.env.PPMA_TIMEOUT_MS = '1000';
    const mom = await login('mom');
    await until(async () => (await health()).ppma === 'offline');
    const controller = new AbortController();
    const res = await fetch(`${base}/api/homemind/events`, { headers: { [SESSION_HEADER]: mom }, signal: controller.signal });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: hello')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).toMatch(/"ppma":"offline"/);
  });
});
