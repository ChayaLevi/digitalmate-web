import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertDelivery } from '../server/homemind/alerts';
import { alertsForChange } from '../server/homemind/alerts';
import { fixedClock, localParts } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import type { Change } from '../server/homemind/core';
import {
  BACKUP_TEXT,
  REMINDER_TIMING,
  inQuietHours,
  nextSummaryAt,
  quietHoursEnd,
  respondToReminder,
  routeAlerts,
  tickReminders
} from '../server/homemind/reminders';
import type { TickResult } from '../server/homemind/reminders';
import { schedulerRunning, startScheduler, stopScheduler, tickSchedulerNow } from '../server/homemind/scheduler';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, Item, Member, Reminder } from '../server/homemind/types';
import { alertButtons, alertText, closeReminder, stillRelevant } from '../src/lib/homemindAlerts';

const TZ = 'Asia/Shanghai';
const MIN = 60_000;
/** 17:00 in Shanghai. The seeded pickup starts at 19:00 (NOW + 120 min), critical, owned by nobody. */
const NOW = Date.parse('2026-11-04T09:00:00Z');
const at = (minutes: number) => NOW + minutes * MIN;

function seed(): HomemindState {
  return seedState({ now: NOW, timezone: TZ });
}

/** The seed with only these items (and nothing scheduled yet). */
function only(st: HomemindState, ids: string[]): HomemindState {
  return { ...st, items: st.items.filter(i => ids.includes(i.id)) };
}

function change(st: HomemindState, c: Change, actor: string, when = NOW): HomemindState {
  const result = applyChange(st, c, actor, fixedClock(when));
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}

const item = (st: HomemindState, id: string) => st.items.find(i => i.id === id) as Item;

/** Dad has the seeded pickup, not confirmed (Scene 1). */
function scene1(): HomemindState {
  const st = only(seed(), ['pickup-today']);
  return change(st, { kind: 'assign', itemId: 'pickup-today', version: item(st, 'pickup-today').version, ownerId: 'dad' }, 'mom');
}

/** A test item at NOW + `inMinutes`, half an hour long. */
function withItem(st: HomemindState, fields: Partial<Item> & Pick<Item, 'id'>, inMinutes: number): HomemindState {
  const base: Item = {
    type: 'event',
    title: fields.id,
    forMemberIds: [],
    ownership: { state: 'none' },
    visibility: 'family',
    sensitive: false,
    importance: 'normal',
    unavailableMemberIds: [],
    status: 'open',
    source: { kind: 'manual', label: 'Mom' },
    createdBy: 'mom',
    version: 1,
    start: new Date(at(inMinutes)).toISOString(),
    end: new Date(at(inMinutes + 30)).toISOString(),
    ...fields
  };
  return { ...st, items: [...st.items, base] };
}

/** Ticks at each minute in `minutes`, carrying the state along. Returns every tick's result. */
function run(st: HomemindState, minutes: number[]): { state: HomemindState; ticks: TickResult[] } {
  const ticks: TickResult[] = [];
  let state = st;
  for (const m of minutes) {
    const t = tickReminders(state, at(m));
    ticks.push(t);
    state = t.state;
  }
  return { state, ticks };
}

