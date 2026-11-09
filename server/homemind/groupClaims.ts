/**
 * Sign-up claims in a simulated group (T7.4, Scene 2).
 *
 * A parent group posts a 接龙 sign-up ("who brings what to the party"). When the family allows it for
 * that group, Homemind claims one item on the family's behalf, puts the party and its preparations on
 * the board, and tells the family. A parent can tap "Change" to switch to another item, which posts a
 * correction in the group.
 *
 * Limits, all enforced here:
 *   - **Per group, off by default.** A parent turns it on; that is the first-time approval of exactly
 *     these limits, and claims are posted as that parent. Turning it off withdraws a waiting claim card.
 *   - **Food and low cost only.** Only foods Homemind knows (`SIGNUP_FOODS`), at most the cap. On its own
 *     Homemind claims only something to **buy**: an item someone has to bake or cook commits a person's
 *     time, so it is offered under "Change" for a parent to pick. A hard preference (an allergy) rules an
 *     item out everywhere; a soft one ranks it first and is shown with its reason.
 *   - **Stops on unclear messages.** The sign-up is read by fixed rules, not the model: a 接龙 marker, the
 *     list of choices, numbered entries that name a choice, and a day and time for the event (from the
 *     list or the teacher's message before it). Anything else: no claim, and the screen says what was
 *     unclear. Also no claim after the sign-up closes, or when the family is already on the list.
 *   - **Every post goes through the action guard** (actions.ts, adapter `group-reply`). At autonomy level 4
 *     for the `group` area the claim posts on its own (the adapter is simulated and allows it); below 4
 *     the card waits for a parent's tap. A paused family gets no automatic claim.
 *
 * Pure apart from what `prepareCard` hashes: the bridge runs the card and then calls `afterGroupCard`.
 * Board items go through `applyChange`, so they have versions, activity and Undo like any other change.
 */
import type { AdapterRegistry } from './actions';
import { autonomyLevelFor, prepareCard, withdrawCard } from './actions';
import type { AlertDelivery } from './alerts';
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import type { Clock } from './clock';
import { applyChange } from './core';
import type { Change, CoreEvent, NewItem } from './core';
import { ADAPTER_IDS, KINDERGARTEN_GROUP, groupAuthorFor, servicesOf } from './fakes';
import { applicablePreferences, checkChoice } from './preferences';
import type { BlockedChoice, PreferenceContext } from './preferences';
import type { ActionCard, GroupClaim, GroupClaimChange, GroupClaimPolicy, GroupMessage, GroupsView, HomemindAlert, HomemindState, Item, Member, Preference, SignUpChoiceView, SignUpOption, SourceRef, Why } from './types';
import { ID_PATTERN } from './types';
import { canSeeItem } from './visibility';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_CLAIMS = 50;
/** The autonomy area of group posts (the `group-reply` adapter's area). */
export const GROUP_AREA = 'group';
export const GROUP_POLICY_DEFAULTS = { maxCost: 50, currency: 'CNY' } as const;
/** The groups Homemind knows. The demo has one, simulated. */
const GROUPS = [KINDERGARTEN_GROUP] as const;
const SOURCE_LABEL = `${KINDERGARTEN_GROUP.name} (simulated group)`;

// --- foods Homemind can claim ---------------------------------------------------------------------------

export interface SignUpFood {
  key: string;
  en: string;
  zh: string;
  /** Words that name it in a sign-up list. */
  words: readonly string[];
  food: boolean;
  /** `make`: someone has to bake or cook it. */
  effort: 'buy' | 'make';
  /** A rough estimate for 8 to 10 children, CNY. */
  cost: number;
}

export const SIGNUP_FOODS: readonly SignUpFood[] = [
  { key: 'apples', en: 'apples', zh: '苹果', words: ['苹果'], food: true, effort: 'buy', cost: 25 },
  { key: 'oranges', en: 'oranges', zh: '橙子', words: ['橙子', '橘子', '桔子'], food: true, effort: 'buy', cost: 25 },
  { key: 'bananas', en: 'bananas', zh: '香蕉', words: ['香蕉'], food: true, effort: 'buy', cost: 15 },
  { key: 'grapes', en: 'grapes', zh: '葡萄', words: ['葡萄'], food: true, effort: 'buy', cost: 30 },
  { key: 'cookies', en: 'cookies', zh: '饼干', words: ['饼干'], food: true, effort: 'buy', cost: 20 },
  { key: 'juice', en: 'juice', zh: '果汁', words: ['果汁'], food: true, effort: 'buy', cost: 30 },
  { key: 'peanut-candy', en: 'peanut candy', zh: '花生糖', words: ['花生糖'], food: true, effort: 'buy', cost: 20 },
  { key: 'cake', en: 'cake', zh: '蛋糕', words: ['蛋糕'], food: true, effort: 'make', cost: 40 },
  { key: 'dumplings', en: 'dumplings', zh: '饺子', words: ['饺子'], food: true, effort: 'make', cost: 35 },
  { key: 'plates', en: 'paper plates', zh: '纸盘', words: ['纸盘', '纸杯', '餐具', '一次性餐具'], food: false, effort: 'buy', cost: 15 },
  { key: 'balloons', en: 'balloons', zh: '气球', words: ['气球'], food: false, effort: 'buy', cost: 20 }
];

/** The food a sign-up choice names: the exact word first, then the longest word it contains. */
export function foodFor(label: string): SignUpFood | undefined {
  const exact = SIGNUP_FOODS.find(f => f.words.includes(label));
  if (exact) return exact;
  let best: { food: SignUpFood; length: number } | undefined;
  for (const food of SIGNUP_FOODS) for (const word of food.words) if (label.includes(word) && (!best || word.length > best.length)) best = { food, length: word.length };
  return best?.food;
}

export const foodByKey = (key: string | undefined) => SIGNUP_FOODS.find(f => f.key === key);

// --- reading a sign-up (fixed rules, not the model) -------------------------------------------------------

const WEEKDAY_ZH: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const WEEKDAY_NAME_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_NAME_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** "本周四下午3点", "周三晚上8点前", "星期五 15:30". */
const WHEN = /(本周|这周|下周)?(?:周|星期|礼拜)([一二三四五六日天])\s*(上午|早上|中午|下午|晚上)?\s*(\d{1,2})\s*(?:点|:|：)\s*(半|[0-5]\d)?\s*(前|之前)?/g;
const DAY_ONLY = /(?:周|星期|礼拜)([一二三四五六日天])/;
const SIGNUP_MARK = /^\s*#\s*接龙/m;
const ENTRY = /^(\d{1,2})\s*[.、．:：)）]\s*(\S+)\s+(\S+)$/;

/** Whether a group message is a 接龙 sign-up at all (others are left alone). */
export const isSignUp = (message: Pick<GroupMessage, 'text' | 'from'>): boolean => message.from !== 'family' && SIGNUP_MARK.test(message.text);

interface WhenMatch {
  prefix: string;
  weekday: number;
  time: string;
  before: boolean;
}

