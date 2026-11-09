/**
 * Homemind core: every change to the board goes through `applyChange`.
 *
 * Pure: no networking, no React, no I/O, no `Date.now()`. The clock is injected. The input state is
 * never mutated; a successful change returns a new state, the `Activity` it wrote, and the events to
 * publish. Ids are derived from the clock and the existing ids, so a test with a fixed clock gets the
 * same ids every run.
 *
 * Rules enforced here:
 *   - Every change on an existing item carries the version the caller saw. The first write wins; a
 *     stale one gets `409` with the current item ("This changed. Here is the latest.").
 *   - Ownership: `none`, `open` ("Who's taking this?"), `assigned`. Anyone can assign to anyone with an
 *     account; the owner confirms or hands back with a note. A claim on an item someone else owns is
 *     refused, so two people tapping "I'll take it" can't both win.
 *   - "Parents only" items are invisible to non-parents: they get `404`, never `403`, so no trace leaks.
 *     Only a parent can own one. Preparations follow their event's visibility.
 *   - Extraction and PPMA sources only create `proposed` items.
 *   - Undo restores every item a change touched, once, and only if nothing changed them since.
 */
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import type { Clock } from './clock';
import { ID_PATTERN } from './types';
import type {
  Activity,
  ActivityKind,
  HomemindState,
  Item,
  ItemSource,
  ItemType,
  Member,
  OpenReason,
  Ownership,
  Recurrence,
  SourceKind,
  SourceRef,
  StaleMark,
  UndoEntry
} from './types';

// ---------------------------------------------------------------------------------------------
// Changes and results

/** Fields a caller may set on create or edit. */
export interface ItemFields {
  title: string;
  notes?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  forMemberIds?: string[];
  visibility?: 'family' | 'parents';
  sensitive?: boolean;
  importance?: 'normal' | 'critical';
  unavailableMemberIds?: string[];
  recurrence?: Recurrence;
}

/** For an edit. An empty `start` or `end` clears it, and `recurrence: null` stops the repetition. */
export type ItemPatch = Partial<Omit<ItemFields, 'recurrence'>> & { recurrence?: Recurrence | null };

export interface NewItem extends ItemFields {
  /** Optional caller-chosen id (seed-like fixtures, tests). Generated when absent. */
  id?: string;
  type: ItemType;
  parentEventId?: string;
  ownership?: Ownership;
  source?: ItemSource;
  /** Create as `proposed`, waiting for approval. Forced for screenshot, email, group and PPMA sources. */
  proposed?: boolean;
  /** T7.4: a Chinese title for an item Homemind itself words (a group claim's preparations). Not from clients. */
  titleZh?: string;
  /** T7.5: the messages the item was made from. Not from clients. */
  sourceRefs?: SourceRef[];
}

/**
 * T7.5: one item's part of a source change: mark or clear `stale`, move it, refresh its source refs, or
 * remove it. Only sourceChanges.ts builds these (never a client).
 */
export interface SourceUpdate {
  itemId: string;
  version: number;
  stale?: StaleMark | null;
  start?: string;
  end?: string;
  sourceRefs?: SourceRef[];
  cancel?: boolean;
}

/** The actor of what Homemind does on its own. Only a `source_sync` change accepts it. */
const HOMEMIND = 'homemind';

export type Change =
  | { kind: 'create'; item: NewItem }
  | { kind: 'edit'; itemId: string; version: number; patch: ItemPatch }
  | { kind: 'assign'; itemId: string; version: number; ownerId: string }
  /** "Who's taking this?" Candidates default to everyone who could own it. `reason` is set only by
   * availability.ts; the bridge never takes one from a client. */
  | { kind: 'open'; itemId: string; version: number; candidateIds?: string[]; reason?: OpenReason }
  | { kind: 'unassign'; itemId: string; version: number }
  | { kind: 'claim'; itemId: string; version: number }
  | { kind: 'confirm'; itemId: string; version: number }
  | { kind: 'handback'; itemId: string; version: number; note?: string }
  | { kind: 'done'; itemId: string; version: number }
  /** Removes the item from the board (kept, with status `cancelled`, so it can be undone). */
  | { kind: 'cancel'; itemId: string; version: number }
  /** Cancels one occurrence of a recurring item. `date` is the local `YYYY-MM-DD`. */
  | { kind: 'cancel_occurrence'; itemId: string; version: number; date: string }
  | { kind: 'approve'; itemId: string; version: number }
  | { kind: 'dismiss'; itemId: string; version: number }
  /** T7.5: several items at once, one Activity (`kind: 'source'`), so one Undo restores them all. */
  | { kind: 'source_sync'; changeId: string; note: 'marked' | 'applied' | 'kept' | 'discarded' | 'synced'; updates: SourceUpdate[] }
  /** `viaSource`: undo a `source` activity. Only sourceChanges.ts sets it, so the source change's own record follows. */
  | { kind: 'undo'; activityId: string; viaSource?: boolean };