const sent = (ticks: TickResult[]) => ticks.flatMap(t => t.deliveries);
const to = (deliveries: AlertDelivery[], memberId: string) => deliveries.filter(d => d.recipientId === memberId).map(d => d.alert);
const reminderOf = (st: HomemindState, itemId: string) => st.reminders.filter(r => r.itemId === itemId).pop() as Reminder;
const minutes = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('planning', () => {
  it('plans one reminder per occurrence, and nothing for an all-day item or a non-critical item nobody was asked about', () => {
    const st = seed();
    const t = tickReminders(st, NOW);
    expect(t.changed).toBe(true);
    // In the next 26 hours: today's pickup (critical, nobody has it) and the swimming lesson (Mom confirmed).
    expect(t.state.reminders.map(r => [r.itemId, r.ask]).sort()).toEqual([
      ['pickup-today', 'open'],
      ['swim-today', 'heads-up']
    ]);
    // Maya's piano lesson has no owner and is not critical; the library books are all day.
    expect(t.state.reminders.some(r => r.itemId === 'piano-tomorrow' || r.itemId === 'library-books')).toBe(false);
    expect(t.deliveries).toEqual([]);
    // A second tick at the same time changes nothing.
    expect(tickReminders(t.state, NOW).changed).toBe(false);
  });

  it('a critical reminder starts an hour ahead, 10 minutes apart; a regular one half an hour ahead', () => {
    const t = tickReminders(withItem(scene1(), { id: 'dentist', ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } }, 200), NOW);
    const pickup = reminderOf(t.state, 'pickup-today');
    expect(pickup).toMatchObject({ ask: 'confirm', recipientIds: ['dad'], tier: 'urgent', maxAttempts: 3, intervalMinutes: 10, status: 'scheduled' });
    expect(pickup.firstAt).toBe(new Date(at(60)).toISOString());
    expect(pickup.escalation).toEqual([
      { afterMinutes: 30, to: 'next-parent' },
      { afterMinutes: 40, to: 'backup' }
    ]);
    const dentist = reminderOf(t.state, 'dentist');
    expect(dentist).toMatchObject({ ask: 'confirm', tier: 'timed', maxAttempts: 1, escalation: [] });
    expect(dentist.firstAt).toBe(new Date(at(170)).toISOString());
  });

  it('with less time left, the steps are closer together and still all happen before the start', () => {
    const st = withItem(only(seed(), []), { id: 'late', importance: 'critical', ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } }, 20);
    const r = reminderOf(tickReminders(st, NOW).state, 'late');
    expect(r.firstAt).toBe(new Date(NOW).toISOString());
    expect(r.intervalMinutes).toBe(5);
    expect(Math.max(...(r.escalation ?? []).map(s => s.afterMinutes))).toBeLessThanOrEqual(20);
  });
});

describe('a regular reminder', () => {
  it('is sent once; with no answer it moves to the evening summary', () => {
    const st = withItem(only(seed(), []), { id: 'dentist', title: 'Dentist', ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } }, 60);
    const { state, ticks } = run(st, [0, 29, 30, 31, 45, 59, 60]);
    const alerts = to(sent(ticks), 'dad');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'reminder', ask: 'confirm', itemId: 'dentist', tier: 'timed', time: '18:00', byId: 'homemind', reminderId: reminderOf(state, 'dentist').id });
    expect(sent(ticks).every(d => d.recipientId === 'dad')).toBe(true);
    const r = reminderOf(state, 'dentist');
    expect(r).toMatchObject({ status: 'sent', attempts: 1, tier: 'summary' });
    // 18:00 local now, 30 minutes with no answer; the summary is at 20:00 local the same day.
    expect(r.summaryAt).toBe(new Date(nextSummaryAt(at(60), TZ)).toISOString());
    expect(localParts(Date.parse(r.summaryAt as string), TZ).time).toBe(REMINDER_TIMING.summaryTime);
  });

  it('a heads-up goes to an owner who already confirmed, once, with no escalation', () => {
    const st = only(seed(), ['swim-today']);
    const { ticks } = run(st, minutes(110, 160));
    expect(sent(ticks).map(d => [d.recipientId, d.alert.kind, d.alert.ask])).toEqual([['mom', 'reminder', 'heads-up']]);
  });
});

