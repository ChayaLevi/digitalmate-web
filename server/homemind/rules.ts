/**
 * Standing rules (T7.3). A rule never acts: it only **prepares** an action card that waits for a
 * parent's tap (actions.ts), and a card nobody taps expires visibly.
 *
 * The one rule kind for now is a weekly order from the simulated pizza shop ("Friday pizza night").
 * `leadMinutes` before the occurrence the rule looks at the family's calendar:
 *   - who is at home then (an event's `unavailableMemberIds`), and resizes the order to fit;
 *   - stops, with no card, when the price is over the rule's cap, the shop is closed then, or nobody is home;
 *   - if both parents are out, also drafts a message to the first free babysitter on the family's list,
 *     as a second card (it needs its own tap too).
 * Every run is recorded (`state.ruleRuns`) with a `Why` (`source: 'rule'`), so a rule that did nothing
 * is visible as well. While a card waits, a calendar change is checked again on every tick: the old card
 * is withdrawn ("the calendar changed") and a new one prepared, so a tap always runs what was shown.
 *
 * Pure apart from what `prepareCard` hashes: no I/O. The bridge calls `runRules` on every scheduler tick
 * and after every change, and `prepareRuleNow` from the demo control.
 */
import type { AdapterRegistry } from './actions';
import { prepareCard, withdrawCard } from './actions';
import { unavailabilityFor } from './availability';
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import { BABYSITTERS, PIZZA_VENDOR, draftBabysitterMessage, pizzaOpenAt, quotePizza, sitterAvailable } from './fakes';
import type { ActionCard, HomemindState, Member, Rule, RuleRun, Why } from './types';
import { ID_PATTERN } from './types';

const MINUTE = 60_000;
/** How long the family is counted for a meal: who is away at some point in the hour from the delivery. */
const MEAL_MINUTES = 60;
/** A babysitter is asked for at most this window: from the meal to the latest evening time. */
const SITTER_LATEST = '22:30';
const MAX_RUNS = 100;

export const RULE_LIMITS = { rules: 20, title: 80, leadMinutes: { min: 5, max: 24 * 60 } } as const;

const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();
const runsOf = (state: HomemindState): RuleRun[] => state.ruleRuns ?? [];
const nameOf = (m: Member | undefined, lang: 'en' | 'zh') => (m ? (lang === 'zh' ? m.nameZh ?? m.name : m.name) : '');

/** The next occurrence of a weekly trigger strictly after `now`: its local date and instant. */
export function nextOccurrence(rule: Rule, now: number, timezone: string): { date: string; at: number } {
  const today = localParts(now, timezone).date;
  for (let d = 0; d <= 7; d++) {
    const date = addDays(today, d);
    if (weekdayOf(date) !== rule.trigger.weekday) continue;
    const at = zonedToUtc(date, rule.trigger.time, timezone);
    if (at > now) return { date, at };
  }
  // Unreachable for a valid weekday: day 7 is the same weekday as today and later than now.
  const date = addDays(today, 7);
  return { date, at: zonedToUtc(date, rule.trigger.time, timezone) };
}

// --- sizing ---------------------------------------------------------------------------------------------

type Line = { id: string; qty: number };

const dishOf = (id: string) => PIZZA_VENDOR.menu.find(d => d.id === id);
const kindOf = (id: string) => id.split('-')[0];

/**
 * The template's order resized for `home` of `family` people. With everyone home it is the template as
 * the family set it. Otherwise the servings shrink in proportion (rounded up), and a one-pizza-kind
 * order picks the cheapest mix of that pizza's sizes that covers them (2 large for 4 becomes 1 large +
 * 1 medium for 3, 1 large for 2). An order of several kinds scales each line, at least 1.
 */
