import { describe, expect, it } from 'vitest';
import { applyChange } from '../server/homemind/core';
import type { NewItem } from '../server/homemind/core';
import { planChat } from '../server/homemind/chat';
import { fixedClock } from '../server/homemind/clock';
import {
  applicablePreferences,
  applyPreferenceRequest,
  avoidedTerms,
  blockedChange,
  checkChoice,
  itemContext,
  parsePreferenceBody,
  preferencesForItem,
  scopeMatches,
  scopeTerms
} from '../server/homemind/preferences';
import type { PreferenceRequest } from '../server/homemind/preferences';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, Item, Preference } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import type { MemberView } from '../server/homemind/visibility';
import { chatTurn } from '../src/lib/homemindSurfaces';
import type { ChatOutcome } from '../src/lib/homemindSurfaces';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const clock = fixedClock(NOW);
const fresh = (): HomemindState => seedState({ now: NOW, timezone: TZ });
const view = (state: HomemindState, memberId: string): MemberView => viewFor(state, memberId) as MemberView;
const members = fresh().family.members;

function apply(state: HomemindState, request: PreferenceRequest, actor = 'mom', now = NOW) {
  const result = applyPreferenceRequest(state, request, actor, now);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

function create(state: HomemindState, item: NewItem, actor = 'mom'): { state: HomemindState; item: Item } {
  const result = applyChange(state, { kind: 'create', item }, actor, clock);
  if (!result.ok) throw new Error(result.message);
  return { state: result.state, item: result.items[0] };
}

const at = (h: number, day = 5) => new Date(Date.UTC(2026, 10, day, h - 8, 0)).toISOString();
const party = (state: HomemindState, extra: Partial<NewItem> = {}) =>
  create(state, { type: 'event', title: 'Kindergarten autumn party', start: at(15), end: at(16), forMemberIds: ['noa'], ...extra });

describe('parsePreferenceBody', () => {
  it('takes a save with a reason, a scope and a member', () => {
    const parsed = parsePreferenceBody({ text: '  Bake a cake  ', reason: 'Noa enjoys it most', aboutMemberId: 'noa', strength: 'soft', scope: 'Kindergarten-Party' }, members);
    expect(parsed).toEqual({ ok: true, value: { op: 'save', input: { text: 'Bake a cake', reason: 'Noa enjoys it most', aboutMemberId: 'noa', strength: 'soft', scope: 'kindergarten-party' } } });
  });

  it('takes a correction by id, a remove and an undo', () => {
    expect(parsePreferenceBody({ id: 'pref-noa-cake', text: 'x', strength: 'soft' }, members)).toMatchObject({ ok: true, value: { op: 'save', id: 'pref-noa-cake' } });
    expect(parsePreferenceBody({ id: 'pref-noa-cake', remove: true }, members)).toEqual({ ok: true, value: { op: 'remove', id: 'pref-noa-cake' } });
    expect(parsePreferenceBody({ undo: 'act-1' }, members)).toEqual({ ok: true, value: { op: 'undo', activityId: 'act-1' } });
  });

  it('refuses unknown fields, bad values and mixed requests', () => {
    for (const body of [
      null,
      [],
      { text: 'x' },
      { text: '', strength: 'soft' },
      { text: 'x', strength: 'very' },
      { text: 'x', strength: 'soft', aboutMemberId: 'grandpa' },
      { text: 'x', strength: 'soft', scope: '<script>' },
      { text: 'x', strength: 'soft', owner: 'mom' },
      { text: 'x'.repeat(501), strength: 'soft' },
      { text: 'a\u0000b', strength: 'soft' },
      { id: 'Bad Id', text: 'x', strength: 'soft' },
      { id: 'pref-noa-cake', remove: 'yes' },
      { id: 'pref-noa-cake', remove: true, text: 'x' },
      { undo: 'act-1', text: 'x' }
    ]) {
      expect(parsePreferenceBody(body, members).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('applyPreferenceRequest: save, correct, remove, undo', () => {
  it('saves a new preference with its reason and scope, who saved it, and one activity with Undo', () => {
    const r = apply(fresh(), { op: 'save', input: { text: 'Pack a small towel', reason: 'Maya forgets it', aboutMemberId: 'maya', strength: 'soft', scope: 'swimming' } });
    expect(r.action).toBe('added');
    expect(r.preference).toMatchObject({ text: 'Pack a small towel', reason: 'Maya forgets it', aboutMemberId: 'maya', strength: 'soft', scope: 'swimming', createdBy: 'mom' });
    expect(r.state.preferences).toHaveLength(3);
    expect(r.activity).toMatchObject({ kind: 'preference', actor: 'mom', ref: r.preference?.id, note: 'added', prefUndo: { preferenceId: r.preference?.id, before: null } });
  });

  it('the same words again correct the saved one instead of adding a twin (and keep the Chinese)', () => {
    const r = apply(fresh(), { op: 'save', input: { text: 'for kindergarten parties, bake a cake!', reason: 'Noa enjoys it most', aboutMemberId: 'noa', strength: 'soft', scope: 'kindergarten-party' } });
    expect(r.action).toBe('corrected');
    expect(r.state.preferences).toHaveLength(2);
    const cake = r.state.preferences.find(p => p.id === 'pref-noa-cake')!;
    expect(cake.reason).toBe('Noa enjoys it most');
    // The seeded Chinese reason belonged to the old reason; the seeded Chinese text still fits.
    expect(cake.reasonZh).toBeUndefined();
    expect(cake.textZh).toBe('幼儿园聚会时，烤一个蛋糕');
  });

  it('saving exactly what is stored changes nothing', () => {
    const state = fresh();
    const cake = state.preferences.find(p => p.id === 'pref-noa-cake')!;
    const r = apply(state, { op: 'save', id: cake.id, input: { text: cake.text, reason: cake.reason, aboutMemberId: 'noa', strength: 'soft', scope: cake.scope } });
    expect(r).toMatchObject({ changed: false, action: 'corrected' });
    expect(r.state).toBe(state);
  });

  it('only a parent may correct or remove a hard preference, or switch hard and soft; anyone may add one', () => {
    const state = fresh();
    const teen = (request: PreferenceRequest) => applyPreferenceRequest(state, request, 'maya', NOW);
    expect(teen({ op: 'remove', id: 'pref-noa-peanuts' })).toMatchObject({ ok: false, status: 403 });
    expect(teen({ op: 'save', id: 'pref-noa-peanuts', input: { text: 'Peanuts are fine', aboutMemberId: 'noa', strength: 'soft' } })).toMatchObject({ ok: false, status: 403 });
    expect(teen({ op: 'save', id: 'pref-noa-cake', input: { text: 'For kindergarten parties, bake a cake', aboutMemberId: 'noa', strength: 'hard', scope: 'kindergarten-party' } })).toMatchObject({ ok: false, status: 403 });
    expect(teen({ op: 'save', input: { text: 'No kiwi', reason: 'Allergy', aboutMemberId: 'maya', strength: 'hard' } })).toMatchObject({ ok: true, action: 'added' });
    // A teen may correct a soft one.
    expect(teen({ op: 'save', id: 'pref-noa-cake', input: { text: 'For kindergarten parties, bake muffins', aboutMemberId: 'noa', strength: 'soft', scope: 'kindergarten-party' } })).toMatchObject({ ok: true, action: 'corrected' });
    expect(apply(state, { op: 'remove', id: 'pref-noa-peanuts' }, 'dad').state.preferences.map(p => p.id)).toEqual(['pref-noa-cake']);
  });

  it('refuses a member with no account, an unknown id, and too many preferences', () => {
    const state = fresh();
    expect(applyPreferenceRequest(state, { op: 'remove', id: 'pref-noa-cake' }, 'noa', NOW)).toMatchObject({ ok: false, status: 404 });
    expect(applyPreferenceRequest(state, { op: 'remove', id: 'pref-nope' }, 'mom', NOW)).toMatchObject({ ok: false, status: 404 });
    expect(applyPreferenceRequest(state, { op: 'save', id: 'pref-nope', input: { text: 'x', strength: 'soft' } }, 'mom', NOW)).toMatchObject({ ok: false, status: 404 });
    const many: Preference[] = Array.from({ length: 200 }, (_, n) => ({ id: `p-${n}`, text: `Thing ${n}`, strength: 'soft' }));
    expect(applyPreferenceRequest({ ...state, preferences: many }, { op: 'save', input: { text: 'One more', strength: 'soft' } }, 'mom', NOW)).toMatchObject({ ok: false, status: 409 });
  });

  it('Undo puts a correction back, removes a new one, and restores a removed one', () => {
    const corrected = apply(fresh(), { op: 'save', id: 'pref-noa-cake', input: { text: 'Bring fruit', aboutMemberId: 'noa', strength: 'soft', scope: 'kindergarten-party' } });
    const undone = apply(corrected.state, { op: 'undo', activityId: corrected.activity!.id }, 'mom', NOW + 1000);
    expect(undone.state.preferences).toEqual(fresh().preferences);
    expect(undone.state.activity.find(a => a.id === corrected.activity!.id)?.undone).toMatchObject({ by: 'mom', activityId: undone.activity!.id });

    const added = apply(fresh(), { op: 'save', input: { text: 'Quiet mornings', strength: 'soft' } }, 'maya');
    expect(apply(added.state, { op: 'undo', activityId: added.activity!.id }, 'maya').state.preferences).toHaveLength(2);

    const removed = apply(fresh(), { op: 'remove', id: 'pref-noa-peanuts' });
    expect(apply(removed.state, { op: 'undo', activityId: removed.activity!.id }).state.preferences.find(p => p.id === 'pref-noa-peanuts')).toEqual(fresh().preferences[1]);
  });

  it('Undo is refused twice, by someone else (not a parent), for a non-preference activity, and over a newer change', () => {
    const added = apply(fresh(), { op: 'save', input: { text: 'Quiet mornings', strength: 'soft' } }, 'dad');
    const id = added.activity!.id;
    expect(applyPreferenceRequest(added.state, { op: 'undo', activityId: id }, 'maya', NOW)).toMatchObject({ ok: false, status: 403 });
    const once = apply(added.state, { op: 'undo', activityId: id }, 'mom', NOW + 1000);
    expect(applyPreferenceRequest(once.state, { op: 'undo', activityId: id }, 'mom', NOW + 2000)).toMatchObject({ ok: false, status: 409 });
    expect(applyPreferenceRequest(once.state, { op: 'undo', activityId: 'act-nope' }, 'mom', NOW)).toMatchObject({ ok: false, status: 404 });

    const first = apply(fresh(), { op: 'save', id: 'pref-noa-cake', input: { text: 'Bring fruit', aboutMemberId: 'noa', strength: 'soft', scope: 'kindergarten-party' } });
    const second = apply(first.state, { op: 'save', id: 'pref-noa-cake', input: { text: 'Bring juice', aboutMemberId: 'noa', strength: 'soft', scope: 'kindergarten-party' } }, 'mom', NOW + 1000);
    expect(applyPreferenceRequest(second.state, { op: 'undo', activityId: first.activity!.id }, 'mom', NOW + 2000)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('scope: the cake applies to the daughter’s kindergarten party, not to every event', () => {
  it('reads scope names in English and Chinese', () => {
    expect(scopeTerms('kindergarten-party')).toEqual({ concepts: ['kindergarten', 'party'], literals: [] });
    expect(scopeTerms('幼儿园聚会')).toEqual({ concepts: ['kindergarten', 'party'], literals: [] });
    expect(scopeTerms('chess club')).toEqual({ concepts: [], literals: ['chess', 'club'] });
  });

  it('matches every concept the scope names, in either language', () => {
    const ctx = (texts: string[], tags?: string[]) => ({ memberIds: ['noa'], texts, ...(tags ? { tags } : {}) });
    expect(scopeMatches('kindergarten-party', ctx(['Kindergarten autumn party']))).toBe(true);
    expect(scopeMatches('kindergarten-party', ctx(['幼儿园秋季水果派对']))).toBe(true);
    expect(scopeMatches('kindergarten-party', ctx(['Kindergarten pickup']))).toBe(false);
    expect(scopeMatches('kindergarten-party', ctx(['Sunday family dinner']))).toBe(false);
    // The group passes what it knows (T7.4): a party read from the kindergarten group.
    expect(scopeMatches('kindergarten-party', ctx(['秋季水果派对'], ['kindergarten']))).toBe(true);
    expect(scopeMatches('chess club', ctx(['Chess club tournament']))).toBe(true);
  });

  it('the cake applies to Noa’s kindergarten party only', () => {
    const { state, item } = party(fresh());
    expect(preferencesForItem(state, item).map(p => p.id)).toEqual(['pref-noa-peanuts', 'pref-noa-cake']);
    const byId = (id: string) => state.items.find(i => i.id === id)!;
    // Noa's swimming and pickup: her allergy, not the cake.
    expect(preferencesForItem(state, byId('swim-today')).map(p => p.id)).toEqual(['pref-noa-peanuts']);
    expect(preferencesForItem(state, byId('pickup-today')).map(p => p.id)).toEqual(['pref-noa-peanuts']);
    // The family dinner includes Noa, so the allergy; it is not a kindergarten party.
    expect(preferencesForItem(state, byId('family-dinner')).map(p => p.id)).toEqual(['pref-noa-peanuts']);
    // Maya's piano: nothing about Noa.
    expect(preferencesForItem(state, byId('piano-tomorrow'))).toEqual([]);
  });

  it('not to Maya’s kindergarten-sounding party, but to a party for nobody in particular (read from a group)', () => {
    const maya = party(fresh(), { forMemberIds: ['maya'] });
    expect(preferencesForItem(maya.state, maya.item)).toEqual([]);
    const nobody = party(fresh(), { forMemberIds: [] });
    expect(preferencesForItem(nobody.state, nobody.item).map(p => p.id)).toEqual(['pref-noa-cake']);
  });

  it('a preparation takes its event’s words and people', () => {
    const { state, item } = party(fresh());
    const prep = create(state, { type: 'preparation', title: 'Buy flour', parentEventId: item.id, forMemberIds: [] });
    expect(itemContext(prep.state.items, members, prep.item).memberIds).toEqual(['noa']);
    expect(preferencesForItem(prep.state, prep.item).map(p => p.id)).toEqual(['pref-noa-peanuts', 'pref-noa-cake']);
  });

  it('lists hard ones first, then scoped before general', () => {
    const prefs: Preference[] = [
      { id: 'a', text: 'Likes red', strength: 'soft' },
      { id: 'b', text: 'Cake at parties', strength: 'soft', scope: 'party' },
      { id: 'c', text: 'No pork', strength: 'hard' }
    ];
    expect(applicablePreferences(prefs, { memberIds: [], texts: ['Birthday party'] }).map(p => p.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('the hard block: hard preferences are never overridden', () => {
  it('reads what a hard preference rules out, in English and Chinese', () => {
    const hard = (text: string, textZh?: string): Preference => ({ id: 'x', text, ...(textZh ? { textZh } : {}), strength: 'hard' });
    expect(avoidedTerms(hard('No peanuts', '不吃花生'))).toEqual(['peanut']);
    expect(avoidedTerms(hard('Noa is allergic to kiwi and strawberries'))).toEqual(['kiwi', 'strawberries']);
    expect(avoidedTerms(hard('Maya has a nut allergy'))).toEqual(['nut']);
    expect(avoidedTerms(hard('We keep it pork-free'))).toEqual(['pork']);
    expect(avoidedTerms(hard('对猕猴桃过敏'))).toContain('kiwi');
    expect(avoidedTerms({ id: 'y', text: 'No peanuts', strength: 'soft' })).toEqual([]);
  });

  it('blocks a choice that names a ruled-out thing, in either language, where the preference applies', () => {
    const prefs = fresh().preferences;
    const noa = { memberIds: ['noa'], texts: ['Kindergarten autumn party'] };
    expect(checkChoice(prefs, noa, ['Peanut butter cookies']).map(b => [b.preference.id, b.term])).toEqual([['pref-noa-peanuts', 'peanut']]);
    expect(checkChoice(prefs, noa, ['花生饼干'])).toHaveLength(1);
    expect(checkChoice(prefs, noa, ['Chocolate cake'])).toEqual([]);
    // Not for Maya: Noa's allergy does not apply.
    expect(checkChoice(prefs, { memberIds: ['maya'], texts: ['Piano lesson'] }, ['Peanut snacks'])).toEqual([]);
  });

  it('refuses a preparation for the family dinner (Noa is there), a retitle, and an approval; not an event or Maya’s things', () => {
    const state = fresh();
    expect(blockedChange(state, { kind: 'create', item: { type: 'preparation', title: 'Bring peanut cookies', parentEventId: 'family-dinner', forMemberIds: [] } })).toHaveLength(1);
    expect(blockedChange(state, { kind: 'create', item: { type: 'preparation', title: 'Bring a fruit salad', parentEventId: 'family-dinner', forMemberIds: [] } })).toEqual([]);
    expect(blockedChange(state, { kind: 'create', item: { type: 'task', title: 'Buy peanuts for Maya', forMemberIds: ['maya'] } })).toEqual([]);
    expect(blockedChange(state, { kind: 'create', item: { type: 'event', title: 'Peanut festival', forMemberIds: ['noa'] } })).toEqual([]);
    const flowers = state.items.find(i => i.id === 'family-dinner-flowers')!;
    expect(blockedChange(state, { kind: 'edit', itemId: flowers.id, version: flowers.version, patch: { title: 'Buy peanut brittle' } })).toHaveLength(1);
    expect(blockedChange(state, { kind: 'edit', itemId: flowers.id, version: flowers.version, patch: { notes: 'peanut' } })).toEqual([]);

    // A proposed preparation (read from a screenshot) can't be approved past the allergy.
    const proposed = create(state, { type: 'preparation', title: '带花生糖', parentEventId: 'family-dinner', forMemberIds: [], proposed: true });
    expect(blockedChange(proposed.state, { kind: 'approve', itemId: proposed.item.id, version: proposed.item.version })).toHaveLength(1);
  });

  it('a preparation under an event for nobody in particular counts the whole family', () => {
    const { state, item } = party(fresh(), { forMemberIds: [] });
    expect(blockedChange(state, { kind: 'create', item: { type: 'preparation', title: 'Peanut snacks', parentEventId: item.id, forMemberIds: [] } })).toHaveLength(1);
  });
});

describe('chat: add_preference and the block', () => {
  const withAutonomy = (state: HomemindState, level: 1 | 2 | 3 | 4, paused = false): HomemindState => ({ ...state, family: { ...state.family, autonomy: { default: level }, paused } });
  const intent = { intent: 'add_preference' as const, text: 'Pack a towel', reason: 'Maya forgets it', aboutMemberId: 'maya', strength: 'soft' as const, scope: 'swimming' };

  it('saves at level 2 and up; at level 1 or paused it offers a Save button', () => {
    expect(planChat(view(fresh(), 'mom'), intent)).toEqual({ kind: 'preference', input: { text: 'Pack a towel', reason: 'Maya forgets it', aboutMemberId: 'maya', strength: 'soft', scope: 'swimming' }, save: true });
    expect(planChat(view(withAutonomy(fresh(), 1), 'mom'), intent)).toMatchObject({ kind: 'preference', save: false, reason: 'level1' });
    expect(planChat(view(withAutonomy(fresh(), 3, true), 'mom'), intent)).toMatchObject({ kind: 'preference', save: false, reason: 'paused' });
  });

  it('a preparation or task that a hard preference rules out is blocked, and nothing is written', () => {
    const plan = planChat(view(fresh(), 'dad'), { intent: 'add_preparation', eventId: 'family-dinner', title: 'Peanut cookies' });
    expect(plan).toMatchObject({ kind: 'blocked', intent: 'add_preparation', title: 'Peanut cookies' });
    expect(plan.kind === 'blocked' && plan.blocked[0].preference.id).toBe('pref-noa-peanuts');
    expect(planChat(view(fresh(), 'dad'), { intent: 'create_task', title: 'Buy peanut snacks for Noa', forMemberIds: ['noa'] })).toMatchObject({ kind: 'blocked' });
    expect(planChat(view(fresh(), 'dad'), { intent: 'add_preparation', eventId: 'family-dinner', title: 'Bake a cake' })).toMatchObject({ kind: 'write' });
  });

  it('cards: the saved preference with Undo, the Save suggestion, the block, in both languages', () => {
    const state = fresh();
    const v = view(state, 'mom');
    const cake = state.preferences[0];
    const outcomes: ChatOutcome[] = [
      { kind: 'preference', action: 'added', preference: cake, activityId: 'act-1' },
      { kind: 'preference', action: 'unchanged', preference: cake },
      { kind: 'preference-suggest', input: { text: 'Pack a towel', aboutMemberId: 'maya', strength: 'soft' }, reason: 'level1' },
      { kind: 'blocked', title: 'Peanut cookies', blocked: [{ preference: state.preferences[1], term: 'peanut' }] }
    ];
    for (const lang of ['en', 'zh'] as const) {
      for (const outcome of outcomes) {
        const t = chatTurn({ lang, now: new Date(NOW).toISOString(), view: v, llm: 'fake', turnId: 't1', outcome });
        const surface = A2uiSurfaceStore.fromJsonl(t.jsonl).list()[0];
        expect(surface, `${lang} ${outcome.kind}`).toBeTruthy();
        expect(t.message).toBeTruthy();
      }
    }
    const saved = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view: v, llm: 'live', turnId: 't2', outcome: outcomes[0] });
    expect(saved.jsonl).toContain('Noa enjoys baking it with us the most');
    expect(saved.jsonl).toContain('kindergarten-party');
    expect(saved.jsonl).toContain('"verb":"undo-preference"');
    const zh = chatTurn({ lang: 'zh', now: new Date(NOW).toISOString(), view: v, llm: 'live', turnId: 't3', outcome: outcomes[3] });
    expect(zh.message).toContain('没有添加');
    expect(zh.jsonl).toContain('不吃花生');
    const save = chatTurn({ lang: 'en', now: new Date(NOW).toISOString(), view: v, llm: 'live', turnId: 't4', outcome: outcomes[2] });
    expect(save.jsonl).toContain('"verb":"save-preference"');
    expect(save.message).toContain('nothing was saved');
  });
});
