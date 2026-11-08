/**
 * What Homemind tells PPMA, and what PPMA's commands do (T6.1). Pure: no network, no clock of its own.
 *
 * Privacy: only what everyone in the family may see goes to PPMA. "Parents only" items (and
 * preparations under them) are never sent in this version; an item that becomes Parents-only is
 * reported as `hidden` with nothing about it but its id. A sensitive item goes without title or notes.
 *
 * Commands: `homemind.get_board` reads the family-wide board. The proposal tools are T6.2; until then
 * they are answered `rejected` with a plain reason, so every command still gets its one outcome.
 */
import type { CoreEvent } from './core';
import type { CommandOutcome, PpmaCommand } from './ppma';
import type { HomemindState, Item, Preference } from './types';
import { isFamilyWide } from './visibility';

export interface PpmaReport {
  type: string;
  payload: Record<string, unknown>;
}

const TEXT_MAX = 500;
const cap = (text: string | undefined, max = TEXT_MAX) => (text ? text.slice(0, max) : undefined);
const nameOf = (state: HomemindState, id: string | undefined) => (id ? state.family.members.find(m => m.id === id)?.name : undefined);

/** Drops `undefined` fields, so the payload is plain JSON. */
function clean(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/** An item as PPMA sees it. Call only for a family-wide item. */
export function itemPayload(state: HomemindState, item: Item): Record<string, unknown> {
  const own = item.ownership;
  return clean({
    item_id: item.id,
    item_type: item.type,
    title: item.sensitive ? undefined : cap(item.title, 200),
    title_zh: item.sensitive ? undefined : cap(item.titleZh, 200),
    notes: item.sensitive ? undefined : cap(item.notes),
    sensitive: item.sensitive || undefined,
    start: item.start,
    end: item.end,
    all_day: item.allDay || undefined,
    weekly: item.recurrence ? item.recurrence.byWeekday : undefined,
    status: item.status,
    importance: item.importance,
    ownership: own.state,
    owner_id: own.state === 'assigned' ? own.ownerId : undefined,
    owner_name: own.state === 'assigned' ? nameOf(state, own.ownerId) : undefined,
    owner_confirmed: own.state === 'assigned' ? own.confirmed : undefined,
    candidate_ids: own.state === 'open' && own.candidateIds.length ? own.candidateIds : undefined,
    for_member_ids: item.forMemberIds.length ? item.forMemberIds : undefined,
    unavailable_member_ids: item.unavailableMemberIds.length ? item.unavailableMemberIds : undefined,
    parent_event_id: item.parentEventId,
    source: item.source.kind,
    version: item.version
  });
}

/** Whether an event's "away" part is unchanged (same time, status and people). */
const sameAway = (a: Item | undefined, b: Item) =>
  !!a && a.start === b.start && a.end === b.end && a.status === b.status && a.unavailableMemberIds.join(',') === b.unavailableMemberIds.join(',');

/**
 * Reports for one committed change: `homemind.item_changed` per touched item PPMA may know about, and
 * `homemind.member_unavailable` when a family-wide event newly makes someone unavailable.
 */
export function reportsForChange(before: HomemindState, after: HomemindState, events: readonly CoreEvent[], actorId?: string): PpmaReport[] {
  const reports: PpmaReport[] = [];
  const actor = actorId ? { actor_id: actorId, actor_name: nameOf(after, actorId) } : {};
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'item.changed' || seen.has(event.itemId)) continue;
    seen.add(event.itemId);
    const old = before.items.find(i => i.id === event.itemId);
    const now = after.items.find(i => i.id === event.itemId);
    const wasShared = !!old && isFamilyWide(before, old);
    const isShared = !!now && isFamilyWide(after, now);
    if (now && isShared) {
      reports.push({ type: 'homemind.item_changed', payload: clean({ ...itemPayload(after, now), change: old && wasShared ? 'changed' : 'created', ...actor }) });
      if (now.type === 'event' && now.status === 'open' && now.unavailableMemberIds.length && !(wasShared && sameAway(old, now))) {
        for (const memberId of now.unavailableMemberIds) {
          reports.push({
            type: 'homemind.member_unavailable',
            payload: clean({ member_id: memberId, member_name: nameOf(after, memberId), event_id: now.id, title: now.sensitive ? undefined : cap(now.title, 200), from: now.start, to: now.end, all_day: now.allDay || undefined })
          });
        }
      }
    } else if (wasShared) {
      // Gone, or now Parents-only: PPMA learns only that it left the family board.
      reports.push({ type: 'homemind.item_changed', payload: clean({ item_id: event.itemId, change: now ? 'hidden' : 'removed', ...actor }) });
    }
  }
  return reports;
}

