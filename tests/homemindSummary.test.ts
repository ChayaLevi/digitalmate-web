import { describe, expect, it } from 'vitest';
import { applyChange } from '../server/homemind/core';
import { fixedClock } from '../server/homemind/clock';
import { GROUP_FIXTURE, KINDERGARTEN_GROUP, postNextGroupMessage, servicesViewFor } from '../server/homemind/fakes';
import { judgeMessage, judgeText, waitingForSummary } from '../server/homemind/judgment';
import { tickReminders } from '../server/homemind/reminders';
import { seedState } from '../server/homemind/seed';
import { lastSummaryAt, summaryFor, tickSummaries } from '../server/homemind/summary';
import type { GroupMessage, HomemindAlert, HomemindState } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { alertButtons, alertText, alertTitle, addAlert, applyItemChange } from '../src/lib/homemindAlerts';
import { screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindViewData } from '../src/lib/homemindSurfaces';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import { toAlert } from '../src/transport/homemindEvents';

const ZONE = 'Asia/Shanghai';
const MIN = 60_000;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi); // Shanghai local
const MON_10 = at(2026, 11, 9, 10);
const MON_20 = at(2026, 11, 9, 20);
const iso = (ms: number) => new Date(ms).toISOString();

const seed = (now = MON_10) => seedState({ now, timezone: ZONE });

/** Posts the fixture messages in order (the demo control), up to and including `upTo` (1-based). */
function post(state: HomemindState, upTo: number, now = MON_10): { state: HomemindState; messages: GroupMessage[] } {
  const messages: GroupMessage[] = [];
  let current = state;
  for (let n = 0; n < upTo; n++) {
    const r = postNextGroupMessage(current, now);
    if (!r.ok) throw new Error(r.message);
    current = r.state;
    messages.push(r.message);
  }
  return { state: current, messages };
}

function judgeAll(state: HomemindState, messages: GroupMessage[], now = MON_10) {
  let current = state;
  const deliveries = [];
  for (const m of messages) {
    const r = judgeMessage(current, m, KINDERGARTEN_GROUP.id, now);
    if (!r) continue;
    current = r.state;
    deliveries.push(...r.deliveries);
  }
  return { state: current, deliveries };
}

