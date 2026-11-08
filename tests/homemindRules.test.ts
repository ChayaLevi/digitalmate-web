import { describe, expect, it } from 'vitest';
import { authorize, executeAction, expireCards, issueConfirmation } from '../server/homemind/actions';
import type { StateRef } from '../server/homemind/actions';
import { createSimulatedAdapters, servicesOf } from '../server/homemind/fakes';
import { applyRuleRequest, nextOccurrence, parseRuleBody, planRule, prepareRuleNow, runRules, sizeOrder } from '../server/homemind/rules';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, Item, Rule } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindViewData } from '../src/lib/homemindSurfaces';

const ZONE = 'Asia/Shanghai';
const MIN = 60_000;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi); // Shanghai local
const WED_10 = at(2026, 11, 11, 10); // Wednesday 2026-11-11 10:00
const FRI_1830 = at(2026, 11, 13, 18, 30); // the seeded rule's next occurrence
const FRI_1805 = at(2026, 11, 13, 18, 5); // inside its 30-minute lead
const KEY = 'test-key-0123456789';

const seed = (now = WED_10) => seedState({ now, timezone: ZONE });

function holder(state: HomemindState, now: number) {
  const box = { state, now };
  const adapters = createSimulatedAdapters({ get: () => box.state, set: s => void (box.state = s), now: () => box.now });
  const ref: StateRef = { get: () => box.state, set: s => void (box.state = s) };
  return { box, adapters, ref };
}

function awayEvent(id: string, title: string, start: number, end: number, away: string[], visibility: Item['visibility'] = 'family'): Item {
  return {
    id,
    type: 'event',
    title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    forMemberIds: [],
    ownership: { state: 'none' },
    visibility,
    sensitive: false,
    importance: 'normal',
    unavailableMemberIds: away,
    status: 'open',
    source: { kind: 'manual', label: 'Mom' },
    createdBy: 'mom',
    version: 1
  };
}

const withItems = (state: HomemindState, ...items: Item[]): HomemindState => ({ ...state, items: [...state.items, ...items] });
/** Mom at an out-of-town wedding from Thursday noon to Saturday noon: away on Friday evening. */
const WEDDING = awayEvent('wedding', "Cousin's wedding", at(2026, 11, 12, 12), at(2026, 11, 14, 12), ['mom']);
const DAD_DINNER = awayEvent('dad-dinner', 'Work dinner', at(2026, 11, 13, 18), at(2026, 11, 13, 22), ['dad']);
const pizzaRule = (state: HomemindState) => state.rules.find(r => r.id === 'rule-friday-pizza') as Rule;
const pendingPizza = (state: HomemindState) => state.actionCards.filter(c => c.adapter === 'pizza' && c.status === 'pending');

describe('timing', () => {
  it('finds the next Friday 18:30, and next week once it has passed', () => {
    const rule = pizzaRule(seed());
    expect(nextOccurrence(rule, WED_10, ZONE)).toEqual({ date: '2026-11-13', at: FRI_1830 });
    expect(nextOccurrence(rule, FRI_1830, ZONE).date).toBe('2026-11-20');
  });

  it('prepares nothing before the lead time, then one card inside it, and no second one on later ticks', () => {
    const { adapters } = holder(seed(), WED_10);
    expect(runRules(seed(), at(2026, 11, 13, 17, 59), adapters)).toMatchObject({ changed: false });
    const first = runRules(seed(), FRI_1805, adapters);
    expect(first.changed).toBe(true);
    expect(first.runs).toHaveLength(1);
    const cards = pendingPizza(first.state);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 'rule-friday-pizza-2026-11-13', mode: 'simulated', ruleId: 'rule-friday-pizza', expiresAt: new Date(FRI_1830).toISOString(), status: 'pending' });
    expect(runRules(first.state, FRI_1805 + 5 * MIN, adapters).changed).toBe(false);
  });

  it('a card nobody taps expires visibly at the occurrence, and the rule does not prepare it again', () => {
    const { adapters } = holder(seed(), WED_10);
    const prepared = runRules(seed(), FRI_1805, adapters).state;
    const after = runRules(prepared, FRI_1830 + MIN, adapters);
    expect(after.changed).toBe(false);
    const expired = expireCards(after.state, FRI_1830 + MIN);
    expect(expired.expired.map(c => c.id)).toEqual(['rule-friday-pizza-2026-11-13']);
    expect(expired.state.activity.at(-1)).toMatchObject({ kind: 'action', note: 'expired', actor: 'homemind' });
    const view = viewFor(expired.state, 'mom') as HomemindViewData;
    const jsonl = screenTurn('my-day', { lang: 'en', now: new Date(FRI_1830 + MIN).toISOString(), view }).jsonl;
    expect(jsonl).toContain('expired: nobody tapped, so nothing happened');
  });

  it('does nothing while paused, or for a rule that is off', () => {
    const { adapters } = holder(seed(), WED_10);
    const paused = { ...seed(), family: { ...seed().family, paused: true } };
    expect(runRules(paused, FRI_1805, adapters).changed).toBe(false);
    const off = { ...seed(), rules: seed().rules.map(r => ({ ...r, enabled: false })) };
    expect(runRules(off, FRI_1805, adapters).changed).toBe(false);
  });
});