export function sizeOrder(template: Line[], home: number, family: number): Line[] {
  if (home >= family || family <= 0) return template.map(l => ({ ...l }));
  if (template.length !== 1) return template.map(l => ({ id: l.id, qty: Math.max(1, Math.ceil((l.qty * home) / family)) }));
  const dish = dishOf(template[0].id);
  if (!dish) return template.map(l => ({ ...l }));
  const target = Math.max(1, Math.ceil((dish.serves * template[0].qty * home) / family));
  const sizes = PIZZA_VENDOR.menu.filter(d => kindOf(d.id) === kindOf(dish.id)).sort((a, b) => b.serves - a.serves);
  let best: { lines: Line[]; price: number; count: number } | null = null;
  const search = (i: number, lines: Line[], servings: number, price: number, count: number) => {
    if (servings >= target) {
      if (!best || price < best.price || (price === best.price && count < best.count)) best = { lines: [...lines], price, count };
      return;
    }
    if (i >= sizes.length || count >= 10) return;
    for (let qty = Math.ceil((target - servings) / sizes[i].serves); qty >= 0; qty--) {
      search(i + 1, qty ? [...lines, { id: sizes[i].id, qty }] : lines, servings + qty * sizes[i].serves, price + qty * sizes[i].price, count + qty);
    }
  };
  search(0, [], 0, 0, 0);
  const found = best as { lines: Line[] } | null;
  return found ? found.lines : template.map(l => ({ ...l }));
}

// --- planning -------------------------------------------------------------------------------------------

export interface RulePlan {
  rule: Rule;
  date: string;
  at: number;
  home: string[];
  away: Array<{ memberId: string; eventId: string }>;
  outcome: 'prepared' | 'stopped';
  reason?: RuleRun['reason'];
  /** The pizza card's payload, when prepared. */
  payload?: Record<string, unknown>;
  total?: number;
  /** Both parents are out: the sitter message, or null when no sitter on the list is free. */
  sitter?: { payload: Record<string, unknown>; sitterId: string; from: string; to: string; expiresAt: number } | null;
}

/** Who is away at the meal, from the events that make them unavailable (seen as a parent: parents see every item). */
function awayAt(state: HomemindState, at: number): { home: string[]; away: RulePlan['away']; entries: ReturnType<typeof unavailabilityFor> } {
  const viewer = state.family.members.find(m => m.role === 'parent')?.id ?? state.family.members[0]?.id ?? '';
  const entries = unavailabilityFor(state, viewer, at, at + MEAL_MINUTES * MINUTE).filter(e => Date.parse(e.start) < at + MEAL_MINUTES * MINUTE && Date.parse(e.end) > at);
  const away: RulePlan['away'] = [];
  for (const e of entries) if (!away.some(a => a.memberId === e.memberId)) away.push({ memberId: e.memberId, eventId: e.eventId });
  const home = state.family.members.filter(m => !away.some(a => a.memberId === m.id)).map(m => m.id);
  return { home, away, entries };
}

function sitterPlan(state: HomemindState, rule: Rule, date: string, at: number, entries: ReturnType<typeof unavailabilityFor>): RulePlan['sitter'] {
  const zone = state.family.timezone;
  const parents = state.family.members.filter(m => m.role === 'parent');
  // From the meal (always in the future, so the card can wait for a tap) to when a parent is back.
  let start = at;
  let end = zonedToUtc(date, SITTER_LATEST, zone);
  for (const parent of parents) {
    const mine = entries.filter(e => e.memberId === parent.id);
    if (!mine.length) return undefined;
    start = Math.max(start, Math.min(...mine.map(e => Date.parse(e.start))));
    end = Math.min(end, Math.max(...mine.map(e => Date.parse(e.end))));
  }
  if (!(end > start)) return null;
  const from = localParts(start, zone).time;
  const to = localParts(end, zone).time;
  const sitter = [...BABYSITTERS].sort((a, b) => a.rank - b.rank).find(s => sitterAvailable(s.id, date, from, to));
  if (!sitter) return null;
  const [, month, day] = date.split('-').map(Number);
  const text = draftBabysitterMessage(sitter.id, date, from, to, 'zh');
  return {
    sitterId: sitter.id,
    from,
    to,
    expiresAt: start,
    payload: {
      sitterId: sitter.id,
      date,
      from,
      to,
      text,
      title: `Babysitter for ${month}/${day} (${rule.title})`,
      titleZh: `${month}月${day}日请保姆（${rule.titleZh ?? rule.title}）`,
      summary: `Both parents are out ${from}–${to}. Message to ${sitter.name}, first free on the family's list: “${text}” Simulated: nothing is sent until a parent taps, and then only to the simulated sitter.`,
      summaryZh: `${from}–${to} 父母都不在家。发给名单上第一位有空的${sitter.nameZh}：“${text}” 模拟：家长点一下之前不会发送，且只发给模拟保姆。`
    }
  };
}