/** `homemind.preference_stated` for a saved, corrected, removed or undone preference. */
export function preferenceReport(state: HomemindState, change: 'added' | 'corrected' | 'removed' | 'undone', preferenceId: string, preference: Preference | null, actorId: string): PpmaReport {
  return {
    type: 'homemind.preference_stated',
    payload: clean({
      preference_id: preferenceId,
      change: preference ? change : 'removed',
      about_member_id: preference?.aboutMemberId,
      about_member_name: nameOf(state, preference?.aboutMemberId),
      text: cap(preference?.text),
      reason: cap(preference?.reason),
      strength: preference?.strength,
      scope: preference?.scope,
      actor_id: actorId,
      actor_name: nameOf(state, actorId)
    })
  };
}

/** `homemind.reminder_outcome` for "Got it" or "Remind me later", only about a family-wide item. */
export function reminderReport(state: HomemindState, reminderId: string, itemId: string, response: 'ack' | 'snooze', memberId: string): PpmaReport | null {
  const item = state.items.find(i => i.id === itemId);
  if (!item || !isFamilyWide(state, item)) return null;
  return { type: 'homemind.reminder_outcome', payload: { reminder_id: reminderId, item_id: itemId, response: response === 'ack' ? 'got_it' : 'remind_later', member_id: memberId } };
}

// --- commands -----------------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
export const BOARD_LIMITS = { backMs: 2 * DAY, aheadMs: 45 * DAY, items: 60 } as const;

/** The family-wide board for `homemind.get_board`: open and proposed items near now, plus undated and weekly ones. */
export function boardForPpma(state: HomemindState, nowMs: number): Record<string, unknown> {
  const items = state.items
    .filter(i => (i.status === 'open' || i.status === 'proposed') && isFamilyWide(state, i))
    .filter(i => {
      if (i.recurrence || !i.start) return true;
      const t = Date.parse(i.end ?? i.start);
      return t >= nowMs - BOARD_LIMITS.backMs && Date.parse(i.start) <= nowMs + BOARD_LIMITS.aheadMs;
    })
    .slice(0, BOARD_LIMITS.items)
    .map(i => itemPayload(state, i));
  return {
    now: new Date(nowMs).toISOString(),
    timezone: state.family.timezone,
    members: state.family.members.map(m => clean({ id: m.id, name: m.name, role: m.role, age: m.age })),
    items
  };
}

const PROPOSAL_TOOLS = new Set(['homemind.propose_item', 'homemind.propose_preparation', 'homemind.add_to_shopping']);

/**
 * What a PPMA command does to Homemind. Returns the outcome and, when the board changed, the new state.
 * `nowMs` is the board's (demo) time.
 */
export function handlePpmaCommand(state: HomemindState, command: PpmaCommand, nowMs: number): { outcome: CommandOutcome; state?: HomemindState } {
  if (command.type === 'homemind.get_board') {
    return { outcome: { status: 'executed', path: 'auto', result: boardForPpma(state, nowMs) } };
  }
  if (PROPOSAL_TOOLS.has(command.type)) {
    return { outcome: { status: 'rejected', path: 'auto', detail: 'Homemind does not take proposals from PPMA yet' } };
  }
  if (command.type.startsWith('ui.')) {
    return { outcome: { status: 'rejected', path: 'auto', detail: 'Homemind does not show PPMA notifications in this version' } };
  }
  if (command.type === 'policy.set_threshold') {
    // Homemind's own rule: PPMA only proposes; a parent approves every proposal.
    return { outcome: { status: 'rejected', path: 'auto', detail: 'Homemind keeps its own approval rules' } };
  }
  return { outcome: { status: 'rejected', path: 'auto', detail: `Homemind has no command ${command.type.slice(0, 80)}` } };
}