describe('sizing the order to who is home', () => {
  it('keeps the template with everyone home, and picks smaller sizes of the same pizza for fewer', () => {
    const template = [{ id: 'margherita-l', qty: 2 }];
    expect(sizeOrder(template, 4, 4)).toEqual(template);
    expect(sizeOrder(template, 3, 4)).toEqual([{ id: 'margherita-l', qty: 1 }, { id: 'margherita-m', qty: 1 }]);
    expect(sizeOrder(template, 2, 4)).toEqual([{ id: 'margherita-l', qty: 1 }]);
    expect(sizeOrder(template, 1, 4)).toEqual([{ id: 'margherita-m', qty: 1 }]);
    expect(sizeOrder([{ id: 'pepperoni-l', qty: 2 }, { id: 'kids-s', qty: 2 }], 2, 4)).toEqual([{ id: 'pepperoni-l', qty: 1 }, { id: 'kids-s', qty: 1 }]);
  });

  it('with Mom at the wedding, orders for 3 at the menu price, with a Why from the rule that names the wedding', () => {
    const state = withItems(seed(), WEDDING);
    const { adapters } = holder(state, WED_10);
    const step = runRules(state, FRI_1805, adapters);
    const card = pendingPizza(step.state)[0];
    expect(card.payload).toMatchObject({ vendor: 'sim-pizza', items: [{ id: 'margherita-l', qty: 1 }, { id: 'margherita-m', qty: 1 }], total: 154, currency: 'CNY', deliverAt: new Date(FRI_1830).toISOString() });
    expect(String(card.payload.summary)).toContain('for 3 at home (Mom away)');
    expect(String(card.payload.summaryZh)).toContain('在家 3 人');
    expect(card.refs).toEqual(['wedding']);
    expect(adapters.pizza.validate(card.payload)).toBeNull();
    const why = step.state.whys.find(w => w.id === card.whyId)!;
    expect(why.source).toBe('rule');
    expect(why.summary).toContain("Mom is away (Cousin's wedding)");
    expect(why.summary).toContain('made smaller');
    expect(why.summaryZh).toContain('来自 Homemind 规则');
    expect(why.basis.map(b => b.kind)).toEqual(['rule', 'availability', 'price', 'vendor']);
    expect(step.runs[0]).toMatchObject({ outcome: 'prepared', home: ['dad', 'maya', 'noa'], away: [{ memberId: 'mom', eventId: 'wedding' }], total: 154, trigger: 'schedule' });
  });
});

