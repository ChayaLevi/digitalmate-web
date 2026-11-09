/**
 * When a message changes after the family acted on it (T7.5).
 *
 * The teacher edits her party message ("Thursday" becomes "Friday") or the sign-up list is edited (apples
 * are no longer needed). Everything Homemind made from the old version (the party on the board, its
 * preparations, the claim, a card that quotes it) is now possibly wrong. This module:
 *   - **reads the new version again with the same fixed rules** as the first time (`readSignUp`), and
 *     **compares in code**: the event's start, the deadline, the choices, whether the family's choice is
 *     still free. The model is not used here at all, so it can't "decide" what changed.
 *   - marks every item that depends on the old version `stale` (one core change, by `homemind`), so its
 *     reminders wait (reminders.ts), and **holds** every pending card that quotes it: a held card never
 *     runs, not even at autonomy level 4 (the guard in actions.ts refuses it).
 *   - records one `SourceChange` with the differences, for one card: "The kindergarten changed the party
 *     to Friday. 3 items depend on it." A parent picks **Apply changes** (move the event, move the
 *     preparations by the same amount, and post a correction in the simulated group if the claim is
 *     affected), **Keep as is** (clear the flags) or **Discard** (take the items off the board and the
 *     family's name off the list). Each has Undo for the board; a post already made in the simulated
 *     group can't be taken back, so Undo is refused then.
 *   - tells the owners of the affected items, in neutral words, only about items they can see.
 *
 * Pure: the bridge commits the state, publishes the events and alerts, and runs any correction card
 * (through the action guard) after a resolution.
 */
import type { AdapterRegistry } from './actions';
import { withdrawCard } from './actions';
import type { AlertDelivery } from './alerts';
import { localParts, toIso } from './clock';
import type { Clock } from './clock';
import { applyChange } from './core';
import type { CoreEvent, SourceUpdate } from './core';
import { KINDERGARTEN_GROUP, servicesOf } from './fakes';
import { claimRefs, labelOf, prepareClaimCorrection, readSignUp, refsOf, replaceClaim, switchChoiceFor } from './groupClaims';
import type { ActionCard, GroupClaim, GroupMessage, HomemindAlert, HomemindState, Item, SourceChange, SourceChangeView, SourceDiff, SourceRef, StaleMark, Why } from './types';
import { canSeeItem } from './visibility';

const HOMEMIND = 'homemind';
type TimeDiff = Extract<SourceDiff, { field: 'eventStart' | 'deadline' }>;
const MAX_CHANGES = 50;
const RECENT_MS = 12 * 60 * 60 * 1000;
const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const changesOf = (state: HomemindState): SourceChange[] => state.sourceChanges ?? [];
const claimsOf = (state: HomemindState): GroupClaim[] => state.groupClaims ?? [];
const live = (item: Item) => item.status === 'open' || item.status === 'proposed';
const groups = [KINDERGARTEN_GROUP] as const;

/** The messages as they are now, by id. */
function messagesById(state: HomemindState): Map<string, GroupMessage> {
  return new Map(servicesOf(state).group.messages.map(m => [m.id, m]));
}

/** Refs whose message has a newer version now. */
function behind(refs: readonly SourceRef[], current: Map<string, GroupMessage>): SourceRef[] {
  return refs.filter(r => {
    const m = current.get(r.id);
    return !!m && m.version > r.version;
  });
}

const refreshed = (refs: readonly SourceRef[], current: Map<string, GroupMessage>): SourceRef[] => refs.map(r => ({ id: r.id, version: current.get(r.id)?.version ?? r.version }));

function freeId(base: string, taken: (id: string) => boolean): string {
  const root = base.slice(0, 58).replace(/-+$/, '');
  for (let n = 1; ; n++) if (!taken(`${root}-${n}`)) return `${root}-${n}`;
}

