import { describe, expect, it } from 'vitest';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import type { Change, ChangeSuccess } from '../server/homemind/core';
import { PROPOSAL_LIMITS, boardForPpma, handlePpmaCommand, preferenceReport, reminderReport, reportsForChange } from '../server/homemind/ppmaMap';
import type { PpmaCommand } from '../server/homemind/ppma';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 4, 2, 0);
const clock = fixedClock(NOW);
const fresh = (): HomemindState => seedState({ now: NOW, timezone: TZ });

function apply(state: HomemindState, change: Change, actor = 'mom'): ChangeSuccess {
  const result = applyChange(state, change, actor, clock);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

const versionOf = (state: HomemindState, id: string) => state.items.find(i => i.id === id)!.version;

function command(type: string, payload: Record<string, unknown> = {}): PpmaCommand {
  return {
    id: '01JC0000000000000000000000',
    kind: 'command',
    type,
    space: 'me',
    source: { app: 'ppma', app_version: 'test' },
    target: 'homemind',
    occurred_at: new Date(NOW).toISOString(),
    payload,
    confidence: 0.5,
    rationale: 'test',
    decision_id: '01JC0000000000000000000001',
    expires_at: new Date(NOW + 600_000).toISOString()
  };
}

describe('reports for board changes', () => {
  it('reports an assignment with names and the actor', () => {
    const before = fresh();
    const r = apply(before, { kind: 'assign', itemId: 'pickup-today', version: versionOf(before, 'pickup-today'), ownerId: 'dad' });
    const reports = reportsForChange(before, r.state, r.events, 'mom');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      type: 'homemind.item_changed',
      payload: { item_id: 'pickup-today', change: 'changed', title: 'Kindergarten pickup', ownership: 'assigned', owner_id: 'dad', owner_name: 'Dad', owner_confirmed: false, actor_id: 'mom', actor_name: 'Mom', importance: 'critical' }
    });
  });

  it('never reports a Parents-only item, nor a preparation under one', () => {
    const before = fresh();
    const v = versionOf(before, 'counselor-meeting');
    const edited = apply(before, { kind: 'edit', itemId: 'counselor-meeting', version: v, patch: { title: 'Changed title' } });
    expect(reportsForChange(before, edited.state, edited.events, 'mom')).toEqual([]);
    const prep = apply(before, { kind: 'create', item: { type: 'preparation', title: 'Bring the school report', parentEventId: 'counselor-meeting', source: { kind: 'manual', label: 'Mom' } } });
    expect(reportsForChange(before, prep.state, prep.events, 'mom')).toEqual([]);
    const created = apply(before, { kind: 'create', item: { type: 'event', title: 'Secret plan', start: new Date(NOW + 86400000).toISOString(), end: new Date(NOW + 90000000).toISOString(), visibility: 'parents', source: { kind: 'manual', label: 'Mom' } } });
    expect(reportsForChange(before, created.state, created.events, 'mom')).toEqual([]);
  });

  it('reports only "hidden" with the id when an item becomes Parents-only', () => {
    const before = fresh();
    const r = apply(before, { kind: 'edit', itemId: 'family-dinner', version: versionOf(before, 'family-dinner'), patch: { visibility: 'parents' } });
    const reports = reportsForChange(before, r.state, r.events, 'mom');
    const dinner = reports.find(x => x.payload.item_id === 'family-dinner');
    expect(dinner).toEqual({ type: 'homemind.item_changed', payload: { item_id: 'family-dinner', change: 'hidden', actor_id: 'mom', actor_name: 'Mom' } });
    // Its preparation followed it out of the family's view: also only "hidden".
    for (const report of reports) expect(Object.keys(report.payload).sort()).toEqual(['actor_id', 'actor_name', 'change', 'item_id']);
  });

  it('leaves out the title and notes of a sensitive item', () => {
    const before = fresh();
    const r = apply(before, { kind: 'create', item: { type: 'task', title: 'Private thing', notes: 'details', sensitive: true, source: { kind: 'manual', label: 'Mom' } } });
    const [report] = reportsForChange(before, r.state, r.events, 'mom');
    expect(report.payload).toMatchObject({ change: 'created', sensitive: true });
    expect(report.payload.title).toBeUndefined();
    expect(report.payload.notes).toBeUndefined();
  });

  it('reports member_unavailable for a family-wide event that makes someone away, once', () => {
    const before = fresh();
    const start = new Date(NOW + 5 * 86400000).toISOString();
    const end = new Date(NOW + 5 * 86400000 + 4 * 3600000).toISOString();
    const r = apply(before, { kind: 'create', item: { type: 'event', title: 'Wedding', start, end, unavailableMemberIds: ['mom'], source: { kind: 'manual', label: 'Mom' } } });
    const reports = reportsForChange(before, r.state, r.events, 'mom');
    expect(reports.map(x => x.type)).toEqual(['homemind.item_changed', 'homemind.member_unavailable']);
    expect(reports[1].payload).toMatchObject({ member_id: 'mom', member_name: 'Mom', title: 'Wedding', from: start, to: end });
    // A notes edit does not repeat it.
    const id = r.items[0].id;
    const again = apply(r.state, { kind: 'edit', itemId: id, version: versionOf(r.state, id), patch: { notes: 'Bring a gift' } });
    expect(reportsForChange(r.state, again.state, again.events, 'mom').map(x => x.type)).toEqual(['homemind.item_changed']);
  });

  it('does not report member_unavailable for a Parents-only event', () => {
    const before = fresh();
    const r = apply(before, {
      kind: 'create',
      item: { type: 'event', title: 'Doctor', start: new Date(NOW + 86400000).toISOString(), end: new Date(NOW + 90000000).toISOString(), unavailableMemberIds: ['mom'], visibility: 'parents', source: { kind: 'manual', label: 'Mom' } }
    });
    expect(reportsForChange(before, r.state, r.events, 'mom')).toEqual([]);
  });

  it('reports a removal (an undone create) as removed', () => {
    const before = fresh();
    const created = apply(before, { kind: 'create', item: { type: 'task', title: 'Buy milk', source: { kind: 'manual', label: 'Mom' } } });
    const undone = apply(created.state, { kind: 'undo', activityId: created.activity.id });
    const [report] = reportsForChange(created.state, undone.state, undone.events, 'mom');
    expect(report.payload).toMatchObject({ item_id: created.items[0].id, change: 'removed' });
    expect(report.payload.title).toBeUndefined();
  });
});

