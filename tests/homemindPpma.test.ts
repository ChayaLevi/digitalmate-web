import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPpmaClient, memorySyncStore, normalizeOutcome, parseExplanation, parseMemoryView, ppmaConfigFromEnv, ppmaSyncFileFor, sseParser, ulid, ULID_PATTERN, HOMEMIND_MANIFEST } from '../server/homemind/ppma';
import type { PpmaClient, PpmaConfig, PpmaMessage, PpmaStatus } from '../server/homemind/ppma';
import { createFakePpma } from '../scripts/fake-ppma.mjs';

type Fake = ReturnType<typeof createFakePpma>;

const OWNER = 'test-owner-token-0123456789abcdef0123';
let fake: Fake;
let clients: PpmaClient[] = [];

function config(url: string, extra: Partial<PpmaConfig> = {}): PpmaConfig {
  return { url, ownerToken: OWNER, ownerTokenFile: '/nonexistent/setup-token', space: 'me', timeoutMs: 2000, debug: 0, ...extra };
}

function client(url: string, deps: Parameters<typeof createPpmaClient>[1] = {}, extra: Partial<PpmaConfig> = {}): PpmaClient {
  const c = createPpmaClient(config(url, extra), { backoffMs: [20, 40, 80], log: () => undefined, ...deps });
  clients.push(c);
  return c;
}

async function until<T>(check: () => T | undefined | false | null, timeoutMs = 4000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 15));
  }
}

const outcomes = (f: Fake): PpmaMessage[] => f.received().filter((m: PpmaMessage) => m.type === 'command.outcome');

beforeEach(async () => {
  fake = createFakePpma({ ownerToken: OWNER, heartbeatMs: 200 });
  await fake.listen(0);
});

afterEach(async () => {
  await Promise.all(clients.map(c => c.stop()));
  clients = [];
  await fake.close();
});

