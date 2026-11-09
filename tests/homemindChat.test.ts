import { describe, expect, it } from 'vitest';
import { applyChange } from '../server/homemind/core';
import { chatMayWrite, eventTimes, explainItem, planChat } from '../server/homemind/chat';
import type { ChatPlan } from '../server/homemind/chat';
import { fixedClock, localParts } from '../server/homemind/clock';
import type { ChatIntent } from '../server/homemind/intents';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import type { MemberView } from '../server/homemind/visibility';
import { chatTurn, plainChatText } from '../src/lib/homemindSurfaces';
import type { ChatOutcome } from '../src/lib/homemindSurfaces';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const clock = fixedClock(NOW);
const fresh = (): HomemindState => seedState({ now: NOW, timezone: TZ });
const view = (state: HomemindState, memberId: string): MemberView => viewFor(state, memberId) as MemberView;
const withAutonomy = (state: HomemindState, level: 1 | 2 | 3 | 4, paused = false): HomemindState => ({ ...state, family: { ...state.family, autonomy: { default: level }, paused } });

/** Plans the intent for the member and applies a write the way the bridge does. */
function run(state: HomemindState, memberId: string, intent: ChatIntent): { plan: ChatPlan; state: HomemindState } {
  const plan = planChat(view(state, memberId), intent);
  if (plan.kind !== 'write') return { plan, state };
  const result = applyChange(state, plan.change, memberId, clock);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return { plan, state: result.state };
}

describe('planChat: writes at the default level (3)', () => {
  it('creates an event from chat with a chat source, an hour long when the model gave no end', () => {
    const start = '2026-11-06T07:00:00.000Z';
    const { plan, state } = run(fresh(), 'mom', { intent: 'create_event', title: 'Dentist', start, allDay: false, forMemberIds: ['noa'], unavailableMemberIds: [], visibility: 'family', importance: 'normal' });
    expect(plan).toMatchObject({ kind: 'write', intent: 'create_event', proposed: false });
    const item = state.items.find(i => i.title === 'Dentist');
    expect(item).toMatchObject({ type: 'event', status: 'open', start, end: '2026-11-06T08:00:00.000Z', source: { kind: 'chat', label: 'Mom' }, createdBy: 'mom' });
    // Every chat write has Undo.
    expect(state.activity.at(-1)?.undo).toBeTruthy();
  });

  it('an all-day event runs from local midnight to the next, and a child is never "away"', () => {
    const times = eventTimes('2026-11-07T05:00:00+08:00', undefined, true, TZ);
    expect(times).toEqual({ start: '2026-11-06T16:00:00.000Z', end: '2026-11-07T16:00:00.000Z', allDay: true });
    const plan = planChat(view(fresh(), 'mom'), { intent: 'create_event', title: 'Wedding', start: '2026-11-10T10:00:00.000Z', allDay: false, forMemberIds: [], unavailableMemberIds: ['mom', 'noa'], visibility: 'family', importance: 'normal' });
    expect(plan.kind === 'write' && plan.change.kind === 'create' && plan.change.item.unavailableMemberIds).toEqual(['mom']);
  });

  it('creates a task with the owner the member named, unconfirmed for someone else', () => {
    const { state } = run(fresh(), 'mom', { intent: 'create_task', title: 'Buy milk', due: '2026-11-05T01:00:00.000Z', ownerId: 'dad', forMemberIds: [] });
    expect(state.items.find(i => i.title === 'Buy milk')).toMatchObject({ type: 'task', start: '2026-11-05T01:00:00.000Z', ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } });
    const mine = run(fresh(), 'mom', { intent: 'create_task', title: 'Call school', ownerId: 'mom', forMemberIds: [] }).state;
    expect(mine.items.find(i => i.title === 'Call school')?.ownership).toEqual({ state: 'assigned', ownerId: 'mom', confirmed: true });
  });

  it('adds a preparation under the event', () => {
    const { state } = run(fresh(), 'dad', { intent: 'add_preparation', eventId: 'family-dinner', title: 'Bake a cake' });
    expect(state.items.find(i => i.title === 'Bake a cake')).toMatchObject({ type: 'preparation', parentEventId: 'family-dinner', source: { kind: 'chat', label: 'Dad' } });
  });

  it('reassigns, claims and marks done through the core, with the current version', () => {
    let state = fresh();
    state = run(state, 'mom', { intent: 'assign', itemId: 'pickup-today', memberId: 'dad' }).state;
    expect(state.items.find(i => i.id === 'pickup-today')?.ownership).toEqual({ state: 'assigned', ownerId: 'dad', confirmed: false });
    // "I'll take it" on something Dad has is a reassignment to yourself.
    const claim = run(state, 'mom', { intent: 'claim', itemId: 'pickup-today' });
    expect(claim.plan.kind === 'write' && claim.plan.change.kind).toBe('assign');
    expect(claim.state.items.find(i => i.id === 'pickup-today')?.ownership).toMatchObject({ ownerId: 'mom' });
    const open = run(fresh(), 'maya', { intent: 'claim', itemId: 'library-books' });
    expect(open.plan.kind === 'write' && open.plan.change.kind).toBe('claim');
    const done = run(open.state, 'maya', { intent: 'mark_done', itemId: 'library-books' });
    expect(done.state.items.find(i => i.id === 'library-books')?.status).toBe('done');
  });
});

