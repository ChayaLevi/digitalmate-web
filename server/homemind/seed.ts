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
import { DEFAULT_STORES } from './shopping';
import { STATE_SCHEMA_VERSION } from './types';
import type { Family, HomemindState, Item, Preference, Rule, ShoppingItem, ShoppingState } from './types';

/** The demo family lives in the zone of the machine running the bridge, so the board matches its clock. */
export function machineTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** An IANA zone name the runtime knows, such as `Asia/Shanghai`. */
export function isValidTimezone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type TimezoneSetting = { ok: true; zone: string; source: 'env' | 'machine' } | { ok: false; error: string };

/**
 * The demo family's zone (T10.2), from `HOMEMIND_TIMEZONE`. Unset: the machine's zone, except in cloud
 * mode, where the server runs in UTC and a silent UTC would put "today's pickup" on the wrong day.
 */
export function timezoneSetting(value: string | undefined, cloud: boolean): TimezoneSetting {
  const zone = value?.trim() ?? '';
  if (!zone) {
    if (cloud) return { ok: false, error: 'HOMEMIND_TIMEZONE is not set. Cloud mode needs the family time zone, for example HOMEMIND_TIMEZONE=Asia/Shanghai' };
    return { ok: true, zone: machineTimezone(), source: 'machine' };
  }
  if (!isValidTimezone(zone)) return { ok: false, error: `HOMEMIND_TIMEZONE is not a known IANA time zone (for example Asia/Shanghai): "${zone.slice(0, 64)}"` };
  return { ok: true, zone, source: 'env' };
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

/** A few things already on the shopping lists, so the demo has something to take and tick off. Nobody is going yet. */
function seedShopping(now: number): ShoppingState {
  const addedAt = toIso(now - 3 * 60 * 60 * 1000);
  const item = (n: number, storeId: string, addedBy: string, name: string, nameZh: string, qty = 1, note?: string, noteZh?: string): ShoppingItem => ({
    id: `shop-${n}`,
    storeId,
    name,
    nameZh,
    qty,
    ...(note ? { note, noteZh } : {}),
    addedBy,
    addedAt
  });
  const items = [
    item(1, 'supermarket', 'mom', 'Milk', '牛奶', 2),
    item(2, 'supermarket', 'dad', 'Eggs', '鸡蛋', 1, 'a pack of 12', '一盒 12 个'),
    item(3, 'supermarket', 'maya', 'Apples', '苹果', 1, '1 kg', '1 公斤'),
    item(4, 'supermarket', 'mom', 'Bread', '面包', 2),
    item(5, 'pharmacy', 'mom', 'Vitamin D drops', '维生素 D 滴剂', 1, 'for Noa', '给诺娅'),
    item(6, 'pharmacy', 'dad', 'Plasters', '创可贴', 3),
    item(7, 'post-office', 'mom', 'Pick up the parcel', '取包裹', 1, 'the slip is on the fridge', '取件单在冰箱上'),
    item(8, 'mall', 'maya', 'Sneakers for Maya', '玛雅的运动鞋', 1, 'size 38', '38 码'),
    item(9, 'mall', 'mom', 'Birthday gift for Grandma', '给奶奶的生日礼物', 1, 'a warm scarf', '一条暖和的围巾'),
    item(10, 'hardware', 'dad', 'Light bulbs', '灯泡', 2, 'E27', 'E27'),
    item(11, 'hardware', 'dad', 'AA batteries', '5 号电池', 4, 'for the remote', '给遥控器用'),
    item(12, 'market', 'mom', 'Tomatoes', '西红柿', 1, '1 kg', '1 公斤'),
    item(13, 'market', 'maya', 'Bananas', '香蕉', 6),
    item(14, 'market', 'mom', 'Fresh herbs', '新鲜香草', 1, 'parsley and coriander', '欧芹和香菜')
  ];
  return { stores: DEFAULT_STORES.map(s => ({ ...s })), items, lastItem: items.length };
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
    shopping: seedShopping(options.now),
    clockOffsetMs: 0,
    seededAt: toIso(options.realNow ?? options.now),
    // T8.2: summaries count from the seed, so a reset after 20:00 does not send tonight's at once.
    summaryCheckedAt: toIso(options.now)
  };
}
