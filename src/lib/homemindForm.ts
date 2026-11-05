/**
 * Homemind Add and edit form (T3.2): pure helpers the Family tab uses on Save.
 *
 * The surface (src/lib/homemindSurfaces.ts, `edit` screen) carries each field's starting value in its
 * component's `default`; the host keeps what the member typed in a `form` map. On Save these helpers
 * turn both into one bridge request: `POST /items` for a new item, `PATCH /items/:id` with only the
 * changed fields for an edit. Dates and times in the form are local to the family's time zone; the
 * zone travels in the Save action's args. No network, no React, no clock.
 */
import type { A2uiSurface } from '../types';

export type FormValues = Record<string, unknown>;

/** Each named field's starting value (`defaults`) and its current value (`values`). */
export function formValues(surface: A2uiSurface, form: Record<string, unknown>): { values: FormValues; defaults: FormValues } {
  const values: FormValues = {};
  const defaults: FormValues = {};
  for (const component of Object.values(surface.components)) {
    const name = typeof component.name === 'string' ? component.name : '';
    if (!name) continue;
    const start = component.component === 'Toggle' ? component.default === true : typeof component.default === 'string' ? component.default : '';
    defaults[name] = start;
    values[name] = name in form ? form[name] : start;
  }
  return { values, defaults };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function zoneOffsetMs(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}

/** A local date and time in `zone` as a UTC ISO string, or null when they can't be read. */
export function localToIso(date: string, time: string, zone: string): string | null {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) return null;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (new Date(guess).toISOString().slice(0, 10) !== date) return null;
  try {
    const first = guess - zoneOffsetMs(guess, zone);
    const second = guess - zoneOffsetMs(first, zone);
    return new Date(second).toISOString();
  } catch {
    return null;
  }
}

export type FormProblem = 'title' | 'date' | 'time' | 'endTime' | 'endBeforeStart' | 'endNeedsStart' | 'awayNeedsEnd' | 'type';

export interface SaveRequest {
  method: 'POST' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
}

export type SaveResult = { ok: true; request: SaveRequest | null } | { ok: false; problem: FormProblem };

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));

function memberIds(values: FormValues, prefix: string): string[] {
  return Object.keys(values)
    .filter(key => key.startsWith(`${prefix}.`) && values[key] === true)
    .map(key => key.slice(prefix.length + 1))
    .sort();
}

/**
 * The bridge request for a Save. `args` are the Save action's args from the surface:
 * `{mode: 'create'|'edit', zone, type?, itemId?, version?, parentEventId?}`.
 * An edit with nothing changed gives `request: null`.
 */
