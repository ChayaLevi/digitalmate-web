import { describe, expect, it } from 'vitest';
import { executeAction, issueConfirmation } from '../server/homemind/actions';
import type { AdapterRegistry, StateRef } from '../server/homemind/actions';
import { fixedClock } from '../server/homemind/clock';
import { createSimulatedAdapters, postNextGroupMessage, servicesOf, servicesViewFor } from '../server/homemind/fakes';
import {
  afterGroupCard,
  applyGroupPolicy,
  considerSignUps,
  eventTitles,
  foodFor,
  groupsView,
  parseGroupPolicyBody,
  preparationsFor,
  readSignUp,
  requestGroupChange,
  resolveWeekday
} from '../server/homemind/groupClaims';
import { tickReminders } from '../server/homemind/reminders';
import { seedState } from '../server/homemind/seed';
import type { GroupMessage, HomemindState, Preference } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import { screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindViewData } from '../src/lib/homemindSurfaces';

const ZONE = 'Asia/Shanghai';
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi); // Shanghai local
const MON_10 = at(2026, 11, 9, 10); // Monday 2026-11-09 10:00
const THU_15 = at(2026, 11, 12, 15); // "本周四下午3点"
const WED_20 = at(2026, 11, 11, 20); // "周三晚上8点前"
const KEY = 'test-key-0123456789';

function holder(state: HomemindState, now: number) {
  const box = { state, now };
  const adapters = createSimulatedAdapters({ get: () => box.state, set: s => void (box.state = s), now: () => box.now });
  const ref: StateRef = { get: () => box.state, set: s => void (box.state = s) };
  return { box, adapters, ref };
}

/** The seed with the teacher's message and the 接龙 posted at `now`. */
function withSignUp(now = MON_10): HomemindState {
  let state = seedState({ now, timezone: ZONE });
  for (let i = 0; i < 2; i++) {
    const posted = postNextGroupMessage(state, now);
    if (!posted.ok) throw new Error('fixture');
    state = posted.state;
  }
  return state;
}