function when(iso: string | undefined, zone: string, lang: 'en' | 'zh'): string {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '';
  const p = localParts(ms, zone);
  const day = `${p.date.slice(5).replace('-', '/')}`;
  return lang === 'zh' ? `${WEEKDAY_ZH[p.weekday]} ${day} ${p.time}` : `${WEEKDAY_EN[p.weekday]} ${day} ${p.time}`;
}

/** The differences in plain words, both languages. Built from the diffs only (code, not the model). */
export function describeDiffs(diffs: readonly SourceDiff[], zone: string): { en: string; zh: string } {
  const en: string[] = [];
  const zh: string[] = [];
  for (const d of diffs) {
    if (d.field === 'eventStart') {
      en.push(`The party moved from ${when(d.old, zone, 'en')} to ${when(d.new, zone, 'en')}.`);
      zh.push(`派对从${when(d.old, zone, 'zh')}改到${when(d.new, zone, 'zh')}。`);
    } else if (d.field === 'deadline') {
      en.push(d.new ? `The sign-up now closes ${when(d.new, zone, 'en')}.` : 'The sign-up no longer says when it closes.');
      zh.push(d.new ? `接龙截止时间改为${when(d.new, zone, 'zh')}。` : '接龙不再写截止时间。');
    } else if (d.field === 'options') {
      if (d.removed.length) {
        en.push(`No longer on the list: ${d.removed.join(', ')}.`);
        zh.push(`清单上已不需要：${d.removed.join('、')}。`);
      }
      if (d.added.length) {
        en.push(`New on the list: ${d.added.join(', ')}.`);
        zh.push(`清单上新增：${d.added.join('、')}。`);
      }
    } else if (d.field === 'choice') {
      en.push(d.switchTo ? `The family's ${d.oldLabel} is no longer needed; Apply switches the claim to ${d.switchToLabel} and posts a correction.` : `The family's ${d.oldLabel} is no longer needed and nothing else fits; Apply takes the family's name off the list.`);
      zh.push(d.switchTo ? `家里认领的${d.oldLabel}已不需要；“应用更改”会改为${d.switchToLabel}并发一条更正。` : `家里认领的${d.oldLabel}已不需要，也没有其他合适的；“应用更改”会把家里从名单上撤下。`);
    } else if (d.field === 'unclear') {
      en.push(`The edited message could not be read: ${d.problem}.`);
      zh.push(`修改后的消息读不懂：${d.problemZh}。`);
    }
  }
  return { en: en.join(' '), zh: zh.join('') };
}

/** One item's stale mark: what moves for it, or why it might be wrong. */
function markFor(item: Item, change: Pick<SourceChange, 'id' | 'diffs'>, claim: GroupClaim, at: number, zone: string): StaleMark {
  const text = describeDiffs(change.diffs, zone);
  const base = { changeId: change.id, at: toIso(at), reason: text.en, reasonZh: text.zh };
  const unclear = change.diffs.find(d => d.field === 'unclear');
  if (unclear) return { ...base, field: 'unclear' };
  const choice = change.diffs.find((d): d is Extract<SourceDiff, { field: 'choice' }> => d.field === 'choice');
  if (choice && item.type === 'preparation') return { ...base, field: 'choice', oldValue: choice.old, ...(choice.switchTo ? { newValue: choice.switchTo } : {}) };
  const moved = change.diffs.find((d): d is TimeDiff => d.field === 'eventStart');
  if (moved && item.start) {
    const delta = Date.parse(moved.new ?? '') - Date.parse(moved.old ?? '');
    const next = Number.isFinite(delta) ? toIso(Date.parse(item.start) + delta) : undefined;
    return { ...base, field: 'start', oldValue: item.start, ...(next ? { newValue: next } : {}) };
  }
  return { ...base, field: choice ? 'choice' : 'start', ...(choice ? { oldValue: claim.choice ?? '' } : {}) };
}

