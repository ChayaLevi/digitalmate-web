/**
 * Preferences (T5.4): saving and correcting them, where they apply, and the hard block.
 *
 * - `parsePreferenceBody` checks a `POST /preferences` body: save (new, or a correction by `id`),
 *   remove, or undo. Unknown fields and bad values are refused, never ignored.
 * - `applyPreferenceRequest` applies one as a member. Every change writes one `preference` activity
 *   with the earlier version in `prefUndo`, so it can be undone. Anyone with an account may add a
 *   preference; only a parent may correct or remove a **hard** one, or make a soft one hard and back.
 * - `appliesTo` / `preferencesForItem`: a preference about a member applies to items for that member;
 *   a scoped one (`kindergarten-party`) only where the scope matches the item's words (both languages).
 *   So the cake applies to Noa's kindergarten party, not to her swimming or the family dinner.
 * - `checkChoice` / `blockedChange`: a hard preference (allergy, dietary law) is never overridden. A
 *   preparation or task whose title names something a hard preference rules out is refused.
 *
 * Pure: no I/O, no clock reads ("now" is passed in), no imports from src/.
 */
import type { Change, NewItem } from './core';
import type { Activity, HomemindState, Item, Member, Preference } from './types';
import { ID_PATTERN } from './types';

export const PREFERENCE_LIMITS = { text: 500, reason: 500, scope: 60, count: 200 } as const;
/** A scope is a short name: letters, digits, spaces, `-` and `_`. */
export const SCOPE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/;

// --- request ---------------------------------------------------------------------------------------

export interface PreferenceInput {
  text: string;
  reason?: string;
  aboutMemberId?: string;
  strength: 'hard' | 'soft';
  scope?: string;
}