describe('planChat: autonomy', () => {
  it('level 1 creates only a proposed item, and turns verbs into a button', () => {
    const state = withAutonomy(fresh(), 1);
    expect(chatMayWrite(state.family)).toBe(false);
    const created = run(state, 'mom', { intent: 'create_task', title: 'Buy milk', forMemberIds: [] });
    expect(created.plan).toMatchObject({ kind: 'write', proposed: true });
    expect(created.state.items.find(i => i.title === 'Buy milk')?.status).toBe('proposed');
    expect(planChat(view(state, 'mom'), { intent: 'assign', itemId: 'pickup-today', memberId: 'dad' })).toEqual({ kind: 'suggest', intent: 'assign', itemId: 'pickup-today', verb: 'assign', memberId: 'dad', reason: 'level1' });
    expect(planChat(view(state, 'mom'), { intent: 'mark_done', itemId: 'library-books' })).toMatchObject({ kind: 'suggest', verb: 'done' });
  });

  it('pause stops chat writes too, and says that is why', () => {
    const state = withAutonomy(fresh(), 3, true);
    expect(planChat(view(state, 'mom'), { intent: 'claim', itemId: 'library-books' })).toMatchObject({ kind: 'suggest', verb: 'claim', reason: 'paused' });
    expect(planChat(view(state, 'mom'), { intent: 'create_task', title: 'x', forMemberIds: [] })).toMatchObject({ kind: 'write', proposed: true });
    expect(chatMayWrite(withAutonomy(fresh(), 2).family)).toBe(true);
  });
});

