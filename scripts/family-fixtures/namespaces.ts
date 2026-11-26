/**
 * Fixtures for HOPA's capability namespaces (plan task C3): `shopping`, `preferences`, `rules`.
 *
 * Each case drives Homemind's own code (shopping.ts, preferences.ts, rules.ts) step by step, and writes
 * the HOPA ops a device would send for the same step: board ops (v1) where Homemind changes the board,
 * and `v: 2` ops of the namespace. Ids come from Homemind's results (D10: the op carries them), and a
 * change that Homemind records for Undo gets its undo id as its op id. After each step the case records
 * what Homemind shows (the lists, the preferences, the rules) and the outcome, which a HOPA reducer must
 * match.
 */
import { applyChange } from '../../server/homemind/core';
import { fixedClock } from '../../server/homemind/clock';
import { addShoppingItems, applyShopping, settleShoppingRuns, shoppingOf } from '../../server/homemind/shopping';
import type { ShoppingEntry, ShoppingRequest } from '../../server/homemind/shopping';
import type { HomemindState, Item } from '../../server/homemind/types';
import { SCOPES } from './adapter';
import type { V1State } from './adapter';
import { seedV1 } from './build';
import { homemindOf } from './time';

const GENERATOR = 'scripts/family-fixtures/namespaces.ts (ChayaLevi/digitalmate-web, branch feat/family-fixtures)';
const at = (hhmm: string, date = '2026-11-11') => `${date}T${hhmm}:00.000Z`;

type Op = Record<string, unknown>;
interface Entry {
  seq: number;
  scope: 'family';
  memberId: string;
  fromDevice: string;
  op: Op;
}

const DEVICE: Record<string, string> = { mom: 'mom-phone', dad: 'dad-laptop', maya: 'maya-phone', noa: 'noa-tablet' };
const CODE: Record<string, string> = {
  not_found: 'not_found',
  forbidden: 'forbidden',
  invalid: 'invalid',
  full: 'conflict',
  taken: 'conflict',
  exists: 'conflict',
  not_empty: 'conflict',
  changed: 'conflict',
  no_run: 'conflict'
};

const stripItem = ({ visibility: _v, sourceRefs: _r, stale: _s, mailboxIds: _m, ...rest }: Item) => rest;

// ---------------------------------------------------------------------------------------------
// shopping

type ShoppingStep =
  | { by: string; at: string; request: ShoppingRequest }
  | { by: string; at: string; addMany: ShoppingEntry[] }
  | { by: string; at: string; board: { kind: string; [k: string]: unknown } };

interface ShoppingCase {
  name: string;
  description: string;
  steps: ShoppingStep[];
}