/** Items that came from the claim's messages at an older version (or, for older data, the claim's own ids). */
function dependents(state: HomemindState, claim: GroupClaim, stale: readonly SourceRef[]): Item[] {
  const ids = new Set(stale.map(r => r.id));
  const own = new Set([claim.eventId, ...(claim.preparationIds ?? [])].filter((x): x is string => !!x));
  return state.items.filter(i => live(i) && ((i.sourceRefs ?? []).some(r => ids.has(r.id) && stale.some(s => s.id === r.id && r.version <= s.version)) || (!i.sourceRefs && own.has(i.id))));
}

/** Pending cards that quote an older version of the messages (or the claim's own cards). */
function quotingCards(state: HomemindState, claim: GroupClaim, stale: readonly SourceRef[]): ActionCard[] {
  const ids = new Set(stale.map(r => r.id));
  const own = new Set([claim.cardId, ...(claim.changes ?? []).map(c => c.cardId)].filter((x): x is string => !!x));
  return state.actionCards.filter(c => c.status === 'pending' && ((c.sourceRefs ?? []).some(r => ids.has(r.id) && stale.some(s => s.id === r.id && r.version <= s.version)) || (!c.sourceRefs && own.has(c.id))));
}

/** The differences between what the claim recorded and a new reading, in code. */
export function compareReading(state: HomemindState, claim: GroupClaim, signUp: GroupMessage): SourceDiff[] {
  const reading = readSignUp(servicesOf(state).group.messages, signUp, state.family.timezone);
  if (!reading.ok) return [{ field: 'unclear', problem: reading.problem, problemZh: reading.problemZh }];
  const diffs: SourceDiff[] = [];
  const start = toIso(reading.eventStart);
  if (claim.eventStart !== start) diffs.push({ field: 'eventStart', ...(claim.eventStart ? { old: claim.eventStart } : {}), new: start });
  const deadline = reading.deadline !== undefined ? toIso(reading.deadline) : undefined;
  if (claim.deadline !== deadline) diffs.push({ field: 'deadline', ...(claim.deadline ? { old: claim.deadline } : {}), ...(deadline ? { new: deadline } : {}) });
  const before = (claim.options ?? []).map(o => o.label);
  const after = reading.options.map(o => o.label);
  const removed = before.filter(l => !after.includes(l));
  const added = after.filter(l => !before.includes(l));
  if (removed.length || added.length) diffs.push({ field: 'options', removed, added });
  if (claim.choice) {
    const label = labelOf(claim, claim.choice);
    const option = reading.options.find(o => o.label === label);
    if (!option || option.takenBy) {
      const instead = switchChoiceFor(state, claim, reading.options);
      diffs.push({ field: 'choice', old: claim.choice, oldLabel: label, ...(instead ? { switchTo: instead.key, switchToLabel: instead.label } : {}) });
    }
  }
  return diffs;
}

/** The claim with what the new reading says (times, choices, versions); the family's choice is kept. */
function claimFromReading(state: HomemindState, claim: GroupClaim, signUp: GroupMessage): GroupClaim {
  const reading = readSignUp(servicesOf(state).group.messages, signUp, state.family.timezone);
  const current = messagesById(state);
  const base: GroupClaim = { ...claim, messageVersion: signUp.version, sourceRefs: refreshed(claimRefs(claim), current) };
  if (!reading.ok) return base;
  const { deadline: _d, ...rest } = base;
  return {
    ...rest,
    sourceRefs: refsOf(signUp, reading.source),
    topic: reading.topic,
    options: reading.options,
    eventStart: toIso(reading.eventStart),
    ...(reading.deadline !== undefined ? { deadline: toIso(reading.deadline) } : {})
  };
}

// --- detecting --------------------------------------------------------------------------------------------

export interface DetectResult {
  state: HomemindState;
  changes: SourceChange[];
  events: CoreEvent[];
  alerts: AlertDelivery[];
  /** Stopped claims whose message changed: the bridge reads them again (they have nothing on the board). */
  reread: string[];
  changed: boolean;
}

