/**
 * What Homemind tells PPMA, and what PPMA's commands do (T6.1). Pure: no network, no clock of its own.
 *
 * Privacy: only what everyone in the family may see goes to PPMA. "Parents only" items (and
 * preparations under them) are never sent in this version; an item that becomes Parents-only is
 * reported as `hidden` with nothing about it but its id. A sensitive item goes without title or notes.
 *
 * Commands: `homemind.get_board` reads the family-wide board. The proposal tools (T6.2) only ever create
 * a `proposed` item, with a `Why` that says it came from PPMA; a parent approves or dismisses it. Nothing
 * a command does sends, buys or orders. Every command still gets exactly one outcome.
 */
import { applyChange } from './core';
import type { CoreEvent, NewItem } from './core';
import type { CommandOutcome, PpmaCommand } from './ppma';
import { isDecisionId } from './ppma';
import { applicablePreferences, blockedChange, itemContext } from './preferences';
import type { GroupMessage, HomemindState, Item, Preference, Why } from './types';
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

/**
 * `homemind.message_received` for a message that arrived in the simulated kindergarten group (T7.2).
 * The group is the whole family's (no "Parents only"), and the message is marked simulated.
 */
export function groupMessageReport(message: GroupMessage, group: { id: string; name: string }): PpmaReport {
  return {
    type: 'homemind.message_received',
    payload: clean({
      source: 'group',
      group_id: group.id,
      group_name: group.name,
      message_id: message.id,
      version: message.version,
      author: message.authorZh ?? message.author,
      from: message.from,
      text: cap(message.text),
      at: message.at,
      simulated: true
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

// --- proposals from PPMA (T6.2) -----------------------------------------------------------------------

/** How much PPMA may put on the board at once, and how far its dates may reach. */
export const PROPOSAL_LIMITS = { waiting: 20, title: 120, notes: 500, pastMs: 2 * DAY, aheadMs: 400 * DAY, eventMinutes: 60 } as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(CONTROL, '').trim().slice(0, max) : '');
const titleKey = (title: string) => title.toLowerCase().replace(/[\s\p{P}]+/gu, '');

type Parsed = { ok: true; item: NewItem } | { ok: false; detail: string };
const refuse = (detail: string): Parsed => ({ ok: false, detail });

/** A date-time with an offset, from 2 days back to 400 days ahead. `undefined` when absent; `null` when bad. */
function dateArg(value: unknown, nowMs: number): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t) || t < nowMs - PROPOSAL_LIMITS.pastMs || t > nowMs + PROPOSAL_LIMITS.aheadMs) return null;
  return new Date(t).toISOString();
}

/** What a proposal tool asks for, checked by hand. Unknown arguments are ignored, never passed on. */
function parseProposal(state: HomemindState, tool: string, args: Record<string, unknown>, nowMs: number): Parsed {
  const title = text(args.title, PROPOSAL_LIMITS.title);
  if (!title) return refuse('title is required');
  const source = { kind: 'ppma' as const, label: 'PPMA' };
  if (tool === 'homemind.add_to_shopping') {
    return { ok: true, item: { type: 'task', title, notes: 'Shopping suggestion from PPMA. Nothing is bought.', source } };
  }
  if (tool === 'homemind.propose_preparation') {
    const eventId = typeof args.event_id === 'string' ? args.event_id : '';
    const event = ID_PATTERN.test(eventId) ? state.items.find(i => i.id === eventId) : undefined;
    // PPMA only knows the family-wide board, so a Parents-only event answers like a missing one.
    if (!event || event.type !== 'event' || (event.status !== 'open' && event.status !== 'proposed') || !isFamilyWide(state, event)) return refuse('No such event on the family board');
    const due = dateArg(args.due, nowMs);
    if (due === null) return refuse('due must be a date-time with an offset, within the next 400 days');
    return { ok: true, item: { type: 'preparation', title, parentEventId: event.id, ...(due ? { start: due } : {}), source } };
  }
  const start = dateArg(args.start, nowMs);
  if (start === null) return refuse('start must be a date-time with an offset, within the next 400 days');
  const notes = text(args.notes, PROPOSAL_LIMITS.notes);
  const common = { title, ...(notes ? { notes } : {}), source };
  if (!start) return { ok: true, item: { type: 'task', ...common } };
  return { ok: true, item: { type: 'event', ...common, start, end: new Date(Date.parse(start) + PROPOSAL_LIMITS.eventMinutes * 60_000).toISOString() } };
}