export function buildSave(args: Record<string, unknown>, values: FormValues, defaults: FormValues): SaveResult {
  const mode = args.mode === 'edit' ? 'edit' : 'create';
  const zone = typeof args.zone === 'string' && args.zone ? args.zone : 'UTC';
  const type = typeof args.type === 'string' ? args.type : text(values.type);
  if (type !== 'event' && type !== 'task' && type !== 'preparation') return { ok: false, problem: 'type' };
  const changed = (name: string) => mode === 'create' || values[name] !== defaults[name];
  const fields: Record<string, unknown> = {};

  const title = text(values.title);
  if (!title) return { ok: false, problem: 'title' };
  if (changed('title')) fields.title = title;
  if (changed('notes') && (mode === 'edit' || text(values.notes))) fields.notes = text(values.notes);

  if (changed('date') || changed('time') || changed('endTime')) {
    const date = text(values.date);
    const time = text(values.time);
    const endTime = text(values.endTime);
    if (date && !DATE.test(date)) return { ok: false, problem: 'date' };
    if (time && !TIME.test(time)) return { ok: false, problem: 'time' };
    if (endTime && !TIME.test(endTime)) return { ok: false, problem: 'endTime' };
    if (endTime && !time) return { ok: false, problem: 'endNeedsStart' };
    if (!date) {
      if (time) return { ok: false, problem: 'date' };
      if (mode === 'edit') Object.assign(fields, { start: '', end: '' });
    } else if (!time) {
      // No time: an all-day item on that date, ending at the next local midnight (so "away" has an end).
      const start = localToIso(date, '00:00', zone);
      const end = localToIso(nextDate(date), '00:00', zone);
      if (!start || !end) return { ok: false, problem: 'date' };
      Object.assign(fields, { start, end, allDay: true });
    } else {
      const start = localToIso(date, time, zone);
      if (!start) return { ok: false, problem: 'date' };
      Object.assign(fields, { start, allDay: false });
      if (endTime) {
        if (endTime <= time) return { ok: false, problem: 'endBeforeStart' };
        fields.end = localToIso(date, endTime, zone);
      } else if (mode === 'edit') fields.end = '';
    }
  }

  const forNow = memberIds(values, 'for');
  if (mode === 'create' ? forNow.length > 0 : !sameList(forNow, memberIds(defaults, 'for'))) fields.forMemberIds = forNow;
  if (type === 'event') {
    const awayNow = memberIds(values, 'away');
    // Homemind checks who is away against the time span, so it needs to know when it ends.
    if (awayNow.length && text(values.time) && !text(values.endTime)) return { ok: false, problem: 'awayNeedsEnd' };
    if (mode === 'create' ? awayNow.length > 0 : !sameList(awayNow, memberIds(defaults, 'away'))) fields.unavailableMemberIds = awayNow;
  }
  if (changed('important') && (mode === 'edit' || values.important === true)) fields.importance = values.important === true ? 'critical' : 'normal';
  if ('parentsOnly' in values && changed('parentsOnly') && (mode === 'edit' || values.parentsOnly === true)) fields.visibility = values.parentsOnly === true ? 'parents' : 'family';

  if (mode === 'edit') {
    const itemId = typeof args.itemId === 'string' ? args.itemId : '';
    if (!itemId) return { ok: false, problem: 'type' };
    if (!Object.keys(fields).length) return { ok: true, request: null };
    return { ok: true, request: { method: 'PATCH', path: `/api/homemind/items/${encodeURIComponent(itemId)}`, body: { version: args.version, patch: fields } } };
  }
  const owner = text(values.owner);
  const body: Record<string, unknown> = { type, ...fields };
  if (owner && owner !== 'none') body.ownerId = owner;
  if (type === 'preparation') {
    if (typeof args.parentEventId !== 'string') return { ok: false, problem: 'type' };
    body.parentEventId = args.parentEventId;
  }
  return { ok: true, request: { method: 'POST', path: '/api/homemind/items', body } };
}

export type SettingsProblem = 'quietBoth' | 'quietTime' | 'quietSame' | 'backupName';

export type SettingsSaveResult = { ok: true; body: Record<string, unknown> | null } | { ok: false; problem: SettingsProblem };

/**
 * The `PUT /api/homemind/settings` body for the Settings form (T4.2), with only what changed, or
 * `body: null` when nothing did. `args` are the Save action's args: `{family, backupStored?, backupShown?}`.
 * The contact's name may be shown in Chinese (`backupShown`); unchanged, it is sent as stored.
 */
export function buildSettingsSave(args: Record<string, unknown>, values: FormValues, defaults: FormValues): SettingsSaveResult {
  const changed = (name: string) => name in values && values[name] !== defaults[name];
  const body: Record<string, unknown> = {};

  if (changed('quietFrom') || changed('quietTo')) {
    const from = text(values.quietFrom);
    const to = text(values.quietTo);
    if (!from && !to) body.quietHours = null;
    else if (!from || !to) return { ok: false, problem: 'quietBoth' };
    else if (!TIME.test(from) || !TIME.test(to)) return { ok: false, problem: 'quietTime' };
    else if (from === to) return { ok: false, problem: 'quietSame' };
    else body.quietHours = { from, to };
  }

  if (args.family === true) {
    if (changed('autonomy')) {
      const level = Number(values.autonomy);
      if ([1, 2, 3, 4].includes(level)) body.autonomy = level;
    }
    if (changed('paused')) body.paused = values.paused === true;
    if (text(values.backupName) !== text(defaults.backupName) || changed('backupChannel')) {
      const name = text(values.backupName);
      const channel = values.backupChannel === 'call' ? 'call' : 'sms';
      if (!name) body.backupContact = null;
      else if (name.length > 60) return { ok: false, problem: 'backupName' };
      else body.backupContact = { name: name === args.backupShown && typeof args.backupStored === 'string' ? args.backupStored : name, channel };
    }
  }
  return { ok: true, body: Object.keys(body).length ? body : null };
}
