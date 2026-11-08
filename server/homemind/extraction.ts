/**
 * Screenshots and preparations (T5.3): a validated `Extraction` becomes proposed items on the board.
 *
 * `applyExtraction` is pure. It runs one `create` per entry through `applyChange` on a local copy of the
 * state, so the bridge commits all of it at once or nothing:
 *   - events          proposed events, with the source quote as the note
 *   - preparations    proposed preparations under the event they name (one from the same screenshot,
 *                     or one already on the member's board). With no event named, a proposed task.
 *                     A preparation without a time, or due only when its event starts, gets a
 *                     suggested time, marked as suggested.
 *                     One for an event that is over, or due before now with no event, is skipped.
 *   - requests        proposed tasks ("reply by Wednesday")
 *   - sign-up         not an item: the card shows what is already taken (claiming it is T7.4)
 *
 * Every item comes from a `screenshot` (or `chat` text) source and is `proposed`: the core forces it for
 * screenshots, and this module asks for it for text as well. Nothing is final until a person approves it.
 * An entry that is already on the board (same title and time) is skipped, so sending the same
 * screenshot twice does not double the board. An event that is already over is skipped, and so is a
 * request whose deadline has passed (an old screenshot says so on the card instead of failing).
 *
 * Each created item gets a `Why` record whose basis is the source quote, with `source: 'model'`: "Why?"
 * then says the model read it, and quotes the source.
 *
 * Pure: no network, no clock reads beyond the injected clock, no imports from src/.
 */
import { addDays, localParts, zonedToUtc } from './clock';
import type { Clock } from './clock';
import { applyChange, canSee } from './core';
import type { ChangeError, CoreEvent, NewItem } from './core';
import { eventTimes } from './chat';
import type { Extraction } from './intents';
import type { ExtractedEntry, HomemindState, Item, ItemSource, SkippedExtraction, Why } from './types';

/** Below this confidence the card marks an entry as unsure. */
export const UNSURE_BELOW = 0.6;
/** A preparation with no time is suggested for the evening before, at this local time... */
export const EVENING_BEFORE = '20:00';
/** ...or, when that has passed, this long before the event. */
export const SHORT_LEAD_MINUTES = 60;
/** At most this many items from one extraction. */
export const MAX_CREATED = 30;

export type ExtractedKind = ExtractedEntry['kind'];
export type CreatedEntry = ExtractedEntry;
export type SkippedEntry = SkippedExtraction;

export interface ExtractionResult {
  ok: true;
  state: HomemindState;
  events: CoreEvent[];
  created: CreatedEntry[];
  skipped: SkippedEntry[];
  activityIds: string[];
}

export interface ExtractionOptions {
  /** `screenshot` for an image; `chat` for pasted text. */
  source: ItemSource;
}

/** The board stores UTC. The validator already gives UTC; this keeps the module safe on its own. */
const utc = (iso: string | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso)).toISOString() : undefined);
const squash = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’「」『』《》()（）:：,，.。!！?？·-]/g, '');
const sameMinute = (a?: string, b?: string) => (!a && !b) || (!!a && !!b && Math.abs(Date.parse(a) - Date.parse(b)) < 60_000);
const titlesOf = (item: Item) => [item.title, item.titleZh].filter((t): t is string => !!t).map(squash);
const titleMatches = (item: Item, title: string) => {
  const t = squash(title);
  return !!t && titlesOf(item).some(own => own === t || (t.length >= 2 && own.length >= 2 && (own.includes(t) || t.includes(own))));
};

/**
 * When to do a preparation the source gave no time for: the evening before the event, or when that
 * has passed, an hour before it. Nothing if the event is about to start or over.
 */
export function suggestPrepTime(eventStart: string, now: number, timezone: string): string | undefined {
  const startMs = Date.parse(eventStart);
  const eveningBefore = zonedToUtc(addDays(localParts(startMs, timezone).date, -1), EVENING_BEFORE, timezone);
  if (eveningBefore > now) return new Date(eveningBefore).toISOString();
  const shortly = startMs - SHORT_LEAD_MINUTES * 60_000;
  return shortly > now ? new Date(shortly).toISOString() : undefined;
}

