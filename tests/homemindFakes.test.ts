import { describe, expect, it } from 'vitest';
import { executeAction, issueConfirmation, prepareCard } from '../server/homemind/actions';
import type { StateRef } from '../server/homemind/actions';
import {
  ADAPTER_IDS,
  APPROVED_SENDERS,
  BABYSITTERS,
  GROUP_FIXTURE,
  KINDERGARTEN_GROUP,
  PIZZA_VENDOR,
  createSimulatedAdapters,
  draftBabysitterMessage,
  groupAuthorFor,
  inboxFor,
  pizzaOpenAt,
  postNextGroupMessage,
  quotePizza,
  servicesOf,
  servicesViewFor,
  sitterAvailable,
  weatherFor
} from '../server/homemind/fakes';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';

const ZONE = 'Asia/Shanghai';
const WED_10 = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const WED_18 = Date.UTC(2026, 10, 4, 10, 0); // 18:00
const WED_22 = Date.UTC(2026, 10, 4, 14, 0); // 22:00
const MON_18 = Date.UTC(2026, 10, 2, 10, 0); // Monday 18:00
const KEY = 'test-key-0123456789';
const HOUR = 60 * 60 * 1000;

const seed = (now = WED_18) => seedState({ now, timezone: ZONE });

/** A state holder like the bridge's runtime: adapters replace the state through it. */
function holder(state: HomemindState, at: number) {
  const box = { state, now: at };
  const deps = { get: () => box.state, set: (s: HomemindState) => void (box.state = s), now: () => box.now };
  const ref: StateRef = { get: () => box.state, set: s => void (box.state = s) };
  return { box, deps, ref, adapters: createSimulatedAdapters(deps) };
}

const signal = () => new AbortController().signal;

describe('seed and state', () => {
  it('a fresh seed has empty services, and an older file without them gets the same', () => {
    const state = seed();
    expect(state.services).toEqual({ group: { id: KINDERGARTEN_GROUP.id, messages: [], posted: 0 }, pizzaOrders: [], babysitterMessages: [] });
    const { services: _dropped, ...older } = state;
    expect(servicesOf(older as HomemindState)).toEqual(state.services);
  });

  it("the seeded Friday rule's pizza order is one the simulated shop accepts, at its own price", () => {
    const rule = seed().rules.find(r => r.id === 'rule-friday-pizza')!;
    const { adapters } = holder(seed(), WED_18);
    expect(rule.actionTemplate.adapter).toBe(ADAPTER_IDS.pizza);
    expect(adapters.pizza.validate(rule.actionTemplate.payload)).toBeNull();
    expect(quotePizza(rule.actionTemplate.payload.items)).toMatchObject({ ok: true, total: 178, currency: 'CNY' });
  });
});

