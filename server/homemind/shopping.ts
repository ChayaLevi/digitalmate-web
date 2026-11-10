/**
 * The family's shopping lists, grouped by store type (supermarket, pharmacy, post office...).
 *
 * Any member adds things to a store's list. One member takes a store's shopping run ("I'll go"), the
 * others see who, and only that member releases it. Items are marked bought (and back), and bought items
 * are cleared. A member may add their own stores; a store they added goes away only when its list is empty.
 *
 * Taking a run puts a task on the board ("Shopping at Supermarket", today, owned by the member), so it is
 * on their My day. Releasing the run removes that task. The task leads: when it is marked done ("Finished
 * shopping" on the Shopping screen does that too), the bought items leave the list, the rest stay for next
 * time, and the store is free; Undo on the board brings the run and those items back. Removed, handed off
 * or its creation undone, the run is over and the whole list stays.
 *
 * Every list change (add, remove, bought, quantity, clear, a store added or removed) keeps an Undo record:
 * the member who made it, or a parent, can undo it while nothing it touched has changed again.
 *
 * Pure: no networking, no clock of its own (`now` is passed in), the state is never mutated. The whole
 * family sees the lists (the family model's default); nothing here is "Parents only".
 */
import { fixedClock } from './clock';
import { applyChange } from './core';
import type { CoreEvent } from './core';
import type { HomemindState, ShoppingItem, ShoppingState, ShoppingStore, ShoppingUndo } from './types';

export const SHOPPING_LIMITS = { maxStores: 20, maxItems: 300, maxName: 80, maxNote: 120, maxStoreName: 40, maxQty: 99, undo: 30, chatItems: 10 } as const;

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
 * After a change on the board:
 * - a run whose task was marked done: the shopping at that store was done. The **bought** items leave the
 *   list; the rest stay for next time; the store is free. The run is kept as `settled` with what it cleared.
 * - a settled run whose task is open again (Undo on the board): the cleared items and the run come back.
 * - a run whose task was reassigned follows its new owner.
 * - a run whose task was removed, handed off or is gone: released; the whole list stays.
 * Returns `state` itself when nothing changed.
 */
export function settleShoppingRuns(state: HomemindState): HomemindState {
  if (!state.shopping) return state;
  let items = state.shopping.items;
  let changed = false;
  const stores = state.shopping.stores.map(store => {
    const run = store.run;
    if (!run?.itemId) return store;
    const task = state.items.find(i => i.id === run.itemId);
    if (task?.status === 'done') {
      if (run.settled) return store;
      const cleared = items.filter(i => i.storeId === store.id && i.bought);
      items = items.filter(i => !(i.storeId === store.id && i.bought));
      changed = true;
      return { ...store, run: { ...run, settled: { cleared } } };
    }
    if (task && task.status === 'open' && task.ownership.state === 'assigned') {
      let next: ShoppingStore = store;
      if (run.settled) {
        const have = new Set(items.map(i => i.id));
        items = [...items, ...run.settled.cleared.filter(i => !have.has(i.id))];
        const { settled: _settled, ...rest } = run;
        next = { ...store, run: rest };
        changed = true;
      }
      if (task.ownership.ownerId !== run.memberId) {
        next = { ...next, run: { ...(next.run as NonNullable<ShoppingStore['run']>), memberId: task.ownership.ownerId } };
        changed = true;
      }
      return next;
    }
    changed = true;
    return withoutRun(store);
  });
  return changed ? { ...state, shopping: { ...state.shopping, stores, items } } : state;
}

function withoutRun(store: ShoppingStore): ShoppingStore {
  const { run: _run, ...rest } = store;
  return rest;
}