export function applyExtraction(state: HomemindState, extraction: Extraction, actor: string, clock: Clock, options: ExtractionOptions): ExtractionResult | ChangeError {
  const now = clock.now();
  const timezone = state.family.timezone;
  let current = state;
  const events: CoreEvent[] = [];
  const created: CreatedEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const activityIds: string[] = [];
  const whys: Why[] = [];
  const liveVisible = () => current.items.filter(i => (i.status === 'open' || i.status === 'proposed') && canSee(current, actor, i));

  const create = (item: NewItem, entry: Omit<CreatedEntry, 'itemId'>): string | ChangeError => {
    const result = applyChange(current, { kind: 'create', item: { ...item, notes: entry.quote ? `“${entry.quote}”` : undefined, source: { ...options.source }, proposed: true } }, actor, clock);
    if (!result.ok) return result;
    current = result.state;
    events.push(...result.events);
    activityIds.push(result.activity.id);
    const itemId = result.items[0].id;
    created.push({ itemId, ...entry });
    if (entry.quote) {
      const taken = (id: string) => current.whys.some(w => w.id === id) || whys.some(w => w.id === id);
      let id = `why-${itemId}`;
      for (let n = 2; taken(id); n++) id = `why-${itemId}-${n}`;
      whys.push({
        id,
        summary: `“${entry.quote}”`,
        basis: [
          { kind: 'quote', ref: itemId, note: entry.quote },
          { kind: 'confidence', ref: itemId, note: entry.confidence.toFixed(2) }
        ],
        source: 'model'
      });
    }
    return itemId;
  };
  const room = () => created.length < MAX_CREATED;
  const meta = (quote: string, confidence: number, suggestedTime = false) => ({ quote, confidence, suggestedTime, unsure: confidence < UNSURE_BELOW });

  // Events, remembered by their extracted title so preparations can go under them.
  const eventIds = new Map<string, string>();
  const pastEvents = new Set<string>();
  for (const e of extraction.events) {
    if (!room()) break;
    const start = utc(e.start);
    if (!start) continue;
    const times = eventTimes(start, utc(e.end), false, timezone);
    if (Date.parse(times.end) <= now) {
      skipped.push({ kind: 'event', title: e.title, reason: 'past' });
      pastEvents.add(squash(e.title));
      continue;
    }
    const existing = liveVisible().find(i => i.type === 'event' && titleMatches(i, e.title) && sameMinute(i.start, times.start));
    if (existing) {
      skipped.push({ kind: 'event', title: e.title, reason: 'duplicate', itemId: existing.id });
      eventIds.set(squash(e.title), existing.id);
      continue;
    }
    const id = create({ type: 'event', title: e.title, ...times, forMemberIds: [] }, { kind: 'event', ...meta(e.quote, e.confidence) });
    if (typeof id !== 'string') return id;
    eventIds.set(squash(e.title), id);
  }

  const parentFor = (forEvent: string | undefined): Item | undefined => {
    const byId = (id: string | undefined) => (id ? current.items.find(i => i.id === id) : undefined);
    if (forEvent) {
      const exact = byId(eventIds.get(squash(forEvent)));
      if (exact) return exact;
      const fromHere = [...eventIds.entries()].find(([title]) => title.includes(squash(forEvent)) || squash(forEvent).includes(title));
      if (fromHere) return byId(fromHere[1]);
      const onBoard = liveVisible().filter(i => i.type === 'event' && titleMatches(i, forEvent) && (!i.end || Date.parse(i.end) > now));
      if (onBoard.length) return onBoard.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))[0];
    }
    // No event named: the preparation stands on its own as a task (a guess would put it in the wrong place).
    return undefined;
  };
  const forPastEvent = (forEvent: string | undefined) => !!forEvent && [...pastEvents].some(t => t === squash(forEvent) || t.includes(squash(forEvent)) || squash(forEvent).includes(t));

  for (const p of extraction.preparations) {
    if (!room()) break;
    const parent = parentFor(p.forEvent);
    // For an event that is already over, or due before now with nothing to go under: too late.
    if ((!parent && forPastEvent(p.forEvent)) || (!parent && p.due && Date.parse(p.due) <= now)) {
      skipped.push({ kind: 'preparation', title: p.title, reason: 'past' });
      continue;
    }
    let due = p.due && Date.parse(p.due) > now ? utc(p.due) : undefined;
    // "Bring X" often comes back due when the event starts, which is too late to prepare: suggest a time.
    if (due && parent?.start && Date.parse(due) >= Date.parse(parent.start)) due = undefined;
    let suggested = false;
    if (!due && parent?.start) {
      due = suggestPrepTime(parent.start, now, timezone);
      suggested = !!due;
    }
    const siblings = liveVisible().filter(i => (parent ? i.parentEventId === parent.id : i.type === 'task'));
    const existing = siblings.find(i => titleMatches(i, p.title) && (parent || sameMinute(i.start, due)));
    if (existing) {
      skipped.push({ kind: 'preparation', title: p.title, reason: 'duplicate', itemId: existing.id });
      continue;
    }
    const item: NewItem = parent
      ? { type: 'preparation', parentEventId: parent.id, title: p.title, ...(due ? { start: due } : {}), forMemberIds: [] }
      : { type: 'task', title: p.title, ...(due ? { start: due } : {}), forMemberIds: [] };
    const id = create(item, { kind: 'preparation', ...meta(p.quote, p.confidence, suggested) });
    if (typeof id !== 'string') return id;
  }

  for (const r of extraction.requests) {
    if (!room()) break;
    if (r.due && Date.parse(r.due) <= now) {
      skipped.push({ kind: 'request', title: r.text, reason: 'past' });
      continue;
    }
    const due = utc(r.due);
    const existing = liveVisible().find(i => i.type === 'task' && titleMatches(i, r.text) && sameMinute(i.start, due));
    if (existing) {
      skipped.push({ kind: 'request', title: r.text, reason: 'duplicate', itemId: existing.id });
      continue;
    }
    const id = create({ type: 'task', title: r.text.slice(0, 200), ...(due ? { start: due } : {}), forMemberIds: [] }, { kind: 'request', ...meta(r.quote, r.confidence) });
    if (typeof id !== 'string') return id;
  }

  if (whys.length) current = { ...current, whys: [...current.whys, ...whys] };
  return { ok: true, state: current, events, created, skipped, activityIds };
}
