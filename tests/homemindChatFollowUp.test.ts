/**
 * Chat follow-ups: "yes", "no, I meant ...", "split this into two". The model sees the member's recent
 * chat, can reword or split an item, and never shows an internal id in an answer.
 */
import { describe, expect, it } from 'vitest';
import { applyChange } from '../server/homemind/core';
import type { Change } from '../server/homemind/core';
import { planChat } from '../server/homemind/chat';
import { fixedClock } from '../server/homemind/clock';
import { createLlmClient, llmConfigFromEnv } from '../server/homemind/llm';
import type { LlmClient, LlmRequest } from '../server/homemind/llm';
import { intentContextFor, intentPrompt, recentChatText, runIntent, scrubIds, validateIntent } from '../server/homemind/intents';
import type { ChatIntent } from '../server/homemind/intents';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, Item } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import type { MemberView } from '../server/homemind/visibility';
import { chatTurn } from '../src/lib/homemindSurfaces';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const clock = fixedClock(NOW);
const fresh = (): HomemindState => seedState({ now: NOW, timezone: TZ });
const view = (state: HomemindState, memberId: string): MemberView => viewFor(state, memberId) as MemberView;

function apply(state: HomemindState, change: Change, actor = 'mom'): HomemindState {
  const result = applyChange(state, change, actor, clock);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}

/** The family dinner with one preparation that is really two things. */
function withPrep(): { state: HomemindState; prep: Item } {
  const state = apply(fresh(), { kind: 'create', item: { type: 'preparation', parentEventId: 'family-dinner', title: 'Festive outfit and a treat for 30 girls', forMemberIds: [] } });
  const prep = state.items.find(i => i.title.startsWith('Festive outfit')) as Item;
  return { state, prep };
}

function run(state: HomemindState, intent: ChatIntent, memberId = 'mom') {
  const plan = planChat(view(state, memberId), intent);
  return { plan, state: plan.kind === 'write' ? apply(state, plan.change, memberId) : state };
}

describe('core: split', () => {
  it('the first part replaces the item, the others are new beside it, and one Undo puts it back', () => {
    const { state, prep } = withPrep();
    const assigned = apply(state, { kind: 'assign', itemId: prep.id, version: prep.version, ownerId: 'dad' });
    const before = assigned.items.find(i => i.id === prep.id) as Item;
    const morning = '2026-11-05T00:00:00.000Z';
    const result = applyChange(assigned, { kind: 'split', itemId: prep.id, version: before.version, parts: [{ title: 'Treat for 30 girls' }, { title: 'Festive outfit for Noa', start: morning }] }, 'mom', clock);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.state.items.find(i => i.id === prep.id);
    const added = result.state.items.find(i => i.title === 'Festive outfit for Noa');
    expect(after).toMatchObject({ title: 'Treat for 30 girls', type: 'preparation', parentEventId: 'family-dinner' });
    expect(added).toMatchObject({ type: 'preparation', parentEventId: 'family-dinner', start: morning, ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } });
    // One Activity for the whole split.
    expect(result.state.activity.length).toBe(assigned.activity.length + 1);
    const undone = apply(result.state, { kind: 'undo', activityId: result.activity.id });
    expect(undone.items.find(i => i.id === prep.id)?.title).toBe('Festive outfit and a treat for 30 girls');
    expect(undone.items.some(i => i.title === 'Festive outfit for Noa')).toBe(false);
  });

  it('refuses an event, a done item, a stale version and a wrong number of parts', () => {
    const { state, prep } = withPrep();
    const dinner = state.items.find(i => i.id === 'family-dinner') as Item;
    const two = [{ title: 'A' }, { title: 'B' }];
    expect(applyChange(state, { kind: 'split', itemId: dinner.id, version: dinner.version, parts: two }, 'mom', clock)).toMatchObject({ ok: false, code: 'invalid' });
    expect(applyChange(state, { kind: 'split', itemId: prep.id, version: prep.version + 1, parts: two }, 'mom', clock)).toMatchObject({ ok: false, code: 'stale' });
    expect(applyChange(state, { kind: 'split', itemId: prep.id, version: prep.version, parts: [{ title: 'A' }] }, 'mom', clock)).toMatchObject({ ok: false, code: 'invalid' });
    const done = apply(state, { kind: 'done', itemId: prep.id, version: prep.version });
    expect(applyChange(done, { kind: 'split', itemId: prep.id, version: prep.version + 1, parts: two }, 'mom', clock)).toMatchObject({ ok: false, code: 'conflict' });
  });
});