describe('helpers', () => {
  it('makes ULIDs the contract accepts, ordered by time', () => {
    const a = ulid(Date.UTC(2026, 10, 8));
    const b = ulid(Date.UTC(2026, 10, 9));
    expect(a).toMatch(ULID_PATTERN);
    expect(b).toMatch(ULID_PATTERN);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it('reads config from env; off without PPMA_URL; a bad space falls back to me', () => {
    expect(ppmaConfigFromEnv({}).url).toBeUndefined();
    const c = ppmaConfigFromEnv({ PPMA_URL: 'http://127.0.0.1:8765/', PPMA_SPACE: 'a b/c', PPMA_OWNER_TOKEN: ' x ' });
    expect(c.url).toBe('http://127.0.0.1:8765');
    expect(c.space).toBe('me');
    expect(c.ownerToken).toBe('x');
    expect(c.ownerTokenFile).toMatch(/setup-token$/);
    expect(createPpmaClient(ppmaConfigFromEnv({})).status()).toBe('off');
  });

  it('puts the sync file beside the state file', () => {
    expect(ppmaSyncFileFor('.homemind/state.json')).toBe('.homemind/state.ppma.json');
    expect(ppmaSyncFileFor('data')).toBe('data.ppma.json');
  });

  it('parses SSE frames split across chunks, skipping heartbeats', () => {
    const frames: Array<{ id?: string; event?: string; data: string }> = [];
    const feed = sseParser(f => frames.push(f));
    feed(': ping\n\nid: 7\nevent: com');
    feed('mand\ndata: {"a":1}\r\n\r\n: ping\n\nid: 8\ndata: x\ndata: y\n\n');
    expect(frames).toEqual([
      { id: '7', event: 'command', data: '{"a":1}' },
      { id: '8', data: 'x\ny' }
    ]);
  });

  it('keeps outcomes inside the contract rules', () => {
    expect(normalizeOutcome({ status: 'dismissed', path: 'auto' }).path).toBe('asked');
    expect(normalizeOutcome({ status: 'modified', path: 'auto' }).modified_args).toEqual({});
    expect(normalizeOutcome({ status: 'executed', path: 'auto', modified_args: { a: 1 } }).modified_args).toBeUndefined();
  });

  it('declares no tool that sends or orders, and only homemind.* names', () => {
    for (const tool of HOMEMIND_MANIFEST.tools) {
      expect(tool.name.startsWith('homemind.')).toBe(true);
      expect(['none', 'create']).toContain(tool.effect);
    }
    for (const e of HOMEMIND_MANIFEST.emits) expect(e.sensitivity).toBe('personal');
  });
});

describe('connecting and reporting', () => {
  it('registers the manifest, mints a token, opens the stream and goes ok', async () => {
    const statuses: PpmaStatus[] = [];
    const c = client(fake.url);
    c.onStatus(s => statuses.push(s));
    expect(c.status()).toBe('connecting');
    c.start();
    await until(() => c.status() === 'ok');
    expect(fake.state.manifestPuts).toBe(1);
    expect(fake.state.tokensMinted).toBe(1);
    expect(fake.state.manifest.ui_commands).toEqual([]);
    expect(statuses).toEqual(['ok']);
  });

  it('sends queued events as valid envelopes', async () => {
    const c = client(fake.url);
    c.start();
    const id = c.emit('homemind.item_changed', { item_id: 'x', change: 'created' });
    expect(id).toMatch(ULID_PATTERN);
    expect(await c.drained()).toBe(true);
    const [m] = fake.received();
    expect(m).toMatchObject({ id, kind: 'event', type: 'homemind.item_changed', space: 'me', source: { app: 'homemind' }, payload: { item_id: 'x' } });
    expect(m.occurred_at).toMatch(/Z$/);
  });

  it('emit returns at once and queues while PPMA is down, then delivers when it is back', async () => {
    fake.setDown(true);
    const sync = memorySyncStore();
    const c = client(fake.url, { sync });
    c.start();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) c.emit('homemind.item_changed', { item_id: `i${i}`, change: 'created' });
    expect(Date.now() - t0).toBeLessThan(50);
    await until(() => c.status() === 'offline');
    expect(c.info().queued).toBe(5);
    expect(c.info().lastError).toBe('http_503');
    await until(() => sync.current()?.outbox.length === 5);
    fake.setDown(false);
    await until(() => c.status() === 'ok');
    expect(await c.drained()).toBe(true);
    expect(fake.received().map((m: PpmaMessage) => m.payload.item_id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
  });

  it('is offline, not stuck, when nothing listens at the URL', async () => {
    const c = client('http://127.0.0.1:9');
    c.start();
    c.emit('homemind.item_changed', { item_id: 'x', change: 'created' });
    await until(() => c.status() === 'offline');
    expect(c.info().queued).toBe(1);
    expect(['network', 'timeout']).toContain(c.info().lastError);
  });

  it('says so when there is no owner token', async () => {
    const c = client(fake.url, {}, { ownerToken: undefined });
    c.start();
    await until(() => c.status() === 'offline');
    expect(c.info().lastError).toBe('owner_token_missing');
    expect(fake.state.manifestPuts).toBe(0);
  });

  it('keeps the queue across a restart (saved sync state)', async () => {
    fake.setDown(true);
    const sync = memorySyncStore();
    const first = client(fake.url, { sync });
    first.start();
    first.emit('homemind.preference_stated', { preference_id: 'p1', change: 'added' });
    await until(() => sync.current()?.outbox.length === 1);
    await first.stop();
    fake.setDown(false);
    const second = client(fake.url, { sync });
    second.start();
    expect(await second.drained()).toBe(true);
    expect(fake.received().map((m: PpmaMessage) => m.type)).toEqual(['homemind.preference_stated']);
  });

  it('mints a new token after a 401 and still delivers', async () => {
    const c = client(fake.url);
    c.start();
    await until(() => c.status() === 'ok');
    fake.forgetTokens();
    c.emit('homemind.item_changed', { item_id: 'after', change: 'created' });
    expect(await c.drained()).toBe(true);
    expect(fake.state.tokensMinted).toBeGreaterThanOrEqual(2);
    expect(fake.received().at(-1).payload.item_id).toBe('after');
  });

  it('drops a message PPMA refuses as invalid without blocking the rest', async () => {
    const lines: string[] = [];
    const c = client(fake.url, { log: l => lines.push(l) });
    c.start();
    c.emit('homemind.not_declared', { x: 1 });
    c.emit('homemind.item_changed', { item_id: 'good', change: 'created' });
    expect(await c.drained()).toBe(true);
    // The fake refuses the whole batch naming the bad id; the good one goes in the next POST.
    expect(fake.received().map((m: PpmaMessage) => m.payload.item_id)).toEqual(['good']);
    expect(lines.some(l => l.includes('refused 1 message'))).toBe(true);
  });

  it('never logs a token', async () => {
    const lines: string[] = [];
    const c = client(fake.url, { log: l => lines.push(l) }, { debug: 2 });
    c.start();
    c.emit('homemind.item_changed', { item_id: 'x', change: 'created' });
    await c.drained();
    expect(lines.length).toBeGreaterThan(0);
    const tokens = [OWNER, ...fake.state.tokens];
    for (const line of lines) for (const t of tokens) expect(line).not.toContain(t);
  });
});

describe('commands', () => {
  it('answers every command with one command.outcome carrying causation_id', async () => {
    const c = client(fake.url);
    c.setCommandHandler(cmd => ({ status: 'executed', path: 'auto', result: { echo: cmd.payload } }));
    c.start();
    await until(() => c.status() === 'ok');
    const entry = fake.issueCommand('homemind.get_board', { a: 1 });
    const [outcome] = await until(() => (outcomes(fake).length ? outcomes(fake) : null));
    expect(outcome.causation_id).toBe(entry.message.id);
    expect(outcome.payload).toEqual({ status: 'executed', path: 'auto', result: { echo: { a: 1 } } });
  });

  it('answers commands issued while it was away, on connect', async () => {
    const first = fake.issueCommand('homemind.get_board', {});
    const c = client(fake.url);
    c.setCommandHandler(() => ({ status: 'executed', path: 'auto' }));
    c.start();
    await until(() => outcomes(fake).length === 1);
    expect(outcomes(fake)[0].causation_id).toBe(first.message.id);
  });

  it('runs a command delivered twice only once', async () => {
    let runs = 0;
    const c = client(fake.url);
    c.setCommandHandler(() => {
      runs++;
      return { status: 'executed', path: 'auto' };
    });
    c.start();
    await until(() => c.status() === 'ok');
    const entry = fake.issueCommand('homemind.get_board', {});
    await until(() => outcomes(fake).length === 1);
    fake.redeliver(entry.message.id);
    await new Promise(r => setTimeout(r, 150));
    expect(runs).toBe(1);
    expect(outcomes(fake)).toHaveLength(1);
  });

  it('resumes after a dropped stream with Last-Event-ID, so old commands do not come back', async () => {
    let runs = 0;
    const sync = memorySyncStore();
    const c = client(fake.url, { sync });
    c.setCommandHandler(() => {
      runs++;
      return { status: 'executed', path: 'auto' };
    });
    c.start();
    await until(() => c.status() === 'ok');
    const one = fake.issueCommand('homemind.get_board', {});
    await until(() => outcomes(fake).length === 1);
    fake.dropStreams();
    await until(() => fake.state.streamConnects >= 2);
    expect(fake.state.lastEventIds.at(-1)).toBe(String(one.seq));
    fake.issueCommand('homemind.get_board', {});
    await until(() => outcomes(fake).length === 2);
    expect(runs).toBe(2);
    expect(sync.current()?.handled.map(h => h.status)).toEqual(['executed', 'executed']);
  });

  it('does not run a command twice across a restart, even reading the stream from the start', async () => {
    let runs = 0;
    const sync = memorySyncStore();
    const handler = () => {
      runs++;
      return { status: 'executed' as const, path: 'auto' as const };
    };
    const first = client(fake.url, { sync });
    first.setCommandHandler(handler);
    first.start();
    fake.issueCommand('homemind.get_board', {});
    await until(() => outcomes(fake).length === 1);
    await first.stop();
    // Forget the stream position, as after a 401 from a restarted PPMA: the ledger is read again.
    const saved = sync.current()!;
    await sync.save({ ...saved, lastStreamId: undefined });
    const second = client(fake.url, { sync });
    second.setCommandHandler(handler);
    second.start();
    await until(() => second.status() === 'ok');
    await new Promise(r => setTimeout(r, 150));
    expect(runs).toBe(1);
    expect(outcomes(fake)).toHaveLength(1);
  });

  it('reports expired for a command past its deadline, without running it', async () => {
    let runs = 0;
    const c = client(fake.url);
    c.setCommandHandler(() => {
      runs++;
      return { status: 'executed', path: 'auto' };
    });
    fake.issueCommand('homemind.propose_item', { title: 'x' }, { expiresInMs: 1 });
    await new Promise(r => setTimeout(r, 20));
    c.start();
    await until(() => outcomes(fake).length === 1);
    expect(runs).toBe(0);
    expect(outcomes(fake)[0].payload.status).toBe('expired');
  });

  it('reports failed when the handler throws', async () => {
    const c = client(fake.url);
    c.setCommandHandler(() => {
      throw new Error('boom');
    });
    c.start();
    fake.issueCommand('homemind.get_board', {});
    await until(() => outcomes(fake).length === 1);
    expect(outcomes(fake)[0].payload).toMatchObject({ status: 'failed', path: 'auto' });
  });

  it('answers a command whose outcome could not be sent yet once PPMA is back (the outcome is queued)', async () => {
    const c = client(fake.url);
    c.setCommandHandler(() => ({ status: 'rejected', path: 'auto', detail: 'no' }));
    c.start();
    await until(() => c.status() === 'ok');
    fake.issueCommand('homemind.add_to_shopping', { title: 'milk' });
    fake.setDown(true);
    await new Promise(r => setTimeout(r, 100));
    fake.setDown(false);
    await until(() => outcomes(fake).length === 1);
    expect(outcomes(fake)[0].payload).toMatchObject({ status: 'rejected', detail: 'no' });
  });
});

describe('reading PPMA memory and explanations (T6.2)', () => {
  const statement = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, text, confidence: 0.8, origin: 'user', editable: true, updated_at: 'x', challenged_by: [], ...extra });

  it('parses a memory view by hand: drops what is off-shape, event-type noise and control characters', () => {
    const body = {
      statements: [
        statement('st-1', 'Noa enjoys cake\u0007 most'),
        statement('st-2', 'homemind.item_changed'),
        statement('bad id', 'Spaces in the id'),
        statement('st-3', '   '),
        statement('st-4', 'Odd origin', { origin: 'martian', confidence: 7, editable: 'yes' }),
        'not an object',
        null
      ]
    };
    expect(parseMemoryView(body, 'about_me')).toEqual([
      { id: 'st-1', text: 'Noa enjoys cake most', origin: 'user', confidence: 0.8, editable: true, view: 'about_me' },
      { id: 'st-4', text: 'Odd origin', origin: 'inferred', confidence: 1, editable: false, view: 'about_me' }
    ]);
    expect(parseMemoryView({ statements: 'nope' }, 'v')).toEqual([]);
    expect(parseMemoryView(undefined, 'v')).toEqual([]);
    expect(parseMemoryView({ statements: Array.from({ length: 300 }, (_, n) => statement(`s${n}`, `fact ${n}`)) }, 'v')).toHaveLength(200);
  });

  it('parses an explanation, trims it, and gives null when there is nothing usable', () => {
    expect(parseExplanation({ summary: ' Because ', rationale: 'R', basis: [{ kind: 'k', ref: 'r', note: 'n' }, { kind: 'empty' }, 'junk'] })).toEqual({ summary: 'Because', rationale: 'R', basis: [{ kind: 'k', ref: 'r', note: 'n' }] });
    expect(parseExplanation({})).toBeNull();
    expect(parseExplanation(null)).toBeNull();
    expect(parseExplanation('text')).toBeNull();
  });

  it('answers loading at once, reads in the background, tells listeners once, and then answers from the cache', async () => {
    fake.setMemory([{ id: 'st-1', text: 'Noa enjoys cake most' }, { id: 'st-2', text: 'homemind.item_changed' }]);
    const c = client(fake.url);
    c.start();
    let announced = 0;
    c.onMemory(() => announced++);
    expect(c.memory()).toEqual({ state: 'loading', statements: [] });
    c.refreshMemory();
    const ready = await until(() => (c.memory().state === 'ready' ? c.memory() : null));
    expect(ready.statements.map(s => s.text)).toEqual(['Noa enjoys cake most']);
    expect(announced).toBe(1);
    // Nothing changed: a forced read finds the same thing and does not announce again, so a screen cannot loop.
    c.refreshMemory({ force: true });
    await new Promise(r => setTimeout(r, 200));
    expect(announced).toBe(1);
    // A new fact is announced.
    fake.setMemory([{ id: 'st-1', text: 'Noa enjoys cake most' }, { id: 'st-9', text: 'Maya plays piano' }]);
    c.refreshMemory({ force: true });
    await until(() => c.memory().statements.length === 2);
    expect(announced).toBe(2);
  });

  it('reads again by itself when PPMA says its memory was updated, but only once someone has looked at it', async () => {
    fake.setMemory([{ id: 'st-1', text: 'One' }]);
    const c = client(fake.url);
    c.start();
    await until(() => c.status() === 'ok');
    // Nobody has asked for the memory yet: PPMA's news causes no read.
    fake.setMemory([{ id: 'st-1', text: 'One' }, { id: 'st-2', text: 'Two' }]);
    await new Promise(r => setTimeout(r, 1300));
    expect(c.memory().state).toBe('loading');
    c.refreshMemory();
    await until(() => c.memory().statements.length === 2);
    // Now it follows PPMA without being asked: a burst of updates, and the screen hears about the last state.
    fake.setMemory([{ id: 'st-1', text: 'One' }]);
    fake.setMemory([{ id: 'st-1', text: 'One' }, { id: 'st-3', text: 'Three' }]);
    await until(() => c.memory().statements.some(st => st.id === 'st-3'), 4000);
  });

  it('limits how often it reads unless forced', async () => {
    fake.setMemory([{ id: 'st-1', text: 'One' }]);
    const c = client(fake.url);
    c.start();
    c.refreshMemory();
    await until(() => c.memory().state === 'ready');
    fake.setMemory([{ id: 'st-1', text: 'One' }, { id: 'st-2', text: 'Two' }]);
    c.refreshMemory();
    await new Promise(r => setTimeout(r, 150));
    expect(c.memory().statements).toHaveLength(1);
    c.refreshMemory({ force: true });
    await until(() => c.memory().statements.length === 2);
  });

  it('says error, never invents memory, and keeps the last good read when a refresh fails', async () => {
    const noToken = client(fake.url, {}, { ownerToken: undefined });
    noToken.start();
    noToken.refreshMemory();
    await until(() => noToken.memory().state === 'error');
    expect(noToken.memory()).toEqual({ state: 'error', statements: [], error: 'owner_token_missing' });

    fake.setMemory([{ id: 'st-1', text: 'Keep me' }]);
    const c = client(fake.url);
    c.start();
    c.refreshMemory();
    await until(() => c.memory().state === 'ready');
    fake.setDown(true);
    c.refreshMemory({ force: true });
    const stale = await until(() => (c.memory().error ? c.memory() : null));
    expect(stale.state).toBe('ready');
    expect(stale.statements.map(s => s.text)).toEqual(['Keep me']);
    fake.setDown(false);
    c.refreshMemory({ force: true });
    await until(() => !c.memory().error);
  });

  it('is quiet when PPMA is off', async () => {
    const off = createPpmaClient(ppmaConfigFromEnv({}));
    off.refreshMemory({ force: true });
    expect(off.memory()).toEqual({ state: 'loading', statements: [] });
    expect(off.explanation('dec-1')).toEqual({ state: 'unavailable' });
    expect(off.correct({ statementId: 'st-1', action: 'wrong', text: 'x' })).toBeNull();
  });

  it('sends a correction as user.correction, marks the statement while it is on its way, and drops the mark once PPMA applied it', async () => {
    fake.setMemory([{ id: 'st-1', text: 'Noa enjoys cake most' }, { id: 'st-2', text: 'Maya plays piano' }]);
    const c = client(fake.url);
    c.start();
    c.refreshMemory();
    await until(() => c.memory().statements.length === 2);
    const id = c.correct({ statementId: 'st-1', action: 'forget', text: 'Noa enjoys cake most' });
    expect(id).toMatch(ULID_PATTERN);
    expect(c.memory().statements.find(s => s.id === 'st-1')?.correcting).toBe('forget');
    expect(c.memory().statements.find(s => s.id === 'st-2')?.correcting).toBeUndefined();
    const sent = await until(() => fake.received().find(m => m.type === 'user.correction'));
    expect(sent.payload).toEqual({ text: 'Noa enjoys cake most', statement_id: 'st-1', action: 'forget' });
    expect(sent.id).toBe(id);
    // The client looks again by itself, and the statement is gone once PPMA has applied the correction.
    await until(() => c.memory().statements.length === 1, 5000);
    expect(c.memory().statements[0].id).toBe('st-2');
  });

  it('refuses an id that is not a statement id, without sending anything', async () => {
    const c = client(fake.url);
    c.start();
    expect(c.correct({ statementId: '../x', action: 'wrong', text: 'x' })).toBeNull();
    expect(c.correct({ statementId: '', action: 'wrong', text: 'x' })).toBeNull();
    await new Promise(r => setTimeout(r, 100));
    expect(fake.received().some(m => m.type === 'user.correction')).toBe(false);
  });

  it('answers an explanation from the cache: loading first, ready after, unavailable for a decision PPMA does not know', async () => {
    const issued = fake.issueCommand('homemind.get_board', {}, { rationale: 'Because the group asked' });
    const decisionId = issued.message.decision_id as string;
    const c = client(fake.url);
    c.start();
    let announced = 0;
    c.onMemory(() => announced++);
    expect(c.explanation(decisionId)).toEqual({ state: 'loading' });
    const ready = await until(() => {
      const e = c.explanation(decisionId);
      return e.state === 'ready' ? e : null;
    });
    expect(ready.summary).toContain('Because the group asked');
    expect(ready.basis?.length).toBeGreaterThan(0);
    expect(announced).toBe(1);
    expect(c.explanation('no-such-decision')).toEqual({ state: 'loading' });
    await until(() => c.explanation('no-such-decision').state === 'unavailable');
    // A decision id that is not an id is never asked for.
    expect(c.explanation('../../etc')).toEqual({ state: 'unavailable' });
  });
});