/** The same thing already waiting or on the board: same words, and the same time or the same event. */
function alreadyThere(state: HomemindState, item: NewItem): boolean {
  const key = titleKey(item.title);
  return state.items.some(
    i => (i.status === 'open' || i.status === 'proposed') && titleKey(i.title) === key && i.type === item.type && i.start === item.start && i.parentEventId === item.parentEventId
  );
}

const rejected = (detail: string): { outcome: CommandOutcome } => ({ outcome: { status: 'rejected', path: 'auto', detail } });

/**
 * One proposal command as a `proposed` item. The technical actor is the first parent (the core needs a member),
 * but the item's source is PPMA and its `Why` says so. Refused, with a plain reason, when Homemind is paused, too
 * many suggestions wait, the arguments are bad, it is already there, or a hard preference rules it out.
 */
function proposeFromPpma(state: HomemindState, command: PpmaCommand, nowMs: number): { outcome: CommandOutcome; state?: HomemindState; events?: CoreEvent[] } {
  if (state.family.paused) return rejected('Homemind is paused, so it takes no suggestions');
  const args = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload) ? command.payload : {};
  const parsed = parseProposal(state, command.type, args, nowMs);
  if (!parsed.ok) return rejected(parsed.detail);
  if (state.items.filter(i => i.status === 'proposed' && i.source.kind === 'ppma').length >= PROPOSAL_LIMITS.waiting) return rejected('Too many suggestions are waiting for a parent');
  if (alreadyThere(state, parsed.item)) return rejected('Already on the board');
  const actor = state.family.members.find(m => m.role === 'parent' && m.hasAccount);
  if (!actor) return { outcome: { status: 'failed', path: 'auto', detail: 'Homemind has no parent to ask' } };

  const change = { kind: 'create', item: { ...parsed.item, proposed: true } } as const;
  const blocked = blockedChange(state, change);
  if (blocked.length) return rejected(`Blocked by a family hard preference (${blocked[0].term})`);
  const result = applyChange(state, change, actor.id, { now: () => nowMs });
  if (!result.ok) return rejected(`Homemind could not add it: ${result.message}`.slice(0, 200));

  const created = result.items[0];
  const rationale = text(command.rationale, 500);
  const considered = applicablePreferences(result.state.preferences, itemContext(result.state.items, result.state.family.members, created)).slice(0, 5);
  const why: Why = {
    id: `why-${created.id}`,
    summary: rationale || 'PPMA suggested this from what it knows about the family.',
    basis: [
      ...(rationale ? [{ kind: 'ppma_rationale', ref: created.id, note: rationale }] : []),
      ...(typeof command.confidence === 'number' && Number.isFinite(command.confidence) ? [{ kind: 'confidence', ref: created.id, note: Math.min(1, Math.max(0, command.confidence)).toFixed(2) }] : []),
      // The saved preferences that applied when it was proposed, so a corrected preference shows in the next one.
      ...considered.map(p => ({ kind: 'preference', note: `${p.text} (${p.strength === 'hard' ? 'hard' : 'soft'})`.slice(0, 300) }))
    ],
    source: 'ppma',
    ...(isDecisionId(command.decision_id) ? { decisionId: command.decision_id } : {})
  };
  const whys = [...result.state.whys.filter(w => w.id !== why.id), why];
  return {
    outcome: { status: 'executed', path: 'auto', result: { item_id: created.id, status: 'proposed', awaits: 'a parent to approve or dismiss' } },
    state: { ...result.state, whys },
    events: result.events
  };
}

/**
 * What a PPMA command does to Homemind. Returns the outcome and, when the board changed, the new state with the
 * core events to publish. `nowMs` is the board's (demo) time.
 */
export function handlePpmaCommand(state: HomemindState, command: PpmaCommand, nowMs: number): { outcome: CommandOutcome; state?: HomemindState; events?: CoreEvent[] } {
  if (command.type === 'homemind.get_board') {
    return { outcome: { status: 'executed', path: 'auto', result: boardForPpma(state, nowMs) } };
  }
  if (PROPOSAL_TOOLS.has(command.type)) return proposeFromPpma(state, command, nowMs);
  if (command.type.startsWith('ui.')) {
    return { outcome: { status: 'rejected', path: 'auto', detail: 'Homemind does not show PPMA notifications in this version' } };
  }
  if (command.type === 'policy.set_threshold') {
    // Homemind's own rule: PPMA only proposes; a parent approves every proposal.
    return { outcome: { status: 'rejected', path: 'auto', detail: 'Homemind keeps its own approval rules' } };
  }
  return { outcome: { status: 'rejected', path: 'auto', detail: `Homemind has no command ${command.type.slice(0, 80)}` } };
}