function changeAlerts(state: HomemindState, change: SourceChange, items: Item[], headline: { en: string; zh: string }, at: number): AlertDelivery[] {
  const out: AlertDelivery[] = [];
  for (const member of state.family.members) {
    if (!member.hasAccount) continue;
    // The owners of the affected items: whoever has one, or is asked "Who's taking this?". Only items they can see.
    const theirs = items.filter(i => canSeeItem(state, member.id, i) && ((i.ownership.state === 'assigned' && i.ownership.ownerId === member.id) || (i.ownership.state === 'open' && i.ownership.candidateIds.includes(member.id))));
    if (!theirs.length) continue;
    const anchor = items.find(i => i.type === 'event' && canSeeItem(state, member.id, i)) ?? theirs[0];
    const alert: HomemindAlert = {
      id: `${change.id}.stale`,
      kind: 'stale',
      itemId: anchor.id,
      itemVersion: anchor.version,
      tier: 'timed',
      at: toIso(at),
      byId: HOMEMIND,
      byName: 'Homemind',
      byNameZh: 'Homemind',
      title: anchor.title,
      ...(anchor.titleZh ? { titleZh: anchor.titleZh } : {}),
      sensitive: anchor.sensitive,
      simulated: true,
      staleCount: theirs.length,
      staleWhat: headline.en,
      staleWhatZh: headline.zh
    };
    out.push({ recipientId: member.id, alert });
  }
  return out;
}

function changeWhy(change: SourceChange, count: number, cards: number, headline: { en: string; zh: string }): Why {
  const waiting = cards ? ` ${cards} card${cards > 1 ? 's' : ''} that quote${cards > 1 ? '' : 's'} it ${cards > 1 ? 'are' : 'is'} on hold and can't run until a parent decides.` : '';
  const waitingZh = cards ? `引用它的 ${cards} 张卡片已暂停，家长决定之前不会执行。` : '';
  return {
    id: change.whyId,
    summary: `A message in the simulated group was edited (${change.messages.map(m => `version ${m.from} → ${m.to}`).join(', ')}). Homemind read the new version with the same fixed rules and compared it with the old one in code, not with the model. ${headline.en} ${count} item${count === 1 ? '' : 's'} on the board depend${count === 1 ? 's' : ''} on it; their reminders wait.${waiting} Nothing on the board was changed yet.`,
    summaryZh: `模拟群里有一条消息被修改了（${change.messages.map(m => `版本 ${m.from} → ${m.to}`).join('，')}）。Homemind 用同样的固定规则读取新版本，并在代码里和旧版本比较，没有用模型。${headline.zh}看板上有 ${count} 项依赖它，相关提醒先暂停。${waitingZh}看板上的内容还没有改动。`,
    basis: [
      ...change.messages.map(m => ({ kind: 'message', ref: m.id, note: `version ${m.from} → ${m.to}` })),
      ...change.diffs.map(d => ({ kind: `diff-${d.field}`, note: d.field === 'unclear' ? d.problem : d.field === 'options' ? `removed: ${d.removed.join(', ') || '-'}; added: ${d.added.join(', ') || '-'}` : d.field === 'choice' ? `${d.oldLabel} → ${d.switchToLabel ?? 'none'}` : `${d.old ?? '-'} → ${d.new ?? '-'}` }))
    ],
    source: 'rule'
  };
}

/**
 * Looks at every claim whose messages have a newer version now. A claim that stopped (nothing on the board)
 * is just read again (`reread`). Otherwise the new version is read and compared in code: no real difference
 * updates the versions quietly; a difference marks the dependent items stale, holds the cards that quote it,
 * and records one pending `SourceChange` (replacing a pending one for the same claim).
 */
