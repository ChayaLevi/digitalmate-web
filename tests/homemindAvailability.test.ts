import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedClock, zonedToUtc } from '../server/homemind/clock';
import {
  conflictsVisibleTo,
  findConflicts,
  mayOpenOnItsOwn,
  proposeForConflicts,
  unavailabilityFor,
  unavailableDuring
} from '../server/homemind/availability';
import type { ProposalSuccess } from '../server/homemind/availability';
import { applyChange } from '../server/homemind/core';
import type { Change, ChangeError, ChangeResult, ChangeSuccess, NewItem } from '../server/homemind/core';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, Item } from '../server/homemind/types';
import { eventFor, viewFor } from '../server/homemind/visibility';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const DAY = 24 * 60 * 60 * 1000;
const clock = fixedClock(NOW);
const TUESDAY = '2026-11-10'; // the seed's pickup-tuesday, 16:30 to 17:00, owned by Mom
const WEEK = { from: NOW, to: NOW + 14 * DAY };

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

function proposed(result: ProposalSuccess | ChangeError): ProposalSuccess {
  if (!result.ok) throw new Error(`expected success, got ${result.status} ${result.code}: ${result.message}`);
  return result;
}

function get(state: HomemindState, id: string): Item {
  const item = state.items.find(i => i.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return item;
}

const at = (date: string, time: string) => new Date(zonedToUtc(date, time, TZ)).toISOString();
const step = (state: HomemindState, change: Change, actor: string) => ok(applyChange(state, change, actor, clock)).state;

/** Mom's cousin's wedding: it makes her unavailable from `from` to `to` on `date`. */
function wedding(fields: Partial<NewItem> & { date?: string; from?: string; to?: string } = {}): NewItem {
  const { date = TUESDAY, from = '15:00', to = '22:00', ...rest } = fields;
  return {
    id: 'wedding',
    type: 'event',
    title: "Cousin's wedding",
    start: at(date, from),
    end: at(date, to),
    forMemberIds: ['mom'],
    unavailableMemberIds: ['mom'],
    ...rest
  };
}

const withWedding = (fields?: Parameters<typeof wedding>[0], state = fresh()) => step(state, { kind: 'create', item: wedding(fields) }, 'mom');

describe('Scene 4: the wedding against the pickup', () => {
  it('the wedding flags a conflict with Mom\'s Tuesday pickup', () => {
    const state = withWedding();
    expect(findConflicts(fresh(), WEEK.from, WEEK.to)).toEqual([]);
    expect(findConflicts(state, WEEK.from, WEEK.to)).toEqual([
      {
        memberId: 'mom',
        eventId: 'wedding',
        itemId: 'pickup-tuesday',
        date: TUESDAY,
        start: at(TUESDAY, '16:30'),
        end: at(TUESDAY, '17:00'),
        recurring: false
      }
    ]);
  });

  it('opens the pickup for someone else, with the reason, and assigns nobody', () => {
    const state = withWedding();
    const result = proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to), 'mom', clock));
    const pickup = get(result.state, 'pickup-tuesday');
    expect(pickup.ownership).toEqual({
      state: 'open',
      candidateIds: ['dad', 'maya'],
      reason: { kind: 'unavailable', memberId: 'mom', eventId: 'wedding', date: TUESDAY }
    });
    expect(pickup.version).toBe(2);
    expect(result.openedItemIds).toEqual(['pickup-tuesday']);
    expect(result.activities.map(a => [a.kind, a.itemId, a.actor])).toEqual([['open', 'pickup-tuesday', 'mom']]);
    expect(result.events.map(e => e.itemId)).toEqual(['pickup-tuesday']);
    // Opened, so the conflict is resolved until someone takes it.
    expect(findConflicts(result.state, WEEK.from, WEEK.to)).toEqual([]);
  });

  it('Dad takes it; the reason goes with the old ownership', () => {
    const state = withWedding();
    const opened = proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to), 'mom', clock)).state;
    const taken = step(opened, { kind: 'claim', itemId: 'pickup-tuesday', version: 2 }, 'dad');
    expect(get(taken, 'pickup-tuesday').ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: true });
    expect(findConflicts(taken, WEEK.from, WEEK.to)).toEqual([]);
  });

  it('Undo gives the pickup back to Mom', () => {
    const state = withWedding();
    const result = proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to), 'mom', clock));
    const undone = step(result.state, { kind: 'undo', activityId: result.activities[0].id }, 'mom');
    expect(get(undone, 'pickup-tuesday').ownership).toEqual({ state: 'assigned', ownerId: 'mom', confirmed: true });
  });

  it('if Mom keeps it anyway, the conflict shows again, for a warning', () => {
    const state = withWedding();
    const opened = proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to), 'mom', clock)).state;
    const kept = step(opened, { kind: 'claim', itemId: 'pickup-tuesday', version: 2 }, 'mom');
    expect(findConflicts(kept, WEEK.from, WEEK.to).map(c => c.itemId)).toEqual(['pickup-tuesday']);
  });

  it('leaves out a candidate who is unavailable too', () => {
    const state = step(withWedding(), { kind: 'create', item: { ...wedding({ from: '09:00', to: '20:00' }), id: 'dad-trip', title: 'Work trip', unavailableMemberIds: ['dad'] } }, 'dad');
    const result = proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to), 'mom', clock));
    expect(get(result.state, 'pickup-tuesday').ownership).toMatchObject({ state: 'open', candidateIds: ['maya'] });
  });

  it('when nobody is free, it asks everyone else who could take it', () => {
    let state = withWedding();
    state = step(state, { kind: 'create', item: { ...wedding({ from: '09:00', to: '20:00' }), id: 'away', title: 'Away', unavailableMemberIds: ['dad', 'maya'] } }, 'dad');
    expect(unavailableDuring(state, Date.parse(at(TUESDAY, '16:30')), Date.parse(at(TUESDAY, '17:00')))).toEqual(['dad', 'maya', 'mom']);
    const result = proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to, { eventId: 'wedding' }), 'mom', clock));
    expect(get(result.state, 'pickup-tuesday').ownership).toMatchObject({ state: 'open', candidateIds: ['dad', 'maya'] });
  });
});