export type ShoppingRequest =
  | { action: 'add-item'; storeId: string; name: string; qty?: number; note?: string }
  | { action: 'remove-item'; itemId: string }
  | { action: 'bought'; itemId: string; bought: boolean }
  | { action: 'clear-bought'; storeId: string }
  | { action: 'claim'; storeId: string }
  | { action: 'release'; storeId: string }
  | { action: 'add-store'; name: string }
  | { action: 'remove-store'; storeId: string }
  /** One more of an item already on the list. */
  | { action: 'bump'; itemId: string }
  /** One less, never below one (Remove takes the item off). */
  | { action: 'unbump'; itemId: string }
  /** A new quantity for an item already on the list. */
  | { action: 'set-qty'; itemId: string; qty: number }
  /** Undo one list change (its record id, `su-<n>`). */
  | { action: 'undo'; undoId: string }
  /** The member going is back: their run's task is marked done, so the bought items leave the list. */
  | { action: 'finish'; storeId: string };

/** How an item's name is compared: case, spaces and the Chinese name don't make it a different item. */
const sameName = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, ' ').trim() === b.toLowerCase().replace(/\s+/g, ' ').trim();

/** The item already waiting to be bought at that store under that name, if there is one. */
export function findDuplicate(shopping: ShoppingState, storeId: string, name: string): ShoppingItem | undefined {
  return shopping.items.find(i => i.storeId === storeId && !i.bought && (sameName(i.name, name) || (!!i.nameZh && sameName(i.nameZh, name))));
}

/** How many: absent means one. */
export const qtyOf = (item: Pick<ShoppingItem, 'qty'>): number => item.qty ?? 1;

export type ShoppingParse = { ok: true; value: ShoppingRequest } | { ok: false; message: string };

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEYS: Record<ShoppingRequest['action'], string[]> = {
  'add-item': ['storeId', 'name', 'qty', 'note'],
  'remove-item': ['itemId'],
  bought: ['itemId', 'bought'],
  'clear-bought': ['storeId'],
  claim: ['storeId'],
  release: ['storeId'],
  'add-store': ['name'],
  'remove-store': ['storeId'],
  bump: ['itemId'],
  unbump: ['itemId'],
  'set-qty': ['itemId', 'qty'],
  undo: ['undoId'],
  finish: ['storeId']
};
const UNDO_ID = /^su-\d{1,6}$/;

