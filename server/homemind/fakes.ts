/**
 * Simulated services for the demo (T7.2): the kindergarten group, a pizza vendor, babysitters, a
 * sample inbox and a weather forecast. In process, deterministic, and **labelled "Simulated" on every
 * card** (the view carries `simulated: true`; the screens render the badge).
 *
 * Nothing here reaches the world. The three that can "do" something (post a reply in the group, order
 * pizza, message a babysitter) are `simulated` adapters for actions.ts, so they run only behind the
 * action guard: a parent's tap with a confirmation token, or autonomy level 4 where the adapter allows
 * it (only the group reply does; an order or a message to a sitter always waits for a tap).
 *
 * What the services remember lives in `state.services` (reset with the demo). The rest is fixed
 * fixtures, with dates relative to the demo clock so the board always fits the script.
 * Pure apart from the adapters, which read and replace the state through the caller's `ServicesDeps`.
 */
import type { ActionAdapter, AdapterRegistry } from './actions';
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import type { BabysitterMessage, GroupMessage, HomemindState, Member, PizzaOrder, ServicesState, ServicesView } from './types';
import { ID_PATTERN } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const SIMULATED_LABEL = { en: 'Simulated', zh: '模拟' } as const;

/** Adapter ids. `pizza` matches the seeded Friday rule's template. */
export const ADAPTER_IDS = { groupReply: 'group-reply', pizza: 'pizza', babysitter: 'babysitter' } as const;

// --- kindergarten group ----------------------------------------------------------------------------------

export const KINDERGARTEN_GROUP = { id: 'kg-sunflower', name: 'Sunflower class parents', nameZh: '向日葵班家长群' } as const;

/**
 * What the demo control posts, in order. No printed dates ("本周四", "下周一"), so the messages never go
 * stale (the screenshot fixture's fixed dates did, see PROGRESS open issues). Apples and cake are still
 * free in the sign-up, for Scene 2 (T7.4 claims one). The last one is the non-urgent note of Scene 5.
 */
export const GROUP_FIXTURE: ReadonlyArray<Pick<GroupMessage, 'id' | 'author' | 'authorZh' | 'from' | 'text'>> = [
  {
    id: 'grp-msg-1',
    author: 'Teacher Wang',
    authorZh: '王老师',
    from: 'teacher',
    text: '各位家长好！本周四下午3点在班里举办秋季美食派对🎉 请家长们接龙认领要带的食物，够8个小朋友吃。周三晚上8点前接龙完毕，谢谢配合！'
  },
  {
    id: 'grp-msg-2',
    author: "Lele's mom",
    authorZh: '乐乐妈妈',
    from: 'parent',
    text: '#接龙\n周四美食派对 认领食物（苹果、橙子、蛋糕、饼干、香蕉、葡萄）\n\n1. 乐乐妈妈 香蕉\n2. 小雨爸爸 葡萄'
  },
  {
    id: 'grp-msg-3',
    author: 'Teacher Wang',
    authorZh: '王老师',
    from: 'teacher',
    text: '另外提醒：下周一前请把秋游回执交回班里，不着急，谢谢！'
  }
];

export function seedServices(): ServicesState {
  return { group: { id: KINDERGARTEN_GROUP.id, messages: [], posted: 0 }, pizzaOrders: [], babysitterMessages: [] };
}

/** The services' state, or a fresh one for a file saved before T7.2. */
export const servicesOf = (state: HomemindState): ServicesState => state.services ?? seedServices();

const withServices = (state: HomemindState, services: ServicesState): HomemindState => ({ ...state, services });

export type PostResult = { ok: true; state: HomemindState; message: GroupMessage; remaining: number } | { ok: false; code: 'no_more_messages'; message: string };

/** The demo control: the next fixture message arrives in the group, now. */
export function postNextGroupMessage(state: HomemindState, now: number): PostResult {
  const services = servicesOf(state);
  const next = GROUP_FIXTURE[services.group.posted];
  if (!next) return { ok: false, code: 'no_more_messages', message: 'Every sample group message has been posted. Reset the demo to start again' };
  const message: GroupMessage = { ...next, version: 1, at: toIso(now), simulated: true };
  const posted = services.group.posted + 1;
  return {
    ok: true,
    message,
    remaining: GROUP_FIXTURE.length - posted,
    state: withServices(state, { ...services, group: { ...services.group, messages: [...services.group.messages, message], posted } })
  };
}