describe('kindergarten group', () => {
  it('posts the fixture messages in order, each labelled simulated, then says there are no more', () => {
    let state = seed();
    const ids: string[] = [];
    for (let n = 0; n < GROUP_FIXTURE.length; n++) {
      const posted = postNextGroupMessage(state, WED_10 + n * 60_000);
      if (!posted.ok) throw new Error(posted.message);
      expect(posted.message).toMatchObject({ version: 1, simulated: true, at: new Date(WED_10 + n * 60_000).toISOString() });
      expect(posted.remaining).toBe(GROUP_FIXTURE.length - n - 1);
      ids.push(posted.message.id);
      state = posted.state;
    }
    expect(ids).toEqual(GROUP_FIXTURE.map(m => m.id));
    expect(servicesOf(state).group.messages).toHaveLength(GROUP_FIXTURE.length);
    const done = postNextGroupMessage(state, WED_18);
    expect(done).toMatchObject({ ok: false, code: 'no_more_messages' });
    // The original state is untouched (pure).
    expect(servicesOf(seed()).group.messages).toEqual([]);
  });

  it('is in Chinese, prints no fixed dates, and leaves apples and cake free in the 接龙 sign-up', () => {
    for (const m of GROUP_FIXTURE) {
      expect(m.text).toMatch(/[一-鿿]/);
      expect(m.text).not.toMatch(/\d+月\d+日/);
    }
    const signUp = GROUP_FIXTURE.find(m => m.text.includes('#接龙'))!;
    const claimed = signUp.text.split('\n').filter(line => /^\d+\./.test(line));
    expect(claimed.length).toBeGreaterThan(0);
    for (const free of ['苹果', '蛋糕']) {
      expect(signUp.text).toContain(free);
      expect(claimed.some(line => line.includes(free))).toBe(false);
    }
  });

  it('a parent appears in the group after the youngest child', () => {
    const state = seed();
    const mom = state.family.members.find(m => m.id === 'mom')!;
    expect(groupAuthorFor(state, mom)).toEqual({ author: "Noa's mom", authorZh: '诺娅妈妈' });
  });

  it('the reply adapter posts a claim as the parent, only in reply to a message that is there', async () => {
    const first = postNextGroupMessage(seed(), WED_10);
    if (!first.ok) throw new Error('fixture');
    const { box, adapters } = holder(first.state, WED_18);
    const reply = adapters[ADAPTER_IDS.groupReply];
    const payload = { groupId: KINDERGARTEN_GROUP.id, text: '3. 诺娅妈妈 苹果', kind: 'claim', replyTo: first.message.id, asMemberId: 'mom' };
    expect(reply.validate(payload)).toBeNull();
    expect(reply.validate({ ...payload, groupId: 'other' })).toMatch(/group/);
    expect(reply.validate({ ...payload, kind: 'order' })).toMatch(/kind/);
    expect(reply.validate({ ...payload, text: '' })).toMatch(/text/);
    expect(reply.validate({ ...payload, extra: 1 })).toMatch(/Unknown field/);

    const result = await reply.execute(payload, signal());
    expect(result).toEqual({ ok: true, result: { messageId: 'grp-reply-1', simulated: true } });
    const posted = servicesOf(box.state).group.messages.at(-1)!;
    expect(posted).toMatchObject({ id: 'grp-reply-1', from: 'family', author: "Noa's mom", authorZh: '诺娅妈妈', replyKind: 'claim', replyTo: first.message.id, simulated: true });

    expect(await reply.execute({ ...payload, replyTo: 'grp-msg-9' }, signal())).toMatchObject({ ok: false });
    expect(await reply.execute({ ...payload, asMemberId: 'maya' }, signal())).toEqual({ ok: false, error: 'Only a parent can post in the group' });
  });
});

describe('pizza vendor', () => {
  it('is open 11:00 to 21:30, closed on Mondays', () => {
    expect(pizzaOpenAt(WED_10, ZONE)).toBe(false);
    expect(pizzaOpenAt(WED_18, ZONE)).toBe(true);
    expect(pizzaOpenAt(WED_22, ZONE)).toBe(false);
    expect(pizzaOpenAt(MON_18, ZONE)).toBe(false);
  });

  it('prices from its own menu and refuses what is not on it', () => {
    expect(quotePizza([{ id: 'margherita-l', qty: 1 }, { id: 'kids-s', qty: 2 }])).toEqual({
      ok: true,
      lines: [
        { itemId: 'margherita-l', qty: 1, price: 89 },
        { itemId: 'kids-s', qty: 2, price: 39 }
      ],
      total: 167,
      currency: 'CNY'
    });
    expect(quotePizza([])).toMatchObject({ ok: false });
    expect(quotePizza([{ id: 'sushi', qty: 1 }])).toMatchObject({ ok: false });
    expect(quotePizza([{ id: 'kids-s', qty: 0 }])).toMatchObject({ ok: false });
    expect(quotePizza([{ id: 'kids-s', qty: 1.5 }])).toMatchObject({ ok: false });
  });

  it('refuses a card whose total is not the menu price, a wrong vendor or currency', () => {
    const { adapters } = holder(seed(), WED_18);
    const ok = { vendor: PIZZA_VENDOR.id, items: [{ id: 'margherita-m', qty: 1 }], total: 65, currency: 'CNY' };
    expect(adapters.pizza.validate(ok)).toBeNull();
    expect(adapters.pizza.validate({ ...ok, total: 50 })).toMatch(/total/);
    expect(adapters.pizza.validate({ ...ok, vendor: 'real-shop' })).toMatch(/vendor/);
    expect(adapters.pizza.validate({ ...ok, currency: 'USD' })).toMatch(/currency/);
    expect(adapters.pizza.validate({ ...ok, title: 'Pizza', summary: '1 medium' })).toBeNull();
  });

  it('records a simulated order when open, and fails when closed', async () => {
    const payload = { vendor: PIZZA_VENDOR.id, items: [{ id: 'margherita-l', qty: 2 }], total: 178, currency: 'CNY' };
    const open = holder(seed(), WED_18);
    const result = await open.adapters.pizza.execute(payload, signal());
    expect(result).toEqual({ ok: true, result: { orderId: 'pz-1', total: 178, currency: 'CNY', deliverAt: new Date(WED_18 + 40 * 60_000).toISOString(), simulated: true } });
    expect(servicesOf(open.box.state).pizzaOrders).toEqual([
      expect.objectContaining({ id: 'pz-1', total: 178, simulated: true, lines: [{ itemId: 'margherita-l', qty: 2, price: 89 }] })
    ]);

    const closed = holder(seed(), MON_18);
    expect(await closed.adapters.pizza.execute(payload, signal())).toEqual({ ok: false, error: 'The pizza shop is closed (simulated)' });
    expect(servicesOf(closed.box.state).pizzaOrders).toEqual([]);
  });
});

