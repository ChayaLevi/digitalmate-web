import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime, setHomemindHeartbeatMs, signSession } from '../server/homemind';
import type { CoreEvent } from '../server/homemind/core';
import { MAX_STREAMS_PER_MEMBER, createEventHub } from '../server/homemind/events';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, Item, StreamMessage } from '../server/homemind/types';
import { BACKOFF, connectHomemindEvents, createSseParser, toStreamMessage } from '../src/transport/homemindEvents';
import type { StreamStatus } from '../src/transport/homemindEvents';

const SECRET = 'test-secret-0123456789';
const ENV_KEYS = ['HOMEMIND_ENABLED', 'HOMEMIND_SECRET', 'HOMEMIND_DEMO', 'HOMEMIND_DATA_FILE'] as const;
const NOW = Date.parse('2026-11-04T09:00:00Z');

const state = (): HomemindState => seedState({ now: NOW, timezone: 'Asia/Shanghai' });
const changed = (st: HomemindState, id: string, extra: Partial<Extract<CoreEvent, { type: 'item.changed' }>> = {}): CoreEvent => ({
  type: 'item.changed',
  itemId: id,
  item: st.items.find(i => i.id === id) ?? null,
  ...extra
});

const itemIdOf = (m: StreamMessage) => (m.event === 'item.changed' ? m.data.itemId : m.event);

describe('the hub', () => {
  it('sends a family item to everyone who has a stream, and a Parents-only item only to parents', () => {
    const st = state();
    const hub = createEventHub();
    const got: Record<string, StreamMessage[]> = { mom: [], dad: [], maya: [] };
    for (const id of Object.keys(got)) hub.subscribe(id, m => got[id].push(m), () => {});
    hub.publishChanges(st, [changed(st, 'counselor-meeting'), changed(st, 'pickup-today')]);
    expect(got.mom.map(itemIdOf)).toEqual(['counselor-meeting', 'pickup-today']);
    expect(got.dad).toHaveLength(2);
    expect(got.maya.map(itemIdOf)).toEqual(['pickup-today']);
    const counselor = st.items.find(i => i.id === 'counselor-meeting') as Item;
    const serialized = JSON.stringify(got.maya);
    for (const secret of [counselor.id, counselor.title, counselor.titleZh, counselor.notes]) {
      if (secret) expect(serialized).not.toContain(secret);
    }
  });

  it('tells a teen an item left their view when it became Parents-only, and tells a teen nothing about one they never saw', () => {
    const st = state();
    const hub = createEventHub();
    const maya: StreamMessage[] = [];
    hub.subscribe('maya', m => maya.push(m), () => {});
    const item = st.items.find(i => i.id === 'pickup-today') as Item;
    hub.publishChanges(st, [{ type: 'item.changed', itemId: item.id, item: { ...item, visibility: 'parents' }, previousVisibility: 'family' }]);
    expect(maya).toEqual([{ event: 'item.changed', data: { itemId: item.id, item: null } }]);
    maya.length = 0;
    hub.publishChanges(st, [{ type: 'item.changed', itemId: 'counselor-meeting', item: null }]);
    expect(maya).toEqual([]);
  });

  it('drops a subscriber whose send throws, and still serves the others', () => {
    const st = state();
    const hub = createEventHub();
    let closed = 0;
    const ok: StreamMessage[] = [];
    hub.subscribe(
      'mom',
      () => {
        throw new Error('socket gone');
      },
      () => {
        closed++;
      }
    );
    hub.subscribe('dad', m => ok.push(m), () => {});
    hub.publishChanges(st, [changed(st, 'pickup-today')]);
    expect(ok).toHaveLength(1);
    expect(closed).toBe(1);
    expect(hub.count()).toBe(1);
  });

  it('unsubscribe, the per-member cap and closeAll', () => {
    const hub = createEventHub();
    const closed: number[] = [];
    const stop = hub.subscribe('mom', () => {}, () => closed.push(-1));
    stop();
    expect(hub.count()).toBe(0);
    for (let i = 0; i < MAX_STREAMS_PER_MEMBER + 2; i++) hub.subscribe('dad', () => {}, () => closed.push(i));
    expect(hub.count('dad')).toBe(MAX_STREAMS_PER_MEMBER);
    expect(closed).toEqual([0, 1]);
    hub.closeAll();
    expect(hub.count()).toBe(0);
    expect(closed).toHaveLength(2 + MAX_STREAMS_PER_MEMBER);
  });
});

