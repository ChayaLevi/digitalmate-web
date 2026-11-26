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
import type { HomemindState, Item, Preference } from '../../server/homemind/types';
import {
  appliesTo,
  applyPreferenceRequest,
  parsePreferenceInput,
  avoidedTerms,
  blockedChange,
  checkChoice,
  itemContext,
  scopeTerms
} from '../../server/homemind/preferences';
import type { PreferenceContext, PreferenceRequest } from '../../server/homemind/preferences';
import type { Change } from '../../server/homemind/core';
import { applyRuleRequest, nextOccurrence } from '../../server/homemind/rules';
import type { RuleRequest } from '../../server/homemind/rules';
import type { Rule } from '../../server/homemind/types';
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

// ---------------------------------------------------------------------------------------------
// preferences

type PrefStep = { by: string; at: string; request: PreferenceRequest | { op: 'undo'; step: number } };

const PREFERENCE_CASES: Array<{ name: string; description: string; steps: PrefStep[] }> = [
  {
    name: 'save-correct-remove',
    description: 'Anyone adds; the same words for the same person and scope correct the saved one instead of adding a twin; only a parent makes a soft one hard, corrects or removes a hard one.',
    steps: [
      { by: 'maya', at: at('12:31'), request: { op: 'save', input: { text: 'Likes chocolate cake', aboutMemberId: 'noa', strength: 'soft', scope: 'birthday' } } },
      { by: 'dad', at: at('12:32'), request: { op: 'save', input: { text: 'likes  CHOCOLATE cake!', reason: 'She said so', aboutMemberId: 'noa', strength: 'soft', scope: 'birthday' } } },
      { by: 'maya', at: at('12:33'), request: { op: 'save', input: { text: 'Likes chocolate cake', aboutMemberId: 'noa', strength: 'hard', scope: 'birthday' } } },
      { by: 'mom', at: at('12:34'), request: { op: 'save', input: { text: 'No peanuts', reason: 'Allergy', aboutMemberId: 'noa', strength: 'hard' } } },
      { by: 'maya', at: at('12:35'), request: { op: 'remove', id: 'STEP4' } },
      { by: 'maya', at: at('12:36'), request: { op: 'save', id: 'STEP4', input: { text: 'No peanuts at all', aboutMemberId: 'noa', strength: 'hard' } } },
      { by: 'dad', at: at('12:37'), request: { op: 'save', id: 'STEP4', input: { text: 'No peanuts or tree nuts', reason: 'Allergy', aboutMemberId: 'noa', strength: 'hard' } } },
      { by: 'dad', at: at('12:38'), request: { op: 'save', id: 'STEP4', input: { text: 'No peanuts or tree nuts', reason: 'Allergy', aboutMemberId: 'noa', strength: 'hard' } } },
      { by: 'mom', at: at('12:39'), request: { op: 'remove', id: 'STEP1' } },
      { by: 'mom', at: at('12:40'), request: { op: 'remove', id: 'no-such-pref' } },
      { by: 'noa', at: at('12:41'), request: { op: 'save', input: { text: 'Pink', strength: 'soft' } } }
    ]
  },
  {
    name: 'undo',
    description: 'Undo by the member who made the change or a parent; only the latest change to that preference; once.',
    steps: [
      { by: 'maya', at: at('12:31'), request: { op: 'save', input: { text: 'Pasta on Mondays', strength: 'soft', scope: 'dinner' } } },
      { by: 'maya', at: at('12:32'), request: { op: 'save', id: 'STEP1', input: { text: 'Pasta on Tuesdays', strength: 'soft', scope: 'dinner' } } },
      { by: 'maya', at: at('12:33'), request: { op: 'undo', step: 1 } },
      { by: 'dad', at: at('12:34'), request: { op: 'undo', step: 2 } },
      { by: 'maya', at: at('12:35'), request: { op: 'undo', step: 2 } },
      { by: 'maya', at: at('12:36'), request: { op: 'undo', step: 2 } },
      { by: 'mom', at: at('12:37'), request: { op: 'remove', id: 'STEP1' } },
      { by: 'maya', at: at('12:38'), request: { op: 'undo', step: 7 } },
      { by: 'dad', at: at('12:39'), request: { op: 'undo', step: 7 } }
    ]
  }
];