/** How a parent appears in the group: "Noa's mom" / "诺娅妈妈", after the family's youngest child. */
export function groupAuthorFor(state: HomemindState, member: Member): { author: string; authorZh: string } {
  const child = state.family.members.filter(m => m.role === 'child').sort((a, b) => (a.age ?? 99) - (b.age ?? 99))[0];
  const zh = member.nameZh ?? member.name;
  if (!child) return { author: member.name, authorZh: zh };
  return { author: `${child.name}'s ${member.name.toLowerCase()}`, authorZh: `${child.nameZh ?? child.name}${zh}` };
}

// --- pizza vendor ----------------------------------------------------------------------------------------

export const PIZZA_VENDOR = {
  id: 'sim-pizza',
  name: 'Simulated pizza shop',
  nameZh: '模拟披萨店',
  currency: 'CNY',
  opensAt: '11:00',
  closesAt: '21:30',
  /** Closed all day on these weekdays (0 = Sunday). */
  closedWeekdays: [1] as readonly number[],
  deliveryMinutes: 40,
  menu: [
    { id: 'margherita-l', name: 'Large margherita', nameZh: '大号玛格丽特披萨', price: 89, serves: 3 },
    { id: 'margherita-m', name: 'Medium margherita', nameZh: '中号玛格丽特披萨', price: 65, serves: 2 },
    { id: 'pepperoni-l', name: 'Large pepperoni', nameZh: '大号意式香肠披萨', price: 99, serves: 3 },
    { id: 'veggie-m', name: 'Medium vegetable', nameZh: '中号蔬菜披萨', price: 59, serves: 2 },
    { id: 'kids-s', name: "Kids' cheese pizza", nameZh: '儿童芝士披萨', price: 39, serves: 1 }
  ]
} as const;

/** Whether the shop is open at `now` in the family's zone. */
export function pizzaOpenAt(now: number, timezone: string): boolean {
  const local = localParts(now, timezone);
  if (PIZZA_VENDOR.closedWeekdays.includes(local.weekday)) return false;
  return local.time >= PIZZA_VENDOR.opensAt && local.time < PIZZA_VENDOR.closesAt;
}

export type PizzaQuote = { ok: true; lines: PizzaOrder['lines']; total: number; currency: string } | { ok: false; error: string };

/** Prices an order from the menu. The vendor, not whoever prepared the card, decides the price. */
export function quotePizza(items: unknown): PizzaQuote {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) return { ok: false, error: 'An order has 1 to 10 lines' };
  const lines: PizzaOrder['lines'] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'Each line is {id, qty}' };
    const { id, qty } = entry as Record<string, unknown>;
    const dish = PIZZA_VENDOR.menu.find(d => d.id === id);
    if (!dish) return { ok: false, error: `Not on the menu: ${String(id).slice(0, 40)}` };
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 10) return { ok: false, error: 'qty is a whole number from 1 to 10' };
    lines.push({ itemId: dish.id, qty, price: dish.price });
  }
  return { ok: true, lines, total: lines.reduce((sum, l) => sum + l.price * l.qty, 0), currency: PIZZA_VENDOR.currency };
}

// --- babysitters -----------------------------------------------------------------------------------------

/** Ranked by the family (1 first). Canned availability by weekday, local times. */
export const BABYSITTERS = [
  { id: 'sitter-zhang', rank: 1, name: 'Auntie Zhang', nameZh: '张阿姨', note: 'Knows Noa well', noteZh: '很熟悉诺娅', weekdays: [1, 2, 3, 4], from: '18:00', to: '22:30' },
  { id: 'sitter-chen', rank: 2, name: 'Xiao Chen (student)', nameZh: '小陈（大学生）', note: 'Evenings and weekends', noteZh: '晚上和周末', weekdays: [0, 5, 6], from: '17:00', to: '23:00' },
  { id: 'sitter-li', rank: 3, name: 'Auntie Li', nameZh: '李阿姨', note: 'Daytime only', noteZh: '只在白天', weekdays: [0, 1, 2, 3, 4, 5, 6], from: '09:00', to: '17:00' }
] as const;

const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Whether a sitter is free for the whole window `from`-`to` on that local date. */
export function sitterAvailable(sitterId: string, date: string, from: string, to: string): boolean {
  const sitter = BABYSITTERS.find(s => s.id === sitterId);
  if (!sitter || !DATE.test(date)) return false;
  return (sitter.weekdays as readonly number[]).includes(weekdayOf(date)) && from >= sitter.from && to <= sitter.to && from < to;
}