/** One line of the family's own words: control characters out, spaces collapsed, trimmed. */
function line(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** Checks a request body (`POST /shopping`). Unknown fields, bad ids and over-long words are refused. */
export function parseShoppingBody(body: Record<string, unknown>): ShoppingParse {
  const action = body.action as ShoppingRequest['action'];
  if (typeof action !== 'string' || !(action in KEYS)) return { ok: false, message: 'action is add-item, remove-item, bought, clear-bought, claim, release, finish, add-store, remove-store, bump, unbump, set-qty or undo' };
  const extra = Object.keys(body).find(k => k !== 'action' && !KEYS[action].includes(k));
  if (extra) return { ok: false, message: `Unknown shopping field: ${extra.slice(0, 40)}` };
  const qty = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SHOPPING_LIMITS.maxQty ? value : null);
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
      if (body.qty !== undefined && qty(body.qty) === null) return { ok: false, message: `The quantity is a whole number from 1 to ${SHOPPING_LIMITS.maxQty}` };
      return { ok: true, value: { action, storeId, name, ...(body.qty !== undefined ? { qty: body.qty as number } : {}), ...(note ? { note } : {}) } };
    }
    case 'remove-item':
    case 'bump':
    case 'unbump':
    case 'set-qty':
    case 'bought': {
      const itemId = id('itemId');
      if (!itemId) return { ok: false, message: 'itemId is not a valid id' };
      if (action === 'remove-item' || action === 'bump' || action === 'unbump') return { ok: true, value: { action, itemId } };
      if (action === 'set-qty') {
        const value = qty(body.qty);
        if (value === null) return { ok: false, message: `The quantity is a whole number from 1 to ${SHOPPING_LIMITS.maxQty}` };
        return { ok: true, value: { action, itemId, qty: value } };
      }
      if (typeof body.bought !== 'boolean') return { ok: false, message: 'bought must be true or false' };
      return { ok: true, value: { action, itemId, bought: body.bought } };
    }
    case 'undo': {
      if (typeof body.undoId !== 'string' || !UNDO_ID.test(body.undoId)) return { ok: false, message: 'undoId is not a valid id' };
      return { ok: true, value: { action, undoId: body.undoId } };
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
      /** Nothing added: this item is already waiting to be bought there. The member is asked what to do with it. */
      duplicateOf?: string;
      /** The board task a claim created, a release removed or a finish marked done (core events, for the live streams and reminders). */
      events?: CoreEvent[];
      taskId?: string;
      /** That board change, for the board's own Undo. */
      activityId?: string;
      /** A list change: its Undo record. */
      undoId?: string;
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
  // `current` is what members see (a finished run is over); `raw` is what is saved (a settled run is kept for Undo).
  const current = shoppingOf(state);
  const raw = state.shopping ?? current;
  const store = 'storeId' in request ? current.stores.find(s => s.id === request.storeId) : undefined;
  const item = 'itemId' in request ? current.items.find(i => i.id === request.itemId) : undefined;
  /** A list change: saved with its Undo record. */
  const done = (shopping: ShoppingState, extra: { itemId?: string; storeId?: string } = {}): ShoppingResult => {
    const recorded = withUndo(raw, shopping, memberId, at);
    return { ok: true, state: { ...state, shopping: recorded.shopping }, changed: true, undoId: recorded.undoId, ...extra };
  };
  const same = (): ShoppingResult => ({ ok: true, state, changed: false });
  const setStore = (next: ShoppingStore) => raw.stores.map(s => (s.id === next.id ? next : s));

  switch (request.action) {
    case 'add-item': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      // Already on that list (and not bought yet): nothing is added; the member chooses +1, a new quantity, or to keep it.
      const twin = findDuplicate(current, store.id, request.name);
      if (twin) return { ok: true, state, changed: false, duplicateOf: twin.id, itemId: twin.id, storeId: store.id };
      if (current.items.length >= SHOPPING_LIMITS.maxItems) return refuse(409, 'full', 'The shopping lists are full. Clear the bought items first.');
      const { id: itemId, n } = nextId('shop', new Set(current.items.map(i => i.id)), current.lastItem);
      const added: ShoppingItem = { id: itemId, storeId: store.id, name: request.name, qty: request.qty ?? 1, ...(request.note ? { note: request.note } : {}), addedBy: memberId, addedAt: at };
      return done({ ...raw, items: [...raw.items, added], lastItem: n }, { itemId, storeId: store.id });
    }
    case 'remove-item': {
      if (!item) return refuse(404, 'not_found', 'That item is no longer on the list');
      return done({ ...raw, items: raw.items.filter(i => i.id !== item.id) }, { itemId: item.id, storeId: item.storeId });
    }
    case 'bought': {
      if (!item) return refuse(404, 'not_found', 'That item is no longer on the list');
      if (!!item.bought === request.bought) return same();
      const { bought: _was, ...rest } = item;
      const next: ShoppingItem = request.bought ? { ...rest, bought: { by: memberId, at } } : rest;
      return done({ ...raw, items: raw.items.map(i => (i.id === item.id ? next : i)) }, { itemId: item.id, storeId: item.storeId });
    }
    case 'bump':
    case 'unbump':
    case 'set-qty': {
      if (!item) return refuse(404, 'not_found', 'That item is no longer on the list');
      const have = qtyOf(item);
      const next = request.action === 'bump' ? Math.min(have + 1, SHOPPING_LIMITS.maxQty) : request.action === 'unbump' ? Math.max(have - 1, 1) : request.qty;
      if (next === have) return same();
      return done({ ...raw, items: raw.items.map(i => (i.id === item.id ? { ...i, qty: next } : i)) }, { itemId: item.id, storeId: item.storeId });
    }
    case 'clear-bought': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      const left = raw.items.filter(i => !(i.storeId === store.id && i.bought));
      if (left.length === raw.items.length) return same();
      return done({ ...raw, items: left }, { storeId: store.id });
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
      const shopping = { ...raw, stores: setStore({ ...store, run: { memberId, at, itemId: taskId } }) };
      return { ok: true, state: { ...task.state, shopping }, changed: true, storeId: store.id, events: task.events, taskId, activityId: task.activity.id };
    }
    case 'release': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      if (!store.run) return same();
      if (store.run.memberId !== memberId) return refuse(403, 'forbidden', 'Only the member who took this shopping run can release it');
      const shopping = { ...raw, stores: setStore(withoutRun(store)) };
      const task = state.items.find(i => i.id === store.run?.itemId && i.status === 'open');
      if (!task) return { ok: true, state: { ...state, shopping }, changed: true, storeId: store.id };
      // Its task leaves the board too (kept as removed, so the board's Undo can bring it back).
      const removed = applyChange(state, { kind: 'cancel', itemId: task.id, version: task.version }, memberId, fixedClock(now));
      if (!removed.ok) return refuse(removed.status, removed.code, removed.message);
      return { ok: true, state: { ...removed.state, shopping }, changed: true, storeId: store.id, events: removed.events, taskId: task.id };
    }
    case 'finish': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      if (!store.run) return refuse(409, 'no_run', 'Nobody is going to this store');
      if (store.run.memberId !== memberId) return refuse(403, 'forbidden', 'Only the member who took this shopping run can finish it');
      const task = state.items.find(i => i.id === store.run?.itemId && i.status === 'open');
      if (!task) return refuse(409, 'no_run', 'This shopping run is no longer on the board');
      // Marked done like on the board; settleShoppingRuns (in the bridge's commit) then takes the bought items off.
      const finished = applyChange(state, { kind: 'done', itemId: task.id, version: task.version }, memberId, fixedClock(now));
      if (!finished.ok) return refuse(finished.status, finished.code, finished.message);
      return { ok: true, state: finished.state, changed: true, storeId: store.id, events: finished.events, taskId: task.id, activityId: finished.activity.id };
    }
    case 'undo':
      return undoShopping(state, raw, request.undoId, memberId, at);
    case 'add-store': {
      const lower = request.name.toLowerCase();
      if (current.stores.some(s => s.name.toLowerCase() === lower || s.nameZh === request.name)) return refuse(409, 'exists', 'That store is already on the list');
      if (current.stores.length >= SHOPPING_LIMITS.maxStores) return refuse(409, 'full', 'There are enough stores. Remove one you no longer use.');
      const storeId = storeIdFor(request.name, new Set(current.stores.map(s => s.id)));
      return done({ ...raw, stores: [...raw.stores, { id: storeId, name: request.name, custom: true, createdBy: memberId }] }, { storeId });
    }
    case 'remove-store': {
      if (!store) return refuse(404, 'not_found', 'No such store');
      if (!store.custom) return refuse(400, 'invalid', 'The default stores stay');
      if (current.items.some(i => i.storeId === store.id)) return refuse(409, 'not_empty', 'Clear this store’s list first');
      if (store.run) return refuse(409, 'taken', 'Someone is going to this store. Release the run first.');
      return done({ ...raw, stores: raw.stores.filter(s => s.id !== store.id) }, { storeId: store.id });
    }
  }
}