function preferences(seed: V1State) {
  const cases = PREFERENCE_CASES.map(c => {
    let state: HomemindState = { ...homemindOf(seed, SCOPES, false), preferences: [], activity: [] };
    const log: Entry[] = [];
    const results: Array<{ seq: number; outcome: string; code?: string }> = [];
    const after: Preference[][] = [];
    const prefOfStep: Record<number, string> = {};
    const activityOfStep: Record<number, { hm: string; op: string }> = {};
    c.steps.forEach((step, index) => {
      const stepNo = index + 1;
      const opId = `op-p${stepNo}`;
      const resolve = (id: string) => (id.startsWith('STEP') ? prefOfStep[Number(id.slice(4))] ?? id : id);
      let request: PreferenceRequest;
      const r = step.request;
      if (r.op === 'undo' && 'step' in r) request = { op: 'undo', activityId: activityOfStep[r.step]?.hm ?? 'act-none' };
      else if (r.op === 'remove') request = { op: 'remove', id: resolve(r.id) };
      else if (r.op === 'save') {
        // As Homemind's server does: the fields are cleaned (spaces collapsed, scope lower case) first.
        const parsed = parsePreferenceInput(r.input as unknown as Record<string, unknown>, state.family.members);
        if (!parsed.ok) throw new Error(`${c.name}: step ${stepNo}: ${parsed.message}`);
        request = { op: 'save', ...(r.id ? { id: resolve(r.id) } : {}), input: parsed.value };
      }
      else request = r as PreferenceRequest;
      const result = applyPreferenceRequest(state, request, step.by, Date.parse(step.at));
      let op: Op;
      if (request.op === 'save') {
        const newId = result.ok && result.action === 'added' && result.preference ? result.preference.id : `pref-${opId}`;
        op = { v: 2, ns: 'preferences', nsv: 1, kind: 'save', opId, at: step.at, newId, ...(request.id ? { id: request.id } : {}), ...request.input };
      } else if (request.op === 'remove') {
        op = { v: 2, ns: 'preferences', nsv: 1, kind: 'remove', opId, at: step.at, id: request.id };
      } else {
        const target = 'step' in r ? activityOfStep[r.step]?.op ?? 'op-none' : 'op-none';
        op = { v: 2, ns: 'preferences', nsv: 1, kind: 'undo', opId, at: step.at, targetOpId: target };
      }
      log.push({ seq: stepNo, scope: 'family', memberId: step.by, fromDevice: DEVICE[step.by], op });
      if (result.ok) {
        results.push({ seq: stepNo, outcome: 'applied' });
        if (result.preference && request.op === 'save') prefOfStep[stepNo] = result.preference.id;
        if (result.activity) activityOfStep[stepNo] = { hm: result.activity.id, op: opId };
        state = result.state;
      } else {
        // HOPA refuses a member without an account before any capability sees the op: forbidden.
        const noAccount = !state.family.members.some(m => m.id === step.by && m.hasAccount);
        results.push({ seq: stepNo, outcome: 'rejected', code: noAccount ? 'forbidden' : result.code });
      }
      after.push(state.preferences);
    });
    return { name: c.name, description: c.description, steps: c.steps, log, results, after };
  });
  return {
    description:
      "The `preferences` capability (Homemind's preferences.ts). Each case starts with no preferences. `log` holds the `preferences` ops (v2: save, remove, undo) HOPA devices send for what members did; `results` the outcome of each; `after` the preferences after each step. Fields are cleaned as Homemind's server cleans them (spaces collapsed, the scope in lower case). A member without an account is refused as `forbidden` (HOPA's rule for every capability; Homemind says not_found). A save carries `newId` for a new preference, `id` to correct a given one; a save whose words match a saved one (same person and scope) corrects it. An Undo names the op of the change it undoes. Generated; do not edit by hand.",
    generator: GENERATOR,
    seed: 'seed.state.json',
    cases
  };
}

