/**
 * Fixtures for HOPA's family logic beyond the board (plan task C3): judgment, summaries, situations,
 * intents. Every expected value is what Homemind's own code computes, unchanged. Files: `logic-*.json`.
 */
import { judgeText } from '../../server/homemind/judgment';
import { summaryFor } from '../../server/homemind/summary';
import { applySuggestions, planSituation, startSituation } from '../../server/homemind/situations';
import type { SituationReport } from '../../server/homemind/situations';
import { fixedClock } from '../../server/homemind/clock';
import { createSimulatedAdapters } from '../../server/homemind/fakes';
import type { Item } from '../../server/homemind/types';
import type { HomemindState, Reminder } from '../../server/homemind/types';
import { SCOPES } from './adapter';
import type { V1State } from './adapter';
import { seedV1 } from './build';
import { apply, homemindOf, timedLog } from './time';
import type { TimedStep } from './time';

const GENERATOR = 'scripts/family-fixtures/logic.ts (ChayaLevi/digitalmate-web, branch feat/family-fixtures)';

/**
 * Message texts for judgment. Homemind's own test texts, then the places where a port could slip:
 * JavaScript's `\b` is ASCII-only (Java's is not), `\s` includes the full-width space U+3000 (Java's
 * does not), `/i` is case-insensitive for ASCII, `^` with `/m` matches after any line break, and the
 * order of the rules decides the reason.
 */
const JUDGMENT_TEXTS: string[] = [
  // Homemind's tests
  '明天停课，请家长注意',
  'Pickup moved to 3pm, urgent!',
  'Photos from today are up',
  'Bring a hat on Friday',
  '下周三交作品，不急',
  '下周一前请把回执交回',
  '谢谢大家的配合',
  // each rule, both languages
  '紧急通知：明天提前放学',
  'Please reply ASAP',
  'This is an EMERGENCY',
  'Come right away please',
  '#接龙 周五水果\n1. 张妈妈 苹果',
  '接龙\n1. 苹果',
  'Sign-up sheet for the picnic',
  'sign up list is open',
  'No rush, reply whenever you can',
  '不着急，周五前回复就行',
  'Party tomorrow at 4',
  '今晚记得签字',
  'This week we read chapter 3',
  'Next week: museum trip',
  '下个月开家长会',
  '星期五带水壶',
  '周日不上课',
  'See you on Monday',
  'Thanks everyone',
  '',
  // order of rules: urgent wins over not-urgent, not-urgent over a date, sign-up over a date
  '不着急，但是明天要交',
  '紧急！不着急的事情以后再说',
  '#接龙 明天的水果',
  'next week, urgent',
  // word boundaries next to CJK (JS \b is ASCII-only)
  'asap吗',
  '今天urgent事项',
  'urgently needed',
  'todays plan',
  'Mondays are busy',
  'emergency.',
  // whitespace: U+3000 before 接龙 on a line start; tabs; a later line
  '　接龙 周五水果',
  '\t接龙',
  '大家好\n  接龙\n1. 苹果',
  'Let us 接龙 later',
  // case
  'URGENT',
  'Tomorrow',
  'NEXT WEEK',
  // quoting trims the match
  'Sign up list ',
  'right   away'
];

function judgment() {
  return {
    description:
      "Message judgment (Homemind's judgment.ts, judgeText): the tier and the reason from fixed rules over the message's words, never the model, and the words matched (`quote`, absent for no-date). Rules in order: urgent-words (urgent), sign-up (timed), not-urgent (summary), soon (timed), next-week (summary), a weekday (soon, timed); none: no-date (summary). The texts include the places a port could slip: JavaScript's \\b is ASCII-only, \\s includes U+3000, /i, ^ with /m. Generated; do not edit by hand.",
    generator: GENERATOR,
    cases: JUDGMENT_TEXTS.map(text => ({ text, ...judgeText(text) }))
  };
}

// ---------------------------------------------------------------------------------------------
// logic-summary.json

export const at = (hhmm: string, date = '2026-11-11') => `${date}T${hhmm}:00.000Z`;