// --- Undo --------------------------------------------------------------------------------------------------

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** A store as an Undo record compares it: who is going is not part of a list change. */
const plainStore = (s: ShoppingStore | undefined) => (s ? withoutRun(s) : undefined);

function diffById<T extends { id: string }>(before: readonly T[], after: readonly T[]): Array<{ id: string; before?: T; after?: T; index?: number }> {
  const ids = [...new Set([...before.map(x => x.id), ...after.map(x => x.id)])];
  return ids.flatMap(id => {
    const b = before.find(x => x.id === id);
    const a = after.find(x => x.id === id);
    return sameJson(b, a) ? [] : [{ id, ...(b ? { before: b } : {}), ...(a ? { after: a } : {}), ...(b && !a ? { index: before.indexOf(b) } : {}) }];
  });
}

/** `list` with `entry` in its old place (or at the end). */
function putBack<T>(list: readonly T[], entry: T, index: number | undefined): T[] {
  const at = index === undefined ? list.length : Math.min(Math.max(index, 0), list.length);
  return [...list.slice(0, at), entry, ...list.slice(at)];
}

/** `next` with an Undo record of what changed from `prev` (items, and stores without their runs). */
function withUndo(prev: ShoppingState, next: ShoppingState, by: string, at: string): { shopping: ShoppingState; undoId: string } {
  const n = (prev.lastUndo ?? 0) + 1;
  const record: ShoppingUndo = {
    id: `su-${n}`,
    at,
    by,
    items: diffById(prev.items, next.items),
    stores: diffById(prev.stores.map(s => plainStore(s) as ShoppingStore), next.stores.map(s => plainStore(s) as ShoppingStore))
  };
  const undo = [...(prev.undo ?? []), record].slice(-SHOPPING_LIMITS.undo);
  return { shopping: { ...next, undo, lastUndo: n }, undoId: record.id };
}