describe('what counts as a conflict', () => {
  const conflictIds = (state: HomemindState) => findConflicts(state, WEEK.from, WEEK.to).map(c => `${c.eventId}>${c.itemId}`);

  it('needs the times to overlap: touching ends do not count, a partial overlap does', () => {
    expect(conflictIds(withWedding({ from: '12:00', to: '16:30' }))).toEqual([]);
    expect(conflictIds(withWedding({ from: '17:00', to: '22:00' }))).toEqual([]);
    expect(conflictIds(withWedding({ from: '16:45', to: '22:00' }))).toEqual(['wedding>pickup-tuesday']);
    expect(conflictIds(withWedding({ from: '12:00', to: '16:31' }))).toEqual(['wedding>pickup-tuesday']);
    expect(conflictIds(withWedding({ date: '2026-11-11' }))).toEqual([]);
  });

  it('only the owner\'s unavailability matters', () => {
    expect(conflictIds(withWedding({ unavailableMemberIds: ['dad'] }))).toEqual([]);
  });

  it('an unconfirmed assignment counts', () => {
    let state = step(fresh(), { kind: 'assign', itemId: 'pickup-tuesday', version: 1, ownerId: 'dad' }, 'mom');
    state = withWedding({ unavailableMemberIds: ['dad'] }, state);
    expect(conflictIds(state)).toEqual(['wedding>pickup-tuesday']);
  });

  it('not for an unowned or open item, a done one, or an all-day task', () => {
    let state = step(fresh(), { kind: 'unassign', itemId: 'pickup-tuesday', version: 1 }, 'mom');
    expect(conflictIds(withWedding({}, state))).toEqual([]);
    state = step(fresh(), { kind: 'done', itemId: 'pickup-tuesday', version: 1 }, 'mom');
    expect(conflictIds(withWedding({}, state))).toEqual([]);
    state = step(fresh(), { kind: 'create', item: { type: 'task', title: 'Pay the school fee', start: at(TUESDAY, '00:00'), allDay: true, ownership: { state: 'assigned', ownerId: 'mom', confirmed: true } } }, 'mom');
    state = step(state, { kind: 'unassign', itemId: 'pickup-tuesday', version: 1 }, 'mom');
    expect(conflictIds(withWedding({}, state))).toEqual([]);
  });

  it('not from a proposed, removed or dismissed event', () => {
    const fromGroup = step(fresh(), { kind: 'create', item: { ...wedding(), source: { kind: 'screenshot', label: 'Invitation' } } }, 'mom');
    expect(get(fromGroup, 'wedding').status).toBe('proposed');
    expect(conflictIds(fromGroup)).toEqual([]);
    expect(conflictIds(step(fromGroup, { kind: 'approve', itemId: 'wedding', version: 1 }, 'mom'))).toEqual(['wedding>pickup-tuesday']);
    expect(conflictIds(step(fromGroup, { kind: 'dismiss', itemId: 'wedding', version: 1 }, 'mom'))).toEqual([]);
    expect(conflictIds(step(withWedding(), { kind: 'cancel', itemId: 'wedding', version: 1 }, 'mom'))).toEqual([]);
  });

  it('not the event itself, its preparations, or another of the member\'s own unavailabilities', () => {
    let state = withWedding({ ownership: { state: 'assigned', ownerId: 'mom', confirmed: true } });
    state = step(state, { kind: 'create', item: { type: 'preparation', title: 'Bring the gift', parentEventId: 'wedding', start: at(TUESDAY, '15:00'), ownership: { state: 'assigned', ownerId: 'mom', confirmed: true } } }, 'mom');
    // From 16:00, so the gift at 15:00 does not clash with it (it would: that is a real conflict).
    state = step(state, { kind: 'create', item: { ...wedding({ from: '16:00' }), id: 'dinner-after', title: 'Dinner after', ownership: { state: 'assigned', ownerId: 'mom', confirmed: true } } }, 'mom');
    expect(conflictIds(state).sort()).toEqual(['dinner-after>pickup-tuesday', 'wedding>pickup-tuesday']);
  });

  it('only clashes that reach into the window', () => {
    const state = withWedding();
    expect(findConflicts(state, NOW, Date.parse(at(TUESDAY, '16:30')))).toEqual([]);
    expect(findConflicts(state, Date.parse(at(TUESDAY, '17:00')), WEEK.to)).toEqual([]);
    expect(findConflicts(state, Date.parse(at(TUESDAY, '16:59')), WEEK.to)).toHaveLength(1);
  });

  it('filters by event and by item', () => {
    let state = withWedding();
    state = step(state, { kind: 'create', item: { id: 'mom-call', type: 'task', title: 'Call the plumber', start: at(TUESDAY, '19:00'), ownership: { state: 'assigned', ownerId: 'mom', confirmed: true } } }, 'mom');
    expect(findConflicts(state, WEEK.from, WEEK.to).map(c => c.itemId)).toEqual(['pickup-tuesday', 'mom-call']);
    expect(findConflicts(state, WEEK.from, WEEK.to, { itemId: 'mom-call' }).map(c => c.itemId)).toEqual(['mom-call']);
    expect(findConflicts(state, WEEK.from, WEEK.to, { eventId: 'nothing' })).toEqual([]);
  });
});