/** Where preferences apply and what a hard one blocks, from Homemind's functions, with its seed preferences. */
function preferenceLogic(seed: V1State) {
  const hm = homemindOf(seed, SCOPES, false);
  const prefs: Preference[] = [
    ...hm.preferences,
    { id: 'pref-maya-veg', aboutMemberId: 'maya', text: "Doesn't eat meat or fish", strength: 'hard' },
    { id: 'pref-family-pork', text: '不吃猪肉、火腿', strength: 'hard' },
    { id: 'pref-dad-coffee', aboutMemberId: 'dad', text: 'Strong coffee in the morning', strength: 'soft', scope: 'breakfast' },
    { id: 'pref-noa-kiwi', aboutMemberId: 'noa', text: 'Allergic to kiwi and sesame.', strength: 'hard' },
    { id: 'pref-gluten', text: 'Gluten-free please', strength: 'hard' }
  ];
  const scopes = ['kindergarten-party', 'school lunch', '幼儿园聚会', 'birthday-party', 'swimming', 'party for grandma', 'and the events', 'violin_lessons', 'x'];
  const contexts: Array<{ name: string; context: PreferenceContext }> = [
    { name: 'noa-kindergarten-party', context: { memberIds: ['noa'], texts: ['Kindergarten party', '幼儿园聚会'] } },
    { name: 'noa-swim', context: { memberIds: ['noa'], texts: ["Noa's swimming lesson"] } },
    { name: 'nobody-preschool-celebration', context: { memberIds: [], texts: ['Preschool celebration on Friday'] } },
    { name: 'group-tag', context: { memberIds: [], texts: ['周五水果'], tags: ['kindergarten', 'party'] } },
    { name: 'dad-breakfast', context: { memberIds: ['dad'], texts: ['Breakfast'] } },
    { name: 'family-dinner', context: { memberIds: ['mom', 'dad', 'maya', 'noa'], texts: ["Family dinner at Grandma's"] } }
  ];
  const choices = [['Peanut butter cookies'], ['Fruit salad with kiwis'], ['花生糖'], ['Ham sandwiches'], ['Grilled chicken'], ['Sesame bars', '芝麻棒'], ['Wheat bread'], ['Apples']];
  const items = hm.items;
  const changes: Array<{ name: string; change: Change }> = [
    { name: 'prep-peanuts-for-dinner', change: { kind: 'create', item: { type: 'preparation', title: 'Bring peanut snacks', parentEventId: 'family-dinner', visibility: 'family' } } as Change },
    { name: 'task-for-maya-chicken', change: { kind: 'create', item: { type: 'task', title: 'Cook chicken for Maya', forMemberIds: ['maya'], visibility: 'family' } } as Change },
    { name: 'event-is-not-a-choice', change: { kind: 'create', item: { type: 'event', title: 'Peanut festival', start: at('10:00', '2026-11-20'), forMemberIds: ['noa'], visibility: 'family' } } as Change },
    { name: 'retitle-flowers-to-ham', change: { kind: 'edit', itemId: 'family-dinner-flowers', version: 1, patch: { title: 'Bring ham' } } },
    { name: 'edit-time-only', change: { kind: 'edit', itemId: 'family-dinner-flowers', version: 1, patch: { start: at('09:00', '2026-11-15') } } }
  ];
  return {
    description:
      "Where preferences apply and what a hard one rules out (Homemind's preferences.ts): scopeTerms (a scope's concepts and literal words), appliesTo per preference and context, avoidedTerms per hard preference, checkChoice for a few choices in each context, and blockedChange for board changes (with the family's preferences below and the seed's board). Words in English and Chinese. Generated; do not edit by hand.",
    generator: GENERATOR,
    preferences: prefs,
    scopeTerms: scopes.map(scope => ({ scope, ...scopeTerms(scope) })),
    appliesTo: contexts.map(c => ({ ...c, applies: prefs.filter(p => appliesTo(p, c.context)).map(p => p.id) })),
    avoidedTerms: prefs.map(p => ({ id: p.id, terms: avoidedTerms(p) })),
    checkChoice: contexts.flatMap(c => choices.map(choice => ({ context: c.name, choice, blocked: checkChoice(prefs, c.context, choice).map(b => ({ id: b.preference.id, term: b.term })) }))),
    itemContexts: items.map(item => ({ itemId: item.id, context: itemContext(items, hm.family.members, item) })),
    blockedChange: changes.map(c => ({ ...c, blocked: blockedChange({ ...hm, preferences: prefs }, c.change).map(b => ({ id: b.preference.id, term: b.term })) }))
  };
}