export function detectSourceChanges(state: HomemindState, now: number, clock: Clock): DetectResult {
  let next = state;
  const events: CoreEvent[] = [];
  const alerts: AlertDelivery[] = [];
  const recorded: SourceChange[] = [];
  const reread: string[] = [];
  const zone = state.family.timezone;
  for (const claim of claimsOf(state)) {
    const current = messagesById(next);
    const old = behind(claimRefs(claim), current);
    if (!old.length) continue;
    const signUp = current.get(claim.messageId);
    if (!signUp) continue;
    if (claim.status === 'stopped') {
      reread.push(claim.messageId);
      continue;
    }
    const diffs = compareReading(next, claim, signUp);
    const items = dependents(next, claim, old);
    const cards = quotingCards(next, claim, old);
    if (!diffs.length) {
      // Only the wording changed: everything follows the new version, nothing to decide.
      const refsNow = refreshed(claimRefs(claim), current);
      next = replaceClaim(next, { ...claimFromReading(next, claim, signUp), sourceRefs: refsNow });
      const updates: SourceUpdate[] = items.map(i => ({ itemId: i.id, version: i.version, sourceRefs: refreshed(i.sourceRefs ?? claimRefs(claim), current) }));
      if (updates.length) {
        const synced = applyChange(next, { kind: 'source_sync', changeId: `sync-${claim.id}`.slice(0, 64), note: 'synced', updates }, HOMEMIND, clock);
        if (synced.ok) {
          next = synced.state;
          events.push(...synced.events);
        }
      }
      next = { ...next, actionCards: next.actionCards.map(c => (cards.some(x => x.id === c.id) ? { ...c, sourceRefs: refreshed(c.sourceRefs ?? claimRefs(claim), current) } : c)) };
      continue;
    }
    // A pending change for this claim is replaced by the new comparison (the messages moved on again).
    const previous = changesOf(next).find(c => c.claimId === claim.id && c.status === 'pending');
    const id = previous?.id ?? freeId(`src-${claim.id}`, x => changesOf(next).some(c => c.id === x));
    const change: SourceChange = {
      id,
      groupId: claim.groupId,
      claimId: claim.id,
      at: toIso(now),
      messages: old.map(r => ({ id: r.id, from: r.version, to: current.get(r.id)?.version ?? r.version })),
      status: 'pending',
      diffs,
      itemIds: items.map(i => i.id),
      cardIds: cards.map(c => c.id),
      ...(claim.eventStart ? { oldEventStart: claim.eventStart } : {}),
      ...(() => {
        const moved = diffs.find((d): d is TimeDiff => d.field === 'eventStart');
        return moved?.new ? { newEventStart: moved.new } : {};
      })(),
      whyId: `why-${id}`.slice(0, 64)
    };
    const headline = describeDiffs(diffs, zone);
    if (items.length) {
      const marked = applyChange(next, { kind: 'source_sync', changeId: id, note: 'marked', updates: items.map(i => ({ itemId: i.id, version: i.version, stale: markFor(i, change, claim, now, zone) })) }, HOMEMIND, clock);
      if (marked.ok) {
        next = marked.state;
        events.push(...marked.events);
      }
    }
    const held = { changeId: id, at: toIso(now), reason: headline.en, reasonZh: headline.zh };
    next = { ...next, actionCards: next.actionCards.map(c => (cards.some(x => x.id === c.id) ? { ...c, held } : c)) };
    const why = changeWhy(change, items.length, cards.length, headline);
    next = {
      ...next,
      sourceChanges: [...changesOf(next).filter(c => c.id !== id), change].slice(-MAX_CHANGES),
      whys: [...next.whys.filter(w => w.id !== why.id), why]
    };
    const markedItems = next.items.filter(i => change.itemIds.includes(i.id));
    alerts.push(...changeAlerts(next, change, markedItems, headline, now));
    recorded.push(change);
  }
  return { state: next, changes: recorded, events, alerts, reread, changed: next !== state };
}

// --- resolving --------------------------------------------------------------------------------------------

export type SourceAction = 'apply' | 'keep' | 'discard';

export type ResolveResult =
  | {
      ok: true;
      state: HomemindState;
      events: CoreEvent[];
      change: SourceChange;
      /** A correction (switch, or the family's name off the list) the bridge should run through the guard at level 4. */
      correctionCardId?: string;
      /** A sign-up whose claim card was withdrawn: the bridge reads it again, which prepares a new card. */
      reread?: string;
      activityId?: string;
    }
  | { ok: false; status: 403 | 404 | 409; code: string; message: string };