/**
 * Puts back what one list change touched, as it was before. Only the member who made it or a parent, once,
 * and only while every item and store it touched is still as that change left it (otherwise 409: someone
 * changed it since, and an Undo would overwrite their change).
 */
function undoShopping(state: HomemindState, raw: ShoppingState, undoId: string, memberId: string, at: string): ShoppingResult {
  const record = (raw.undo ?? []).find(u => u.id === undoId);
  if (!record) return refuse(404, 'not_found', 'Nothing to undo');
  if (record.undone) return { ok: true, state, changed: false };
  const isParent = state.family.members.some(m => m.id === memberId && m.role === 'parent');
  if (record.by !== memberId && !isParent) return refuse(403, 'forbidden', 'Only the member who made this change, or a parent, can undo it');
  const changedSince = () => refuse(409, 'changed', 'The list changed since, so this can no longer be undone');
  for (const entry of record.items) if (!sameJson(raw.items.find(i => i.id === entry.id), entry.after)) return changedSince();
  for (const entry of record.stores) if (!sameJson(plainStore(raw.stores.find(s => s.id === entry.id)), entry.after)) return changedSince();

  let stores = raw.stores;
  for (const entry of record.stores) {
    const now = stores.find(s => s.id === entry.id);
    if (entry.before) {
      const before = entry.before;
      stores = now ? stores.map(s => (s.id === entry.id ? { ...before, ...(now.run ? { run: now.run } : {}) } : s)) : putBack(stores, before, entry.index);
    } else if (now?.run) return refuse(409, 'taken', 'Someone is going to this store. Release the run first.');
    else stores = stores.filter(s => s.id !== entry.id);
  }
  let items = raw.items;
  const ordered = [...record.items].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
  for (const entry of ordered) {
    const before = entry.before;
    if (before) items = items.some(i => i.id === entry.id) ? items.map(i => (i.id === entry.id ? before : i)) : putBack(items, before, entry.index);
    else items = items.filter(i => i.id !== entry.id);
  }
  const storeIds = new Set(stores.map(s => s.id));
  if (items.some(i => !storeIds.has(i.storeId))) return changedSince();
  const undo = (raw.undo ?? []).map(u => (u.id === record.id ? { ...u, undone: at } : u));
  return { ok: true, state: { ...state, shopping: { ...raw, stores, items, undo } }, changed: true };
}

// --- from chat ---------------------------------------------------------------------------------------------

/**
 * `POST /shopping {action: 'add-items', items}` (the chat card's "Add to the list"): the list's shape only;
 * each entry is checked again by `addShoppingItems` with the form's rules.
 */