describe('babysitters', () => {
  it('are ranked, with canned availability by weekday', () => {
    expect(BABYSITTERS.map(s => s.rank)).toEqual([1, 2, 3]);
    expect(sitterAvailable('sitter-zhang', '2026-11-10', '18:30', '22:00')).toBe(true); // Tuesday
    expect(sitterAvailable('sitter-zhang', '2026-11-13', '18:30', '22:00')).toBe(false); // Friday
    expect(sitterAvailable('sitter-chen', '2026-11-13', '18:30', '22:00')).toBe(true);
    expect(sitterAvailable('sitter-li', '2026-11-10', '18:30', '22:00')).toBe(false); // daytime only
    expect(sitterAvailable('nobody', '2026-11-10', '18:30', '22:00')).toBe(false);
  });

  it('the draft says when, in both languages, and nothing about why', () => {
    const en = draftBabysitterMessage('sitter-zhang', '2026-11-10', '18:30', '22:00', 'en');
    const zh = draftBabysitterMessage('sitter-zhang', '2026-11-10', '18:30', '22:00', 'zh');
    expect(en).toBe('Hi Auntie Zhang, could you babysit on 11/10 from 18:30 to 22:00? Thank you!');
    expect(zh).toBe('张阿姨您好！请问11月10日18:30到22:00您能来帮忙照看孩子吗？谢谢！');
    expect(`${en} ${zh}`).not.toMatch(/wedding|婚礼|Mom|Dad|妈妈|爸爸/);
  });

  it('the message adapter validates and records the canned answer', async () => {
    const { box, adapters } = holder(seed(), WED_18);
    const sitter = adapters[ADAPTER_IDS.babysitter];
    const payload = { sitterId: 'sitter-zhang', date: '2026-11-10', from: '18:30', to: '22:00', text: draftBabysitterMessage('sitter-zhang', '2026-11-10', '18:30', '22:00', 'zh') };
    expect(sitter.validate(payload)).toBeNull();
    expect(sitter.validate({ ...payload, sitterId: 'x' })).toMatch(/babysitter/);
    expect(sitter.validate({ ...payload, from: '23:00' })).toMatch(/before/);
    expect(sitter.validate({ ...payload, date: '10/11' })).toMatch(/date/);
    expect(sitter.validate({ ...payload, text: 'a\u0007b' })).toMatch(/text/);
    expect(await sitter.execute(payload, signal())).toEqual({ ok: true, result: { messageId: 'sit-1', reply: 'yes', simulated: true } });
    expect(await sitter.execute({ ...payload, date: '2026-11-13' }, signal())).toEqual({ ok: true, result: { messageId: 'sit-2', reply: 'no', simulated: true } });
    expect(servicesOf(box.state).babysitterMessages.map(m => [m.id, m.reply, m.simulated])).toEqual([
      ['sit-1', 'yes', true],
      ['sit-2', 'no', true]
    ]);
  });
});