interface SummaryScenario {
  name: string;
  description: string;
  steps: TimedStep[];
  /** Reminders that reached these members, got no answer and moved to the summary (local in HOPA). */
  unanswered?: Array<{ itemId: string; memberIds: string[] }>;
  /** Instants to take each member's daily and weekly summary at. */
  nows: string[];
}

const SUMMARY_SCENARIOS: SummaryScenario[] = [
  {
    name: 'seed',
    description: 'The seed: Mom owns the swim and the Tuesday pickup, the library task is open, the family dinner, the parents-only counselor meeting.',
    steps: [],
    nows: [at('12:30'), at('19:30'), at('21:00'), at('19:00', '2026-11-15')]
  },
  {
    name: 'away-and-asked',
    description: 'Mom is at a wedding tomorrow (family) and Dad at a parents-only appointment; Maya is asked to take the piano lesson; Dad owns a task with no date; Dad gets the Tuesday pickup.',
    steps: [
      { by: 'mom', at: at('12:31'), op: { kind: 'create', item: { id: 'wedding', type: 'event', title: 'Wedding', start: at('10:00', '2026-11-12'), end: at('20:00', '2026-11-12'), unavailableMemberIds: ['mom'] } } },
      { by: 'mom', scope: 'parents', at: at('12:32'), op: { kind: 'create', item: { id: 'doctor', type: 'event', title: 'Doctor', start: at('08:00', '2026-11-13'), end: at('09:00', '2026-11-13'), unavailableMemberIds: ['dad'] } } },
      { by: 'mom', at: at('12:33'), op: { kind: 'open', itemId: 'piano-tomorrow', version: 1, candidateIds: ['maya', 'dad'] } },
      { by: 'dad', at: at('12:34'), op: { kind: 'create', item: { id: 'fix-bike', type: 'task', title: 'Fix the bike', ownership: { state: 'assigned', ownerId: 'dad' } } } },
      { by: 'mom', at: at('12:35'), op: { kind: 'assign', itemId: 'pickup-tuesday', version: 1, ownerId: 'dad' } }
    ],
    nows: [at('12:40'), at('19:00', '2026-11-15')]
  },
  {
    name: 'weekly-and-unanswered',
    description: 'A weekly event, a done item, and a reminder Maya did not answer: it is listed as unanswered even with no occurrence in the period.',
    steps: [
      { by: 'mom', at: at('12:31'), op: { kind: 'create', item: { id: 'choir', type: 'event', title: 'Choir', start: at('15:00', '2026-11-10'), end: at('16:00', '2026-11-10'), recurrence: { freq: 'weekly', byWeekday: [2, 4] } } } },
      { by: 'mom', at: at('12:32'), op: { kind: 'done', itemId: 'swim-today', version: 1 } },
      { by: 'mom', at: at('12:33'), op: { kind: 'create', item: { id: 'old-form', type: 'task', title: 'Sign the form', start: at('08:00', '2026-11-09'), ownership: { state: 'assigned', ownerId: 'maya' } } } }
    ],
    unanswered: [{ itemId: 'old-form', memberIds: ['maya'] }],
    nows: [at('12:40'), at('18:00', '2026-11-12')]
  }
];

function summaryState(v1: V1State, unanswered: SummaryScenario['unanswered']): HomemindState {
  const hm = homemindOf(v1, SCOPES, false);
  const reminders = (unanswered ?? []).map(
    (u, n) =>
      ({
        id: `rem-u${n}`,
        itemId: u.itemId,
        occurrenceDate: '2026-11-09',
        occurrenceStart: at('08:00', '2026-11-09'),
        ask: 'confirm',
        recipientIds: u.memberIds,
        firstAt: at('07:30', '2026-11-09'),
        intervalMinutes: 0,
        maxAttempts: 1,
        tier: 'summary',
        attempts: 1,
        status: 'sent',
        summaryAt: at('18:00', '2026-11-09')
      }) as Reminder
  );
  return { ...hm, reminders, messageJudgments: undefined, summaries: undefined };
}