function whenMatches(text: string): WhenMatch[] {
  const out: WhenMatch[] = [];
  for (const m of text.matchAll(WHEN)) {
    let hour = Number(m[4]);
    const period = m[3] ?? '';
    if (hour < 12 && (period === '下午' || period === '晚上' || (period === '中午' && hour < 11))) hour += 12;
    const minute = m[5] === '半' ? 30 : m[5] ? Number(m[5]) : 0;
    if (hour > 23 || minute > 59) continue;
    out.push({ prefix: m[1] ?? '', weekday: WEEKDAY_ZH[m[2]], time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, before: !!m[6] });
  }
  return out;
}

const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * The instant a weekday reference means, seen from `from` (when the message was posted): "下周X" is that
 * day of the next Monday-to-Sunday week; "本周X", "这周X" or a bare "周X" is the coming one (today counts
 * while the time is still ahead).
 */
export function resolveWeekday(prefix: string, weekday: number, time: string, from: number, timezone: string): number {
  const today = localParts(from, timezone);
  if (prefix === '下周') {
    const nextMonday = addDays(today.date, (1 - today.weekday + 7) % 7 || 7);
    return zonedToUtc(addDays(nextMonday, (weekday + 6) % 7), time, timezone);
  }
  for (let d = 0; d <= 7; d++) {
    const date = addDays(today.date, d);
    if (weekdayOf(date) !== weekday) continue;
    const at = zonedToUtc(date, time, timezone);
    if (at > from) return at;
  }
  const date = addDays(today.date, 7);
  return zonedToUtc(date, time, timezone);
}

/** The latest instant on `weekday` at `time` that is not after `limit` ("周三晚上8点前" before a Thursday party). */
function latestBefore(weekday: number, time: string, limit: number, timezone: string): number | undefined {
  const day = localParts(limit, timezone).date;
  for (let d = 0; d <= 7; d++) {
    const date = addDays(day, -d);
    if (weekdayOf(date) !== weekday) continue;
    const at = zonedToUtc(date, time, timezone);
    if (at <= limit) return at;
  }
  return undefined;
}

export type SignUpReading =
  | {
      ok: true;
      topic: string;
      options: SignUpOption[];
      entries: Array<{ n: number; who: string; label: string }>;
      eventStart: number;
      deadline?: number;
      /** The event's name as written ("秋季美食派对"), or a plain word when none is given. */
      eventName: string;
      children?: number;
      /** The text the event's time came from (the sign-up, or the teacher's message), for the board. */
      source: GroupMessage;
    }
  | { ok: false; problem: string; problemZh: string };

const unclear = (problem: string, problemZh: string): SignUpReading => ({ ok: false, problem, problemZh });

/**
 * Reads one 接龙 message, with the group's earlier messages for the event's time. Fixed rules only:
 * anything that does not fit is `unclear`, never guessed.
 */
export function readSignUp(messages: readonly GroupMessage[], message: GroupMessage, timezone: string): SignUpReading {
  const lines = message.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const markAt = lines.findIndex(l => /^#\s*接龙/.test(l));
  if (markAt < 0) return unclear('It is not marked as a sign-up (#接龙)', '没有接龙标记（#接龙）');
  const listAt = lines.findIndex((l, i) => i > markAt && /[（(][^）)]+[）)]/.test(l));
  if (listAt < 0) return unclear('It has no list of things to choose from', '没有列出可以认领的东西');
  const listLine = lines[listAt];
  const inside = /[（(]([^）)]+)[）)]/.exec(listLine)?.[1] ?? '';
  const labels = [...new Set(inside.split(/[、，,／/;；\s]+/).map(s => s.trim()).filter(Boolean))];
  if (labels.length < 2 || labels.length > 20) return unclear('The list of choices could not be read', '无法读懂可选清单');
  const topic = listLine.replace(/[（(][^）)]+[）)]/, '').trim();

  const entries: Array<{ n: number; who: string; label: string }> = [];
  for (const line of lines.slice(listAt + 1)) {
    if (!/^\d/.test(line)) continue;
    const m = ENTRY.exec(line);
    if (!m) return unclear(`The line “${line.slice(0, 30)}” could not be read`, `无法读懂这一行：“${line.slice(0, 30)}”`);
    const n = Number(m[1]);
    if (n !== entries.length + 1) return unclear('The numbers in the list are out of order', '清单的编号顺序不对');
    if (!labels.includes(m[3])) return unclear(`“${m[3]}” is not one of the choices`, `“${m[3]}”不在可选清单里`);
    entries.push({ n, who: m[2], label: m[3] });
  }

  // The event's day and time: from the sign-up itself, else the latest teacher message before it that has one.
  const index = messages.findIndex(m => m.id === message.id);
  const earlier = (index < 0 ? messages : messages.slice(0, index)).filter(m => m.from === 'teacher').reverse();
  let source: GroupMessage | undefined;
  let when: WhenMatch | undefined;
  for (const candidate of [message, ...earlier]) {
    when = whenMatches(candidate.text).find(w => !w.before);
    if (when) {
      source = candidate;
      break;
    }
  }
  if (!when || !source) return unclear('No day and time for the event was found', '没有找到活动的日期和时间');
  const listDay = DAY_ONLY.exec(topic);
  if (listDay && WEEKDAY_ZH[listDay[1]] !== when.weekday) {
    return unclear(`The list says ${WEEKDAY_NAME_EN[WEEKDAY_ZH[listDay[1]]]}, but the event is on ${WEEKDAY_NAME_EN[when.weekday]}`, `清单写的是${WEEKDAY_NAME_ZH[WEEKDAY_ZH[listDay[1]]]}，但活动是${WEEKDAY_NAME_ZH[when.weekday]}`);
  }
  const eventStart = resolveWeekday(when.prefix, when.weekday, when.time, Date.parse(source.at), timezone);
  const closes = [message, source].map(m => whenMatches(m.text).find(w => w.before)).find(Boolean);
  const deadline = closes ? latestBefore(closes.weekday, closes.time, eventStart, timezone) : undefined;

  const texts = [source.text, message.text];
  const named = texts.map(t => /举办([^，。！!,\s]{1,20}?(?:派对|聚会|活动))/.exec(t)?.[1]).find(Boolean) ?? /([^\s，。、]{0,10}?(?:派对|聚会))/.exec(topic)?.[1];
  const childCount = texts.map(t => /(\d{1,3})\s*(?:个|位|名)?\s*(?:小朋友|孩子)/.exec(t)?.[1]).find(Boolean);
  const takenBy = new Map<string, string>();
  for (const e of entries) if (!takenBy.has(e.label)) takenBy.set(e.label, e.who);
  return {
    ok: true,
    topic,
    options: labels.map(label => {
      const food = foodFor(label);
      return { label, ...(food ? { key: food.key } : {}), ...(takenBy.has(label) ? { takenBy: takenBy.get(label) } : {}) };
    }),
    entries,
    eventStart,
    ...(deadline !== undefined ? { deadline } : {}),
    eventName: named ?? '派对',
    ...(childCount ? { children: Number(childCount) } : {}),
    source
  };
}

/** The party's titles. The English one is built from words Homemind knows; the Chinese one is the group's own. */
export function eventTitles(name: string): { en: string; zh: string } {
  const words = [name.includes('秋') ? 'autumn' : '', name.includes('春') ? 'spring' : '', name.includes('美食') ? 'food' : ''].filter(Boolean);
  const kind = name.includes('聚会') ? 'get-together' : 'party';
  return { en: `Kindergarten ${[...words, kind].join(' ')}`, zh: name.startsWith('幼儿园') ? name : `幼儿园${name}` };
}