describe('repeating items and events', () => {
  function weeklyPickup(): HomemindState {
    let state = step(fresh(), { kind: 'cancel', itemId: 'pickup-tuesday', version: 1 }, 'mom');
    state = step(state, {
      kind: 'create',
      item: {
        id: 'pickup-weekly',
        type: 'event',
        title: 'Kindergarten pickup',
        start: at('2026-11-03', '16:30'),
        end: at('2026-11-03', '17:00'),
        forMemberIds: ['noa'],
        importance: 'critical',
        recurrence: { freq: 'weekly', byWeekday: [2] },
        ownership: { state: 'assigned', ownerId: 'mom', confirmed: true }
      }
    }, 'mom');
    return state;
  }

  it('only the clashing occurrence of a weekly item moves; the series stays with its owner', () => {
    const state = withWedding({}, weeklyPickup());
    const conflicts = findConflicts(state, WEEK.from, WEEK.to);
    expect(conflicts).toEqual([expect.objectContaining({ itemId: 'pickup-weekly', date: TUESDAY, recurring: true })]);

    const result = proposed(proposeForConflicts(state, conflicts, 'mom', clock));
    const series = get(result.state, 'pickup-weekly');
    expect(series.recurrence?.exceptions).toEqual([TUESDAY]);
    expect(series.ownership).toEqual({ state: 'assigned', ownerId: 'mom', confirmed: true });

    const copy = get(result.state, `pickup-weekly-${TUESDAY}`);
    expect(copy).toMatchObject({
      type: 'event',
      title: 'Kindergarten pickup',
      start: at(TUESDAY, '16:30'),
      end: at(TUESDAY, '17:00'),
      importance: 'critical',
      status: 'open',
      forMemberIds: ['noa'],
      ownership: { state: 'open', candidateIds: ['dad', 'maya'], reason: { kind: 'unavailable', memberId: 'mom', eventId: 'wedding', date: TUESDAY } }
    });
    expect(copy.recurrence).toBeUndefined();
    expect(result.openedItemIds).toEqual([copy.id]);
    expect(result.activities.map(a => a.kind)).toEqual(['cancel_occurrence', 'create']);
    expect(findConflicts(result.state, WEEK.from, WEEK.to)).toEqual([]);
  });

  it('a weekly unavailability clashes on each occurrence in the window', () => {
    let state = step(fresh(), { kind: 'cancel', itemId: 'pickup-tuesday', version: 1 }, 'mom');
    state = step(state, {
      kind: 'create',
      item: { ...wedding({ date: '2026-11-03', from: '16:00', to: '18:00' }), id: 'mom-class', title: 'Evening class', recurrence: { freq: 'weekly', byWeekday: [2] } }
    }, 'mom');
    state = step(state, { kind: 'create', item: { id: 'one-off', type: 'task', title: 'Pick up the cake', start: at('2026-11-17', '17:00'), ownership: { state: 'assigned', ownerId: 'mom', confirmed: true } } }, 'mom');
    expect(findConflicts(state, WEEK.from, WEEK.to).map(c => `${c.eventId}>${c.itemId}@${c.date}`)).toEqual(['mom-class>one-off@2026-11-17']);
  });

  it('proposing twice for the same occurrence handles it once', () => {
    let state = withWedding({}, weeklyPickup());
    state = step(state, { kind: 'create', item: { ...wedding(), id: 'reception', title: 'Reception' } }, 'mom');
    const conflicts = findConflicts(state, WEEK.from, WEEK.to);
    expect(conflicts).toHaveLength(2);
    const result = proposed(proposeForConflicts(state, conflicts, 'mom', clock));
    expect(result.openedItemIds).toHaveLength(1);
  });
});