describe('planChat: answers, explanations and what is not built', () => {
  it('keeps only rows still on the board', () => {
    expect(planChat(view(fresh(), 'mom'), { intent: 'ask', answer: 'Two things.', itemIds: ['pickup-today', 'gone'] })).toEqual({ kind: 'answer', answer: 'Two things.', itemIds: ['pickup-today'] });
  });

  it('an item that left the board while the model was thinking is "missing"', () => {
    expect(planChat(view(fresh(), 'maya'), { intent: 'mark_done', itemId: 'counselor-meeting' })).toEqual({ kind: 'missing', intent: 'mark_done' });
    expect(planChat(view(fresh(), 'mom'), { intent: 'why', itemId: 'nope' })).toEqual({ kind: 'missing', intent: 'why' });
  });

  it('rules and situations other than "sick" are not built from chat and change nothing', () => {
    const v = view(fresh(), 'mom');
    expect(planChat(v, { intent: 'create_rule', title: 'x', weekday: 5, time: '18:00', leadMinutes: 30, action: 'x' })).toEqual({ kind: 'later', intent: 'create_rule', task: 'T7.3' });
    expect(planChat(v, { intent: 'report_situation', situation: 'late', date: '2026-11-04', summary: 'x' })).toEqual({ kind: 'later', intent: 'report_situation', task: 'T8.1' });
    // T8.1: "sick" is planned by the bridge (situations.ts).
    expect(planChat(v, { intent: 'report_situation', situation: 'sick', date: '2026-11-04', summary: 'x' })).toEqual({ kind: 'situation', memberId: 'mom', date: '2026-11-04', summary: 'x' });
  });

  it('explains from the board record: creator, source and the last change', () => {
    const state = run(fresh(), 'mom', { intent: 'assign', itemId: 'pickup-today', memberId: 'dad' }).state;
    const e = explainItem(view(state, 'dad'), 'pickup-today');
    expect(e).toMatchObject({ itemId: 'pickup-today', createdBy: 'mom', source: { kind: 'manual' } });
    expect(e?.lastActivityId).toBe(state.activity.at(-1)?.id);
    expect(e?.why).toBeUndefined();
    // A stored Why that names the item comes with its own source.
    const withWhy = { ...state, whys: [{ id: 'why-1', summary: 'The Friday rule', basis: [{ kind: 'item', ref: 'pickup-today', note: '' }], source: 'rule' as const }] };
    expect(explainItem(view(withWhy, 'mom'), 'pickup-today')?.why?.source).toBe('rule');
    expect(explainItem(view(fresh(), 'maya'), 'counselor-meeting')).toBeNull();
  });
});