function summaries(seed: V1State) {
  return {
    description:
      "Each member's evening summary (`daily`: what is left of that day and the next) and week ahead (`weekly`: the seven days after), from Homemind's summary.ts summaryFor, as previews (none delivered). `toDo`: theirs (owner), given and not confirmed (unconfirmed), an open item they could take (asked), or a reminder that reached them and got no answer (unanswered, listed in `unanswered`; local in HOPA). `away`: from events that member may see. `everyone`: events in the period not already in toDo. The family's week starts on Monday (`weekStartsOn` 1). Group messages are left out (none here). Generated; do not edit by hand.",
    generator: GENERATOR,
    seed: 'seed.state.json',
    weekStartsOn: 1,
    cases: SUMMARY_SCENARIOS.map(s => {
      const log = timedLog(s.name, s.steps);
      const v1 = log.reduce((state, entry) => apply(state, entry, s.name), structuredClone(seed));
      const hm = summaryState(v1, s.unanswered);
      const views = s.nows.flatMap(now =>
        ['mom', 'dad', 'maya'].flatMap(memberId =>
          (['daily', 'weekly'] as const).map(kind => {
            const { messages: _m, ...view } = summaryFor(hm, memberId, kind, Date.parse(now))!;
            return { now, memberId, ...view };
          })
        )
      );
      return { name: s.name, description: s.description, log, unanswered: s.unanswered ?? [], summaries: views };
    })
  };
}

// ---------------------------------------------------------------------------------------------
// logic-situations.json

interface SituationScenario {
  name: string;
  description: string;
  steps: TimedStep[];
  reports: Array<{ reporter: string; memberId: string; date: string; now: string; mayWrite?: boolean }>;
}

const noaEvents: TimedStep[] = [
  { by: 'mom', at: at('12:21'), op: { kind: 'create', item: { id: 'noa-ballet', type: 'event', title: 'Ballet', start: at('14:00', '2026-11-04'), end: at('15:00', '2026-11-04'), forMemberIds: ['noa'], recurrence: { freq: 'weekly', byWeekday: [3] } } } },
  { by: 'mom', at: at('12:22'), op: { kind: 'create', item: { id: 'noa-dentist', type: 'event', title: 'Dentist', start: at('16:00'), end: at('16:30'), forMemberIds: ['noa'] } } },
  { by: 'mom', at: at('12:23'), op: { kind: 'create', item: { id: 'noa-dropoff', type: 'event', title: 'Drop-off at the party', start: at('17:00'), forMemberIds: ['noa'] } } },
  { by: 'mom', scope: 'parents', at: at('12:24'), op: { kind: 'create', item: { id: 'noa-therapist', type: 'event', title: 'Speech therapist', start: at('17:30'), end: at('18:00'), forMemberIds: ['noa'] } } },
  { by: 'mom', at: at('12:25'), op: { kind: 'create', item: { id: 'early-event', type: 'event', title: 'Morning show', start: at('06:00'), end: at('07:00'), forMemberIds: ['noa'] } } }
];

const SITUATION_SCENARIOS: SituationScenario[] = [
  {
    name: 'noa-sick-today',
    description: "Noa (a child) is sick today. Her pickup and drop-off are cancelled, the dentist is postponed a week, ballet is skipped once, the parents-only therapist is a suggestion only for a parent's view, an event that already started is left alone, and both parents are asked who stays home.",
    steps: noaEvents,
    reports: [
      { reporter: 'mom', memberId: 'noa', date: '2026-11-11', now: at('12:30') },
      { reporter: 'maya', memberId: 'noa', date: '2026-11-11', now: at('12:30') },
      { reporter: 'dad', memberId: 'noa', date: '2026-11-11', now: at('12:30'), mayWrite: false }
    ]
  },
  {
    name: 'maya-sick-tomorrow',
    description: 'Maya (a teen) is sick tomorrow: her piano lesson is postponed, the task she owns opens to the others; no stay-home task for a teen.',
    steps: [
      { by: 'mom', at: at('12:21'), op: { kind: 'create', item: { id: 'maya-walk-dog', type: 'task', title: 'Walk the dog', start: at('16:00', '2026-11-12'), ownership: { state: 'assigned', ownerId: 'maya' } } } }
    ],
    reports: [{ reporter: 'mom', memberId: 'maya', date: '2026-11-12', now: at('12:30') }]
  },
  {
    name: 'noa-sick-both-parents-away',
    description: 'Both parents are away on the day Noa is sick: every parent is still asked (nobody is free), and the away entries say why.',
    steps: [
      { by: 'mom', at: at('12:21'), op: { kind: 'create', item: { id: 'conference', type: 'event', title: 'Conference', start: at('06:00', '2026-11-17'), end: at('18:00', '2026-11-17'), unavailableMemberIds: ['mom', 'dad'] } } }
    ],
    reports: [{ reporter: 'dad', memberId: 'noa', date: '2026-11-17', now: at('12:30') }]
  },
  {
    name: 'refusals',
    description: 'A day already over, a day too far ahead, an unknown member, and a reporter without an account.',
    steps: [],
    reports: [
      { reporter: 'mom', memberId: 'noa', date: '2026-11-10', now: at('12:30') },
      { reporter: 'mom', memberId: 'noa', date: '2026-11-18', now: at('12:30') },
      { reporter: 'mom', memberId: 'grandpa', date: '2026-11-11', now: at('12:30') },
      { reporter: 'noa', memberId: 'noa', date: '2026-11-11', now: at('12:30') }
    ]
  }
];