export type ChangeKind = Change['kind'];

export type CoreEvent = {
  type: 'item.changed';
  itemId: string;
  /** `null` when the item no longer exists (an undone create). */
  item: Item | null;
  /** The visibility before the change, when it differs or the item is gone, so a hub can tell a
   * member who could see it before that it left their view. */
  previousVisibility?: Item['visibility'];
};

export type ChangeErrorCode = 'invalid' | 'forbidden' | 'not_found' | 'stale' | 'conflict';

export interface ChangeError {
  ok: false;
  status: 400 | 403 | 404 | 409;
  code: ChangeErrorCode;
  /** English, for logs and tests. Screens use `code`. */
  message: string;
  /** For `stale` and `conflict`: the item as it is now, so the screen can show the latest. */
  current?: Item;
}

export interface ChangeSuccess {
  ok: true;
  state: HomemindState;
  activity: Activity;
  /** The items as they are after the change (an undone create is absent). */
  items: Item[];
  events: CoreEvent[];
}

export type ChangeResult = ChangeSuccess | ChangeError;

// ---------------------------------------------------------------------------------------------
// Limits and small helpers

export const LIMITS = { title: 200, notes: 2000, note: 500, members: 16, weekdays: 7, exceptions: 400 } as const;

/** Sources whose items wait for a person to approve them. */
const PROPOSING_SOURCES: ReadonlySet<SourceKind> = new Set(['screenshot', 'email', 'group', 'ppma']);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (status: ChangeError['status'], code: ChangeErrorCode, message: string, current?: Item): ChangeError =>
  current ? { ok: false, status, code, message, current } : { ok: false, status, code, message };
const invalid = (message: string) => fail(400, 'invalid', message);
const notFound = (what = 'item') => fail(404, 'not_found', `no such ${what}`);

function memberOf(state: HomemindState, id: string): Member | undefined {
  return state.family.members.find(m => m.id === id);
}

const isParent = (state: HomemindState, id: string) => memberOf(state, id)?.role === 'parent';

/** Whether `memberId` may see `item` at all. visibility.ts builds the full per-member view on this. */
export function canSee(state: HomemindState, memberId: string, item: Item): boolean {
  return item.visibility === 'family' || isParent(state, memberId);
}

/** Members who could own `item`: everyone with an account, and only parents for "Parents only". */
export function eligibleOwners(state: HomemindState, item: Pick<Item, 'visibility'>): string[] {
  return state.family.members
    .filter(m => m.hasAccount && (item.visibility === 'family' || m.role === 'parent'))
    .map(m => m.id);
}

function nameOf(state: HomemindState, id: string): string {
  return memberOf(state, id)?.name ?? id;
}