// --- policies --------------------------------------------------------------------------------------------

const policies = (state: HomemindState) => state.groupPolicies ?? [];
const claimsOf = (state: HomemindState) => state.groupClaims ?? [];
const groupInfo = (groupId: string) => GROUPS.find(g => g.id === groupId);

/** The group's policy, or the default: off. */
export function policyFor(state: HomemindState, groupId: string): GroupClaimPolicy {
  return policies(state).find(p => p.groupId === groupId) ?? { groupId, enabled: false, ...GROUP_POLICY_DEFAULTS };
}

/** Whether a claim may post without a tap now: autonomy level 4 for the `group` area, and not paused. The guard checks again. */
export const groupAutoAllowed = (state: HomemindState): boolean => !state.family.paused && autonomyLevelFor(state.family, GROUP_AREA) >= 4;

export interface GroupPolicyRequest {
  action: 'group-claims';
  groupId: string;
  enabled?: boolean;
  /** true: posts on its own (level 4 for the group area). false: a parent taps each claim (level 3). */
  auto?: boolean;
}

/** Checks a `POST /rules {action: 'group-claims'}` body by hand. */
export function parseGroupPolicyBody(body: Record<string, unknown>): { ok: true; value: GroupPolicyRequest } | { ok: false; message: string } {
  const extra = Object.keys(body).find(k => !['action', 'groupId', 'enabled', 'auto'].includes(k));
  if (extra) return { ok: false, message: `Unknown group-claims field: ${extra.slice(0, 40)}` };
  if (typeof body.groupId !== 'string' || !ID_PATTERN.test(body.groupId)) return { ok: false, message: 'groupId is not a valid id' };
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return { ok: false, message: 'enabled is true or false' };
  if (body.auto !== undefined && typeof body.auto !== 'boolean') return { ok: false, message: 'auto is true or false' };
  if (body.enabled === undefined && body.auto === undefined) return { ok: false, message: 'Say enabled, auto, or both' };
  return { ok: true, value: { action: 'group-claims', groupId: body.groupId, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.auto !== undefined ? { auto: body.auto } : {}) } };
}

export type GroupPolicyResult =
  | { ok: true; state: HomemindState; policy: GroupClaimPolicy; changed: boolean; activityId?: string }
  | { ok: false; status: 403 | 404; code: string; message: string };

function freeId(base: string, taken: (id: string) => boolean): string {
  const root = base.slice(0, 56).replace(/-+$/, '');
  if (!taken(root)) return root;
  for (let n = 2; ; n++) if (!taken(`${root}-${n}`)) return `${root}-${n}`;
}

const isParent = (state: HomemindState, memberId: string) => state.family.members.some(m => m.id === memberId && m.role === 'parent' && m.hasAccount);

/**
 * Turns a group's claims on or off, and chooses whether they post on their own. Parents only: a claim
 * writes to people outside the family. Turning it on is the approval, recorded with who and when. One
 * Activity (`kind: 'rule'`, `ref` the group). Turning it off withdraws a claim card still waiting.
 */
export function applyGroupPolicy(state: HomemindState, request: GroupPolicyRequest, memberId: string, now: number): GroupPolicyResult {
  if (!isParent(state, memberId)) return { ok: false, status: 403, code: 'forbidden', message: 'Only a parent can let Homemind post in a group' };
  if (!groupInfo(request.groupId)) return { ok: false, status: 404, code: 'not_found', message: 'No such group' };
  const before = policyFor(state, request.groupId);
  let policy: GroupClaimPolicy = { ...before };
  const notes: string[] = [];
  if (request.enabled !== undefined && request.enabled !== before.enabled) {
    if (request.enabled) policy = { ...policy, enabled: true, approvedBy: memberId, approvedAt: toIso(now) };
    else {
      const { approvedBy: _by, approvedAt: _at, ...rest } = policy;
      policy = { ...rest, enabled: false };
    }
    notes.push(request.enabled ? 'enabled' : 'disabled');
  }
  let family = state.family;
  if (request.auto !== undefined) {
    const level = request.auto ? 4 : 3;
    if (autonomyLevelFor(family, GROUP_AREA) !== level || family.autonomy.byArea?.[GROUP_AREA] !== level) {
      family = { ...family, autonomy: { ...family.autonomy, byArea: { ...(family.autonomy.byArea ?? {}), [GROUP_AREA]: level } } };
      if (autonomyLevelFor(state.family, GROUP_AREA) !== level) notes.push(request.auto ? 'auto' : 'ask');
    }
  }
  if (!notes.length && family === state.family) return { ok: true, state, policy: before, changed: false };
  let next: HomemindState = { ...state, family, groupPolicies: [...policies(state).filter(p => p.groupId !== policy.groupId), policy] };
  if (notes.includes('disabled')) {
    for (const claim of claimsOf(next)) {
      if (claim.groupId !== policy.groupId || claim.status !== 'waiting' || !claim.cardId) continue;
      next = withdrawCard(next, claim.cardId, 'Group claims were turned off', now).state;
    }
  }
  if (!notes.length) return { ok: true, state: next, policy, changed: true };
  const activityId = freeId(`act-${Math.max(0, Math.floor(now)).toString(36)}`, id => next.activity.some(a => a.id === id));
  next = { ...next, activity: [...next.activity, { id: activityId, at: toIso(now), actor: memberId, what: `Group claims for ${policy.groupId}: ${notes.join(', ')}`, kind: 'rule', ref: policy.groupId, note: notes.join(',') }] };
  return { ok: true, state: next, policy, changed: true, activityId };
}

// --- choosing --------------------------------------------------------------------------------------------

/** The child the group is about: the family's youngest (the kindergarten child). */
function childOf(state: HomemindState): Member | undefined {
  return state.family.members.filter(m => m.role === 'child').sort((a, b) => (a.age ?? 99) - (b.age ?? 99))[0];
}

function contextFor(state: HomemindState, claim: Pick<GroupClaim, 'groupId' | 'eventTitle' | 'eventTitleZh' | 'topic'>): PreferenceContext {
  const child = childOf(state);
  return {
    memberIds: child ? [child.id] : [],
    texts: [claim.eventTitle, claim.eventTitleZh, claim.topic].filter((t): t is string => !!t),
    tags: claim.groupId === KINDERGARTEN_GROUP.id ? ['kindergarten'] : []
  };
}

const asciiWord = (w: string) => /^[a-z ]+$/.test(w);
/** Whether a preference names the food (its English name at a word start, or a Chinese word anywhere). */
function mentions(preference: Preference, food: SignUpFood): boolean {
  const text = `${preference.text}\n${preference.textZh ?? ''}`.toLowerCase();
  return [food.en, food.zh, ...food.words].some(w => (asciiWord(w) ? new RegExp(`(^|[^a-z])${w}`).test(text) : text.includes(w)));
}

interface Assessed {
  option: SignUpOption;
  food?: SignUpFood;
  blocked: BlockedChoice[];
  preferred: Preference[];
}

