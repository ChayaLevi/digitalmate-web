import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER, handleHomemindRequest, resetHomemindRuntime } from '../server/homemind';
import { planChat } from '../server/homemind/chat';
import { fakeReply } from '../server/homemind/llmFake';
import { intentContextFor, intentPrompt, validateIntent } from '../server/homemind/intents';
import type { IntentStore } from '../server/homemind/intents';
import { seedState } from '../server/homemind/seed';
import { addShoppingItems, applyShopping, parseShoppingBody, parseShoppingItems, shoppingOf } from '../server/homemind/shopping';
import type { ShoppingRequest, ShoppingResult } from '../server/homemind/shopping';
import type { HomemindState } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { chatTurn } from '../src/lib/homemindSurfaces';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';

// Shopping lists: Undo for every list change, "Finished shopping" (only the bought items leave), and adding
// to a list from the Family chat.

const NOW = Date.UTC(2026, 10, 11, 6, 30);
const seeded = () => seedState({ now: NOW, timezone: 'Asia/Shanghai' });

function ok(result: ShoppingResult): Extract<ShoppingResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${result.status} ${result.code}: ${result.message}`);
  return result;
}
const apply = (state: HomemindState, member: string, request: ShoppingRequest) => ok(applyShopping(state, request, member, NOW));
const names = (state: HomemindState, storeId: string) => shoppingOf(state).items.filter(i => i.storeId === storeId).map(i => `${i.name}${i.bought ? ' (bought)' : ''} x${i.qty ?? 1}`);

describe('Undo for shopping list changes', () => {
  it('undoes an add, a remove, bought, a quantity and a clear, each back to exactly how it was', () => {
    const start = seeded();
    const before = names(start, 'supermarket');
    const steps: Array<[string, ShoppingRequest]> = [
      ['mom', { action: 'add-item', storeId: 'supermarket', name: 'Yogurt', qty: 3 }],
      ['mom', { action: 'remove-item', itemId: 'shop-2' }],
      ['dad', { action: 'bought', itemId: 'shop-1', bought: true }],
      ['dad', { action: 'bump', itemId: 'shop-4' }],
      ['maya', { action: 'set-qty', itemId: 'shop-3', qty: 5 }]
    ];
    for (const [member, request] of steps) {
      const changed = apply(start, member, request);
      expect(changed.undoId, request.action).toMatch(/^su-\d+$/);
      expect(names(changed.state, 'supermarket'), request.action).not.toEqual(before);
      const undone = apply(changed.state, member, { action: 'undo', undoId: changed.undoId as string });
      expect(undone.changed).toBe(true);
      expect(names(undone.state, 'supermarket'), request.action).toEqual(before);
      // Once only.
      expect(apply(undone.state, member, { action: 'undo', undoId: changed.undoId as string }).changed).toBe(false);
    }
    // Clear bought: the bought items come back, still bought.
    const bought = apply(apply(start, 'dad', { action: 'bought', itemId: 'shop-1', bought: true }).state, 'dad', { action: 'bought', itemId: 'shop-4', bought: true }).state;
    const cleared = apply(bought, 'dad', { action: 'clear-bought', storeId: 'supermarket' });
    expect(names(cleared.state, 'supermarket')).toEqual(['Eggs x1', 'Apples x1']);
    expect(names(apply(cleared.state, 'dad', { action: 'undo', undoId: cleared.undoId as string }).state, 'supermarket')).toEqual(names(bought, 'supermarket'));
  });

  it('undoes a store added or removed, and refuses to drop a store that has items now', () => {
    const added = apply(seeded(), 'mom', { action: 'add-store', name: 'Bakery' });
    const undone = apply(added.state, 'mom', { action: 'undo', undoId: added.undoId as string });
    expect(shoppingOf(undone.state).stores.some(s => s.id === 'bakery')).toBe(false);
    const removed = apply(added.state, 'mom', { action: 'remove-store', storeId: 'bakery' });
    expect(shoppingOf(apply(removed.state, 'mom', { action: 'undo', undoId: removed.undoId as string }).state).stores.find(s => s.id === 'bakery')).toMatchObject({ name: 'Bakery', custom: true });
    // An item was added to the new store since: undoing the store's creation would orphan it.
    const withItem = apply(added.state, 'dad', { action: 'add-item', storeId: 'bakery', name: 'Challah' }).state;
    const refused = applyShopping(withItem, { action: 'undo', undoId: added.undoId as string }, 'mom', NOW);
    expect(refused).toMatchObject({ ok: false, status: 409 });
  });

  it('only the member who made it or a parent may undo, and not after someone changed it again', () => {
    const maya = apply(seeded(), 'maya', { action: 'add-item', storeId: 'mall', name: 'Headphones' });
    const momAdds = apply(maya.state, 'mom', { action: 'add-item', storeId: 'mall', name: 'Socks' });
    // A teen cannot undo a parent's change; a parent can undo a teen's.
    expect(applyShopping(momAdds.state, { action: 'undo', undoId: momAdds.undoId as string }, 'maya', NOW)).toMatchObject({ ok: false, status: 403 });
    expect(apply(momAdds.state, 'dad', { action: 'undo', undoId: maya.undoId as string }).changed).toBe(true);
    // Dad marked Maya's headphones bought since: her Undo would overwrite that, so it is refused.
    const headphones = shoppingOf(momAdds.state).items.find(i => i.name === 'Headphones')!;
    const dadBought = apply(momAdds.state, 'dad', { action: 'bought', itemId: headphones.id, bought: true }).state;
    expect(applyShopping(dadBought, { action: 'undo', undoId: maya.undoId as string }, 'maya', NOW)).toMatchObject({ ok: false, status: 409, code: 'changed' });
    expect(applyShopping(dadBought, { action: 'undo', undoId: 'su-999' }, 'maya', NOW)).toMatchObject({ ok: false, status: 404 });
  });

  it('keeps the last 30 records and checks the undo id', () => {
    let state = seeded();
    for (let i = 0; i < 35; i++) state = apply(state, 'mom', { action: 'bump', itemId: 'shop-13' }).state;
    expect(state.shopping?.undo).toHaveLength(30);
    expect(state.shopping?.undo?.[0].id).toBe('su-6');
    expect(parseShoppingBody({ action: 'undo', undoId: 'su-3' })).toMatchObject({ ok: true });
    expect(parseShoppingBody({ action: 'undo', undoId: 'act-3' })).toMatchObject({ ok: false });
    expect(parseShoppingBody({ action: 'undo', undoId: 'su-3', extra: 1 })).toMatchObject({ ok: false });
  });
});

describe('Finished shopping', () => {
  it('only the member going can finish; it marks the task done', () => {
    const claimed = apply(seeded(), 'dad', { action: 'claim', storeId: 'pharmacy' });
    expect(claimed.activityId).toBeTruthy();
    expect(applyShopping(claimed.state, { action: 'finish', storeId: 'pharmacy' }, 'mom', NOW)).toMatchObject({ ok: false, status: 403 });
    expect(applyShopping(claimed.state, { action: 'finish', storeId: 'market' }, 'dad', NOW)).toMatchObject({ ok: false, status: 409, code: 'no_run' });
    const finished = apply(claimed.state, 'dad', { action: 'finish', storeId: 'pharmacy' });
    expect(finished.state.items.find(i => i.id === finished.taskId)?.status).toBe('done');
    expect(finished.activityId).toBeTruthy();
  });
});

describe('adding several items at once (chat)', () => {
  it('adds new ones, skips what is already waiting, and one Undo takes them all back', () => {
    const start = seeded();
    const result = addShoppingItems(
      start,
      [
        { storeId: 'supermarket', name: 'Yogurt', qty: 2 },
        { storeId: 'supermarket', name: 'milk' },
        { storeId: 'pharmacy', name: 'Cough syrup', note: 'for Noa' }
      ],
      'dad',
      NOW
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.added.map(i => [i.name, i.qty, i.storeId])).toEqual([
      ['Yogurt', 2, 'supermarket'],
      ['Cough syrup', 1, 'pharmacy']
    ]);
    expect(result.duplicates.map(d => d.name)).toEqual(['Milk']);
    const undone = apply(result.state, 'dad', { action: 'undo', undoId: result.undoId as string });
    expect(shoppingOf(undone.state).items).toEqual(shoppingOf(start).items);
  });

  it('refuses a bad entry, an unknown store, and nothing new adds no Undo', () => {
    expect(addShoppingItems(seeded(), [{ storeId: 'nowhere', name: 'Milk' }], 'mom', NOW)).toMatchObject({ ok: false, status: 404 });
    expect(addShoppingItems(seeded(), [{ storeId: 'market', name: 'x'.repeat(81) }], 'mom', NOW)).toMatchObject({ ok: false, status: 400 });
    expect(addShoppingItems(seeded(), [], 'mom', NOW)).toMatchObject({ ok: false, status: 400 });
    expect(addShoppingItems(seeded(), [{ storeId: 'market', name: 'Plums' }], 'noa', NOW)).toMatchObject({ ok: false, status: 403 });
    const same = addShoppingItems(seeded(), [{ storeId: 'market', name: 'Tomatoes' }], 'mom', NOW);
    expect(same).toMatchObject({ ok: true, added: [] });
    expect(same.ok && same.undoId).toBeFalsy();
    expect(parseShoppingItems({ action: 'add-items', items: [{ storeId: 'market', name: 'Plums', qty: 2 }] })).toMatchObject({ ok: true });
    expect(parseShoppingItems({ action: 'add-items', items: [{ storeId: 'market', name: 'Plums', price: 2 }] })).toMatchObject({ ok: false });
    expect(parseShoppingItems({ action: 'add-items', items: [] })).toMatchObject({ ok: false });
  });
});

describe('the add_to_shopping intent', () => {
  const state = seeded();
  const view = viewFor(state, 'mom')!;
  const stores: IntentStore[] = shoppingOf(state).stores.map(s => ({ id: s.id, name: s.name, nameZh: s.nameZh, waiting: [] }));
  const ctx = intentContextFor(view, NOW, stores);

  it('is validated by hand: stores from the list, 1 to 10 items, quantities 1 to 99', () => {
    expect(validateIntent({ intent: 'add_to_shopping', items: [{ storeId: 'pharmacy', name: 'Plasters', qty: 2, note: null }] }, ctx)).toEqual({
      ok: true,
      value: { intent: 'add_to_shopping', items: [{ storeId: 'pharmacy', name: 'Plasters', qty: 2 }] }
    });
    expect(validateIntent({ intent: 'add_to_shopping', items: [{ storeId: 'amazon', name: 'Plasters' }] }, ctx)).toMatchObject({ ok: false });
    expect(validateIntent({ intent: 'add_to_shopping', items: [{ storeId: 'pharmacy', name: 'Plasters', qty: 0 }] }, ctx)).toMatchObject({ ok: false });
    expect(validateIntent({ intent: 'add_to_shopping', items: [] }, ctx)).toMatchObject({ ok: false });
    expect(validateIntent({ intent: 'add_to_shopping', items: Array.from({ length: 11 }, () => ({ storeId: 'market', name: 'x' })) }, ctx)).toMatchObject({ ok: false });
    // Without stores (an older caller), no store id is valid.
    expect(validateIntent({ intent: 'add_to_shopping', items: [{ storeId: 'market', name: 'Plums' }] }, intentContextFor(view, NOW))).toMatchObject({ ok: false });
  });

  it('the prompt lists the stores and says adding is not buying', () => {
    const prompt = intentPrompt({ view, now: NOW, lang: 'en', text: 'add milk', stores });
    expect(prompt.system).toContain('add_to_shopping');
    expect(prompt.system).toContain('is not buying');
    expect(prompt.user).toContain('"stores"');
    expect(prompt.user).toContain('"pharmacy"');
  });

  it('at level 1 or paused it becomes a button, otherwise it adds', () => {
    const intent = { intent: 'add_to_shopping' as const, items: [{ storeId: 'market', name: 'Plums' }] };
    expect(planChat(view, intent)).toMatchObject({ kind: 'shopping', add: true });
    const level1 = viewFor({ ...state, family: { ...state.family, autonomy: { default: 1 } } }, 'mom')!;
    expect(planChat(level1, intent)).toMatchObject({ kind: 'shopping', add: false, reason: 'level1' });
    const paused = viewFor({ ...state, family: { ...state.family, paused: true } }, 'mom')!;
    expect(planChat(paused, intent)).toMatchObject({ kind: 'shopping', add: false, reason: 'paused' });
  });

  it('the fake model reads the phrasings used in tests and rehearsal', () => {
    const reply = (text: string, lang: 'en' | 'zh' = 'en') => {
      const prompt = intentPrompt({ view, now: NOW, lang, text, stores });
      return JSON.parse(fakeReply(prompt.system, prompt.user, false)) as Record<string, unknown>;
    };
    expect(reply('Add milk and 2 lemons to the shopping list')).toEqual({
      intent: 'add_to_shopping',
      items: [
        { storeId: 'supermarket', name: 'milk', qty: null, note: null },
        { storeId: 'supermarket', name: 'lemons', qty: 2, note: null }
      ]
    });
    expect(reply('Put plasters on the pharmacy list')).toMatchObject({ intent: 'add_to_shopping', items: [{ storeId: 'pharmacy', name: 'plasters' }] });
    expect(reply('购物清单加上酸奶和面条', 'zh')).toMatchObject({ intent: 'add_to_shopping', items: [{ storeId: 'supermarket', name: '酸奶' }, { storeId: 'supermarket', name: '面条' }] });
    // A question about the list is not an add.
    expect(reply("What's on the shopping list?").intent).not.toBe('add_to_shopping');
    expect(reply('Remove milk from the shopping list').intent).not.toBe('add_to_shopping');
  });

  it('the chat card shows what was added with Undo, and the suggestion with a button', () => {
    const item = { storeId: 'pharmacy', store: 'Pharmacy', storeZh: '药店', name: 'Plasters', qty: 2 };
    const card = (outcome: Parameters<typeof chatTurn>[0]['outcome'], lang: 'en' | 'zh' = 'en') =>
      A2uiSurfaceStore.fromJsonl(chatTurn({ lang, now: new Date(NOW).toISOString(), view, llm: 'fake', turnId: 't1', outcome }).jsonl).list()[0];
    const added = card({ kind: 'shopping', added: [item], duplicates: [{ ...item, name: 'Milk', store: 'Supermarket', storeZh: '超市', qty: 1 }], undoId: 'su-7' });
    expect(added.data.shop).toEqual([{ label: 'Pharmacy', value: 'Plasters ×2', tone: 'muted' }]);
    expect(added.components.actions.actions?.[0].args).toEqual({ verb: 'shop-undo', undoId: 'su-7' });
    const zh = card({ kind: 'shopping', added: [item], duplicates: [], undoId: 'su-7' }, 'zh');
    expect(zh.data.shop).toEqual([{ label: '药店', value: 'Plasters ×2', tone: 'muted' }]);
    const suggest = card({ kind: 'shopping-suggest', items: [item], reason: 'level1' });
    expect(suggest.components.actions.actions?.[0].args).toEqual({ verb: 'shop-add-many', items: [{ storeId: 'pharmacy', name: 'Plasters', qty: 2 }] });
  });
});

// --- through the bridge ----------------------------------------------------------------------------------

const ENV_KEYS = ['HOMEMIND_ENABLED', 'HOMEMIND_SECRET', 'HOMEMIND_DEMO', 'HOMEMIND_DATA_FILE', 'HOMEMIND_LLM'] as const;
const saved: Record<string, string | undefined> = {};
let server: Server;
let base = '';
let dir = '';

async function login(memberId: string): Promise<string> {
  const res = await fetch(`${base}/api/homemind/session`, { method: 'POST', body: JSON.stringify({ memberId }) });
  return ((await res.json()) as { token: string }).token;
}
const post = (token: string, path: string, body: unknown) => fetch(`${base}/api/homemind${path}`, { method: 'POST', headers: { [SESSION_HEADER]: token }, body: JSON.stringify(body) });
const stateNow = async () => (await (await fetch(`${base}/api/homemind/debug/state`)).json()) as HomemindState;

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
  dir = await mkdtemp(join(tmpdir(), 'homemind-shop-undo-'));
  Object.assign(process.env, { HOMEMIND_ENABLED: '1', HOMEMIND_SECRET: 'test-secret-0123456789', HOMEMIND_DEMO: '1', HOMEMIND_DATA_FILE: join(dir, 'state.json'), HOMEMIND_LLM: 'fake' });
  resetHomemindRuntime();
});

afterEach(async () => {
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

describe('shopping Undo, finish and chat through the bridge', () => {
  it('a list change answers with an undo id, and Undo puts it back', async () => {
    const mom = await login('mom');
    const res = await post(mom, '/shopping', { action: 'remove-item', itemId: 'shop-5' });
    const body = (await res.json()) as { undoId?: string };
    expect(body.undoId).toMatch(/^su-\d+$/);
    expect((await stateNow()).shopping?.items.some(i => i.id === 'shop-5')).toBe(false);
    expect((await post(mom, '/shopping', { action: 'undo', undoId: body.undoId })).status).toBe(200);
    expect((await stateNow()).shopping?.items.find(i => i.id === 'shop-5')).toMatchObject({ name: 'Vitamin D drops' });
    // The screen never carries the Undo records.
    const screen = (await (await fetch(`${base}/api/homemind/screen/shopping?lang=en`, { headers: { [SESSION_HEADER]: mom } })).json()) as { view: { shopping?: unknown }; shopping?: Record<string, unknown> };
    expect(JSON.stringify(screen)).not.toContain('"undo"');
  });

  it('Finished shopping takes off the bought items only; the board Undo brings them and the run back', async () => {
    const dad = await login('dad');
    const claim = (await (await post(dad, '/shopping', { action: 'claim', storeId: 'supermarket' })).json()) as { activityId?: string; taskId?: string };
    expect(claim.activityId && claim.taskId).toBeTruthy();
    await post(dad, '/shopping', { action: 'bought', itemId: 'shop-1', bought: true });
    await post(dad, '/shopping', { action: 'bought', itemId: 'shop-4', bought: true });
    const finished = (await (await post(dad, '/shopping', { action: 'finish', storeId: 'supermarket' })).json()) as { cleared: number; activityId: string; taskId: string };
    expect(finished.cleared).toBe(2);
    const after = await stateNow();
    expect(after.shopping?.items.filter(i => i.storeId === 'supermarket').map(i => i.name)).toEqual(['Eggs', 'Apples']);
    expect(shoppingOf(after).stores.find(s => s.id === 'supermarket')?.run).toBeUndefined();
    // Undo on the board, the same call the notice's Undo makes.
    const undo = await post(dad, `/items/${finished.taskId}/undo`, { activityId: finished.activityId });
    expect(undo.status).toBe(200);
    const back = await stateNow();
    expect(back.shopping?.items.filter(i => i.storeId === 'supermarket').map(i => i.name).sort()).toEqual(['Apples', 'Bread', 'Eggs', 'Milk']);
    expect(shoppingOf(back).stores.find(s => s.id === 'supermarket')?.run?.memberId).toBe('dad');
  });

  it('the Family chat adds to the list, with one Undo; the card button adds at level 1', async () => {
    const maya = await login('maya');
    const res = await post(maya, '/chat', { text: 'Add yogurt and 2 lemons to the shopping list' });
    expect(res.status).toBe(200);
    const turn = (await res.json()) as { outcome: string; intent: string; undoId?: string; jsonl: string };
    expect(turn).toMatchObject({ outcome: 'shopping', intent: 'add_to_shopping' });
    const card = A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0];
    expect(card.data.shop).toEqual([
      { label: 'Supermarket', value: 'yogurt', tone: 'muted' },
      { label: 'Supermarket', value: 'lemons ×2', tone: 'muted' }
    ]);
    const added = (await stateNow()).shopping?.items.filter(i => i.addedBy === 'maya' && ['yogurt', 'lemons'].includes(i.name));
    expect(added?.map(i => i.qty)).toEqual([1, 2]);
    // Undo from the card removes both.
    expect((await post(maya, '/shopping', { action: 'undo', undoId: turn.undoId })).status).toBe(200);
    expect((await stateNow()).shopping?.items.some(i => i.name === 'yogurt' || i.name === 'lemons')).toBe(false);
    // The card's "Add to the list" (level 1): several items in one request.
    const many = (await (await post(maya, '/shopping', { action: 'add-items', items: [{ storeId: 'market', name: 'Plums', qty: 3 }, { storeId: 'market', name: 'Tomatoes' }] })).json()) as { added: number; duplicates: number; undoId?: string };
    expect(many).toMatchObject({ added: 1, duplicates: 1 });
    expect(many.undoId).toMatch(/^su-/);
  });
});
