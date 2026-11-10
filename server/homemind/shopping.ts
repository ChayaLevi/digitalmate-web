/**
 * The family's shopping lists, grouped by store type (supermarket, pharmacy, post office...).
 *
 * Any member adds things to a store's list. One member takes a store's shopping run ("I'm going"), the
 * others see who, and only that member releases it. Items are marked bought (and back), and bought items
 * are cleared. A member may add their own stores; a store they added goes away only when its list is empty.
 *
 * Taking a run puts a task on the board ("Shopping at Supermarket", today, owned by the member), so it is
 * on their My day. Releasing the run removes that task. The task leads: when it is marked done or removed
 * on the board (or its creation undone), the run is over, and the store is free again.
 *
 * Pure: no networking, no clock of its own (`now` is passed in), the state is never mutated. The whole
 * family sees the lists (the family model's default); nothing here is "Parents only".
 */
import { fixedClock } from './clock';
import { applyChange } from './core';
import type { CoreEvent } from './core';
import type { HomemindState, ShoppingItem, ShoppingState, ShoppingStore } from './types';

export const SHOPPING_LIMITS = { maxStores: 20, maxItems: 300, maxName: 80, maxNote: 120, maxStoreName: 40 } as const;

/** The stores every family starts with. Fixed ids, so a reset gives the same lists. */
export const DEFAULT_STORES: readonly ShoppingStore[] = [
  { id: 'supermarket', name: 'Supermarket', nameZh: '超市' },
  { id: 'pharmacy', name: 'Pharmacy', nameZh: '药店' },
  { id: 'mall', name: 'Mall', nameZh: '商场' },
  { id: 'post-office', name: 'Post office', nameZh: '邮局' },
  { id: 'hardware', name: 'Hardware store', nameZh: '五金店' },
  { id: 'market', name: 'Market', nameZh: '菜市场' }
];

/**
 * The lists as they are, or the default stores with nothing on them (older files, a fresh seed). A run
 * whose board task is done, removed or gone is over, so it is left out.
 */
export function shoppingOf(state: HomemindState): ShoppingState {
  const shopping = state.shopping ?? { stores: DEFAULT_STORES.map(s => ({ ...s })), items: [] };
  // The task leads: assigned to someone else on the board, the run is theirs; handed off, done or removed, it is over.
  const follow = (s: ShoppingStore): ShoppingStore => {
    if (!s.run?.itemId) return s;
    const task = state.items.find(i => i.id === s.run?.itemId);
    if (!task || task.status !== 'open' || task.ownership.state !== 'assigned') return withoutRun(s);
    return task.ownership.ownerId === s.run.memberId ? s : { ...s, run: { ...s.run, memberId: task.ownership.ownerId } };
  };
  const stores = shopping.stores.map(follow);
  return stores.every((s, i) => s === shopping.stores[i]) ? shopping : { ...shopping, stores };
}

/**
 * After a change on the board: a run whose task was marked done means the shopping at that store was
 * done, so that store's list starts again empty and the store is free. A run whose task was removed or
 * handed off is only released (the list stays). Returns `state` itself when nothing changed.
 */
export function settleShoppingRuns(state: HomemindState): HomemindState {
  if (!state.shopping) return state;
  const finished = new Set(
    state.shopping.stores.filter(s => s.run?.itemId && state.items.some(i => i.id === s.run?.itemId && i.status === 'done')).map(s => s.id)
  );
  const normal = shoppingOf(state);
  const runsChanged = normal.stores.some((s, i) => s !== state.shopping?.stores[i]);
  if (!finished.size && !runsChanged) return state;
  return { ...state, shopping: { ...normal, items: normal.items.filter(i => !finished.has(i.storeId)) } };
}

function withoutRun(store: ShoppingStore): ShoppingStore {
  const { run: _run, ...rest } = store;
  return rest;
}

export type ShoppingRequest =
  | { action: 'add-item'; storeId: string; name: string; note?: string }
  | { action: 'remove-item'; itemId: string }
  | { action: 'bought'; itemId: string; bought: boolean }
  | { action: 'clear-bought'; storeId: string }
  | { action: 'claim'; storeId: string }
  | { action: 'release'; storeId: string }
  | { action: 'add-store'; name: string }
  | { action: 'remove-store'; storeId: string };

export type ShoppingParse = { ok: true; value: ShoppingRequest } | { ok: false; message: string };

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEYS: Record<ShoppingRequest['action'], string[]> = {
  'add-item': ['storeId', 'name', 'note'],
  'remove-item': ['itemId'],
  bought: ['itemId', 'bought'],
  'clear-bought': ['storeId'],
  claim: ['storeId'],
  release: ['storeId'],
  'add-store': ['name'],
  'remove-store': ['storeId']
};