describe('a critical reminder (Scene 1)', () => {
  it('3 attempts to Dad, then one escalation to Mom, then the backup contact, then nothing more', () => {
    const { state, ticks } = run(scene1(), minutes(0, 180));
    const all = sent(ticks);
    const dad = to(all, 'dad');
    const mom = to(all, 'mom');
    expect(dad.filter(a => a.kind === 'reminder').map(a => a.id.split('.').pop())).toEqual(['a1', 'a2', 'a3']);
    expect(mom.filter(a => a.kind === 'escalation')).toHaveLength(1);
    expect(mom.find(a => a.kind === 'escalation')).toMatchObject({ ask: 'confirm', tier: 'urgent', itemId: 'pickup-today', time: '19:00' });
    expect(to(all, 'maya')).toEqual([]);
    // When: attempts at -60, -50, -40, escalation at -30, backup at -20.
    const when = (pred: (d: AlertDelivery) => boolean) => ticks.findIndex(t => t.deliveries.some(pred));
    expect(when(d => d.alert.id.endsWith('.a1'))).toBe(60);
    expect(when(d => d.alert.id.endsWith('.a3'))).toBe(80);
    expect(when(d => d.alert.kind === 'escalation')).toBe(90);
    expect(when(d => d.alert.kind === 'backup')).toBe(100);
    // The backup notice goes to both parents, and says the contact is simulated.
    expect(all.filter(d => d.alert.kind === 'backup').map(d => d.recipientId).sort()).toEqual(['dad', 'mom']);
    expect(all.find(d => d.alert.kind === 'backup')?.alert).toMatchObject({ contactName: 'Grandma Lin', simulated: true });
    expect(state.backupMessages).toHaveLength(1);
    expect(reminderOf(state, 'pickup-today')).toMatchObject({ status: 'sent', attempts: 3, escalationsDone: 2, escalatedToIds: ['mom'] });
  });

  it('a demo clock jump past several steps counts them and sends one reminder and the escalation, not a burst', () => {
    let st = tickReminders(scene1(), NOW).state;
    const t = tickReminders(st, at(95));
    expect(to(t.deliveries, 'dad').map(a => a.kind)).toEqual(['reminder']);
    expect(to(t.deliveries, 'mom').map(a => a.kind)).toEqual(['escalation']);
    st = t.state;
    expect(reminderOf(st, 'pickup-today').attempts).toBe(3);
    // The next tick only adds the backup step, when it is due.
    expect(tickReminders(st, at(96)).deliveries).toEqual([]);
    expect(tickReminders(st, at(100)).deliveries.map(d => d.alert.kind)).toEqual(['backup', 'backup']);
  });

  it('no backup step when the family set no backup contact', () => {
    const st = scene1();
    const { state, ticks } = run({ ...st, family: { ...st.family, backupContact: undefined } }, minutes(0, 180));
    expect(sent(ticks).some(d => d.alert.kind === 'backup')).toBe(false);
    expect(state.backupMessages).toBeUndefined();
  });

  it('the backup message has no reason and no details', () => {
    const { state } = run(scene1(), minutes(0, 110));
    const [message] = state.backupMessages ?? [];
    expect(message).toMatchObject({ to: 'Grandma Lin', channel: 'sms', simulated: true, text: BACKUP_TEXT.en, textZh: BACKUP_TEXT.zh });
    const pickup = item(state, 'pickup-today');
    for (const detail of [pickup.title, pickup.titleZh, '19:00', 'Noa', '诺娅', 'Dad', '爸爸', 'Mom', '妈妈', 'pickup', '接']) {
      expect(`${message.text} ${message.textZh}`).not.toContain(detail as string);
    }
  });

  it('a pause stops automatic actions, not reminders', () => {
    const st = scene1();
    const paused = { ...st, family: { ...st.family, paused: true } };
    expect(sent(run(paused, minutes(0, 100)).ticks).length).toBe(sent(run(st, minutes(0, 100)).ticks).length);
    expect(sent(run(paused, minutes(0, 100)).ticks).length).toBeGreaterThan(0);
  });
});

describe('an open item', () => {
  it('a regular one goes to its candidates, then to both parents near its time', () => {
    const st = withItem(only(seed(), []), { id: 'bake', title: 'Bake', ownership: { state: 'open', candidateIds: ['maya'] } }, 60);
    const { ticks } = run(st, minutes(0, 70));
    const all = sent(ticks);
    expect(to(all, 'maya').map(a => [a.kind, a.ask])).toEqual([['reminder', 'open']]);
    expect(all.filter(d => d.alert.kind === 'escalation').map(d => d.recipientId).sort()).toEqual(['dad', 'mom']);
    expect(ticks.findIndex(t => t.deliveries.some(d => d.alert.kind === 'escalation'))).toBe(45);
  });

  it('an unowned critical item (the pickup before anyone has it) asks everyone who could take it, then both parents', () => {
    const st = only(seed(), ['pickup-today']);
    const { ticks } = run(st, minutes(0, 95));
    const all = sent(ticks);
    expect(all.filter(d => d.alert.id.endsWith('.a1')).map(d => d.recipientId).sort()).toEqual(['dad', 'maya', 'mom']);
    expect(all.filter(d => d.alert.kind === 'escalation').map(d => d.recipientId).sort()).toEqual(['dad', 'mom']);
  });
});