export function parseShoppingItems(body: Record<string, unknown>): { ok: true; value: ShoppingEntry[] } | { ok: false; message: string } {
  const extra = Object.keys(body).find(k => k !== 'action' && k !== 'items');
  if (extra) return { ok: false, message: `Unknown shopping field: ${extra.slice(0, 40)}` };
  const items = body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > SHOPPING_LIMITS.chatItems) return { ok: false, message: `items is a list of 1 to ${SHOPPING_LIMITS.chatItems}` };
  const value: ShoppingEntry[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, message: 'Each item is an object' };
    const e = entry as Record<string, unknown>;
    const unknown = Object.keys(e).find(k => !['storeId', 'name', 'qty', 'note'].includes(k));
    if (unknown) return { ok: false, message: `Unknown item field: ${unknown.slice(0, 40)}` };
    if (typeof e.storeId !== 'string' || typeof e.name !== 'string') return { ok: false, message: 'Each item needs a storeId and a name' };
    if (e.qty !== undefined && typeof e.qty !== 'number') return { ok: false, message: 'qty must be a number' };
    if (e.note !== undefined && typeof e.note !== 'string') return { ok: false, message: 'note must be text' };
    value.push({ storeId: e.storeId, name: e.name, ...(typeof e.qty === 'number' ? { qty: e.qty } : {}), ...(typeof e.note === 'string' && e.note ? { note: e.note } : {}) });
  }
  return { ok: true, value };
}

export interface ShoppingEntry {
  storeId: string;
  name: string;
  qty?: number;
  note?: string;
}

export type ShoppingAddResult =
  | { ok: true; state: HomemindState; added: ShoppingItem[]; duplicates: ShoppingItem[]; undoId?: string }
  | { ok: false; status: 400 | 403 | 404 | 409; code: string; message: string };

/**
 * Several items at once (a chat message: "milk and eggs, and plasters from the pharmacy"), as one change with
 * one Undo. Something already waiting at that store is not added again: it comes back in `duplicates`.
 * Every entry is checked with the same rules as the Shopping screen's form.
 */
export function addShoppingItems(state: HomemindState, entries: readonly ShoppingEntry[], memberId: string, now: number): ShoppingAddResult {
  if (!state.family.members.some(m => m.id === memberId && m.hasAccount)) return { ok: false, status: 403, code: 'forbidden', message: 'Only a family member can change the shopping lists' };
  if (!entries.length || entries.length > SHOPPING_LIMITS.chatItems) return { ok: false, status: 400, code: 'invalid', message: `Add 1 to ${SHOPPING_LIMITS.chatItems} items at a time` };
  const at = new Date(now).toISOString();
  const raw = state.shopping ?? shoppingOf(state);
  let next: ShoppingState = raw;
  const added: ShoppingItem[] = [];
  const duplicates: ShoppingItem[] = [];
  for (const entry of entries) {
    const parsed = parseShoppingBody({ action: 'add-item', storeId: entry.storeId, name: entry.name, ...(entry.qty !== undefined ? { qty: entry.qty } : {}), ...(entry.note ? { note: entry.note } : {}) });
    if (!parsed.ok) return { ok: false, status: 400, code: 'invalid', message: parsed.message };
    if (parsed.value.action !== 'add-item') return { ok: false, status: 400, code: 'invalid', message: 'Not an item to add' };
    const request = parsed.value;
    if (!next.stores.some(s => s.id === request.storeId)) return { ok: false, status: 404, code: 'not_found', message: 'No such store' };
    const twin = findDuplicate(next, request.storeId, request.name);
    if (twin) {
      if (!duplicates.some(d => d.id === twin.id)) duplicates.push(twin);
      continue;
    }
    if (next.items.length >= SHOPPING_LIMITS.maxItems) return { ok: false, status: 409, code: 'full', message: 'The shopping lists are full. Clear the bought items first.' };
    const { id, n } = nextId('shop', new Set(next.items.map(i => i.id)), next.lastItem);
    const item: ShoppingItem = { id, storeId: request.storeId, name: request.name, qty: request.qty ?? 1, ...(request.note ? { note: request.note } : {}), addedBy: memberId, addedAt: at };
    added.push(item);
    next = { ...next, items: [...next.items, item], lastItem: n };
  }
  if (!added.length) return { ok: true, state, added, duplicates };
  const recorded = withUndo(raw, next, memberId, at);
  return { ok: true, state: { ...state, shopping: recorded.shopping }, added, duplicates, undoId: recorded.undoId };
}