/** Claims on, as Mom: `auto` puts the group area at level 4. */
function turnOn(state: HomemindState, auto: boolean, now = MON_10): HomemindState {
  const result = applyGroupPolicy(state, { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto }, 'mom', now);
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

/** Runs a waiting group card at level 4 and applies what follows, as the bridge does. */
async function runAuto(box: { state: HomemindState; now: number }, ref: StateRef, adapters: AdapterRegistry, cardId: string) {
  const ran = await executeAction(ref, cardId, { kind: 'auto' }, { adapters, key: KEY, now: () => box.now });
  const card = box.state.actionCards.find(c => c.id === cardId)!;
  const after = afterGroupCard(box.state, card, box.now, fixedClock(box.now));
  if (after) box.state = after.state;
  return { ran, after };
}

const signUpMessage = (state: HomemindState) => servicesOf(state).group.messages.find(m => m.id === 'grp-msg-2') as GroupMessage;

function message(id: string, text: string, from: GroupMessage['from'] = 'parent', at = MON_10): GroupMessage {
  return { id, version: 1, at: new Date(at).toISOString(), author: 'Someone', from, text, simulated: true };
}

/** A group whose messages are exactly these (after the seed). */
function withMessages(...messages: GroupMessage[]): HomemindState {
  const state = seedState({ now: MON_10, timezone: ZONE });
  return { ...state, services: { ...servicesOf(state), group: { ...servicesOf(state).group, messages, posted: 3 } } };
}

const TEACHER = message('t-1', '各位家长好！本周四下午3点在班里举办秋季美食派对🎉 请家长们接龙认领要带的食物，够8个小朋友吃。周三晚上8点前接龙完毕', 'teacher');

describe('reading a 接龙 sign-up (fixed rules)', () => {
  it('reads the fixture: six choices, two taken, the party on Thursday 15:00, closing Wednesday 20:00, 8 children', () => {
    const state = withSignUp();
    const reading = readSignUp(servicesOf(state).group.messages, signUpMessage(state), ZONE);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.options.map(o => o.label)).toEqual(['苹果', '橙子', '蛋糕', '饼干', '香蕉', '葡萄']);
    expect(reading.options.filter(o => o.takenBy).map(o => `${o.label}:${o.takenBy}`)).toEqual(['香蕉:乐乐妈妈', '葡萄:小雨爸爸']);
    expect(reading.eventStart).toBe(THU_15);
    expect(reading.deadline).toBe(WED_20);
    expect(reading.eventName).toBe('秋季美食派对');
    expect(reading.children).toBe(8);
    expect(reading.source.id).toBe('grp-msg-1');
    expect(eventTitles(reading.eventName)).toEqual({ en: 'Kindergarten autumn food party', zh: '幼儿园秋季美食派对' });
  });

  it.each([
    ['no marker', '周四美食派对 认领食物（苹果、橙子）\n1. 乐乐妈妈 苹果', 'not marked as a sign-up'],
    ['no list', '#接龙\n周四美食派对 大家带点吃的\n1. 乐乐妈妈 苹果', 'no list of things'],
    ['numbers out of order', '#接龙\n周四美食派对 认领食物（苹果、橙子、香蕉）\n1. 乐乐妈妈 香蕉\n3. 小雨爸爸 苹果', 'out of order'],
    ['an entry not on the list', '#接龙\n周四美食派对 认领食物（苹果、橙子）\n1. 乐乐妈妈 西瓜', '“西瓜” is not one of the choices'],
    ['a line it cannot read', '#接龙\n周四美食派对 认领食物（苹果、橙子）\n1. 乐乐妈妈苹果橙子都行吗', 'could not be read'],
    ['a different weekday', '#接龙\n周五美食派对 认领食物（苹果、橙子）', 'the list says Friday']
  ])('stops on %s', (_name, text, problem) => {
    const signUp = message('s-1', text);
    const reading = readSignUp([TEACHER, signUp], signUp, ZONE);
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(reading.problem.toLowerCase()).toContain(problem.toLowerCase());
      expect(reading.problemZh.length).toBeGreaterThan(3);
    }
  });

  it('stops when no message gives the event a day and time', () => {
    const signUp = message('s-1', '#接龙\n美食派对 认领食物（苹果、橙子）');
    const reading = readSignUp([signUp], signUp, ZONE);
    expect(reading).toMatchObject({ ok: false, problem: 'No day and time for the event was found' });
  });

  it('resolves weekdays from when the message was posted', () => {
    const wed = at(2026, 11, 11, 10);
    expect(resolveWeekday('本周', 4, '15:00', wed, ZONE)).toBe(THU_15);
    expect(resolveWeekday('下周', 1, '09:00', wed, ZONE)).toBe(at(2026, 11, 16, 9));
    // Thursday after the party: "this Thursday" can only mean the coming one.
    expect(resolveWeekday('', 4, '15:00', at(2026, 11, 12, 16), ZONE)).toBe(at(2026, 11, 19, 15));
  });

  it('knows foods by their words, and paper plates are not food', () => {
    expect(foodFor('苹果')).toMatchObject({ key: 'apples', effort: 'buy', food: true });
    expect(foodFor('蛋糕')).toMatchObject({ key: 'cake', effort: 'make' });
    expect(foodFor('纸盘')).toMatchObject({ food: false });
    expect(foodFor('西瓜')).toBeUndefined();
  });
});