/** What the rule would prepare for its occurrence on `date` at `at`, from the calendar as it is now. */
export function planRule(state: HomemindState, rule: Rule, date: string, at: number): RulePlan {
  const zone = state.family.timezone;
  const { home, away, entries } = awayAt(state, at);
  const base: RulePlan = { rule, date, at, home, away, outcome: 'stopped' };
  const template = rule.actionTemplate.payload;
  const items = Array.isArray(template.items) ? (template.items as Line[]) : [];
  if (rule.actionTemplate.adapter !== 'pizza' || template.vendor !== PIZZA_VENDOR.id || !quotePizza(items).ok) return { ...base, reason: 'invalid' };
  if (home.length === 0) return { ...base, reason: 'nobody_home' };
  const sized = sizeOrder(items, home.length, state.family.members.length);
  const quote = quotePizza(sized);
  if (!quote.ok) return { ...base, reason: 'invalid' };
  if (rule.limits.maxPrice !== undefined && quote.total > rule.limits.maxPrice) return { ...base, reason: 'over_cap', total: quote.total };
  if (!pizzaOpenAt(at, zone)) return { ...base, reason: 'closed', total: quote.total };

  const time = localParts(at, zone).time;
  const linesEn = quote.lines.map(l => `${l.qty} × ${dishOf(l.itemId)?.name ?? l.itemId}`).join(', ');
  const linesZh = quote.lines.map(l => `${dishOf(l.itemId)?.nameZh ?? l.itemId} × ${l.qty}`).join('，');
  const awayEn = away.map(a => nameOf(state.family.members.find(m => m.id === a.memberId), 'en')).join(', ');
  const awayZh = away.map(a => nameOf(state.family.members.find(m => m.id === a.memberId), 'zh')).join('、');
  const cap = rule.limits.maxPrice !== undefined ? ` (cap ${rule.limits.maxPrice} ${quote.currency})` : '';
  const capZh = rule.limits.maxPrice !== undefined ? `（上限 ${rule.limits.maxPrice} ${quote.currency}）` : '';
  const payload: Record<string, unknown> = {
    vendor: PIZZA_VENDOR.id,
    items: sized,
    total: quote.total,
    currency: quote.currency,
    deliverAt: toIso(at),
    title: `${rule.title}: order`,
    titleZh: `${rule.titleZh ?? rule.title}：下单`,
    summary: `${linesEn} · ${quote.total} ${quote.currency}${cap} · delivery ${time} · for ${home.length} at home${away.length ? ` (${awayEn} away)` : ''}. Simulated shop: nothing is really ordered.`,
    summaryZh: `${linesZh} · ${quote.total} ${quote.currency}${capZh} · ${time} 送达 · 在家 ${home.length} 人${away.length ? `（${awayZh}不在家）` : ''}。模拟店铺：不会真的下单。`
  };
  const parentsOut = state.family.members.filter(m => m.role === 'parent').every(p => away.some(a => a.memberId === p.id));
  return { ...base, outcome: 'prepared', payload, total: quote.total, ...(parentsOut ? { sitter: sitterPlan(state, rule, date, at, entries) ?? null } : {}) };
}