/** Every free option with what Homemind knows about it: the food, hard preferences against it, soft ones for it. */
function assess(state: HomemindState, claim: Pick<GroupClaim, 'groupId' | 'eventTitle' | 'eventTitleZh' | 'topic' | 'options'>): Assessed[] {
  const context = contextFor(state, claim);
  const soft = applicablePreferences(state.preferences, context).filter(p => p.strength === 'soft');
  return (claim.options ?? [])
    .filter(o => !o.takenBy)
    .map(option => {
      const food = foodFor(option.label);
      return {
        option,
        food,
        blocked: checkChoice(state.preferences, context, [option.label, food?.en ?? '', food?.zh ?? '']),
        preferred: food ? soft.filter(p => mentions(p, food)) : []
      };
    });
}

const allowed = (a: Assessed, policy: GroupClaimPolicy) => !!a.food?.food && a.food.cost <= policy.maxCost && a.blocked.length === 0;
/** Preferred first, then the list's own order. */
const ranked = (list: Assessed[]) => [...list].sort((a, b) => Number(b.preferred.length > 0) - Number(a.preferred.length > 0));

/** What Homemind claims on its own: allowed, and something to buy (never a thing someone has to make). */
function autoChoice(assessed: Assessed[], policy: GroupClaimPolicy): Assessed | undefined {
  return ranked(assessed.filter(a => allowed(a, policy) && a.food?.effort === 'buy'))[0];
}

/** What a parent can change to: allowed (making is fine: a parent chooses), not the current choice. */
function alternativesFor(state: HomemindState, claim: GroupClaim): Assessed[] {
  const policy = policyFor(state, claim.groupId);
  return ranked(assess(state, claim).filter(a => allowed(a, policy) && a.food?.key !== claim.choice));
}

const choiceView = (food: SignUpFood, label: string, currency: string): SignUpChoiceView => ({ key: food.key, label, en: food.en, cost: food.cost, currency, effort: food.effort });

// --- the Why ---------------------------------------------------------------------------------------------

const nameOf = (state: HomemindState, id: string | undefined, lang: 'en' | 'zh') => {
  const m = state.family.members.find(x => x.id === id);
  return m ? (lang === 'zh' ? m.nameZh ?? m.name : m.name) : '';
};

const STOP_TEXT: Record<string, [string, string]> = {
  closed: ['the sign-up has closed', '接龙已经截止'],
  nothing_suitable: ['nothing left on the list is food Homemind may claim on its own (food to buy, within the cap, no preference against it)', '清单上剩下的没有 Homemind 可以自行认领的（需购买的食物、不超过上限、没有冲突的偏好）'],
  already_signed_up: ['the family is already on the list', '家里已经在接龙名单上'],
  paused: ['automatic actions are paused', '自动操作已暂停'],
  failed: ['the simulated group did not take the post', '模拟群没有收到这条消息'],
  withdrawn: ['the family was taken off the list', '已把家里从名单上撤下']
};

function claimWhy(state: HomemindState, claim: GroupClaim, assessed: Assessed[], auto: boolean): Why {
  const group = groupInfo(claim.groupId);
  const policy = policyFor(state, claim.groupId);
  const groupEn = group?.name ?? claim.groupId;
  const groupZh = group?.nameZh ?? claim.groupId;
  const by = policy.approvedBy;
  const header = `From the group setting "Claim food in ${groupEn}"${by ? ` (turned on by ${nameOf(state, by, 'en')})` : ''}. Homemind read the sign-up with fixed rules, not the model.`;
  const headerZh = `来自群设置“在${groupZh}认领食物”${by ? `（${nameOf(state, by, 'zh')}开启）` : ''}。Homemind 用固定规则读取接龙，没有用模型。`;
  const basis: Why['basis'] = [{ kind: 'group-setting', ref: claim.groupId, note: `Claims on, food only, up to ${policy.maxCost} ${policy.currency}${by ? `, approved by ${nameOf(state, by, 'en')}` : ''}` }, { kind: 'message', ref: claim.messageId, note: 'The sign-up message in the simulated group' }];
  let what: string;
  let whatZh: string;
  if (claim.status === 'stopped') {
    const [en, zh] = claim.reason === 'unclear' ? [`the sign-up was unclear: ${claim.problem ?? ''}`, `接龙内容不清楚：${claim.problemZh ?? ''}`] : STOP_TEXT[claim.reason ?? 'failed'] ?? STOP_TEXT.failed;
    what = `Nothing was posted: ${en}.`;
    whatZh = `没有发送：${zh}。`;
  } else {
    const chosen = assessed.find(a => a.food?.key === claim.choice);
    const food = chosen?.food;
    const taken = (claim.options ?? []).filter(o => o.takenBy).map(o => o.label);
    what = `${claim.options?.length ?? 0} choices${taken.length ? `, already taken: ${taken.join(', ')}` : ''}. It picked ${chosen?.option.label ?? ''} (${food?.en ?? ''}): food to buy, about ${food?.cost ?? 0} ${policy.currency} (cap ${policy.maxCost}), nothing to make.`;
    whatZh = `共 ${claim.options?.length ?? 0} 项${taken.length ? `，已被认领：${taken.join('、')}` : ''}。选择了${chosen?.option.label ?? ''}：需购买的食物，约 ${food?.cost ?? 0} ${policy.currency}（上限 ${policy.maxCost}），不需要动手做。`;
    if (chosen?.preferred.length) {
      what += ` A saved preference points to it: “${chosen.preferred[0].text}”.`;
      whatZh += ` 有一条已保存的偏好指向它：“${chosen.preferred[0].textZh ?? chosen.preferred[0].text}”。`;
    }
    basis.push({ kind: 'choice', note: `${chosen?.option.label ?? ''}, about ${food?.cost ?? 0} ${policy.currency}` });
    const makes = assessed.filter(a => allowed(a, policy) && a.food?.effort === 'make');
    if (makes.length) {
      what += ` ${makes.map(a => a.option.label).join(', ')} ${makes.length > 1 ? 'were' : 'was'} left for a parent to choose: making it takes someone's time, and Homemind does not commit a person's time on its own.`;
      whatZh += ` ${makes.map(a => a.option.label).join('、')}留给家长决定：做这些需要有人花时间，Homemind 不会自行替家人承诺时间。`;
    }
    for (const a of assessed) {
      for (const p of a.preferred) {
        if (a.food?.key === claim.choice) continue;
        what += ` Saved preference for ${a.option.label}: “${p.text}”${p.reason ? `, because ${p.reason}` : ''}. Tap Change to switch.`;
        whatZh += ` 关于${a.option.label}的偏好：“${p.textZh ?? p.text}”${p.reasonZh ?? p.reason ? `，因为${p.reasonZh ?? p.reason}` : ''}。点“更改”即可换。`;
        basis.push({ kind: 'preference', ref: p.id, note: p.text });
      }
      for (const b of a.blocked) {
        what += ` ${a.option.label} was ruled out: “${b.preference.text}” is never overridden.`;
        whatZh += ` ${a.option.label}被排除：“${b.preference.textZh ?? b.preference.text}”不可更改。`;
        basis.push({ kind: 'hard-preference', ref: b.preference.id, note: `${b.preference.text} (${b.term})` });
      }
    }
    what += auto ? ' The group is set to post on its own (level 4), so it posted in the simulated group.' : ' Nothing is posted until a parent taps the card.';
    whatZh += auto ? ' 这个群设置为自动发送（等级 4），所以已在模拟群里发送。' : ' 家长点一下卡片之前，不会发送任何内容。';
  }
  return { id: claim.whyId, summary: `${header} ${what}`, summaryZh: `${headerZh}${whatZh}`, basis, source: 'rule' };
}

