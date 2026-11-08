/**
 * The demo family and the board it starts with. Names are fictional.
 *
 * Times are relative to the injected `now`, in the family's time zone, so a reset always gives a
 * board that fits the demo script:
 *   Scene 1  today's kindergarten pickup, critical, nobody owns it yet (Mom assigns it to Dad)
 *   Scene 2  the saved cake preference with its reason and scope, and a hard peanut allergy
 *   Scene 3  what today holds for Noa (pickup, swimming), for "Noa is sick"
 *   Scene 4  next Tuesday's pickup, owned by Mom (the wedding will conflict), and the Friday pizza rule
 *   Privacy  one "Parents only", sensitive item that Maya must never see a trace of
 * Pure: no I/O.
 */
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import { seedServices } from './fakes';
import { STATE_SCHEMA_VERSION } from './types';
import type { Family, HomemindState, Item, Preference, Rule } from './types';

/** The demo family lives in the zone of the machine running the bridge, so the board matches its clock. */
export function machineTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export interface SeedOptions {
  /** Demo time in ms (the clock's `now()`). */
  now: number;
  /** IANA zone. Defaults to the machine's zone. */
  timezone?: string;
  /** Real time in ms, recorded as `seededAt`. Defaults to `now`. */
  realNow?: number;
}

const HOUR = 60 * 60 * 1000;
const HALF_HOUR = HOUR / 2;

function seedFamily(timezone: string): Family {
  return {
    id: 'demo-family',
    name: 'Our family',
    nameZh: '我们家',
    timezone,
    members: [
      { id: 'mom', name: 'Mom', nameZh: '妈妈', role: 'parent', hasAccount: true, lang: 'en', quietHours: { from: '22:00', to: '07:00' } },
      { id: 'dad', name: 'Dad', nameZh: '爸爸', role: 'parent', hasAccount: true, lang: 'zh', quietHours: { from: '22:00', to: '07:00' } },
      { id: 'maya', name: 'Maya', nameZh: '玛雅', role: 'teen', age: 15, hasAccount: true, lang: 'en', quietHours: { from: '22:30', to: '07:00' } },
      { id: 'noa', name: 'Noa', nameZh: '诺娅', role: 'child', age: 5, hasAccount: false, lang: 'en' }
    ],
    backupContact: { name: 'Grandma Lin', nameZh: '林奶奶', channel: 'sms', simulated: true },
    autonomy: { default: 3 },
    weekStartsOn: 1,
    paused: false
  };
}

/** Days from `weekday` to the next `target` weekday, at least 1. */
function daysUntil(weekday: number, target: number): number {
  return (target - weekday + 7) % 7 || 7;
}

function item(fields: Partial<Item> & Pick<Item, 'id' | 'type' | 'title'>): Item {
  return {
    forMemberIds: [],
    ownership: { state: 'none' },
    visibility: 'family',
    sensitive: false,
    importance: 'normal',
    unavailableMemberIds: [],
    status: 'open',
    source: { kind: 'manual', label: 'Added by Mom' },
    createdBy: 'mom',
    version: 1,
    ...fields
  };
}