/** The message Homemind drafts for a sitter: when, and nothing about why or where the parents are. */
export function draftBabysitterMessage(sitterId: string, date: string, from: string, to: string, lang: 'en' | 'zh'): string {
  const sitter = BABYSITTERS.find(s => s.id === sitterId);
  const name = sitter ? (lang === 'zh' ? sitter.nameZh : sitter.name) : '';
  const [, month, day] = date.split('-').map(Number);
  return lang === 'zh'
    ? `${name}您好！请问${month}月${day}日${from}到${to}您能来帮忙照看孩子吗？谢谢！`
    : `Hi ${name}, could you babysit on ${month}/${day} from ${from} to ${to}? Thank you!`;
}

// --- inbox -----------------------------------------------------------------------------------------------

export const APPROVED_SENDERS = [
  { address: 'teacher@sunflower-kg.example', name: 'Sunflower class teacher', nameZh: '向日葵班老师' },
  { address: 'notices@city-library.example', name: 'City library', nameZh: '市图书馆' },
  { address: 'info@swim-club.example', name: 'Swim club', nameZh: '游泳俱乐部' }
] as const;

/** Sample mail. `to` is whose mailbox it is in; a sender not on the approved list is never shown. */
const INBOX_FIXTURE = [
  {
    id: 'mail-1',
    hoursAgo: 3,
    to: ['mom', 'dad'],
    from: 'teacher@sunflower-kg.example',
    subject: 'Class photo day next Wednesday',
    subjectZh: '下周三拍班级合影',
    body: 'Please dress the children in the class T-shirt next Wednesday.',
    bodyZh: '下周三请给孩子穿班服。'
  },
  {
    id: 'mail-2',
    hoursAgo: 20,
    to: ['mom'],
    from: 'notices@city-library.example',
    subject: 'Your books are due tomorrow',
    subjectZh: '您借的书明天到期',
    body: 'Two books on your card are due tomorrow.',
    bodyZh: '您借阅的两本书明天到期。'
  },
  {
    id: 'mail-3',
    hoursAgo: 26,
    to: ['dad'],
    from: 'info@swim-club.example',
    subject: 'Pool closed next Saturday',
    subjectZh: '下周六泳池关闭',
    body: 'The pool is closed next Saturday for cleaning. Lessons on other days are as usual.',
    bodyZh: '下周六泳池清洁关闭，其他日子的课程照常。'
  },
  {
    id: 'mail-4',
    hoursAgo: 1,
    to: ['mom'],
    from: 'deals@shop.example',
    subject: 'Big sale today only',
    subjectZh: '今日大促',
    body: 'Not from an approved sender: never shown.',
    bodyZh: '非白名单发件人：不显示。'
  }
] as const;