describe('stops, with no card and a visible reason', () => {
  it('stops on a price over the cap', () => {
    const state = { ...seed(), rules: seed().rules.map(r => ({ ...r, limits: { maxPrice: 150, currency: 'CNY' } })) };
    const { adapters } = holder(state, WED_10);
    const step = runRules(state, FRI_1805, adapters);
    expect(pendingPizza(step.state)).toHaveLength(0);
    expect(step.runs[0]).toMatchObject({ outcome: 'stopped', reason: 'over_cap', total: 178, maxPrice: 150 });
    expect(step.state.whys.find(w => w.id === step.runs[0].whyId)?.summary).toContain('over the rule\'s cap of 150 CNY');
    const view = viewFor(step.state, 'mom') as HomemindViewData;
    expect(screenTurn('rules', { lang: 'en', now: new Date(FRI_1805).toISOString(), view }).jsonl).toContain('stopped, no card: over the price cap');
  });

  it('stops when the simulated shop is closed at the time', () => {
    const late = (s: HomemindState) => ({ ...s, rules: s.rules.map(r => ({ ...r, trigger: { ...r.trigger, time: '22:00' } })) });
    const state = late(seed());
    const { adapters } = holder(state, WED_10);
    const step = runRules(state, at(2026, 11, 13, 21, 45), adapters);
    expect(step.runs[0]).toMatchObject({ outcome: 'stopped', reason: 'closed' });
    expect(step.state.actionCards).toHaveLength(0);
  });

  it('stops when nobody is home, and a stop is checked again (and kept) on later ticks', () => {
    const everyone = awayEvent('trip', 'Family trip', at(2026, 11, 12, 8), at(2026, 11, 15, 20), ['mom', 'dad', 'maya', 'noa']);
    const state = withItems(seed(), everyone);
    const { adapters } = holder(state, WED_10);
    const step = runRules(state, FRI_1805, adapters);
    expect(step.runs[0]).toMatchObject({ outcome: 'stopped', reason: 'nobody_home' });
    expect(runRules(step.state, FRI_1805 + MIN, adapters).changed).toBe(false);
  });
});

describe('a calendar change while the card waits', () => {
  it('withdraws the old card (its token is refused) and prepares one that fits, with a new hash', () => {
    const { adapters } = holder(seed(), WED_10);
    const first = runRules(seed(), FRI_1805, adapters).state;
    const old = pendingPizza(first)[0];
    const token = issueConfirmation(first, old.id, 'mom', { key: KEY, now: FRI_1805 }, adapters);
    expect(token.ok).toBe(true);

    const changed = withItems(first, WEDDING);
    const step = runRules(changed, FRI_1805 + MIN, adapters);
    expect(step.runs[0]).toMatchObject({ trigger: 'calendar', outcome: 'prepared', total: 154 });
    const withdrawn = step.state.actionCards.find(c => c.id === old.id)!;
    expect(withdrawn).toMatchObject({ status: 'cancelled', executedBy: 'homemind' });
    expect(withdrawn.error).toMatch(/^The calendar changed/);
    const fresh = pendingPizza(step.state);
    expect(fresh.map(c => c.id)).toEqual(['rule-friday-pizza-2026-11-13-2']);
    expect(fresh[0].payloadHash).not.toBe(old.payloadHash);
    if (!token.ok) return;
    expect(authorize(step.state, old.id, { kind: 'tap', memberId: 'mom', token: token.token }, adapters, { key: KEY, now: FRI_1805 + MIN })).toMatchObject({ ok: false, code: 'not_pending' });
    expect(authorize(step.state, fresh[0].id, { kind: 'tap', memberId: 'mom', token: token.token }, adapters, { key: KEY, now: FRI_1805 + MIN })).toMatchObject({ ok: false, code: 'wrong_card' });
    const view = viewFor(step.state, 'mom') as HomemindViewData;
    expect(screenTurn('my-day', { lang: 'en', now: new Date(FRI_1805 + MIN).toISOString(), view }).jsonl).toContain('replaced: the calendar changed');
  });

  it('a card a parent cancelled is not prepared again by the next tick', () => {
    const { adapters } = holder(seed(), WED_10);
    const first = runRules(seed(), FRI_1805, adapters).state;
    const cancelled = { ...first, actionCards: first.actionCards.map(c => ({ ...c, status: 'cancelled' as const })) };
    expect(runRules(withItems(cancelled, WEDDING), FRI_1805 + MIN, adapters).changed).toBe(false);
  });
});

