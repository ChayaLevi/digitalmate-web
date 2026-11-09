import { describe, expect, it } from 'vitest';
import { executeAction, issueConfirmation } from '../server/homemind/actions';
import type { StateRef } from '../server/homemind/actions';
import { planChat } from '../server/homemind/chat';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import type { NewItem } from '../server/homemind/core';
import { createSimulatedAdapters, servicesViewFor } from '../server/homemind/fakes';
import { seedState } from '../server/homemind/seed';
import { applySuggestions, dismissSuggestion, situationsView, startSituation, undoSuggestion } from '../server/homemind/situations';
import type { SituationReport } from '../server/homemind/situations';
import type { HomemindState } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import type { MemberView } from '../server/homemind/visibility';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import { chatTurn, screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindViewData } from '../src/lib/homemindSurfaces';

const ZONE = 'Asia/Shanghai';
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi); // Shanghai local
const MON_10 = at(2026, 11, 9, 10);
const SAT_10 = at(2026, 11, 14, 10);
const TODAY = '2026-11-09';
const KEY = 'test-key-0123456789';
const iso = (ms: number) => new Date(ms).toISOString();

const sick = (memberId = 'noa', date = TODAY): SituationReport => ({ kind: 'sick', memberId, date, summary: `${memberId} has a fever` });

function holder(state: HomemindState, now: number) {
  const box = { state, now };
  const adapters = createSimulatedAdapters({ get: () => box.state, set: s => void (box.state = s), now: () => box.now });
  const ref: StateRef = { get: () => box.state, set: s => void (box.state = s) };
  return { box, adapters, ref };
}