const isParent = (state: HomemindState, id: string) => state.family.members.some(m => m.id === id && m.role === 'parent' && m.hasAccount);

/**
 * A parent's decision on a pending source change. Parents only: Apply and Discard may post in the group,
 * which is outside the family. Every board change is one core change (`source_sync`), so one Undo brings
 * all the items back.
 */
export function resolveSourceChange(state: HomemindState, changeId: string, action: SourceAction, memberId: string, now: number, clock: Clock, adapters: AdapterRegistry): ResolveResult {
  if (!isParent(state, memberId)) return { ok: false, status: 403, code: 'forbidden', message: 'Only a parent can decide about a changed message' };
  const change = changesOf(state).find(c => c.id === changeId);
  if (!change) return { ok: false, status: 404, code: 'not_found', message: 'No such change' };
  if (change.status !== 'pending') return { ok: false, status: 409, code: 'not_pending', message: 'This change was already decided' };
  const claim = claimsOf(state).find(c => c.id === change.claimId);
  if (!claim) return { ok: false, status: 404, code: 'not_found', message: 'The sign-up is gone' };
  const unclear = change.diffs.some(d => d.field === 'unclear');
  if (action === 'apply' && unclear) return { ok: false, status: 409, code: 'unclear', message: 'The new version could not be read, so there is nothing to apply. Keep or discard' };
  const current = messagesById(state);
  const signUp = current.get(claim.messageId);
  if (!signUp) return { ok: false, status: 404, code: 'not_found', message: 'The message is gone' };

  const items = state.items.filter(i => i.stale?.changeId === change.id && live(i));
  const moved = change.diffs.find((d): d is TimeDiff => d.field === 'eventStart');
  const delta = moved ? Date.parse(moved.new ?? '') - Date.parse(moved.old ?? '') : 0;
  const updates: SourceUpdate[] = items.map(item => {
    const refs = refreshed(item.sourceRefs ?? claimRefs(claim), current);
    if (action === 'discard') return { itemId: item.id, version: item.version, cancel: true, sourceRefs: refs };
    const base: SourceUpdate = { itemId: item.id, version: item.version, stale: null, sourceRefs: refs };
    if (action === 'apply' && Number.isFinite(delta) && delta !== 0) {
      if (item.start) base.start = toIso(Date.parse(item.start) + delta);
      if (item.end) base.end = toIso(Date.parse(item.end) + delta);
    }
    return base;
  });

  let next = state;
  const events: CoreEvent[] = [];
  let activityId: string | undefined;
  if (updates.length) {
    const result = applyChange(next, { kind: 'source_sync', changeId: change.id, note: action === 'apply' ? 'applied' : action === 'keep' ? 'kept' : 'discarded', updates }, memberId, clock);
    if (!result.ok) return { ok: false, status: result.status === 409 ? 409 : result.status === 403 ? 403 : 404, code: result.code, message: result.message };
    next = result.state;
    events.push(...result.events);
    activityId = result.activity.id;
  }

  // Cards that quote the old version: Keep lets them run as they are; Apply and Discard withdraw them.
  const reason = action === 'apply' ? 'The message it quoted changed; the changes were applied' : 'The message it quoted changed; the family discarded it';
  for (const cardId of change.cardIds) {
    const card = next.actionCards.find(c => c.id === cardId);
    if (!card || card.status !== 'pending') continue;
    if (action === 'keep') {
      const { held: _h, ...rest } = card;
      next = { ...next, actionCards: next.actionCards.map(c => (c.id === cardId ? { ...rest, sourceRefs: refreshed(card.sourceRefs ?? claimRefs(claim), current) } : c)) };
    } else next = withdrawCard(next, cardId, reason, now).state;
  }

  // The claim follows the decision.
  let correctionCardId: string | undefined;
  let reread: string | undefined;
  const claimBefore = claim;
  if (action === 'keep') {
    next = replaceClaim(next, { ...claim, messageVersion: signUp.version, sourceRefs: refreshed(claimRefs(claim), current) });
  } else if (action === 'apply') {
    next = replaceClaim(next, claimFromReading(next, claim, signUp));
    if (claim.status === 'waiting') reread = claim.messageId;
    const choice = change.diffs.find((d): d is Extract<SourceDiff, { field: 'choice' }> => d.field === 'choice');
    if (claim.status === 'claimed' && choice) {
      const because = { en: `The kindergarten no longer needs ${choice.oldLabel}`, zh: `${choice.oldLabel}已不需要` };
      const fix = prepareClaimCorrection(next, claim.id, choice.switchTo ?? '', memberId, now, adapters, because);
      if (fix.ok) {
        next = fix.state;
        correctionCardId = fix.card.id;
      }
    }
  } else {
    const refsNow = refreshed(claimRefs(claim), current);
    if (claim.status === 'claimed') {
      next = replaceClaim(next, { ...claim, messageVersion: signUp.version, sourceRefs: refsNow });
      const fix = prepareClaimCorrection(next, claim.id, '', memberId, now, adapters, { en: 'The family discarded the sign-up after the message changed', zh: '消息有变，家里不再参加认领' });
      if (fix.ok) {
        next = fix.state;
        correctionCardId = fix.card.id;
      }
    } else {
      next = replaceClaim(next, { ...claim, status: 'stopped', reason: 'withdrawn', messageVersion: signUp.version, sourceRefs: refsNow });
    }
  }

  const resolved: SourceChange = {
    ...change,
    status: action === 'apply' ? 'applied' : action === 'keep' ? 'kept' : 'discarded',
    resolvedBy: memberId,
    resolvedAt: toIso(now),
    claimBefore,
    ...(activityId ? { activityId } : {}),
    ...(correctionCardId ? { correctionCardId } : {})
  };
  const { undoneAt: _u, ...clean } = resolved;
  next = { ...next, sourceChanges: changesOf(next).map(c => (c.id === change.id ? clean : c)) };
  return { ok: true, state: next, events, change: clean, ...(correctionCardId ? { correctionCardId } : {}), ...(reread ? { reread } : {}), ...(activityId ? { activityId } : {}) };
}