describe('the client reader', () => {
  it('parses frames split anywhere, with CRLF and comments', () => {
    const frames: Array<{ event: string; data: string }> = [];
    const parser = createSseParser(f => frames.push(f));
    const text = 'retry: 3000\n\n: ping\n\nevent: hello\ndata: {"a":1}\n\nevent: x\r\ndata: 1\r\ndata: 2\r\n\r\n';
    for (const ch of text) parser.push(ch);
    expect(frames).toEqual([
      { event: 'hello', data: '{"a":1}' },
      { event: 'x', data: '1\n2' }
    ]);
  });

  it('accepts only known messages of the right shape', () => {
    expect(toStreamMessage({ event: 'hello', data: '{"memberId":"mom","now":"2026-11-04T09:00:00Z"}' })).toMatchObject({ event: 'hello' });
    expect(toStreamMessage({ event: 'item.changed', data: '{"itemId":"a","item":null}' })).toEqual({ event: 'item.changed', data: { itemId: 'a', item: null } });
    expect(toStreamMessage({ event: 'item.changed', data: '{"item":null}' })).toBeNull();
    expect(toStreamMessage({ event: 'hello', data: '{"memberId":1}' })).toBeNull();
    expect(toStreamMessage({ event: 'nope', data: '{}' })).toBeNull();
    expect(toStreamMessage({ event: 'hello', data: 'not json' })).toBeNull();
    expect(toStreamMessage({ event: 'hello', data: '[1]' })).toBeNull();
  });

  const streamOf = (chunks: string[], hold = false) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
          if (!hold) c.close();
        }
      }),
      { status: 200 }
    );
  const hello = 'event: hello\ndata: {"memberId":"mom","now":"2026-11-04T09:00:00Z"}\n\n';

  it('sends the token in a header, never in the URL, and backs off 1 s, 2 s, 4 s ... up to the cap', async () => {
    const sleeps: number[] = [];
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let n = 0;
    const stop = connectHomemindEvents({
      token: 'tok-123',
      onMessage: () => {},
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        n++;
        if (n <= 7) return new Response('down', { status: 503 });
        return streamOf([], true);
      }) as unknown as typeof fetch,
      sleep: async ms => {
        sleeps.push(ms);
      }
    });
    await new Promise(r => setTimeout(r, 50));
    stop();
    expect(sleeps.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(Math.max(...sleeps)).toBe(BACKOFF.maxMs);
    expect(calls[0].headers['x-homemind-session']).toBe('tok-123');
    expect(calls.every(c => !c.url.includes('tok-123'))).toBe(true);
  });

  it('resets the backoff after hello, reconnects when the stream ends, and stops on 401', async () => {
    const sleeps: number[] = [];
    const statuses: StreamStatus[] = [];
    const got: string[] = [];
    let n = 0;
    connectHomemindEvents({
      token: 't',
      onMessage: m => got.push(m.event),
      onStatus: s => statuses.push(s),
      fetchImpl: (async () => {
        n++;
        if (n === 1) return new Response('down', { status: 503 });
        if (n === 2) return streamOf([hello]); // live, then the server closes it
        return new Response('no', { status: 401 });
      }) as unknown as typeof fetch,
      sleep: async ms => {
        sleeps.push(ms);
      }
    });
    await new Promise(r => setTimeout(r, 50));
    expect(sleeps).toEqual([1000, 1000]);
    expect(got).toEqual(['hello']);
    expect(statuses[statuses.length - 1]).toBe('signed-out');
    expect(statuses).toContain('live');
    expect(n).toBe(3);
  });
});