const SHOPPING_CASES: ShoppingCase[] = [
  {
    name: 'add-buy-clear',
    description: 'Add, a duplicate (refused: first writer wins), more of it, mark bought, unmark, clear what was bought.',
    steps: [
      { by: 'mom', at: at('12:31'), request: { action: 'add-item', storeId: 'supermarket', name: 'Milk', qty: 2, note: '1 L' } },
      { by: 'maya', at: at('12:32'), request: { action: 'add-item', storeId: 'supermarket', name: '  milk ' } },
      { by: 'maya', at: at('12:33'), request: { action: 'add-item', storeId: 'supermarket', name: 'Eggs' } },
      { by: 'dad', at: at('12:34'), request: { action: 'bump', itemId: 'shop-1' } },
      { by: 'dad', at: at('12:35'), request: { action: 'unbump', itemId: 'shop-2' } },
      { by: 'dad', at: at('12:36'), request: { action: 'set-qty', itemId: 'shop-2', qty: 12 } },
      { by: 'mom', at: at('12:37'), request: { action: 'bought', itemId: 'shop-1', bought: true } },
      { by: 'mom', at: at('12:38'), request: { action: 'bought', itemId: 'shop-1', bought: true } },
      { by: 'maya', at: at('12:39'), request: { action: 'bought', itemId: 'shop-2', bought: true } },
      { by: 'maya', at: at('12:40'), request: { action: 'bought', itemId: 'shop-2', bought: false } },
      { by: 'mom', at: at('12:41'), request: { action: 'clear-bought', storeId: 'supermarket' } },
      { by: 'mom', at: at('12:42'), request: { action: 'remove-item', itemId: 'shop-2' } },
      { by: 'mom', at: at('12:43'), request: { action: 'remove-item', itemId: 'shop-2' } }
    ]
  },
  {
    name: 'undo-rules',
    description: 'Undo by the author or a parent only, once, and not after someone changed the item since; an undone remove puts the item back in its place.',
    steps: [
      { by: 'maya', at: at('12:31'), request: { action: 'add-item', storeId: 'pharmacy', name: 'Plasters' } },
      { by: 'maya', at: at('12:32'), request: { action: 'add-item', storeId: 'pharmacy', name: 'Sun cream' } },
      { by: 'maya', at: at('12:33'), request: { action: 'add-item', storeId: 'pharmacy', name: 'Vitamins' } },
      { by: 'dad', at: at('12:34'), request: { action: 'remove-item', itemId: 'shop-2' } },
      { by: 'maya', at: at('12:35'), request: { action: 'undo', undoId: 'su-4' } },
      { by: 'mom', at: at('12:36'), request: { action: 'undo', undoId: 'su-4' } },
      { by: 'mom', at: at('12:37'), request: { action: 'undo', undoId: 'su-4' } },
      { by: 'dad', at: at('12:38'), request: { action: 'bump', itemId: 'shop-1' } },
      { by: 'maya', at: at('12:39'), request: { action: 'undo', undoId: 'su-1' } },
      { by: 'maya', at: at('12:40'), request: { action: 'undo', undoId: 'su-3' } },
      { by: 'maya', at: at('12:41'), request: { action: 'undo', undoId: 'su-99' } }
    ]
  },
  {
    name: 'stores',
    description: 'A family store (its id from its name), one with no Latin letters (a counted id), a name already there, removing a default store (refused), a store with items (refused), then an empty one.',
    steps: [
      { by: 'dad', at: at('12:31'), request: { action: 'add-store', name: 'Pet shop' } },
      { by: 'dad', at: at('12:32'), request: { action: 'add-store', name: '面包店' } },
      { by: 'mom', at: at('12:33'), request: { action: 'add-store', name: 'pet SHOP' } },
      { by: 'mom', at: at('12:34'), request: { action: 'remove-store', storeId: 'supermarket' } },
      { by: 'mom', at: at('12:35'), request: { action: 'add-item', storeId: 'pet-shop', name: 'Cat food' } },
      { by: 'mom', at: at('12:36'), request: { action: 'remove-store', storeId: 'pet-shop' } },
      { by: 'mom', at: at('12:37'), request: { action: 'remove-store', storeId: 'store-7' } },
      { by: 'mom', at: at('12:38'), request: { action: 'add-item', storeId: 'nowhere', name: 'x' } }
    ]
  },
  {
    name: 'a-run',
    description: 'Dad takes the supermarket run (a task on the board), Maya cannot take it too nor release it; Dad buys two things and finishes: the bought items leave the list, the rest stay; an Undo of the done task on the board brings them back.',
    steps: [
      { by: 'mom', at: at('12:31'), request: { action: 'add-item', storeId: 'supermarket', name: 'Bread' } },
      { by: 'mom', at: at('12:32'), request: { action: 'add-item', storeId: 'supermarket', name: 'Apples' } },
      { by: 'mom', at: at('12:33'), request: { action: 'add-item', storeId: 'supermarket', name: 'Rice' } },
      { by: 'dad', at: at('12:34'), request: { action: 'claim', storeId: 'supermarket' } },
      { by: 'dad', at: at('12:35'), request: { action: 'claim', storeId: 'supermarket' } },
      { by: 'maya', at: at('12:36'), request: { action: 'claim', storeId: 'supermarket' } },
      { by: 'maya', at: at('12:37'), request: { action: 'release', storeId: 'supermarket' } },
      { by: 'dad', at: at('12:38'), request: { action: 'bought', itemId: 'shop-1', bought: true } },
      { by: 'dad', at: at('12:39'), request: { action: 'bought', itemId: 'shop-2', bought: true } },
      { by: 'dad', at: at('12:40'), request: { action: 'finish', storeId: 'supermarket' } },
      { by: 'mom', at: at('12:41'), request: { action: 'add-item', storeId: 'supermarket', name: 'Bread' } },
      { by: 'dad', at: at('12:42'), board: { kind: 'undo', targetStep: 10 } },
      { by: 'maya', at: at('12:43'), request: { action: 'finish', storeId: 'pharmacy' } }
    ]
  },
  {
    name: 'run-follows-the-task',
    description: "The run follows its task: assigned to Mom on the board, it is Mom's; handed back, the run is over and the whole list stays; Mom takes it again; releasing removes the task too.",
    steps: [
      { by: 'dad', at: at('12:31'), request: { action: 'add-item', storeId: 'market', name: 'Tomatoes' } },
      { by: 'dad', at: at('12:32'), request: { action: 'claim', storeId: 'market' } },
      { by: 'dad', at: at('12:33'), board: { kind: 'assign', taskOfStep: 2, ownerId: 'mom' } },
      { by: 'mom', at: at('12:34'), request: { action: 'bought', itemId: 'shop-1', bought: true } },
      { by: 'mom', at: at('12:35'), board: { kind: 'handback', taskOfStep: 2 } },
      { by: 'mom', at: at('12:36'), request: { action: 'claim', storeId: 'market' } },
      { by: 'mom', at: at('12:37'), request: { action: 'release', storeId: 'market' } }
    ]
  },
  {
    name: 'from-chat',
    description: 'Several things from one chat message, as one change with one Undo; what is already waiting comes back as a duplicate and is not added.',
    steps: [
      { by: 'mom', at: at('12:31'), request: { action: 'add-item', storeId: 'supermarket', name: 'Milk' } },
      { by: 'maya', at: at('12:32'), addMany: [{ storeId: 'supermarket', name: 'milk' }, { storeId: 'supermarket', name: 'Eggs', qty: 6 }, { storeId: 'pharmacy', name: 'Plasters', note: 'for Noa' }] },
      { by: 'maya', at: at('12:33'), request: { action: 'undo', undoId: 'su-2' } }
    ]
  }
];

