/**
 * Availability: an event's `unavailableMemberIds` against the items those members own at that time.
 *
 * `findConflicts` only detects. `proposeForConflicts` turns each conflict into an `open` item ("Mom is
 * at the wedding on Tuesday. Who takes pickup?") through `applyChange`, so it has a version, an
 * activity entry and Undo. It never assigns anyone: the family picks. Run it when an event that makes
 * someone unavailable is created or edited, not on every change, so an owner who keeps the item
 * anyway is not asked again. Pure: no I/O.
 */
import type { Clock } from './clock';
import { applyChange, eligibleOwners, occurrences } from './core';
import type { Activity, Family, HomemindState, Item, OpenReason } from './types';
import type { ChangeError, CoreEvent, NewItem } from './core';
import { canSeeItem } from './visibility';

export interface Conflict {
  /** The owner who is unavailable. */
  memberId: string;
  /** The event that makes them unavailable. */
  eventId: string;
  /** The item they own at that time. */
  itemId: string;
  /** Local date of the item's clashing occurrence. */
  date: string;
  /** The item's occurrence. */
  start: string;
  end?: string;
  /** A weekly item: only this occurrence is opened. */
  recurring: boolean;
}

export interface ConflictFilter {
  /** Only conflicts caused by this event. */
  eventId?: string;
  /** Only conflicts on this item. */
  itemId?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** Events that make someone unavailable and are on the board (not proposed, done or removed). */
function unavailabilityEvents(state: HomemindState): Item[] {
  return state.items.filter(i => i.type === 'event' && i.status === 'open' && i.unavailableMemberIds.length > 0 && i.start && i.end);
}

function durationOf(item: Item): number {
  return item.start && item.end ? Date.parse(item.end) - Date.parse(item.start) : 0;
}

/** Half-open overlap. An item with no end counts as the instant it starts. */
function overlaps(start: number, end: number | undefined, otherStart: number, otherEnd: number): boolean {
  return end !== undefined && end > start ? start < otherEnd && end > otherStart : start >= otherStart && start < otherEnd;
}

/** Items someone owns at a fixed time, which an unavailability can clash with. */
function isTimedOwnedItem(item: Item): boolean {
  return item.status === 'open' && !!item.start && !item.allDay && item.ownership.state === 'assigned';
}

/**
 * Conflicts whose clash is at least partly in `[fromMs, toMs)`: an item assigned to a member while an
 * event makes that member unavailable. Unconfirmed assignments count. All-day items, the event itself,
 * its preparations, and the member's own unavailability events (two weddings) are not conflicts.
 * Sorted by time.
 */
export function findConflicts(state: HomemindState, fromMs: number, toMs: number, filter: ConflictFilter = {}): Conflict[] {
  const timezone = state.family.timezone;
  const events = unavailabilityEvents(state).filter(e => !filter.eventId || e.id === filter.eventId);
  const items = state.items.filter(i => isTimedOwnedItem(i) && (!filter.itemId || i.id === filter.itemId));
  const out: Conflict[] = [];
  for (const event of events) {
    for (const eventOcc of occurrences(event, fromMs - durationOf(event), toMs, timezone)) {
      const eventStart = Date.parse(eventOcc.start);
      const eventEnd = Date.parse(eventOcc.end as string);
      for (const item of items) {
        if (item.id === event.id || item.parentEventId === event.id || item.ownership.state !== 'assigned') continue;
        const ownerId = item.ownership.ownerId;
        if (!event.unavailableMemberIds.includes(ownerId) || item.unavailableMemberIds.includes(ownerId)) continue;
        for (const occ of occurrences(item, eventStart - durationOf(item) - 1, eventEnd, timezone)) {
          const start = Date.parse(occ.start);
          const end = occ.end === undefined ? undefined : Date.parse(occ.end);
          if (!overlaps(start, end, eventStart, eventEnd)) continue;
          // Keep only clashes that reach into the window.
          const clashStart = Math.max(start, eventStart);
          const clashEnd = Math.min(end !== undefined && end > start ? end : start + 1, eventEnd);
          if (clashEnd <= fromMs || clashStart >= toMs) continue;
          const conflict: Conflict = { memberId: ownerId, eventId: event.id, itemId: item.id, date: occ.date, start: occ.start, recurring: !!item.recurrence };
          if (occ.end) conflict.end = occ.end;
          out.push(conflict);
        }
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.itemId.localeCompare(b.itemId) || a.eventId.localeCompare(b.eventId));
}

/** The conflicts `memberId` may know about: both the item and the event must be visible to them. */
export function conflictsVisibleTo(state: HomemindState, memberId: string, conflicts: Conflict[]): Conflict[] {
  const visible = (id: string) => {
    const item = state.items.find(i => i.id === id);
    return !!item && canSeeItem(state, memberId, item);
  };
  return conflicts.filter(c => visible(c.itemId) && visible(c.eventId));
}

export interface Unavailability {
  memberId: string;
  eventId: string;
  /** Local date the occurrence starts on. */
  date: string;
  start: string;
  end: string;
}

/**
 * Who is unavailable when, in `[fromMs, toMs)`, for `memberId`'s summary. Comes only from events
 * `memberId` may see, so a Parents-only event leaves no trace in a teen's summary.
 */
export function unavailabilityFor(state: HomemindState, memberId: string, fromMs: number, toMs: number): Unavailability[] {
  const out: Unavailability[] = [];
  for (const event of unavailabilityEvents(state)) {
    if (!canSeeItem(state, memberId, event)) continue;
    for (const occ of occurrences(event, fromMs - durationOf(event), toMs, state.family.timezone)) {
      if (Date.parse(occ.end as string) <= fromMs) continue;
      for (const id of event.unavailableMemberIds) out.push({ memberId: id, eventId: event.id, date: occ.date, start: occ.start, end: occ.end as string });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.memberId.localeCompare(b.memberId));
}

/** Members unavailable at some point in `[startMs, endMs)` (an instant when `endMs` is absent). */
export function unavailableDuring(state: HomemindState, startMs: number, endMs?: number): string[] {
  const busy = new Set<string>();
  for (const event of unavailabilityEvents(state)) {
    for (const occ of occurrences(event, startMs - durationOf(event) - DAY, (endMs ?? startMs) + DAY, state.family.timezone)) {
      if (overlaps(startMs, endMs, Date.parse(occ.start), Date.parse(occ.end as string))) {
        for (const id of event.unavailableMemberIds) busy.add(id);
      }
    }
  }
  return [...busy].sort();
}

/**
 * Whether Homemind may open items on its own: not when the family pressed stop, and not at autonomy
 * level 1 (Suggests), where the bridge shows the conflicts as suggestions instead.
 */
export function mayOpenOnItsOwn(family: Family): boolean {
  return !family.paused && family.autonomy.default >= 2;
}

export interface ProposalSuccess {
  ok: true;
  state: HomemindState;
  /** One per change, in order. Each can be undone on its own. */
  activities: Activity[];
  events: CoreEvent[];
  /** The ids of the items now open: the item itself, or the one-off copy of a weekly occurrence. */
  openedItemIds: string[];
}

/**
 * Opens each conflicting item for someone else to take, as `actor` (whoever made the change that
 * caused it). Candidates are those who could own it and are free then; if nobody is, everyone else
 * who could own it. For a weekly item only that occurrence moves: it is cancelled in the series and a
 * one-off copy is opened. Conflicts on the same item and date are handled once. All or nothing: on
 * any error, nothing is applied and the error is returned.
 */
export function proposeForConflicts(state: HomemindState, conflicts: Conflict[], actor: string, clock: Clock): ProposalSuccess | ChangeError {
  let current = state;
  const activities: Activity[] = [];
  const events: CoreEvent[] = [];
  const openedItemIds: string[] = [];
  const done = new Set<string>();

  for (const conflict of conflicts) {
    const key = `${conflict.itemId}|${conflict.date}`;
    if (done.has(key)) continue;
    done.add(key);
    const item = current.items.find(i => i.id === conflict.itemId);
    if (!item) continue;
    const reason: OpenReason = { kind: 'unavailable', memberId: conflict.memberId, eventId: conflict.eventId, date: conflict.date };
    const candidateIds = candidatesFor(current, item, conflict);

    const steps = conflict.recurring ? splitOccurrence(current, item, conflict, reason, candidateIds, actor, clock) : openItem(current, item, reason, candidateIds, actor, clock);
    if (!steps.ok) return steps;
    current = steps.state;
    activities.push(...steps.activities);
    events.push(...steps.events);
    openedItemIds.push(steps.openedItemId);
  }
  return { ok: true, state: current, activities, events, openedItemIds };
}

function candidatesFor(state: HomemindState, item: Item, conflict: Conflict): string[] | undefined {
  const others = eligibleOwners(state, item).filter(id => id !== conflict.memberId);
  const busy = unavailableDuring(state, Date.parse(conflict.start), conflict.end ? Date.parse(conflict.end) : undefined);
  const free = others.filter(id => !busy.includes(id));
  if (free.length) return free;
  // Leaving it undefined lets the core offer it to everyone who could own it.
  return others.length ? others : undefined;
}

type Steps = { ok: true; state: HomemindState; activities: Activity[]; events: CoreEvent[]; openedItemId: string } | ChangeError;

function openItem(state: HomemindState, item: Item, reason: OpenReason, candidateIds: string[] | undefined, actor: string, clock: Clock): Steps {
  const result = applyChange(state, { kind: 'open', itemId: item.id, version: item.version, candidateIds, reason }, actor, clock);
  if (!result.ok) return result;
  return { ok: true, state: result.state, activities: [result.activity], events: result.events, openedItemId: item.id };
}

function splitOccurrence(state: HomemindState, item: Item, conflict: Conflict, reason: OpenReason, candidateIds: string[] | undefined, actor: string, clock: Clock): Steps {
  const cancelled = applyChange(state, { kind: 'cancel_occurrence', itemId: item.id, version: item.version, date: conflict.date }, actor, clock);
  if (!cancelled.ok) return cancelled;

  const wanted = `${item.id}-${conflict.date}`;
  const copy: NewItem = {
    type: item.type,
    title: item.title,
    start: conflict.start,
    forMemberIds: item.forMemberIds,
    visibility: item.visibility,
    sensitive: item.sensitive,
    importance: item.importance,
    // Not the original source: a group or PPMA source would make the copy wait for approval.
    source: { kind: 'rule', label: 'Availability check' },
    ownership: { state: 'open', candidateIds: candidateIds ?? [], reason }
  };
  if (wanted.length <= 64 && !cancelled.state.items.some(i => i.id === wanted)) copy.id = wanted;
  if (conflict.end) copy.end = conflict.end;
  if (item.notes) copy.notes = item.notes;
  const created = applyChange(cancelled.state, { kind: 'create', item: copy }, actor, clock);
  if (!created.ok) return created;
  const openedItemId = created.items[0].id;
  return {
    ok: true,
    state: created.state,
    activities: [cancelled.activity, created.activity],
    events: [...cancelled.events, ...created.events],
    openedItemId
  };
}