/** One line of the family's own words: control characters out, spaces collapsed, trimmed. */
function line(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** Checks a request body (`POST /shopping`). Unknown fields, bad ids and over-long words are refused. */
export function parseShoppingBody(body: Record<string, unknown>): ShoppingParse {
  const action = body.action as ShoppingRequest['action'];
  if (typeof action !== 'string' || !(action in KEYS)) return { ok: false, message: 'action is add-item, remove-item, bought, clear-bought, claim, release, add-store or remove-store' };
  const extra = Object.keys(body).find(k => k !== 'action' && !KEYS[action].includes(k));
  if (extra) return { ok: false, message: `Unknown shopping field: ${extra.slice(0, 40)}` };
  const id = (key: 'storeId' | 'itemId'): string | null => (typeof body[key] === 'string' && ID.test(body[key] as string) ? (body[key] as string) : null);
  switch (action) {
    case 'add-item': {
      const storeId = id('storeId');
      if (!storeId) return { ok: false, message: 'storeId is not a valid id' };
      const name = line(body.name);
      if (!name) return { ok: false, message: 'Write what to buy' };
      if (name.length > SHOPPING_LIMITS.maxName) return { ok: false, message: `Keep the item to ${SHOPPING_LIMITS.maxName} characters` };
      if (body.note !== undefined && typeof body.note !== 'string') return { ok: false, message: 'note must be text' };
      const note = line(body.note);
      if (note.length > SHOPPING_LIMITS.maxNote) return { ok: false, message: `Keep the quantity or note to ${SHOPPING_LIMITS.maxNote} characters` };
      return { ok: true, value: { action, storeId, name, ...(note ? { note } : {}) } };
    }
    case 'remove-item':
    case 'bought': {
      const itemId = id('itemId');
      if (!itemId) return { ok: false, message: 'itemId is not a valid id' };
      if (action === 'remove-item') return { ok: true, value: { action, itemId } };
      if (typeof body.bought !== 'boolean') return { ok: false, message: 'bought must be true or false' };
      return { ok: true, value: { action, itemId, bought: body.bought } };
    }
    case 'add-store': {
      // A store name is shown inside screen text, so characters that make links or bold there are dropped.
      const name = line(body.name).replace(/[[\]()*`_\\]/g, '').replace(/\s+/g, ' ').trim();
      if (!name) return { ok: false, message: 'Write the name of the store' };
      if (name.length > SHOPPING_LIMITS.maxStoreName) return { ok: false, message: `Keep the store name to ${SHOPPING_LIMITS.maxStoreName} characters` };
      return { ok: true, value: { action, name } };
    }
    default: {
      const storeId = id('storeId');
      if (!storeId) return { ok: false, message: 'storeId is not a valid id' };
      return { ok: true, value: { action, storeId } };
    }
  }
}

export type ShoppingResult =
  | {
      ok: true;
      state: HomemindState;
      changed: boolean;
      itemId?: string;
      storeId?: string;
      /** The board task a claim created or a release removed (core events, for the live streams and reminders). */
      events?: CoreEvent[];
      taskId?: string;
    }
  | { ok: false; status: 400 | 403 | 404 | 409; code: string; message: string };

const refuse = (status: 400 | 403 | 404 | 409, code: string, message: string): ShoppingResult => ({ ok: false, status, code, message });

/**
 * A new id: `shop-<n>` or `store-<n>`, counting up from the last one ever given (`last`), so an id is never
 * used twice: a button left on another screen can't act on a new item that took a deleted one's id.
 */
function nextId(prefix: string, taken: ReadonlySet<string>, last = 0): { id: string; n: number } {
  for (let n = Math.max(taken.size, last) + 1; ; n++) if (!taken.has(`${prefix}-${n}`)) return { id: `${prefix}-${n}`, n };
}

/** A store name made into an id ("Pet shop" → `pet-shop`), or a counted one for words with no Latin letters. */
function storeIdFor(name: string, taken: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (slug && ID.test(slug) && !taken.has(slug)) return slug;
  return nextId('store', taken).id;
}

/**
 * Applies one request by `memberId` at `now` (ms). Any member with an account may add, remove, mark and
 * clear; claiming a run that someone else holds is a 409, and only the member who holds it releases it.
 */
export function applyShopping(state: HomemindState, request: ShoppingRequest, memberId: string, now: number): ShoppingResult {
  if (!state.family.members.some(m => m.id === memberId && m.hasAccount)) return refuse(403, 'forbidden', 'Only a family member can change the shopping lists');
  const at = new Date(now).toISOString();
  const current = shoppingOf(state);
  const store = 'storeId' in request ? current.stores.find(s => s.id === request.storeId) : undefined;
  const item = 'itemId' in request ? current.items.find(i => i.id === request.itemId) : undefined;
  const done = (shopping: ShoppingState, extra: { itemId?: string; storeId?: string } = {}): ShoppingResult => ({ ok: true, state: { ...state, shopping }, changed: true, ...extra });
  const same = (): ShoppingResult => ({ ok: true, state, changed: false });
  const setStore = (next: ShoppingStore) => current.stores.map(s => (s.id === next.id ? next : s));

  switch (request.action) {
    case 'add-item': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      if (current.items.length >= SHOPPING_LIMITS.maxItems) return refuse(409, 'full', 'The shopping lists are full. Clear the bought items first.');
      const { id: itemId, n } = nextId('shop', new Set(current.items.map(i => i.id)), current.lastItem);
      const added: ShoppingItem = { id: itemId, storeId: store.id, name: request.name, ...(request.note ? { note: request.note } : {}), addedBy: memberId, addedAt: at };
      return done({ ...current, items: [...current.items, added], lastItem: n }, { itemId, storeId: store.id });
    }
    case 'remove-item': {
      if (!item) return refuse(404, 'not_found', 'That item is no longer on the list');
      return done({ ...current, items: current.items.filter(i => i.id !== item.id) }, { itemId: item.id, storeId: item.storeId });
    }
    case 'bought': {
      if (!item) return refuse(404, 'not_found', 'That item is no longer on the list');
      if (!!item.bought === request.bought) return same();
      const { bought: _was, ...rest } = item;
      const next: ShoppingItem = request.bought ? { ...rest, bought: { by: memberId, at } } : rest;
      return done({ ...current, items: current.items.map(i => (i.id === item.id ? next : i)) }, { itemId: item.id, storeId: item.storeId });
    }
    case 'clear-bought': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      const left = current.items.filter(i => !(i.storeId === store.id && i.bought));
      if (left.length === current.items.length) return same();
      return done({ ...current, items: left }, { storeId: store.id });
    }
    case 'claim': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      if (store.run?.memberId === memberId) return same();
      if (store.run) return refuse(409, 'taken', 'Someone else already took this shopping run');
      // The run goes on the member's own board as a task for today, with Undo like any other item.
      const task = applyChange(
        state,
        {
          kind: 'create',
          item: {
            type: 'task',
            title: `Shopping at ${store.name}`,
            ...(store.nameZh ? { titleZh: `去${store.nameZh}购物` } : {}),
            notes: 'From the shopping list. The list itself is on the Shopping screen.',
            start: at,
            allDay: true,
            ownership: { state: 'assigned', ownerId: memberId, confirmed: true },
            source: { kind: 'shopping', label: store.name }
          }
        },
        memberId,
        fixedClock(now)
      );
      if (!task.ok) return refuse(task.status, task.code, task.message);
      const taskId = task.items[0].id;
      const shopping = { ...current, stores: setStore({ ...store, run: { memberId, at, itemId: taskId } }) };
      return { ok: true, state: { ...task.state, shopping }, changed: true, storeId: store.id, events: task.events, taskId };
    }
    case 'release': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      if (!store.run) return same();
      if (store.run.memberId !== memberId) return refuse(403, 'forbidden', 'Only the member who took this shopping run can release it');
      const shopping = { ...current, stores: setStore(withoutRun(store)) };
      const task = state.items.find(i => i.id === store.run?.itemId && i.status === 'open');
      if (!task) return done(shopping, { storeId: store.id });
      // Its task leaves the board too (kept as removed, so the board's Undo can bring it back).
      const removed = applyChange(state, { kind: 'cancel', itemId: task.id, version: task.version }, memberId, fixedClock(now));
      if (!removed.ok) return refuse(removed.status, removed.code, removed.message);
      return { ok: true, state: { ...removed.state, shopping }, changed: true, storeId: store.id, events: removed.events, taskId: task.id };
    }
    case 'add-store': {
      const lower = request.name.toLowerCase();
      if (current.stores.some(s => s.name.toLowerCase() === lower || s.nameZh === request.name)) return refuse(409, 'exists', 'That store is already on the list');
      if (current.stores.length >= SHOPPING_LIMITS.maxStores) return refuse(409, 'full', 'There are enough stores. Remove one you no longer use.');
      const storeId = storeIdFor(request.name, new Set(current.stores.map(s => s.id)));
      return done({ ...current, stores: [...current.stores, { id: storeId, name: request.name, custom: true, createdBy: memberId }] }, { storeId });
    }
    case 'remove-store': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      if (!store.custom) return refuse(400, 'invalid', 'The default stores stay');
      if (current.items.some(i => i.storeId === store.id)) return refuse(409, 'not_empty', 'Clear this store’s list first');
      if (store.run) return refuse(409, 'taken', 'Someone is going to this store. Release the run first.');
      return done({ ...current, stores: current.stores.filter(s => s.id !== store.id) }, { storeId: store.id });
    }
  }
}