describe('"Parents only" and availability', () => {
  const SECRET = /wedding/i;

  function secretWedding(): HomemindState {
    const state = withWedding({ visibility: 'parents' });
    return proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to), 'mom', clock)).state;
  }

  it('a teen sees the pickup open, with no reason, no event and no unavailability', () => {
    const state = secretWedding();
    const view = viewFor(state, 'maya')!;
    expect(view.items.find(i => i.id === 'pickup-tuesday')?.ownership).toEqual({ state: 'open', candidateIds: ['dad', 'maya'] });
    expect(JSON.stringify(view)).not.toMatch(SECRET);
    expect(unavailabilityFor(state, 'maya', WEEK.from, WEEK.to)).toEqual([]);
    expect(conflictsVisibleTo(state, 'maya', [{ memberId: 'mom', eventId: 'wedding', itemId: 'pickup-tuesday', date: TUESDAY, start: '', recurring: false }])).toEqual([]);
  });

  it('the live event about the pickup reaches the teen without the reason', () => {
    const state = withWedding({ visibility: 'parents' });
    const result = proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to), 'mom', clock));
    const forMaya = eventFor(result.state, 'maya', result.events[0]);
    expect(forMaya?.item?.ownership).toEqual({ state: 'open', candidateIds: ['dad', 'maya'] });
    expect(JSON.stringify(forMaya)).not.toMatch(SECRET);
    expect(eventFor(result.state, 'dad', result.events[0])?.item?.ownership).toMatchObject({ reason: { eventId: 'wedding' } });
  });

  it('parents see the reason and the unavailability', () => {
    const state = secretWedding();
    expect(viewFor(state, 'dad')!.items.find(i => i.id === 'pickup-tuesday')?.ownership).toMatchObject({ reason: { eventId: 'wedding' } });
    expect(unavailabilityFor(state, 'dad', WEEK.from, WEEK.to)).toEqual([
      { memberId: 'mom', eventId: 'wedding', date: TUESDAY, start: at(TUESDAY, '15:00'), end: at(TUESDAY, '22:00') }
    ]);
  });

  it('a family-wide wedding is in everyone\'s summary', () => {
    const state = withWedding();
    expect(unavailabilityFor(state, 'maya', WEEK.from, WEEK.to).map(u => u.memberId)).toEqual(['mom']);
    expect(unavailabilityFor(state, 'maya', Date.parse(at(TUESDAY, '22:00')), WEEK.to)).toEqual([]);
    const conflicts = findConflicts(state, WEEK.from, WEEK.to);
    expect(conflictsVisibleTo(state, 'maya', conflicts)).toEqual(conflicts);
  });
});

