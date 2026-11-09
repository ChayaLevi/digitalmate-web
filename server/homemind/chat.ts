/**
 * Chat (T5.2): what a validated `ChatIntent` does to the board.
 *
 * `planChat` turns one intent into one plan, from the member's own view only:
 *   answer   a question: the model's answer and the rows it is about
 *   write    one core change for the bridge to apply (it has Undo, like every family item write)
 *   suggest  autonomy level 1, or paused: nothing changes, the member gets a button that does it
 *   why      Homemind's own record of an item: who added it, how, who has it, the last change
 *   preference  save a preference (T5.4); at level 1 or paused, a card with a Save button instead
 *   blocked  a preparation or task that a hard preference rules out (T5.4): nothing changes
 *   situation  someone is sick (T8.1): the bridge runs situations.ts (who stays home, what to change)
 *   later    an intent whose task is not built yet (rules from chat; situations other than "sick")
 *   missing  the item is no longer on the member's board (changed while the model was thinking)
 *
 * Autonomy (CLAUDE.md): at level 2 and up, the family item writes a member asks for apply at once,
 * with Undo. At level 1, or while paused, a create becomes a `proposed` item (a suggestion to
 * approve) and a verb becomes a button. Nothing here sends, orders or pays, and nothing assigns work
 * to someone unless the member asked for exactly that.
 *
 * Pure: no network, no clock reads ("now" is passed in), no imports from src/.
 */
import { addDays, localParts, zonedToUtc } from './clock';
import type { Change, NewItem } from './core';
import type { ChatIntent, IntentName } from './intents';
import type { MemberView } from './visibility';
import { blockedChange, parsePreferenceInput } from './preferences';
import type { BlockedChoice, PreferenceInput } from './preferences';
import type { Family, ItemExplanation, ItemSource } from './types';

/** A timed event the model gave no end for lasts this long. */
export const DEFAULT_EVENT_MINUTES = 60;

export type WriteIntent = 'create_event' | 'create_task' | 'add_preparation' | 'assign' | 'claim' | 'mark_done';
export type LaterIntent = 'create_rule' | 'report_situation';

export type ChatPlan =
  | { kind: 'answer'; answer: string; itemIds: string[] }
  | { kind: 'write'; intent: WriteIntent; change: Change; proposed: boolean }
  | { kind: 'suggest'; intent: 'assign' | 'claim' | 'mark_done'; itemId: string; verb: 'assign' | 'claim' | 'done'; memberId?: string; reason: 'level1' | 'paused' }
  | { kind: 'why'; explanation: ItemExplanation }
  /** `save: false`: level 1 or paused, so the member gets a Save button instead. */
  | { kind: 'preference'; input: PreferenceInput; save: boolean; reason?: 'level1' | 'paused' }
  | { kind: 'blocked'; intent: 'create_task' | 'add_preparation'; title: string; blocked: BlockedChoice[] }
  | { kind: 'later'; intent: LaterIntent; task: 'T7.3' | 'T8.1' }
  /** T8.1: who is sick and which day; the bridge plans the rest with fixed rules (situations.ts). */
  | { kind: 'situation'; memberId: string; date: string; summary: string }
  | { kind: 'missing'; intent: IntentName };

/** Whether chat may change the board on its own (level 2 and up, not paused). */
export function chatMayWrite(family: Family): boolean {
  return !family.paused && family.autonomy.default >= 2;
}

/** The source of an item a member asked for in chat. */
export const chatSource = (name: string): ItemSource => ({ kind: 'chat', label: name });

