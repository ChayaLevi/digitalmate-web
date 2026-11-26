/**
 * Time fixtures for HOPA's family board (plan task C2): time zones and daylight saving, reminders and
 * escalation, availability. Every expected value here is what Homemind's own code computes, unchanged:
 * `clock.ts`, `core.ts` (`occurrences`), `reminders.ts` and `availability.ts`.
 *
 * HOPA computes reminders on each device from the board (its D5), instead of keeping reminder records
 * on a server. The reminder cases check that both give the same alerts at the same minutes: the
 * generator replays the ops at their `at`, ticks Homemind's scheduler once a minute through a window,
 * and records every alert it delivers. HOPA's planner, run over the same board at the same minutes, must
 * deliver exactly these. Quiet hours and batching are local to a device, so these cases turn them off
 * (members have no quiet hours) and check them in `time-zones.json` instead.
 *
 * Availability runs per scope (HOPA's D11): an event in `parents` never makes a conflict with a
 * `family` item. A parent device that wants the family to plan around a parents event derives a busy
 * event into `family` first (board-scopes.json, `derive-busy-event-for-family`).
 */
import { activeReminderFor, inQuietHours, nextSummaryAt, quietHoursEnd, respondToReminder, tickReminders } from '../../server/homemind/reminders';
import { findConflicts, proposeForConflicts, unavailabilityFor, unavailableDuring } from '../../server/homemind/availability';
import { localParts, toIso, zonedToUtc } from '../../server/homemind/clock';
import { occurrences } from '../../server/homemind/core';
import { seedState } from '../../server/homemind/seed';
import type { HomemindState, Item, Member, Recurrence } from '../../server/homemind/types';
import { applyEntry, SCOPES } from './adapter';
import type { LogEntry, Scope, V1Item, V1State } from './adapter';
import { SEED_NOW, seedV1, TIMEZONE } from './build';
import type { Member as Who } from './cases';

const MIN = 60_000;
const DEVICE: Record<Who, string> = { mom: 'mom-phone', dad: 'dad-laptop', maya: 'maya-phone', noa: 'noa-tablet' };
const clone = <T>(value: T): T => structuredClone(value);
const ms = (iso: string) => Date.parse(iso);

// ---------------------------------------------------------------------------------------------
// Shared: a v1 log with explicit times, and the Homemind state for a v1 state

interface TimedStep {
  by: Who;
  scope?: Scope;
  /** ISO time in UTC, on a whole minute: when the op is written (its `at`). */
  at: string;
  op: { kind: string; [field: string]: unknown };
}

function timedLog(name: string, steps: TimedStep[]): LogEntry[] {
  return steps.map((step, n) => ({
    seq: n + 1,
    scope: step.scope ?? 'family',
    memberId: step.by,
    fromDevice: DEVICE[step.by],
    op: { v: 1, opId: `op${n + 1}-${name}`, at: step.at, ...step.op }
  }));
}

function withTimezone(state: V1State, timezone?: string): V1State {
  return timezone ? { ...clone(state), family: { ...clone(state.family), timezone } } : clone(state);
}

function apply(state: V1State, entry: LogEntry, name: string): V1State {
  const step = applyEntry(state, entry);
  if (step.kind !== 'applied') throw new Error(`${name}: seq ${entry.seq} (${entry.op.kind}) was not applied`);
  return step.state;
}

const asItem = (item: V1Item, visibility: Scope): Item => ({ ...clone(item), visibility }) as Item;

/** Homemind's state for a device holding `scopes`: the seed's extras, the v1 roster, no quiet hours. */
function homemindOf(v1: V1State, scopes: readonly Scope[], backup: boolean): HomemindState {
  const seed = seedState({ now: SEED_NOW, timezone: TIMEZONE });
  const members: Member[] = seed.family.members.map(({ quietHours: _quiet, ...m }) => m);
  const family = { ...seed.family, timezone: v1.family.timezone, members };
  if (!backup) delete family.backupContact;
  const items = scopes.flatMap(scope => (v1.scopes[scope]?.items ?? []).map(item => asItem(item, scope)));
  return { ...seed, family, items, reminders: [], activity: [], heldAlerts: undefined, backupMessages: undefined };
}

// ---------------------------------------------------------------------------------------------
// time-zones.json: clock and occurrence rules