describe('proposals and their limits', () => {
  it('a reason must name an event that makes that member unavailable', () => {
    const state = withWedding();
    const bad = (reason: object) => applyChange(state, { kind: 'open', itemId: 'pickup-tuesday', version: 1, reason } as Change, 'mom', clock);
    expect(bad({ kind: 'unavailable', memberId: 'dad', eventId: 'wedding', date: TUESDAY })).toMatchObject({ status: 400 });
    expect(bad({ kind: 'unavailable', memberId: 'mom', eventId: 'pickup-today', date: TUESDAY })).toMatchObject({ status: 400 });
    expect(bad({ kind: 'unavailable', memberId: 'mom', eventId: 'wedding', date: 'Tuesday' })).toMatchObject({ status: 400 });
    expect(bad({ kind: 'other', memberId: 'mom', eventId: 'wedding', date: TUESDAY })).toMatchObject({ status: 400 });
  });

  it('all or nothing: an error applies nothing', () => {
    const state = withWedding();
    const conflicts = findConflicts(state, WEEK.from, WEEK.to);
    const result = proposeForConflicts(state, conflicts, 'noa', clock);
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(get(state, 'pickup-tuesday').ownership.state).toBe('assigned');
  });

  it('Homemind opens items on its own only from level 2 and not while paused', () => {
    const family = fresh().family;
    expect(mayOpenOnItsOwn(family)).toBe(true);
    expect(mayOpenOnItsOwn({ ...family, paused: true })).toBe(false);
    expect(mayOpenOnItsOwn({ ...family, autonomy: { default: 1 } })).toBe(false);
    expect(mayOpenOnItsOwn({ ...family, autonomy: { default: 2 } })).toBe(true);
  });

  it('a reason does not reach the activity log', () => {
    const state = withWedding({ visibility: 'parents' });
    const result = proposed(proposeForConflicts(state, findConflicts(state, WEEK.from, WEEK.to), 'mom', clock));
    expect(JSON.stringify({ ...result.activities[0], undo: undefined })).not.toMatch(/wedding/);
  });
});

describe('availability.ts stays pure', () => {
  it('imports only sibling modules', () => {
    const source = readFileSync(join(__dirname, '..', 'server', 'homemind', 'availability.ts'), 'utf8');
    const specifiers = [...new Set([...source.matchAll(/\bfrom\s*'([^']+)'/g)].map(m => m[1]))].sort();
    expect(specifiers).toEqual(['./clock', './core', './types', './visibility']);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bfetch\s*\(|Date\.now\s*\(|new Date\(\)|process\.|globalThis/);
  });
});