/** The `Why` of one run, in both languages, with the rule, who is away (and the event), the price and the shop. */
function whyFor(state: HomemindState, plan: RulePlan, id: string): Why {
  const { rule } = plan;
  const members = state.family.members;
  const author = members.find(m => m.id === rule.createdBy);
  const cur = PIZZA_VENDOR.currency;
  const time = localParts(plan.at, state.family.timezone).time;
  const awayEn = plan.away.map(a => `${nameOf(members.find(m => m.id === a.memberId), 'en')} is away (${state.items.find(i => i.id === a.eventId)?.title ?? 'an event'})`).join('; ');
  const awayZh = plan.away.map(a => {
    const event = state.items.find(i => i.id === a.eventId);
    return `${nameOf(members.find(m => m.id === a.memberId), 'zh')}不在家（${event?.titleZh ?? event?.title ?? '有安排'}）`;
  }).join('；');
  const homeLine = `${plan.home.length} of ${members.length} at home at ${time}${awayEn ? `: ${awayEn}` : ''}.`;
  const homeLineZh = `${time} 在家 ${plan.home.length}/${members.length} 人${awayZh ? `：${awayZh}` : ''}。`;
  let what: string;
  let whatZh: string;
  if (plan.outcome === 'prepared') {
    what = plan.home.length < members.length ? `The order was made smaller to fit: ${plan.total} ${cur}.` : `The usual order: ${plan.total} ${cur}.`;
    whatZh = plan.home.length < members.length ? `订单按人数减少：${plan.total} ${cur}。` : `照常下单：${plan.total} ${cur}。`;
    if (plan.sitter) {
      what += ` Both parents are out ${plan.sitter.from}–${plan.sitter.to}, so a message to a babysitter was drafted.`;
      whatZh += ` ${plan.sitter.from}–${plan.sitter.to} 父母都不在家，所以起草了给保姆的消息。`;
    } else if (plan.sitter === null) {
      what += ' Both parents are out, but no babysitter on the list is free then.';
      whatZh += ' 父母都不在家，但名单上的保姆那时都没空。';
    }
    what += ' Nothing happens until a parent taps the card.';
    whatZh += ' 家长点一下卡片之前，什么都不会发生。';
  } else if (plan.reason === 'over_cap') {
    what = `Stopped: the order would cost ${plan.total} ${cur}, over the rule's cap of ${rule.limits.maxPrice} ${cur}. No card was prepared.`;
    whatZh = `已停止：订单需 ${plan.total} ${cur}，超过规则上限 ${rule.limits.maxPrice} ${cur}。没有准备卡片。`;
  } else if (plan.reason === 'closed') {
    what = `Stopped: the simulated pizza shop is closed at ${time}. No card was prepared.`;
    whatZh = `已停止：模拟披萨店 ${time} 不营业。没有准备卡片。`;
  } else if (plan.reason === 'nobody_home') {
    what = 'Stopped: nobody is at home then. No card was prepared.';
    whatZh = '已停止：那时家里没人。没有准备卡片。';
  } else {
    what = 'Stopped: the rule’s order is not one the shop accepts. No card was prepared.';
    whatZh = '已停止：规则里的订单店铺无法接受。没有准备卡片。';
  }
  const basis: Why['basis'] = [{ kind: 'rule', ref: rule.id, note: `${rule.title}, set by ${author?.name ?? rule.createdBy}: every week, prepared ${rule.trigger.leadMinutes} minutes ahead` }];
  for (const a of plan.away) basis.push({ kind: 'availability', ref: a.eventId, note: `${nameOf(members.find(m => m.id === a.memberId), 'en')} is away` });
  if (plan.total !== undefined) basis.push({ kind: 'price', note: `${plan.total} ${cur}${rule.limits.maxPrice !== undefined ? `, cap ${rule.limits.maxPrice} ${cur}` : ''}` });
  basis.push({ kind: 'vendor', note: `${PIZZA_VENDOR.name} (simulated), open ${PIZZA_VENDOR.opensAt}–${PIZZA_VENDOR.closesAt}` });
  const ruleName = author ? `"${rule.title}" (set by ${author.name})` : `"${rule.title}"`;
  const ruleNameZh = `“${rule.titleZh ?? rule.title}”${author ? `（${nameOf(author, 'zh')}设置）` : ''}`;
  return {
    id,
    summary: `From the Homemind rule ${ruleName}. ${homeLine} ${what}`,
    summaryZh: `来自 Homemind 规则${ruleNameZh}。${homeLineZh}${whatZh}`,
    basis,
    source: 'rule'
  };
}

// --- running --------------------------------------------------------------------------------------------

/** A free id `<base>`, `<base>-2`, ... among `taken`, cut to fit the id pattern. */
function freeId(base: string, taken: (id: string) => boolean): string {
  const root = base.slice(0, 56).replace(/-+$/, '');
  if (!taken(root)) return root;
  for (let n = 2; ; n++) if (!taken(`${root}-${n}`)) return `${root}-${n}`;
}

const cardOf = (state: HomemindState, id: string | undefined): ActionCard | undefined => (id ? state.actionCards.find(c => c.id === id) : undefined);

/** The newest run for the rule's occurrence on `date`. */
export const latestRun = (state: HomemindState, ruleId: string, date: string): RuleRun | undefined =>
  [...runsOf(state)].reverse().find(r => r.ruleId === ruleId && r.date === date);

/** What a plan would show, as one string: two plans with the same key prepare the same cards. */
function planKey(plan: RulePlan): string {
  return JSON.stringify([plan.outcome, plan.reason ?? '', plan.home, plan.away, plan.total ?? null, plan.payload ?? null, plan.sitter === undefined ? 'no' : plan.sitter === null ? 'none' : plan.sitter.payload]);
}