describe('babysitter draft when both parents are out', () => {
  it('drafts a message to the first free sitter by rank, with no reason in the text, as its own card', () => {
    const state = withItems(seed(), WEDDING, DAD_DINNER);
    const { adapters } = holder(state, WED_10);
    const step = runRules(state, FRI_1805, adapters);
    expect(pendingPizza(step.state)[0].payload).toMatchObject({ items: [{ id: 'margherita-l', qty: 1 }], total: 89 });
    const sitter = step.state.actionCards.find(c => c.adapter === 'babysitter')!;
    // Auntie Zhang (rank 1) works Monday to Thursday; Xiao Chen (rank 2) is free on Friday evenings.
    expect(sitter).toMatchObject({ id: 'rule-friday-pizza-2026-11-13-sitter', status: 'pending', expiresAt: new Date(FRI_1830).toISOString() });
    expect(sitter.payload).toMatchObject({ sitterId: 'sitter-chen', date: '2026-11-13', from: '18:30', to: '22:00' });
    expect(String(sitter.payload.text)).not.toMatch(/wedding|dinner|婚礼|晚宴/i);
    expect(adapters.babysitter.validate(sitter.payload)).toBeNull();
    expect(step.runs[0]).toMatchObject({ sitter: 'drafted', sitterCardId: sitter.id });
    expect(step.state.whys.find(w => w.id === sitter.whyId)?.summary).toContain('a message to a babysitter was drafted');
  });

  it('says so when no sitter on the list is free then (Sunday lunch)', () => {
    const sunday = (s: HomemindState) => ({ ...s, rules: s.rules.map(r => ({ ...r, trigger: { ...r.trigger, weekday: 0, time: '12:00' } })) });
    const both = awayEvent('both-out', 'Both out', at(2026, 11, 15, 10), at(2026, 11, 15, 20), ['mom', 'dad']);
    const state = sunday(withItems(seed(), both));
    const { adapters } = holder(state, WED_10);
    const step = runRules(state, at(2026, 11, 15, 11, 40), adapters);
    expect(step.runs[0]).toMatchObject({ outcome: 'prepared', sitter: 'none_free' });
    expect(step.state.actionCards.some(c => c.adapter === 'babysitter')).toBe(false);
  });
});

describe('who sees it', () => {
  it('a teen gets no card, run or Why about a Parents-only event; parents get all of it', () => {
    const secret = { ...WEDDING, id: 'secret-trip', title: 'Surprise trip', visibility: 'parents' as const };
    const state = withItems(seed(), secret);
    const { adapters } = holder(state, WED_10);
    const step = runRules(state, FRI_1805, adapters);
    const maya = viewFor(step.state, 'maya')!;
    expect(maya.actionCards).toHaveLength(0);
    expect(maya.ruleRuns).toHaveLength(0);
    expect(maya.whys.some(w => w.source === 'rule')).toBe(false);
    expect(JSON.stringify(maya)).not.toContain('Surprise trip');
    const mom = viewFor(step.state, 'mom')!;
    expect(mom.actionCards).toHaveLength(1);
    expect(mom.ruleRuns).toHaveLength(1);
  });
});

describe('the card runs only with a tap', () => {
  it('a parent taps with its token: the simulated shop records the resized order once', async () => {
    const state = withItems(seed(), WEDDING);
    const h = holder(state, FRI_1805);
    h.box.state = runRules(state, FRI_1805, h.adapters).state;
    const card = pendingPizza(h.box.state)[0];
    const token = issueConfirmation(h.box.state, card.id, 'dad', { key: KEY, now: FRI_1805 }, h.adapters);
    if (!token.ok) throw new Error('no token');
    const deps = { adapters: h.adapters, key: KEY, now: () => FRI_1805 };
    expect(await executeAction(h.ref, card.id, { kind: 'auto' }, deps)).toMatchObject({ ok: false, code: 'auto_not_allowed' });
    expect(await executeAction(h.ref, card.id, { kind: 'tap', memberId: 'dad', token: token.token }, deps)).toMatchObject({ ok: true });
    expect(servicesOf(h.box.state).pizzaOrders).toHaveLength(1);
    expect(servicesOf(h.box.state).pizzaOrders[0]).toMatchObject({ total: 154, simulated: true });
    expect(await executeAction(h.ref, card.id, { kind: 'tap', memberId: 'dad', token: token.token }, deps)).toMatchObject({ ok: false });
    expect(runRules(h.box.state, FRI_1805 + MIN, h.adapters).changed).toBe(false);
  });
});

