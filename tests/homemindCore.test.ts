import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedClock, zonedToUtc } from '../server/homemind/clock';
import { applyChange, occurrences, preparationsFor } from '../server/homemind/core';
import type { Change, ChangeError, ChangeResult, ChangeSuccess, NewItem } from '../server/homemind/core';
import { seedState } from '../server/homemind/seed';
import { ID_PATTERN } from '../server/homemind/types';
import type { HomemindState, Item } from '../server/homemind/types';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const MINUTE = 60_000;
const clock = fixedClock(NOW);

/** Freezes the whole state, so any mutation inside the core throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function fresh(): HomemindState {
  return deepFreeze(seedState({ now: NOW, timezone: TZ }));
}

function ok(result: ChangeResult): ChangeSuccess {
  if (!result.ok) throw new Error(`expected success, got ${result.status} ${result.code}: ${result.message}`);
  return result;
}

function err(result: ChangeResult): ChangeError {
  if (result.ok) throw new Error('expected an error');
  return result;
}

function get(state: HomemindState, id: string): Item {
  const item = state.items.find(i => i.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return item;
}

/** Applies a change with the item's current version filled in. */
function apply(state: HomemindState, change: Change, actor: string, at = clock): ChangeResult {
  return applyChange(state, change, actor, at);
}

const v = (state: HomemindState, id: string) => get(state, id).version;