const stripItem = ({ visibility: _v, sourceRefs: _r, stale: _s, mailboxIds: _m, ...rest }: Item) => rest;

function situations(seed: V1State) {
  return {
    description:
      "\"Noa is sick\" (Homemind's situations.ts). For each report: `refused` with Homemind's code, or `plan` (planSituation: the suggestions from the reporter's view, the parents who are free, who is away), `stayHome` (the task startSituation creates for a sick child, open to the free parents, or to all parents when none is; proposed when `mayWrite` is false), and `itemsAfter` (every item, by scope, after the stay-home task and after applying every suggestion as the reporter). Cards to the teacher or a babysitter are simulated services and are left out. Generated; do not edit by hand.",
    generator: GENERATOR,
    seed: 'seed.state.json',
    cases: SITUATION_SCENARIOS.map(sc => {
      const log = timedLog(sc.name, sc.steps);
      const v1 = log.reduce((state, entry) => apply(state, entry, sc.name), structuredClone(seed));
      const reports = sc.reports.map(r => {
        const now = Date.parse(r.now);
        const box = { state: homemindOf(v1, SCOPES, false), now };
        const adapters = createSimulatedAdapters({ get: () => box.state, set: st => void (box.state = st), now: () => box.now });
        const report: SituationReport = { kind: 'sick', memberId: r.memberId, date: r.date, summary: 'sick' };
        const mayWrite = r.mayWrite ?? true;
        const started = startSituation(box.state, r.reporter, report, { now, clock: fixedClock(now), adapters, mayWrite });
        if (!started.ok) return { ...r, mayWrite, refused: started.code };
        if (!started.created) throw new Error(`${sc.name}: not created`);
        const plan = planSituation(homemindOf(v1, SCOPES, false), r.reporter, report, now);
        const stayHomeId = started.situation.stayHomeItemId;
        const stayHome = stayHomeId ? stripItem(started.state.items.find(i => i.id === stayHomeId)!) : undefined;
        const decided = applySuggestions(started.state, started.situation.id, 'all', r.reporter, fixedClock(now));
        const after = decided.ok ? decided.state : started.state;
        const byScope = (scope: string) => after.items.filter(i => i.visibility === scope).map(stripItem);
        return {
          ...r,
          mayWrite,
          plan,
          ...(stayHome ? { stayHome } : {}),
          applied: decided.ok ? decided.applied : [],
          failed: decided.ok ? decided.failed.map(f => ({ proposalId: f.proposalId, code: f.code })) : [],
          itemsAfter: { family: byScope('family'), parents: byScope('parents') }
        };
      });
      return { name: sc.name, description: sc.description, log, reports };
    })
  };
}

/** Every logic fixture file, by file name. */
export function buildLogicFixtures(): Map<string, unknown> {
  const seed = seedV1();
  return new Map<string, unknown>([
    ['logic-judgment.json', judgment()],
    ['logic-summary.json', summaries(seed)],
    ['logic-situations.json', situations(seed)]
  ]);
}