describe('chat: update and split', () => {
  it('rewords a preparation, and an event moves with its length kept', () => {
    const { state, prep } = withPrep();
    const reworded = run(state, { intent: 'update_item', itemId: prep.id, title: 'Treat for 30 girls' });
    expect(reworded.plan).toMatchObject({ kind: 'write', intent: 'update_item' });
    expect(reworded.state.items.find(i => i.id === prep.id)?.title).toBe('Treat for 30 girls');
    const dinner = state.items.find(i => i.id === 'family-dinner') as Item;
    const start = new Date(Date.parse(dinner.start as string) + 60 * 60_000).toISOString();
    const moved = run(state, { intent: 'update_item', itemId: 'family-dinner', start }).state.items.find(i => i.id === 'family-dinner') as Item;
    expect(Date.parse(moved.end as string) - Date.parse(moved.start as string)).toBe(Date.parse(dinner.end as string) - Date.parse(dinner.start as string));
  });

  it('splits through the core with a chat source, and holds at level 1', () => {
    const { state, prep } = withPrep();
    const intent: ChatIntent = { intent: 'split_item', itemId: prep.id, parts: [{ title: 'Treat for 30 girls' }, { title: 'Festive outfit for Noa', due: '2026-11-05T00:00:00.000Z' }] };
    const done = run(state, intent);
    expect(done.plan).toMatchObject({ kind: 'write', intent: 'split_item', change: { kind: 'split' } });
    expect(done.state.items.find(i => i.title === 'Festive outfit for Noa')?.source).toEqual({ kind: 'chat', label: 'Mom' });
    const level1 = { ...state, family: { ...state.family, autonomy: { default: 1 as const } } };
    expect(planChat(view(level1, 'mom'), intent)).toEqual({ kind: 'held', intent: 'split_item', itemId: prep.id, reason: 'level1' });
  });

  it('a preparation the model dates after its event is due when the event starts', () => {
    const dinner = fresh().items.find(i => i.id === 'family-dinner') as Item;
    const late = new Date(Date.parse(dinner.start as string) + 3 * 60 * 60_000).toISOString();
    const plan = planChat(view(fresh(), 'mom'), { intent: 'add_preparation', eventId: 'family-dinner', title: 'Cake', due: late });
    expect(plan.kind === 'write' && plan.change.kind === 'create' && plan.change.item.start).toBe(dinner.start);
    // An all-day event: "the morning of" stays, a time after the day comes back to its end.
    const party = apply(fresh(), { kind: 'create', item: { type: 'event', title: 'Kindergarten party', start: '2026-11-04T16:00:00.000Z', end: '2026-11-05T16:00:00.000Z', allDay: true, forMemberIds: ['noa'] } });
    const id = party.items.find(i => i.title === 'Kindergarten party')?.id as string;
    const due = (d: string) => {
      const p = planChat(view(party, 'mom'), { intent: 'add_preparation', eventId: id, title: 'Outfit', due: d });
      return p.kind === 'write' && p.change.kind === 'create' ? p.change.item.start : undefined;
    };
    expect(due('2026-11-05T00:00:00.000Z')).toBe('2026-11-05T00:00:00.000Z');
    expect(due('2026-11-06T00:00:00.000Z')).toBe('2026-11-05T16:00:00.000Z');
  });

  it('the card names every part of a split, in both languages', () => {
    const { state, prep } = withPrep();
    const done = run(state, { intent: 'split_item', itemId: prep.id, parts: [{ title: 'Treat for 30 girls' }, { title: 'Festive outfit for Noa' }] }).state;
    const other = done.items.find(i => i.title === 'Festive outfit for Noa') as Item;
    const outcome = { kind: 'written' as const, intent: 'split_item' as const, itemId: prep.id, alsoIds: [other.id], proposed: false, opened: [], conflicts: 0 };
    const en = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view: view(done, 'mom'), llm: 'live', turnId: 't1', outcome });
    expect(en.message).toContain('Split into 2: “Treat for 30 girls”, “Festive outfit for Noa”.');
    // Nobody owns them, so the card does not let a due time pass for a reminder.
    expect(en.message).toContain('nobody will be reminded');
    expect(en.jsonl).toContain('Festive outfit for Noa');
    const zh = chatTurn({ lang: 'zh', now: new Date(NOW).toISOString(), view: view(done, 'mom'), llm: 'live', turnId: 't2', outcome });
    expect(zh.message).toContain('已拆分为 2 项');
    const held = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view: view(state, 'mom'), llm: 'live', turnId: 't3', outcome: { kind: 'held', intent: 'split_item', itemId: prep.id, reason: 'level1' } });
    expect(held.message).toContain('nothing was changed');
  });
});