// --- considering new sign-ups ----------------------------------------------------------------------------

export interface ConsiderResult {
  state: HomemindState;
  /** Claims recorded or replaced in this step. */
  claims: GroupClaim[];
  changed: boolean;
}

/** The claim for a message, whatever version it read: a newer version is T7.5's to compare (sourceChanges.ts), never a second claim. */
const claimFor = (state: HomemindState, message: GroupMessage) => claimsOf(state).find(c => c.messageId === message.id);

/** The messages a reading used, at their versions: the sign-up and the message the event's time came from. */
export function refsOf(message: GroupMessage, timeSource?: GroupMessage): SourceRef[] {
  const refs: SourceRef[] = [{ id: message.id, version: message.version }];
  if (timeSource && timeSource.id !== message.id) refs.push({ id: timeSource.id, version: timeSource.version });
  return refs;
}

/** A claim's source refs (older claims recorded only the sign-up). */
export const claimRefs = (claim: GroupClaim): SourceRef[] => claim.sourceRefs ?? [{ id: claim.messageId, version: claim.messageVersion }];

/**
 * Looks at every sign-up in the groups whose claims are on and that has no claim yet (or stopped only
 * because the family was paused). Records what it read and either prepares the claim card (`waiting`) or
 * stops, with the reason. Never posts: the bridge runs a waiting card at level 4, or a parent taps it.
 */
export function considerSignUps(state: HomemindState, now: number, adapters: AdapterRegistry): ConsiderResult {
  return considerMessages(state, now, adapters, () => true);
}

/** T7.5: reads one sign-up again (a stopped claim whose message was edited), replacing its claim. */
export function reconsiderSignUp(state: HomemindState, messageId: string, now: number, adapters: AdapterRegistry): ConsiderResult {
  return considerMessages(state, now, adapters, m => m.id === messageId, true);
}

function considerMessages(state: HomemindState, now: number, adapters: AdapterRegistry, wanted: (m: GroupMessage) => boolean, again = false): ConsiderResult {
  let next = state;
  const recorded: GroupClaim[] = [];
  const services = servicesOf(state);
  const group = services.group;
  const policy = policyFor(state, group.id);
  if (!policy.enabled) return { state, claims: [], changed: false };
  for (const message of group.messages) {
    if (!isSignUp(message) || !wanted(message)) continue;
    const existing = claimFor(next, message);
    if (existing && !again && !(existing.status === 'stopped' && existing.reason === 'paused' && !next.family.paused)) continue;
    const done = considerOne(next, message, policy, now, adapters, existing?.id);
    next = done.state;
    recorded.push(done.claim);
  }
  return { state: next, claims: recorded, changed: recorded.length > 0 };
}

function saveClaim(state: HomemindState, claim: GroupClaim, why: Why): HomemindState {
  const others = claimsOf(state).filter(c => c.id !== claim.id);
  return { ...state, groupClaims: [...others, claim].slice(-MAX_CLAIMS), whys: [...state.whys.filter(w => w.id !== why.id), why] };
}

function considerOne(state: HomemindState, message: GroupMessage, policy: GroupClaimPolicy, now: number, adapters: AdapterRegistry, replaceId?: string): { state: HomemindState; claim: GroupClaim } {
  const zone = state.family.timezone;
  const id = replaceId ?? freeId(`claim-${message.id}`, x => claimsOf(state).some(c => c.id === x));
  const base: GroupClaim = { id, groupId: policy.groupId, messageId: message.id, messageVersion: message.version, sourceRefs: refsOf(message), at: toIso(now), status: 'stopped', whyId: `why-${id}`.slice(0, 64) };
  const stop = (claim: GroupClaim, assessed: Assessed[] = []) => ({ claim, state: saveClaim(state, claim, claimWhy(state, claim, assessed, false)) });

  if (state.family.paused) return stop({ ...base, reason: 'paused' });
  const reading = readSignUp(servicesOf(state).group.messages, message, zone);
  if (!reading.ok) return stop({ ...base, reason: 'unclear', problem: reading.problem, problemZh: reading.problemZh });
  const titles = eventTitles(reading.eventName);
  const read: GroupClaim = {
    ...base,
    sourceRefs: refsOf(message, reading.source),
    topic: reading.topic,
    options: reading.options,
    eventTitle: titles.en,
    eventTitleZh: titles.zh,
    eventStart: toIso(reading.eventStart),
    ...(reading.deadline !== undefined ? { deadline: toIso(reading.deadline) } : {}),
    ...(reading.children ? { children: reading.children } : {})
  };
  const asMember = state.family.members.find(m => m.id === policy.approvedBy && m.role === 'parent' && m.hasAccount);
  const author = asMember ? groupAuthorFor(state, asMember) : undefined;
  if (!asMember || !author) return stop({ ...read, reason: 'failed' });
  if (reading.entries.some(e => e.who === author.authorZh || e.who === author.author)) return stop({ ...read, reason: 'already_signed_up' });
  const closesAt = Math.min(reading.deadline ?? reading.eventStart, reading.eventStart);
  if (closesAt <= now) return stop({ ...read, reason: 'closed' });
  const assessed = assess(state, read);
  const chosen = autoChoice(assessed, policy);
  if (!chosen || !chosen.food) return stop({ ...read, reason: 'nothing_suitable' }, assessed);

  const line = `${reading.entries.length + 1}. ${author.authorZh} ${chosen.option.label}`;
  const repost = `${message.text}\n${line}`;
  const text = repost.length <= 200 ? repost : line;
  const day = localParts(reading.eventStart, zone);
  const groupInfoNow = groupInfo(policy.groupId);
  const cardId = freeId(`card-${id}`, x => state.actionCards.some(c => c.id === x));
  const claim: GroupClaim = { ...read, status: 'waiting', choice: chosen.food.key, asMemberId: asMember.id, cardId };
  const auto = groupAutoAllowed(state);
  const why = claimWhy(state, claim, assessed, auto);
  const prepared = prepareCard(
    state,
    {
      id: cardId,
      adapter: ADAPTER_IDS.groupReply,
      payload: {
        groupId: policy.groupId,
        text,
        kind: 'claim',
        replyTo: message.id,
        asMemberId: asMember.id,
        title: `Sign-up: ${chosen.food.en} for the ${titles.en.toLowerCase()}`,
        titleZh: `接龙认领：${chosen.option.label}（${titles.zh}）`,
        summary: `Post in ${groupInfoNow?.name ?? policy.groupId} as ${author.author}: “${line}”. ${WEEKDAY_NAME_EN[day.weekday]} ${day.time}. Food to buy, about ${chosen.food.cost} ${policy.currency}. Simulated group: nothing leaves this demo.`,
        summaryZh: `以${author.authorZh}的身份在${groupInfoNow?.nameZh ?? policy.groupId}发送：“${line}”。${WEEKDAY_NAME_ZH[day.weekday]} ${day.time}。需购买的食物，约 ${chosen.food.cost} ${policy.currency}。模拟群：不会发到演示之外。`
      },
      expiresAt: toIso(closesAt),
      whyId: why.id,
      title: `Sign-up: ${chosen.food.en}`,
      titleZh: `接龙认领：${chosen.option.label}`,
      sourceRefs: claim.sourceRefs
    },
    adapters,
    now
  );
  if (!prepared.ok) return stop({ ...read, reason: 'failed' }, assessed);
  return { claim, state: saveClaim(prepared.state, claim, why) };
}