describe('the group setting', () => {
  it('is off by default: a sign-up gets no claim and no record', () => {
    const state = withSignUp();
    const { adapters } = holder(state, MON_10);
    const step = considerSignUps(state, MON_10, adapters);
    expect(step.changed).toBe(false);
    expect(step.state.groupClaims ?? []).toEqual([]);
    expect(step.state.actionCards).toEqual([]);
    expect(groupsView(state).policies[0]).toMatchObject({ groupId: 'kg-sunflower', enabled: false, maxCost: 50 });
  });

  it('only a parent turns it on; that is the approval, recorded with who and when, and auto sets the group area to level 4', () => {
    const state = withSignUp();
    expect(applyGroupPolicy(state, { action: 'group-claims', groupId: 'kg-sunflower', enabled: true }, 'maya', MON_10)).toMatchObject({ ok: false, status: 403 });
    expect(applyGroupPolicy(state, { action: 'group-claims', groupId: 'nope', enabled: true }, 'mom', MON_10)).toMatchObject({ ok: false, status: 404 });
    const on = applyGroupPolicy(state, { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto: true }, 'mom', MON_10);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.policy).toMatchObject({ enabled: true, approvedBy: 'mom', approvedAt: new Date(MON_10).toISOString() });
    expect(on.state.family.autonomy).toEqual({ default: 3, byArea: { group: 4 } });
    expect(on.state.activity.at(-1)).toMatchObject({ kind: 'rule', ref: 'kg-sunflower', note: 'enabled,auto', actor: 'mom' });
    // The same request again changes nothing.
    expect(applyGroupPolicy(on.state, { action: 'group-claims', groupId: 'kg-sunflower', enabled: true, auto: true }, 'dad', MON_10)).toMatchObject({ ok: true, changed: false });
  });

  it('checks the request body by hand', () => {
    expect(parseGroupPolicyBody({ action: 'group-claims', groupId: 'kg-sunflower', enabled: true })).toMatchObject({ ok: true });
    expect(parseGroupPolicyBody({ action: 'group-claims', groupId: 'kg-sunflower' })).toMatchObject({ ok: false });
    expect(parseGroupPolicyBody({ action: 'group-claims', groupId: 'kg-sunflower', enabled: 'yes' })).toMatchObject({ ok: false });
    expect(parseGroupPolicyBody({ action: 'group-claims', groupId: 'kg-sunflower', enabled: true, maxCost: 999 })).toMatchObject({ ok: false });
  });
});