/** Whether a fresh plan differs from what the run was recorded from. */
const planChanged = (run: RuleRun, plan: RulePlan): boolean => run.planKey !== planKey(plan);

export interface RuleStep {
  state: HomemindState;
  changed: boolean;
  /** Runs recorded in this step. */
  runs: RuleRun[];
}

/** Records a run for a plan: prepares its cards (pizza, and the sitter's when drafted), its Why and the run. */
function record(state: HomemindState, plan: RulePlan, trigger: RuleRun['trigger'], adapters: AdapterRegistry, now: number): { state: HomemindState; run: RuleRun } {
  const { rule } = plan;
  const runId = freeId(`run-${rule.id}-${plan.date}`, id => runsOf(state).some(r => r.id === id));
  const whyId = `why-${runId}`.slice(0, 64);
  let next: HomemindState = state;
  const refs = [...new Set(plan.away.map(a => a.eventId))];
  const run: RuleRun = {
    id: runId,
    ruleId: rule.id,
    date: plan.date,
    occurrence: toIso(plan.at),
    at: toIso(now),
    trigger,
    outcome: plan.outcome,
    home: plan.home,
    away: plan.away,
    whyId,
    planKey: planKey(plan),
    ...(plan.reason ? { reason: plan.reason } : {}),
    ...(plan.total !== undefined ? { total: plan.total, currency: PIZZA_VENDOR.currency } : {}),
    ...(rule.limits.maxPrice !== undefined ? { maxPrice: rule.limits.maxPrice } : {})
  };
  if (plan.outcome === 'prepared' && plan.payload) {
    const cardId = freeId(`${rule.id}-${plan.date}`, id => next.actionCards.some(c => c.id === id));
    const prepared = prepareCard(
      next,
      { id: cardId, adapter: rule.actionTemplate.adapter, payload: plan.payload, expiresAt: toIso(plan.at), whyId, title: plan.payload.title as string, titleZh: plan.payload.titleZh as string, ruleId: rule.id, refs },
      adapters,
      now
    );
    if (prepared.ok) {
      next = prepared.state;
      run.cardId = cardId;
    } else {
      run.outcome = 'stopped';
      run.reason = 'invalid';
    }
    if (prepared.ok && plan.sitter) {
      const sitterCardId = freeId(`${rule.id}-${plan.date}-sitter`, id => next.actionCards.some(c => c.id === id));
      const sitter = prepareCard(
        next,
        { id: sitterCardId, adapter: 'babysitter', payload: plan.sitter.payload, expiresAt: toIso(plan.sitter.expiresAt), whyId, title: plan.sitter.payload.title as string, titleZh: plan.sitter.payload.titleZh as string, ruleId: rule.id, refs },
        adapters,
        now
      );
      if (sitter.ok) {
        next = sitter.state;
        run.sitter = 'drafted';
        run.sitterCardId = sitterCardId;
      } else {
        run.sitter = 'none_free';
      }
    } else if (prepared.ok && plan.sitter !== undefined) {
      run.sitter = 'none_free';
    }
  }
  const why = whyFor(next, run.outcome === plan.outcome ? plan : { ...plan, outcome: 'stopped', reason: 'invalid' }, whyId);
  const runs = [...runsOf(next), run].slice(-MAX_RUNS);
  return { run, state: { ...next, ruleRuns: runs, whys: [...next.whys.filter(w => w.id !== whyId), why] } };
}

/** Withdraws the run's pending cards (pizza and sitter) with a reason. */
function withdrawRun(state: HomemindState, run: RuleRun, reason: string, now: number): HomemindState {
  let next = state;
  for (const id of [run.cardId, run.sitterCardId]) if (id) next = withdrawCard(next, id, reason, now).state;
  return next;
}

const CALENDAR_CHANGED = 'The calendar changed, so Homemind replaced this card';

/**
 * One step for every enabled rule, on every scheduler tick and after every change. Not while paused
 * (the stop button stops the rules). For the rule's next occurrence:
 *   - inside the lead time, with no run yet: plan it and record the run;
 *   - a run whose card still waits, or that stopped: plan again, and if anything changed (who is home,
 *     the order, the stop), withdraw the old cards and record a new run.
 * A card a parent tapped, cancelled, or that expired is left alone.
 */