/** The lists as members see them, without Undo records and counters (local bookkeeping). */
function visibleShopping(state: HomemindState) {
  const s = shoppingOf(state);
  return { stores: s.stores, items: s.items };
}

function shopping(seed: V1State) {
  return {
    description:
      "The `shopping` capability (Homemind's shopping.ts). Each case starts from seed.state.json with the default stores and empty lists, and `steps` are what members did: a request to the lists, several items from chat (`addMany`), or a board change. `log` is what HOPA devices send for them, in order: board ops (v1) and `shopping` ops (v2: item.add, item.addMany, item.remove, item.buy, item.bump, item.unbump, item.setQty, list.clearBought, run.take, run.release, store.add, store.remove, undo); a run's task is a board task, and finishing a run is the board `done` of that task. Each `results` entry is the outcome of one log entry. `after` is, after each step, what the members see: the lists (a finished run's bought items gone; a run following its task's owner) and the board's items. Undo records use the op id of the change they belong to. Generated; do not edit by hand.",
    generator: GENERATOR,
    seed: 'seed.state.json',
    cases: SHOPPING_CASES.map(c => runShopping(seed, c))
  };
}

function runShopping(seed: V1State, c: ShoppingCase) {
  // HOPA starts with no lists: the default stores, nothing on them (Homemind's demo seed has a filled list).
  let state: HomemindState = { ...homemindOf(seed, SCOPES, false), shopping: undefined };
  const log: Entry[] = [];
  const results: Array<{ seq: number; outcome: string; code?: string }> = [];
  const after: unknown[] = [];
  const stepOps: string[][] = [];
  const taskOfStep: Record<number, string> = {};
  const activityOfStep: Record<number, string> = {};
  let n = 0;
  const push = (by: string, op: Op, outcome: string, code?: string) => {
    const seq = log.length + 1;
    log.push({ seq, scope: 'family', memberId: by, fromDevice: DEVICE[by], op });
    results.push(code ? { seq, outcome, code } : { seq, outcome });
    return op.opId as string;
  };
  const shoppingOp = (kind: string, opId: string, when: string, fields: Op): Op => ({ v: 2, ns: 'shopping', nsv: 1, kind, opId, at: when, ...fields });
  const boardFor = (before: HomemindState, afterState: HomemindState, opId: string, when: string, kind: string, extra: Op): Op => {
    if (kind === 'create') {
      const created = afterState.items.find(i => !before.items.some(b => b.id === i.id))!;
      const { id, type, title, notes, start, allDay, source } = created;
      return { v: 1, kind: 'create', opId, at: when, item: { id, type, title, notes, start, allDay, ownership: { state: 'assigned', ownerId: (created.ownership as { ownerId: string }).ownerId }, source } };
    }
    return { v: 1, kind, opId, at: when, ...extra };
  };

  c.steps.forEach((step, index) => {
    const stepNo = index + 1;
    const when = Date.parse(step.at);
    const ops: string[] = [];
    if ('board' in step) {
      const { kind, targetStep, taskOfStep: ts, ...rest } = step.board as { kind: string; targetStep?: number; taskOfStep?: number };
      const opId = `op-b${++n}`;
      let change: Op;
      if (kind === 'undo') change = { kind: 'undo', activityId: activityOfStep[targetStep!] };
      else {
        const task = state.items.find(i => i.id === taskOfStep[ts!])!;
        change = { kind, itemId: task.id, version: task.version, ...rest };
      }
      const result = applyChange(state, change as never, step.by, fixedClock(when));
      if (!result.ok) throw new Error(`${c.name}: board step ${stepNo} refused: ${result.message}`);
      const op: Op = kind === 'undo' ? { v: 1, kind: 'undo', opId, at: step.at, targetOpId: activityOfStep[targetStep!] } : { v: 1, opId, at: step.at, ...change };
      ops.push(push(step.by, op, 'applied'));
      activityOfStep[stepNo] = opId;
      state = settleShoppingRuns(rename(result.state, result.activity.id, opId));
    } else if ('addMany' in step) {
      const result = addShoppingItems(state, step.addMany, step.by, when);
      if (!result.ok) throw new Error(`${c.name}: step ${stepNo} refused`);
      const opId = result.undoId ?? `op-s${++n}`;
      const items = result.added.map(i => ({ id: i.id, storeId: i.storeId, name: i.name, ...(i.qty !== undefined ? { qty: i.qty } : {}), ...(i.note ? { note: i.note } : {}) }));
      // A device sends only what is not already waiting; the duplicates are shown to the member.
      ops.push(push(step.by, shoppingOp('item.addMany', opId, step.at, { items }), result.added.length ? 'applied' : 'rejected', result.added.length ? undefined : 'conflict'));
      state = settleShoppingRuns(result.state);
    } else {
      const request = step.request;
      const before = state;
      const result = applyShopping(state, request, step.by, when);
      const outcome = (code?: string) => (code ? ['rejected', CODE[code] ?? 'invalid'] : ['applied']);
      const [o, code] = result.ok ? (result.duplicateOf ? ['rejected', 'conflict'] : ['applied']) : outcome(result.code);
      const opId = result.ok && result.undoId ? result.undoId : `op-s${++n}`;
      const when2 = step.at;
      switch (request.action) {
        case 'add-item': {
          const id = result.ok && !result.duplicateOf ? result.itemId! : result.ok ? `shop-dup-${n}` : `shop-x-${n}`;
          ops.push(push(step.by, shoppingOp('item.add', opId, when2, { id, storeId: request.storeId, name: request.name, ...(request.qty !== undefined ? { qty: request.qty } : {}), ...(request.note ? { note: request.note } : {}) }), o, code));
          break;
        }
        case 'remove-item':
          ops.push(push(step.by, shoppingOp('item.remove', opId, when2, { itemId: request.itemId }), o, code));
          break;
        case 'bought':
          ops.push(push(step.by, shoppingOp('item.buy', opId, when2, { itemId: request.itemId, bought: request.bought }), o, code));
          break;
        case 'bump':
          ops.push(push(step.by, shoppingOp('item.bump', opId, when2, { itemId: request.itemId }), o, code));
          break;
        case 'unbump':
          ops.push(push(step.by, shoppingOp('item.unbump', opId, when2, { itemId: request.itemId }), o, code));
          break;
        case 'set-qty':
          ops.push(push(step.by, shoppingOp('item.setQty', opId, when2, { itemId: request.itemId, qty: request.qty }), o, code));
          break;
        case 'clear-bought':
          ops.push(push(step.by, shoppingOp('list.clearBought', opId, when2, { storeId: request.storeId }), o, code));
          break;
        case 'add-store': {
          const storeId = result.ok ? result.storeId! : `store-x-${n}`;
          ops.push(push(step.by, shoppingOp('store.add', opId, when2, { storeId, name: request.name }), o, code));
          break;
        }
        case 'remove-store':
          ops.push(push(step.by, shoppingOp('store.remove', opId, when2, { storeId: request.storeId }), o, code));
          break;
        case 'undo':
          ops.push(push(step.by, shoppingOp('undo', opId, when2, { undoId: request.undoId }), o, code));
          break;
        case 'claim': {
          if (result.ok && result.taskId) {
            const taskOp = `op-t${++n}`;
            ops.push(push(step.by, boardFor(before, result.state, taskOp, when2, 'create', {}), 'applied'));
            taskOfStep[stepNo] = result.taskId;
            activityOfStep[stepNo] = taskOp;
            ops.push(push(step.by, shoppingOp('run.take', opId, when2, { storeId: request.storeId, taskId: result.taskId }), 'applied'));
            state = settleShoppingRuns(rename(result.state, result.activityId!, taskOp));
            stepOps.push(ops);
            after.push(snapshot(state));
            return;
          }
          // Refused, or already theirs: the device sends only the run op (it holds no new task).
          const held = shoppingOf(before).stores.find(s => s.id === request.storeId)?.run?.itemId ?? 'no-task';
          ops.push(push(step.by, shoppingOp('run.take', opId, when2, { storeId: request.storeId, taskId: held }), o, code));
          break;
        }
        case 'release': {
          ops.push(push(step.by, shoppingOp('run.release', opId, when2, { storeId: request.storeId }), o, code));
          if (result.ok && result.taskId) {
            const task = before.items.find(i => i.id === result.taskId)!;
            ops.push(push(step.by, { v: 1, kind: 'cancel', opId: `op-t${++n}`, at: when2, itemId: task.id, version: task.version }, 'applied'));
          }
          break;
        }
        case 'finish': {
          if (result.ok && result.taskId) {
            const task = before.items.find(i => i.id === result.taskId)!;
            const doneOp = `op-t${++n}`;
            ops.push(push(step.by, { v: 1, kind: 'done', opId: doneOp, at: when2, itemId: task.id, version: task.version }, 'applied'));
            activityOfStep[stepNo] = doneOp;
            state = settleShoppingRuns(rename(result.state, result.activityId!, doneOp));
            stepOps.push(ops);
            after.push(snapshot(state));
            return;
          }
          // Nothing to finish: no op is sent at all (the device knows there is no run).
          break;
        }
      }
      if (result.ok) state = settleShoppingRuns(result.state);
    }
    stepOps.push(ops);
    after.push(snapshot(state));
  });
  return { name: c.name, description: c.description, steps: c.steps, log, results, stepOps, after };
}

/** The board activity the core minted gets the op's id (D10), so an Undo can name it. */
function rename(state: HomemindState, from: string, to: string): HomemindState {
  return { ...state, activity: state.activity.map(a => (a.id === from ? { ...a, id: to } : a.undone?.activityId === from ? { ...a, undone: { ...a.undone, activityId: to } } : a)) };
}

function snapshot(state: HomemindState) {
  return { shopping: visibleShopping(state), board: state.items.filter(i => i.visibility === 'family').map(stripItem) };
}

/** Every namespace fixture file, by file name. */
export function buildNamespaceFixtures(): Map<string, unknown> {
  const seed = seedV1();
  return new Map<string, unknown>([['ns-shopping.json', shopping(seed)]]);
}
