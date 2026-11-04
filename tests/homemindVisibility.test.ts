import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import type { Change, ChangeResult, ChangeSuccess, CoreEvent } from '../server/homemind/core';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, Item } from '../server/homemind/types';
import { eventFor, isFamilyWide, redactItem, searchItems, viewFor, visibleItems } from '../server/homemind/visibility';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const clock = fixedClock(NOW);

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

function get(state: HomemindState, id: string): Item {
  const item = state.items.find(i => i.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return item;
}

const v = (state: HomemindState, id: string) => get(state, id).version;
const step = (state: HomemindState, change: Change, actor: string) => ok(applyChange(state, change, actor, clock));

/** Every way the counselor meeting could show up: ids, titles in both languages, notes. */
const SECRET = /counselor|辅导|report card|成绩单|prep-secret/i;

/**
 * A board where the Parents-only meeting has history: edits, a preparation, an owner change, a
 * reminder and a "Why?" record that names it, plus an undone Parents-only create.
 */
function busyBoard(): HomemindState {
  let state = fresh();
  state = step(state, { kind: 'edit', itemId: 'counselor-meeting', version: 1, patch: { notes: 'Bring the report card' } }, 'mom').state;
  state = step(state, { kind: 'create', item: { id: 'prep-secret', type: 'preparation', title: 'Print the report card', parentEventId: 'counselor-meeting' } }, 'dad').state;
  state = step(state, { kind: 'assign', itemId: 'counselor-meeting', version: v(state, 'counselor-meeting'), ownerId: 'dad' }, 'mom').state;
  const created = step(state, { kind: 'create', item: { type: 'task', title: 'Talk to the counselor again', visibility: 'parents' } }, 'mom');
  state = step(created.state, { kind: 'undo', activityId: created.activity.id }, 'mom').state;
  return deepFreeze({
    ...state,
    reminders: [
      { id: 'rem-secret', itemId: 'counselor-meeting', recipientIds: ['mom', 'dad'], fireAt: '2026-11-06T01:30:00.000Z', tier: 'timed', attempts: 0, status: 'scheduled' },
      { id: 'rem-pickup', itemId: 'pickup-today', recipientIds: ['dad'], fireAt: '2026-11-04T03:30:00.000Z', tier: 'timed', attempts: 0, status: 'scheduled' }
    ],
    whys: [
      { id: 'why-secret', summary: 'Moved because of the meeting', basis: [{ kind: 'item', ref: 'counselor-meeting', note: 'meeting' }], source: 'rule' },
      { id: 'why-pizza', summary: 'Friday rule', basis: [{ kind: 'rule', ref: 'rule-friday-pizza', note: 'standing rule' }], source: 'rule' }
    ]
  });
}

describe('a teen gets no trace of a Parents-only item', () => {
  it('nothing in the view mentions it: items, preparations, activity, reminders, whys', () => {
    const state = busyBoard();
    expect(JSON.stringify(state)).toMatch(SECRET);
    const view = viewFor(state, 'maya');
    expect(view).not.toBeNull();
    expect(JSON.stringify(view)).not.toMatch(SECRET);
    expect(view!.items.map(i => i.id)).not.toContain('counselor-meeting');
    expect(view!.items.map(i => i.id)).not.toContain('prep-secret');
    expect(view!.reminders.map(r => r.id)).toEqual(['rem-pickup']);
    expect(view!.whys.map(w => w.id)).toEqual(['why-pizza']);
    // Not even the undone Parents-only create, whose item is gone.
    expect(view!.activity).toEqual([]);
  });

  it('the same for Noa, a child', () => {
    expect(JSON.stringify(viewFor(busyBoard(), 'noa'))).not.toMatch(SECRET);
  });

  it('parents see all of it, but no Undo patches leave the server', () => {
    const state = busyBoard();
    for (const parent of ['mom', 'dad']) {
      const view = viewFor(state, parent)!;
      expect(view.items.map(i => i.id)).toEqual(expect.arrayContaining(['counselor-meeting', 'prep-secret']));
      expect(view.activity).toHaveLength(state.activity.length);
      expect(view.reminders).toHaveLength(2);
      expect(view.whys).toHaveLength(2);
      expect(view.activity.every(a => !('undo' in a))).toBe(true);
    }
    expect(state.activity.every(a => a.undo || a.kind === 'undo')).toBe(true);
  });

  it('a teen still sees every family item and its activity', () => {
    let state = fresh();
    state = step(state, { kind: 'assign', itemId: 'pickup-today', version: 1, ownerId: 'dad' }, 'mom').state;
    const view = viewFor(state, 'maya')!;
    expect(view.items).toHaveLength(state.items.length - 1);
    expect(view.activity.map(a => a.itemId)).toEqual(['pickup-today']);
    expect(visibleItems(state, 'maya')).toEqual(view.items);
  });

  it('an unknown member gets no view', () => {
    expect(viewFor(fresh(), 'stranger')).toBeNull();
  });

  it('a preparation is hidden when its event is, even if the preparation itself says family', () => {
    const base = fresh();
    // Not reachable through applyChange, which keeps them in step; this guards against a bad file.
    const state = { ...base, items: [...base.items, { ...get(base, 'family-dinner-flowers'), id: 'odd-prep', parentEventId: 'counselor-meeting' }] };
    expect(visibleItems(state, 'maya').map(i => i.id)).not.toContain('odd-prep');
    expect(isFamilyWide(state, get(state, 'odd-prep'))).toBe(false);
  });
});

describe('live events per member', () => {
  it('a change to a Parents-only item reaches parents only', () => {
    const result = step(fresh(), { kind: 'assign', itemId: 'counselor-meeting', version: 1, ownerId: 'dad' }, 'mom');
    const [event] = result.events;
    expect(eventFor(result.state, 'maya', event)).toBeNull();
    expect(eventFor(result.state, 'noa', event)).toBeNull();
    expect(eventFor(result.state, 'dad', event)).toEqual(event);
  });

  it('an item that becomes Parents-only leaves a teen\'s view as a removal, with nothing about it', () => {
    const result = step(fresh(), { kind: 'edit', itemId: 'family-dinner', version: 1, patch: { visibility: 'parents', title: 'Secret dinner' } }, 'mom');
    expect(result.events).toHaveLength(2); // the event and its preparation
    for (const event of result.events) {
      expect(eventFor(result.state, 'maya', event)).toEqual({ type: 'item.changed', itemId: event.itemId, item: null });
      expect(eventFor(result.state, 'dad', event)?.item?.visibility).toBe('parents');
    }
  });

  it('an item that becomes family-wide appears for a teen', () => {
    const result = step(fresh(), { kind: 'edit', itemId: 'counselor-meeting', version: 1, patch: { visibility: 'family' } }, 'mom');
    expect(eventFor(result.state, 'maya', result.events[0])?.item?.id).toBe('counselor-meeting');
  });

  it('an undone create is a removal for whoever could see it, and nothing for anyone else', () => {
    const family = step(fresh(), { kind: 'create', item: { type: 'task', title: 'Buy milk' } }, 'mom');
    const undoneFamily = step(family.state, { kind: 'undo', activityId: family.activity.id }, 'mom');
    expect(eventFor(undoneFamily.state, 'maya', undoneFamily.events[0])).toEqual({ type: 'item.changed', itemId: family.activity.itemId, item: null });

    const secret = step(fresh(), { kind: 'create', item: { type: 'task', title: 'Counselor follow-up', visibility: 'parents' } }, 'mom');
    const undoneSecret = step(secret.state, { kind: 'undo', activityId: secret.activity.id }, 'mom');
    expect(eventFor(undoneSecret.state, 'maya', undoneSecret.events[0])).toBeNull();
    expect(eventFor(undoneSecret.state, 'dad', undoneSecret.events[0])).toEqual({ type: 'item.changed', itemId: secret.activity.itemId, item: null });
  });

  it('ignores an event type it does not know', () => {
    const odd = { type: 'other', itemId: 'pickup-today', item: null } as unknown as CoreEvent;
    expect(eventFor(fresh(), 'dad', odd)).toBeNull();
  });
});

describe('search', () => {
  it('a teen finds family items only, in either language', () => {
    const state = busyBoard();
    expect(searchItems(state, 'maya', 'counselor')).toEqual([]);
    expect(searchItems(state, 'maya', '辅导')).toEqual([]);
    expect(searchItems(state, 'maya', 'report')).toEqual([]);
    expect(searchItems(state, 'dad', 'counselor').map(i => i.id)).toEqual(['counselor-meeting']);
    expect(searchItems(state, 'dad', '辅导').map(i => i.id)).toEqual(['counselor-meeting']);
    expect(searchItems(state, 'dad', 'REPORT CARD').map(i => i.id)).toEqual(['counselor-meeting', 'prep-secret']);
    expect(searchItems(state, 'maya', 'Pickup').map(i => i.id)).toEqual(['pickup-today', 'pickup-tuesday']);
    expect(searchItems(state, 'maya', '幼儿园').map(i => i.id)).toEqual(['pickup-today', 'pickup-tuesday']);
  });

  it('leaves out removed items, and an empty query finds nothing', () => {
    const state = step(fresh(), { kind: 'cancel', itemId: 'pickup-today', version: 1 }, 'mom').state;
    expect(searchItems(state, 'maya', 'pickup').map(i => i.id)).toEqual(['pickup-tuesday']);
    expect(searchItems(state, 'maya', '   ')).toEqual([]);
    expect(searchItems(state, 'maya', undefined as unknown as string)).toEqual([]);
  });
});

describe('what may leave the family (PPMA)', () => {
  it('only family-wide items', () => {
    const state = busyBoard();
    expect(isFamilyWide(state, get(state, 'counselor-meeting'))).toBe(false);
    expect(isFamilyWide(state, get(state, 'prep-secret'))).toBe(false);
    expect(isFamilyWide(state, get(state, 'pickup-today'))).toBe(true);
    expect(isFamilyWide(state, get(state, 'family-dinner-flowers'))).toBe(true);
  });
});

describe('redacting a reason', () => {
  it('drops an "unavailable" reason whose event the member cannot see, and keeps the rest', () => {
    const state = fresh();
    const item: Item = {
      ...get(state, 'pickup-tuesday'),
      ownership: { state: 'open', candidateIds: ['dad', 'maya'], reason: { kind: 'unavailable', memberId: 'mom', eventId: 'counselor-meeting', date: '2026-11-06' } }
    };
    expect(redactItem(state, 'maya', item).ownership).toEqual({ state: 'open', candidateIds: ['dad', 'maya'] });
    expect(redactItem(state, 'dad', item)).toBe(item);
    const visibleReason: Item = { ...item, ownership: { state: 'open', candidateIds: ['dad'], reason: { kind: 'unavailable', memberId: 'mom', eventId: 'family-dinner', date: '2026-11-08' } } };
    expect(redactItem(state, 'maya', visibleReason)).toBe(visibleReason);
  });
});

describe('visibility.ts stays pure', () => {
  it('imports only sibling core and types modules', () => {
    const source = readFileSync(join(__dirname, '..', 'server', 'homemind', 'visibility.ts'), 'utf8');
    const specifiers = [...new Set([...source.matchAll(/\bfrom\s*'([^']+)'/g)].map(m => m[1]))].sort();
    expect(specifiers).toEqual(['./core', './types']);
  });
});