// --- after a card ran ------------------------------------------------------------------------------------

export interface AfterCard {
  state: HomemindState;
  events: CoreEvent[];
  alerts: AlertDelivery[];
  claim: GroupClaim;
}

/** Applies changes one after another as `actor`; stops at the first refusal and keeps what was applied. */
function applyAll(state: HomemindState, changes: Change[], actor: string, clock: Clock): { state: HomemindState; events: CoreEvent[]; ids: string[] } {
  let current = state;
  const events: CoreEvent[] = [];
  const ids: string[] = [];
  for (const change of changes) {
    const result = applyChange(current, change, actor, clock);
    if (!result.ok) break;
    current = result.state;
    events.push(...result.events);
    ids.push(...result.items.map(i => i.id));
  }
  return { state: current, events, ids };
}

const sourceOf = () => ({ kind: 'rule' as const, label: SOURCE_LABEL, simulated: true });

/** The preparations for a claimed food: buy it (and bake it, for a cake) the day before, bring it that morning. */
export function preparationsFor(food: SignUpFood, label: string, claim: GroupClaim, timezone: string, now: number): Array<{ title: string; titleZh: string; start?: string }> {
  const start = Date.parse(claim.eventStart ?? '');
  if (!Number.isFinite(start)) return [];
  const date = localParts(start, timezone).date;
  const before = addDays(date, -1);
  const kids = claim.children ? ` (${claim.children} children)` : '';
  const kidsZh = claim.children ? `（${claim.children}个小朋友）` : '';
  const at = (day: string, time: string, limit = start) => {
    const ms = Math.min(zonedToUtc(day, time, timezone), limit - HOUR);
    return ms > now ? toIso(ms) : undefined;
  };
  const bring = { title: `Bring the ${food.en} to kindergarten`, titleZh: `把${label}带到幼儿园`, start: at(date, '08:00') };
  const list =
    food.effort === 'make'
      ? [
          { title: `Buy what the ${food.en} needs`, titleZh: `买做${label}的材料`, start: at(before, '17:00') },
          { title: `Make the ${food.en} for the party${kids}`, titleZh: `为派对做${label}${kidsZh}`, start: at(before, '19:00') },
          bring
        ]
      : [{ title: `Buy ${food.en} for the kindergarten party${kids}`, titleZh: `为幼儿园派对买${label}${kidsZh}`, start: at(before, '18:00') }, bring];
  return list.map(p => (p.start ? p : { title: p.title, titleZh: p.titleZh }));
}

function prepChanges(state: HomemindState, food: SignUpFood, label: string, claim: GroupClaim, eventId: string, now: number): Change[] {
  const parents = state.family.members.filter(m => m.role === 'parent' && m.hasAccount).map(m => m.id);
  return preparationsFor(food, label, claim, state.family.timezone, now).map(p => {
    const item: NewItem = {
      type: 'preparation',
      title: p.title,
      titleZh: p.titleZh,
      ...(p.start ? { start: p.start } : {}),
      parentEventId: eventId,
      // "Who's taking this?": Homemind never gives a person work on its own.
      ownership: { state: 'open', candidateIds: parents },
      source: sourceOf(),
      sourceRefs: claimRefs(claim)
    };
    return { kind: 'create', item };
  });
}

/** The party already on the board (same start, open, a party), or none. */
function existingEvent(state: HomemindState, claim: GroupClaim): Item | undefined {
  return state.items.find(i => i.type === 'event' && i.status === 'open' && i.start === claim.eventStart && /party|派对|聚会/i.test(`${i.title} ${i.titleZh ?? ''}`));
}

function groupAlerts(state: HomemindState, claim: GroupClaim, event: Item, at: number, step: string, label: string, food: SignUpFood, from?: { label: string; food?: SignUpFood }): AlertDelivery[] {
  const alert: HomemindAlert = {
    id: `${claim.id}.${step}.group`,
    kind: 'group',
    itemId: event.id,
    itemVersion: event.version,
    tier: 'timed',
    at: toIso(at),
    byId: 'homemind',
    byName: 'Homemind',
    byNameZh: 'Homemind',
    title: event.title,
    ...(event.titleZh ? { titleZh: event.titleZh } : {}),
    sensitive: false,
    simulated: true,
    groupChoice: food.en,
    groupChoiceZh: label,
    ...(from ? { groupFrom: from.food?.en ?? from.label, groupFromZh: from.label } : {})
  };
  return state.family.members.filter(m => m.hasAccount && canSeeItem(state, m.id, event)).map(m => ({ recipientId: m.id, alert }));
}

export const labelOf = (claim: GroupClaim, key: string | undefined) => claim.options?.find(o => o.key === key)?.label ?? foodByKey(key)?.zh ?? key ?? '';

export function replaceClaim(state: HomemindState, claim: GroupClaim): HomemindState {
  return { ...state, groupClaims: claimsOf(state).map(c => (c.id === claim.id ? claim : c)) };
}

/**
 * After the bridge ran a group card: a claim that posted becomes `claimed`, with the party (unless it is
 * on the board already) and its preparations, and a notice to the family; a correction that posted swaps
 * the preparations. A failed post is recorded. Returns null for a card that is not a group claim's.
 */
export function afterGroupCard(state: HomemindState, card: ActionCard, now: number, clock: Clock): AfterCard | null {
  if (card.adapter !== ADAPTER_IDS.groupReply) return null;
  const claim = claimsOf(state).find(c => c.cardId === card.id || (c.changes ?? []).some(ch => ch.cardId === card.id));
  if (!claim) return null;
  if (claim.cardId === card.id) return afterClaimCard(state, claim, card, now, clock);
  return afterChangeCard(state, claim, card, now, clock);
}