describe('chatTurn', () => {
  const surfaceOf = (jsonl: string) => A2uiSurfaceStore.fromJsonl(jsonl).list()[0];
  const turnFor = (outcome: ChatOutcome, opts: { state?: HomemindState; member?: string; lang?: 'en' | 'zh'; llm?: 'live' | 'fake' } = {}) =>
    chatTurn({ lang: opts.lang ?? 'en', now: new Date(NOW).toISOString(), view: view(opts.state ?? fresh(), opts.member ?? 'mom'), llm: opts.llm ?? 'live', turnId: 't1', outcome });

  it('an answer is plain text, with the rows it is about, and can carry no link', () => {
    const t = turnFor({ kind: 'answer', answer: 'See [this](javascript:alert(1)).', itemIds: ['pickup-today'] });
    expect(t.message).toBe('See [this] (javascript:alert(1)).');
    expect(plainChatText('[a](b) and [c] ( d)')).toBe('[a] (b) and [c] ( d)');
    const s = surfaceOf(t.jsonl);
    expect(s.id).toBe('homemind-chat-t1');
    expect(JSON.stringify(s.data)).toContain('Kindergarten pickup');
    // A live answer with no rows needs no card.
    expect(turnFor({ kind: 'answer', answer: 'Nothing today.', itemIds: [] }).jsonl).toBe('');
  });

  it('the simulated model is labelled on the card, in both languages', () => {
    expect(JSON.stringify(surfaceOf(turnFor({ kind: 'answer', answer: 'x', itemIds: [] }, { llm: 'fake' }).jsonl).components)).toContain('Simulated model');
    expect(JSON.stringify(surfaceOf(turnFor({ kind: 'answer', answer: 'x', itemIds: [] }, { llm: 'fake', lang: 'zh' }).jsonl).components)).toContain('模拟模型');
  });

  it('a write shows the row and an Undo button, in English and Chinese', () => {
    const state = run(fresh(), 'mom', { intent: 'assign', itemId: 'pickup-today', memberId: 'dad' }).state;
    const activityId = state.activity.at(-1)?.id as string;
    const outcome: ChatOutcome = { kind: 'written', intent: 'assign', itemId: 'pickup-today', proposed: false, activityId, opened: [], conflicts: 0 };
    const en = turnFor(outcome, { state });
    expect(en.message).toBe('Assigned “Kindergarten pickup” to Dad. Dad still needs to confirm. You can undo it.');
    const undo = surfaceOf(en.jsonl).components.actions?.actions?.[0];
    expect(undo).toMatchObject({ kind: 'homemind', label: 'Undo', args: { verb: 'undo', activityId, itemId: 'pickup-today' } });
    const zh = turnFor(outcome, { state, lang: 'zh' });
    expect(zh.message).toContain('已把“幼儿园接孩子”分配给爸爸');
    expect(surfaceOf(zh.jsonl).components.actions?.actions?.[0].label).toBe('撤销');
  });

  it('a level-1 suggestion is a button that does it, and changes nothing by itself', () => {
    const t = turnFor({ kind: 'suggest', intent: 'assign', itemId: 'pickup-today', verb: 'assign', memberId: 'dad', reason: 'level1' });
    expect(t.message).toContain('nothing was changed');
    expect(surfaceOf(t.jsonl).components.actions?.actions?.[0]).toMatchObject({ label: 'Assign to Dad', args: { verb: 'assign', itemId: 'pickup-today', memberId: 'dad' } });
  });

  it('"Why?" says it is Homemind’s own record, not PPMA', () => {
    const state = run(fresh(), 'mom', { intent: 'assign', itemId: 'pickup-today', memberId: 'dad' }).state;
    const e = explainItem(view(state, 'mom'), 'pickup-today');
    const t = turnFor({ kind: 'why', explanation: e! }, { state });
    expect(t.message).toBe('Here is what the board records about “Kindergarten pickup”.');
    expect(t.jsonl).toContain('not from PPMA');
    const rows = JSON.stringify(surfaceOf(t.jsonl).data.why);
    expect(rows).toContain('Typed in on the board');
    expect(rows).toContain('Mom assigned to Dad');
  });

  it('failures are an ErrorNotice that says nothing changed', () => {
    const t = turnFor({ kind: 'failed', reason: 'model', code: 'invalid', message: 'bad' });
    const s = surfaceOf(t.jsonl);
    expect(Object.values(s.components).some(c => c.component === 'ErrorNotice' && String(c.body).includes('Nothing was changed'))).toBe(true);
    expect(turnFor({ kind: 'failed', reason: 'not_configured', code: 'not_configured', message: '' }, { lang: 'zh' }).jsonl).toContain('模型未配置');
    expect(turnFor({ kind: 'later', intent: 'create_rule' }).message).toContain('Nothing was set up');
  });

  it('builds every outcome in both languages', () => {
    const outcomes: ChatOutcome[] = [
      { kind: 'answer', answer: 'x', itemIds: ['pickup-today'] },
      { kind: 'written', intent: 'create_task', itemId: 'library-books', proposed: true, opened: [], conflicts: 2 },
      { kind: 'suggest', intent: 'mark_done', itemId: 'library-books', verb: 'done', reason: 'paused' },
      { kind: 'later', intent: 'create_rule' },
      { kind: 'later', intent: 'report_situation' },
      { kind: 'missing' },
      { kind: 'failed', reason: 'change', code: 'conflict', message: 'taken' }
    ];
    for (const lang of ['en', 'zh'] as const) {
      for (const o of outcomes) {
        const t = turnFor(o, { lang, llm: 'fake' });
        expect(t.message || t.jsonl, `${lang} ${o.kind}`).toBeTruthy();
        if (t.jsonl) expect(surfaceOf(t.jsonl), `${lang} ${o.kind}`).toBeTruthy();
      }
    }
    expect(localParts(NOW, TZ).date).toBe('2026-11-04');
  });
});