describe('judgment: the tier of a group message, by fixed rules (T8.2)', () => {
  it('reads the three sample messages: the party this week now, the sign-up now, the "不着急" note for the summary', () => {
    expect(GROUP_FIXTURE.map(m => judgeText(m.text))).toEqual([
      { tier: 'timed', reason: 'soon', quote: '本周' },
      { tier: 'timed', reason: 'sign-up', quote: '#接龙' },
      { tier: 'summary', reason: 'not-urgent', quote: '不着急' }
    ]);
  });

  it('urgent words win, the sender’s "no rush" wins over a date, next week waits, and no date waits', () => {
    expect(judgeText('明天停课，请家长注意')).toMatchObject({ tier: 'urgent', reason: 'urgent-words', quote: '停课' });
    expect(judgeText('Pickup moved to 3pm, urgent!')).toMatchObject({ tier: 'urgent', reason: 'urgent-words' });
    expect(judgeText('Photos from today are up')).toMatchObject({ tier: 'timed', reason: 'soon', quote: 'today' });
    expect(judgeText('Bring a hat on Friday')).toMatchObject({ tier: 'timed', reason: 'soon', quote: 'Friday' });
    expect(judgeText('下周三交作品，不急')).toMatchObject({ tier: 'summary', reason: 'not-urgent', quote: '不急' });
    expect(judgeText('下周一前请把回执交回')).toMatchObject({ tier: 'summary', reason: 'next-week', quote: '下周' });
    expect(judgeText('谢谢大家的配合')).toEqual({ tier: 'summary', reason: 'no-date' });
  });

  it('alerts the parents only, and only for what should be seen now; the summary one waits for 20:00', () => {
    const { state, messages } = post(seed(), 3);
    const first = judgeMessage(state, messages[0], KINDERGARTEN_GROUP.id, MON_10);
    expect(first?.judgment).toMatchObject({ id: 'jdg-grp-msg-1-v1', tier: 'timed', reason: 'soon', alertedIds: ['mom', 'dad'] });
    expect(first?.deliveries.map(d => d.recipientId)).toEqual(['mom', 'dad']);
    expect(first?.deliveries[0].alert).toMatchObject({ kind: 'message', itemId: 'grp-msg-1', tier: 'timed', messageAuthor: 'Teacher Wang', messageAuthorZh: '王老师', judgmentReason: 'soon', simulated: true, sensitive: false });

    const note = judgeMessage(state, messages[2], KINDERGARTEN_GROUP.id, MON_10);
    expect(note?.deliveries).toEqual([]);
    expect(note?.judgment).toMatchObject({ tier: 'summary', reason: 'not-urgent', quote: '不着急', summaryAt: iso(MON_20) });
    expect(note && waitingForSummary(note.state).map(j => j.messageId)).toEqual(['grp-msg-3']);
  });

  it('a sign-up the claim rules already told the family about gets no second alert; a family reply is not judged; a repeat sends nothing', () => {
    const { state, messages } = post(seed(), 2);
    const handled = judgeMessage(state, messages[1], KINDERGARTEN_GROUP.id, MON_10, true);
    expect(handled?.deliveries).toEqual([]);
    expect(handled?.judgment).toMatchObject({ tier: 'timed', reason: 'sign-up', handledBy: 'group-claim', alertedIds: [] });
    expect(judgeMessage(state, { ...messages[1], id: 'grp-reply-1', from: 'family' }, KINDERGARTEN_GROUP.id, MON_10)).toBeNull();
    const again = handled && judgeMessage(handled.state, messages[1], KINDERGARTEN_GROUP.id, MON_10 + MIN);
    expect(again?.deliveries).toEqual([]);
    expect(again?.state.messageJudgments).toHaveLength(1);
  });

  it('message alerts are held by quiet hours and released after, never batched with item alerts', () => {
    const late = at(2026, 11, 9, 23);
    const { state, messages } = post(seed(MON_10), 1, late);
    const judged = judgeMessage(state, messages[0], KINDERGARTEN_GROUP.id, late);
    if (!judged) throw new Error('not judged');
    const held = tickReminders(judged.state, late, judged.deliveries);
    expect(held.deliveries).toEqual([]);
    expect(held.state.heldAlerts?.map(h => h.recipientId)).toEqual(['mom', 'dad']);
    const morning = tickReminders(held.state, at(2026, 11, 10, 7, 1));
    expect(morning.deliveries.filter(d => d.alert.kind === 'message').map(d => d.recipientId).sort()).toEqual(['dad', 'mom']);

    // In daytime, with an item alert for the same member at once: two alerts, not one batch.
    const day = judgeMessage(post(seed(), 1).state, messages[0], KINDERGARTEN_GROUP.id, MON_10);
    const itemAlert: HomemindAlert = { id: 'x', kind: 'open', itemId: 'library-books', itemVersion: 1, tier: 'timed', at: iso(MON_10), byId: 'dad', byName: 'Dad', sensitive: false, title: 'Return the library books' };
    const routed = tickReminders(day?.state as HomemindState, MON_10, [...(day?.deliveries ?? []), { recipientId: 'mom', alert: itemAlert }]);
    expect(routed.deliveries.filter(d => d.recipientId === 'mom').map(d => d.alert.kind).sort()).toEqual(['message', 'open']);
  });
});