// ---------------------------------------------------------------------------------------------
// rules

type RuleStep = { by: string; at: string; request: RuleRequest | { action: 'restore'; step: number } };

const PIZZA = { action: 'create' as const, title: 'Friday pizza night', titleZh: '周五披萨之夜', weekday: 5, time: '18:30', leadMinutes: 30, items: [{ id: 'margherita-l', qty: 2 }], maxPrice: 250 };

const RULE_CASES: Array<{ name: string; description: string; steps: RuleStep[] }> = [
  {
    name: 'parents-only',
    description: 'Only a parent creates, changes, turns on or off, deletes and restores a rule (every rule here spends money); a teen sees it but cannot change it.',
    steps: [
      { by: 'maya', at: at('12:31'), request: PIZZA },
      { by: 'mom', at: at('12:32'), request: PIZZA },
      { by: 'maya', at: at('12:33'), request: { action: 'disable', id: 'rule-1' } },
      { by: 'dad', at: at('12:34'), request: { action: 'update', id: 'rule-1', time: '19:00' } },
      { by: 'dad', at: at('12:35'), request: { action: 'update', id: 'rule-1', time: '19:00' } },
      { by: 'dad', at: at('12:36'), request: { action: 'update', id: 'rule-1', maxPrice: 300 } },
      { by: 'mom', at: at('12:37'), request: { action: 'disable', id: 'rule-1' } },
      { by: 'mom', at: at('12:38'), request: { action: 'disable', id: 'rule-1' } },
      { by: 'dad', at: at('12:39'), request: { action: 'enable', id: 'rule-1' } },
      { by: 'mom', at: at('12:40'), request: { action: 'delete', id: 'rule-1' } },
      { by: 'maya', at: at('12:41'), request: { action: 'restore', step: 10 } },
      { by: 'dad', at: at('12:42'), request: { action: 'restore', step: 10 } },
      { by: 'dad', at: at('12:43'), request: { action: 'restore', step: 10 } },
      { by: 'mom', at: at('12:44'), request: { action: 'enable', id: 'no-such-rule' } }
    ]
  }
];