export function inboxFor(memberId: string, now: number): ServicesView['inbox']['messages'] {
  return INBOX_FIXTURE.filter(m => (m.to as readonly string[]).includes(memberId))
    .map(m => ({ m, sender: APPROVED_SENDERS.find(s => s.address === m.from) }))
    .filter(({ sender }) => sender !== undefined)
    .map(({ m, sender }) => ({
      id: m.id,
      at: toIso(now - m.hoursAgo * HOUR),
      from: m.from,
      fromName: sender!.name,
      fromNameZh: sender!.nameZh,
      subject: m.subject,
      subjectZh: m.subjectZh,
      body: m.body,
      bodyZh: m.bodyZh
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// --- weather ---------------------------------------------------------------------------------------------

const FORECAST = [
  { summary: 'Sunny', summaryZh: '晴', low: 12, high: 21, rainChance: 0 },
  { summary: 'Cloudy', summaryZh: '多云', low: 10, high: 18, rainChance: 20 },
  { summary: 'Light rain', summaryZh: '小雨', low: 9, high: 15, rainChance: 70 }
] as const;

export function weatherFor(now: number, timezone: string): ServicesView['weather']['days'] {
  const today = localParts(now, timezone).date;
  return FORECAST.map((day, i) => ({ date: addDays(today, i), ...day }));
}

// --- the view screens get --------------------------------------------------------------------------------

/** Every simulated service as one member's screen shows it. The inbox is that member's own mailbox only. */
export function servicesViewFor(state: HomemindState, memberId: string, now: number): ServicesView {
  const services = servicesOf(state);
  const zone = state.family.timezone;
  const today = localParts(now, zone).date;
  const weekday = weekdayOf(today);
  return {
    group: {
      id: KINDERGARTEN_GROUP.id,
      name: KINDERGARTEN_GROUP.name,
      nameZh: KINDERGARTEN_GROUP.nameZh,
      messages: services.group.messages,
      remaining: Math.max(0, GROUP_FIXTURE.length - services.group.posted),
      simulated: true
    },
    pizza: {
      name: PIZZA_VENDOR.name,
      nameZh: PIZZA_VENDOR.nameZh,
      open: pizzaOpenAt(now, zone),
      opensAt: PIZZA_VENDOR.opensAt,
      closesAt: PIZZA_VENDOR.closesAt,
      currency: PIZZA_VENDOR.currency,
      menu: PIZZA_VENDOR.menu.map(d => ({ ...d })),
      ...(services.pizzaOrders.length ? { lastOrder: services.pizzaOrders[services.pizzaOrders.length - 1] } : {}),
      simulated: true
    },
    babysitters: {
      date: today,
      sitters: BABYSITTERS.map(s => {
        const available = (s.weekdays as readonly number[]).includes(weekday);
        return { id: s.id, name: s.name, nameZh: s.nameZh, rank: s.rank, note: s.note, noteZh: s.noteZh, available, ...(available ? { from: s.from, to: s.to } : {}) };
      }),
      simulated: true
    },
    inbox: { approvedSenders: APPROVED_SENDERS.map(s => ({ ...s })), messages: inboxFor(memberId, now), simulated: true },
    weather: { days: weatherFor(now, zone), simulated: true }
  };
}

// --- adapters (behind the action guard) -------------------------------------------------------------------

/** How an adapter reads and replaces the caller's state. `set` is synchronous: actions.ts saves after the run. */
export interface ServicesDeps {
  get(): HomemindState;
  set(state: HomemindState): void;
  now(): number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanText = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !CONTROL.test(v) ? v.trim() : null);
/** Card fields a screen shows (T7.3 added the Chinese ones); any adapter accepts them. */
const CARD_KEYS = ['title', 'summary', 'titleZh', 'summaryZh'];

function extraKeys(payload: Record<string, unknown>, keys: string[]): string | null {
  const unknown = Object.keys(payload).filter(k => !keys.includes(k) && !CARD_KEYS.includes(k));
  return unknown.length ? `Unknown field: ${unknown[0].slice(0, 40)}` : null;
}

function nextId(prefix: string, taken: readonly { id: string }[]): string {
  for (let n = taken.length + 1; ; n++) if (!taken.some(t => t.id === `${prefix}-${n}`)) return `${prefix}-${n}`;
}

const aborted = (signal: AbortSignal) => (signal.aborted ? { ok: false as const, error: 'The service did not answer in time' } : null);

/** Posts a reply in the simulated group as a parent: a sign-up claim, or a correction of one. */
function groupReplyAdapter(deps: ServicesDeps): ActionAdapter {
  return {
    id: ADAPTER_IDS.groupReply,
    mode: 'simulated',
    area: 'group',
    // T7.4: at level 4 Homemind may claim in the simulated group on its own (and only there).
    autoAllowed: true,
    validate(payload) {
      const extra = extraKeys(payload, ['groupId', 'text', 'kind', 'replyTo', 'asMemberId']);
      if (extra) return extra;
      if (payload.groupId !== KINDERGARTEN_GROUP.id) return 'Unknown group';
      if (!cleanText(payload.text, 200)) return 'text is 1 to 200 characters';
      if (payload.kind !== 'claim' && payload.kind !== 'correction') return 'kind is claim or correction';
      if (payload.replyTo !== undefined && (typeof payload.replyTo !== 'string' || !ID_PATTERN.test(payload.replyTo))) return 'replyTo is a message id';
      if (typeof payload.asMemberId !== 'string' || !ID_PATTERN.test(payload.asMemberId)) return 'asMemberId is a member id';
      return null;
    },
    async execute(payload, signal) {
      const stop = aborted(signal);
      if (stop) return stop;
      const state = deps.get();
      const services = servicesOf(state);
      const member = state.family.members.find(m => m.id === payload.asMemberId && m.role === 'parent' && m.hasAccount);
      if (!member) return { ok: false, error: 'Only a parent can post in the group' };
      if (payload.replyTo !== undefined && !services.group.messages.some(m => m.id === payload.replyTo)) return { ok: false, error: 'That group message is not there' };
      const message: GroupMessage = {
        id: nextId('grp-reply', services.group.messages.filter(m => m.from === 'family')),
        version: 1,
        at: toIso(deps.now()),
        ...groupAuthorFor(state, member),
        from: 'family',
        text: cleanText(payload.text, 200) as string,
        replyKind: payload.kind as 'claim' | 'correction',
        ...(typeof payload.replyTo === 'string' ? { replyTo: payload.replyTo } : {}),
        simulated: true
      };
      deps.set(withServices(state, { ...services, group: { ...services.group, messages: [...services.group.messages, message] } }));
      return { ok: true, result: { messageId: message.id, simulated: true } };
    }
  };
}

/** Orders from the simulated pizza shop. Always needs a tap: never at level 4 on its own. */
function pizzaAdapter(deps: ServicesDeps): ActionAdapter {
  return {
    id: ADAPTER_IDS.pizza,
    mode: 'simulated',
    area: 'food',
    autoAllowed: false,
    validate(payload) {
      const extra = extraKeys(payload, ['vendor', 'items', 'total', 'currency', 'deliverAt']);
      if (extra) return extra;
      if (payload.vendor !== PIZZA_VENDOR.id) return 'Unknown vendor';
      const quote = quotePizza(payload.items);
      if (!quote.ok) return quote.error;
      if (payload.currency !== quote.currency) return `currency is ${quote.currency}`;
      // The card must show the vendor's price: an order whose total differs is refused, not "corrected".
      if (payload.total !== quote.total) return `The total does not match the menu (${quote.total} ${quote.currency})`;
      if (payload.deliverAt !== undefined && (typeof payload.deliverAt !== 'string' || !Number.isFinite(Date.parse(payload.deliverAt)))) return 'deliverAt is a date and time';
      return null;
    },
    async execute(payload, signal) {
      const stop = aborted(signal);
      if (stop) return stop;
      const state = deps.get();
      const now = deps.now();
      if (!pizzaOpenAt(now, state.family.timezone)) return { ok: false, error: 'The pizza shop is closed (simulated)' };
      const quote = quotePizza(payload.items);
      if (!quote.ok) return { ok: false, error: quote.error };
      const services = servicesOf(state);
      const order: PizzaOrder = {
        id: nextId('pz', services.pizzaOrders),
        at: toIso(now),
        lines: quote.lines,
        total: quote.total,
        currency: quote.currency,
        deliverAt: typeof payload.deliverAt === 'string' ? toIso(Date.parse(payload.deliverAt)) : toIso(now + PIZZA_VENDOR.deliveryMinutes * MINUTE),
        simulated: true
      };
      deps.set(withServices(state, { ...services, pizzaOrders: [...services.pizzaOrders, order] }));
      return { ok: true, result: { orderId: order.id, total: order.total, currency: order.currency, deliverAt: order.deliverAt, simulated: true } };
    }
  };
}

/** Sends the drafted message to a simulated sitter, who answers from the canned availability. Always a tap. */
function babysitterAdapter(deps: ServicesDeps): ActionAdapter {
  return {
    id: ADAPTER_IDS.babysitter,
    mode: 'simulated',
    area: 'childcare',
    autoAllowed: false,
    validate(payload) {
      const extra = extraKeys(payload, ['sitterId', 'date', 'from', 'to', 'text']);
      if (extra) return extra;
      if (!BABYSITTERS.some(s => s.id === payload.sitterId)) return 'Unknown babysitter';
      if (typeof payload.date !== 'string' || !DATE.test(payload.date)) return 'date is YYYY-MM-DD';
      if (typeof payload.from !== 'string' || !HHMM.test(payload.from) || typeof payload.to !== 'string' || !HHMM.test(payload.to)) return 'from and to are HH:MM';
      if (payload.from >= payload.to) return 'from is before to';
      if (!cleanText(payload.text, 300)) return 'text is 1 to 300 characters';
      return null;
    },
    async execute(payload, signal) {
      const stop = aborted(signal);
      if (stop) return stop;
      const state = deps.get();
      const services = servicesOf(state);
      const [sitterId, date, from, to] = [payload.sitterId, payload.date, payload.from, payload.to] as string[];
      const message: BabysitterMessage = {
        id: nextId('sit', services.babysitterMessages),
        at: toIso(deps.now()),
        sitterId,
        date,
        from,
        to,
        text: cleanText(payload.text, 300) as string,
        reply: sitterAvailable(sitterId, date, from, to) ? 'yes' : 'no',
        simulated: true
      };
      deps.set(withServices(state, { ...services, babysitterMessages: [...services.babysitterMessages, message] }));
      return { ok: true, result: { messageId: message.id, reply: message.reply, simulated: true } };
    }
  };
}

/** The demo's adapters. All simulated: the demo has no real adapter. */
export function createSimulatedAdapters(deps: ServicesDeps): AdapterRegistry {
  const list = [groupReplyAdapter(deps), pizzaAdapter(deps), babysitterAdapter(deps)];
  return Object.freeze(Object.fromEntries(list.map(a => [a.id, a])));
}

/** Local `HH:MM` to an ISO instant on a local date, for callers that build payloads (T7.3). */
export const localIso = (date: string, time: string, timezone: string): string => toIso(zonedToUtc(date, time, timezone));