describe('answers', () => {
  it('Dad confirming closes the reminder for everyone it reached, with no heads-up right after', () => {
    let st = run(scene1(), minutes(0, 92)).state;
    const before = reminderOf(st, 'pickup-today');
    st = change(st, { kind: 'confirm', itemId: 'pickup-today', version: item(st, 'pickup-today').version }, 'dad', at(93));
    const t = tickReminders(st, at(93));
    expect(t.closed).toEqual([{ reminderId: before.id, recipientIds: ['dad', 'mom'] }]);
    expect(t.state.reminders.find(r => r.id === before.id)).toMatchObject({ status: 'acknowledged', answeredBy: 'dad' });
    // Confirmed: no new reminder for this occurrence, and nothing more is sent.
    const later = run(t.state, minutes(94, 180));
    expect(sent(later.ticks)).toEqual([]);
    expect(later.state.reminders.filter(r => r.itemId === 'pickup-today' && (r.status === 'scheduled' || r.status === 'sent'))).toEqual([]);
  });

  it('Mom taking it from the escalation closes it for Dad too', () => {
    let st = run(scene1(), minutes(0, 91)).state;
    st = change(st, { kind: 'assign', itemId: 'pickup-today', version: item(st, 'pickup-today').version, ownerId: 'mom' }, 'mom', at(92));
    const t = tickReminders(st, at(92));
    expect(t.closed.map(c => c.recipientIds.sort())).toEqual([['dad', 'mom']]);
    expect(sent(run(t.state, minutes(93, 180)).ticks)).toEqual([]);
  });

  it('"Got it" from anyone it reached closes it for all; a second answer is refused', () => {
    let st = run(scene1(), minutes(0, 91)).state;
    const r = reminderOf(st, 'pickup-today');
    const answer = respondToReminder(st, r.id, 'mom', 'ack', at(92));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.closed).toEqual([{ reminderId: r.id, recipientIds: ['dad', 'mom'] }]);
    st = answer.state;
    expect(respondToReminder(st, r.id, 'dad', 'ack', at(93))).toMatchObject({ ok: false, status: 409 });
    expect(sent(run(st, minutes(93, 180)).ticks)).toEqual([]);
  });

  it('only a member it reached may answer; for a teen, a Parents-only reminder does not exist', () => {
    const st = run(scene1(), minutes(0, 65)).state;
    const r = reminderOf(st, 'pickup-today');
    expect(respondToReminder(st, r.id, 'maya', 'ack', at(66))).toMatchObject({ ok: false, status: 403 });
    expect(respondToReminder(st, 'rem-nope', 'dad', 'ack', at(66))).toMatchObject({ ok: false, status: 404 });
    const secret = only(seed(), ['counselor-meeting']);
    const start = Date.parse(item(secret, 'counselor-meeting').start as string);
    const planned = tickReminders(secret, start - 60 * MIN).state;
    const sr = reminderOf(planned, 'counselor-meeting');
    expect(respondToReminder(planned, sr.id, 'maya', 'ack', start - 50 * MIN)).toMatchObject({ ok: false, status: 404 });
  });

  it('"Remind me later" closes the alert for all, sends nothing until then, then once more; the escalation does not move', () => {
    let st = run(scene1(), minutes(0, 60)).state;
    const r = reminderOf(st, 'pickup-today');
    const answer = respondToReminder(st, r.id, 'dad', 'snooze', at(61));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.closed).toEqual([{ reminderId: r.id, recipientIds: ['dad'] }]);
    st = answer.state;
    const { ticks } = run(st, minutes(62, 95));
    const dad = ticks.map((t, i) => [62 + i, to(t.deliveries, 'dad').map(a => a.kind)] as const).filter(([, kinds]) => kinds.length);
    // The 70-minute attempt is swallowed by the snooze; at 71 one more; then the 80-minute attempt.
    expect(dad).toEqual([
      [71, ['reminder']],
      [80, ['reminder']]
    ]);
    expect(ticks.findIndex(t => to(t.deliveries, 'mom').some(a => a.kind === 'escalation')) + 62).toBe(90);
  });

  it('a removed item cancels its reminder and closes the open alerts', () => {
    let st = run(scene1(), minutes(0, 65)).state;
    st = change(st, { kind: 'cancel', itemId: 'pickup-today', version: item(st, 'pickup-today').version }, 'mom', at(66));
    const t = tickReminders(st, at(66));
    expect(t.closed).toHaveLength(1);
    expect(reminderOf(t.state, 'pickup-today').status).toBe('cancelled');
  });

  it('a reassignment before anything was sent moves the reminder to the new owner', () => {
    let st = tickReminders(scene1(), NOW).state;
    const id = reminderOf(st, 'pickup-today').id;
    st = change(st, { kind: 'assign', itemId: 'pickup-today', version: item(st, 'pickup-today').version, ownerId: 'maya' }, 'mom');
    const t = tickReminders(st, at(1));
    expect(t.state.reminders.filter(r => r.itemId === 'pickup-today')).toMatchObject([{ id, recipientIds: ['maya'], status: 'scheduled' }]);
    // A teen's critical item escalates to both parents ("the next person").
    const later = sent(run(t.state, minutes(2, 95)).ticks);
    expect(later.filter(d => d.alert.kind === 'escalation').map(d => d.recipientId).sort()).toEqual(['dad', 'mom']);
  });
});