const ZONES = ['Asia/Jerusalem', 'America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Shanghai'] as const;

/** Local date-times around each zone's 2026 changes: before, in the gap or overlap, after. */
const LOCAL_TIMES: Record<(typeof ZONES)[number], Array<[string, string]>> = {
  'Asia/Jerusalem': [['2026-03-27', '01:30'], ['2026-03-27', '02:30'], ['2026-03-27', '03:30'], ['2026-10-25', '00:30'], ['2026-10-25', '01:30'], ['2026-10-25', '02:30'], ['2026-11-11', '14:30']],
  'America/New_York': [['2026-03-08', '01:30'], ['2026-03-08', '02:30'], ['2026-03-08', '03:30'], ['2026-11-01', '00:30'], ['2026-11-01', '01:30'], ['2026-11-01', '02:30']],
  'Europe/London': [['2026-03-29', '00:30'], ['2026-03-29', '01:30'], ['2026-03-29', '02:30'], ['2026-10-25', '00:30'], ['2026-10-25', '01:30'], ['2026-10-25', '02:30']],
  'Australia/Sydney': [['2026-04-05', '01:30'], ['2026-04-05', '02:30'], ['2026-04-05', '03:30'], ['2026-10-04', '01:30'], ['2026-10-04', '02:30'], ['2026-10-04', '03:30']],
  'Asia/Shanghai': [['2026-03-08', '02:30'], ['2026-11-11', '23:59'], ['2026-12-31', '00:00']]
};