describe('inbox and weather', () => {
  it("shows only the member's own mailbox, only approved senders, newest first", () => {
    const mom = inboxFor('mom', WED_18);
    expect(mom.map(m => m.id)).toEqual(['mail-1', 'mail-2']);
    expect(mom.every(m => APPROVED_SENDERS.some(s => s.address === m.from))).toBe(true);
    expect(inboxFor('dad', WED_18).map(m => m.id)).toEqual(['mail-1', 'mail-3']);
    expect(inboxFor('maya', WED_18)).toEqual([]);
    expect(JSON.stringify(mom)).not.toContain('deals@shop.example');
  });

  it('gives a canned three-day forecast from today', () => {
    expect(weatherFor(WED_18, ZONE).map(d => d.date)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
  });
});

describe('the services view', () => {
  it('labels every card simulated', () => {
    const view = servicesViewFor(seed(), 'mom', WED_18);
    for (const card of [view.group, view.pizza, view.babysitters, view.inbox, view.weather]) expect(card.simulated).toBe(true);
    expect(view.group.remaining).toBe(GROUP_FIXTURE.length);
    expect(view.pizza.open).toBe(true);
    expect(view.babysitters.sitters.find(s => s.id === 'sitter-zhang')).toMatchObject({ available: true, from: '18:00', to: '22:30' });
    expect(view.babysitters.sitters.find(s => s.id === 'sitter-chen')).toMatchObject({ available: false });
    expect(servicesViewFor(seed(), 'maya', WED_18).inbox.messages).toEqual([]);
  });
});

describe('behind the action guard', () => {
  it('every adapter is simulated, and only the group reply may run on its own', () => {
    const { adapters } = holder(seed(), WED_18);
    expect(Object.values(adapters).map(a => [a.id, a.mode, a.area, a.autoAllowed === true])).toEqual([
      ['group-reply', 'simulated', 'group', true],
      ['pizza', 'simulated', 'food', false],
      ['babysitter', 'simulated', 'childcare', false],
      ['teacher-message', 'simulated', 'childcare', false]
    ]);
  });

  it('a pizza card waits for a tap even at level 4, and runs on a parent tap', async () => {
    const base = seed();
    const level4: HomemindState = { ...base, family: { ...base.family, autonomy: { default: 4 } } };
    const h = holder(level4, WED_18);
    const payload = { vendor: PIZZA_VENDOR.id, items: [{ id: 'margherita-l', qty: 2 }], total: 178, currency: 'CNY', title: 'Friday pizza' };
    const prepared = prepareCard(h.box.state, { id: 'card-pizza', adapter: 'pizza', payload, expiresAt: new Date(WED_18 + HOUR).toISOString(), whyId: 'why-pizza' }, h.adapters, WED_18);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.card.mode).toBe('simulated');
    h.box.state = prepared.state;

    const deps = { adapters: h.adapters, key: KEY, now: () => WED_18 };
    expect(await executeAction(h.ref, 'card-pizza', { kind: 'auto' }, deps)).toMatchObject({ ok: false, code: 'auto_not_allowed', reason: 'not_allowed' });
    expect(servicesOf(h.box.state).pizzaOrders).toEqual([]);

    const token = issueConfirmation(h.box.state, 'card-pizza', 'mom', { key: KEY, now: WED_18 }, h.adapters);
    if (!token.ok) throw new Error(token.message);
    const ran = await executeAction(h.ref, 'card-pizza', { kind: 'tap', memberId: 'mom', token: token.token }, deps);
    expect(ran).toMatchObject({ ok: true, card: { status: 'executed', result: { orderId: 'pz-1', simulated: true } } });
    // The adapter's order and the card's outcome are both in the state that was saved.
    expect(servicesOf(h.box.state).pizzaOrders.map(o => o.id)).toEqual(['pz-1']);
    expect(h.box.state.actionCards.find(c => c.id === 'card-pizza')?.status).toBe('executed');
  });

  it('a group claim runs on its own at level 4, and not below', async () => {
    const first = postNextGroupMessage(seed(), WED_10);
    if (!first.ok) throw new Error('fixture');
    const payload = { groupId: KINDERGARTEN_GROUP.id, text: '3. 诺娅妈妈 苹果', kind: 'claim', replyTo: 'grp-msg-1', asMemberId: 'mom' };
    for (const level of [3, 4] as const) {
      const h = holder({ ...first.state, family: { ...first.state.family, autonomy: { default: level } } }, WED_18);
      const prepared = prepareCard(h.box.state, { id: 'card-claim', adapter: 'group-reply', payload, expiresAt: new Date(WED_18 + HOUR).toISOString(), whyId: 'why-claim' }, h.adapters, WED_18);
      if (!prepared.ok) throw new Error(prepared.message);
      h.box.state = prepared.state;
      const result = await executeAction(h.ref, 'card-claim', { kind: 'auto' }, { adapters: h.adapters, key: KEY, now: () => WED_18 });
      if (level === 4) {
        expect(result).toMatchObject({ ok: true, card: { status: 'executed', executedBy: 'homemind' } });
        expect(servicesOf(h.box.state).group.messages.at(-1)).toMatchObject({ from: 'family', replyKind: 'claim' });
      } else {
        expect(result).toMatchObject({ ok: false, code: 'auto_not_allowed', reason: 'level' });
        expect(servicesOf(h.box.state).group.messages).toHaveLength(1);
      }
    }
  });
});