describe('preference and reminder reports', () => {
  it('carries the reason and scope; a removal carries no text', () => {
    const state = fresh();
    const pref = state.preferences.find(p => p.id === 'pref-noa-cake')!;
    const added = preferenceReport(state, 'added', pref.id, pref, 'mom');
    expect(added.payload).toMatchObject({ preference_id: 'pref-noa-cake', change: 'added', about_member_id: 'noa', about_member_name: 'Noa', strength: pref.strength, actor_name: 'Mom' });
    expect(added.payload.reason).toBe(pref.reason);
    const removed = preferenceReport(state, 'removed', pref.id, null, 'mom');
    expect(removed.payload).toEqual({ preference_id: 'pref-noa-cake', change: 'removed', actor_id: 'mom', actor_name: 'Mom' });
  });

  it('reports a reminder answer only for a family-wide item', () => {
    const state = fresh();
    expect(reminderReport(state, 'r1', 'pickup-today', 'snooze', 'dad')?.payload).toEqual({ reminder_id: 'r1', item_id: 'pickup-today', response: 'remind_later', member_id: 'dad' });
    expect(reminderReport(state, 'r2', 'counselor-meeting', 'ack', 'mom')).toBeNull();
  });
});

describe('commands', () => {
  it('get_board returns the family-wide board, never a Parents-only item', () => {
    const state = fresh();
    const { outcome } = handlePpmaCommand(state, command('homemind.get_board'), NOW);
    expect(outcome.status).toBe('executed');
    const result = outcome.result as { items: Array<{ item_id: string }>; members: Array<{ id: string }>; timezone: string };
    const ids = result.items.map(i => i.item_id);
    expect(ids).toContain('pickup-today');
    expect(ids).toContain('family-dinner-flowers');
    expect(ids).not.toContain('counselor-meeting');
    expect(JSON.stringify(result)).not.toContain('counselor');
    expect(result.members.map(m => m.id)).toEqual(['mom', 'dad', 'maya', 'noa']);
    expect(result.timezone).toBe(TZ);
    expect(boardForPpma(state, NOW)).toEqual(result);
  });

  it('answers ui and policy commands and unknown ones with a plain rejection, changing nothing', () => {
    const state = fresh();
    for (const type of ['ui.notify', 'ui.ask', 'policy.set_threshold', 'other.thing']) {
      const handled = handlePpmaCommand(state, command(type, { title: 'x' }), NOW);
      expect(handled.outcome.status).toBe('rejected');
      expect(handled.outcome.detail).toBeTruthy();
      expect(handled.state).toBeUndefined();
    }
  });
});

