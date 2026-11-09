/**
 * Reminders and escalation (T4.1).
 *
 * One reminder per occurrence of a timed item, kept in line with the board on every tick:
 *   heads-up  assigned and confirmed: one note before it starts, to the owner
 *   confirm   assigned, not confirmed: to the owner
 *   open      "Who's taking this?": to the candidates (an unowned item only if it is critical)
 * A regular reminder is sent once; with no answer it moves to the next summary. A critical one is
 * sent up to 3 times, then escalated once (to the other parent, or to both parents for an open
 * item), then the backup contact gets a message with no details, if the family set one. A regular
 * open item escalates to both parents shortly before it starts.
 *
 * Any answer closes the reminder for everyone it reached: the item answered on the board (confirmed,
 * taken, done) or the reminder itself ("Got it", "Remind me later"). Quiet hours hold everything but
 * `urgent`, and several small updates for one member go out as one alert. Pausing Homemind stops
 * automatic actions and rules, not reminders.
 *
 * Pure: no I/O, no clock reads (`now` is passed in), no randomness. Wording is the client's job; the
 * only text made here is the backup message, which says nothing about the family's plans.
 */
import type { AlertDelivery } from './alerts';
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import { eligibleOwners, occurrences } from './core';
import type {
  AlertBatchEntry,
  BackupMessage,
  EscalationStep,
  HeldAlert,
  HomemindAlert,
  HomemindState,
  Item,
  Member,
  PendingReminder,
  Reminder,
  ReminderAsk,
  Tier
} from './types';
import { canSeeItem } from './visibility';

const MIN = 60_000;

export const REMINDER_TIMING = {
  /** Reminders are planned for occurrences that start within this many minutes. */
  horizonMinutes: 26 * 60,
  /** The first attempt, this many minutes before the start (or at once, if that has passed). */
  leadMinutes: { normal: 30, critical: 60 },
  /** Critical: attempts this far apart at most, closer when there is less time. */
  maxIntervalMinutes: 10,
  minIntervalMinutes: 1,
  criticalAttempts: 3,
  /** A regular open item asks both parents this long before it starts. */
  openEscalateBeforeMinutes: 15,
  snoozeMinutes: 10,
  /** Sent and not answered for this long, with nothing left to send: it goes to the summary. */
  summaryAfterMinutes: 30,
  /** Nothing fires later than this after the start. */
  graceAfterStartMinutes: 60,
  /** Local time of the evening summary (T8.2 builds the card). */
  summaryTime: '20:00',
  /** Closed reminders are kept this long after their occurrence, then dropped. */
  keepDays: 2
} as const;

/** The sender of reminder alerts. Not a member. */
export const HOMEMIND_SENDER = { id: 'homemind', name: 'Homemind', nameZh: 'Homemind' } as const;

/** The whole backup message. No reason, no item, no time, no names (CLAUDE.md). */
export const BACKUP_TEXT = {
  en: 'Homemind: please get in touch with the family when you can.',
  zh: 'Homemind：方便时请联系一下家里。'
} as const;

// ---------------------------------------------------------------------------------------------
// Small helpers

const parse = (iso: string) => Date.parse(iso);

function memberOf(state: HomemindState, id: string): Member | undefined {
  return state.family.members.find(m => m.id === id);
}

function withAccount(state: HomemindState, ids: readonly string[]): string[] {
  return [...new Set(ids)].filter(id => memberOf(state, id)?.hasAccount);
}

function parentIds(state: HomemindState): string[] {
  return state.family.members.filter(m => m.role === 'parent' && m.hasAccount).map(m => m.id);
}

const isActive = (r: Reminder) => r.status === 'scheduled' || r.status === 'sent';
const wasSent = (r: Reminder) => r.attempts > 0 || (r.escalationsDone ?? 0) > 0 || r.lastSentAt !== undefined;
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