describe('the stream over HTTP', () => {
  let server: Server;
  let base = '';
  let dir = '';
  const saved: Record<string, string | undefined> = {};
  const aborts: AbortController[] = [];

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
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'homemind-events-'));
    process.env.HOMEMIND_ENABLED = '1';
    process.env.HOMEMIND_SECRET = SECRET;
    process.env.HOMEMIND_DEMO = '1';
    process.env.HOMEMIND_DATA_FILE = join(dir, 'state.json');
    resetHomemindRuntime();
  });

  afterEach(async () => {
    for (const c of aborts.splice(0)) c.abort();
    setHomemindHeartbeatMs(undefined);
    resetHomemindRuntime();
    await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function login(memberId: string): Promise<string> {
    const res = await fetch(`${base}/api/homemind/session`, { method: 'POST', body: JSON.stringify({ memberId }) });
    return ((await res.json()) as { token: string }).token;
  }

  const post = (token: string, path: string, body: unknown) =>
    fetch(`${base}/api/homemind${path}`, { method: 'POST', headers: { [SESSION_HEADER]: token }, body: JSON.stringify(body) });

  interface Live {
    raw: string;
    messages: StreamMessage[];
    ended: Promise<void>;
    res: Response;
    /** The next message matching `want` within `ms`, else null. */
    next(want?: (m: StreamMessage) => boolean, ms?: number): Promise<StreamMessage | null>;
    stop(): void;
  }

  async function listen(token: string): Promise<Live> {
    const controller = new AbortController();
    aborts.push(controller);
    const res = await fetch(`${base}/api/homemind/events`, { headers: { [SESSION_HEADER]: token }, signal: controller.signal });
    const live: Live = { raw: '', messages: [], ended: Promise.resolve(), res, next: async () => null, stop: () => controller.abort() };
    if (!res.ok || !res.body) return live;
    let cursor = 0;
    const waiters: Array<() => void> = [];
    const parser = createSseParser(frame => {
      const m = toStreamMessage(frame);
      if (m) live.messages.push(m);
      waiters.splice(0).forEach(w => w());
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    live.ended = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          live.raw += text;
          parser.push(text);
        }
      } catch {
        /* aborted */
      }
      waiters.splice(0).forEach(w => w());
    })();
    live.next = async (want = () => true, ms = 2000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        while (cursor < live.messages.length) {
          const m = live.messages[cursor++];
          if (want(m)) return m;
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        await new Promise<void>(resolve => {
          waiters.push(resolve);
          setTimeout(resolve, left);
        });
      }
    };
    return live;
  }

  it('needs a session, and sends hello first', async () => {
    expect((await fetch(`${base}/api/homemind/events`)).status).toBe(401);
    const mom = await listen(await login('mom'));
    expect(mom.res.headers.get('content-type')).toContain('text/event-stream');
    expect(await mom.next()).toMatchObject({ event: 'hello', data: { memberId: 'mom' } });
  });

  it('Scene 1: Mom assigns the pickup and Dad sees it on his stream without asking', async () => {
    const momToken = await login('mom');
    const dad = await listen(await login('dad'));
    await dad.next(m => m.event === 'hello');
    const screen = (await (await fetch(`${base}/api/homemind/screen/family`, { headers: { [SESSION_HEADER]: momToken } })).json()) as { view: { items: Item[] } };
    const pickup = screen.view.items.find(i => i.id === 'pickup-today') as Item;
    const res = await post(momToken, '/items/pickup-today/assign', { version: pickup.version, ownerId: 'dad' });
    expect(res.status).toBe(200);
    const got = await dad.next(m => m.event === 'item.changed');
    expect(got).toMatchObject({ event: 'item.changed', data: { itemId: 'pickup-today', item: { ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } } } });
  });

  it("a teen's stream gets no trace of a Parents-only item, but still gets what is family-wide", async () => {
    const momToken = await login('mom');
    const maya = await listen(await login('maya'));
    const dad = await listen(await login('dad'));
    await Promise.all([maya.next(), dad.next()]);
    const secret = await post(momToken, '/items', { type: 'event', title: 'Quiet talk about school', visibility: 'parents', start: '2026-11-06T10:00:00Z' });
    expect(secret.status).toBe(200);
    expect(await dad.next(m => m.event === 'item.changed')).toMatchObject({ data: { item: { title: 'Quiet talk about school' } } });
    const open = await post(momToken, '/items', { type: 'task', title: 'Buy milk' });
    expect(open.status).toBe(200);
    const first = await maya.next(m => m.event === 'item.changed');
    expect(first).toMatchObject({ data: { item: { title: 'Buy milk' } } });
    expect(maya.raw).not.toContain('Quiet talk');
    expect(maya.raw).not.toContain('school');
  });

  it("Scene 4: an unavailability event that opens Mom's pickup reaches Dad's stream", async () => {
    const momToken = await login('mom');
    const dad = await listen(await login('dad'));
    await dad.next();
    const full = (await (await fetch(`${base}/api/homemind/debug/state`)).json()) as HomemindState;
    const pickup = full.items.find(i => i.id === 'pickup-tuesday') as Item;
    const start = new Date(Date.parse(pickup.start as string) - 60 * 60 * 1000).toISOString();
    const end = new Date(Date.parse(pickup.start as string) + 3 * 60 * 60 * 1000).toISOString();
    const res = await post(momToken, '/items', { type: 'event', title: 'Wedding', start, end, unavailableMemberIds: ['mom'] });
    expect(res.status).toBe(200);
    const opened = await dad.next(m => m.event === 'item.changed' && m.data.itemId === 'pickup-tuesday');
    expect(opened).toMatchObject({ data: { item: { ownership: { state: 'open' } } } });
  });

  it('a removed item reaches the stream as item: null', async () => {
    const momToken = await login('mom');
    const dad = await listen(await login('dad'));
    await dad.next();
    const created = (await (await post(momToken, '/items', { type: 'task', title: 'Temp' })).json()) as { activityId: string; items: Item[] };
    await dad.next(m => m.event === 'item.changed');
    const id = created.items[0].id;
    expect((await post(momToken, `/items/${id}/undo`, { activityId: created.activityId })).status).toBe(200);
    expect(await dad.next(m => m.event === 'item.changed')).toEqual({ event: 'item.changed', data: { itemId: id, item: null } });
  });

  it('demo reset reaches every stream', async () => {
    const momToken = await login('mom');
    const maya = await listen(await login('maya'));
    await maya.next();
    expect((await post(momToken, '/demo/reset', {})).status).toBe(200);
    expect(await maya.next(m => m.event === 'demo.reset')).toEqual({ event: 'demo.reset', data: {} });
  });

  it('sends a comment line while idle', async () => {
    setHomemindHeartbeatMs(30);
    const mom = await listen(await login('mom'));
    await mom.next();
    await new Promise(r => setTimeout(r, 150));
    expect(mom.raw).toContain(': ping');
  });

  it('ends when the session token expires', async () => {
    const token = signSession('mom', SECRET, Date.now() - 12 * 60 * 60 * 1000 + 300);
    const mom = await listen(token);
    expect(await mom.next()).toMatchObject({ event: 'hello' });
    await Promise.race([mom.ended, new Promise((_, reject) => setTimeout(() => reject(new Error('stream did not end')), 2000))]);
  });

  it('a closed stream is forgotten, and a new one works (reconnect)', async () => {
    const momToken = await login('mom');
    const dadToken = await login('dad');
    const first = await listen(dadToken);
    await first.next();
    first.stop();
    await first.ended;
    const second = await listen(dadToken);
    expect(await second.next()).toMatchObject({ event: 'hello' });
    expect((await post(momToken, '/items', { type: 'task', title: 'After reconnect' })).status).toBe(200);
    expect(await second.next(m => m.event === 'item.changed')).toMatchObject({ data: { item: { title: 'After reconnect' } } });
    expect(first.messages.filter(m => m.event === 'item.changed')).toHaveLength(0);
  });

  it('the client reconnects by itself after the server drops it, and sees later changes', async () => {
    const momToken = await login('mom');
    const dadToken = await login('dad');
    const titles: string[] = [];
    const statuses: StreamStatus[] = [];
    const stop = connectHomemindEvents({
      token: dadToken,
      fetchImpl: ((url: string, init: RequestInit) => fetch(`${base}${url}`, init)) as typeof fetch,
      sleep: async () => {
        await new Promise(r => setTimeout(r, 20));
      },
      onStatus: s => statuses.push(s),
      onMessage: m => {
        if (m.event === 'item.changed' && m.data.item) titles.push(m.data.item.title);
      }
    });
    try {
      await waitFor(() => statuses.includes('live'));
      resetHomemindRuntime(); // the bridge closes every stream
      await waitFor(() => statuses.filter(s => s === 'live').length === 2);
      expect((await post(momToken, '/items', { type: 'task', title: 'Seen after drop' })).status).toBe(200);
      await waitFor(() => titles.includes('Seen after drop'));
    } finally {
      stop();
    }
  });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}
