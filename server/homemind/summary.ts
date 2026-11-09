/**
 * Summaries (T8.2): the evening summary (every day at 20:00, local) and the week ahead (on the evening
 * before the family's week starts). Each member's is built from their own view only, so a Parents-only
 * item or away event leaves no trace in a teen's summary.
 *
 * Order, as the plan asks: "What you need to do" first (theirs, given to them and not confirmed yet,
 * "Who's taking this?" they could take, reminders that got no answer), then who is away, then the
 * general events for everyone, then (parents) the group messages that waited for the summary, each with
 * the reason it waited (judgment.ts).
 *
 * `tickSummaries` sends one notice per member when a tick crosses 20:00. It never fires for a 20:00 that
 * passed before the state was made (a server started at 21:00 does not send last night's summary).
 *
 * Pure: no I/O, no clock reads (`now` is passed in).
 */
import type { AlertDelivery } from './alerts';
import { unavailabilityFor } from './availability';
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import { eligibleOwners, occurrences } from './core';
import { servicesOf } from './fakes';
import { HOMEMIND_SENDER, REMINDER_TIMING } from './reminders';
import type { HomemindAlert, HomemindState, Item, MessageJudgment, SummaryRecord, SummaryToDo, SummaryView } from './types';
import { visibleItems } from './visibility';

/** At most this many summary records are kept. */
export const MAX_SUMMARIES = 30;

const SUMMARY_TIME = REMINDER_TIMING.summaryTime;