describe('quiet hours and batching', () => {
  const dad = (st: HomemindState) => st.family.members.find(m => m.id === 'dad') as Member;

  it('knows the quiet hours, overnight included', () => {
    const st = seed();
    const local = (time: string) => Date.parse(`2026-11-04T${time}:00+08:00`);
    expect(inQuietHours(dad(st), local('22:30'), TZ)).toBe(true);
    expect(inQuietHours(dad(st), local('06:59'), TZ)).toBe(true);
    expect(inQuietHours(dad(st), local('07:00'), TZ)).toBe(false);
    expect(inQuietHours(dad(st), local('21:59'), TZ)).toBe(false);
    expect(new Date(quietHoursEnd(dad(st), local('22:30'), TZ)).toISOString()).toBe('2026-11-04T23:00:00.000Z');
  });

  it('a regular reminder during quiet hours waits for them to end; an urgent one does not', () => {
    // 23:00 local: inside Dad's quiet hours (22:00 to 07:00).
    const late = Date.parse('2026-11-04T15:00:00Z');
    const lateAt = (m: number) => late + m * MIN;
    let st = only(seed(), []);
    st = withItem(st, { id: 'night-call', start: new Date(lateAt(30)).toISOString(), end: new Date(lateAt(60)).toISOString(), ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } }, 0);
    st = withItem(st, { id: 'night-pickup', importance: 'critical', start: new Date(lateAt(60)).toISOString(), end: new Date(lateAt(90)).toISOString(), ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } }, 0);
    const t = tickReminders(st, lateAt(1));
    expect(t.deliveries.map(d => d.alert.itemId)).toEqual(['night-pickup']);
    expect(t.state.heldAlerts?.map(h => [h.recipientId, h.alert.itemId, h.releaseAt])).toEqual([['dad', 'night-call', '2026-11-04T23:00:00.000Z']]);
    // Released at 07:00 local, if it still applies.
    const morning = tickReminders(t.state, Date.parse('2026-11-04T23:00:00Z'));
    expect(morning.deliveries.map(d => d.alert.itemId)).toContain('night-call');
    expect(morning.state.heldAlerts).toEqual([]);
  });

  it('a held alert that no longer applies is dropped, not released', () => {
    const late = Date.parse('2026-11-04T15:00:00Z');
    let st = withItem(only(seed(), []), { id: 'night-call', start: new Date(late + 30 * MIN).toISOString(), ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } }, 0);
    st = tickReminders(st, late + MIN).state;
    st = change(st, { kind: 'confirm', itemId: 'night-call', version: item(st, 'night-call').version }, 'dad', late + 2 * MIN);
    const morning = tickReminders(st, Date.parse('2026-11-04T23:00:00Z'));
    expect(morning.deliveries).toEqual([]);
  });

  it('several small updates for one member in one tick become one alert', () => {
    let st = only(seed(), []);
    st = withItem(st, { id: 'one', title: 'One', ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } }, 30);
    st = withItem(st, { id: 'two', title: 'Two', titleZh: '二', ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } }, 30);
    const t = tickReminders(st, NOW);
    expect(t.deliveries).toHaveLength(1);
    expect(t.deliveries[0].alert).toMatchObject({ kind: 'batch', tier: 'timed', entries: [{ itemId: 'one', title: 'One' }, { itemId: 'two', title: 'Two', titleZh: '二' }] });
    expect(alertText(t.deliveries[0].alert, 'en')).toBe('2 updates: One, Two');
    expect(alertText(t.deliveries[0].alert, 'zh')).toBe('2 条更新：One、二');
  });

  it("a person's change goes through quiet hours too, unless the item is critical", () => {
    const late = Date.parse('2026-11-04T15:00:00Z');
    let st = withItem(only(seed(), []), { id: 'chore', start: new Date(late + 600 * MIN).toISOString() }, 0);
    st = withItem(st, { id: 'pickup-late', importance: 'critical', start: new Date(late + 600 * MIN).toISOString() }, 0);
    const before = st;
    st = change(st, { kind: 'assign', itemId: 'chore', version: 1, ownerId: 'dad' }, 'mom', late);
    st = change(st, { kind: 'assign', itemId: 'pickup-late', version: 1, ownerId: 'dad' }, 'mom', late);
    const alerts = alertsForChange(before, st, st.items.filter(i => i.id === 'chore' || i.id === 'pickup-late').map(i => ({ type: 'item.changed' as const, itemId: i.id, item: i })), 'mom', new Date(late).toISOString());
    expect(alerts.map(a => [a.alert.itemId, a.alert.tier])).toEqual([
      ['chore', 'timed'],
      ['pickup-late', 'urgent']
    ]);
    const routed = routeAlerts(st, alerts, late);
    expect(routed.send.map(d => d.alert.itemId)).toEqual(['pickup-late']);
    expect(routed.held.map(h => h.alert.itemId)).toEqual(['chore']);
  });

  it('the change alert to the owner replaces that tick\'s reminder alert about the same item', () => {
    const st = withItem(only(seed(), []), { id: 'soon', importance: 'critical' }, 20);
    const after = change(st, { kind: 'assign', itemId: 'soon', version: 1, ownerId: 'dad' }, 'mom');
    const alerts = alertsForChange(st, after, [{ type: 'item.changed', itemId: 'soon', item: item(after, 'soon') }], 'mom', new Date(NOW).toISOString());
    const t = tickReminders(after, NOW, alerts);
    expect(to(t.deliveries, 'dad').map(a => a.kind)).toEqual(['assigned']);
    expect(reminderOf(t.state, 'soon').attempts).toBe(1);
  });
});