describe('claiming', () => {
  it('below level 4: prepares a claim card for apples that waits for a tap, never cake (someone would have to bake it)', () => {
    const state = turnOn(withSignUp(), false);
    const { adapters } = holder(state, MON_10);
    const step = considerSignUps(state, MON_10, adapters);
    expect(step.claims).toHaveLength(1);
    const claim = step.claims[0];
    expect(claim).toMatchObject({ status: 'waiting', choice: 'apples', asMemberId: 'mom', eventStart: new Date(THU_15).toISOString(), deadline: new Date(WED_20).toISOString(), children: 8 });
    const card = step.state.actionCards.find(c => c.id === claim.cardId)!;
    expect(card).toMatchObject({ adapter: 'group-reply', mode: 'simulated', status: 'pending', expiresAt: new Date(WED_20).toISOString() });
    expect(card.payload).toMatchObject({ kind: 'claim', replyTo: 'grp-msg-2', asMemberId: 'mom', groupId: 'kg-sunflower' });
    expect(String(card.payload.text).endsWith('\n3. 诺娅妈妈 苹果')).toBe(true);
    // The Why is the rule's, names the cake preference with its reason, and says why cake was not taken.
    const why = step.state.whys.find(w => w.id === claim.whyId)!;
    expect(why.source).toBe('rule');
    expect(why.summary).toContain('fixed rules, not the model');
    expect(why.summary).toContain('蛋糕 was left for a parent to choose');
    expect(why.summary).toContain('Noa enjoys baking it with us the most');
    expect(why.summary).toContain('Nothing is posted until a parent taps');
    expect(why.summaryZh).toContain('留给家长决定');
    // Looking again changes nothing: one claim per message version.
    expect(considerSignUps(step.state, MON_10, adapters).changed).toBe(false);
  });

  it('a parent tap with the card token posts the claim like any card', async () => {
    const start = considerSignUps(turnOn(withSignUp(), false), MON_10, holder(withSignUp(), MON_10).adapters).state;
    const { box, ref, adapters } = holder(start, MON_10);
    const cardId = box.state.groupClaims![0].cardId!;
    expect((await executeAction(ref, cardId, { kind: 'auto' }, { adapters, key: KEY, now: () => box.now })).ok).toBe(false);
    const issued = issueConfirmation(box.state, cardId, 'dad', { key: KEY, now: box.now }, adapters);
    if (!issued.ok) throw new Error('token');
    expect((await executeAction(ref, cardId, { kind: 'tap', memberId: 'dad', token: issued.token }, { adapters, key: KEY, now: () => box.now })).ok).toBe(true);
    const after = afterGroupCard(box.state, box.state.actionCards.find(c => c.id === cardId)!, box.now, fixedClock(box.now));
    expect(after?.claim.status).toBe('claimed');
  });

  it('at level 4: posts on its own, puts the party and two preparations on the board ("Who\'s taking this?"), and tells the family', async () => {
    const start = turnOn(withSignUp(), true);
    const { box, ref, adapters } = holder(start, MON_10);
    box.state = considerSignUps(box.state, MON_10, adapters).state;
    const claim = box.state.groupClaims![0];
    const { ran, after } = await runAuto(box, ref, adapters, claim.cardId!);
    expect(ran.ok).toBe(true);
    expect(after?.claim).toMatchObject({ status: 'claimed', choice: 'apples' });
    const reply = servicesOf(box.state).group.messages.at(-1)!;
    expect(reply).toMatchObject({ from: 'family', replyKind: 'claim', replyTo: 'grp-msg-2', author: "Noa's mom", authorZh: '诺娅妈妈', simulated: true });

    const event = box.state.items.find(i => i.id === after!.claim.eventId)!;
    expect(event).toMatchObject({ type: 'event', title: 'Kindergarten autumn food party', titleZh: '幼儿园秋季美食派对', start: new Date(THU_15).toISOString(), status: 'open', forMemberIds: ['noa'] });
    expect(event.source).toEqual({ kind: 'rule', label: 'Sunflower class parents (simulated group)', simulated: true });
    const preps = after!.claim.preparationIds!.map(id => box.state.items.find(i => i.id === id)!);
    expect(preps.map(p => [p.title, p.titleZh, p.start])).toEqual([
      ['Buy apples for the kindergarten party (8 children)', '为幼儿园派对买苹果（8个小朋友）', new Date(at(2026, 11, 11, 18)).toISOString()],
      ['Bring the apples to kindergarten', '把苹果带到幼儿园', new Date(at(2026, 11, 12, 8)).toISOString()]
    ]);
    for (const p of preps) expect(p).toMatchObject({ type: 'preparation', parentEventId: event.id, status: 'open', ownership: { state: 'open', candidateIds: ['mom', 'dad'] } });
    // Everyone with an account gets one notice, labelled simulated.
    expect(after!.alerts.map(a => a.recipientId)).toEqual(['mom', 'dad', 'maya']);
    expect(after!.alerts[0].alert).toMatchObject({ kind: 'group', itemId: event.id, groupChoice: 'apples', groupChoiceZh: '苹果', simulated: true, tier: 'timed' });
    // Each board change is a normal change: activity with Undo.
    expect(box.state.activity.filter(a => a.kind === 'create' && a.undo).length).toBe(3);
  });

  it('reminders follow: a preparation within the planning window gets an open reminder to both parents', async () => {
    const start = turnOn(withSignUp(), true);
    const { box, ref, adapters } = holder(start, MON_10);
    box.state = considerSignUps(box.state, MON_10, adapters).state;
    await runAuto(box, ref, adapters, box.state.groupClaims![0].cardId!);
    const buyId = box.state.groupClaims![0].preparationIds![0];
    const ticked = tickReminders(box.state, at(2026, 11, 10, 20));
    expect(ticked.state.reminders.find(r => r.itemId === buyId)).toMatchObject({ ask: 'open', recipientIds: ['mom', 'dad'] });
  });

  it('"Change" to cake: posts a correction, swaps the preparations, and says so', async () => {
    const start = turnOn(withSignUp(), true);
    const { box, ref, adapters } = holder(start, MON_10);
    box.state = considerSignUps(box.state, MON_10, adapters).state;
    await runAuto(box, ref, adapters, box.state.groupClaims![0].cardId!);
    const claim = box.state.groupClaims![0];
    const view = groupsView(box.state).claims[0];
    // Cake first, with the saved preference and its reason; taken and non-food choices are not offered.
    expect(view.alternatives.map(a => a.key)).toEqual(['cake', 'oranges', 'cookies']);
    expect(view.alternatives[0]).toMatchObject({ effort: 'make', preferences: [{ id: 'pref-noa-cake', reason: 'Noa enjoys baking it with us the most' }] });

    expect(requestGroupChange(box.state, claim.id, 'cake', 'maya', MON_10, adapters)).toMatchObject({ ok: false, status: 403 });
    expect(requestGroupChange(box.state, claim.id, 'bananas', 'dad', MON_10, adapters)).toMatchObject({ ok: false, status: 409, code: 'not_available' });
    const asked = requestGroupChange(box.state, claim.id, 'cake', 'dad', MON_10, adapters);
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    box.state = asked.state;
    expect(requestGroupChange(box.state, claim.id, 'oranges', 'dad', MON_10, adapters)).toMatchObject({ ok: false, code: 'change_waiting' });
    const { ran, after } = await runAuto(box, ref, adapters, asked.card.id);
    expect(ran.ok).toBe(true);
    expect(servicesOf(box.state).group.messages.at(-1)).toMatchObject({ replyKind: 'correction', text: '更正：诺娅妈妈认领改为蛋糕（原来是苹果）', author: "Noa's dad" });
    expect(after!.claim).toMatchObject({ choice: 'cake', changes: [{ from: 'apples', to: 'cake', by: 'dad', status: 'posted' }] });
    for (const id of claim.preparationIds!) expect(box.state.items.find(i => i.id === id)?.status).toBe('cancelled');
    const preps = after!.claim.preparationIds!.map(id => box.state.items.find(i => i.id === id)!);
    expect(preps.map(p => p.titleZh)).toEqual(['买做蛋糕的材料', '为派对做蛋糕（8个小朋友）', '把蛋糕带到幼儿园']);
    expect(after!.alerts[0].alert).toMatchObject({ groupChoiceZh: '蛋糕', groupFromZh: '苹果' });
    const why = box.state.whys.find(w => w.id === after!.claim.whyId)!;
    expect(why).toMatchObject({ source: 'rule' });
    expect(why.summary).toContain('Dad tapped Change: 苹果 → 蛋糕');
    expect(why.summary).toContain('For kindergarten parties, bake a cake');
  });

  it('a hard preference rules a choice out everywhere, and the Why says so', () => {
    const signUp = message('s-1', '#接龙\n周四美食派对 认领食物（花生糖、苹果、蛋糕）\n1. 乐乐妈妈 蛋糕');
    const state = turnOn(withMessages(TEACHER, signUp), false);
    const step = considerSignUps(state, MON_10, holder(state, MON_10).adapters);
    expect(step.claims[0]).toMatchObject({ status: 'waiting', choice: 'apples' });
    const why = step.state.whys.find(w => w.id === step.claims[0].whyId)!;
    expect(why.summary).toContain('花生糖 was ruled out: “No peanuts” is never overridden');
  });

  it('a soft preference for something to buy is taken first', () => {
    const grapes: Preference = { id: 'pref-grapes', aboutMemberId: 'noa', text: 'For kindergarten parties, bring grapes', strength: 'soft', scope: 'kindergarten-party' };
    const signUp = message('s-1', '#接龙\n周四美食派对 认领食物（苹果、葡萄）');
    const base = withMessages(TEACHER, signUp);
    const state = turnOn({ ...base, preferences: [...base.preferences, grapes] }, false);
    expect(considerSignUps(state, MON_10, holder(state, MON_10).adapters).claims[0].choice).toBe('grapes');
  });

  it.each([
    ['an unclear message', '#接龙\n周四美食派对 认领食物（苹果、橙子）\n1. 乐乐妈妈 西瓜', MON_10, 'unclear'],
    ['the sign-up has closed', '#接龙\n周四美食派对 认领食物（苹果、橙子）', at(2026, 11, 11, 21), 'closed'],
    ['the family is already on it', '#接龙\n周四美食派对 认领食物（苹果、橙子）\n1. 诺娅妈妈 橙子', MON_10, 'already_signed_up'],
    ['only things to make or not food are left', '#接龙\n周四美食派对 认领食物（蛋糕、纸盘、苹果）\n1. 乐乐妈妈 苹果', MON_10, 'nothing_suitable']
  ])('stops visibly on %s: no card', (_name, text, now, reason) => {
    const state = turnOn(withMessages(TEACHER, message('s-1', text)), true);
    const step = considerSignUps(state, now, holder(state, now).adapters);
    expect(step.claims[0]).toMatchObject({ status: 'stopped', reason });
    expect(step.state.actionCards).toEqual([]);
    expect(step.state.whys.find(w => w.id === step.claims[0].whyId)?.summary).toContain('Nothing was posted');
  });

  it('paused: stops, and looks again once the family is running', () => {
    const on = turnOn(withSignUp(), true);
    const paused = { ...on, family: { ...on.family, paused: true } };
    const { adapters } = holder(paused, MON_10);
    const stopped = considerSignUps(paused, MON_10, adapters);
    expect(stopped.claims[0]).toMatchObject({ status: 'stopped', reason: 'paused' });
    const running = { ...stopped.state, family: { ...stopped.state.family, paused: false } };
    const again = considerSignUps(running, MON_10, adapters);
    expect(again.claims[0]).toMatchObject({ id: stopped.claims[0].id, status: 'waiting' });
    expect(again.state.groupClaims).toHaveLength(1);
  });

  it('turning the setting off withdraws a claim card still waiting', () => {
    const state = turnOn(withSignUp(), false);
    const step = considerSignUps(state, MON_10, holder(state, MON_10).adapters);
    const off = applyGroupPolicy(step.state, { action: 'group-claims', groupId: 'kg-sunflower', enabled: false }, 'dad', MON_10 + MIN);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.state.actionCards[0]).toMatchObject({ status: 'cancelled', executedBy: 'homemind', error: 'Group claims were turned off' });
    expect(off.policy).toEqual({ groupId: 'kg-sunflower', enabled: false, maxCost: 50, currency: 'CNY' });
  });

  it('preparation times that have passed are left out rather than set in the past', () => {
    const state = turnOn(withSignUp(), true);
    const claim = considerSignUps(state, MON_10, holder(state, MON_10).adapters).claims[0];
    const late = preparationsFor(foodFor('苹果')!, '苹果', claim, ZONE, at(2026, 11, 11, 19));
    expect(late[0]).toEqual({ title: 'Buy apples for the kindergarten party (8 children)', titleZh: '为幼儿园派对买苹果（8个小朋友）' });
    expect(late[1].start).toBe(new Date(at(2026, 11, 12, 8)).toISOString());
  });
});