export function runRules(state: HomemindState, now: number, adapters: AdapterRegistry): RuleStep {
  if (state.family.paused) return { state, changed: false, runs: [] };
  let next = state;
  const runs: RuleRun[] = [];
  for (const rule of state.rules) {
    if (!rule.enabled || rule.trigger.kind !== 'weekly') continue;
    const { date, at } = nextOccurrence(rule, now, state.family.timezone);
    const last = latestRun(next, rule.id, date);
    if (!last) {
      if (now < at - rule.trigger.leadMinutes * MINUTE) continue;
      const done = record(next, planRule(next, rule, date, at), 'schedule', adapters, now);
      next = done.state;
      runs.push(done.run);
      continue;
    }
    const waiting = cardOf(next, last.cardId)?.status === 'pending';
    if (!waiting && last.outcome !== 'stopped') continue;
    const plan = planRule(next, rule, date, at);
    if (!planChanged(last, plan)) continue;
    next = withdrawRun(next, last, CALENDAR_CHANGED, now);
    const done = record(next, plan, 'calendar', adapters, now);
    next = done.state;
    runs.push(done.run);
  }
  return { state: next, changed: runs.length > 0, runs };
}

export type PrepareNowResult = { ok: true; state: HomemindState; run: RuleRun; existing: boolean } | { ok: false; status: 404 | 409; code: string; message: string };

/**
 * The demo control: the rule looks at its next occurrence now, without waiting for the lead time. A
 * card that already waits for that occurrence is kept (`existing`), re-planned only if the calendar
 * changed. Paused or turned off: refused.
 */
export function prepareRuleNow(state: HomemindState, ruleId: string, now: number, adapters: AdapterRegistry): PrepareNowResult {
  const rule = state.rules.find(r => r.id === ruleId);
  if (!rule) return { ok: false, status: 404, code: 'not_found', message: 'No such rule' };
  if (!rule.enabled) return { ok: false, status: 409, code: 'rule_off', message: 'This rule is turned off' };
  if (state.family.paused) return { ok: false, status: 409, code: 'paused', message: 'Automatic actions are paused' };
  const { date, at } = nextOccurrence(rule, now, state.family.timezone);
  const last = latestRun(state, rule.id, date);
  if (last && cardOf(state, last.cardId)?.status === 'pending') {
    const plan = planRule(state, rule, date, at);
    if (!planChanged(last, plan)) return { ok: true, state, run: last, existing: true };
    const done = record(withdrawRun(state, last, CALENDAR_CHANGED, now), plan, 'calendar', adapters, now);
    return { ok: true, state: done.state, run: done.run, existing: false };
  }
  const done = record(state, planRule(state, rule, date, at), 'demo', adapters, now);
  return { ok: true, state: done.state, run: done.run, existing: false };
}

// --- turning rules on and off, creating them (POST /rules) ------------------------------------------------

export type RuleRequest =
  | { action: 'enable' | 'disable'; id: string }
  | { action: 'create'; title: string; titleZh?: string; weekday: number; time: string; leadMinutes: number; items: Line[]; maxPrice: number };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Checks a `POST /rules` body by hand. Unknown fields are refused. */
export function parseRuleBody(body: Record<string, unknown>): { ok: true; value: RuleRequest } | { ok: false; message: string } {
  const allowed = body.action === 'create' ? ['action', 'title', 'titleZh', 'weekday', 'time', 'leadMinutes', 'items', 'maxPrice'] : ['action', 'id'];
  const extra = Object.keys(body).find(k => !allowed.includes(k));
  if (extra) return { ok: false, message: `Unknown rule field: ${extra.slice(0, 40)}` };
  if (body.action === 'enable' || body.action === 'disable') {
    if (typeof body.id !== 'string' || !ID_PATTERN.test(body.id)) return { ok: false, message: 'id is not a valid id' };
    return { ok: true, value: { action: body.action, id: body.id } };
  }
  if (body.action !== 'create') return { ok: false, message: 'action is create, enable or disable' };
  const text = (v: unknown) => typeof v === 'string' && v.trim().length >= 1 && v.length <= RULE_LIMITS.title && !CONTROL.test(v);
  if (!text(body.title)) return { ok: false, message: `title is 1 to ${RULE_LIMITS.title} characters` };
  if (body.titleZh !== undefined && !text(body.titleZh)) return { ok: false, message: `titleZh is 1 to ${RULE_LIMITS.title} characters` };
  if (typeof body.weekday !== 'number' || !Number.isInteger(body.weekday) || body.weekday < 0 || body.weekday > 6) return { ok: false, message: 'weekday is 0 (Sunday) to 6' };
  if (typeof body.time !== 'string' || !HHMM.test(body.time)) return { ok: false, message: 'time is HH:MM' };
  const lead = body.leadMinutes;
  if (typeof lead !== 'number' || !Number.isInteger(lead) || lead < RULE_LIMITS.leadMinutes.min || lead > RULE_LIMITS.leadMinutes.max) return { ok: false, message: `leadMinutes is ${RULE_LIMITS.leadMinutes.min} to ${RULE_LIMITS.leadMinutes.max}` };
  const quote = quotePizza(body.items);
  if (!quote.ok) return { ok: false, message: quote.error };
  if (typeof body.maxPrice !== 'number' || !Number.isFinite(body.maxPrice) || body.maxPrice <= 0 || body.maxPrice > 5000) return { ok: false, message: 'maxPrice is a number from 1 to 5000' };
  const items = (body.items as Line[]).map(l => ({ id: l.id, qty: l.qty }));
  return {
    ok: true,
    value: { action: 'create', title: (body.title as string).trim(), ...(typeof body.titleZh === 'string' ? { titleZh: body.titleZh.trim() } : {}), weekday: body.weekday, time: body.time, leadMinutes: lead, items, maxPrice: body.maxPrice }
  };
}