function newId(prefix: string, now: number, taken: (id: string) => boolean): string {
  const base = `${prefix}-${Math.max(0, Math.floor(now)).toString(36)}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

// ---------------------------------------------------------------------------------------------
// Quiet hours and the summary time

/** Whether `ms` falls in the member's quiet hours (local `from` to `to`, overnight allowed). */
export function inQuietHours(member: Member | undefined, ms: number, timezone: string): boolean {
  const q = member?.quietHours;
  if (!q || q.from === q.to) return false;
  const time = localParts(ms, timezone).time;
  return q.from < q.to ? time >= q.from && time < q.to : time >= q.from || time < q.to;
}

/** The next end of the member's quiet hours after `ms`. Only meaningful while they are on. */
export function quietHoursEnd(member: Member, ms: number, timezone: string): number {
  const q = member.quietHours as { from: string; to: string };
  const { date, time } = localParts(ms, timezone);
  return zonedToUtc(time < q.to ? date : addDays(date, 1), q.to, timezone);
}

/** The next evening summary at or after `ms`. */
export function nextSummaryAt(ms: number, timezone: string): number {
  const { date, time } = localParts(ms, timezone);
  return zonedToUtc(time < REMINDER_TIMING.summaryTime ? date : addDays(date, 1), REMINDER_TIMING.summaryTime, timezone);
}

// ---------------------------------------------------------------------------------------------
// What the board asks for

interface Ask {
  ask: ReminderAsk;
  recipientIds: string[];
}

/** What a reminder for `item` would ask now, and of whom. `null`: nothing to remind anyone of. */
export function askFor(state: HomemindState, item: Item): Ask | null {
  if (item.status !== 'open' || !item.start || item.allDay) return null;
  const visible = (ids: readonly string[]) => withAccount(state, ids).filter(id => canSeeItem(state, id, item));
  const own = item.ownership;
  let result: Ask;
  if (own.state === 'assigned') {
    result = { ask: own.confirmed ? 'heads-up' : 'confirm', recipientIds: visible([own.ownerId]) };
  } else if (own.state === 'open') {
    const candidates = visible(own.candidateIds);
    result = { ask: 'open', recipientIds: candidates.length ? candidates : visible(parentIds(state)) };
  } else {
    // Nobody owns it and nobody was asked: only a critical item (a child's pickup) is worth a reminder.
    if (item.importance !== 'critical') return null;
    result = { ask: 'open', recipientIds: visible(eligibleOwners(state, item)) };
  }
  return result.recipientIds.length ? result : null;
}

interface Spec extends Ask {
  item: Item;
  date: string;
  start: string;
}

const keyOf = (itemId: string, date: string) => `${itemId}|${date}`;

/** Every reminder the board calls for now, by item and occurrence. */
function desiredSpecs(state: HomemindState, now: number): Map<string, Spec> {
  const out = new Map<string, Spec>();
  const { timezone } = state.family;
  const from = now - REMINDER_TIMING.graceAfterStartMinutes * MIN;
  const to = now + REMINDER_TIMING.horizonMinutes * MIN;
  for (const item of state.items) {
    const ask = askFor(state, item);
    if (!ask) continue;
    for (const occurrence of occurrences(item, from, to, timezone)) {
      out.set(keyOf(item.id, occurrence.date), { ...ask, item, date: occurrence.date, start: occurrence.start });
    }
  }
  return out;
}

/** The ask for an existing reminder's own occurrence, wherever it is in time. `gone`: it no longer exists. */
function currentAsk(state: HomemindState, r: Reminder): Ask | 'done' | 'gone' {
  const item = state.items.find(i => i.id === r.itemId);
  if (!item) return 'gone';
  if (item.status === 'done') return 'done';
  const startMs = parse(r.occurrenceStart);
  const still = occurrences(item, startMs, startMs + 1, state.family.timezone).some(o => o.start === r.occurrenceStart);
  if (!still) return 'gone';
  return askFor(state, item) ?? 'gone';
}

/** When attempts and escalation steps happen, for a reminder planned at `now`. */
function schedule(state: HomemindState, spec: Spec, now: number) {
  const T = REMINDER_TIMING;
  const critical = spec.item.importance === 'critical';
  const startMs = parse(spec.start);
  const firstMs = Math.max(now, startMs - (critical ? T.leadMinutes.critical : T.leadMinutes.normal) * MIN);
  const room = Math.max(0, startMs - firstMs) / MIN;
  const tier: Tier = critical ? 'urgent' : 'timed';
  const base = { firstAt: toIso(firstMs), fireAt: toIso(firstMs), tier };
  if (spec.ask === 'heads-up') return { ...base, maxAttempts: 1, intervalMinutes: 0, escalation: [] as EscalationStep[] };
  if (critical) {
    const interval = Math.min(T.maxIntervalMinutes, Math.max(T.minIntervalMinutes, Math.floor(room / 4)));
    const escalation: EscalationStep[] = [{ afterMinutes: 3 * interval, to: spec.ask === 'confirm' ? 'next-parent' : 'both-parents' }];
    if (state.family.backupContact) escalation.push({ afterMinutes: 4 * interval, to: 'backup' });
    return { ...base, maxAttempts: T.criticalAttempts, intervalMinutes: interval, escalation };
  }
  if (spec.ask === 'open') {
    return { ...base, maxAttempts: 1, intervalMinutes: 0, escalation: [{ afterMinutes: Math.max(0, Math.floor(room - T.openEscalateBeforeMinutes)), to: 'both-parents' }] as EscalationStep[] };
  }
  return { ...base, maxAttempts: 1, intervalMinutes: 0, escalation: [] as EscalationStep[] };
}

function planned(state: HomemindState, spec: Spec, now: number, id: string): Reminder {
  return {
    id,
    itemId: spec.item.id,
    occurrenceDate: spec.date,
    occurrenceStart: spec.start,
    ask: spec.ask,
    recipientIds: spec.recipientIds,
    attempts: 0,
    status: 'scheduled',
    escalationsDone: 0,
    ...schedule(state, spec, now)
  };
}

// ---------------------------------------------------------------------------------------------
// Keeping reminders in line with the board

/** A reminder that stopped. Its open alerts close for everyone it reached. */
export interface ClosedReminder {
  reminderId: string;
  recipientIds: string[];
}

/** Everyone a reminder reached: its recipients, whoever it escalated to, and parents for a backup notice. */
function reachedBy(state: HomemindState, r: Reminder): string[] {
  const backupSent = (r.escalation ?? []).slice(0, r.escalationsDone ?? 0).some(step => step.to === 'backup');
  return [...new Set([...r.recipientIds, ...(r.escalatedToIds ?? []), ...(backupSent ? parentIds(state) : [])])];
}

function close(state: HomemindState, r: Reminder, status: 'acknowledged' | 'cancelled', now: number, closed: ClosedReminder[], answeredBy?: string): Reminder {
  if (wasSent(r)) closed.push({ reminderId: r.id, recipientIds: reachedBy(state, r) });
  const { fireAt: _f, snoozedUntil: _s, ...rest } = r;
  return { ...rest, status, ...(status === 'acknowledged' ? { answeredAt: toIso(now), ...(answeredBy ? { answeredBy } : {}) } : {}) };
}

/**
 * Brings the reminders in line with the board at `now`: plans new ones, follows ownership changes,
 * and closes those the board answered (confirmed, done) or that no longer apply.
 */
export function syncReminders(state: HomemindState, now: number): { reminders: Reminder[]; closed: ClosedReminder[] } {
  const specs = desiredSpecs(state, now);
  const closed: ClosedReminder[] = [];
  const covered = new Set<string>();
  const keepAfter = now - REMINDER_TIMING.keepDays * 24 * 60 * MIN;
  const out: Reminder[] = [];
  const taken = new Set(state.reminders.map(r => r.id));

  for (const r of state.reminders) {
    if (!isActive(r)) {
      if (parse(r.occurrenceStart) >= keepAfter) out.push(r);
      continue;
    }
    const key = keyOf(r.itemId, r.occurrenceDate);
    const now_ = currentAsk(state, r);
    if (now_ === 'gone' || covered.has(key)) {
      out.push(close(state, r, 'cancelled', now, closed));
      continue;
    }
    if (now_ === 'done') {
      out.push(close(state, r, 'acknowledged', now, closed));
      continue;
    }
    if (now_.ask === r.ask && sameIds(now_.recipientIds, r.recipientIds)) {
      covered.add(key);
      out.push(r);
      continue;
    }
    // The ask changed. Confirmed by the owner: answered. Anything else: start again for the new ask.
    if (r.status === 'sent' && r.ask !== 'heads-up' && now_.ask === 'heads-up') {
      out.push(close(state, r, 'acknowledged', now, closed, now_.recipientIds[0]));
      continue;
    }
    const spec = specs.get(key);
    if (r.status === 'scheduled' && spec) {
      covered.add(key);
      out.push({ ...planned(state, spec, now, r.id), id: r.id });
      continue;
    }
    out.push(close(state, r, 'cancelled', now, closed));
  }

  for (const [key, spec] of specs) {
    if (covered.has(key) || parse(spec.start) <= now) continue;
    // Already answered for this occurrence: once with the same ask and people, and any heads-up after
    // a confirmation (the owner just said "I'm on it").
    const answered = out.filter(r => r.status === 'acknowledged' && keyOf(r.itemId, r.occurrenceDate) === key);
    if (answered.some(r => (r.ask === spec.ask && sameIds(r.recipientIds, spec.recipientIds)) || spec.ask === 'heads-up')) continue;
    const id = newId('rem', now, candidate => taken.has(candidate));
    taken.add(id);
    out.push(planned(state, spec, now, id));
  }
  return { reminders: out, closed };
}

// ---------------------------------------------------------------------------------------------
// Firing

function baseAlert(state: HomemindState, r: Reminder, item: Item, kind: HomemindAlert['kind'], id: string, now: number): HomemindAlert {
  return {
    id,
    kind,
    itemId: item.id,
    itemVersion: item.version,
    tier: r.tier === 'urgent' ? 'urgent' : 'timed',
    at: toIso(now),
    byId: HOMEMIND_SENDER.id,
    byName: HOMEMIND_SENDER.name,
    byNameZh: HOMEMIND_SENDER.nameZh,
    // A sensitive item shows only "You have a reminder": no title and no time.
    ...(item.sensitive
      ? {}
      : { title: item.title, ...(item.titleZh ? { titleZh: item.titleZh } : {}), time: localParts(parse(r.occurrenceStart), state.family.timezone).time }),
    sensitive: item.sensitive,
    reminderId: r.id,
    ask: r.ask,
    ...(item.recurrence ? { recurring: true } : {})
  };
}

interface Fired {
  reminder: Reminder;
  alerts: AlertDelivery[];
  backup?: BackupMessage;
}

function fire(state: HomemindState, r: Reminder, now: number, backupId: () => string): Fired {
  const item = state.items.find(i => i.id === r.itemId);
  const startMs = parse(r.occurrenceStart);
  const firstMs = parse(r.firstAt);
  if (!item || now < firstMs) return { reminder: r, alerts: [] };
  const T = REMINDER_TIMING;

  // Long past the start: nothing more fires. Never sent: drop it quietly. Sent: wait for the summary.
  if (now > startMs + T.graceAfterStartMinutes * MIN) {
    if (r.status === 'scheduled') {
      const { fireAt: _f, ...rest } = r;
      return { reminder: { ...rest, status: 'cancelled' }, alerts: [] };
    }
    return { reminder: r.summaryAt ? r : { ...r, tier: 'summary', summaryAt: toIso(nextSummaryAt(now, state.family.timezone)) }, alerts: [] };
  }

  const next: Reminder = { ...r };
  const alerts: AlertDelivery[] = [];
  const to = (ids: readonly string[], alert: HomemindAlert) => {
    for (const recipientId of ids) if (canSeeItem(state, recipientId, item)) alerts.push({ recipientId, alert });
  };

  // Attempts. A clock jump past several slots counts them all and sends one.
  const slots = r.intervalMinutes > 0 ? Math.min(r.maxAttempts, Math.floor((now - firstMs) / (r.intervalMinutes * MIN)) + 1) : Math.min(1, r.maxAttempts);
  const snoozed = r.snoozedUntil ? parse(r.snoozedUntil) : undefined;
  let send = false;
  if (slots > r.attempts) {
    next.attempts = slots;
    if (slots < r.maxAttempts) next.fireAt = toIso(firstMs + slots * r.intervalMinutes * MIN);
    else delete next.fireAt;
    if (snoozed === undefined || snoozed <= now) send = true;
  }
  if (snoozed !== undefined && snoozed <= now) {
    send = true;
    delete next.snoozedUntil;
  }
  if (send) {
    const step = snoozed !== undefined && snoozed <= now ? `s${Math.floor(now).toString(36)}` : `a${next.attempts}`;
    to(r.recipientIds, baseAlert(state, r, item, 'reminder', `${r.id}.${step}`, now));
    next.status = 'sent';
    next.lastSentAt = toIso(now);
  }

  // Escalation steps, each once, in order.
  const steps = r.escalation ?? [];
  let done = r.escalationsDone ?? 0;
  let backup: BackupMessage | undefined;
  while (done < steps.length && firstMs + steps[done].afterMinutes * MIN <= now) {
    const step = steps[done];
    done++;
    if (step.to === 'backup') {
      const contact = state.family.backupContact;
      if (!contact) continue;
      next.status = 'sent';
      next.lastSentAt = toIso(now);
      backup = { id: backupId(), at: toIso(now), reminderId: r.id, to: contact.name, channel: contact.channel, text: BACKUP_TEXT.en, textZh: BACKUP_TEXT.zh, simulated: contact.simulated };
      const notice: HomemindAlert = {
        ...baseAlert(state, r, item, 'backup', `${r.id}.b${done}`, now),
        contactName: contact.name,
        ...(contact.nameZh ? { contactNameZh: contact.nameZh } : {}),
        ...(contact.simulated ? { simulated: true } : {})
      };
      to(parentIds(state), notice);
      continue;
    }
    const targets = withAccount(state, step.to === 'both-parents' ? parentIds(state) : parentIds(state).filter(id => !r.recipientIds.includes(id)));
    if (!targets.length) continue;
    next.status = 'sent';
    next.lastSentAt = toIso(now);
    to(targets, baseAlert(state, r, item, 'escalation', `${r.id}.e${done}`, now));
    next.escalatedToIds = [...new Set([...(next.escalatedToIds ?? []), ...targets])];
  }
  next.escalationsDone = done;

  // Sent, nothing left to send, and no answer for a while: it waits for the summary.
  const finished = next.fireAt === undefined && done >= steps.length && !next.snoozedUntil;
  if (next.status === 'sent' && finished && !next.summaryAt && next.lastSentAt && now >= parse(next.lastSentAt) + T.summaryAfterMinutes * MIN) {
    next.tier = 'summary';
    next.summaryAt = toIso(nextSummaryAt(now, state.family.timezone));
  }
  return { reminder: next, alerts, ...(backup ? { backup } : {}) };
}

/**
 * One alert per member and reminder per tick: an escalation replaces that tick's reminder alert for
 * the same member. A reminder alert is also left out for a member who gets an alert about the same
 * item from the change itself ("Mom assigned you"): that attempt still counts.
 */
function dedupe(alerts: readonly AlertDelivery[], fromChange: readonly AlertDelivery[]): AlertDelivery[] {
  const rank: Partial<Record<HomemindAlert['kind'], number>> = { reminder: 1, escalation: 2 };
  const byKey = new Map<string, AlertDelivery>();
  for (const delivery of alerts) {
    const { alert, recipientId } = delivery;
    if (alert.kind === 'reminder' && fromChange.some(d => d.recipientId === recipientId && d.alert.itemId === alert.itemId)) continue;
    const key = `${recipientId}|${alert.reminderId}|${alert.kind === 'backup' ? 'b' : 'r'}`;
    const existing = byKey.get(key);
    if (!existing || (rank[alert.kind] ?? 0) >= (rank[existing.alert.kind] ?? 0)) byKey.set(key, delivery);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------------------------
// Quiet hours and batching

function stillApplies(state: HomemindState, held: HeldAlert): boolean {
  const item = state.items.find(i => i.id === held.alert.itemId);
  if (!item || item.status !== 'open' || !canSeeItem(state, held.recipientId, item)) return false;
  if (!held.alert.reminderId) return true;
  const r = state.reminders.find(x => x.id === held.alert.reminderId);
  return !!r && isActive(r) && !r.snoozedUntil;
}

function batchAlert(recipientId: string, alerts: readonly HomemindAlert[], now: number): HomemindAlert {
  const entries: AlertBatchEntry[] = [];
  for (const alert of alerts) {
    for (const entry of alert.kind === 'batch' && alert.entries ? alert.entries : [{ itemId: alert.itemId, title: alert.title, titleZh: alert.titleZh, sensitive: alert.sensitive }]) {
      if (entries.some(e => e.itemId === entry.itemId)) continue;
      entries.push({ itemId: entry.itemId, sensitive: entry.sensitive, ...(entry.sensitive || !entry.title ? {} : { title: entry.title, ...(entry.titleZh ? { titleZh: entry.titleZh } : {}) }) });
    }
  }
  const first = alerts[0];
  return {
    id: `batch.${recipientId}.${Math.floor(now).toString(36)}`,
    kind: 'batch',
    itemId: first.itemId,
    itemVersion: first.itemVersion,
    tier: 'timed',
    at: toIso(now),
    byId: HOMEMIND_SENDER.id,
    byName: HOMEMIND_SENDER.name,
    byNameZh: HOMEMIND_SENDER.nameZh,
    sensitive: entries.every(e => e.sensitive),
    entries
  };
}

/**
 * Holds what may not break quiet hours, releases what was held once they end, and joins several
 * small updates for one member into one alert. Urgent alerts always go at once, on their own.
 */
export function routeAlerts(state: HomemindState, deliveries: readonly AlertDelivery[], now: number): { held: HeldAlert[]; send: AlertDelivery[] } {
  const { timezone } = state.family;
  const waiting = (state.heldAlerts ?? []).filter(h => stillApplies(state, h));
  const due = waiting.filter(h => parse(h.releaseAt) <= now);
  const held = waiting.filter(h => parse(h.releaseAt) > now);
  const ready: AlertDelivery[] = due.map(h => ({ recipientId: h.recipientId, alert: h.alert }));
  for (const delivery of deliveries) {
    const member = memberOf(state, delivery.recipientId);
    if (delivery.alert.tier !== 'urgent' && member && inQuietHours(member, now, timezone)) {
      held.push({ recipientId: delivery.recipientId, alert: delivery.alert, releaseAt: toIso(quietHoursEnd(member, now, timezone)) });
    } else {
      ready.push(delivery);
    }
  }
  const send: AlertDelivery[] = ready.filter(d => d.alert.tier === 'urgent');
  const small = new Map<string, HomemindAlert[]>();
  for (const d of ready) if (d.alert.tier !== 'urgent') small.set(d.recipientId, [...(small.get(d.recipientId) ?? []), d.alert]);
  for (const [recipientId, alerts] of small) {
    send.push({ recipientId, alert: alerts.length === 1 ? alerts[0] : batchAlert(recipientId, alerts, now) });
  }
  return { held, send };
}

// ---------------------------------------------------------------------------------------------
// The tick

export interface TickResult {
  state: HomemindState;
  /** Alerts to deliver now, after quiet hours and batching. */
  deliveries: AlertDelivery[];
  /** Reminders that stopped: close their alerts for everyone they reached. */
  closed: ClosedReminder[];
  /** Whether reminders, held alerts or backup messages changed (so the state needs saving). */
  changed: boolean;
}

/**
 * One scheduler tick at `now`. `fromChange` are the alerts a person's change just made (alerts.ts);
 * they go through the same quiet hours and batching. Pure.
 */
export function tickReminders(state: HomemindState, now: number, fromChange: readonly AlertDelivery[] = []): TickResult {
  const synced = syncReminders(state, now);
  let current: HomemindState = { ...state, reminders: synced.reminders };
  const backups = [...(state.backupMessages ?? [])];
  const backupIds = new Set(backups.map(b => b.id));
  const backupId = () => {
    const id = newId('bak', now, candidate => backupIds.has(candidate));
    backupIds.add(id);
    return id;
  };
  const fired: AlertDelivery[] = [];
  const closed = [...synced.closed];
  // T7.5: an item whose message changed waits for a parent's decision: its reminders do not fire meanwhile.
  const staleIds = new Set(current.items.filter(i => i.stale).map(i => i.id));
  const reminders = current.reminders.map(r => {
    if (!isActive(r) || staleIds.has(r.itemId)) return r;
    const result = fire(current, r, now, backupId);
    fired.push(...result.alerts);
    if (result.backup) backups.push(result.backup);
    if (r.status === 'sent' && result.reminder.status === 'cancelled') closed.push({ reminderId: r.id, recipientIds: reachedBy(current, r) });
    return result.reminder;
  });
  current = { ...current, reminders };
  const routed = routeAlerts(current, [...fromChange, ...dedupe(fired, fromChange)], now);
  const next: HomemindState = { ...current };
  if (routed.held.length || state.heldAlerts) next.heldAlerts = routed.held;
  if (backups.length) next.backupMessages = backups;
  const changed =
    JSON.stringify(state.reminders) !== JSON.stringify(next.reminders) ||
    JSON.stringify(state.heldAlerts ?? []) !== JSON.stringify(next.heldAlerts ?? []) ||
    JSON.stringify(state.backupMessages ?? []) !== JSON.stringify(next.backupMessages ?? []);
  return { state: next, deliveries: routed.send, closed, changed };
}

// ---------------------------------------------------------------------------------------------
// Answers to a reminder itself

export type ReminderResponse = 'ack' | 'snooze';

export type RespondResult =
  | { ok: true; state: HomemindState; reminder: Reminder; closed: ClosedReminder[] }
  | { ok: false; status: 403 | 404 | 409; code: 'forbidden' | 'not_found' | 'conflict'; message: string };

/**
 * "Got it" (`ack`) or "Remind me later" (`snooze`) from a member the reminder reached. Either one
 * closes its alerts for everyone. A snooze keeps the reminder: one more alert after the snooze, and
 * the escalation times do not move. Answers on the item itself (confirm, take, done, hand off) go
 * through `applyChange`, and the next sync closes the reminder.
 */
export function respondToReminder(state: HomemindState, reminderId: string, memberId: string, response: ReminderResponse, now: number): RespondResult {
  const r = state.reminders.find(x => x.id === reminderId);
  const item = r && state.items.find(i => i.id === r.itemId);
  // A member who may not see the item gets the same answer as for a missing reminder.
  if (!r || !item || !canSeeItem(state, memberId, item)) return { ok: false, status: 404, code: 'not_found', message: 'no such reminder' };
  if (!reachedBy(state, r).includes(memberId)) return { ok: false, status: 403, code: 'forbidden', message: 'this reminder is not for you' };
  if (!isActive(r)) return { ok: false, status: 409, code: 'conflict', message: 'this reminder was already answered' };
  const closed: ClosedReminder[] = [];
  let reminder: Reminder;
  if (response === 'ack') {
    reminder = close(state, r, 'acknowledged', now, closed, memberId);
  } else {
    if (wasSent(r)) closed.push({ reminderId: r.id, recipientIds: reachedBy(state, r) });
    reminder = { ...r, snoozedUntil: toIso(now + REMINDER_TIMING.snoozeMinutes * MIN) };
  }
  const heldAlerts = state.heldAlerts?.filter(h => h.alert.reminderId !== r.id);
  return {
    ok: true,
    reminder,
    closed,
    state: { ...state, reminders: state.reminders.map(x => (x.id === r.id ? reminder : x)), ...(heldAlerts ? { heldAlerts } : {}) }
  };
}

/** The member's active reminder for an item, if any (the newest). For answering from an alert. */
export function activeReminderFor(state: HomemindState, itemId: string, memberId: string): Reminder | undefined {
  return state.reminders.filter(r => r.itemId === itemId && isActive(r) && reachedBy(state, r).includes(memberId)).pop();
}

/** Active reminders already sent that reached `memberId`, newest per item. */
export function pendingRemindersFor(state: HomemindState, memberId: string, now: number): PendingReminder[] {
  const byItem = new Map<string, PendingReminder>();
  for (const r of state.reminders) {
    if (!isActive(r) || !wasSent(r) || !reachedBy(state, r).includes(memberId)) continue;
    byItem.set(r.itemId, {
      itemId: r.itemId,
      reminderId: r.id,
      ask: r.ask,
      escalated: !r.recipientIds.includes(memberId),
      snoozed: r.snoozedUntil !== undefined && Date.parse(r.snoozedUntil) > now
    });
  }
  return [...byItem.values()];
}
