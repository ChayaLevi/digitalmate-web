import { describe, expect, it } from 'vitest';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import type { Change, ChangeSuccess } from '../server/homemind/core';
import { boardForPpma, handlePpmaCommand, preferenceReport, reminderReport, reportsForChange } from '../server/homemind/ppmaMap';
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

  it('answers proposals, ui and policy commands with a plain rejection until T6.2, changing nothing', () => {
    const state = fresh();
    for (const type of ['homemind.propose_item', 'homemind.propose_preparation', 'homemind.add_to_shopping', 'ui.notify', 'policy.set_threshold', 'other.thing']) {
      const handled = handlePpmaCommand(state, command(type, { title: 'x' }), NOW);
      expect(handled.outcome.status).toBe('rejected');
      expect(handled.outcome.detail).toBeTruthy();
      expect(handled.state).toBeUndefined();
    }
  });
});