describe('privacy', () => {
  it('a Parents-only, sensitive item reminds only parents, with no title and no time', () => {
    const st = only(seed(), ['counselor-meeting']);
    const start = Date.parse(item(st, 'counselor-meeting').start as string);
    const { ticks } = (() => {
      const out: TickResult[] = [];
      let s = st;
      for (let m = -70; m <= 10; m++) {
        const t = tickReminders(s, start + m * MIN);
        out.push(t);
        s = t.state;
      }
      return { ticks: out };
    })();
    const all = sent(ticks);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(d => d.recipientId === 'mom' || d.recipientId === 'dad')).toBe(true);
    for (const d of all) {
      expect(d.alert.title).toBeUndefined();
      expect(d.alert.time).toBeUndefined();
      expect(alertText(d.alert, 'en')).toBe('You have a reminder');
    }
  });
});

describe('alert wording and buttons', () => {
  const base = { id: 'rem-1.a1', itemId: 'pickup-today', itemVersion: 3, tier: 'urgent' as const, at: '2026-11-04T10:00:00.000Z', byId: 'homemind', byName: 'Homemind', title: 'Kindergarten pickup', titleZh: '幼儿园接孩子', sensitive: false, reminderId: 'rem-1', time: '19:00' };

  it('escalation wording is neutral: what is waiting, never who did not answer', () => {
    const escalation = { ...base, kind: 'escalation' as const, ask: 'confirm' as const };
    expect(alertText(escalation, 'en')).toBe('Kindergarten pickup at 19:00 is not confirmed yet.');
    expect(alertText(escalation, 'zh')).toBe('19:00 的「幼儿园接孩子」还没有确认。');
    expect(alertText({ ...escalation, ask: 'open' }, 'en')).toBe('Kindergarten pickup at 19:00 is still open.');
    for (const lang of ['en', 'zh'] as const) {
      for (const ask of ['confirm', 'open'] as const) {
        const text = alertText({ ...escalation, ask }, lang);
        for (const blame of ['Dad', 'Mom', '爸爸', '妈妈', "didn't", 'did not', 'no answer', '没回', '没有回复']) expect(text).not.toContain(blame);
      }
    }
  });

  it('the responses: Done, I\'m on it, Hand off, Remind me later', () => {
    expect(alertButtons({ ...base, kind: 'reminder', ask: 'confirm' }, 'en').map(b => b.verb)).toEqual(['ack', 'handback', 'snooze', 'open']);
    expect(alertButtons({ ...base, kind: 'reminder', ask: 'heads-up' }, 'en').map(b => b.label)).toEqual(['Done', 'Got it', 'Remind me later', 'Open']);
    expect(alertButtons({ ...base, kind: 'reminder', ask: 'heads-up', recurring: true }, 'en').map(b => b.verb)).not.toContain('done');
    expect(alertButtons({ ...base, kind: 'escalation', ask: 'confirm' }, 'zh').map(b => b.label)).toEqual(['我来', '知道了', '查看']);
    expect(alertButtons({ ...base, kind: 'escalation', ask: 'confirm' }, 'en')[0].verb).toBe('take');
  });

  it('the backup notice says it was simulated', () => {
    const notice = { ...base, kind: 'backup' as const, ask: 'confirm' as const, contactName: 'Grandma Lin', contactNameZh: '林奶奶', simulated: true };
    expect(alertText(notice, 'en')).toBe('Grandma Lin was sent a short message to get in touch. (Simulated)');
    expect(alertText(notice, 'zh')).toContain('（模拟）');
  });

  it('an escalation closes in the window once someone confirmed; any answer closes a reminder\'s alerts', () => {
    const st = scene1();
    const pickup = item(st, 'pickup-today');
    const escalation = { ...base, kind: 'escalation' as const, ask: 'confirm' as const };
    expect(stillRelevant(escalation, pickup, 'mom')).toBe(true);
    expect(stillRelevant(escalation, { ...pickup, ownership: { state: 'assigned', ownerId: 'dad', confirmed: true } }, 'mom')).toBe(false);
    expect(closeReminder([escalation, { ...base, id: 'x', reminderId: 'rem-2', kind: 'reminder', ask: 'open' }], 'rem-1').map(a => a.reminderId)).toEqual(['rem-2']);
  });
});

describe('the scheduler', () => {
  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  it('runs one loop per process: starting it again swaps the task, it does not add a timer', async () => {
    vi.useFakeTimers();
    let first = 0;
    let second = 0;
    startScheduler(() => {
      first++;
    }, 5000);
    startScheduler(() => {
      second++;
    }, 5000);
    expect(schedulerRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first).toBe(0);
    expect(second).toBe(3);
    stopScheduler();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(second).toBe(3);
    expect(schedulerRunning()).toBe(false);
  });

  it('never overlaps a slow tick, and goes on after a failing one', async () => {
    vi.useFakeTimers();
    let running = 0;
    let most = 0;
    let calls = 0;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    startScheduler(async () => {
      calls++;
      running++;
      most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, 12_000));
      running--;
      if (calls === 1) throw new Error('boom');
    }, 5000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(most).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    await tickSchedulerNow();
  });
});