describe('applyChange basics', () => {
  it('never mutates the input state', () => {
    const state = fresh();
    const result = ok(apply(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom'));
    expect(result.state).not.toBe(state);
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'none' });
    expect(state.activity).toHaveLength(0);
  });

  it('increments the version, writes one activity at the clock time, and returns an event', () => {
    const state = fresh();
    const result = ok(apply(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom'));
    expect(get(result.state, 'pickup-today').version).toBe(2);
    expect(result.state.activity).toHaveLength(1);
    expect(result.activity).toMatchObject({ actor: 'mom', at: new Date(NOW).toISOString(), kind: 'assign', itemId: 'pickup-today', memberId: 'dad' });
    expect(result.activity.id).toMatch(ID_PATTERN);
    expect(result.events).toEqual([{ type: 'item.changed', itemId: 'pickup-today', item: get(result.state, 'pickup-today') }]);
    expect(result.items).toEqual([get(result.state, 'pickup-today')]);
  });

  it('gives unique activity ids for changes at the same instant', () => {
    let state = fresh();
    state = ok(apply(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom')).state;
    state = ok(apply(state, { kind: 'confirm', itemId: 'pickup-today', version: 2 }, 'dad')).state;
    const ids = state.activity.map(a => a.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses an unknown member and a member without an account', () => {
    const state = fresh();
    const change: Change = { kind: 'claim', itemId: 'library-books', version: 1 };
    expect(err(apply(state, change, 'nobody')).status).toBe(403);
    expect(err(apply(state, change, 'noa')).status).toBe(403);
  });

  it('returns 404 for an unknown item and 400 without a version', () => {
    const state = fresh();
    expect(err(apply(state, { kind: 'done', itemId: 'nope', version: 1 }, 'mom')).status).toBe(404);
    expect(err(apply(state, { kind: 'done', itemId: 'library-books' } as unknown as Change, 'mom')).code).toBe('invalid');
  });

  it('refuses an unknown change kind', () => {
    const state = fresh();
    expect(err(apply(state, { kind: 'teleport', itemId: 'library-books', version: 1 } as unknown as Change, 'mom')).status).toBe(400);
  });
});

describe('ownership transitions', () => {
  it('Scene 1: Mom assigns the pickup to Dad, unconfirmed; Dad confirms', () => {
    let state = fresh();
    state = ok(apply(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: false });

    expect(err(apply(state, { kind: 'confirm', itemId: 'pickup-today', version: 2 }, 'mom')).status).toBe(403);
    state = ok(apply(state, { kind: 'confirm', itemId: 'pickup-today', version: 2 }, 'dad')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: true });
    expect(err(apply(state, { kind: 'confirm', itemId: 'pickup-today', version: 3 }, 'dad')).code).toBe('conflict');
  });

  it('assigning to yourself is confirmed at once', () => {
    const state = ok(apply(fresh(), { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'mom' }, 'mom')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'assigned', ownerId: 'mom', confirmed: true });
  });

  it('anyone with an account can assign to anyone with an account, including a teen assigning a parent', () => {
    const state = ok(apply(fresh(), { kind: 'assign', itemId: 'library-books', version: 1, ownerId: 'dad' }, 'maya')).state;
    expect(get(state, 'library-books').ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: false });
  });

  it('refuses an owner without an account, an unknown owner, and the same owner again', () => {
    const state = fresh();
    expect(err(apply(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'noa' }, 'mom')).status).toBe(400);
    expect(err(apply(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'ghost' }, 'mom')).status).toBe(400);
    expect(err(apply(state, { kind: 'assign', itemId: 'swim-today', version: 1, ownerId: 'mom' }, 'dad')).code).toBe('conflict');
  });

  it('"Who\'s taking this?" defaults to everyone who could own it', () => {
    const state = ok(apply(fresh(), { kind: 'open', itemId: 'pickup-today', version: 1 }, 'mom')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'open', candidateIds: ['mom', 'dad', 'maya'] });
  });

  it('"Who\'s taking this?" takes chosen candidates, and refuses one who cannot own it', () => {
    const state = fresh();
    const result = ok(apply(state, { kind: 'open', itemId: 'pickup-today', version: 1, candidateIds: ['dad', 'mom'] }, 'mom'));
    expect(get(result.state, 'pickup-today').ownership).toEqual({ state: 'open', candidateIds: ['dad', 'mom'] });
    expect(err(apply(state, { kind: 'open', itemId: 'pickup-today', version: 1, candidateIds: ['noa'] }, 'mom')).status).toBe(400);
  });

  it('a claim takes an open item, confirmed', () => {
    const result = ok(apply(fresh(), { kind: 'claim', itemId: 'library-books', version: 1 }, 'maya'));
    expect(get(result.state, 'library-books').ownership).toEqual({ state: 'assigned', ownerId: 'maya', confirmed: true });
    expect(result.activity).toMatchObject({ kind: 'claim', memberId: 'maya' });
  });

  it('a claim takes an unowned item too', () => {
    const state = ok(apply(fresh(), { kind: 'claim', itemId: 'pickup-today', version: 1 }, 'dad')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: true });
  });

  it('a claim on something another member owns is refused with the current item', () => {
    const state = ok(apply(fresh(), { kind: 'claim', itemId: 'library-books', version: 1 }, 'maya')).state;
    const refused = err(apply(state, { kind: 'claim', itemId: 'library-books', version: 2 }, 'dad'));
    expect(refused).toMatchObject({ status: 409, code: 'conflict' });
    expect(refused.current?.ownership).toMatchObject({ ownerId: 'maya' });
  });

  it('an assignee claiming an unconfirmed assignment confirms it', () => {
    let state = ok(apply(fresh(), { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom')).state;
    state = ok(apply(state, { kind: 'claim', itemId: 'pickup-today', version: 2 }, 'dad')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: true });
  });

  it('the owner hands back with a note; it opens to everyone else', () => {
    let state = ok(apply(fresh(), { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom')).state;
    const result = ok(apply(state, { kind: 'handback', itemId: 'pickup-today', version: 2, note: '  Stuck in a meeting until 6  ' }, 'dad'));
    state = result.state;
    expect(get(state, 'pickup-today').ownership).toEqual({
      state: 'open',
      candidateIds: ['mom', 'maya'],
      handedBackBy: 'dad',
      note: 'Stuck in a meeting until 6'
    });
    expect(result.activity).toMatchObject({ kind: 'handback', memberId: 'dad', note: 'Stuck in a meeting until 6', what: 'Handed back' });
  });

  it('hand back works without a note, and only the owner can do it', () => {
    let state = ok(apply(fresh(), { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom')).state;
    expect(err(apply(state, { kind: 'handback', itemId: 'pickup-today', version: 2 }, 'mom')).status).toBe(403);
    expect(err(apply(state, { kind: 'handback', itemId: 'pickup-today', version: 2, note: 'x'.repeat(501) }, 'dad')).status).toBe(400);
    state = ok(apply(state, { kind: 'handback', itemId: 'pickup-today', version: 2 }, 'dad')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'open', candidateIds: ['mom', 'maya'], handedBackBy: 'dad' });
  });

  it('a handed-back item can be claimed again', () => {
    let state = ok(apply(fresh(), { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom')).state;
    state = ok(apply(state, { kind: 'handback', itemId: 'pickup-today', version: 2, note: 'Sorry' }, 'dad')).state;
    state = ok(apply(state, { kind: 'claim', itemId: 'pickup-today', version: 3 }, 'mom')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'assigned', ownerId: 'mom', confirmed: true });
  });

  it('unassign clears the owner; there must be one to clear', () => {
    const state = fresh();
    const cleared = ok(apply(state, { kind: 'unassign', itemId: 'swim-today', version: 1 }, 'dad')).state;
    expect(get(cleared, 'swim-today').ownership).toEqual({ state: 'none' });
    expect(err(apply(state, { kind: 'unassign', itemId: 'pickup-today', version: 1 }, 'dad')).code).toBe('conflict');
  });

  it('done closes an item, once, and then ownership is frozen', () => {
    let state = ok(apply(fresh(), { kind: 'done', itemId: 'swim-today', version: 1 }, 'mom')).state;
    expect(get(state, 'swim-today').status).toBe('done');
    expect(err(apply(state, { kind: 'done', itemId: 'swim-today', version: 2 }, 'mom')).code).toBe('conflict');
    expect(err(apply(state, { kind: 'assign', itemId: 'swim-today', version: 2, ownerId: 'dad' }, 'mom')).code).toBe('conflict');
    expect(err(apply(state, { kind: 'claim', itemId: 'swim-today', version: 2 }, 'dad')).code).toBe('conflict');
    // Any member can mark a family item done, not only its owner.
    state = ok(apply(state, { kind: 'done', itemId: 'library-books', version: 1 }, 'maya')).state;
    expect(get(state, 'library-books').status).toBe('done');
  });
});

describe('stale versions: the first write wins', () => {
  it('two members act on the same version; the second gets 409 with the latest item', () => {
    const state = fresh();
    // Both screens show library-books at version 1.
    const first = ok(apply(state, { kind: 'claim', itemId: 'library-books', version: 1 }, 'maya'));
    const second = err(apply(first.state, { kind: 'claim', itemId: 'library-books', version: 1 }, 'dad'));
    expect(second).toMatchObject({ ok: false, status: 409, code: 'stale' });
    expect(second.current).toEqual(get(first.state, 'library-books'));
    expect(second.current?.version).toBe(2);
    expect('state' in second).toBe(false);
  });

  it('a stale edit is refused even if it would not clash', () => {
    const state = ok(apply(fresh(), { kind: 'edit', itemId: 'family-dinner', version: 1, patch: { notes: 'Bring dessert' } }, 'mom')).state;
    const refused = err(apply(state, { kind: 'edit', itemId: 'family-dinner', version: 1, patch: { title: 'Dinner' } }, 'dad'));
    expect(refused.code).toBe('stale');
    expect(refused.current?.notes).toBe('Bring dessert');
  });

  it('a version from the future is stale too', () => {
    expect(err(apply(fresh(), { kind: 'done', itemId: 'library-books', version: 7 }, 'mom')).code).toBe('stale');
  });
});

describe('create, edit and remove', () => {
  const pottery: NewItem = {
    type: 'event',
    title: 'Pottery class',
    start: '2026-11-06T10:00:00.000Z',
    end: '2026-11-06T11:00:00.000Z',
    forMemberIds: ['maya']
  };

  it('creates an item at version 1, with a generated id and a manual source', () => {
    const result = ok(apply(fresh(), { kind: 'create', item: pottery }, 'maya'));
    const [item] = result.items;
    expect(item.id).toMatch(ID_PATTERN);
    expect(item).toMatchObject({
      type: 'event',
      title: 'Pottery class',
      version: 1,
      status: 'open',
      visibility: 'family',
      createdBy: 'maya',
      ownership: { state: 'none' },
      source: { kind: 'manual', label: 'Added by Maya' }
    });
    expect(result.activity).toMatchObject({ kind: 'create', itemId: item.id, what: 'Added an item' });
    expect(result.events).toEqual([{ type: 'item.changed', itemId: item.id, item }]);
  });

  it('two creates at the same instant get different ids; a chosen id must be free and valid', () => {
    let state = ok(apply(fresh(), { kind: 'create', item: pottery }, 'maya')).state;
    state = ok(apply(state, { kind: 'create', item: pottery }, 'maya')).state;
    const ids = state.items.map(i => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(err(apply(state, { kind: 'create', item: { ...pottery, id: 'pickup-today' } }, 'mom')).code).toBe('conflict');
    expect(err(apply(state, { kind: 'create', item: { ...pottery, id: 'Bad Id!' } }, 'mom')).code).toBe('invalid');
  });

  it('can create with an owner; assigning someone else is unconfirmed', () => {
    const result = ok(apply(fresh(), { kind: 'create', item: { ...pottery, ownership: { state: 'assigned', ownerId: 'dad', confirmed: true } } }, 'mom'));
    expect(result.items[0].ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: false });
  });

  it('validates fields', () => {
    const state = fresh();
    const bad = (item: Partial<NewItem>) => err(apply(state, { kind: 'create', item: { ...pottery, ...item } as NewItem }, 'mom')).code;
    expect(bad({ title: '   ' })).toBe('invalid');
    expect(bad({ title: 'x'.repeat(201) })).toBe('invalid');
    expect(bad({ start: 'tomorrow' })).toBe('invalid');
    expect(bad({ start: '2026-11-06T10:00:00+08:00' })).toBe('invalid');
    expect(bad({ end: '2026-11-06T09:00:00.000Z' })).toBe('invalid');
    expect(bad({ forMemberIds: ['ghost'] })).toBe('invalid');
    expect(bad({ type: 'meeting' as never })).toBe('invalid');
    expect(bad({ unavailableMemberIds: ['mom'], type: 'task' })).toBe('invalid');
    expect(bad({ parentEventId: 'family-dinner' })).toBe('invalid');
  });

  it('extraction, group, email and PPMA sources only create proposed items', () => {
    for (const kind of ['screenshot', 'email', 'group', 'ppma'] as const) {
      const result = ok(apply(fresh(), { kind: 'create', item: { ...pottery, source: { kind, label: 'From a screenshot', simulated: true } } }, 'mom'));
      expect(result.items[0].status).toBe('proposed');
      expect(result.activity.what).toBe('Proposed an item');
    }
  });

  it('a proposed item is approved or dismissed, once, and is not done before approval', () => {
    const created = ok(apply(fresh(), { kind: 'create', item: { ...pottery, proposed: true } }, 'mom'));
    const id = created.items[0].id;
    expect(err(apply(created.state, { kind: 'done', itemId: id, version: 1 }, 'mom')).code).toBe('conflict');
    const approved = ok(apply(created.state, { kind: 'approve', itemId: id, version: 1 }, 'dad')).state;
    expect(get(approved, id).status).toBe('open');
    expect(err(apply(approved, { kind: 'approve', itemId: id, version: 2 }, 'dad')).code).toBe('conflict');
    const dismissed = ok(apply(created.state, { kind: 'dismiss', itemId: id, version: 1 }, 'dad')).state;
    expect(get(dismissed, id).status).toBe('cancelled');
  });

  it('edits fields, drops a seeded Chinese title that no longer matches, and clears a field', () => {
    let state = fresh();
    state = ok(apply(state, { kind: 'edit', itemId: 'piano-tomorrow', version: 1, patch: { title: 'Piano recital', notes: 'Bring the sheet music' } }, 'maya')).state;
    expect(get(state, 'piano-tomorrow')).toMatchObject({ title: 'Piano recital', notes: 'Bring the sheet music', version: 2 });
    expect(get(state, 'piano-tomorrow').titleZh).toBeUndefined();
    state = ok(apply(state, { kind: 'edit', itemId: 'piano-tomorrow', version: 2, patch: { notes: '' } }, 'maya')).state;
    expect(get(state, 'piano-tomorrow').notes).toBeUndefined();
    // Same title keeps the Chinese one.
    state = ok(apply(state, { kind: 'edit', itemId: 'family-dinner', version: 1, patch: { title: "Family dinner at Grandma's", importance: 'critical' } }, 'mom')).state;
    expect(get(state, 'family-dinner').titleZh).toBe('去奶奶家吃饭');
  });

  it('cancel removes an event from the board together with its preparations', () => {
    const result = ok(apply(fresh(), { kind: 'cancel', itemId: 'family-dinner', version: 1 }, 'mom'));
    expect(get(result.state, 'family-dinner').status).toBe('cancelled');
    expect(get(result.state, 'family-dinner-flowers').status).toBe('cancelled');
    expect(result.events.map(e => e.itemId).sort()).toEqual(['family-dinner', 'family-dinner-flowers']);
    expect(err(apply(result.state, { kind: 'edit', itemId: 'family-dinner', version: 2, patch: { notes: 'x' } }, 'mom')).code).toBe('conflict');
  });
});

describe('preparations under events', () => {
  const cards: NewItem = { type: 'preparation', title: 'Write a card', parentEventId: 'family-dinner', start: '2026-11-08T02:00:00.000Z' };

  it('a preparation is created under an event and listed with it, in time order', () => {
    const result = ok(apply(fresh(), { kind: 'create', item: cards }, 'maya'));
    const list = preparationsFor(result.state, 'family-dinner');
    expect(list.map(p => p.title)).toEqual(['Write a card', 'Buy flowers for Grandma']);
    expect(list[0].parentEventId).toBe('family-dinner');
  });

  it('a preparation needs an existing, live event', () => {
    const state = fresh();
    expect(err(apply(state, { kind: 'create', item: { ...cards, parentEventId: 'ghost' } }, 'mom')).status).toBe(404);
    expect(err(apply(state, { kind: 'create', item: { ...cards, parentEventId: 'library-books' } }, 'mom')).status).toBe(400);
    const cancelled = ok(apply(state, { kind: 'cancel', itemId: 'family-dinner', version: 1 }, 'mom')).state;
    expect(err(apply(cancelled, { kind: 'create', item: cards }, 'mom')).code).toBe('conflict');
  });

  it('a preparation can be removed on its own, leaving the event', () => {
    const state = ok(apply(fresh(), { kind: 'cancel', itemId: 'family-dinner-flowers', version: 1 }, 'dad')).state;
    expect(get(state, 'family-dinner').status).toBe('open');
    expect(preparationsFor(state, 'family-dinner')).toEqual([]);
  });

  it('a preparation under a Parents-only event is Parents-only too, and stays so', () => {
    const result = ok(apply(fresh(), { kind: 'create', item: { ...cards, parentEventId: 'counselor-meeting', title: 'Print the report' } }, 'mom'));
    const prep = result.items[0];
    expect(prep.visibility).toBe('parents');
    expect(err(apply(result.state, { kind: 'edit', itemId: prep.id, version: 1, patch: { visibility: 'family' } }, 'mom')).code).toBe('invalid');
  });

  it('when an event becomes Parents-only, its preparations follow and a teen owner is let go', () => {
    let state = ok(apply(fresh(), { kind: 'claim', itemId: 'family-dinner-flowers', version: 1 }, 'dad')).state;
    state = ok(apply(state, { kind: 'create', item: cards }, 'maya')).state;
    const cardId = state.items[state.items.length - 1].id;
    state = ok(apply(state, { kind: 'claim', itemId: cardId, version: 1 }, 'maya')).state;

    const result = ok(apply(state, { kind: 'edit', itemId: 'family-dinner', version: 1, patch: { visibility: 'parents' } }, 'mom'));
    expect(get(result.state, 'family-dinner-flowers')).toMatchObject({ visibility: 'parents', ownership: { ownerId: 'dad' } });
    expect(get(result.state, cardId)).toMatchObject({ visibility: 'parents', ownership: { state: 'open', candidateIds: ['mom', 'dad'] } });
    for (const event of result.events) expect(event.previousVisibility).toBe('family');
  });
});

describe('"Parents only" in transitions', () => {
  it('a teen gets 404 for every change on a Parents-only item, the same as for a missing one', () => {
    const state = fresh();
    const changes: Change[] = [
      { kind: 'edit', itemId: 'counselor-meeting', version: 1, patch: { notes: 'x' } },
      { kind: 'claim', itemId: 'counselor-meeting', version: 1 },
      { kind: 'done', itemId: 'counselor-meeting', version: 1 },
      { kind: 'cancel', itemId: 'counselor-meeting', version: 1 },
      // A wrong version must not reveal the item exists either.
      { kind: 'done', itemId: 'counselor-meeting', version: 99 }
    ];
    const missing = err(apply(state, { kind: 'done', itemId: 'no-such-item', version: 1 }, 'maya'));
    for (const change of changes) {
      const refused = err(apply(state, change, 'maya'));
      expect(refused).toEqual(missing);
    }
    expect(err(apply(state, { kind: 'create', item: { type: 'preparation', title: 'x', parentEventId: 'counselor-meeting' } }, 'maya'))).toEqual(
      err(apply(state, { kind: 'create', item: { type: 'preparation', title: 'x', parentEventId: 'no-such-item' } }, 'maya'))
    );
  });

  it('only parents can own one, or be asked to', () => {
    let state = fresh();
    expect(err(apply(state, { kind: 'assign', itemId: 'counselor-meeting', version: 1, ownerId: 'maya' }, 'mom')).status).toBe(400);
    state = ok(apply(state, { kind: 'open', itemId: 'counselor-meeting', version: 1 }, 'mom')).state;
    expect(get(state, 'counselor-meeting').ownership).toEqual({ state: 'open', candidateIds: ['mom', 'dad'] });
  });

  it('a teen cannot create one or move an item into or out of it', () => {
    const state = fresh();
    expect(err(apply(state, { kind: 'create', item: { type: 'task', title: 'Secret', visibility: 'parents' } }, 'maya')).status).toBe(403);
    expect(err(apply(state, { kind: 'edit', itemId: 'piano-tomorrow', version: 1, patch: { visibility: 'parents' } }, 'maya')).status).toBe(403);
  });

  it('an item with a teen owner cannot become Parents-only', () => {
    const state = ok(apply(fresh(), { kind: 'claim', itemId: 'library-books', version: 1 }, 'maya')).state;
    expect(err(apply(state, { kind: 'edit', itemId: 'library-books', version: 2, patch: { visibility: 'parents' } }, 'mom')).status).toBe(400);
  });

  it('a hand-back on a Parents-only item opens it to the other parent only', () => {
    const state = ok(apply(fresh(), { kind: 'handback', itemId: 'counselor-meeting', version: 1, note: 'Can you go?' }, 'mom')).state;
    expect(get(state, 'counselor-meeting').ownership).toMatchObject({ state: 'open', candidateIds: ['dad'] });
  });
});

describe('Undo', () => {
  it('restores the item under a new version and marks the change undone', () => {
    let state = fresh();
    const assigned = ok(apply(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom'));
    const undone = ok(apply(assigned.state, { kind: 'undo', activityId: assigned.activity.id }, 'mom'));
    state = undone.state;
    expect(get(state, 'pickup-today')).toEqual({ ...get(fresh(), 'pickup-today'), version: 3 });
    expect(undone.activity).toMatchObject({ kind: 'undo', ref: assigned.activity.id, itemId: 'pickup-today' });
    expect(undone.activity.undo).toBeUndefined();
    expect(state.activity.find(a => a.id === assigned.activity.id)?.undone).toEqual({ at: new Date(NOW).toISOString(), by: 'mom', activityId: undone.activity.id });
    expect(undone.events).toEqual([{ type: 'item.changed', itemId: 'pickup-today', item: get(state, 'pickup-today') }]);
  });

  it('works once only, and an undo cannot itself be undone', () => {
    const assigned = ok(apply(fresh(), { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom'));
    const undone = ok(apply(assigned.state, { kind: 'undo', activityId: assigned.activity.id }, 'mom'));
    expect(err(apply(undone.state, { kind: 'undo', activityId: assigned.activity.id }, 'mom')).code).toBe('conflict');
    expect(err(apply(undone.state, { kind: 'undo', activityId: undone.activity.id }, 'mom')).status).toBe(404);
  });

  it('is refused with the latest item if the item changed since', () => {
    const assigned = ok(apply(fresh(), { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom'));
    const confirmed = ok(apply(assigned.state, { kind: 'confirm', itemId: 'pickup-today', version: 2 }, 'dad'));
    const refused = err(apply(confirmed.state, { kind: 'undo', activityId: assigned.activity.id }, 'mom'));
    expect(refused).toMatchObject({ status: 409, code: 'stale' });
    expect(refused.current?.ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: true });
    // The newest change can still be undone.
    ok(apply(confirmed.state, { kind: 'undo', activityId: confirmed.activity.id }, 'dad'));
  });

  it('undoes a create by removing the item, unless something was added under it', () => {
    const created = ok(apply(fresh(), { kind: 'create', item: { type: 'event', title: 'Book fair', start: '2026-11-10T01:00:00.000Z' } }, 'dad'));
    const id = created.items[0].id;
    const undone = ok(apply(created.state, { kind: 'undo', activityId: created.activity.id }, 'dad'));
    expect(undone.state.items.some(i => i.id === id)).toBe(false);
    expect(undone.items).toEqual([]);
    expect(undone.events).toEqual([{ type: 'item.changed', itemId: id, item: null, previousVisibility: 'family' }]);

    const withPrep = ok(apply(created.state, { kind: 'create', item: { type: 'preparation', title: 'Bring a bag', parentEventId: id } }, 'dad'));
    expect(err(apply(withPrep.state, { kind: 'undo', activityId: created.activity.id }, 'dad')).code).toBe('conflict');
  });

  it('undoes a cancelled event together with its preparations', () => {
    const cancelled = ok(apply(fresh(), { kind: 'cancel', itemId: 'family-dinner', version: 1 }, 'mom'));
    const state = ok(apply(cancelled.state, { kind: 'undo', activityId: cancelled.activity.id }, 'mom')).state;
    expect(get(state, 'family-dinner')).toMatchObject({ status: 'open', version: 3 });
    expect(get(state, 'family-dinner-flowers')).toMatchObject({ status: 'open', version: 3 });
  });

  it('undoes a hand-back, a done and a cancelled occurrence', () => {
    let state = ok(apply(fresh(), { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom')).state;
    const handback = ok(apply(state, { kind: 'handback', itemId: 'pickup-today', version: 2, note: 'Sorry' }, 'dad'));
    state = ok(apply(handback.state, { kind: 'undo', activityId: handback.activity.id }, 'dad')).state;
    expect(get(state, 'pickup-today').ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: false });

    const done = ok(apply(state, { kind: 'done', itemId: 'swim-today', version: 1 }, 'mom'));
    state = ok(apply(done.state, { kind: 'undo', activityId: done.activity.id }, 'mom')).state;
    expect(get(state, 'swim-today').status).toBe('open');
  });

  it('a teen can undo their own change but not a parent\'s; a parent can undo anyone\'s', () => {
    const byMaya = ok(apply(fresh(), { kind: 'claim', itemId: 'library-books', version: 1 }, 'maya'));
    ok(apply(byMaya.state, { kind: 'undo', activityId: byMaya.activity.id }, 'maya'));
    ok(apply(byMaya.state, { kind: 'undo', activityId: byMaya.activity.id }, 'mom'));
    const byMom = ok(apply(fresh(), { kind: 'claim', itemId: 'pickup-today', version: 1 }, 'mom'));
    expect(err(apply(byMom.state, { kind: 'undo', activityId: byMom.activity.id }, 'maya')).status).toBe(403);
  });

  it('a teen gets 404 for a change to a Parents-only item, as for an unknown change', () => {
    const edit = ok(apply(fresh(), { kind: 'edit', itemId: 'counselor-meeting', version: 1, patch: { notes: 'Room 4' } }, 'mom'));
    const refused = err(apply(edit.state, { kind: 'undo', activityId: edit.activity.id }, 'maya'));
    expect(refused).toEqual(err(apply(edit.state, { kind: 'undo', activityId: 'act-unknown' }, 'maya')));
  });
});

describe('recurrence with one cancelled occurrence', () => {
  const week = 7 * 24 * 60 * MINUTE;
  // Wednesdays 16:30 to 17:30 in Shanghai, starting today.
  const firstStart = zonedToUtc('2026-11-04', '16:30', TZ);
  const art: NewItem = {
    id: 'art-club',
    type: 'event',
    title: 'Art club',
    start: new Date(firstStart).toISOString(),
    end: new Date(firstStart + 60 * MINUTE).toISOString(),
    forMemberIds: ['noa'],
    recurrence: { freq: 'weekly', byWeekday: [3] }
  };

  function withArt(): HomemindState {
    return ok(apply(fresh(), { kind: 'create', item: art }, 'mom')).state;
  }

  it('expands weekly at the same local time', () => {
    const state = withArt();
    const list = occurrences(get(state, 'art-club'), NOW, NOW + 3 * week, TZ);
    expect(list.map(o => o.date)).toEqual(['2026-11-04', '2026-11-11', '2026-11-18']);
    expect(list[1]).toEqual({ itemId: 'art-club', date: '2026-11-11', start: '2026-11-11T08:30:00.000Z', end: '2026-11-11T09:30:00.000Z' });
  });

  it('cancelling one occurrence leaves the others', () => {
    const state = withArt();
    const result = ok(apply(state, { kind: 'cancel_occurrence', itemId: 'art-club', version: 1, date: '2026-11-11' }, 'mom'));
    const item = get(result.state, 'art-club');
    expect(item.recurrence?.exceptions).toEqual(['2026-11-11']);
    expect(item.status).toBe('open');
    expect(occurrences(item, NOW, NOW + 3 * week, TZ).map(o => o.date)).toEqual(['2026-11-04', '2026-11-18']);
    expect(result.activity).toMatchObject({ kind: 'cancel_occurrence', ref: '2026-11-11' });

    const restored = ok(apply(result.state, { kind: 'undo', activityId: result.activity.id }, 'mom')).state;
    expect(occurrences(get(restored, 'art-club'), NOW, NOW + 3 * week, TZ)).toHaveLength(3);
  });

  it('refuses a date with no occurrence, one already cancelled, and a one-off item', () => {
    let state = withArt();
    expect(err(apply(state, { kind: 'cancel_occurrence', itemId: 'art-club', version: 1, date: '2026-11-12' }, 'mom')).code).toBe('invalid');
    expect(err(apply(state, { kind: 'cancel_occurrence', itemId: 'art-club', version: 1, date: '2026-10-28' }, 'mom')).code).toBe('invalid');
    expect(err(apply(state, { kind: 'cancel_occurrence', itemId: 'art-club', version: 1, date: '11/11' }, 'mom')).code).toBe('invalid');
    state = ok(apply(state, { kind: 'cancel_occurrence', itemId: 'art-club', version: 1, date: '2026-11-11' }, 'mom')).state;
    expect(err(apply(state, { kind: 'cancel_occurrence', itemId: 'art-club', version: 2, date: '2026-11-11' }, 'mom')).code).toBe('conflict');
    expect(err(apply(state, { kind: 'cancel_occurrence', itemId: 'swim-today', version: 1, date: '2026-11-04' }, 'mom')).code).toBe('invalid');
  });

  it('stops at `until`, and a repeating item is not marked done as a whole', () => {
    let state = withArt();
    state = ok(apply(state, { kind: 'edit', itemId: 'art-club', version: 1, patch: { recurrence: { freq: 'weekly', byWeekday: [3], until: '2026-11-11' } } }, 'mom')).state;
    expect(occurrences(get(state, 'art-club'), NOW, NOW + 3 * week, TZ).map(o => o.date)).toEqual(['2026-11-04', '2026-11-11']);
    expect(err(apply(state, { kind: 'done', itemId: 'art-club', version: 2 }, 'mom')).code).toBe('invalid');
    state = ok(apply(state, { kind: 'edit', itemId: 'art-club', version: 2, patch: { recurrence: null } }, 'mom')).state;
    expect(get(state, 'art-club').recurrence).toBeUndefined();
  });

  it('keeps the local time across a daylight-saving change', () => {
    // Europe/Berlin leaves summer time on 2026-10-25.
    const berlin = 'Europe/Berlin';
    const start = zonedToUtc('2026-10-14', '16:30', berlin);
    const item = { ...get(withArt(), 'art-club'), start: new Date(start).toISOString(), end: undefined };
    const list = occurrences(item, start, start + 3 * week, berlin);
    expect(list.map(o => o.start)).toEqual(['2026-10-14T14:30:00.000Z', '2026-10-21T14:30:00.000Z', '2026-10-28T15:30:00.000Z']);
  });

  it('validates the rule', () => {
    const state = fresh();
    const bad = (recurrence: unknown) => err(apply(state, { kind: 'create', item: { ...art, recurrence } as NewItem }, 'mom')).code;
    expect(bad({ freq: 'daily', byWeekday: [1] })).toBe('invalid');
    expect(bad({ freq: 'weekly', byWeekday: [] })).toBe('invalid');
    expect(bad({ freq: 'weekly', byWeekday: [7] })).toBe('invalid');
    expect(err(apply(state, { kind: 'create', item: { ...art, start: undefined, end: undefined } }, 'mom')).code).toBe('invalid');
  });

  it('a one-off item gives itself when in range', () => {
    const state = fresh();
    expect(occurrences(get(state, 'pickup-tuesday'), NOW, NOW + week, TZ)).toHaveLength(1);
    expect(occurrences(get(state, 'pickup-tuesday'), NOW + week, NOW + 2 * week, TZ)).toHaveLength(0);
  });
});

describe('activity log', () => {
  it('records every change in order, with neutral wording and no item titles', () => {
    let state = fresh();
    const later = fixedClock(NOW + 5 * MINUTE);
    state = ok(apply(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom')).state;
    state = ok(apply(state, { kind: 'handback', itemId: 'pickup-today', version: 2, note: 'Meeting' }, 'dad', later)).state;
    state = ok(apply(state, { kind: 'edit', itemId: 'counselor-meeting', version: 1, patch: { notes: 'Room 4' } }, 'mom', later)).state;
    expect(state.activity.map(a => [a.kind, a.actor, a.what])).toEqual([
      ['assign', 'mom', 'Assigned to Dad'],
      ['handback', 'dad', 'Handed back'],
      ['edit', 'mom', 'Edited']
    ]);
    expect(state.activity[1].at).toBe(new Date(NOW + 5 * MINUTE).toISOString());
    for (const a of state.activity) {
      expect(a.what).not.toMatch(/counselor|pickup|didn't|did not|ignored/i);
    }
  });

  it('a failed change writes nothing', () => {
    const state = fresh();
    const result = apply(state, { kind: 'claim', itemId: 'swim-today', version: 1 }, 'dad');
    expect(result.ok).toBe(false);
    expect(state.activity).toHaveLength(0);
  });
});

describe('core.ts stays pure', () => {
  it('imports only its sibling clock and types modules', () => {
    const source = readFileSync(join(__dirname, '..', 'server', 'homemind', 'core.ts'), 'utf8');
    const specifiers = [...new Set([...source.matchAll(/\bfrom\s*'([^']+)'|\bimport\s*\(\s*'([^']+)'/g)].map(m => m[1] ?? m[2]))].sort();
    expect(specifiers).toEqual(['./clock', './types']);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bfetch\s*\(|Date\.now\s*\(|new Date\(\)|process\.|globalThis/);
  });
});

describe('Chinese titles Homemind words itself (T7.4)', () => {
  it('a create may carry titleZh; it is trimmed and checked like a title', () => {
    const state = fresh();
    const made = ok(applyChange(state, { kind: 'create', item: { type: 'task', title: 'Buy apples', titleZh: ' 买苹果 ' } }, 'mom', clock));
    expect(made.items[0]).toMatchObject({ title: 'Buy apples', titleZh: '买苹果' });
    expect(err(applyChange(state, { kind: 'create', item: { type: 'task', title: 'Buy apples', titleZh: '  ' } }, 'mom', clock)).code).toBe('invalid');
    // A later retitle drops it, as for a seeded one.
    const edited = ok(applyChange(made.state, { kind: 'edit', itemId: made.items[0].id, version: 1, patch: { title: 'Buy pears' } }, 'mom', clock));
    expect(edited.items[0].titleZh).toBeUndefined();
  });
});