describe('screens', () => {
  const screenData = (state: HomemindState, memberId: string, lang: 'en' | 'zh', screen: 'my-day' | 'services') => {
    const view = viewFor(state, memberId) as unknown as HomemindViewData;
    const turn = screenTurn(screen, { lang, now: new Date(MON_10).toISOString(), view, groups: groupsView(state), ...(screen === 'services' ? { services: servicesViewFor(state, memberId, MON_10) } : {}) });
    const surface = A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0];
    return { turn, surface, json: turn.jsonl };
  };

  it('My day shows what was signed up for, with Why? and the choices a parent can change to; a teen sees no Change button', async () => {
    const start = turnOn(withSignUp(), true);
    const { box, ref, adapters } = holder(start, MON_10);
    box.state = considerSignUps(box.state, MON_10, adapters).state;
    await runAuto(box, ref, adapters, box.state.groupClaims![0].cardId!);
    const mom = screenData(box.state, 'mom', 'en', 'my-day');
    expect(mom.surface).toBeDefined();
    expect(mom.json).toContain('Signed up: 苹果 (apples) · Kindergarten autumn food party');
    expect(mom.json).toContain('read by fixed rules, not the model');
    expect(mom.json).toContain('Saved preference: “For kindergarten parties, bake a cake” because Noa enjoys baking it with us the most');
    expect(mom.json).toContain('"verb":"group-change"');
    const dad = screenData(box.state, 'dad', 'zh', 'my-day');
    expect(dad.json).toContain('已认领：苹果 · 幼儿园秋季美食派对');
    expect(dad.json).toContain('改成这个');
    const maya = screenData(box.state, 'maya', 'en', 'my-day');
    expect(maya.json).toContain('Signed up: 苹果 (apples)');
    expect(maya.json).not.toContain('"verb":"group-change"');
  });

  it('Services shows the setting: off with two ways to turn it on for a parent, and the limits; a teen gets no buttons', () => {
    const state = withSignUp();
    const mom = screenData(state, 'mom', 'en', 'services');
    expect(mom.json).toContain('Off. Homemind does not sign the family up for anything here.');
    expect(mom.json).toContain('Turn on: post on its own (level 4)');
    expect(mom.json).toContain('Turn on: ask me each time');
    const on = screenData(turnOn(state, true), 'dad', 'zh', 'services');
    expect(on.json).toContain('已开启，由妈妈于');
    expect(on.json).toContain('会自动发送认领（等级 4，仅限模拟群）');
    const maya = screenData(state, 'maya', 'en', 'services');
    expect(maya.json).toContain('Only a parent can change this.');
    expect(maya.json).not.toContain('"verb":"group-policy"');
  });
});
