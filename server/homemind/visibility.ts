/**
 * Per-member filtering. Everything a member is shown, searched over, streamed or sent to the model
 * goes through here first (CLAUDE.md: "Parents only" is enforced on the server).
 *
 * A non-parent gets no trace of a "Parents only" item: not the item, not its preparations, not its
 * activity, reminders or "Why?" records, not an SSE event about it, and not a reason on another item
 * that names it. Pure: no I/O.
 */
import { canSee } from './core';
import type { CoreEvent } from './core';
import type { Activity, ActionCard, Family, HomemindState, Item, Preference, Reminder, Rule, Why } from './types';

export { canSee };

function isParent(state: HomemindState, memberId: string): boolean {
  return state.family.members.some(m => m.id === memberId && m.role === 'parent');
}

/** `canSee`, and also the item's event, so a preparation can never give its event away. */
export function canSeeItem(state: HomemindState, memberId: string, item: Item): boolean {
  if (!canSee(state, memberId, item)) return false;
  if (!item.parentEventId) return true;
  const parent = state.items.find(i => i.id === item.parentEventId);
  return !parent || canSee(state, memberId, parent);
}

function canSeeId(state: HomemindState, memberId: string, itemId: string): boolean {
  const item = state.items.find(i => i.id === itemId);
  // An item that no longer exists (an undone create) may have been Parents-only: only parents.
  return item ? canSeeItem(state, memberId, item) : isParent(state, memberId);
}

/** The item as `memberId` may see it: an "unavailable" reason is dropped if its event is hidden. */
export function redactItem(state: HomemindState, memberId: string, item: Item): Item {
  const { ownership } = item;
  if (ownership.state !== 'open' || !ownership.reason || canSeeId(state, memberId, ownership.reason.eventId)) return item;
  const { reason: _hidden, ...rest } = ownership;
  return { ...item, ownership: rest };
}

/**
 * Items, PPMA and anything else outside the family's own screens: only what everyone in the family
 * may see. "Parents only" items are not sent to PPMA in this version.
 */
export function isFamilyWide(state: HomemindState, item: Item): boolean {
  if (item.visibility !== 'family') return false;
  const parent = item.parentEventId ? state.items.find(i => i.id === item.parentEventId) : undefined;
  return !parent || parent.visibility === 'family';
}

export function visibleItems(state: HomemindState, memberId: string): Item[] {
  return state.items.filter(item => canSeeItem(state, memberId, item)).map(item => redactItem(state, memberId, item));
}

/** What one member may know. The base for every screen, search, SSE event and model context. */
export interface MemberView {
  memberId: string;
  family: Family;
  items: Item[];
  reminders: Reminder[];
  preferences: Preference[];
  rules: Rule[];
  actionCards: ActionCard[];
  /** Without Undo patches: those hold whole earlier versions of items, and stay on the server. */
  activity: Activity[];
  whys: Why[];
}

/** The view for `memberId`, or `null` for an unknown member. */
export function viewFor(state: HomemindState, memberId: string): MemberView | null {
  if (!state.family.members.some(m => m.id === memberId)) return null;
  const hiddenIds = new Set(state.items.filter(item => !canSeeItem(state, memberId, item)).map(item => item.id));
  return {
    memberId,
    family: state.family,
    items: visibleItems(state, memberId),
    reminders: state.reminders.filter(r => canSeeId(state, memberId, r.itemId)),
    preferences: state.preferences,
    rules: state.rules,
    actionCards: state.actionCards,
    activity: state.activity
      .filter(a => (a.itemId ? canSeeId(state, memberId, a.itemId) : isParent(state, memberId)))
      .map(({ undo: _patch, ...rest }) => rest),
    whys: state.whys.filter(w => !w.basis.some(b => b.ref !== undefined && hiddenIds.has(b.ref)))
  };
}

/**
 * The event as `memberId` should get it, or `null` to send nothing. `state` is the state after the
 * change. When an item leaves a member's view (it became Parents-only, or was removed by an undo),
 * they get `item: null`, as for a deletion, and nothing about what it became.
 */
export function eventFor(state: HomemindState, memberId: string, event: CoreEvent): CoreEvent | null {
  if (event.type !== 'item.changed') return null;
  if (event.item && canSeeItem(state, memberId, event.item)) {
    return { type: 'item.changed', itemId: event.itemId, item: redactItem(state, memberId, event.item) };
  }
  // Parents see every item, so for them this is a removal. Anyone else saw it only if it was
  // family-wide before the change (`previousVisibility` is set whenever visibility changed).
  const sawItBefore = isParent(state, memberId) || event.previousVisibility === 'family';
  return sawItBefore ? { type: 'item.changed', itemId: event.itemId, item: null } : null;
}

export const SEARCH_LIMITS = { query: 100, results: 50 } as const;

/**
 * Items whose title (either language) or notes contain `query`, ignoring case, from what `memberId`
 * may see. Removed items are left out. In board order, at most `SEARCH_LIMITS.results`.
 */
export function searchItems(state: HomemindState, memberId: string, query: string): Item[] {
  const needle = typeof query === 'string' ? query.trim().slice(0, SEARCH_LIMITS.query).toLocaleLowerCase() : '';
  if (!needle) return [];
  return visibleItems(state, memberId)
    .filter(item => item.status !== 'cancelled')
    .filter(item => [item.title, item.titleZh, item.notes].some(text => text?.toLocaleLowerCase().includes(needle)))
    .slice(0, SEARCH_LIMITS.results);
}