function afterClaimCard(state: HomemindState, claim: GroupClaim, card: ActionCard, now: number, clock: Clock): AfterCard | null {
  if (claim.status !== 'waiting') return null;
  if (card.status === 'failed') {
    const stopped: GroupClaim = { ...claim, status: 'stopped', reason: 'failed' };
    return { state: replaceClaim(state, stopped), events: [], alerts: [], claim: stopped };
  }
  if (card.status !== 'executed') return null;
  const food = foodByKey(claim.choice);
  const actor = claim.asMemberId ?? '';
  if (!food) return null;
  const label = labelOf(claim, claim.choice);
  let current = state;
  const events: CoreEvent[] = [];
  let event = existingEvent(current, claim);
  if (!event && claim.eventStart) {
    const message = servicesOf(current).group.messages.find(m => m.id === claim.messageId);
    const start = Date.parse(claim.eventStart);
    const child = childOf(current);
    const created = applyAll(
      current,
      [
        {
          kind: 'create',
          item: {
            type: 'event',
            title: claim.eventTitle ?? 'Kindergarten party',
            titleZh: claim.eventTitleZh,
            start: claim.eventStart,
            end: toIso(start + HOUR),
            forMemberIds: child ? [child.id] : [],
            ...(message ? { notes: `“${message.text.slice(0, 300)}”` } : {}),
            source: sourceOf(),
            sourceRefs: claimRefs(claim)
          }
        }
      ],
      actor,
      clock
    );
    current = created.state;
    events.push(...created.events);
    event = current.items.find(i => i.id === created.ids[0]);
  }
  let preparationIds: string[] = [];
  if (event) {
    const preps = applyAll(current, prepChanges(current, food, label, claim, event.id, now), actor, clock);
    current = preps.state;
    events.push(...preps.events);
    preparationIds = preps.ids;
  }
  const claimed: GroupClaim = { ...claim, status: 'claimed', ...(event ? { eventId: event.id } : {}), preparationIds };
  current = replaceClaim(current, claimed);
  const alerts = event ? groupAlerts(current, claimed, current.items.find(i => i.id === event!.id) ?? event, now, 'claimed', label, food) : [];
  return { state: current, events, alerts, claim: claimed };
}

function afterChangeCard(state: HomemindState, claim: GroupClaim, card: ActionCard, now: number, clock: Clock): AfterCard | null {
  const change = (claim.changes ?? []).find(ch => ch.cardId === card.id);
  if (!change || change.status !== 'waiting') return null;
  const withChange = (status: GroupClaimChange['status'], extra: Partial<GroupClaim> = {}): GroupClaim => ({
    ...claim,
    ...extra,
    changes: (claim.changes ?? []).map(ch => (ch.cardId === card.id ? { ...ch, status } : ch))
  });
  if (card.status === 'failed') {
    const failed = withChange('failed');
    return { state: replaceClaim(state, failed), events: [], alerts: [], claim: failed };
  }
  if (card.status !== 'executed') return null;
  if (!change.to) return afterWithdrawal(state, claim, change, card, clock);
  const food = foodByKey(change.to);
  if (!food) return null;
  const label = labelOf(claim, change.to);
  let current = state;
  const events: CoreEvent[] = [];
  // The old preparations leave the board (cancelled, so Undo can bring them back), the new ones arrive.
  const cancels: Change[] = (claim.preparationIds ?? []).flatMap(id => {
    const item = current.items.find(i => i.id === id);
    return item && (item.status === 'open' || item.status === 'proposed') ? [{ kind: 'cancel' as const, itemId: id, version: item.version }] : [];
  });
  const cancelled = applyAll(current, cancels, change.by, clock);
  current = cancelled.state;
  events.push(...cancelled.events);
  const event = claim.eventId ? current.items.find(i => i.id === claim.eventId && i.status === 'open') : undefined;
  let preparationIds: string[] = [];
  if (event) {
    const preps = applyAll(current, prepChanges(current, food, label, claim, event.id, now), change.by, clock);
    current = preps.state;
    events.push(...preps.events);
    preparationIds = preps.ids;
  }
  const changed = withChange('posted', { choice: change.to, preparationIds });
  current = replaceClaim(current, changed);
  const step = `change${(claim.changes ?? []).indexOf(change) + 1}`;
  const alerts = event ? groupAlerts(current, changed, current.items.find(i => i.id === event.id) ?? event, now, step, label, food, { label: labelOf(claim, change.from), food: foodByKey(change.from) }) : [];
  return { state: current, events, alerts, claim: changed };
}

/** T7.5: the family's name came off the list. What is left of its preparations leaves the board (Undo can bring them back). */
function afterWithdrawal(state: HomemindState, claim: GroupClaim, change: GroupClaimChange, card: ActionCard, clock: Clock): AfterCard {
  const cancels: Change[] = (claim.preparationIds ?? []).flatMap(id => {
    const item = state.items.find(i => i.id === id);
    return item && (item.status === 'open' || item.status === 'proposed') ? [{ kind: 'cancel' as const, itemId: id, version: item.version }] : [];
  });
  const cancelled = applyAll(state, cancels, change.by, clock);
  const withdrawn: GroupClaim = {
    ...claim,
    status: 'stopped',
    reason: 'withdrawn',
    changes: (claim.changes ?? []).map(ch => (ch.cardId === card.id ? { ...ch, status: 'posted' as const } : ch))
  };
  return { state: replaceClaim(cancelled.state, withdrawn), events: cancelled.events, alerts: [], claim: withdrawn };
}

// --- "Change" --------------------------------------------------------------------------------------------

export type ChangeRequestResult =
  | { ok: true; state: HomemindState; claim: GroupClaim; card: ActionCard }
  | { ok: false; status: 403 | 404 | 409; code: string; message: string };

/**
 * A parent taps "Change" on a claim: prepares a correction card for the group (a simulated post). The
 * bridge runs it at level 4; below that it waits for the parent's tap like any card. The option must be
 * one of the claim's alternatives right now (free, food, within the cap, no hard preference against it).
 */
export function requestGroupChange(state: HomemindState, claimId: string, optionKey: string, memberId: string, now: number, adapters: AdapterRegistry): ChangeRequestResult {
  if (!optionKey) return { ok: false, status: 409, code: 'not_available', message: 'Say which choice to change to' };
  return prepareClaimCorrection(state, claimId, optionKey, memberId, now, adapters);
}

/**
 * A correction card for a posted claim: switch to `optionKey`, or (T7.5) with `''` take the family's name
 * off the list. `because` (T7.5: "apples are no longer needed") goes into the post and the Why.
 */