function seedItems(now: number, timezone: string): Item[] {
  const today = localParts(now, timezone);
  const at = (date: string, time: string) => toIso(zonedToUtc(date, time, timezone));
  const tomorrow = addDays(today.date, 1);
  const inTwoDays = addDays(today.date, 2);
  const tuesday = addDays(today.date, daysUntil(today.weekday, 2));
  const sunday = addDays(today.date, daysUntil(today.weekday, 0));

  // Today's pickup is about two hours ahead whenever the demo starts, so the clock jump has room.
  const pickupStart = Math.ceil((now + 2 * HOUR) / HALF_HOUR) * HALF_HOUR;

  return [
    item({
      id: 'pickup-today',
      type: 'event',
      title: 'Kindergarten pickup',
      titleZh: '幼儿园接孩子',
      start: toIso(pickupStart),
      end: toIso(pickupStart + HALF_HOUR),
      forMemberIds: ['noa'],
      importance: 'critical'
    }),
    item({
      id: 'swim-today',
      type: 'event',
      title: "Noa's swimming lesson",
      titleZh: '诺娅的游泳课',
      start: toIso(pickupStart + 2 * HALF_HOUR),
      end: toIso(pickupStart + 4 * HALF_HOUR),
      forMemberIds: ['noa'],
      ownership: { state: 'assigned', ownerId: 'mom', confirmed: true }
    }),
    item({
      id: 'piano-tomorrow',
      type: 'event',
      title: "Maya's piano lesson",
      titleZh: '玛雅的钢琴课',
      start: at(tomorrow, '17:00'),
      end: at(tomorrow, '18:00'),
      forMemberIds: ['maya'],
      source: { kind: 'manual', label: 'Added by Maya' },
      createdBy: 'maya'
    }),
    item({
      id: 'library-books',
      type: 'task',
      title: 'Return the library books',
      titleZh: '还图书馆的书',
      start: at(tomorrow, '00:00'),
      allDay: true,
      ownership: { state: 'open', candidateIds: ['mom', 'dad', 'maya'] }
    }),
    item({
      id: 'pickup-tuesday',
      type: 'event',
      title: 'Kindergarten pickup',
      titleZh: '幼儿园接孩子',
      start: at(tuesday, '16:30'),
      end: at(tuesday, '17:00'),
      forMemberIds: ['noa'],
      importance: 'critical',
      ownership: { state: 'assigned', ownerId: 'mom', confirmed: true }
    }),
    item({
      id: 'counselor-meeting',
      type: 'event',
      title: "Meeting with Maya's school counselor",
      titleZh: '与玛雅的学校辅导老师见面',
      start: at(inTwoDays, '10:00'),
      end: at(inTwoDays, '11:00'),
      forMemberIds: ['mom', 'dad'],
      visibility: 'parents',
      sensitive: true,
      ownership: { state: 'assigned', ownerId: 'mom', confirmed: true }
    }),
    item({
      id: 'family-dinner',
      type: 'event',
      title: "Family dinner at Grandma's",
      titleZh: '去奶奶家吃饭',
      start: at(sunday, '18:00'),
      end: at(sunday, '20:00'),
      forMemberIds: ['mom', 'dad', 'maya', 'noa']
    }),
    item({
      id: 'family-dinner-flowers',
      type: 'preparation',
      title: 'Buy flowers for Grandma',
      titleZh: '给奶奶买花',
      start: at(sunday, '12:00'),
      parentEventId: 'family-dinner',
      ownership: { state: 'open', candidateIds: ['mom', 'dad'] }
    })
  ];
}

function seedPreferences(): Preference[] {
  return [
    {
      id: 'pref-noa-cake',
      aboutMemberId: 'noa',
      text: 'For kindergarten parties, bake a cake',
      textZh: '幼儿园聚会时，烤一个蛋糕',
      reason: 'Noa enjoys baking it with us the most',
      reasonZh: '诺娅最喜欢和我们一起烤蛋糕',
      strength: 'soft',
      scope: 'kindergarten-party'
    },
    {
      id: 'pref-noa-peanuts',
      aboutMemberId: 'noa',
      text: 'No peanuts',
      textZh: '不吃花生',
      reason: 'Allergy',
      reasonZh: '过敏',
      strength: 'hard'
    }
  ];
}

function seedRules(): Rule[] {
  return [
    {
      id: 'rule-friday-pizza',
      title: 'Friday pizza night',
      titleZh: '周五披萨之夜',
      trigger: { kind: 'weekly', weekday: 5, time: '18:30', leadMinutes: 30 },
      actionTemplate: {
        adapter: 'pizza',
        // The simulated shop's menu ids and price (fakes.ts): 2 x 89 CNY.
        payload: { vendor: 'sim-pizza', items: [{ id: 'margherita-l', qty: 2 }], total: 178, currency: 'CNY' }
      },
      limits: { maxPrice: 250, currency: 'CNY' },
      area: 'food',
      enabled: true,
      createdBy: 'mom'
    }
  ];
}

export function seedState(options: SeedOptions): HomemindState {
  const timezone = options.timezone ?? machineTimezone();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    family: seedFamily(timezone),
    items: seedItems(options.now, timezone),
    reminders: [],
    preferences: seedPreferences(),
    rules: seedRules(),
    actionCards: [],
    activity: [],
    whys: [],
    services: seedServices(),
    clockOffsetMs: 0,
    seededAt: toIso(options.realNow ?? options.now)
  };
}