/** Weekly items whose series crosses a change, and a one-off; each expanded over a few weeks. */
const OCCURRENCE_CASES: Array<{ name: string; zone: string; item: { start: string; end?: string; recurrence?: Recurrence; status?: string }; from: string; to: string }> = [
  { name: 'jerusalem-weekly-across-october-change', zone: 'Asia/Jerusalem', item: { start: '2026-10-11T13:30:00.000Z', end: '2026-10-11T14:30:00.000Z', recurrence: { freq: 'weekly', byWeekday: [0] } }, from: '2026-10-10T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' },
  { name: 'jerusalem-weekly-across-march-change', zone: 'Asia/Jerusalem', item: { start: '2026-03-13T06:00:00.000Z', recurrence: { freq: 'weekly', byWeekday: [5], until: '2026-04-10' } }, from: '2026-03-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
  { name: 'new-york-twice-weekly-across-november-change', zone: 'America/New_York', item: { start: '2026-10-20T12:00:00.000Z', end: '2026-10-20T13:00:00.000Z', recurrence: { freq: 'weekly', byWeekday: [1, 4], exceptions: ['2026-11-05'] } }, from: '2026-10-25T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' },
  { name: 'new-york-weekly-in-the-repeated-hour', zone: 'America/New_York', item: { start: '2026-10-25T05:30:00.000Z', recurrence: { freq: 'weekly', byWeekday: [0] } }, from: '2026-10-24T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z' },
  { name: 'new-york-weekly-in-the-skipped-hour', zone: 'America/New_York', item: { start: '2026-03-01T07:30:00.000Z', recurrence: { freq: 'weekly', byWeekday: [0] } }, from: '2026-02-28T00:00:00.000Z', to: '2026-03-23T00:00:00.000Z' },
  { name: 'london-weekly-across-october-change', zone: 'Europe/London', item: { start: '2026-10-14T16:00:00.000Z', end: '2026-10-14T17:00:00.000Z', recurrence: { freq: 'weekly', byWeekday: [3] } }, from: '2026-10-13T00:00:00.000Z', to: '2026-11-05T00:00:00.000Z' },
  { name: 'sydney-weekly-across-october-change', zone: 'Australia/Sydney', item: { start: '2026-09-23T22:00:00.000Z', recurrence: { freq: 'weekly', byWeekday: [4] } }, from: '2026-09-20T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' },
  { name: 'shanghai-daily-on-weekdays', zone: 'Asia/Shanghai', item: { start: '2026-11-09T00:30:00.000Z', recurrence: { freq: 'weekly', byWeekday: [1, 2, 3, 4, 5] } }, from: '2026-11-11T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z' },
  { name: 'one-off-in-range', zone: 'Asia/Jerusalem', item: { start: '2026-11-12T15:00:00.000Z', end: '2026-11-12T16:00:00.000Z' }, from: '2026-11-12T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' },
  { name: 'one-off-at-the-end-is-out', zone: 'Asia/Jerusalem', item: { start: '2026-11-13T00:00:00.000Z' }, from: '2026-11-12T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' },
  { name: 'cancelled-has-none', zone: 'Asia/Jerusalem', item: { start: '2026-11-12T15:00:00.000Z', status: 'cancelled', recurrence: { freq: 'weekly', byWeekday: [4] } }, from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' }
];

const QUIET = [
  { from: '22:00', to: '07:00' },
  { from: '13:00', to: '15:00' },
  { from: '07:00', to: '07:00' }
];
const QUIET_INSTANTS: Array<[string, string]> = [
  ['Asia/Jerusalem', '2026-11-11T19:59:00.000Z'],
  ['Asia/Jerusalem', '2026-11-11T20:00:00.000Z'],
  ['Asia/Jerusalem', '2026-11-12T04:59:00.000Z'],
  ['Asia/Jerusalem', '2026-11-12T05:00:00.000Z'],
  ['Asia/Jerusalem', '2026-11-11T12:30:00.000Z'],
  ['America/New_York', '2026-11-01T03:30:00.000Z'],
  ['America/New_York', '2026-11-01T11:59:00.000Z'],
  ['Europe/London', '2026-03-28T23:30:00.000Z']
];

function timeZones() {
  const zonedToUtcCases = ZONES.flatMap(zone => LOCAL_TIMES[zone].map(([date, time]) => ({ zone, date, time, utc: toIso(zonedToUtc(date, time, zone)) })));
  const instants = [...new Set(zonedToUtcCases.map(c => c.utc))];
  const localPartsCases = ZONES.flatMap(zone =>
    instants.map(instant => ({ zone, instant, ...localParts(ms(instant), zone) }))
  );
  const occurrenceCases = OCCURRENCE_CASES.map(c => {
    const item = { id: 'item', status: 'open', ...c.item } as unknown as Item;
    return { ...c, occurrences: occurrences(item, ms(c.from), ms(c.to), c.zone) };
  });
  const quietCases = QUIET.flatMap(quiet =>
    QUIET_INSTANTS.map(([zone, instant]) => {
      const member = { quietHours: quiet } as Member;
      const inside = inQuietHours(member, ms(instant), zone);
      return { zone, quietHours: quiet, instant, inside, ...(inside ? { endsAt: toIso(quietHoursEnd(member, ms(instant), zone)) } : {}) };
    })
  );
  const summaryCases = QUIET_INSTANTS.map(([zone, instant]) => ({ zone, instant, summaryAt: toIso(nextSummaryAt(ms(instant), zone)) }));
  return {
    description:
      "The family's clock rules, computed by Homemind's clock.ts, core.ts (occurrences) and reminders.ts. zonedToUtc: a local date and time in a zone; in a daylight-saving gap it moves forward by the gap, in an overlap the earlier instant wins. localParts: weekday 0 = Sunday. occurrences: the starts of an item in [from, to); a weekly item keeps its local time across a change and skips its exceptions and dates after `until`. quietHours: `from` to `to` local, overnight allowed, equal means none; `endsAt` is the next end when inside. summaryAt: the next 20:00 local at or after the instant. Generated; do not edit by hand.",
    generator: 'scripts/family-fixtures/time.ts (ChayaLevi/digitalmate-web, branch feat/family-fixtures)',
    zonedToUtc: zonedToUtcCases,
    localParts: localPartsCases,
    occurrences: occurrenceCases,
    quietHours: quietCases,
    summary: summaryCases
  };
}

// ---------------------------------------------------------------------------------------------
// time-reminders.json

interface ReminderScenario {
  name: string;
  description: string;
  timezone?: string;
  /** Keep the seed's backup contact (a local family setting in HOPA). */
  backup?: boolean;
  steps: TimedStep[];
  /** "Remind me later" pressed by `by` on their alert for `itemId`, at `at`. */
  snoozes?: Array<{ by: Who; itemId: string; at: string }>;
  from: string;
  to: string;
}

const at = (hhmm: string, date = '2026-11-11') => `${date}T${hhmm}:00.000Z`;
const assign = (itemId: string, version: number, ownerId: string) => ({ kind: 'assign', itemId, version, ownerId });
const on = (kind: string, itemId: string, version: number, extra: Record<string, unknown> = {}) => ({ kind, itemId, version, ...extra });

const REMINDER_SCENARIOS: ReminderScenario[] = [
  {
    name: 'seed-afternoon',
    description: "The seed alone, 13:00–17:00 UTC: the critical pickup nobody owns asks everyone who could own it, three times, then both parents; Mom's confirmed swim gets one heads-up.",
    steps: [],
    from: at('13:00'),
    to: at('17:00')
  },
  {
    name: 'scene-1-dad-does-not-answer',
    description: 'Scene 1: Mom assigns the critical pickup to Dad. Dad is asked three times, ten minutes apart, then Mom (the other parent) gets the escalation.',
    steps: [{ by: 'mom', at: at('13:00'), op: assign('pickup-today', 1, 'dad') }],
    from: at('12:50'),
    to: at('15:40')
  },
  {
    name: 'scene-1-dad-confirms',
    description: 'Dad confirms after the second ask: nothing more for the pickup, no escalation, and no heads-up (he just said he is on it).',
    steps: [
      { by: 'mom', at: at('13:00'), op: assign('pickup-today', 1, 'dad') },
      { by: 'dad', at: at('13:45'), op: on('confirm', 'pickup-today', 2) }
    ],
    from: at('12:50'),
    to: at('15:40')
  },
  {
    name: 'scene-1-dad-confirms-early',
    description: 'Dad confirms before any ask went out: he gets the heads-up an hour before instead.',
    steps: [
      { by: 'mom', at: at('13:00'), op: assign('pickup-today', 1, 'dad') },
      { by: 'dad', at: at('13:05'), op: on('confirm', 'pickup-today', 2) }
    ],
    from: at('12:50'),
    to: at('15:40')
  },
  {
    name: 'scene-1-done-early',
    description: 'Dad marks the pickup done after the first ask: everything about it stops.',
    steps: [
      { by: 'mom', at: at('13:00'), op: assign('pickup-today', 1, 'dad') },
      { by: 'dad', at: at('13:35'), op: on('done', 'pickup-today', 2) }
    ],
    from: at('12:50'),
    to: at('15:40')
  },
  {
    name: 'scene-1-with-backup-contact',
    description: 'With a backup contact set, the fourth step tells the parents that the contact was messaged.',
    backup: true,
    steps: [{ by: 'mom', at: at('13:00'), op: assign('pickup-today', 1, 'dad') }],
    from: at('12:50'),
    to: at('15:40')
  },
  {
    name: 'scene-1-dad-snoozes',
    description: '"Remind me later" holds the next ask for ten minutes, then sends one; the escalation time does not move.',
    steps: [{ by: 'mom', at: at('13:00'), op: assign('pickup-today', 1, 'dad') }],
    snoozes: [{ by: 'dad', itemId: 'pickup-today', at: at('13:31') }],
    from: at('12:50'),
    to: at('15:40')
  },
  {
    name: 'assigned-late-asks-at-once',
    description: 'A task for 14:00 assigned to Mom at 13:50: the ask goes at once, not 30 minutes before.',
    steps: [{ by: 'dad', at: at('13:50'), op: { kind: 'create', item: { id: 'call-grandma', type: 'task', title: 'Call Grandma', start: at('14:00'), ownership: { state: 'assigned', ownerId: 'mom' } } } }],
    from: at('12:50'),
    to: at('15:10')
  },
  {
    name: 'open-normal-escalates-before-start',
    description: "Tomorrow's piano lesson opened to everyone: one ask 30 minutes before, then both parents 15 minutes before.",
    steps: [{ by: 'mom', at: at('13:00', '2026-11-12'), op: on('open', 'piano-tomorrow', 1) }],
    from: at('12:55', '2026-11-12'),
    to: at('16:10', '2026-11-12')
  },
  {
    name: 'teen-owner-critical-escalates-to-both-parents',
    description: 'A critical pickup assigned to Maya: when she does not answer, both parents are told.',
    steps: [{ by: 'mom', at: at('13:00'), op: assign('pickup-today', 1, 'maya') }],
    from: at('12:50'),
    to: at('15:40')
  },
  {
    name: 'parents-event-reminds-parents-only',
    description: "The parents-only counselor meeting: Mom's heads-up, and nothing for Maya.",
    steps: [],
    from: at('07:00', '2026-11-13'),
    to: at('09:30', '2026-11-13')
  },
  {
    name: 'weekly-after-the-change-in-new-york',
    description: 'A family in New York: a weekly Monday 08:00 event keeps its local time after the clocks go back on 1 November, so its heads-up moves from 11:30 to 12:30 UTC.',
    timezone: 'America/New_York',
    steps: [
      {
        by: 'mom',
        at: at('12:00', '2026-10-20'),
        op: { kind: 'create', item: { id: 'standup', type: 'event', title: 'School drop-off', start: at('12:00', '2026-10-26'), end: at('12:30', '2026-10-26'), recurrence: { freq: 'weekly', byWeekday: [1] }, ownership: { state: 'assigned', ownerId: 'mom' } } }
      }
    ],
    from: at('11:00', '2026-11-02'),
    to: at('13:30', '2026-11-02')
  },
  {
    name: 'sensitive-and-recurring-alerts',
    description: 'A sensitive weekly task assigned to Dad: the alert says it is sensitive and recurring (no title, no time on screen).',
    steps: [
      {
        by: 'mom',
        scope: 'parents',
        at: at('13:00'),
        op: { kind: 'create', item: { id: 'therapy', type: 'task', title: 'Therapy call', start: at('15:00'), sensitive: true, recurrence: { freq: 'weekly', byWeekday: [3] }, ownership: { state: 'assigned', ownerId: 'dad' } } }
      }
    ],
    from: at('12:55'),
    to: at('16:10')
  }
];

interface Delivery {
  at: string;
  recipientId: string;
  itemId: string;
  date: string;
  ask: string;
  kind: string;
  step: string;
  key: string;
  tier: string;
  itemVersion: number;
  sensitive: boolean;
  recurring?: boolean;
}

function runReminders(seed: V1State, s: ReminderScenario) {
  const log = timedLog(s.name, s.steps);
  let v1 = withTimezone(seed, s.timezone);
  const start = v1;
  let reminders: HomemindState['reminders'] = [];
  let held: HomemindState['heldAlerts'];
  let backups: HomemindState['backupMessages'];
  let next = 0;
  const out: Delivery[] = [];
  const snoozes = s.snoozes ?? [];
  for (let t = ms(s.from); t <= ms(s.to); t += MIN) {
    while (next < log.length && ms(log[next].op.at) <= t) v1 = apply(v1, log[next++], s.name);
    let hm: HomemindState = { ...homemindOf(v1, SCOPES, !!s.backup), reminders, heldAlerts: held, backupMessages: backups };
    for (const snooze of snoozes.filter(x => ms(x.at) === t)) {
      const r = activeReminderFor(hm, snooze.itemId, snooze.by);
      if (!r) throw new Error(`${s.name}: no reminder to snooze at ${snooze.at}`);
      const answered = respondToReminder(hm, r.id, snooze.by, 'snooze', t);
      if (!answered.ok) throw new Error(`${s.name}: snooze refused`);
      hm = answered.state;
    }
    const tick = tickReminders(hm, t);
    reminders = tick.state.reminders;
    held = tick.state.heldAlerts;
    backups = tick.state.backupMessages;
    for (const d of tick.deliveries) {
      if (d.alert.kind === 'batch') throw new Error(`${s.name}: a batch at ${toIso(t)}; spread the case out`);
      const r = reminders.find(x => x.id === d.alert.reminderId);
      if (!r) throw new Error(`${s.name}: an alert without a reminder`);
      const raw = d.alert.id.slice(d.alert.id.lastIndexOf('.') + 1);
      const step = raw.startsWith('s') ? 's' : raw;
      const delivery: Delivery = {
        at: toIso(t),
        recipientId: d.recipientId,
        itemId: d.alert.itemId,
        date: r.occurrenceDate,
        ask: r.ask,
        kind: d.alert.kind,
        step,
        key: `${d.alert.itemId}:${r.occurrenceDate}.${r.ask}:${step}`,
        tier: d.alert.tier,
        itemVersion: d.alert.itemVersion,
        sensitive: d.alert.sensitive
      };
      if (d.alert.recurring) delivery.recurring = true;
      out.push(delivery);
    }
  }
  if (next !== log.length) throw new Error(`${s.name}: ops after the window`);
  out.sort((a, b) => a.at.localeCompare(b.at) || a.recipientId.localeCompare(b.recipientId) || a.key.localeCompare(b.key));
  return {
    name: s.name,
    description: s.description,
    ...(s.timezone ? { timezone: s.timezone } : {}),
    backupContact: !!s.backup,
    log,
    snoozes: snoozes.map(x => ({ memberId: x.by, itemId: x.itemId, at: x.at })),
    from: s.from,
    to: s.to,
    deliveries: out,
    _start: start
  };
}

function timeReminders(seed: V1State) {
  const cases = REMINDER_SCENARIOS.map(s => {
    const { _start: _s, ...rest } = runReminders(seed, s);
    return rest;
  });
  return {
    description:
      "Reminders and escalation. Each case starts from seed.state.json (with `timezone` in place of the family's zone when given), applies `log` at each op's `at`, and runs once a minute from `from` to `to` inclusive. `deliveries` are every alert delivered, at the minute it was delivered, with its stable key `<itemId>:<date>.<ask>:<step>` (step a1-a3 attempts, e<n> escalation, b<n> backup notice, s after a snooze). A snooze is pressed by `memberId` at `at`. Members have no quiet hours here; `backupContact` says whether the family set one. Computed by Homemind's reminders.ts ticking at every minute. Generated; do not edit by hand.",
    generator: 'scripts/family-fixtures/time.ts (ChayaLevi/digitalmate-web, branch feat/family-fixtures), running Homemind reminders.ts tickReminders',
    seed: 'seed.state.json',
    cases
  };
}

// ---------------------------------------------------------------------------------------------
// time-availability.json

interface AvailabilityScenario {
  name: string;
  description: string;
  steps: TimedStep[];
  from: string;
  to: string;
  /** Instants or ranges to ask "who is unavailable then?". */
  during: Array<{ start: string; end?: string }>;
  /** Propose for the conflicts of each scope, as this member, at this time. */
  propose?: { by: Who; at: string };
}

const wedding = (id: string, start: string, end: string, who: string[], extra: Record<string, unknown> = {}) => ({
  kind: 'create',
  item: { id, type: 'event', title: 'Wedding', start, end, unavailableMemberIds: who, ...extra }
});

const AVAILABILITY_SCENARIOS: AvailabilityScenario[] = [
  {
    name: 'wedding-clashes-with-pickup-and-swim',
    description: "Scene 4: Mom is at a wedding all afternoon. Her swim and the Tuesday pickup she owns clash; the open copy goes to whoever could own it and is free.",
    steps: [
      { by: 'mom', at: at('12:31'), op: wedding('wedding', at('13:00'), at('20:00'), ['mom']) },
      { by: 'dad', at: at('12:32'), op: wedding('wedding-tue', at('12:00', '2026-11-17'), at('18:00', '2026-11-17'), ['mom', 'dad']) }
    ],
    from: at('00:00'),
    to: at('00:00', '2026-11-20'),
    during: [{ start: at('15:45') }, { start: at('14:00', '2026-11-17'), end: at('14:45', '2026-11-17') }, { start: at('21:00') }],
    propose: { by: 'mom', at: at('12:33') }
  },
  {
    name: 'weekly-item-opens-one-occurrence',
    description: 'A weekly swim owned by Dad clashes with one trip: only that date moves, as a one-off copy open to the others; the series skips it.',
    steps: [
      { by: 'dad', at: at('12:31'), op: { kind: 'create', item: { id: 'swim-weekly', type: 'event', title: 'Swimming', start: at('15:30'), end: at('16:30'), recurrence: { freq: 'weekly', byWeekday: [3] }, ownership: { state: 'assigned', ownerId: 'dad' }, forMemberIds: ['maya'] } } },
      { by: 'dad', at: at('12:32'), op: wedding('trip', at('06:00', '2026-11-18'), at('20:00', '2026-11-18'), ['dad'], { title: 'Work trip' }) }
    ],
    from: at('00:00'),
    to: at('00:00', '2026-11-26'),
    during: [{ start: at('15:30', '2026-11-18') }],
    propose: { by: 'dad', at: at('12:33') }
  },
  {
    name: 'parents-event-makes-no-family-conflict',
    description: "Mom's parents-only appointment overlaps her family swim, but per scope there is no conflict, and a teen's view has no unavailability; the busy event derived into family makes one.",
    steps: [
      { by: 'mom', scope: 'parents', at: at('12:31'), op: wedding('doctor', at('15:00'), at('17:00'), ['mom'], { title: 'Doctor' }) },
      { by: 'mom', at: at('12:40'), op: wedding('mom-busy', at('15:00'), at('17:00'), ['mom'], { title: 'Busy' }) }
    ],
    from: at('00:00'),
    to: at('00:00', '2026-11-12'),
    during: [{ start: at('15:30') }],
    propose: { by: 'mom', at: at('12:41') }
  },
  {
    name: 'nobody-free-offers-everyone-else',
    description: 'Both parents are away: the pickup Mom owns is offered to everyone else who could own it (Maya), not to nobody.',
    steps: [{ by: 'dad', at: at('12:31'), op: wedding('conference', at('10:00', '2026-11-17'), at('19:00', '2026-11-17'), ['mom', 'dad']) }],
    from: at('00:00', '2026-11-17'),
    to: at('00:00', '2026-11-18'),
    during: [{ start: at('14:30', '2026-11-17') }],
    propose: { by: 'dad', at: at('12:32') }
  }
];

function runAvailability(seed: V1State, s: AvailabilityScenario) {
  const log = timedLog(s.name, s.steps);
  const v1 = log.reduce((state, entry) => apply(state, entry, s.name), clone(seed));
  const scopeState = (scope: Scope) => homemindOf(v1, [scope], false);
  const conflicts = Object.fromEntries(SCOPES.map(scope => [scope, findConflicts(scopeState(scope), ms(s.from), ms(s.to))]));
  const both = homemindOf(v1, SCOPES, false);
  const unavailability = Object.fromEntries(['mom', 'dad', 'maya'].map(id => [id, unavailabilityFor(both, id, ms(s.from), ms(s.to))]));
  const during = s.during.map(range => ({
    ...range,
    parentDevice: unavailableDuring(both, ms(range.start), range.end ? ms(range.end) : undefined),
    familyDevice: unavailableDuring(scopeState('family'), ms(range.start), range.end ? ms(range.end) : undefined)
  }));
  const proposals: Record<string, unknown> = {};
  if (s.propose) {
    for (const scope of SCOPES) {
      const list = conflicts[scope];
      if (!list.length) continue;
      const result = proposeForConflicts(scopeState(scope), list, s.propose.by, { now: () => ms(s.propose!.at) });
      if (!result.ok) throw new Error(`${s.name}: proposal failed: ${result.message}`);
      const strip = ({ visibility: _v, sourceRefs: _r, stale: _s, mailboxIds: _m, ...rest }: Item) => rest;
      proposals[scope] = { openedItemIds: result.openedItemIds, items: result.state.items.map(strip) };
    }
  }
  return {
    name: s.name,
    description: s.description,
    log,
    from: s.from,
    to: s.to,
    conflicts,
    unavailability,
    during,
    ...(s.propose ? { propose: { memberId: s.propose.by, at: s.propose.at }, proposals } : {})
  };
}

function timeAvailability(seed: V1State) {
  return {
    description:
      "Availability. Each case starts from seed.state.json and applies `log`. `conflicts` per scope (an event and an item in different scopes never clash): items assigned to someone while an event in the same scope makes them unavailable, clashing in [from, to). `unavailability` per member: who is unavailable when, from the events that member may see. `during`: who is unavailable at an instant or in a range, on a device with both scopes and on one with family only. `proposals` per scope: the items of that scope after opening every conflict as `propose.memberId` at `propose.at`, and the ids opened (a weekly item: its occurrence is cancelled and a one-off copy `<itemId>-<date>` opened). Computed by Homemind's availability.ts. Generated; do not edit by hand.",
    generator: 'scripts/family-fixtures/time.ts (ChayaLevi/digitalmate-web, branch feat/family-fixtures), running Homemind availability.ts',
    seed: 'seed.state.json',
    cases: AVAILABILITY_SCENARIOS.map(s => runAvailability(seed, s))
  };
}

/** Every time fixture file, by file name. */
export function buildTimeFixtures(): Map<string, unknown> {
  const seed = seedV1();
  return new Map<string, unknown>([
    ['time-zones.json', timeZones()],
    ['time-reminders.json', timeReminders(seed)],
    ['time-availability.json', timeAvailability(seed)]
  ]);
}