export type UndoResult = { ok: true; state: HomemindState; events: CoreEvent[]; change: SourceChange } | { ok: false; status: 403 | 404 | 409; code: string; message: string };

/** Why Undo is not possible now, or null. A post already made in the simulated group can't be taken back. */
function undoBlock(state: HomemindState, change: SourceChange): string | null {
  if (change.status === 'pending') return 'Nothing was decided yet';
  if (change.correctionCardId) {
    const card = state.actionCards.find(c => c.id === change.correctionCardId);
    if (card && (card.status === 'executed' || card.status === 'executing')) return 'A correction was already posted in the simulated group, and it cannot be taken back. Use Change instead';
  }
  const claim = claimsOf(state).find(c => c.id === change.claimId);
  if (claim && claim.cardId && claim.cardId !== change.claimBefore?.cardId) {
    const card = state.actionCards.find(c => c.id === claim.cardId);
    if (card && (card.status === 'executed' || card.status === 'executing')) return 'The new claim was already posted in the simulated group, and it cannot be taken back';
  }
  return null;
}

/**
 * Undo of a decision: the items as they were (stale again), the claim as it was, the change pending again,
 * and cards Keep had released held again. A correction card that was only prepared is withdrawn.
 */
export function undoSourceChange(state: HomemindState, changeId: string, memberId: string, now: number, clock: Clock): UndoResult {
  if (!isParent(state, memberId)) return { ok: false, status: 403, code: 'forbidden', message: 'Only a parent can undo this' };
  const change = changesOf(state).find(c => c.id === changeId);
  if (!change) return { ok: false, status: 404, code: 'not_found', message: 'No such change' };
  const blocked = undoBlock(state, change);
  if (blocked) return { ok: false, status: 409, code: change.status === 'pending' ? 'not_resolved' : 'posted', message: blocked };
  let next = state;
  const events: CoreEvent[] = [];
  if (change.activityId) {
    const undone = applyChange(next, { kind: 'undo', activityId: change.activityId, viaSource: true }, memberId, clock);
    if (!undone.ok) return { ok: false, status: undone.status === 403 ? 403 : undone.status === 404 ? 404 : 409, code: undone.code, message: undone.message };
    next = undone.state;
    events.push(...undone.events);
  }
  if (change.correctionCardId) next = withdrawCard(next, change.correctionCardId, 'The decision about the changed message was undone', now).state;
  const claim = claimsOf(next).find(c => c.id === change.claimId);
  if (claim && claim.cardId && claim.cardId !== change.claimBefore?.cardId) next = withdrawCard(next, claim.cardId, 'The decision about the changed message was undone', now).state;
  if (change.claimBefore) next = replaceClaim(next, change.claimBefore);
  // Cards Keep released are held again (Apply and Discard withdrew theirs, and a withdrawn card stays so).
  const held = { changeId: change.id, at: toIso(now), ...describeHeld(change, next.family.timezone) };
  next = { ...next, actionCards: next.actionCards.map(c => (change.cardIds.includes(c.id) && c.status === 'pending' ? { ...c, held } : c)) };
  const { resolvedBy: _b, resolvedAt: _a, activityId: _i, correctionCardId: _c, claimBefore: _p, ...rest } = change;
  const reopened: SourceChange = { ...rest, status: 'pending', undoneAt: toIso(now) };
  next = { ...next, sourceChanges: changesOf(next).map(c => (c.id === change.id ? reopened : c)) };
  return { ok: true, state: next, events, change: reopened };
}