function rules(seed: V1State) {
  const cases = RULE_CASES.map(c => {
    let state: HomemindState = { ...homemindOf(seed, SCOPES, false), rules: [], activity: [], actionCards: [], ruleRuns: [] };
    const log: Entry[] = [];
    const results: Array<{ seq: number; outcome: string; code?: string }> = [];
    const after: Rule[][] = [];
    const activityOfStep: Record<number, { hm: string; op: string }> = {};
    c.steps.forEach((step, index) => {
      const stepNo = index + 1;
      const opId = `op-r${stepNo}`;
      const r = step.request;
      const request: RuleRequest = 'step' in r ? { action: 'restore', activityId: activityOfStep[r.step]?.hm ?? 'act-none' } : r;
      const result = applyRuleRequest(state, request, step.by, Date.parse(step.at));
      const base = { v: 2, ns: 'rules', nsv: 1, opId, at: step.at };
      let op: Op;
      if (request.action === 'create') {
        // The device builds the rule (its action from its own adapter: here the simulated pizza shop's quote).
        const rule = result.ok ? result.rule : { id: `rule-${opId}`, title: request.title, titleZh: request.titleZh, trigger: { kind: 'weekly', weekday: request.weekday, time: request.time, leadMinutes: request.leadMinutes }, actionTemplate: { adapter: 'pizza', payload: { vendor: 'sim-pizza', items: request.items, total: 178, currency: 'CNY' } }, limits: { maxPrice: request.maxPrice, currency: 'CNY' }, area: 'food' };
        const { enabled: _e, createdBy: _c, ...fields } = rule as Rule;
        op = { ...base, kind: 'create', rule: fields };
      } else if (request.action === 'restore') {
        op = { ...base, kind: 'restore', targetOpId: 'step' in r ? activityOfStep[r.step]?.op ?? 'op-none' : 'op-none' };
      } else if (request.action === 'update') {
        op = { ...base, kind: 'update', id: request.id, ...(request.time !== undefined ? { time: request.time } : {}), ...(request.maxPrice !== undefined ? { maxPrice: request.maxPrice } : {}) };
      } else {
        op = { ...base, kind: request.action, id: request.id };
      }
      log.push({ seq: stepNo, scope: 'family', memberId: step.by, fromDevice: DEVICE[step.by], op });
      if (result.ok) {
        results.push({ seq: stepNo, outcome: 'applied' });
        if (result.activityId) activityOfStep[stepNo] = { hm: result.activityId, op: opId };
        state = result.state;
      } else {
        results.push({ seq: stepNo, outcome: 'rejected', code: ({ forbidden: 'forbidden', not_found: 'not_found', invalid: 'invalid' } as Record<string, string>)[result.code] ?? 'conflict' });
      }
      after.push(state.rules);
    });
    return { name: c.name, description: c.description, steps: c.steps, log, results, after };
  });
  const rule = { trigger: { kind: 'weekly', weekday: 5, time: '18:30', leadMinutes: 30 } } as Rule;
  const occurrences = [
    { now: at('12:30'), timezone: 'Asia/Jerusalem', weekday: 5, time: '18:30' },
    { now: at('16:29', '2026-11-13'), timezone: 'Asia/Jerusalem', weekday: 5, time: '18:30' },
    { now: at('16:30', '2026-11-13'), timezone: 'Asia/Jerusalem', weekday: 5, time: '18:30' },
    { now: at('12:00', '2026-10-28'), timezone: 'America/New_York', weekday: 0, time: '01:30' },
    { now: at('23:30', '2026-11-11'), timezone: 'Asia/Shanghai', weekday: 4, time: '07:00' }
  ].map(o => {
    const next = nextOccurrence({ ...rule, trigger: { ...rule.trigger, weekday: o.weekday, time: o.time } }, Date.parse(o.now), o.timezone);
    return { ...o, date: next.date, at: new Date(next.at).toISOString() };
  });
  return {
    description:
      "The `rules` capability (Homemind's rules.ts): a standing rule only prepares an action that waits for a parent's tap; it never acts. In the family scope, visible to everyone, changed only by a parent (every rule here spends money). `log` holds the `rules` ops (v2: create, update, enable, disable, delete, restore); a create carries the whole rule (its action built by the device's own adapter); a restore names the op of the delete it undoes. `after`: the rules after each step. `nextOccurrence`: the next time of a weekly rule strictly after `now`, in the family's zone. Running a rule (sizing, price cap, the card) belongs to the device's actions and ActionExecutor. Generated; do not edit by hand.",
    generator: GENERATOR,
    seed: 'seed.state.json',
    cases,
    nextOccurrence: occurrences
  };
}

/** Every namespace fixture file, by file name. */
export function buildNamespaceFixtures(): Map<string, unknown> {
  const seed = seedV1();
  return new Map<string, unknown>([
    ['ns-shopping.json', shopping(seed)],
    ['ns-preferences.json', preferences(seed)],
    ['logic-preferences.json', preferenceLogic(seed)],
    ['ns-rules.json', rules(seed)]
  ]);
}