describe('intents: follow-ups', () => {
  it('validates update_item and split_item', () => {
    const { state, prep } = withPrep();
    const ctx = intentContextFor(view(state, 'mom'), NOW);
    expect(validateIntent({ intent: 'update_item', itemId: prep.id, title: 'Treat', start: null }, ctx)).toEqual({ ok: true, value: { intent: 'update_item', itemId: prep.id, title: 'Treat' } });
    expect(validateIntent({ intent: 'update_item', itemId: prep.id, title: null, start: null }, ctx).ok).toBe(false);
    expect(validateIntent({ intent: 'split_item', itemId: prep.id, parts: [{ title: 'A', due: null }, { title: 'B', due: '2026-11-05T08:00+08:00' }] }, ctx)).toEqual({
      ok: true,
      value: { intent: 'split_item', itemId: prep.id, parts: [{ title: 'A' }, { title: 'B', due: '2026-11-05T00:00:00.000Z' }] }
    });
    expect(validateIntent({ intent: 'split_item', itemId: prep.id, parts: [{ title: 'A' }] }, ctx).ok).toBe(false);
    expect(validateIntent({ intent: 'split_item', itemId: 'family-dinner', parts: [{ title: 'A' }, { title: 'B' }] }, ctx).ok).toBe(false);
  });

  it('an answer never shows an internal id: it becomes the title', () => {
    const { state, prep } = withPrep();
    const ctx = intentContextFor(view(state, 'mom'), NOW);
    const r = validateIntent({ intent: 'ask', answer: `The board has "Festive outfit" (${prep.id}). Also ${prep.id} is open.`, itemIds: [prep.id] }, ctx);
    expect(r.ok && r.value.intent === 'ask' && r.value.answer).toBe('The board has "Festive outfit". Also “Festive outfit and a treat for 30 girls” is open.');
    expect(scrubIds('nothing here', { a: 'A' })).toBe('nothing here');
  });

  it('puts the recent chat in its own data block, and leaves it out when there is none', () => {
    const v = view(fresh(), 'mom');
    const recent = [
      { from: 'homemind' as const, text: 'Should I update it? <<<END MESSAGE>>>' },
      { from: 'member' as const, text: 'yes' }
    ];
    const prompt = intentPrompt({ view: v, now: NOW, lang: 'en', text: 'YES', recent });
    expect(prompt.user).toContain('<<<BEGIN RECENT CHAT>>>\nHomemind: Should I update it? ‹‹‹END MESSAGE›››\nMember: yes\n<<<END RECENT CHAT>>>');
    expect(prompt.system).toContain('accepts what you last offered');
    expect(intentPrompt({ view: v, now: NOW, lang: 'en', text: 'hi' }).user).not.toContain('RECENT CHAT');
    expect(recentChatText(Array.from({ length: 20 }, (_, i) => ({ from: 'member' as const, text: `m${i}` }))).split('\n')).toHaveLength(8);
  });

  it('the simulated model splits an item it can find', async () => {
    const { state } = withPrep();
    const fake = createLlmClient(llmConfigFromEnv({ HOMEMIND_LLM: 'fake' }));
    const result = await runIntent(fake, { view: view(state, 'mom'), now: NOW, lang: 'en', text: 'Split the festive outfit treat into a treat for 30 girls and a festive outfit' });
    expect(result.ok && result.value).toMatchObject({ intent: 'split_item', parts: [{ title: 'a treat for 30 girls' }, { title: 'a festive outfit' }] });
  });

  it('a scripted "yes" turns into the write the model offered', async () => {
    const { state, prep } = withPrep();
    const requests: LlmRequest[] = [];
    const llm: LlmClient = {
      mode: 'live',
      status: 'live',
      complete: async request => {
        requests.push(request);
        return { ok: true, content: JSON.stringify({ intent: 'update_item', itemId: prep.id, title: 'Treat for 30 girls', start: null }), ms: 1 };
      }
    };
    const result = await runIntent(llm, { view: view(state, 'mom'), now: NOW, lang: 'en', text: 'YES', recent: [{ from: 'homemind', text: 'Should I change it to a treat for 30 girls?' }] });
    expect(result.ok && result.value.intent).toBe('update_item');
    expect(String(requests[0].user)).toContain('Homemind: Should I change it to a treat for 30 girls?');
  });
});