export function prepareClaimCorrection(
  state: HomemindState,
  claimId: string,
  optionKey: string,
  memberId: string,
  now: number,
  adapters: AdapterRegistry,
  because?: { en: string; zh: string }
): ChangeRequestResult {
  if (!isParent(state, memberId)) return { ok: false, status: 403, code: 'forbidden', message: 'Only a parent can change what the family signed up for' };
  const claim = claimsOf(state).find(c => c.id === claimId);
  if (!claim) return { ok: false, status: 404, code: 'not_found', message: 'No such sign-up' };
  if (claim.status !== 'claimed') return { ok: false, status: 409, code: 'not_claimed', message: 'Nothing was posted for this sign-up yet' };
  if ((claim.changes ?? []).some(ch => ch.status === 'waiting' && state.actionCards.find(c => c.id === ch.cardId)?.status === 'pending')) {
    return { ok: false, status: 409, code: 'change_waiting', message: 'A change for this sign-up already waits for a tap' };
  }
  const closesAt = Math.min(Date.parse(claim.deadline ?? claim.eventStart ?? ''), Date.parse(claim.eventStart ?? ''));
  if (!(closesAt > now)) return { ok: false, status: 409, code: 'closed', message: 'The sign-up has closed' };
  const target = optionKey ? alternativesFor(state, claim).find(a => a.food?.key === optionKey) : undefined;
  if (optionKey && (!target || !target.food)) return { ok: false, status: 409, code: 'not_available', message: 'That choice is not available: taken, not food, over the cap, or ruled out by a preference' };
  const member = state.family.members.find(m => m.id === memberId) as Member;
  const claimant = state.family.members.find(m => m.id === claim.asMemberId) ?? member;
  const author = groupAuthorFor(state, claimant);
  const fromLabel = labelOf(claim, claim.choice);
  const text = target
    ? `更正：${author.authorZh}认领改为${target.option.label}（原来是${fromLabel}${because ? `，${because.zh}` : ''}）`
    : `更正：${author.authorZh}取消认领${fromLabel}${because ? `（${because.zh}）` : ''}`;
  const n = (claim.changes ?? []).length + 1;
  const cardId = freeId(`card-${claim.id}-fix-${n}`, x => state.actionCards.some(c => c.id === x));
  const whyId = `why-${cardId}`.slice(0, 64);
  const pref = target?.preferred[0];
  const auto = groupAutoAllowed(state);
  const group = groupInfo(claim.groupId);
  const toEn = target ? `${target.option.label} (${target.food?.en ?? ''})` : 'off the list';
  const toZh = target ? target.option.label : '取消认领';
  const who = nameOf(state, memberId, 'en');
  const whoZh = nameOf(state, memberId, 'zh');
  const lead = because ? `${because.en}. ${who} chose: ${fromLabel} → ${toEn}.` : `${who} tapped Change: ${fromLabel} → ${toEn}.`;
  const leadZh = because ? `${because.zh}。${whoZh}选择：${fromLabel} → ${toZh}。` : `${whoZh}点了“更改”：${fromLabel} → ${toZh}。`;
  const why: Why = {
    id: whyId,
    summary: `${lead}${pref ? ` Saved preference: “${pref.text}”${pref.reason ? `, because ${pref.reason}` : ''}.` : ''} Homemind posts a correction in ${group?.name ?? claim.groupId} (simulated) and ${target ? 'swaps the preparations' : 'takes the preparations off the board'}.${auto ? ' The group is set to post on its own (level 4).' : ' Nothing is posted until a parent taps the card.'}`,
    summaryZh: `${leadZh}${pref ? `已保存的偏好：“${pref.textZh ?? pref.text}”${pref.reasonZh ?? pref.reason ? `，因为${pref.reasonZh ?? pref.reason}` : ''}。` : ''}Homemind 会在${group?.nameZh ?? claim.groupId}（模拟）发一条更正，${target ? '并更换准备事项' : '并把准备事项从看板上移除'}。${auto ? '这个群设置为自动发送（等级 4）。' : '家长点一下卡片之前，不会发送任何内容。'}`,
    basis: [
      { kind: 'change', ref: claim.id, note: `${fromLabel} to ${target ? target.option.label : 'none'}, asked by ${who}` },
      ...(because ? [{ kind: 'message', ref: claim.messageId, note: because.en }] : []),
      ...(pref ? [{ kind: 'preference', ref: pref.id, note: pref.text }] : [])
    ],
    source: 'rule'
  };
  const cardTitle = target ? `Change the sign-up to ${target.food?.en ?? ''}` : `Take the family off the sign-up (${fromLabel})`;
  const cardTitleZh = target ? `接龙改为${target.option.label}` : `取消接龙认领（${fromLabel}）`;
  const prepared = prepareCard(
    state,
    {
      id: cardId,
      adapter: ADAPTER_IDS.groupReply,
      payload: {
        groupId: claim.groupId,
        text,
        kind: 'correction',
        replyTo: claim.messageId,
        asMemberId: memberId,
        title: cardTitle,
        titleZh: cardTitleZh,
        summary: `Post in ${group?.name ?? claim.groupId}: “${text}”. Simulated group: nothing leaves this demo.`,
        summaryZh: `在${group?.nameZh ?? claim.groupId}发送：“${text}”。模拟群：不会发到演示之外。`
      },
      expiresAt: toIso(closesAt),
      whyId,
      title: cardTitle,
      titleZh: cardTitleZh,
      sourceRefs: claimRefs(claim)
    },
    adapters,
    now
  );
  if (!prepared.ok) return { ok: false, status: 409, code: prepared.code, message: prepared.message };
  const change: GroupClaimChange = { at: toIso(now), by: memberId, from: claim.choice ?? '', to: target?.food?.key ?? '', cardId, status: 'waiting' };
  const updated: GroupClaim = { ...claim, changes: [...(claim.changes ?? []), change], whyId };
  const next = replaceClaim({ ...prepared.state, whys: [...prepared.state.whys.filter(w => w.id !== whyId), why] }, updated);
  return { ok: true, state: next, claim: updated, card: prepared.card };
}


// --- what screens show -----------------------------------------------------------------------------------

/** Policies and claims as the screens show them. Nothing here is Parents-only: the group is family-wide. */
export function groupsView(state: HomemindState): GroupsView {
  const level = autonomyLevelFor(state.family, GROUP_AREA);
  return {
    policies: GROUPS.map(g => {
      const p = policyFor(state, g.id);
      return { groupId: g.id, name: g.name, nameZh: g.nameZh, enabled: p.enabled, ...(p.approvedBy ? { approvedBy: p.approvedBy } : {}), ...(p.approvedAt ? { approvedAt: p.approvedAt } : {}), maxCost: p.maxCost, currency: p.currency, level, paused: state.family.paused };
    }),
    claims: [...claimsOf(state)].reverse().map(claim => {
      const g = groupInfo(claim.groupId);
      const policy = policyFor(state, claim.groupId);
      const food = foodByKey(claim.choice);
      const waiting = (claim.changes ?? []).find(ch => ch.status === 'waiting' && state.actionCards.find(c => c.id === ch.cardId)?.status === 'pending');
      return {
        claim,
        groupName: g?.name ?? claim.groupId,
        groupNameZh: g?.nameZh ?? claim.groupId,
        ...(food ? { choice: choiceView(food, labelOf(claim, food.key), policy.currency) } : {}),
        alternatives:
          claim.status === 'claimed'
            ? alternativesFor(state, claim).flatMap(a =>
                a.food ? [{ ...choiceView(a.food, a.option.label, policy.currency), preferences: a.preferred.map(p => ({ id: p.id, text: p.text, ...(p.textZh ? { textZh: p.textZh } : {}), ...(p.reason ? { reason: p.reason } : {}), ...(p.reasonZh ? { reasonZh: p.reasonZh } : {}) })) }] : []
              )
            : [],
        ...(claim.status === 'waiting' && claim.cardId ? { cardStatus: state.actionCards.find(c => c.id === claim.cardId)?.status } : {}),
        ...(waiting ? { changeWaiting: { to: waiting.to, label: labelOf(claim, waiting.to) } } : {})
      };
    })
  };
}

// --- T7.5: what a changed sign-up allows ------------------------------------------------------------------

/**
 * When the family's choice is gone from an edited list: what Homemind would claim instead, by the same
 * rules as a first claim (food to buy, within the cap, no hard preference against it, a soft one first).
 */
export function switchChoiceFor(state: HomemindState, claim: GroupClaim, options: SignUpOption[]): { key: string; label: string } | undefined {
  const policy = policyFor(state, claim.groupId);
  const pick = autoChoice(assess(state, { ...claim, options }).filter(a => a.food?.key !== claim.choice), policy);
  return pick?.food ? { key: pick.food.key, label: pick.option.label } : undefined;
}