function describeHeld(change: SourceChange, zone: string): { reason: string; reasonZh: string } {
  const text = describeDiffs(change.diffs, zone);
  return { reason: text.en, reasonZh: text.zh };
}

// --- what screens show ------------------------------------------------------------------------------------

/**
 * Pending changes, and decisions from the last 12 hours (for Undo), as one member's screen shows them:
 * only items that member can see. A change with no item the member can see is not shown to them at all,
 * so a Parents-only event leaves no trace.
 */
export function sourceChangesView(state: HomemindState, memberId: string, now: number): SourceChangeView[] {
  const out: SourceChangeView[] = [];
  for (const change of [...changesOf(state)].reverse()) {
    const recent = change.status === 'pending' || now - Date.parse(change.resolvedAt ?? change.at) < RECENT_MS;
    if (!recent) continue;
    const all = change.itemIds.map(id => state.items.find(i => i.id === id)).filter((i): i is Item => !!i);
    const visible = all.filter(i => canSeeItem(state, memberId, i));
    if (all.length && !visible.length) continue;
    const claim = claimsOf(state).find(c => c.id === change.claimId);
    const group = groups.find(g => g.id === change.groupId);
    const event = visible.find(i => i.type === 'event');
    out.push({
      change,
      groupName: group?.name ?? change.groupId,
      groupNameZh: group?.nameZh ?? change.groupId,
      ...(event ? { eventTitle: event.title, ...(event.titleZh ? { eventTitleZh: event.titleZh } : {}) } : claim?.eventTitle ? { eventTitle: claim.eventTitle, ...(claim.eventTitleZh ? { eventTitleZh: claim.eventTitleZh } : {}) } : {}),
      items: visible.map(i => ({ id: i.id, title: i.title, ...(i.titleZh ? { titleZh: i.titleZh } : {}), ...(i.stale ? { stale: i.stale } : {}) })),
      undoable: change.status !== 'pending' && !undoBlock(state, change),
      canApply: change.status === 'pending' && !change.diffs.some(d => d.field === 'unclear')
    });
  }
  return out.slice(0, 5);
}