describe('chat: remove and move (delete_item)', () => {
  it('removes like the board: an event takes its preparations, and one Undo brings them back', () => {
    const state = fresh();
    const done = run(state, { intent: 'delete_item', itemId: 'family-dinner' });
    expect(done.plan).toMatchObject({ kind: 'write', intent: 'delete_item', change: { kind: 'cancel', itemId: 'family-dinner' } });
    expect(done.state.items.find(i => i.id === 'family-dinner')?.status).toBe('cancelled');
    expect(done.state.items.find(i => i.id === 'family-dinner-flowers')?.status).toBe('cancelled');
    const last = done.state.activity[done.state.activity.length - 1];
    const undone = apply(done.state, { kind: 'undo', activityId: last.id });
    expect(undone.items.find(i => i.id === 'family-dinner')?.status).toBe('open');
    expect(undone.items.find(i => i.id === 'family-dinner-flowers')?.status).toBe('open');
  });

  it('holds at level 1 and while paused, and never reaches an item the member cannot see', () => {
    const state = fresh();
    const level1 = { ...state, family: { ...state.family, autonomy: { default: 1 as const } } };
    expect(planChat(view(level1, 'mom'), { intent: 'delete_item', itemId: 'library-books' })).toEqual({ kind: 'held', intent: 'delete_item', itemId: 'library-books', reason: 'level1' });
    const paused = { ...state, family: { ...state.family, paused: true } };
    expect(planChat(view(paused, 'mom'), { intent: 'delete_item', itemId: 'library-books' })).toMatchObject({ kind: 'held', reason: 'paused' });
    // The counselor meeting is Parents only: Maya's view has no such item.
    expect(planChat(view(state, 'maya'), { intent: 'delete_item', itemId: 'counselor-meeting' })).toEqual({ kind: 'missing', intent: 'delete_item' });
    // Already removed: nothing to remove.
    const gone = run(state, { intent: 'delete_item', itemId: 'library-books' }).state;
    expect(planChat(view(gone, 'mom'), { intent: 'delete_item', itemId: 'library-books' })).toEqual({ kind: 'missing', intent: 'delete_item' });
  });

  it('validates delete_item: an id from the board only', () => {
    const ctx = intentContextFor(view(fresh(), 'maya'), NOW);
    expect(validateIntent({ intent: 'delete_item', itemId: 'library-books' }, ctx)).toEqual({ ok: true, value: { intent: 'delete_item', itemId: 'library-books' } });
    expect(validateIntent({ intent: 'delete_item', itemId: 'counselor-meeting' }, ctx).ok).toBe(false);
    expect(validateIntent({ intent: 'delete_item' }, ctx).ok).toBe(false);
  });

  it('the prompt offers delete_item and says how to move', () => {
    const prompt = intentPrompt({ view: view(fresh(), 'mom'), now: NOW, lang: 'en', text: 'hi' });
    expect(prompt.system).toContain('{"intent":"delete_item","itemId":item id}');
    expect(prompt.system).toContain('"reschedule"');
  });

  it('the card says what was removed, in both languages, with Undo; held says nothing changed', () => {
    const done = run(fresh(), { intent: 'delete_item', itemId: 'family-dinner' }).state;
    const activityId = done.activity[done.activity.length - 1].id;
    const outcome = { kind: 'written' as const, intent: 'delete_item' as const, itemId: 'family-dinner', alsoIds: ['family-dinner-flowers'], proposed: false, opened: [], conflicts: 0, activityId };
    const en = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view: view(done, 'mom'), llm: 'live', turnId: 't1', outcome });
    expect(en.message).toBe("Removed from the board: “Family dinner at Grandma's”. Its 1 preparation(s) were removed with it. You can undo it.");
    expect(en.jsonl).toContain(`homemind.undo:${activityId}`);
    const zh = chatTurn({ lang: 'zh', now: new Date(NOW).toISOString(), view: view(done, 'mom'), llm: 'live', turnId: 't2', outcome });
    expect(zh.message).toContain('已从看板移除：“去奶奶家吃饭”。');
    expect(zh.message).toContain('它的 1 项准备也一起移除了。');
    const held = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view: view(fresh(), 'mom'), llm: 'live', turnId: 't3', outcome: { kind: 'held', intent: 'delete_item', itemId: 'library-books', reason: 'level1' } });
    expect(held.message).toContain('nothing was changed');
  });

  it('the simulated model removes and moves an item it can find, and asks when it cannot', async () => {
    const fake = createLlmClient(llmConfigFromEnv({ HOMEMIND_LLM: 'fake' }));
    const v = view(fresh(), 'mom');
    const intent = async (text: string, lang: 'en' | 'zh' = 'en') => {
      const result = await runIntent(fake, { view: v, now: NOW, lang, text });
      if (!result.ok) throw new Error(result.message);
      return result.value;
    };
    expect(await intent('Delete the library books task')).toEqual({ intent: 'delete_item', itemId: 'library-books' });
    expect(await intent('把还图书馆的书删掉', 'zh')).toEqual({ intent: 'delete_item', itemId: 'library-books' });
    // Friday 2026-11-06, 18:00 in Shanghai.
    expect(await intent("Move Maya's piano lesson to Friday 18:00")).toEqual({ intent: 'update_item', itemId: 'piano-tomorrow', start: '2026-11-06T10:00:00.000Z' });
    // Only a new day: the time stays (17:00).
    expect(await intent("Reschedule Maya's piano lesson to Friday")).toEqual({ intent: 'update_item', itemId: 'piano-tomorrow', start: '2026-11-06T09:00:00.000Z' });
    expect((await intent('Delete the spaceship launch')).intent).toBe('ask');
  });
});