describe('proposals from PPMA (T6.2)', () => {
  const START = '2026-11-06T09:00:00+08:00';
  const propose = (state: HomemindState, type: string, payload: Record<string, unknown>, extra: Partial<PpmaCommand> = {}) => handlePpmaCommand(state, { ...command(type, payload), ...extra }, NOW);
  const proposedItems = (state: HomemindState) => state.items.filter(i => i.source.kind === 'ppma');

  it('proposes a task without a time and an event with one, both waiting for a parent', () => {
    const state = fresh();
    const task = propose(state, 'homemind.propose_item', { title: 'Check the swim bag', notes: 'Goggles?' });
    expect(task.outcome).toMatchObject({ status: 'executed', path: 'auto' });
    const created = task.state!.items.find(i => i.title === 'Check the swim bag')!;
    expect(created).toMatchObject({ type: 'task', status: 'proposed', notes: 'Goggles?', source: { kind: 'ppma', label: 'PPMA' }, ownership: { state: 'none' } });
    expect(task.events!.map(e => e.itemId)).toContain(created.id);
    expect(task.outcome.result).toMatchObject({ item_id: created.id, status: 'proposed' });

    const event = propose(task.state!, 'homemind.propose_item', { title: 'Kindergarten party', start: START });
    const party = event.state!.items.find(i => i.title === 'Kindergarten party')!;
    expect(party).toMatchObject({ type: 'event', status: 'proposed', start: '2026-11-06T01:00:00.000Z', end: '2026-11-06T02:00:00.000Z' });
  });

  it('puts a preparation under a family-wide event, and a shopping suggestion is a task that buys nothing', () => {
    const state = fresh();
    const prep = propose(state, 'homemind.propose_preparation', { event_id: 'family-dinner', title: 'Bring a dessert', due: START });
    expect(prep.outcome.status).toBe('executed');
    expect(prep.state!.items.find(i => i.title === 'Bring a dessert')).toMatchObject({ type: 'preparation', parentEventId: 'family-dinner', status: 'proposed', start: '2026-11-06T01:00:00.000Z' });
    const shop = propose(state, 'homemind.add_to_shopping', { title: 'Cut fruit' });
    const task = shop.state!.items.find(i => i.title === 'Cut fruit')!;
    expect(task).toMatchObject({ type: 'task', status: 'proposed' });
    expect(task.notes).toContain('Nothing is bought');
  });

  it('writes a Why that says PPMA, with its reason, confidence and decision id, and never an actor in the report', () => {
    const state = fresh();
    const done = propose(state, 'homemind.propose_item', { title: 'Plan the party' }, { rationale: 'The group asked for fruit', confidence: 0.7, decision_id: 'dec-1' });
    const created = done.state!.items.find(i => i.title === 'Plan the party')!;
    const why = done.state!.whys.find(w => w.basis.some(b => b.ref === created.id))!;
    expect(why).toMatchObject({ id: `why-${created.id}`, source: 'ppma', summary: 'The group asked for fruit', decisionId: 'dec-1' });
    expect(why.basis).toContainEqual({ kind: 'confidence', ref: created.id, note: '0.70' });
    // The report to PPMA about the new item names no member as the actor.
    const reports = reportsForChange(state, done.state!, done.events!, undefined);
    expect(reports[0].payload).toMatchObject({ item_id: created.id, source: 'ppma', change: 'created' });
    expect(reports[0].payload.actor_id).toBeUndefined();
  });

  it('keeps a decision id only when it is well formed, and falls back to a plain reason', () => {
    const state = fresh();
    const done = propose(state, 'homemind.propose_item', { title: 'Odd one' }, { decision_id: 'bad id with spaces', rationale: '' });
    const created = done.state!.items.find(i => i.title === 'Odd one')!;
    const why = done.state!.whys.find(w => w.basis.some(b => b.ref === created.id) || w.id === `why-${created.id}`)!;
    expect(why.decisionId).toBeUndefined();
    expect(why.summary).toContain('PPMA suggested');
  });

  it('refuses with a plain reason and changes nothing', () => {
    const state = fresh();
    const refused = (type: string, payload: Record<string, unknown>, s = state) => {
      const handled = propose(s, type, payload);
      expect(handled.outcome.status, JSON.stringify(payload)).toBe('rejected');
      expect(handled.outcome.detail).toBeTruthy();
      expect(handled.state).toBeUndefined();
      return handled.outcome.detail as string;
    };
    refused('homemind.propose_item', {});
    refused('homemind.propose_item', { title: '   ' });
    refused('homemind.propose_item', { title: 'x', start: 'tomorrow' });
    refused('homemind.propose_item', { title: 'x', start: '2026-11-06T09:00:00' });
    refused('homemind.propose_item', { title: 'x', start: '2031-11-06T09:00:00+08:00' });
    refused('homemind.propose_item', { title: 'x', start: '2020-11-06T09:00:00+08:00' });
    refused('homemind.propose_preparation', { title: 'x', event_id: 'no-such-event' });
    refused('homemind.propose_preparation', { title: 'x', event_id: 'pickup-today/../x' });
    refused('homemind.propose_preparation', { title: 'x', event_id: 'library-books' });
    // A Parents-only event answers like a missing one: PPMA never learns it exists.
    expect(refused('homemind.propose_preparation', { title: 'Bring tea', event_id: 'counselor-meeting' })).toBe('No such event on the family board');
    refused('homemind.add_to_shopping', { title: 5 });
  });

  it('refuses while paused, and when the same thing is already there', () => {
    const state = fresh();
    expect(propose({ ...state, family: { ...state.family, paused: true } }, 'homemind.propose_item', { title: 'Anything' }).outcome).toMatchObject({ status: 'rejected' });
    const first = propose(state, 'homemind.propose_item', { title: 'Check the swim bag' });
    const again = propose(first.state!, 'homemind.propose_item', { title: 'check the swim bag!' });
    expect(again.outcome).toMatchObject({ status: 'rejected', detail: 'Already on the board' });
    // The same words at another time are a different thing.
    expect(propose(first.state!, 'homemind.propose_item', { title: 'Check the swim bag', start: START }).outcome.status).toBe('executed');
  });

  it('stops at the number of suggestions waiting for a parent', () => {
    let state = fresh();
    for (let n = 0; n < PROPOSAL_LIMITS.waiting; n++) {
      const handled = propose(state, 'homemind.propose_item', { title: `Idea ${n}` });
      expect(handled.outcome.status).toBe('executed');
      state = handled.state!;
    }
    expect(propose(state, 'homemind.propose_item', { title: 'One more' }).outcome).toMatchObject({ status: 'rejected', detail: 'Too many suggestions are waiting for a parent' });
    // A parent approving one makes room.
    const first = proposedItems(state)[0];
    state = apply(state, { kind: 'approve', itemId: first.id, version: first.version }).state;
    expect(propose(state, 'homemind.propose_item', { title: 'One more' }).outcome.status).toBe('executed');
  });

  it('never proposes what a hard preference rules out, and says which word', () => {
    const state = fresh();
    const blocked = propose(state, 'homemind.propose_preparation', { event_id: 'family-dinner', title: 'Bring peanut cookies' });
    expect(blocked.outcome.status).toBe('rejected');
    expect(blocked.outcome.detail).toContain('hard preference');
    expect(blocked.outcome.detail).toContain('peanut');
    expect(blocked.state).toBeUndefined();
    // Without the preference the same suggestion goes through: the saved preference decided, not a guess.
    const without = { ...state, preferences: state.preferences.filter(p => p.id !== 'pref-noa-peanuts') };
    expect(propose(without, 'homemind.propose_preparation', { event_id: 'family-dinner', title: 'Bring peanut cookies' }).outcome.status).toBe('executed');
  });

  it('lists the saved preferences that applied, so a removed preference is gone from the next suggestion', () => {
    let state = fresh();
    const party = propose(state, 'homemind.propose_item', { title: 'Kindergarten party', start: START });
    state = party.state!;
    const partyId = state.items.find(i => i.title === 'Kindergarten party')!.id;
    const considered = (s: HomemindState, title: string) => {
      const created = s.items.find(i => i.title === title)!;
      return s.whys.find(w => w.id === `why-${created.id}`)!.basis.filter(b => b.kind === 'preference').map(b => b.note);
    };
    const first = propose(state, 'homemind.propose_preparation', { event_id: partyId, title: 'Bake a cake' }, { rationale: 'She enjoys it' });
    expect(first.outcome.status).toBe('executed');
    expect(considered(first.state!, 'Bake a cake').join(' ')).toContain('bake a cake');
    // The correction: the family removes the preference. The next suggestion no longer lists it.
    const corrected = { ...first.state!, preferences: first.state!.preferences.filter(p => p.id !== 'pref-noa-cake') };
    const next = propose(corrected, 'homemind.propose_preparation', { event_id: partyId, title: 'Bring plates' });
    expect(next.outcome.status).toBe('executed');
    expect(considered(next.state!, 'Bring plates').join(' ')).not.toContain('bake a cake');
  });

  it('ignores arguments it does not know and cannot be made to set an owner, a person or a visibility', () => {
    const state = fresh();
    const handled = propose(state, 'homemind.propose_item', { title: 'Sneaky', owner_id: 'dad', for_member_ids: ['noa'], visibility: 'parents', sensitive: true, status: 'open', source: { kind: 'manual' } });
    const created = handled.state!.items.find(i => i.title === 'Sneaky')!;
    expect(created).toMatchObject({ status: 'proposed', visibility: 'family', sensitive: false, ownership: { state: 'none' }, forMemberIds: [], source: { kind: 'ppma' } });
  });
});