describe('summaries: what goes in, for whom, and in what order (T8.2)', () => {
  it('Mom’s evening summary: what she needs to do first (hers, "Who\'s taking this?"), then events for everyone', () => {
    const v = summaryFor(seed(), 'mom', 'daily', MON_10);
    expect(v).toMatchObject({ kind: 'daily', date: '2026-11-09', from: '2026-11-09', to: '2026-11-10', scheduledAt: iso(MON_20) });
    expect(v?.deliveredAt).toBeUndefined();
    expect(v?.toDo.map(t => [t.itemId, t.why])).toEqual([
      ['pickup-today', 'asked'],
      ['swim-today', 'owner'],
      ['library-books', 'asked'],
      ['pickup-tuesday', 'owner']
    ]);
    expect(v?.everyone.map(e => e.itemId)).toEqual(['piano-tomorrow']);
    // Wednesday's Parents-only meeting is outside tonight's summary.
    expect(JSON.stringify(v)).not.toContain('counselor');
  });

  it('the week ahead: a parent sees the Parents-only meeting under her own to-dos; a teen gets no trace of it', () => {
    const mom = summaryFor(seed(), 'mom', 'weekly', MON_10);
    expect(mom).toMatchObject({ kind: 'weekly', from: '2026-11-10', to: '2026-11-16' });
    // The week ahead goes out on Sunday evening (the family's week starts on Monday).
    expect(mom?.scheduledAt).toBe(iso(at(2026, 11, 15, 20)));
    expect(mom?.toDo.map(t => t.itemId)).toContain('counselor-meeting');
    expect(mom?.everyone.map(e => e.itemId)).toEqual(expect.arrayContaining(['piano-tomorrow', 'family-dinner']));
    const maya = summaryFor(seed(), 'maya', 'weekly', MON_10);
    expect(JSON.stringify(maya)).not.toContain('counselor');
    expect(maya?.messages).toEqual([]);
  });

  it('who is away comes from events the member can see', () => {
    const r = applyChange(
      seed(),
      { kind: 'create', item: { type: 'event', title: 'Wedding', start: iso(at(2026, 11, 10, 9)), end: iso(at(2026, 11, 10, 23)), forMemberIds: ['mom'], unavailableMemberIds: ['mom'], visibility: 'parents' } },
      'mom',
      fixedClock(MON_10)
    );
    if (!r.ok) throw new Error(r.message);
    expect(summaryFor(r.state, 'dad', 'daily', MON_10)?.away.map(a => a.memberId)).toEqual(['mom']);
    expect(summaryFor(r.state, 'maya', 'daily', MON_10)?.away).toEqual([]);
  });

  it('goes out once when a tick crosses 20:00, with the messages that waited, to everyone with an account', () => {
    const { state, messages } = post(seed(), 3);
    let current = judgeAll(state, messages).state;
    expect(tickSummaries(current, at(2026, 11, 9, 19, 59)).changed).toBe(false);
    const sent = tickSummaries(current, at(2026, 11, 9, 20, 1));
    expect(sent.sent).toMatchObject({ id: 'sum-2026-11-09', date: '2026-11-09', weekAhead: false });
    expect(sent.deliveries.map(d => d.recipientId)).toEqual(['mom', 'dad', 'maya']);
    const momAlert = sent.deliveries.find(d => d.recipientId === 'mom')?.alert;
    expect(momAlert).toMatchObject({ id: 'sum-2026-11-09', kind: 'summary', itemId: 'sum-2026-11-09', tier: 'timed', summaryMessages: 1 });
    expect(sent.deliveries.find(d => d.recipientId === 'maya')?.alert.summaryMessages).toBe(0);
    current = sent.state;
    expect(current.messageJudgments?.find(j => j.messageId === 'grp-msg-3')?.deliveredIn).toBe('sum-2026-11-09');
    expect(waitingForSummary(current)).toEqual([]);

    const mom = summaryFor(current, 'mom', 'daily', at(2026, 11, 9, 20, 2));
    expect(mom?.deliveredAt).toBe(iso(at(2026, 11, 9, 20, 1)));
    expect(mom?.messages.map(m => [m.message.id, m.judgment.reason])).toEqual([['grp-msg-3', 'not-urgent']]);
    // The messages shown now never wait for the summary.
    expect(mom?.messages.map(m => m.message.id)).not.toContain('grp-msg-1');
    expect(summaryFor(current, 'maya', 'daily', at(2026, 11, 9, 20, 2))?.messages).toEqual([]);

    // Not twice the same evening.
    expect(tickSummaries(current, at(2026, 11, 9, 20, 30)).deliveries).toEqual([]);
  });

  it('never sends a summary for a 20:00 that passed before the state was made, and starts counting on old files', () => {
    const late = at(2026, 11, 9, 21);
    expect(tickSummaries(seed(late), late + 5 * MIN)).toMatchObject({ changed: false, deliveries: [] });
    const { summaryCheckedAt: _c, ...old } = seed(late);
    const first = tickSummaries(old as HomemindState, late);
    expect(first.deliveries).toEqual([]);
    expect(first.state.summaryCheckedAt).toBe(iso(late));
    expect(lastSummaryAt(late, ZONE)).toBe(MON_20);
    expect(lastSummaryAt(MON_10, ZONE)).toBe(at(2026, 11, 8, 20));
  });

  it('a jump over several evenings sends only the latest; Sunday evening carries the week ahead', () => {
    const sunday = tickSummaries(seed(), at(2026, 11, 15, 20, 5));
    expect(sunday.sent).toMatchObject({ id: 'sum-2026-11-15', weekAhead: true });
    expect(sunday.deliveries[0].alert.weekAhead).toBe(true);
    expect(summaryFor(sunday.state, 'mom', 'weekly', at(2026, 11, 15, 20, 6))?.deliveredAt).toBe(iso(at(2026, 11, 15, 20, 5)));
  });

  it('a reminder nobody answered is under "What you need to do" as unanswered', () => {
    const base = seed();
    const state: HomemindState = {
      ...base,
      reminders: [
        { id: 'rem-1', itemId: 'pickup-today', occurrenceDate: '2026-11-09', occurrenceStart: iso(at(2026, 11, 9, 12)), ask: 'open', recipientIds: ['dad'], attempts: 1, status: 'sent', tier: 'summary', summaryAt: iso(MON_20), firstAt: iso(at(2026, 11, 9, 11)), intervalMinutes: 0, maxAttempts: 1 }
      ]
    };
    expect(summaryFor(state, 'dad', 'daily', MON_10)?.toDo.find(t => t.itemId === 'pickup-today')?.why).toBe('unanswered');
    expect(summaryFor(state, 'mom', 'daily', MON_10)?.toDo.find(t => t.itemId === 'pickup-today')?.why).toBe('asked');
  });
});