/** A new id: `<prefix>-<clock in base 36>`, with `-2`, `-3`... if that is taken. Matches ID_PATTERN. */
function newId(prefix: string, clock: Clock, taken: (id: string) => boolean): string {
  const base = `${prefix}-${Math.max(0, Math.floor(clock.now())).toString(36)}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// ---------------------------------------------------------------------------------------------
// Validation of caller-supplied fields

function checkIso(value: unknown, what: string): string | ChangeError {
  if (typeof value !== 'string' || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    return invalid(`${what} must be an ISO time in UTC`);
  }
  return toIso(Date.parse(value));
}

function checkMembers(state: HomemindState, ids: unknown, what: string): string[] | ChangeError {
  if (!Array.isArray(ids) || ids.length > LIMITS.members) return invalid(`${what} must be a list of members`);
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !memberOf(state, id)) return invalid(`${what}: unknown member`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function checkRecurrence(value: Recurrence): Recurrence | ChangeError {
  if (!value || value.freq !== 'weekly') return invalid('recurrence must be weekly');
  const days = value.byWeekday;
  if (!Array.isArray(days) || days.length === 0 || days.length > LIMITS.weekdays) return invalid('recurrence needs weekdays');
  if (!days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return invalid('weekdays are 0 to 6');
  if (value.until !== undefined && (typeof value.until !== 'string' || !LOCAL_DATE.test(value.until))) {
    return invalid('recurrence until must be YYYY-MM-DD');
  }
  const exceptions = value.exceptions ?? [];
  if (!Array.isArray(exceptions) || exceptions.length > LIMITS.exceptions || !exceptions.every(d => typeof d === 'string' && LOCAL_DATE.test(d))) {
    return invalid('recurrence exceptions must be YYYY-MM-DD dates');
  }
  const out: Recurrence = { freq: 'weekly', byWeekday: [...new Set(days)].sort((a, b) => a - b) };
  if (value.until) out.until = value.until;
  if (exceptions.length) out.exceptions = [...new Set(exceptions)].sort();
  return out;
}

/** Applies `fields` over `base` and checks the result. Returns the new item or an error. */
function withFields(state: HomemindState, actor: string, base: Item, fields: ItemPatch): Item | ChangeError {
  const next: Item = { ...base };
  if (fields.title !== undefined) {
    const title = typeof fields.title === 'string' ? fields.title.trim() : '';
    if (!title || title.length > LIMITS.title) return invalid(`title must be 1 to ${LIMITS.title} characters`);
    if (title !== base.title) {
      next.title = title;
      // A seeded Chinese title would now describe something else.
      delete next.titleZh;
    }
  }
  if (fields.notes !== undefined) {
    if (typeof fields.notes !== 'string' || fields.notes.length > LIMITS.notes) return invalid('notes are too long');
    if (fields.notes.trim()) next.notes = fields.notes;
    else delete next.notes;
  }
  for (const key of ['start', 'end'] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    if (value === '') {
      delete next[key];
      continue;
    }
    const iso = checkIso(value, key);
    if (typeof iso !== 'string') return iso;
    next[key] = iso;
  }
  if (fields.allDay !== undefined) {
    if (typeof fields.allDay !== 'boolean') return invalid('allDay must be true or false');
    next.allDay = fields.allDay;
  }
  for (const key of ['forMemberIds', 'unavailableMemberIds'] as const) {
    if (fields[key] === undefined) continue;
    const ids = checkMembers(state, fields[key], key);
    if (!Array.isArray(ids)) return ids;
    next[key] = ids;
  }
  if (fields.visibility !== undefined) {
    if (fields.visibility !== 'family' && fields.visibility !== 'parents') return invalid('visibility is family or parents');
    if (fields.visibility !== base.visibility && !isParent(state, actor)) return fail(403, 'forbidden', 'only a parent can change who sees an item');
    next.visibility = fields.visibility;
  }
  if (fields.sensitive !== undefined) {
    if (typeof fields.sensitive !== 'boolean') return invalid('sensitive must be true or false');
    next.sensitive = fields.sensitive;
  }
  if (fields.importance !== undefined) {
    if (fields.importance !== 'normal' && fields.importance !== 'critical') return invalid('importance is normal or critical');
    next.importance = fields.importance;
  }
  if (fields.recurrence !== undefined) {
    if (fields.recurrence === null) delete next.recurrence;
    else {
      const recurrence = checkRecurrence(fields.recurrence);
      if ('ok' in recurrence) return recurrence;
      next.recurrence = recurrence;
    }
  }

  if (next.end && !next.start) return invalid('an end needs a start');
  if (next.start && next.end && Date.parse(next.end) < Date.parse(next.start)) return invalid('end is before start');
  if (next.recurrence && !next.start) return invalid('a recurring item needs a start');
  if (next.recurrence && next.type === 'preparation') return invalid('a preparation does not repeat');
  if (next.unavailableMemberIds.length && next.type !== 'event') return invalid('only an event makes members unavailable');
  if (next.unavailableMemberIds.length && !(next.start && next.end)) return invalid('unavailability needs a start and an end');
  if (next.ownership.state === 'assigned' && !eligibleOwners(state, next).includes(next.ownership.ownerId)) {
    return invalid('the owner of a Parents-only item must be a parent');
  }
  if (next.ownership.state === 'open') {
    const eligible = eligibleOwners(state, next);
    const candidateIds = next.ownership.candidateIds.filter(id => eligible.includes(id));
    if (!sameIds(candidateIds, next.ownership.candidateIds)) next.ownership = { ...next.ownership, candidateIds };
  }
  return next;
}

function checkOwnership(state: HomemindState, actor: string, item: Item, ownership: Ownership | undefined): Ownership | ChangeError {
  if (!ownership || ownership.state === 'none') return { state: 'none' };
  const eligible = eligibleOwners(state, item);
  if (ownership.state === 'open') {
    const ids = ownership.candidateIds?.length ? checkMembers(state, ownership.candidateIds, 'candidateIds') : eligible;
    if (!Array.isArray(ids)) return ids;
    if (!ids.every(id => eligible.includes(id))) return invalid('a candidate cannot own this item');
    if (ownership.reason === undefined) return { state: 'open', candidateIds: ids };
    const reason = checkReason(state, ownership.reason);
    if ('ok' in reason) return reason;
    return { state: 'open', candidateIds: ids, reason };
  }
  if (ownership.state === 'assigned') {
    if (typeof ownership.ownerId !== 'string' || !eligible.includes(ownership.ownerId)) return invalid('that member cannot own this item');
    return { state: 'assigned', ownerId: ownership.ownerId, confirmed: ownership.ownerId === actor };
  }
  return invalid('unknown ownership state');
}

/** A reason must name a real event that makes that member unavailable. */
function checkReason(state: HomemindState, reason: OpenReason): OpenReason | ChangeError {
  if (!reason || reason.kind !== 'unavailable') return invalid('unknown reason');
  const event = typeof reason.eventId === 'string' ? state.items.find(i => i.id === reason.eventId) : undefined;
  if (!event || event.type !== 'event' || typeof reason.memberId !== 'string' || !event.unavailableMemberIds.includes(reason.memberId)) {
    return invalid('the reason must name an event that makes that member unavailable');
  }
  if (typeof reason.date !== 'string' || !LOCAL_DATE.test(reason.date)) return invalid('reason date must be YYYY-MM-DD');
  return { kind: 'unavailable', memberId: reason.memberId, eventId: event.id, date: reason.date };
}

// ---------------------------------------------------------------------------------------------
// applyChange

interface Draft {
  /** Items after the change, by id. A `null` value removes the item. */
  next: Map<string, Item | null>;
  kind: ActivityKind;
  itemId?: string;
  what: string;
  memberId?: string;
  note?: string;
  ref?: string;
  /** Undo marks the original activity instead of writing an undo patch. */
  undoes?: Activity;
}

/**
 * Applies one change by `actor` (a member id) at `clock.now()`. Never mutates `state`.
 * On success the caller should persist `result.state` and publish `result.events`.
 */
export function applyChange(state: HomemindState, change: Change, actor: string, clock: Clock): ChangeResult {
  if (!change || typeof change !== 'object') return invalid('no change');
  const member = memberOf(state, actor);
  const homemind = actor === HOMEMIND && change.kind === 'source_sync';
  if (!homemind && (!member || !member.hasAccount)) return fail(403, 'forbidden', 'unknown member, or a member without an account');

  const draft =
    change.kind === 'create'
      ? planCreate(state, change.item, actor, clock)
      : change.kind === 'undo'
        ? planUndo(state, change.activityId, actor, change.viaSource === true)
        : change.kind === 'source_sync'
          ? planSourceSync(state, change, actor)
          : planItemChange(state, change, actor);
  if ('ok' in draft) return draft;
  return commit(state, draft, actor, clock);
}

function commit(state: HomemindState, draft: Draft, actor: string, clock: Clock): ChangeSuccess {
  const at = toIso(clock.now());
  const byId = new Map(state.items.map(item => [item.id, item]));
  const undoEntries: UndoEntry[] = [];
  const events: CoreEvent[] = [];
  const changed: Item[] = [];

  const finalized = new Map<string, Item | null>();
  for (const [id, next] of draft.next) {
    const before = byId.get(id) ?? null;
    const after = next && { ...next, version: before ? before.version + 1 : next.version };
    finalized.set(id, after);
    if (after) changed.push(after);
    undoEntries.push({ itemId: id, before, afterVersion: after ? after.version : 0 });
    const event: CoreEvent = { type: 'item.changed', itemId: id, item: after };
    if (before && (!after || after.visibility !== before.visibility)) event.previousVisibility = before.visibility;
    events.push(event);
  }

  const items = state.items.flatMap(item => {
    if (!finalized.has(item.id)) return [item];
    const after = finalized.get(item.id);
    return after ? [after] : [];
  });
  for (const [id, after] of finalized) if (after && !byId.has(id)) items.push(after);

  const activityId = newId('act', clock, id => state.activity.some(a => a.id === id));
  const activity: Activity = { id: activityId, at, actor, what: draft.what, kind: draft.kind };
  if (draft.itemId) activity.itemId = draft.itemId;
  if (draft.memberId) activity.memberId = draft.memberId;
  if (draft.note) activity.note = draft.note;
  if (draft.ref) activity.ref = draft.ref;
  if (!draft.undoes) activity.undo = { items: undoEntries };

  const log = state.activity.map(a => (a === draft.undoes ? { ...a, undone: { at, by: actor, activityId } } : a));
  return {
    ok: true,
    state: { ...state, items, activity: [...log, activity] },
    activity,
    items: changed,
    events
  };
}

function planCreate(state: HomemindState, input: NewItem, actor: string, clock: Clock): Draft | ChangeError {
  if (!input || typeof input !== 'object') return invalid('no item');
  if (input.type !== 'event' && input.type !== 'task' && input.type !== 'preparation') return invalid('type is event, task or preparation');
  const taken = (id: string) => state.items.some(item => item.id === id);
  let id: string;
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) return invalid('bad id');
    if (taken(input.id)) return fail(409, 'conflict', 'an item with that id exists');
    id = input.id;
  } else {
    id = newId('item', clock, taken);
  }

  let visibility = input.visibility ?? 'family';
  let parentEventId: string | undefined;
  if (input.type === 'preparation') {
    const parent = typeof input.parentEventId === 'string' ? state.items.find(item => item.id === input.parentEventId) : undefined;
    if (!parent || !canSee(state, actor, parent)) return notFound('event');
    if (parent.type !== 'event') return invalid('a preparation belongs under an event');
    if (parent.status === 'cancelled') return fail(409, 'conflict', 'that event was cancelled', parent);
    parentEventId = parent.id;
    // A preparation is as private as its event, or it would give the event away.
    if (parent.visibility === 'parents') visibility = 'parents';
  } else if (input.parentEventId !== undefined) {
    return invalid('only a preparation has a parent event');
  }
  if (visibility === 'parents' && !isParent(state, actor)) return fail(403, 'forbidden', 'only a parent can create a Parents-only item');

  const source: ItemSource = input.source ?? { kind: 'manual', label: `Added by ${nameOf(state, actor)}` };
  if (!source || typeof source.kind !== 'string' || typeof source.label !== 'string') return invalid('bad source');
  const proposed = input.proposed === true || PROPOSING_SOURCES.has(source.kind);

  const base: Item = {
    id,
    type: input.type,
    title: '',
    forMemberIds: [],
    ownership: { state: 'none' },
    visibility: 'family',
    sensitive: false,
    importance: 'normal',
    unavailableMemberIds: [],
    status: proposed ? 'proposed' : 'open',
    source: { ...source },
    createdBy: actor,
    version: 1
  };
  if (parentEventId) base.parentEventId = parentEventId;
  const filled = withFields(state, actor, base, { ...pickFields(input), title: input.title ?? '', visibility });
  if ('ok' in filled) return filled;
  const ownership = checkOwnership(state, actor, filled, input.ownership);
  if ('ok' in ownership) return ownership;
  const item: Item = { ...filled, ownership };
  if (input.titleZh !== undefined) {
    const titleZh = typeof input.titleZh === 'string' ? input.titleZh.trim() : '';
    if (!titleZh || titleZh.length > LIMITS.title) return invalid(`titleZh must be 1 to ${LIMITS.title} characters`);
    item.titleZh = titleZh;
  }
  if (input.sourceRefs?.length) item.sourceRefs = input.sourceRefs.slice(0, 8).map(r => ({ id: r.id, version: r.version }));

  return { next: new Map([[id, item]]), kind: 'create', itemId: id, what: proposed ? 'Proposed an item' : 'Added an item' };
}

const FIELD_KEYS = ['title', 'notes', 'start', 'end', 'allDay', 'forMemberIds', 'visibility', 'sensitive', 'importance', 'unavailableMemberIds', 'recurrence'] as const;

function pickFields(input: ItemPatch): ItemPatch {
  const out: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) if (input[key] !== undefined) out[key] = input[key];
  return out as ItemPatch;
}

type ItemChange = Exclude<Change, { kind: 'create' } | { kind: 'undo' } | { kind: 'source_sync' }>;

const SOURCE_WHAT: Record<Extract<Change, { kind: 'source_sync' }>['note'], string> = {
  marked: 'Marked items whose message changed',
  applied: 'Applied a changed message',
  kept: 'Kept items as they were',
  discarded: 'Discarded items from a changed message',
  synced: 'Updated the source versions of items'
};

/** T7.5: several items in one step. Every item must be the version the caller read, or nothing changes. */
function planSourceSync(state: HomemindState, change: Extract<Change, { kind: 'source_sync' }>, actor: string): Draft | ChangeError {
  if (!Array.isArray(change.updates) || change.updates.length === 0 || change.updates.length > 50) return invalid('updates must be a short list');
  if (typeof change.changeId !== 'string' || !ID_PATTERN.test(change.changeId)) return invalid('bad change id');
  if (!SOURCE_WHAT[change.note]) return invalid('unknown note');
  const next = new Map<string, Item | null>();
  for (const update of change.updates) {
    const item = state.items.find(i => i.id === update.itemId);
    if (!item || (actor !== HOMEMIND && !canSee(state, actor, item))) return notFound();
    if (update.version !== item.version) return fail(409, 'stale', 'this changed; here is the latest', item);
    if (next.has(item.id)) return invalid('an item is listed twice');
    const after: Item = { ...item };
    if (update.stale === null) delete after.stale;
    else if (update.stale) after.stale = { ...update.stale };
    if (update.start !== undefined) {
      const start = checkIso(update.start, 'start');
      if (typeof start !== 'string') return start;
      after.start = start;
    }
    if (update.end !== undefined) {
      const end = checkIso(update.end, 'end');
      if (typeof end !== 'string') return end;
      after.end = end;
    }
    if (after.start && after.end && Date.parse(after.end) < Date.parse(after.start)) return invalid('end is before start');
    if (update.sourceRefs) after.sourceRefs = update.sourceRefs.slice(0, 8).map(r => ({ id: r.id, version: r.version }));
    if (update.cancel) {
      if (item.status === 'done') return fail(409, 'conflict', 'this is already done', item);
      after.status = 'cancelled';
      delete after.stale;
    }
    next.set(item.id, after);
  }
  return { next, kind: 'source', what: SOURCE_WHAT[change.note], note: change.note, ref: change.changeId };
}

function planItemChange(state: HomemindState, change: ItemChange, actor: string): Draft | ChangeError {
  const item = typeof change.itemId === 'string' ? state.items.find(i => i.id === change.itemId) : undefined;
  if (!item || !canSee(state, actor, item)) return notFound();
  if (!Number.isInteger(change.version)) return invalid('version is required');
  if (change.version !== item.version) return fail(409, 'stale', 'this changed; here is the latest', item);
  if (item.status === 'cancelled') return fail(409, 'conflict', 'this item was removed', item);

  const one = (next: Item, kind: ActivityKind, what: string, extra: Partial<Draft> = {}): Draft => ({
    next: new Map([[item.id, next]]),
    kind,
    itemId: item.id,
    what,
    ...extra
  });
  const owner = item.ownership.state === 'assigned' ? item.ownership.ownerId : undefined;
  const settled = item.status === 'done';
  const notWhileDone = () => fail(409, 'conflict', 'this is already done', item);

  switch (change.kind) {
    case 'edit': {
      if (!change.patch || typeof change.patch !== 'object') return invalid('no patch');
      const next = withFields(state, actor, item, pickFields(change.patch));
      if ('ok' in next) return next;
      const parent = item.parentEventId ? state.items.find(i => i.id === item.parentEventId) : undefined;
      if (parent?.visibility === 'parents' && next.visibility !== 'parents') return invalid('a preparation is as private as its event');
      const draft = one(next, 'edit', 'Edited');
      // Preparations follow their event into or out of "Parents only".
      if (next.type === 'event' && next.visibility !== item.visibility) {
        for (const prep of preparationsOf(state, item.id)) {
          const moved: Item = { ...prep, visibility: next.visibility };
          if (moved.ownership.state === 'assigned' && !eligibleOwners(state, moved).includes(moved.ownership.ownerId)) {
            moved.ownership = { state: 'open', candidateIds: eligibleOwners(state, moved) };
          } else if (moved.ownership.state === 'open') {
            moved.ownership = { ...moved.ownership, candidateIds: moved.ownership.candidateIds.filter(id => eligibleOwners(state, moved).includes(id)) };
          }
          draft.next.set(prep.id, moved);
        }
      }
      return draft;
    }

    case 'assign': {
      if (settled) return notWhileDone();
      if (typeof change.ownerId !== 'string' || !eligibleOwners(state, item).includes(change.ownerId)) return invalid('that member cannot own this item');
      if (owner === change.ownerId) return fail(409, 'conflict', 'already assigned to that member', item);
      const ownership: Ownership = { state: 'assigned', ownerId: change.ownerId, confirmed: change.ownerId === actor };
      return one({ ...item, ownership }, 'assign', `Assigned to ${nameOf(state, change.ownerId)}`, { memberId: change.ownerId });
    }

    case 'open': {
      if (settled) return notWhileDone();
      const ownership = checkOwnership(state, actor, item, { state: 'open', candidateIds: change.candidateIds ?? [], reason: change.reason });
      if ('ok' in ownership) return ownership;
      // The reason stays off the log: whoever can't see the event must not find it, or who it keeps
      // away, there. Screens read it from the ownership, which visibility.ts redacts.
      return one({ ...item, ownership }, 'open', 'Asked who is taking this');
    }

    case 'unassign': {
      if (settled) return notWhileDone();
      if (item.ownership.state === 'none') return fail(409, 'conflict', 'nobody owns this', item);
      return one({ ...item, ownership: { state: 'none' } }, 'unassign', 'Cleared the owner');
    }

    case 'claim': {
      if (settled) return notWhileDone();
      if (!eligibleOwners(state, item).includes(actor)) return fail(403, 'forbidden', 'you cannot own this item');
      if (owner && owner !== actor) return fail(409, 'conflict', 'someone else is already taking this', item);
      if (owner === actor && item.ownership.state === 'assigned' && item.ownership.confirmed) return fail(409, 'conflict', 'you are already taking this', item);
      return one({ ...item, ownership: { state: 'assigned', ownerId: actor, confirmed: true } }, 'claim', `${nameOf(state, actor)} is taking this`, { memberId: actor });
    }

    case 'confirm': {
      if (settled) return notWhileDone();
      if (owner !== actor) return fail(403, 'forbidden', 'only the owner can confirm');
      if (item.ownership.state === 'assigned' && item.ownership.confirmed) return fail(409, 'conflict', 'already confirmed', item);
      return one({ ...item, ownership: { state: 'assigned', ownerId: actor, confirmed: true } }, 'confirm', 'Confirmed', { memberId: actor });
    }

    case 'handback': {
      if (settled) return notWhileDone();
      if (owner !== actor) return fail(403, 'forbidden', 'only the owner can hand this back');
      if (change.note !== undefined && (typeof change.note !== 'string' || change.note.length > LIMITS.note)) return invalid('the note is too long');
      const note = change.note?.trim();
      const candidateIds = eligibleOwners(state, item).filter(id => id !== actor);
      const ownership: Ownership = { state: 'open', candidateIds, handedBackBy: actor };
      if (note) ownership.note = note;
      return one({ ...item, ownership }, 'handback', 'Handed back', { memberId: actor, note });
    }

    case 'done': {
      if (settled) return notWhileDone();
      if (item.status === 'proposed') return fail(409, 'conflict', 'approve this first', item);
      if (item.recurrence) return invalid('a repeating item is not done as a whole; cancel or edit it');
      return one({ ...item, status: 'done' }, 'done', 'Marked done');
    }

    case 'cancel': {
      const draft = one({ ...item, status: 'cancelled' }, 'cancel', 'Removed');
      if (item.type === 'event') {
        for (const prep of preparationsOf(state, item.id)) draft.next.set(prep.id, { ...prep, status: 'cancelled' });
      }
      return draft;
    }

    case 'cancel_occurrence': {
      if (!item.recurrence || !item.start) return invalid('this item does not repeat');
      const date = change.date;
      if (typeof date !== 'string' || !LOCAL_DATE.test(date)) return invalid('date must be YYYY-MM-DD');
      if (!isOccurrenceDate(item, date, state.family.timezone)) return invalid('there is no occurrence on that date');
      const exceptions = item.recurrence.exceptions ?? [];
      if (exceptions.includes(date)) return fail(409, 'conflict', 'that occurrence is already cancelled', item);
      if (exceptions.length >= LIMITS.exceptions) return invalid('too many cancelled occurrences');
      const recurrence: Recurrence = { ...item.recurrence, exceptions: [...exceptions, date].sort() };
      return one({ ...item, recurrence }, 'cancel_occurrence', 'Cancelled one occurrence', { ref: date });
    }

    case 'approve':
    case 'dismiss': {
      if (item.status !== 'proposed') return fail(409, 'conflict', 'this is not waiting for approval', item);
      const status = change.kind === 'approve' ? 'open' : 'cancelled';
      const draft = change.kind === 'approve' ? one({ ...item, status }, 'approve', 'Approved') : one({ ...item, status }, 'dismiss', 'Dismissed');
      // One tap for an event and the preparations proposed with it (T5.3). Undo restores them all.
      if (item.type === 'event') {
        for (const prep of preparationsOf(state, item.id)) if (prep.status === 'proposed') draft.next.set(prep.id, { ...prep, status });
      }
      return draft;
    }

    default:
      return invalid('unknown change');
  }
}

function planUndo(state: HomemindState, activityId: string, actor: string, viaSource = false): Draft | ChangeError {
  const original = typeof activityId === 'string' ? state.activity.find(a => a.id === activityId) : undefined;
  if (!original || !original.undo) return notFound('change');
  // T7.5: a source change is undone as a whole (its record and held cards too), never item by item.
  if (original.kind === 'source' && !viaSource) return fail(409, 'conflict', 'undo this from the changed-message card');
  const touched = original.undo.items.map(entry => entry.before ?? state.items.find(i => i.id === entry.itemId)).filter((i): i is Item => !!i);
  // No trace of a Parents-only change for anyone else, and nobody undoes another member's change
  // unless they are a parent.
  if (touched.some(item => !canSee(state, actor, item))) return notFound('change');
  if (original.actor !== actor && !isParent(state, actor)) return fail(403, 'forbidden', 'only a parent can undo what someone else did');
  if (original.undone) return fail(409, 'conflict', 'this was already undone');

  const next = new Map<string, Item | null>();
  for (const entry of original.undo.items) {
    const current = state.items.find(i => i.id === entry.itemId);
    if ((current?.version ?? 0) !== entry.afterVersion) {
      return fail(409, 'stale', 'this changed since; here is the latest', current);
    }
    if (entry.before === null) {
      const child = state.items.find(i => i.parentEventId === entry.itemId && i.status !== 'cancelled');
      if (child) return fail(409, 'conflict', 'something was added under this since', current);
      next.set(entry.itemId, null);
    } else {
      // Restore the old content under a new version, so screens holding the undone version see it moved.
      next.set(entry.itemId, entry.before);
    }
  }
  return { next, kind: 'undo', itemId: original.itemId, what: 'Undid a change', ref: original.id, undoes: original };
}

function preparationsOf(state: HomemindState, eventId: string): Item[] {
  return state.items.filter(item => item.type === 'preparation' && item.parentEventId === eventId && item.status !== 'cancelled');
}

// ---------------------------------------------------------------------------------------------
// Reading helpers (pure), for screens and later tasks

/** The preparations under an event, in time order, cancelled ones left out. */
export function preparationsFor(state: HomemindState, eventId: string): Item[] {
  return preparationsOf(state, eventId).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
}

export interface Occurrence {
  itemId: string;
  /** Local date `YYYY-MM-DD` in the family's time zone. */
  date: string;
  start: string;
  end?: string;
}

/** Safety bound on how many days one expansion walks. */
const MAX_EXPAND_DAYS = 400;

function isOccurrenceDate(item: Item, date: string, timezone: string): boolean {
  if (!item.recurrence || !item.start) return false;
  const first = localParts(Date.parse(item.start), timezone);
  if (date < first.date) return false;
  if (item.recurrence.until && date > item.recurrence.until) return false;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return item.recurrence.byWeekday.includes(weekday);
}

/**
 * The occurrences of `item` that start in `[fromMs, toMs)`. A one-off item gives itself, if it is in
 * range. A weekly item repeats at the same local time in the family's zone, so it stays at 16:30 across
 * a daylight-saving change, and skips its cancelled dates.
 */
export function occurrences(item: Item, fromMs: number, toMs: number, timezone: string): Occurrence[] {
  if (!item.start || item.status === 'cancelled') return [];
  const startMs = Date.parse(item.start);
  const duration = item.end ? Date.parse(item.end) - startMs : undefined;
  const make = (date: string, ms: number): Occurrence => {
    const occurrence: Occurrence = { itemId: item.id, date, start: toIso(ms) };
    if (duration !== undefined) occurrence.end = toIso(ms + duration);
    return occurrence;
  };
  if (!item.recurrence) {
    return startMs >= fromMs && startMs < toMs ? [make(localParts(startMs, timezone).date, startMs)] : [];
  }

  const first = localParts(startMs, timezone);
  const exceptions = new Set(item.recurrence.exceptions ?? []);
  const out: Occurrence[] = [];
  const fromDate = localParts(fromMs, timezone).date;
  let date = first.date > fromDate ? first.date : fromDate;
  const lastDate = localParts(toMs, timezone).date;
  for (let i = 0; i < MAX_EXPAND_DAYS && date <= lastDate; i++, date = addDays(date, 1)) {
    if (!isOccurrenceDate(item, date, timezone) || exceptions.has(date)) continue;
    const ms = zonedToUtc(date, first.time, timezone);
    if (ms >= fromMs && ms < toMs) out.push(make(date, ms));
  }
  return out;
}