/** The latest evening summary time at or before `now`. */
export function lastSummaryAt(now: number, timezone: string): number {
  const { date, time } = localParts(now, timezone);
  return zonedToUtc(time >= SUMMARY_TIME ? date : addDays(date, -1), SUMMARY_TIME, timezone);
}

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Whether the week ahead goes out on the evening of `date` (the next day starts the family's week). */
export const weekAheadOn = (state: HomemindState, date: string) => weekdayOf(addDays(date, 1)) === state.family.weekStartsOn;

/** Same rule as the screens' `needsOwner`: a task or preparation, or an Important event, with nobody on it. */
function wantsOwner(item: Item): boolean {
  if (item.status !== 'open') return false;
  if (item.ownership.state === 'open') return true;
  return item.ownership.state === 'none' && (item.type !== 'event' || item.importance === 'critical');
}

function toDoReason(state: HomemindState, item: Item, memberId: string): SummaryToDo['why'] | null {
  const own = item.ownership;
  if (own.state === 'assigned') return own.ownerId === memberId ? (own.confirmed ? 'owner' : 'unconfirmed') : null;
  if (!wantsOwner(item)) return null;
  if (own.state === 'open') return own.candidateIds.includes(memberId) ? 'asked' : null;
  return eligibleOwners(state, item).includes(memberId) ? 'asked' : null;
}

/** The local dates a summary covers, and its start and end instants. */
function periodOf(state: HomemindState, kind: SummaryView['kind'], date: string) {
  const tz = state.family.timezone;
  // Daily: what is left of that day and the next. Weekly: the seven days after it.
  const from = kind === 'daily' ? date : addDays(date, 1);
  const to = kind === 'daily' ? addDays(date, 1) : addDays(date, 7);
  return { from, to, fromMs: zonedToUtc(from, '00:00', tz), toMs: zonedToUtc(addDays(to, 1), '00:00', tz) };
}

/** Reminders that reached `memberId`, got no answer and moved to a summary at or before `atMs`. */
function unansweredFor(state: HomemindState, memberId: string, atMs: number): string[] {
  return state.reminders
    .filter(r => r.status === 'sent' && r.tier === 'summary' && r.summaryAt && Date.parse(r.summaryAt) <= atMs)
    .filter(r => [...r.recipientIds, ...(r.escalatedToIds ?? [])].includes(memberId))
    .map(r => r.itemId);
}

/**
 * One member's summary for the evening of `now`'s local date (`daily`), or for the week after it
 * (`weekly`). Before 20:00 it is a preview; once that evening's summary went out it carries `deliveredAt`.
 * `null` for an unknown member.
 */
export function summaryFor(state: HomemindState, memberId: string, kind: SummaryView['kind'], now: number): SummaryView | null {
  const member = state.family.members.find(m => m.id === memberId);
  if (!member) return null;
  const tz = state.family.timezone;
  const date = localParts(now, tz).date;
  const record = (state.summaries ?? []).find(s => s.date === date);
  // The week ahead goes out on the evening before the week starts; any other day it is a preview of it.
  let weeklyDate = date;
  while (kind === 'weekly' && !weekAheadOn(state, weeklyDate)) weeklyDate = addDays(weeklyDate, 1);
  const evening = kind === 'daily' ? date : weeklyDate;
  const scheduledMs = zonedToUtc(evening, SUMMARY_TIME, tz);
  const delivered = kind === 'daily' ? record : weeklyDate === date && record?.weekAhead ? record : undefined;
  // The week ahead is always the seven days after today, so a preview mid-week is still useful.
  const period = periodOf(state, kind, date);
  const items = visibleItems(state, memberId).filter(i => i.status === 'open');

  const toDo: SummaryToDo[] = [];
  const listed = new Set<string>();
  const unanswered = new Set(kind === 'daily' ? unansweredFor(state, memberId, delivered ? Date.parse(delivered.at) : scheduledMs) : []);
  for (const item of [...items].sort((a, b) => (a.start ?? '9').localeCompare(b.start ?? '9') || a.id.localeCompare(b.id))) {
    const why = unanswered.has(item.id) ? 'unanswered' : toDoReason(state, item, memberId);
    if (!why) continue;
    if (!item.start) {
      // No date: a task to do some time. Listed, so it is not forgotten.
      toDo.push({ itemId: item.id, why });
      listed.add(item.id);
      continue;
    }
    const first = occurrences(item, period.fromMs, period.toMs, tz)[0];
    if (first || why === 'unanswered') {
      toDo.push({ itemId: item.id, why, ...(first ? { date: first.date } : { date: localParts(Date.parse(item.start), tz).date }) });
      listed.add(item.id);
    }
  }

  const awaySeen = new Set<string>();
  const away = unavailabilityFor(state, memberId, period.fromMs, period.toMs).filter(a => {
    const key = `${a.memberId}|${a.eventId}`;
    if (awaySeen.has(key)) return false;
    awaySeen.add(key);
    return true;
  });

  const everyone: SummaryView['everyone'] = [];
  for (const item of items) {
    if (item.type !== 'event' || listed.has(item.id) || !item.start) continue;
    const first = occurrences(item, period.fromMs, period.toMs, tz)[0];
    if (first) everyone.push({ itemId: item.id, date: first.date });
  }
  everyone.sort((a, b) => a.date.localeCompare(b.date) || a.itemId.localeCompare(b.itemId));

  // The parents' group: its messages are for parents. The daily summary only.
  const messages: SummaryView['messages'] = [];
  if (kind === 'daily' && member.role === 'parent' && member.hasAccount) {
    const groupMessages = servicesOf(state).group.messages;
    const waited = (j: MessageJudgment) =>
      j.tier === 'summary' && (delivered ? j.deliveredIn === delivered.id : !j.deliveredIn && !!j.summaryAt && Date.parse(j.summaryAt) <= scheduledMs);
    for (const judgment of (state.messageJudgments ?? []).filter(waited)) {
      const message = groupMessages.find(m => m.id === judgment.messageId);
      if (message) messages.push({ judgment, message });
    }
  }

  return {
    kind,
    date: kind === 'daily' ? date : period.from,
    from: period.from,
    to: period.to,
    scheduledAt: toIso(scheduledMs),
    ...(delivered ? { deliveredAt: delivered.at } : {}),
    toDo,
    away,
    everyone,
    messages
  };
}

export interface SummaryTick {
  state: HomemindState;
  /** One notice per member with an account; route them like any alert (quiet hours hold them). */
  deliveries: AlertDelivery[];
  /** Whether the state changed and needs saving. */
  changed: boolean;
  /** The summary that went out on this tick, if one did. */
  sent?: SummaryRecord;
}

/**
 * Sends the evening summary when a tick crosses 20:00 (and the week ahead with it on the evening before
 * the week starts). A state with no `summaryCheckedAt` (made before T8.2) only starts counting now. The
 * messages that waited are marked as delivered in it.
 */
export function tickSummaries(state: HomemindState, now: number): SummaryTick {
  const tz = state.family.timezone;
  if (!state.summaryCheckedAt) return { state: { ...state, summaryCheckedAt: toIso(now) }, deliveries: [], changed: true };
  const due = lastSummaryAt(now, tz);
  if (Date.parse(state.summaryCheckedAt) >= due) return { state, deliveries: [], changed: false };
  const date = localParts(due, tz).date;
  const id = `sum-${date}`;
  if ((state.summaries ?? []).some(s => s.id === id)) return { state: { ...state, summaryCheckedAt: toIso(now) }, deliveries: [], changed: true };
  const record: SummaryRecord = { id, date, at: toIso(now), weekAhead: weekAheadOn(state, date) };
  const next: HomemindState = {
    ...state,
    summaryCheckedAt: toIso(now),
    summaries: [...(state.summaries ?? []), record].slice(-MAX_SUMMARIES),
    messageJudgments: (state.messageJudgments ?? []).map(j =>
      j.tier === 'summary' && !j.deliveredIn && j.summaryAt && Date.parse(j.summaryAt) <= due ? { ...j, deliveredIn: id } : j
    )
  };
  if (!next.messageJudgments?.length) delete next.messageJudgments;
  const deliveries: AlertDelivery[] = [];
  for (const member of next.family.members.filter(m => m.hasAccount)) {
    const view = summaryFor(next, member.id, 'daily', now);
    if (!view) continue;
    const alert: HomemindAlert = {
      id,
      kind: 'summary',
      itemId: id,
      itemVersion: 1,
      tier: 'timed',
      at: record.at,
      byId: HOMEMIND_SENDER.id,
      byName: HOMEMIND_SENDER.name,
      byNameZh: HOMEMIND_SENDER.nameZh,
      sensitive: false,
      summaryToDo: view.toDo.length,
      summaryMessages: view.messages.length,
      ...(record.weekAhead ? { weekAhead: true } : {})
    };
    deliveries.push({ recipientId: member.id, alert });
  }
  return { state: next, deliveries, changed: true, sent: record };
}