export type RuleChangeResult =
  | { ok: true; state: HomemindState; rule: Rule; changed: boolean; activityId?: string }
  | { ok: false; status: 403 | 404 | 409; code: string; message: string };

/**
 * Applies a rule request as `memberId`. Every rule here spends money (the pizza shop), so only a parent
 * may create, turn on or turn off one. Turning a rule off withdraws its waiting cards. One Activity each.
 */
export function applyRuleRequest(state: HomemindState, request: RuleRequest, memberId: string, now: number): RuleChangeResult {
  const member = state.family.members.find(m => m.id === memberId);
  if (!member || member.role !== 'parent' || !member.hasAccount) return { ok: false, status: 403, code: 'forbidden', message: 'Only a parent can change a rule that spends money' };
  const log = (next: HomemindState, rule: Rule, note: 'created' | 'enabled' | 'disabled'): { state: HomemindState; activityId: string } => {
    const activityId = freeId(`act-${Math.max(0, Math.floor(now)).toString(36)}`, id => next.activity.some(a => a.id === id));
    return { activityId, state: { ...next, activity: [...next.activity, { id: activityId, at: toIso(now), actor: memberId, what: `Rule ${rule.id} ${note}`, kind: 'rule', ref: rule.id, note }] } };
  };
  if (request.action === 'create') {
    if (state.rules.length >= RULE_LIMITS.rules) return { ok: false, status: 409, code: 'too_many', message: 'Too many rules' };
    const quote = quotePizza(request.items);
    if (!quote.ok) return { ok: false, status: 409, code: 'invalid', message: quote.error };
    const id = freeId(`rule-${state.rules.length + 1}`, x => state.rules.some(r => r.id === x));
    const rule: Rule = {
      id,
      title: request.title,
      ...(request.titleZh ? { titleZh: request.titleZh } : {}),
      trigger: { kind: 'weekly', weekday: request.weekday, time: request.time, leadMinutes: request.leadMinutes },
      actionTemplate: { adapter: 'pizza', payload: { vendor: PIZZA_VENDOR.id, items: request.items, total: quote.total, currency: quote.currency } },
      limits: { maxPrice: request.maxPrice, currency: quote.currency },
      area: 'food',
      enabled: true,
      createdBy: memberId
    };
    return { ok: true, rule, changed: true, ...log({ ...state, rules: [...state.rules, rule] }, rule, 'created') };
  }
  const rule = state.rules.find(r => r.id === request.id);
  if (!rule) return { ok: false, status: 404, code: 'not_found', message: 'No such rule' };
  const enabled = request.action === 'enable';
  if (rule.enabled === enabled) return { ok: true, state, rule, changed: false };
  const updated: Rule = { ...rule, enabled };
  let next: HomemindState = { ...state, rules: state.rules.map(r => (r.id === rule.id ? updated : r)) };
  if (!enabled) {
    for (const card of next.actionCards) if (card.ruleId === rule.id && card.status === 'pending') next = withdrawCard(next, card.id, 'The rule was turned off', now).state;
  }
  return { ok: true, rule: updated, changed: true, ...log(next, updated, enabled ? 'enabled' : 'disabled') };
}