export type PreferenceRequest =
  | { op: 'save'; id?: string; input: PreferenceInput }
  | { op: 'remove'; id: string }
  | { op: 'undo'; activityId: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null || v === '';

function cleanText(value: unknown, what: string, max: number, required: boolean): Parsed<string | undefined> {
  if (absent(value)) return required ? { ok: false, message: `${what} is required` } : { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, message: `${what} must be text` };
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return required ? { ok: false, message: `${what} is required` } : { ok: true, value: undefined };
  if (text.length > max) return { ok: false, message: `${what} is longer than ${max} characters` };
  if (CONTROL.test(text)) return { ok: false, message: `${what} has control characters` };
  return { ok: true, value: text };
}

/** Checks the fields of a preference (from a request body or a validated model intent). */
export function parsePreferenceInput(raw: Record<string, unknown>, members: readonly Member[]): Parsed<PreferenceInput> {
  const text = cleanText(raw.text, 'text', PREFERENCE_LIMITS.text, true);
  if (!text.ok) return text;
  const reason = cleanText(raw.reason, 'reason', PREFERENCE_LIMITS.reason, false);
  if (!reason.ok) return reason;
  if (raw.strength !== 'hard' && raw.strength !== 'soft') return { ok: false, message: 'strength must be hard or soft' };
  let aboutMemberId: string | undefined;
  if (!absent(raw.aboutMemberId)) {
    if (typeof raw.aboutMemberId !== 'string' || !members.some(m => m.id === raw.aboutMemberId)) return { ok: false, message: 'aboutMemberId is not a family member' };
    aboutMemberId = raw.aboutMemberId;
  }
  const scope = cleanText(raw.scope, 'scope', PREFERENCE_LIMITS.scope, false);
  if (!scope.ok) return scope;
  if (scope.value && !SCOPE_PATTERN.test(scope.value)) return { ok: false, message: 'scope is not a short name' };
  return {
    ok: true,
    value: {
      text: text.value as string,
      ...(reason.value ? { reason: reason.value } : {}),
      ...(aboutMemberId ? { aboutMemberId } : {}),
      strength: raw.strength,
      ...(scope.value ? { scope: scope.value.toLowerCase() } : {})
    }
  };
}

const FIELDS = ['text', 'reason', 'aboutMemberId', 'strength', 'scope'];

/** `{text, reason?, aboutMemberId?, strength, scope?, id?}`, `{id, remove: true}` or `{undo: activityId}`. */
export function parsePreferenceBody(body: unknown, members: readonly Member[]): Parsed<PreferenceRequest> {
  if (!isObject(body)) return { ok: false, message: 'preference must be an object' };
  const keys = Object.keys(body);
  const idOk = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
  if ('undo' in body) {
    if (keys.length !== 1) return { ok: false, message: 'undo takes no other field' };
    return idOk(body.undo) ? { ok: true, value: { op: 'undo', activityId: body.undo } } : { ok: false, message: 'undo must be an activity id' };
  }
  if ('remove' in body) {
    if (body.remove !== true || keys.some(k => k !== 'remove' && k !== 'id')) return { ok: false, message: 'remove takes only {id, remove: true}' };
    return idOk(body.id) ? { ok: true, value: { op: 'remove', id: body.id } } : { ok: false, message: 'id must be a preference id' };
  }
  const extra = keys.find(k => k !== 'id' && !FIELDS.includes(k));
  if (extra) return { ok: false, message: `Unknown preference field: ${extra.slice(0, 40)}` };
  if ('id' in body && !idOk(body.id)) return { ok: false, message: 'id must be a preference id' };
  const input = parsePreferenceInput(body, members);
  if (!input.ok) return input;
  return { ok: true, value: { op: 'save', ...(typeof body.id === 'string' ? { id: body.id } : {}), input: input.value } };
}

// --- apply -----------------------------------------------------------------------------------------

export type PreferenceAction = 'added' | 'corrected' | 'removed' | 'undone';

export type PreferenceResult =
  | { ok: true; state: HomemindState; action: PreferenceAction; preference: Preference | null; activity?: Activity; changed: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409; code: 'invalid' | 'forbidden' | 'not_found' | 'conflict'; message: string };

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

function newId(taken: (id: string) => boolean, prefix: string, now: number): string {
  const base = `${prefix}-${Math.max(0, Math.floor(now)).toString(36)}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

function samePreference(a: Preference, b: Preference): boolean {
  return a.text === b.text && a.reason === b.reason && a.aboutMemberId === b.aboutMemberId && a.strength === b.strength && a.scope === b.scope;
}

function withActivity(state: HomemindState, actorId: string, now: number, action: PreferenceAction, preferenceId: string, before: Preference | null, preferences: Preference[], extra: Partial<Activity> = {}): { state: HomemindState; activity: Activity } {
  const activity: Activity = {
    id: newId(id => state.activity.some(a => a.id === id), 'act', now),
    at: new Date(now).toISOString(),
    actor: actorId,
    what: `${action} a preference`,
    kind: 'preference',
    ref: preferenceId,
    note: action,
    prefUndo: { preferenceId, before },
    ...extra
  };
  return { activity, state: { ...state, preferences, activity: [...state.activity, activity] } };
}

/**
 * Applies a checked request as `actorId`. A save with no `id` that matches a saved preference (same
 * person, same words, same scope) corrects that one rather than adding a twin. A correction drops the
 * seeded Chinese text or reason when the English one changed (they belong to the seeded words only).
 */
export function applyPreferenceRequest(state: HomemindState, request: PreferenceRequest, actorId: string, now: number): PreferenceResult {
  const actor = state.family.members.find(m => m.id === actorId);
  if (!actor || !actor.hasAccount) return { ok: false, status: 404, code: 'not_found', message: 'No such member' };
  const isParent = actor.role === 'parent';
  const hardOnly = { ok: false as const, status: 403 as const, code: 'forbidden' as const, message: 'Only a parent can change or remove a hard preference' };

  if (request.op === 'undo') return undoPreference(state, request.activityId, actor, now);

  if (request.op === 'remove') {
    const old = state.preferences.find(p => p.id === request.id);
    if (!old) return { ok: false, status: 404, code: 'not_found', message: 'No such preference' };
    if (old.strength === 'hard' && !isParent) return hardOnly;
    const next = withActivity(state, actor.id, now, 'removed', old.id, old, state.preferences.filter(p => p.id !== old.id));
    return { ok: true, ...next, action: 'removed', preference: null, changed: true };
  }

  const input = request.input;
  if (input.aboutMemberId && !state.family.members.some(m => m.id === input.aboutMemberId)) return { ok: false, status: 400, code: 'invalid', message: 'aboutMemberId is not a family member' };
  const old = request.id
    ? state.preferences.find(p => p.id === request.id)
    : state.preferences.find(p => (p.aboutMemberId ?? '') === (input.aboutMemberId ?? '') && (p.scope ?? '') === (input.scope ?? '') && (norm(p.text) === norm(input.text) || (!!p.textZh && norm(p.textZh) === norm(input.text))));
  if (request.id && !old) return { ok: false, status: 404, code: 'not_found', message: 'No such preference' };

  if (!old) {
    if (state.preferences.length >= PREFERENCE_LIMITS.count) return { ok: false, status: 409, code: 'conflict', message: 'Too many preferences saved' };
    const preference: Preference = {
      id: newId(id => state.preferences.some(p => p.id === id), 'pref', now),
      ...input,
      createdBy: actor.id,
      updatedAt: new Date(now).toISOString()
    };
    const next = withActivity(state, actor.id, now, 'added', preference.id, null, [...state.preferences, preference]);
    return { ok: true, ...next, action: 'added', preference, changed: true };
  }

  if ((old.strength === 'hard' || input.strength === 'hard') && old.strength !== input.strength && !isParent) return hardOnly;
  const merged: Preference = {
    id: old.id,
    aboutMemberId: input.aboutMemberId,
    text: input.text,
    ...(old.textZh && (norm(old.text) === norm(input.text) || norm(old.textZh) === norm(input.text)) ? { textZh: old.textZh } : {}),
    reason: input.reason ?? (request.id ? undefined : old.reason),
    strength: input.strength,
    scope: input.scope,
    ...(old.createdBy ? { createdBy: old.createdBy } : {}),
    updatedAt: new Date(now).toISOString()
  };
  // Saving the seeded Chinese words keeps the English ones.
  if (old.textZh && norm(old.textZh) === norm(input.text)) merged.text = old.text;
  if (old.reasonZh && merged.reason === old.reason) merged.reasonZh = old.reasonZh;
  for (const key of Object.keys(merged) as Array<keyof Preference>) if (merged[key] === undefined) delete merged[key];
  if (old.strength === 'hard' && !isParent && !samePreference(old, merged)) return hardOnly;
  if (samePreference(old, merged)) return { ok: true, state, action: 'corrected', preference: old, changed: false };
  const next = withActivity(state, actor.id, now, 'corrected', old.id, old, state.preferences.map(p => (p.id === old.id ? merged : p)));
  return { ok: true, ...next, action: 'corrected', preference: merged, changed: true };
}

/** Puts a preference back as it was before one change. The member who made it, or a parent, may. */
function undoPreference(state: HomemindState, activityId: string, actor: Member, now: number): PreferenceResult {
  const target = state.activity.find(a => a.id === activityId);
  if (!target || target.kind !== 'preference' || !target.prefUndo) return { ok: false, status: 404, code: 'not_found', message: 'Nothing to undo' };
  if (target.undone) return { ok: false, status: 409, code: 'conflict', message: 'Already undone' };
  if (target.actor !== actor.id && actor.role !== 'parent') return { ok: false, status: 403, code: 'forbidden', message: 'Only the member who made this change, or a parent, can undo it' };
  // Undo only the latest change to that preference, so an older Undo can't wipe a newer correction.
  const later = state.activity.slice(state.activity.indexOf(target) + 1).some(a => a.kind === 'preference' && a.ref === target.ref && !a.undone);
  if (later) return { ok: false, status: 409, code: 'conflict', message: 'This preference changed again since. Undo the latest change first' };
  const { preferenceId, before } = target.prefUndo;
  const current = state.preferences.find(p => p.id === preferenceId) ?? null;
  const preferences = before
    ? current
      ? state.preferences.map(p => (p.id === preferenceId ? before : p))
      : [...state.preferences, before]
    : state.preferences.filter(p => p.id !== preferenceId);
  const id = newId(x => state.activity.some(a => a.id === x), 'act', now);
  const marked = { ...state, activity: state.activity.map(a => (a.id === target.id ? { ...a, undone: { at: new Date(now).toISOString(), by: actor.id, activityId: id } } : a)) };
  const next = withActivity(marked, actor.id, now, 'undone', preferenceId, current, preferences, { id });
  return { ok: true, ...next, action: 'undone', preference: before, changed: true };
}

// --- where a preference applies ------------------------------------------------------------------

/** Words for the scope names people and the model use. A scope needs every concept it names. */
const SCOPE_CONCEPTS: Record<string, string[]> = {
  kindergarten: ['kindergarten', 'preschool', 'pre-school', 'nursery', 'daycare', '幼儿园', '幼稚园', '托儿所'],
  school: ['school', '学校'],
  party: ['party', 'parties', 'celebration', 'picnic', '派对', '聚会', '联欢', '庆祝', '野餐'],
  birthday: ['birthday', '生日'],
  dinner: ['dinner', 'supper', '晚饭', '晚餐', '聚餐'],
  lunch: ['lunch', 'lunchbox', '午饭', '午餐', '便当'],
  breakfast: ['breakfast', '早饭', '早餐'],
  snack: ['snack', 'snacks', '零食', '点心'],
  trip: ['trip', 'outing', 'excursion', '郊游', '出游', '旅行', '春游', '秋游'],
  sport: ['sport', 'sports', 'swim', 'swimming', 'football', 'soccer', 'basketball', '运动', '体育', '游泳', '足球', '篮球'],
  music: ['music', 'piano', 'violin', '音乐', '钢琴', '小提琴'],
  weekend: ['weekend', '周末']
};
const SCOPE_STOP = new Set(['and', 'or', 'the', 'for', 'with', 'all', 'any', 'events', 'event', 'time', 'times', 'day', 'days']);

const ascii = (w: string) => /^[a-z0-9-]+$/.test(w);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An English word matches at a word start (`peanut` matches `peanuts`); Chinese words anywhere. */
function hasWord(haystack: string, word: string): boolean {
  return ascii(word) ? new RegExp(`(^|[^a-z0-9])${escape(word)}`).test(haystack) : haystack.includes(word);
}

/** What a scope needs: concepts (any of their words) and leftover literal words. */
export function scopeTerms(scope: string): { concepts: string[]; literals: string[] } {
  let rest = scope.toLowerCase();
  const concepts: string[] = [];
  for (const [concept, words] of Object.entries(SCOPE_CONCEPTS)) {
    const hit = [concept, ...words].sort((a, b) => b.length - a.length).find(w => hasWord(rest, w));
    if (hit) {
      concepts.push(concept);
      for (const w of [concept, ...words]) rest = rest.split(w).join(' ');
    }
  }
  const literals = rest.split(/[\s_-]+/).map(w => w.trim()).filter(w => w && !SCOPE_STOP.has(w) && (ascii(w) ? w.length >= 3 : w.length >= 2));
  return { concepts, literals };
}

export interface PreferenceContext {
  /** Who the thing is for. Empty: nobody in particular. */
  memberIds: string[];
  /** Words that describe it: titles in both languages, notes, the parent event, the source. */
  texts: string[];
  /** Extra words a caller knows (T7.4: the kindergarten group passes `kindergarten`). */
  tags?: string[];
}

export function scopeMatches(scope: string, context: PreferenceContext): boolean {
  const haystack = [...context.texts, ...(context.tags ?? [])].join(' \n ').toLowerCase();
  const { concepts, literals } = scopeTerms(scope);
  if (concepts.length === 0 && literals.length === 0) return false;
  return concepts.every(c => [c, ...SCOPE_CONCEPTS[c]].some(w => hasWord(haystack, w))) && literals.every(w => hasWord(haystack, w));
}

/**
 * Whether a preference applies. About someone: things for that member; a scoped one also things for
 * nobody in particular (a party read from a group message) when the scope matches. A scope must match.
 */
export function appliesTo(preference: Preference, context: PreferenceContext): boolean {
  const about = preference.aboutMemberId;
  const memberOk = !about || context.memberIds.includes(about) || (context.memberIds.length === 0 && !!preference.scope);
  return memberOk && (!preference.scope || scopeMatches(preference.scope, context));
}

/** Applicable preferences, hard first, then scoped (more specific) before general. */
export function applicablePreferences(preferences: readonly Preference[], context: PreferenceContext): Preference[] {
  const rank = (p: Preference) => (p.strength === 'hard' ? 0 : 2) + (p.scope ? 0 : 1);
  return preferences.filter(p => appliesTo(p, context)).sort((a, b) => rank(a) - rank(b));
}

/**
 * The context of an item: its own words and its parent event's, and who it is for. A preparation for
 * nobody in particular is for whoever its event is for; when that is nobody either, the whole family
 * (food for an event reaches everyone, so every hard preference counts).
 */
export function itemContext(items: readonly Item[], members: readonly Member[], item: Pick<Item, 'type' | 'title' | 'forMemberIds'> & Partial<Pick<Item, 'titleZh' | 'notes' | 'parentEventId' | 'source'>>): PreferenceContext {
  const parent = item.parentEventId ? items.find(i => i.id === item.parentEventId) : undefined;
  let memberIds = item.forMemberIds;
  if (memberIds.length === 0 && item.type === 'preparation') memberIds = parent?.forMemberIds.length ? parent.forMemberIds : members.map(m => m.id);
  const texts = [item.title, item.titleZh, item.notes, parent?.title, parent?.titleZh, parent?.notes, item.source?.label].filter((t): t is string => !!t);
  return { memberIds: [...memberIds], texts };
}

export function preferencesForItem(state: Pick<HomemindState, 'items' | 'preferences' | 'family'>, item: Item): Preference[] {
  return applicablePreferences(state.preferences, itemContext(state.items, state.family.members, item));
}

// --- the hard block --------------------------------------------------------------------------------

/** Things hard preferences rule out, with their words in both languages. */
const AVOID_CONCEPTS: Record<string, string[]> = {
  peanut: ['peanut', 'peanuts', 'groundnut', '花生'],
  nut: ['nut', 'nuts', 'tree nut', 'walnut', 'almond', 'cashew', 'hazelnut', 'pistachio', 'pecan', '坚果', '核桃', '杏仁', '腰果', '榛子', '开心果'],
  kiwi: ['kiwi', 'kiwis', 'kiwifruit', '猕猴桃', '奇异果'],
  egg: ['egg', 'eggs', '鸡蛋'],
  dairy: ['dairy', 'milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', '牛奶', '奶酪', '乳制品', '黄油', '奶油', '酸奶'],
  pork: ['pork', 'ham', 'bacon', 'sausage', '猪肉', '火腿', '培根', '香肠'],
  gluten: ['gluten', 'wheat', '小麦', '面筋', '麸质'],
  shellfish: ['shellfish', 'shrimp', 'prawn', 'crab', 'lobster', '虾', '蟹', '龙虾', '贝类'],
  fish: ['fish', '鱼'],
  sesame: ['sesame', '芝麻'],
  soy: ['soy', 'soya', 'tofu', '大豆', '豆腐'],
  meat: ['meat', 'beef', 'chicken', 'lamb', '肉', '牛肉', '鸡肉', '羊肉']
};
const AVOID_EN = [
  /\b(?:no|not|never|avoid|avoids|without|free of|don'?t eat|doesn'?t eat|can'?t eat|cannot eat|can'?t have|cannot have|allergic to|allergy to|intolerant to)\s+(?:any\s+)?(.+)$/i,
  /\b([a-z]+)[- ](?:free|allergy|allergies|intolerance)\b/i
];
const AVOID_ZH = [/(?:不吃|不能吃|不可以吃|不要|不能有|禁止|忌口|忌|避免|不含|别带)(.+)$/, /对(.+?)过敏/, /^(.+?)过敏/];

/** The things a hard preference rules out: concept names or literal words. */
export function avoidedTerms(preference: Preference): string[] {
  if (preference.strength !== 'hard') return [];
  const found = new Set<string>();
  for (const text of [preference.text, preference.textZh].filter((t): t is string => !!t)) {
    const objects: string[] = [];
    for (const re of AVOID_EN) {
      const m = re.exec(text);
      if (m) objects.push(...m[1].split(/,|\/|\band\b|\bor\b|、|和|或/i));
    }
    for (const re of AVOID_ZH) {
      const m = re.exec(text);
      if (m) objects.push(...m[1].split(/[,，、和或/]/));
    }
    for (const raw of objects) {
      const term = raw.toLowerCase().replace(/[.!。！]+$/, '').replace(/\b(at all|please|food|foods|products?)\b/g, '').replace(/(食品|食物|制品|类)$/, '').trim();
      if (!term) continue;
      const concept = Object.entries(AVOID_CONCEPTS).find(([, words]) => words.includes(term));
      if (concept) found.add(concept[0]);
      else if (ascii(term.replace(/ /g, '')) ? term.length >= 3 : term.length >= 1) found.add(term);
    }
  }
  return [...found];
}

function termWords(term: string): string[] {
  return AVOID_CONCEPTS[term] ?? [term];
}

export interface BlockedChoice {
  preference: Preference;
  /** The word in the choice that the preference rules out. */
  term: string;
}

/** Hard preferences that rule out a choice (its words in either language), where they apply. */
export function checkChoice(preferences: readonly Preference[], context: PreferenceContext, choice: readonly string[]): BlockedChoice[] {
  const haystack = choice.filter(Boolean).join(' \n ').toLowerCase();
  const blocked: BlockedChoice[] = [];
  for (const preference of preferences) {
    if (preference.strength !== 'hard' || !appliesTo(preference, context)) continue;
    for (const term of avoidedTerms(preference)) {
      const word = termWords(term).find(w => hasWord(haystack, w));
      if (word) {
        blocked.push({ preference, term: word });
        break;
      }
    }
  }
  return blocked;
}

/**
 * Whether a board change would add something a hard preference rules out: a preparation or task
 * created, retitled, or approved (with an event's proposed preparations). Events are not choices.
 */
export function blockedChange(state: Pick<HomemindState, 'items' | 'preferences' | 'family'>, change: Change): BlockedChoice[] {
  const check = (item: Pick<Item, 'type' | 'title' | 'forMemberIds'> & Partial<Item>) =>
    item.type === 'event' ? [] : checkChoice(state.preferences, itemContext(state.items, state.family.members, item), [item.title, item.titleZh ?? '']);
  if (change.kind === 'create') {
    const item: NewItem = change.item;
    return check({ ...item, forMemberIds: item.forMemberIds ?? [] });
  }
  if (change.kind === 'edit') {
    const current = state.items.find(i => i.id === change.itemId);
    if (!current || (change.patch.title === undefined && change.patch.forMemberIds === undefined)) return [];
    return check({ ...current, ...(change.patch.title !== undefined ? { title: change.patch.title, titleZh: undefined } : {}), ...(change.patch.forMemberIds ? { forMemberIds: change.patch.forMemberIds } : {}) });
  }
  if (change.kind === 'approve') {
    const current = state.items.find(i => i.id === change.itemId);
    if (!current) return [];
    const preps = current.type === 'event' ? state.items.filter(i => i.parentEventId === current.id && i.status === 'proposed') : [];
    return [current, ...preps].flatMap(check);
  }
  return [];
}
