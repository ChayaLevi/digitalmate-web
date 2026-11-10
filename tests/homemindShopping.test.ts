import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime } from '../server/homemind';
import { DEFAULT_STORES, applyShopping, parseShoppingBody, settleShoppingRuns, shoppingOf } from '../server/homemind/shopping';
import type { ShoppingRequest, ShoppingResult } from '../server/homemind/shopping';
import { seedState } from '../server/homemind/seed';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import type { HomemindState } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { screenTurn } from '../src/lib/homemindSurfaces';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';

const NOW = Date.UTC(2026, 10, 9, 2, 0);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** A state file from before the shopping lists (no `shopping`): the default stores, nothing on them. */
const fresh = () => {
  const { shopping: _demo, ...state } = seedState({ now: NOW, timezone: 'Asia/Shanghai' });
  return deepFreeze(state as HomemindState);
};

function ok(result: ShoppingResult): Extract<ShoppingResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${result.status} ${result.code}: ${result.message}`);
  return result;
}

/** Applies requests in order, each by its member, and returns the state. */
function run(state: HomemindState, ...steps: Array<[string, ShoppingRequest]>): HomemindState {
  return steps.reduce((s, [member, request]) => deepFreeze(ok(applyShopping(s, request, member, NOW)).state), state);
}

describe('shopping lists (core)', () => {
  it('starts with the default stores and no items, in older files too', () => {
    const state = fresh();
    expect(state.shopping).toBeUndefined();
    const shopping = shoppingOf(state);
    expect(shopping.items).toEqual([]);
    expect(shopping.stores.map(s => s.id)).toEqual(DEFAULT_STORES.map(s => s.id));
    expect(shopping.stores.map(s => s.id)).toEqual(expect.arrayContaining(['supermarket', 'pharmacy', 'mall', 'post-office']));
  });

  it('never gives a deleted item’s id to a new one', () => {
    const state = run(fresh(), ['mom', { action: 'add-item', storeId: 'mall', name: 'A' }], ['mom', { action: 'add-item', storeId: 'mall', name: 'B' }], ['mom', { action: 'remove-item', itemId: 'shop-2' }]);
    expect(ok(applyShopping(state, { action: 'add-item', storeId: 'mall', name: 'C' }, 'mom', NOW)).itemId).toBe('shop-3');
  });

  it('moves the run with its task: reassigned on the board it follows, handed off it ends', () => {
    const state = run(fresh(), ['dad', { action: 'claim', storeId: 'market' }]);
    const task = state.items.find(i => i.source.kind === 'shopping')!;
    const reassigned = applyChange(state, { kind: 'assign', itemId: task.id, version: task.version, ownerId: 'maya' }, 'dad', fixedClock(NOW));
    if (!reassigned.ok) throw new Error(reassigned.message);
    expect(shoppingOf(reassigned.state).stores.find(s => s.id === 'market')?.run?.memberId).toBe('maya');
    const handed = applyChange(state, { kind: 'handback', itemId: task.id, version: task.version }, 'dad', fixedClock(NOW));
    if (!handed.ok) throw new Error(handed.message);
    expect(shoppingOf(handed.state).stores.find(s => s.id === 'market')?.run).toBeUndefined();
  });

  it('keeps a store while someone is going there, and drops link and bold marks from store names', () => {
    const state = run(fresh(), ['mom', { action: 'add-store', name: 'Bakery' }], ['mom', { action: 'claim', storeId: 'bakery' }]);
    expect(applyShopping(state, { action: 'remove-store', storeId: 'bakery' }, 'mom', NOW)).toMatchObject({ ok: false, status: 409 });
    expect(parseShoppingBody({ action: 'add-store', name: '[Click](http://x) **shop**' })).toEqual({ ok: true, value: { action: 'add-store', name: 'Clickhttp://x shop' } });
  });

  it('lets any member add an item with a note, and says who added it', () => {
    const state = run(fresh(), ['maya', { action: 'add-item', storeId: 'supermarket', name: 'Milk', note: '2 cartons' }], ['maya', { action: 'add-item', storeId: 'supermarket', name: 'Bread' }]);
    expect(shoppingOf(state).items).toEqual([
      { id: 'shop-1', storeId: 'supermarket', name: 'Milk', note: '2 cartons', addedBy: 'maya', addedAt: new Date(NOW).toISOString() },
      { id: 'shop-2', storeId: 'supermarket', name: 'Bread', addedBy: 'maya', addedAt: new Date(NOW).toISOString() }
    ]);
  });

  it('refuses a member without an account and an unknown store', () => {
    expect(applyShopping(fresh(), { action: 'add-item', storeId: 'supermarket', name: 'Milk' }, 'noa', NOW)).toMatchObject({ ok: false, status: 403 });
    expect(applyShopping(fresh(), { action: 'add-item', storeId: 'nowhere', name: 'Milk' }, 'mom', NOW)).toMatchObject({ ok: false, status: 404 });
  });

  it('marks bought and back, and clears only the bought items of that store', () => {
    let state = run(
      fresh(),
      ['mom', { action: 'add-item', storeId: 'supermarket', name: 'Milk' }],
      ['mom', { action: 'add-item', storeId: 'supermarket', name: 'Bread' }],
      ['dad', { action: 'add-item', storeId: 'pharmacy', name: 'Plasters' }],
      ['dad', { action: 'bought', itemId: 'shop-1', bought: true }],
      ['dad', { action: 'bought', itemId: 'shop-3', bought: true }]
    );
    expect(shoppingOf(state).items.find(i => i.id === 'shop-1')?.bought).toEqual({ by: 'dad', at: new Date(NOW).toISOString() });
    state = run(state, ['maya', { action: 'bought', itemId: 'shop-1', bought: false }]);
    expect(shoppingOf(state).items.find(i => i.id === 'shop-1')?.bought).toBeUndefined();
    state = run(state, ['maya', { action: 'bought', itemId: 'shop-2', bought: true }], ['maya', { action: 'clear-bought', storeId: 'supermarket' }]);
    expect(shoppingOf(state).items.map(i => i.id)).toEqual(['shop-1', 'shop-3']);
    // Marking twice or clearing nothing changes nothing.
    expect(ok(applyShopping(state, { action: 'bought', itemId: 'shop-3', bought: true }, 'mom', NOW)).changed).toBe(false);
    expect(ok(applyShopping(state, { action: 'clear-bought', storeId: 'mall' }, 'mom', NOW)).changed).toBe(false);
  });

  it('lets one member take a run; others see it, cannot take or release it; the taker releases', () => {
    const state = run(fresh(), ['dad', { action: 'claim', storeId: 'supermarket' }]);
    expect(shoppingOf(state).stores.find(s => s.id === 'supermarket')?.run).toMatchObject({ memberId: 'dad', at: new Date(NOW).toISOString() });
    expect(applyShopping(state, { action: 'claim', storeId: 'supermarket' }, 'mom', NOW)).toMatchObject({ ok: false, status: 409, code: 'taken' });
    expect(applyShopping(state, { action: 'release', storeId: 'supermarket' }, 'mom', NOW)).toMatchObject({ ok: false, status: 403 });
    expect(ok(applyShopping(state, { action: 'claim', storeId: 'supermarket' }, 'dad', NOW)).changed).toBe(false);
    const released = run(state, ['dad', { action: 'release', storeId: 'supermarket' }]);
    expect(shoppingOf(released).stores.find(s => s.id === 'supermarket')?.run).toBeUndefined();
    expect(ok(applyShopping(released, { action: 'claim', storeId: 'supermarket' }, 'mom', NOW)).changed).toBe(true);
  });

  it("puts a taken run on the member's board as today's task, and removes it on release", () => {
    const state = run(fresh(), ['dad', { action: 'claim', storeId: 'supermarket' }]);
    const runOf = (s: HomemindState) => shoppingOf(s).stores.find(x => x.id === 'supermarket')?.run;
    const task = state.items.find(i => i.id === runOf(state)?.itemId);
    expect(task).toMatchObject({ type: 'task', title: 'Shopping at Supermarket', titleZh: '去超市购物', status: 'open', allDay: true, start: new Date(NOW).toISOString(), source: { kind: 'shopping' }, ownership: { state: 'assigned', ownerId: 'dad', confirmed: true } });
    // On Dad's My day, today.
    const myDay = A2uiSurfaceStore.fromJsonl(screenTurn('my-day', { lang: 'en', now: new Date(NOW).toISOString(), view: viewFor(state, 'dad')! }).jsonl).list()[0];
    expect(JSON.stringify(myDay.data)).toContain('Shopping at Supermarket');
    const released = run(state, ['dad', { action: 'release', storeId: 'supermarket' }]);
    expect(runOf(released)).toBeUndefined();
    expect(released.items.find(i => i.id === task!.id)?.status).toBe('cancelled');
  });

  it("empties the store's list when its shopping task is done, and only frees the store when it is removed", () => {
    const state = run(
      fresh(),
      ['mom', { action: 'add-item', storeId: 'supermarket', name: 'Milk' }],
      ['mom', { action: 'add-item', storeId: 'supermarket', name: 'Bread' }],
      ['mom', { action: 'add-item', storeId: 'pharmacy', name: 'Plasters' }],
      ['dad', { action: 'claim', storeId: 'supermarket' }],
      ['mom', { action: 'claim', storeId: 'pharmacy' }]
    );
    expect(settleShoppingRuns(state)).toBe(state);
    const task = (storeId: string) => state.items.find(i => i.id === shoppingOf(state).stores.find(s => s.id === storeId)?.run?.itemId)!;
    const done = applyChange(state, { kind: 'done', itemId: task('supermarket').id, version: task('supermarket').version }, 'dad', fixedClock(NOW));
    if (!done.ok) throw new Error(done.message);
    const settled = settleShoppingRuns(done.state);
    expect(shoppingOf(settled).items.map(i => i.name)).toEqual(['Plasters']);
    expect(settled.shopping?.stores.find(s => s.id === 'supermarket')?.run).toBeUndefined();
    expect(settled.shopping?.stores.find(s => s.id === 'pharmacy')?.run?.memberId).toBe('mom');
    // Removed instead of done: the store is free, the list stays.
    const removed = applyChange(state, { kind: 'cancel', itemId: task('pharmacy').id, version: task('pharmacy').version }, 'mom', fixedClock(NOW));
    if (!removed.ok) throw new Error(removed.message);
    const freed = settleShoppingRuns(removed.state);
    expect(freed.shopping?.stores.find(s => s.id === 'pharmacy')?.run).toBeUndefined();
    expect(shoppingOf(freed).items.map(i => i.name)).toEqual(['Milk', 'Bread', 'Plasters']);
  });

  it('ends the run when its task is done or removed on the board', () => {
    const state = run(fresh(), ['mom', { action: 'claim', storeId: 'pharmacy' }]);
    const task = state.items.find(i => i.source.kind === 'shopping')!;
    const done = applyChange(state, { kind: 'done', itemId: task.id, version: task.version }, 'mom', fixedClock(NOW));
    if (!done.ok) throw new Error(done.message);
    expect(shoppingOf(done.state).stores.find(s => s.id === 'pharmacy')?.run).toBeUndefined();
    // Free again: someone else can take it.
    expect(ok(applyShopping(done.state, { action: 'claim', storeId: 'pharmacy' }, 'dad', NOW)).changed).toBe(true);
  });

  it('adds a family store, refuses a duplicate, and removes it only when its list is empty', () => {
    let state = run(fresh(), ['maya', { action: 'add-store', name: 'Pet shop' }]);
    const store = shoppingOf(state).stores.at(-1);
    expect(store).toMatchObject({ id: 'pet-shop', name: 'Pet shop', custom: true, createdBy: 'maya' });
    expect(applyShopping(state, { action: 'add-store', name: 'pet SHOP' }, 'mom', NOW)).toMatchObject({ ok: false, status: 409 });
    expect(ok(applyShopping(state, { action: 'add-store', name: '面包店' }, 'dad', NOW)).storeId).toBe('store-8');
    state = run(state, ['mom', { action: 'add-item', storeId: 'pet-shop', name: 'Cat food' }]);
    expect(applyShopping(state, { action: 'remove-store', storeId: 'pet-shop' }, 'mom', NOW)).toMatchObject({ ok: false, status: 409 });
    expect(applyShopping(state, { action: 'remove-store', storeId: 'supermarket' }, 'mom', NOW)).toMatchObject({ ok: false, status: 400 });
    state = run(state, ['mom', { action: 'remove-item', itemId: 'shop-1' }], ['mom', { action: 'remove-store', storeId: 'pet-shop' }]);
    expect(shoppingOf(state).stores.some(s => s.id === 'pet-shop')).toBe(false);
  });

  it('checks request bodies', () => {
    expect(parseShoppingBody({ action: 'add-item', storeId: 'supermarket', name: 'Milk', note: '2 cartons' })).toEqual({ ok: true, value: { action: 'add-item', storeId: 'supermarket', name: 'Milk', note: '2 cartons' } });
    expect(parseShoppingBody({ action: 'add-item', storeId: 'supermarket', name: 'Milk', qty: 2 }).ok).toBe(false);
    expect(parseShoppingBody({ action: 'add-item', storeId: 'supermarket', name: '   ' }).ok).toBe(false);
    expect(parseShoppingBody({ action: 'add-item', storeId: 'supermarket', name: 'x'.repeat(81) }).ok).toBe(false);
    expect(parseShoppingBody({ action: 'add-item', storeId: '../x', name: 'Milk' }).ok).toBe(false);
    expect(parseShoppingBody({ action: 'claim', storeId: 'mall', memberId: 'mom' }).ok).toBe(false);
    expect(parseShoppingBody({ action: 'bought', itemId: 'shop-1', bought: 'yes' }).ok).toBe(false);
    expect(parseShoppingBody({ action: 'buy' }).ok).toBe(false);
    expect(parseShoppingBody({ action: 'add-store', name: 'Bakery\n\tnorth' })).toEqual({ ok: true, value: { action: 'add-store', name: 'Bakery north' } });
  });
});

describe('no duplicates', () => {
  const base = () => run(fresh(), ['mom', { action: 'add-item', storeId: 'supermarket', name: 'Milk', note: '2 cartons' }]);

  it('does not add an item already waiting at that store, and says which one it is', () => {
    const state = base();
    for (const name of ['milk', '  MILK ', 'Milk']) {
      const result = ok(applyShopping(state, { action: 'add-item', storeId: 'supermarket', name }, 'dad', NOW));
      expect(result).toMatchObject({ changed: false, duplicateOf: 'shop-1' });
      expect(result.state).toBe(state);
    }
    // Another store, or the same thing already bought: a new line.
    expect(ok(applyShopping(state, { action: 'add-item', storeId: 'market', name: 'Milk' }, 'dad', NOW)).changed).toBe(true);
    const bought = run(state, ['dad', { action: 'bought', itemId: 'shop-1', bought: true }]);
    expect(ok(applyShopping(bought, { action: 'add-item', storeId: 'supermarket', name: 'Milk' }, 'dad', NOW)).changed).toBe(true);
  });

  it('says so on the Shopping screen', () => {
    const state = base();
    const surface = A2uiSurfaceStore.fromJsonl(
      screenTurn('shopping', { lang: 'en', now: new Date(NOW).toISOString(), view: viewFor(state, 'dad')!, shopping: shoppingOf(state), shoppingAsk: { itemId: 'shop-1' } }).jsonl
    ).list()[0];
    expect(surface.components['shop-ask'].text).toBe('**Milk** is already on the Supermarket list, added by Mom. It was not added again.');
    expect((surface.components['shop-ask-actions'].actions ?? []).map(a => [a.label, a.args?.verb])).toEqual([['OK', 'shop-keep']]);
    const plain = A2uiSurfaceStore.fromJsonl(screenTurn('shopping', { lang: 'en', now: new Date(NOW).toISOString(), view: viewFor(state, 'dad')!, shopping: shoppingOf(state) }).jsonl).list()[0];
    expect(plain.components['shop-ask']).toBeUndefined();
  });
});

describe('the Shopping screen', () => {
  it('shows each store with something on it, who is going, and the right buttons per member', () => {
    const state = run(
      fresh(),
      ['mom', { action: 'add-item', storeId: 'supermarket', name: 'Milk', note: '2 cartons' }],
      ['maya', { action: 'add-item', storeId: 'supermarket', name: 'Bread' }],
      ['maya', { action: 'bought', itemId: 'shop-2', bought: true }],
      ['dad', { action: 'claim', storeId: 'supermarket' }]
    );
    const build = (memberId: string) => {
      const turn = screenTurn('shopping', { lang: 'en', now: new Date(NOW).toISOString(), view: viewFor(state, memberId)!, shopping: shoppingOf(state) });
      return A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0];
    };
    const dad = build('dad');
    expect(dad.components['shop-supermarket'].title).toBe("Supermarket · You're going (on your My day)");
    const rows = dad.data['shop-supermarket'] as Array<{ title: string; meta: string; state: string; actions: Array<{ args: Record<string, unknown> }> }>;
    expect(rows.map(r => [r.title, r.meta, r.state])).toEqual([
      ['Milk', '2 cartons · Added by Mom', ''],
      ['Bread', 'Bought by Maya', 'done']
    ]);
    const verbs = (surface: typeof dad, id: string) => (surface.components[id]?.actions ?? []).map(a => a.args?.verb);
    expect(verbs(dad, 'shop-supermarket-actions')).toEqual(['shop-release', 'shop-clear']);
    const mom = build('mom');
    expect(mom.components['shop-supermarket'].title).toBe('Supermarket · Dad is going');
    expect(verbs(mom, 'shop-supermarket-actions')).toEqual(['shop-clear']);
    // Stores with nothing on them are one line, not empty boxes.
    expect(mom.components['shop-pharmacy']).toBeUndefined();
    expect(String(mom.components['shop-quiet'].text)).toContain('Pharmacy');
    expect(mom.components['f-shopStore'].options).toHaveLength(DEFAULT_STORES.length);
    // No intro line above the form.
    expect(mom.components['shop-intro']).toBeUndefined();
  });
});

// --- through the bridge, saved to the file and read back ------------------------------------------------

const SECRET = 'test-secret-0123456789';
const ENV_KEYS = ['HOMEMIND_ENABLED', 'HOMEMIND_SECRET', 'HOMEMIND_DEMO', 'HOMEMIND_DATA_FILE', 'HOMEMIND_LLM'] as const;
let server: Server;
let base = '';
let dir = '';
const saved: Record<string, string | undefined> = {};

async function login(memberId: string): Promise<string> {
  const res = await fetch(`${base}/api/homemind/session`, { method: 'POST', body: JSON.stringify({ memberId }) });
  return ((await res.json()) as { token: string }).token;
}

function as(token: string) {
  return {
    get: (path: string) => fetch(`${base}/api/homemind${path}`, { headers: { [SESSION_HEADER]: token } }),
    post: (body: unknown) => fetch(`${base}/api/homemind/shopping`, { method: 'POST', headers: { [SESSION_HEADER]: token }, body: JSON.stringify(body) }),
    screen: async () => A2uiSurfaceStore.fromJsonl(((await (await fetch(`${base}/api/homemind/screen/shopping?lang=en`, { headers: { [SESSION_HEADER]: token } })).json()) as { jsonl: string }).jsonl).list()[0]
  };
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  server = createServer((req, res) => {
    void handleHomemindRequest(req, res).then(handled => {
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
  dir = await mkdtemp(join(tmpdir(), 'homemind-shopping-'));
  Object.assign(process.env, { HOMEMIND_ENABLED: '1', HOMEMIND_SECRET: SECRET, HOMEMIND_DEMO: '1', HOMEMIND_DATA_FILE: join(dir, 'state.json'), HOMEMIND_LLM: 'fake' });
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

describe('shopping through the bridge', () => {
  it('adds, claims, marks bought and keeps it all after a restart', async () => {
    const mom = as(await login('mom'));
    const dad = as(await login('dad'));
    const added = await mom.post({ action: 'add-item', storeId: 'pharmacy', name: 'Cough syrup', note: 'kids' });
    expect(added.status).toBe(200);
    const { itemId } = (await added.json()) as { itemId: string };
    // The same again: nothing added, the bridge says which item it already is.
    const twice = await dad.post({ action: 'add-item', storeId: 'pharmacy', name: 'cough SYRUP' });
    expect(await twice.json()).toMatchObject({ ok: true, changed: false, duplicateOf: itemId });
    expect((await dad.post({ action: 'claim', storeId: 'pharmacy' })).status).toBe(200);
    expect((await mom.post({ action: 'claim', storeId: 'pharmacy' })).status).toBe(409);
    expect((await mom.post({ action: 'release', storeId: 'pharmacy' })).status).toBe(403);
    expect((await dad.post({ action: 'bought', itemId, bought: true })).status).toBe(200);
    expect((await mom.post({ action: 'nope' })).status).toBe(400);

    // A restart reads the file again.
    resetHomemindRuntime();
    const screen = await as(await login('mom')).screen();
    expect(screen.components['shop-pharmacy'].title).toBe('Pharmacy · Dad is going');
    const rows = screen.data['shop-pharmacy'] as Array<{ title: string; meta: string; state: string }>;
    expect(rows.find(r => r.title === 'Cough syrup')).toMatchObject({ meta: 'kids · Bought by Dad', state: 'done' });
    // The run is on Dad's board as a task.
    const dadDay = await as(await login('dad')).get('/screen/my-day?lang=en');
    expect(JSON.stringify(await dadDay.json())).toContain('Shopping at Pharmacy');
  });

  it("Done on the shopping task (My day) empties that store's list", async () => {
    const dad = as(await login('dad'));
    expect((await dad.post({ action: 'claim', storeId: 'supermarket' })).status).toBe(200);
    const state = (await (await fetch(`${base}/api/homemind/debug/state`)).json()) as HomemindState;
    const task = state.items.find(i => i.source.kind === 'shopping')!;
    const res = await fetch(`${base}/api/homemind/items/${task.id}/done`, { method: 'POST', headers: { [SESSION_HEADER]: await login('dad') }, body: JSON.stringify({ version: task.version }) });
    expect(res.status).toBe(200);
    const screen = await dad.screen();
    expect(screen.data['shop-supermarket']).toBeUndefined();
    expect(String(screen.components['shop-quiet'].text)).toContain('Supermarket');
  });

  it('needs a session', async () => {
    const res = await fetch(`${base}/api/homemind/shopping`, { method: 'POST', body: JSON.stringify({ action: 'claim', storeId: 'mall' }) });
    expect(res.status).toBe(401);
  });
});