describe('prepare now (demo control)', () => {
  it('prepares the next occurrence days ahead, keeps a waiting card, and refuses when paused or off', () => {
    const { adapters } = holder(seed(), WED_10);
    const first = prepareRuleNow(seed(), 'rule-friday-pizza', WED_10, adapters);
    if (!first.ok) throw new Error(first.message);
    expect(first).toMatchObject({ existing: false, run: { trigger: 'demo', date: '2026-11-13', outcome: 'prepared' } });
    expect(pendingPizza(first.state)[0].expiresAt).toBe(new Date(FRI_1830).toISOString());
    expect(prepareRuleNow(first.state, 'rule-friday-pizza', WED_10 + MIN, adapters)).toMatchObject({ ok: true, existing: true });
    // The ticks before the lead time leave a card prepared early alone.
    expect(runRules(first.state, WED_10 + MIN, adapters).changed).toBe(false);
    // But a calendar change is still noticed.
    expect(runRules(withItems(first.state, WEDDING), WED_10 + 2 * MIN, adapters)).toMatchObject({ changed: true, runs: [{ trigger: 'calendar', total: 154 }] });
    expect(prepareRuleNow(seed(), 'nope', WED_10, adapters)).toMatchObject({ ok: false, status: 404 });
    expect(prepareRuleNow({ ...seed(), family: { ...seed().family, paused: true } }, 'rule-friday-pizza', WED_10, adapters)).toMatchObject({ ok: false, code: 'paused' });
  });
});

describe('creating and switching rules (POST /rules)', () => {
  it('checks the body by hand', () => {
    expect(parseRuleBody({ action: 'enable', id: 'rule-friday-pizza' })).toMatchObject({ ok: true });
    expect(parseRuleBody({ action: 'enable', id: 'Bad Id' })).toMatchObject({ ok: false });
    expect(parseRuleBody({ action: 'enable', id: 'x', extra: 1 })).toMatchObject({ ok: false });
    expect(parseRuleBody({ action: 'delete', id: 'x' })).toMatchObject({ ok: false });
    const good = { action: 'create', title: 'Sunday pizza', weekday: 0, time: '12:00', leadMinutes: 30, items: [{ id: 'veggie-m', qty: 1 }], maxPrice: 100 };
    expect(parseRuleBody(good)).toMatchObject({ ok: true });
    expect(parseRuleBody({ ...good, items: [{ id: 'sushi', qty: 1 }] })).toMatchObject({ ok: false });
    expect(parseRuleBody({ ...good, weekday: 7 })).toMatchObject({ ok: false });
    expect(parseRuleBody({ ...good, time: '25:00' })).toMatchObject({ ok: false });
    expect(parseRuleBody({ ...good, leadMinutes: 1 })).toMatchObject({ ok: false });
    expect(parseRuleBody({ ...good, title: 'a\u0000b' })).toMatchObject({ ok: false });
  });

  it('only a parent may change a rule; turning it off withdraws its waiting card; each change is logged', () => {
    const { adapters } = holder(seed(), WED_10);
    const prepared = runRules(seed(), FRI_1805, adapters).state;
    expect(applyRuleRequest(prepared, { action: 'disable', id: 'rule-friday-pizza' }, 'maya', FRI_1805)).toMatchObject({ ok: false, status: 403 });
    const off = applyRuleRequest(prepared, { action: 'disable', id: 'rule-friday-pizza' }, 'dad', FRI_1805);
    if (!off.ok) throw new Error(off.message);
    expect(off.rule.enabled).toBe(false);
    expect(pendingPizza(off.state)).toHaveLength(0);
    expect(off.state.actionCards[0].error).toBe('The rule was turned off');
    expect(off.state.activity.at(-1)).toMatchObject({ kind: 'rule', ref: 'rule-friday-pizza', note: 'disabled', actor: 'dad', id: off.activityId });
    expect(new Set(off.state.activity.map(a => a.id)).size).toBe(off.state.activity.length);
    expect(applyRuleRequest(off.state, { action: 'disable', id: 'rule-friday-pizza' }, 'dad', FRI_1805)).toMatchObject({ ok: true, changed: false });
    const on = applyRuleRequest(off.state, { action: 'enable', id: 'rule-friday-pizza' }, 'mom', FRI_1805);
    expect(on).toMatchObject({ ok: true, changed: true, rule: { enabled: true } });
    const made = applyRuleRequest(seed(), { action: 'create', title: 'Sunday pizza', weekday: 0, time: '12:00', leadMinutes: 30, items: [{ id: 'veggie-m', qty: 1 }], maxPrice: 100 }, 'mom', WED_10);
    if (!made.ok) throw new Error(made.message);
    expect(made.rule).toMatchObject({ id: 'rule-2', area: 'food', enabled: true, createdBy: 'mom', actionTemplate: { adapter: 'pizza', payload: { total: 59 } } });
    expect(planRule(made.state, made.rule, '2026-11-15', at(2026, 11, 15, 12))).toMatchObject({ outcome: 'prepared', total: 59 });
  });
});