export function planChat(view: MemberView, intent: ChatIntent): ChatPlan {
  const me = view.family.members.find(m => m.id === view.memberId);
  const name = me?.name ?? view.memberId;
  const mayWrite = chatMayWrite(view.family);
  const reason = view.family.paused ? 'paused' : 'level1';
  const find = (id: string) => view.items.find(i => i.id === id && (i.status === 'open' || i.status === 'proposed'));

  switch (intent.intent) {
    case 'ask':
      // Only rows the member can still see.
      return { kind: 'answer', answer: intent.answer, itemIds: intent.itemIds.filter(id => find(id)) };

    case 'create_event': {
      const item: NewItem = {
        type: 'event',
        title: intent.title,
        ...eventTimes(intent.start, intent.end, intent.allDay, view.family.timezone),
        forMemberIds: intent.forMemberIds,
        // A child is never "away"; only parents and teens are asked to cover things.
        unavailableMemberIds: intent.unavailableMemberIds.filter(id => view.family.members.find(m => m.id === id)?.role !== 'child'),
        visibility: intent.visibility,
        importance: intent.importance,
        source: chatSource(name),
        ...(mayWrite ? {} : { proposed: true })
      };
      return { kind: 'write', intent: 'create_event', change: { kind: 'create', item }, proposed: !mayWrite };
    }

    case 'create_task': {
      const item: NewItem = {
        type: 'task',
        title: intent.title,
        ...(intent.due ? { start: intent.due } : {}),
        forMemberIds: intent.forMemberIds,
        // The member named the owner; it stays unconfirmed until that person says "I'm on it".
        ...(intent.ownerId ? { ownership: { state: 'assigned' as const, ownerId: intent.ownerId, confirmed: intent.ownerId === view.memberId } } : {}),
        source: chatSource(name),
        ...(mayWrite ? {} : { proposed: true })
      };
      const blocked = blockedChange(view, { kind: 'create', item });
      if (blocked.length) return { kind: 'blocked', intent: 'create_task', title: item.title, blocked };
      return { kind: 'write', intent: 'create_task', change: { kind: 'create', item }, proposed: !mayWrite };
    }

    case 'add_preparation': {
      if (!find(intent.eventId)) return { kind: 'missing', intent: intent.intent };
      const item: NewItem = {
        type: 'preparation',
        parentEventId: intent.eventId,
        title: intent.title,
        ...(intent.due ? { start: intent.due } : {}),
        forMemberIds: [],
        source: chatSource(name),
        ...(mayWrite ? {} : { proposed: true })
      };
      const blocked = blockedChange(view, { kind: 'create', item });
      if (blocked.length) return { kind: 'blocked', intent: 'add_preparation', title: item.title, blocked };
      return { kind: 'write', intent: 'add_preparation', change: { kind: 'create', item }, proposed: !mayWrite };
    }

    case 'assign': {
      const item = find(intent.itemId);
      if (!item) return { kind: 'missing', intent: intent.intent };
      if (!mayWrite) return { kind: 'suggest', intent: 'assign', itemId: item.id, verb: 'assign', memberId: intent.memberId, reason };
      return { kind: 'write', intent: 'assign', change: { kind: 'assign', itemId: item.id, version: item.version, ownerId: intent.memberId }, proposed: false };
    }

    case 'claim': {
      const item = find(intent.itemId);
      if (!item) return { kind: 'missing', intent: intent.intent };
      // "I'll take it" on something someone else has is a reassignment to yourself, as on the board.
      const taken = item.ownership.state === 'assigned' && item.ownership.ownerId !== view.memberId;
      if (!mayWrite) return { kind: 'suggest', intent: 'claim', itemId: item.id, ...(taken ? { verb: 'assign', memberId: view.memberId } : { verb: 'claim' }), reason };
      const change: Change = taken ? { kind: 'assign', itemId: item.id, version: item.version, ownerId: view.memberId } : { kind: 'claim', itemId: item.id, version: item.version };
      return { kind: 'write', intent: 'claim', change, proposed: false };
    }

    case 'mark_done': {
      const item = find(intent.itemId);
      if (!item) return { kind: 'missing', intent: intent.intent };
      if (!mayWrite) return { kind: 'suggest', intent: 'mark_done', itemId: item.id, verb: 'done', reason };
      return { kind: 'write', intent: 'mark_done', change: { kind: 'done', itemId: item.id, version: item.version }, proposed: false };
    }

    case 'why': {
      const explanation = explainItem(view, intent.itemId);
      return explanation ? { kind: 'why', explanation } : { kind: 'missing', intent: intent.intent };
    }

    case 'add_preference': {
      // Checked again with the request rules (the intent validator is close, not the same).
      const parsed = parsePreferenceInput({ ...intent }, view.family.members);
      if (!parsed.ok) return { kind: 'missing', intent: intent.intent };
      return mayWrite ? { kind: 'preference', input: parsed.value, save: true } : { kind: 'preference', input: parsed.value, save: false, reason };
    }
    case 'create_rule':
      return { kind: 'later', intent: 'create_rule', task: 'T7.3' };
    case 'report_situation': {
      // Only "sick" is built. "Noa is sick" names Noa; "I'm sick" names nobody, so it is the member who said it.
      if (intent.situation !== 'sick') return { kind: 'later', intent: 'report_situation', task: 'T8.1' };
      const memberId = intent.memberId && view.family.members.some(m => m.id === intent.memberId) ? intent.memberId : view.memberId;
      return { kind: 'situation', memberId, date: intent.date, summary: intent.summary };
    }
  }
}

/**
 * Start and end as the board stores them. All day: local midnight to the next local midnight (as the
 * Add form does; "away" needs an end). Timed with no end: `DEFAULT_EVENT_MINUTES`.
 */
export function eventTimes(start: string, end: string | undefined, allDay: boolean, timezone: string): { start: string; end: string; allDay: boolean } {
  const startMs = Date.parse(start);
  if (allDay) {
    const date = localParts(startMs, timezone).date;
    const endDate = end ? localParts(Date.parse(end) - 1, timezone).date : date;
    const lastDate = endDate < date ? date : endDate;
    return { start: new Date(zonedToUtc(date, '00:00', timezone)).toISOString(), end: new Date(zonedToUtc(addDays(lastDate, 1), '00:00', timezone)).toISOString(), allDay: true };
  }
  return { start, end: end ?? new Date(startMs + DEFAULT_EVENT_MINUTES * 60_000).toISOString(), allDay: false };
}

/**
 * Homemind's own record of why an item is on the board, from the member's view (so a teen learns
 * nothing about a Parents-only event). A `Why` record that names the item is included with its source;
 * otherwise the board record (source, creator, owner, last change) is the whole answer, and it says so.
 */
export function explainItem(view: MemberView, itemId: string): ItemExplanation | null {
  const item = view.items.find(i => i.id === itemId);
  if (!item) return null;
  const history = view.activity.filter(a => a.itemId === itemId && !a.undone);
  const created = history.find(a => a.kind === 'create');
  const last = [...history].reverse().find(a => a.kind !== 'create');
  const why = view.whys.find(w => w.basis.some(b => b.ref === itemId));
  return {
    itemId,
    source: item.source,
    createdBy: item.createdBy,
    ...(created ? { createdAt: created.at } : {}),
    ...(last ? { lastActivityId: last.id } : {}),
    ...(why ? { why } : {})
  };
}