function start(state: HomemindState, reporter = 'mom', report = sick(), now = MON_10, mayWrite = true) {
  const { adapters } = holder(state, now);
  const result = startSituation(state, reporter, report, { now, clock: fixedClock(now), adapters, mayWrite });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

function add(state: HomemindState, item: NewItem, actor = 'mom', now = MON_10): HomemindState {
  const r = applyChange(state, { kind: 'create', item }, actor, fixedClock(now));
  if (!r.ok) throw new Error(r.message);
  return r.state;
}

/** An all-day event today that makes `who` away. */
const awayToday = (who: string[], extra: Partial<NewItem> = {}): NewItem => ({
  type: 'event',
  title: 'Wedding',
  start: iso(at(2026, 11, 9, 0)),
  end: iso(at(2026, 11, 10, 0)),
  allDay: true,
  unavailableMemberIds: who,
  ...extra
});

describe('a day gone wrong: what falls through (T8.1)', () => {
  it('Noa is sick: pickup not needed, swimming postponed a week, a stay-home task for the free parents, a teacher draft behind a tap', () => {
    const r = start(seedState({ now: MON_10, timezone: ZONE }));
    expect(r.created).toBe(true);
    const s = r.situation;
    expect(s.proposals.map(p => [p.kind, p.itemId])).toEqual([
      ['cancel', 'pickup-today'],
      ['postpone', 'swim-today']
    ]);
    // Same local time a week later.
    const swim = r.state.items.find(i => i.id === 'swim-today');
    expect(s.proposals[1].newStart).toBe(iso(Date.parse(swim?.start as string) + 7 * 24 * HOUR));
    // Nothing on the board changed except the new task.
    expect(r.state.items.find(i => i.id === 'pickup-today')?.status).toBe('open');
    expect(swim?.version).toBe(1);
    const task = r.state.items.find(i => i.id === s.stayHomeItemId);
    expect(task).toMatchObject({ type: 'task', title: 'Stay home with Noa', titleZh: '在家照顾诺娅', status: 'open', allDay: true, forMemberIds: ['noa'] });
    expect(task?.ownership).toEqual({ state: 'open', candidateIds: ['mom', 'dad'] });
    expect(s.available).toEqual(['mom', 'dad']);
    expect(r.events.map(e => e.itemId)).toEqual([s.stayHomeItemId]);
    // The teacher message: a pending simulated card, Chinese, no symptoms, never on its own.
    expect(s.cardIds).toEqual([`${s.id}-teacher`]);
    const card = r.state.actionCards.find(c => c.id === s.cardIds[0]);
    expect(card).toMatchObject({ adapter: 'teacher-message', mode: 'simulated', status: 'pending', area: 'childcare' });
    expect(card?.payload.text).toBe('王老师您好！诺娅今天身体不舒服，在家休息，不来幼儿园了。谢谢！——诺娅妈妈');
    expect(Date.parse(card?.expiresAt as string)).toBeLessThan(at(2026, 11, 10, 0));
    // Homemind's own reason, from rules, never the model's or PPMA's.
    const why = r.state.whys.find(w => w.id === s.whyId);
    expect(why?.source).toBe('rule');
    expect(why?.summary).toContain('fixed rules (the model only read the message)');
    expect(why?.summary).toContain('Homemind does not choose between them');
    expect(why?.summaryZh).toContain('Homemind 不替他们选');
  });

  it('cross-checks who is away: only the free parent is asked; with both away, a daytime babysitter draft', () => {
    const one = add(seedState({ now: MON_10, timezone: ZONE }), awayToday(['mom']));
    const r1 = start(one);
    expect(r1.situation.available).toEqual(['dad']);
    expect(r1.situation.away).toMatchObject([{ memberId: 'mom' }]);
    expect(r1.state.items.find(i => i.id === r1.situation.stayHomeItemId)?.ownership).toEqual({ state: 'open', candidateIds: ['dad'] });
    expect(r1.situation.cardIds).toHaveLength(1);

    const both = add(seedState({ now: MON_10, timezone: ZONE }), awayToday(['mom', 'dad']));
    const r2 = start(both);
    expect(r2.situation.available).toEqual([]);
    // Nobody is free: both parents are asked anyway (Homemind never decides), and a sitter draft waits for a tap.
    expect(r2.state.items.find(i => i.id === r2.situation.stayHomeItemId)?.ownership).toEqual({ state: 'open', candidateIds: ['mom', 'dad'] });
    const sitter = r2.state.actionCards.find(c => c.id === `${r2.situation.id}-sitter`);
    expect(sitter).toMatchObject({ adapter: 'babysitter', mode: 'simulated', status: 'pending' });
    expect(sitter?.payload).toMatchObject({ sitterId: 'sitter-li', date: TODAY, from: '10:00', to: '17:00' });
    expect(String(sitter?.payload.text)).not.toMatch(/sick|生病|wedding|婚礼/i);
  });

  it('a weekly event is skipped once; something the sick member owned becomes "Who\'s taking this?"', () => {
    let state = add(seedState({ now: MON_10, timezone: ZONE }), {
      type: 'event',
      title: "Noa's ballet",
      start: iso(at(2026, 11, 9, 16)),
      end: iso(at(2026, 11, 9, 17)),
      forMemberIds: ['noa'],
      recurrence: { freq: 'weekly', byWeekday: [1] }
    } as NewItem);
    const r = start(state);
    const ballet = r.situation.proposals.find(p => p.kind === 'skip');
    expect(ballet).toMatchObject({ date: TODAY });

    // Mom is sick: her swimming duty is opened to the others; no stay-home task and no teacher message for a parent.
    state = seedState({ now: MON_10, timezone: ZONE });
    const m = start(state, 'mom', sick('mom'));
    expect(m.situation.proposals).toEqual([expect.objectContaining({ kind: 'open', itemId: 'swim-today', candidateIds: ['dad', 'maya'] })]);
    expect(m.situation.stayHomeItemId).toBeUndefined();
    expect(m.situation.cardIds).toEqual([]);
  });

  it('only the rest of the day counts, no teacher message on a weekend, and a day that is over is refused', () => {
    const state = seedState({ now: MON_10, timezone: ZONE });
    // At 13:30 the pickup (12:00) and the start of swimming (13:00) are behind: nothing to change.
    const later = start(state, 'mom', sick(), MON_10 + 3.5 * HOUR);
    expect(later.situation.proposals).toEqual([]);

    const weekend = start(seedState({ now: SAT_10, timezone: ZONE }), 'mom', sick('noa', '2026-11-14'), SAT_10);
    expect(weekend.situation.cardIds).toEqual([]);

    const { adapters } = holder(state, MON_10);
    expect(startSituation(state, 'mom', sick('noa', '2026-11-08'), { now: MON_10, clock: fixedClock(MON_10), adapters, mayWrite: true })).toMatchObject({ ok: false, code: 'past' });
    expect(startSituation(state, 'mom', sick('noa', '2026-11-30'), { now: MON_10, clock: fixedClock(MON_10), adapters, mayWrite: true })).toMatchObject({ ok: false, code: 'too_far' });
    expect(startSituation(state, 'noa', sick(), { now: MON_10, clock: fixedClock(MON_10), adapters, mayWrite: true })).toMatchObject({ ok: false, status: 403 });
  });

  it('the same member and day reported twice gives the same situation, nothing new; at level 1 the task is only proposed', () => {
    const first = start(seedState({ now: MON_10, timezone: ZONE }));
    const again = start(first.state, 'dad');
    expect(again.created).toBe(false);
    expect(again.situation.id).toBe(first.situation.id);
    expect(again.state).toBe(first.state);

    const proposed = start(seedState({ now: MON_10, timezone: ZONE }), 'mom', sick(), MON_10, false);
    expect(proposed.state.items.find(i => i.id === proposed.situation.stayHomeItemId)?.status).toBe('proposed');
  });
});

describe('a day gone wrong: deciding (T8.1)', () => {
  it('Apply cancels the pickup, Undo puts it back and the suggestion waits again', () => {
    const r = start(seedState({ now: MON_10, timezone: ZONE }));
    const clock = fixedClock(MON_10 + MIN);
    const applied = applySuggestions(r.state, r.situation.id, 'p1', 'dad', clock);
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.state.items.find(i => i.id === 'pickup-today')?.status).toBe('cancelled');
    expect(applied.situation.proposals[0]).toMatchObject({ status: 'applied', by: 'dad' });
    expect(applied.activityIds).toHaveLength(1);
    expect(applySuggestions(applied.state, r.situation.id, 'p1', 'dad', clock)).toMatchObject({ ok: false, code: 'decided' });

    const undone = undoSuggestion(applied.state, r.situation.id, 'p1', 'dad', clock);
    if (!undone.ok) throw new Error(undone.message);
    expect(undone.state.items.find(i => i.id === 'pickup-today')?.status).toBe('open');
    expect(undone.situation.proposals[0]).toEqual({ id: 'p1', kind: 'cancel', itemId: 'pickup-today', start: r.situation.proposals[0].start, status: 'pending' });
  });

  it('Apply all moves swimming a week and cancels the pickup, each with its own Undo; a moved item is not touched', () => {
    const r = start(seedState({ now: MON_10, timezone: ZONE }));
    const clock = fixedClock(MON_10 + MIN);
    const all = applySuggestions(r.state, r.situation.id, 'all', 'mom', clock);
    if (!all.ok) throw new Error(all.message);
    expect(all.applied).toEqual(['p1', 'p2']);
    expect(new Set(all.activityIds).size).toBe(2);
    const swim = all.state.items.find(i => i.id === 'swim-today');
    expect(swim?.start).toBe(r.situation.proposals[1].newStart);
    expect(swim?.end).toBe(r.situation.proposals[1].newEnd);
    expect(applySuggestions(all.state, r.situation.id, 'all', 'mom', clock)).toMatchObject({ ok: false, code: 'nothing_waiting' });

    // Someone moved swimming by hand after the report: Apply refuses and shows the latest.
    const swimNow = r.state.items.find(i => i.id === 'swim-today');
    const moved = applyChange(r.state, { kind: 'edit', itemId: 'swim-today', version: swimNow?.version as number, patch: { start: iso(MON_10 + 5 * HOUR), end: iso(MON_10 + 6 * HOUR) } }, 'mom', clock);
    if (!moved.ok) throw new Error(moved.message);
    expect(applySuggestions(moved.state, r.situation.id, 'p2', 'mom', clock)).toMatchObject({ ok: false, status: 409, code: 'changed' });
    const partly = applySuggestions(moved.state, r.situation.id, 'all', 'mom', clock);
    expect(partly).toMatchObject({ ok: true, applied: ['p1'], failed: [{ proposalId: 'p2', code: 'changed' }] });
  });

  it('Not now changes nothing on the board, and Undo brings the suggestion back', () => {
    const r = start(seedState({ now: MON_10, timezone: ZONE }));
    const dismissed = dismissSuggestion(r.state, r.situation.id, 'p2', 'mom', MON_10 + MIN);
    if (!dismissed.ok) throw new Error(dismissed.message);
    expect(dismissed.state.items).toBe(r.state.items);
    expect(dismissed.situation.proposals[1].status).toBe('dismissed');
    const back = undoSuggestion(dismissed.state, r.situation.id, 'p2', 'mom', fixedClock(MON_10 + MIN));
    expect(back).toMatchObject({ ok: true });
    if (back.ok) expect(back.situation.proposals[1].status).toBe('pending');
    expect(undoSuggestion(r.state, r.situation.id, 'p2', 'mom', fixedClock(MON_10))).toMatchObject({ ok: false, code: 'nothing_to_undo' });
    expect(applySuggestions(r.state, 'no-such', 'p1', 'mom', fixedClock(MON_10))).toMatchObject({ ok: false, status: 404 });
  });

  it('the teacher message runs only with a parent tap, and lands in the simulated services with a canned answer', async () => {
    const r = start(seedState({ now: MON_10, timezone: ZONE }));
    const h = holder(r.state, MON_10 + MIN);
    const cardId = r.situation.cardIds[0];
    expect(await executeAction(h.ref, cardId, { kind: 'auto' }, { adapters: h.adapters, key: KEY, now: () => h.box.now })).toMatchObject({ ok: false, code: 'auto_not_allowed' });
    expect(issueConfirmation(h.box.state, cardId, 'maya', { key: KEY, now: h.box.now }, h.adapters)).toMatchObject({ ok: false });
    const issued = issueConfirmation(h.box.state, cardId, 'dad', { key: KEY, now: h.box.now }, h.adapters);
    if (!issued.ok) throw new Error('token');
    const ran = await executeAction(h.ref, cardId, { kind: 'tap', memberId: 'dad', token: issued.token }, { adapters: h.adapters, key: KEY, now: () => h.box.now });
    expect(ran).toMatchObject({ ok: true });
    const teacher = servicesViewFor(h.box.state, 'mom', h.box.now).teacher;
    expect(teacher).toMatchObject({ name: 'Teacher Wang', simulated: true });
    expect(teacher?.messages).toEqual([expect.objectContaining({ childId: 'noa', author: '诺娅妈妈', reply: '收到，谢谢告知！祝孩子早日康复。', simulated: true })]);
  });
});