describe('summary screens and alerts (T8.2)', () => {
  const screens = () => {
    const { state, messages } = post(seed(), 3);
    const judged = judgeAll(state, messages).state;
    return { judged, sent: tickSummaries(judged, at(2026, 11, 9, 20, 1)).state };
  };

  it('the summary screen, in English and Chinese: to-dos first, the waited message with its reason, the rule named', () => {
    const { sent } = screens();
    const now = at(2026, 11, 9, 20, 2);
    for (const lang of ['en', 'zh'] as const) {
      const turn = screenTurn('summary', { lang, now: iso(now), view: viewFor(sent, 'mom') as unknown as HomemindViewData, summary: summaryFor(sent, 'mom', 'daily', now) ?? undefined });
      expect(A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0]).toBeDefined();
      const toDo = lang === 'en' ? 'What you need to do' : '你需要做的事';
      const everyone = lang === 'en' ? 'For everyone' : '全家知道就好';
      expect(turn.jsonl.indexOf(toDo)).toBeGreaterThan(-1);
      expect(turn.jsonl.indexOf(toDo)).toBeLessThan(turn.jsonl.indexOf(everyone));
      expect(turn.jsonl).toContain('秋游回执');
      expect(turn.jsonl).toContain(lang === 'en' ? 'the sender wrote “不着急” (not urgent)' : '发消息的人写了“不着急”（不着急）');
      expect(turn.jsonl).toContain(lang === 'en' ? 'not by the model' : '不是由模型决定');
      expect(turn.jsonl).toContain(lang === 'en' ? 'Sent at 20:01' : '20:01送达');
      expect(turn.jsonl).toContain('"simulated":true');
    }
    const preview = screenTurn('summary', { lang: 'en', now: iso(MON_10), view: viewFor(sent, 'maya') as unknown as HomemindViewData, summary: summaryFor(seed(), 'maya', 'weekly', MON_10) ?? undefined });
    expect(preview.jsonl).toContain('Preview: the week ahead goes out on Sun 11/15 at 20:00');
    expect(preview.jsonl).not.toContain('秋游');
  });

  it('My day (parents) lists the message that waits for tonight, with its reason; the group rows on Services carry it too', () => {
    const { judged } = screens();
    const services = servicesViewFor(judged, 'mom', MON_10);
    const myDay = screenTurn('my-day', { lang: 'en', now: iso(MON_10), view: viewFor(judged, 'mom') as unknown as HomemindViewData, judgments: judged.messageJudgments, services });
    expect(myDay.jsonl).toContain("Waiting for tonight's summary");
    expect(myDay.jsonl).toContain('Waits for the evening summary (20:00): the sender wrote “不着急” (not urgent)');
    expect(myDay.jsonl).toContain('No alert was sent for these.');
    const servicesScreen = screenTurn('services', { lang: 'zh', now: iso(MON_10), view: viewFor(judged, 'mom') as unknown as HomemindViewData, judgments: judged.messageJudgments, services });
    expect(servicesScreen.jsonl).toContain('现在提醒：和“本周”有关');
    expect(servicesScreen.jsonl).toContain('现在提醒：接龙（“#接龙”）有截止时间');
    expect(servicesScreen.jsonl).toContain('等到晚间摘要（20:00）');
    // Without judgments (a teen's screen) nothing is said about them.
    const teen = screenTurn('my-day', { lang: 'en', now: iso(MON_10), view: viewFor(judged, 'maya') as unknown as HomemindViewData });
    expect(teen.jsonl).not.toContain("Waiting for tonight's summary");
  });

  it('the client accepts message and summary alerts only when complete, words them, and keeps them as notices', () => {
    const { state, messages } = post(seed(), 1);
    const message = judgeMessage(state, messages[0], KINDERGARTEN_GROUP.id, MON_10)?.deliveries[0].alert as HomemindAlert;
    const summary = tickSummaries(seed(), at(2026, 11, 9, 20, 1)).deliveries[0].alert;
    const wire = (a: HomemindAlert) => JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
    expect(toAlert(wire(message))).toEqual(message);
    expect(toAlert(wire(summary))).toEqual(summary);
    expect(toAlert({ ...wire(message), simulated: undefined })).toBeNull();
    expect(toAlert({ ...wire(message), judgmentReason: 'because' })).toBeNull();
    expect(toAlert({ ...wire(summary), summaryToDo: -1 })).toBeNull();

    expect(alertText(message, 'en')).toContain('Teacher Wang in the class group: “各位家长好');
    expect(alertText(message, 'en')).toContain('Shown now: it is about the next few days. (Simulated group)');
    expect(alertText(message, 'zh')).toContain('王老师在班级群');
    expect(alertText({ ...summary, summaryToDo: 2, summaryMessages: 1 }, 'en')).toBe('Your evening summary is ready: 2 things for you. 1 group message waited for it.');
    expect(alertText({ ...summary, summaryToDo: 1, summaryMessages: 0, weekAhead: true }, 'zh')).toBe('你的晚间摘要已送达：1 件与你有关的事。下周概览也一起送达。');
    expect(alertTitle(summary, 'zh')).toBe('晚间摘要');
    expect(alertButtons(summary, 'en').map(b => b.verb)).toEqual(['open', 'dismiss']);
    expect(alertButtons(message, 'en').map(b => b.verb)).toEqual(['open', 'dismiss']);
    // Notices: an item change never removes them, and they never push out an alert that asks something.
    const list = addAlert(addAlert([], message), summary);
    expect(list).toHaveLength(2);
    expect(applyItemChange(list, 'grp-msg-1', null, 'mom')).toHaveLength(2);
  });
});