describe('a day gone wrong: privacy (T8.1)', () => {
  /** A Parents-only doctor visit for Noa today, and a Parents-only event that makes Mom away. */
  function withSecrets(): HomemindState {
    let state = add(seedState({ now: MON_10, timezone: ZONE }), {
      type: 'event',
      title: 'Doctor about the allergy test',
      start: iso(at(2026, 11, 9, 15)),
      end: iso(at(2026, 11, 9, 16)),
      forMemberIds: ['noa'],
      visibility: 'parents',
      sensitive: true
    });
    state = add(state, awayToday(['mom'], { title: 'Therapy day', visibility: 'parents', sensitive: true }));
    return state;
  }

  it("a teen's report has no trace of Parents-only items; a parent's report does, and the teen still sees none of it", () => {
    const state = withSecrets();
    const byMaya = start(state, 'maya');
    expect(byMaya.situation.proposals.map(p => p.itemId)).toEqual(['pickup-today', 'swim-today']);
    // Maya can't know Mom is away: both parents are asked, with no reason given.
    expect(byMaya.situation.away).toEqual([]);
    expect(JSON.stringify(byMaya.state.whys.find(w => w.id === byMaya.situation.whyId))).not.toMatch(/Doctor|Therapy|away:/);

    const byMom = start(state, 'mom');
    const doctor = byMom.state.items.find(i => i.title === 'Doctor about the allergy test');
    expect(byMom.situation.proposals.map(p => p.itemId)).toContain(doctor?.id);
    expect(byMom.situation.away).toHaveLength(1);
    const [forMaya] = situationsView(byMom.state, 'maya', MON_10);
    expect(JSON.stringify(forMaya)).not.toMatch(/Doctor|Therapy/);
    expect(forMaya.situation.proposals.map(p => p.itemId)).toEqual(['pickup-today', 'swim-today']);
    expect(forMaya.situation.away).toEqual([]);
    expect(forMaya.situation.summary).toBe('');
    // The Why names hidden items, so a teen does not get it at all.
    expect(viewFor(byMom.state, 'maya')?.whys.some(w => w.id === byMom.situation.whyId)).toBe(false);
    // And a teen can't act on a suggestion about a hidden item.
    const hidden = byMom.situation.proposals.find(p => p.itemId === doctor?.id);
    expect(applySuggestions(byMom.state, byMom.situation.id, hidden?.id as string, 'maya', fixedClock(MON_10))).toMatchObject({ ok: false, status: 404 });
    expect(dismissSuggestion(byMom.state, byMom.situation.id, hidden?.id as string, 'maya', MON_10)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('a day gone wrong: chat and screens (T8.1)', () => {
  it('chat: "sick" plans a situation (nobody named: the member who wrote); other situations are not built', () => {
    const view = viewFor(seedState({ now: MON_10, timezone: ZONE }), 'dad') as MemberView;
    expect(planChat(view, { intent: 'report_situation', situation: 'sick', memberId: 'noa', date: TODAY, summary: 'Noa is sick' })).toEqual({ kind: 'situation', memberId: 'noa', date: TODAY, summary: 'Noa is sick' });
    expect(planChat(view, { intent: 'report_situation', situation: 'sick', date: TODAY, summary: "I'm sick" })).toMatchObject({ kind: 'situation', memberId: 'dad' });
    expect(planChat(view, { intent: 'report_situation', situation: 'late', date: TODAY, summary: 'late' })).toMatchObject({ kind: 'later' });
  });

  it('My day and the chat card show it in both languages, with Apply / Not now, and Undo once decided', () => {
    const r = start(seedState({ now: MON_10, timezone: ZONE }));
    const screen = (state: HomemindState, memberId: string, lang: 'en' | 'zh') => {
      const turn = screenTurn('my-day', { lang, now: iso(MON_10), view: viewFor(state, memberId) as unknown as HomemindViewData, situations: situationsView(state, memberId, MON_10) });
      expect(A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0]).toBeDefined();
      return turn.jsonl;
    };
    const en = screen(r.state, 'dad', 'en');
    expect(en).toContain('Noa is sick today');
    expect(en).toContain('Reported by Mom');
    expect(en).toContain('Who could stay home');
    expect(en).toContain('Not marked away that day');
    expect(en).toContain('Stay home with Noa');
    expect(en).toContain('Not needed: Noa stays home');
    expect(en).toContain('Postpone a week, to Mon 11/16 13:00');
    expect(en).toContain('Apply all (2)');
    expect(en).toContain('"verb":"situation"');
    expect(en).toContain('"verb":"claim"');
    expect(en).toContain('Waiting for your tap');
    const zh = screen(r.state, 'dad', 'zh');
    expect(zh).toContain('诺娅今天生病了');
    expect(zh).toContain('不需要了：诺娅在家');
    expect(zh).toContain('在家照顾诺娅');

    const applied = applySuggestions(r.state, r.situation.id, 'p1', 'dad', fixedClock(MON_10 + MIN));
    if (!applied.ok) throw new Error(applied.message);
    const after = screen(applied.state, 'mom', 'en');
    expect(after).toContain('Done by Dad');
    expect(after).toContain('"action":"undo"');
    // A teen sees the situation but no teacher card (only parents confirm).
    expect(screen(r.state, 'maya', 'en')).not.toContain('Waiting for your tap');

    const chat = chatTurn({
      lang: 'en',
      now: iso(MON_10),
      view: viewFor(r.state, 'mom') as unknown as HomemindViewData,
      llm: 'fake',
      turnId: 't1',
      outcome: { kind: 'situation', situationId: r.situation.id, created: true, ...(r.created && r.activityId ? { activityId: r.activityId } : {}) },
      situations: situationsView(r.state, 'mom', MON_10)
    });
    expect(A2uiSurfaceStore.fromJsonl(chat.jsonl).list()[0]).toBeDefined();
    expect(chat.message).toContain('Nothing is cancelled or moved until someone taps');
    expect(chat.jsonl).toContain('Undo the stay-home task');
    expect(chat.jsonl).toContain('Simulated model');
  });
});
