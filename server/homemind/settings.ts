/**
 * Family and member settings (T4.2): quiet hours, autonomy, pause and the backup contact.
 *
 * Pure: no I/O. The bridge validates the request body with `parseSettingsPatch`, then calls
 * `applySettings`. Quiet hours are the member's own; everything else belongs to the family and only a
 * parent may change it. A change writes one `settings` activity (no Undo: settings are changed back
 * the same way they were set). The backup contact is always simulated in this version: nothing is
 * ever sent to it (reminders.ts stores a fixed message with no details).
 */
import type { Activity, AutonomyLevel, BackupContact, HeldAlert, HomemindState, Member } from './types';
import { inQuietHours, quietHoursEnd } from './reminders';

export type SettingKey = 'quietHours' | 'autonomy' | 'paused' | 'backupContact';

export interface SettingsPatch {
  /** The signed-in member's own quiet hours. `null` turns them off. */
  quietHours?: { from: string; to: string } | null;
  autonomy?: AutonomyLevel;
  paused?: boolean;
  /** `null` removes the backup contact. */
  backupContact?: { name: string; channel: BackupContact['channel'] } | null;
}

export const FAMILY_SETTINGS: readonly SettingKey[] = ['autonomy', 'paused', 'backupContact'];
const KEYS: readonly SettingKey[] = ['quietHours', ...FAMILY_SETTINGS];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_NAME = 60;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export type ParseResult = { ok: true; patch: SettingsPatch } | { ok: false; message: string };

/** Checks a request body. Unknown fields, wrong types and bad times are refused, never ignored. */
export function parseSettingsPatch(body: unknown): ParseResult {
  if (!isObject(body)) return { ok: false, message: 'settings must be an object' };
  const extra = Object.keys(body).find(key => !(KEYS as readonly string[]).includes(key));
  if (extra) return { ok: false, message: `Unknown settings field: ${extra.slice(0, 40)}` };
  const patch: SettingsPatch = {};

  if ('quietHours' in body) {
    const q = body.quietHours;
    if (q === null) patch.quietHours = null;
    else {
      if (!isObject(q) || Object.keys(q).some(k => k !== 'from' && k !== 'to')) return { ok: false, message: 'quietHours must be {from, to} or null' };
      if (typeof q.from !== 'string' || !TIME.test(q.from) || typeof q.to !== 'string' || !TIME.test(q.to)) return { ok: false, message: 'quietHours times must be HH:MM' };
      if (q.from === q.to) return { ok: false, message: 'quietHours must start and end at different times' };
      patch.quietHours = { from: q.from, to: q.to };
    }
  }
  if ('autonomy' in body) {
    const level = body.autonomy;
    if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return { ok: false, message: 'autonomy must be 1, 2, 3 or 4' };
    patch.autonomy = level;
  }
  if ('paused' in body) {
    if (typeof body.paused !== 'boolean') return { ok: false, message: 'paused must be true or false' };
    patch.paused = body.paused;
  }
  if ('backupContact' in body) {
    const b = body.backupContact;
    if (b === null) patch.backupContact = null;
    else {
      if (!isObject(b) || Object.keys(b).some(k => k !== 'name' && k !== 'channel')) return { ok: false, message: 'backupContact must be {name, channel} or null' };
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, message: `backupContact name must be 1 to ${MAX_NAME} characters` };
      if (b.channel !== 'sms' && b.channel !== 'call') return { ok: false, message: 'backupContact channel must be sms or call' };
      patch.backupContact = { name, channel: b.channel };
    }
  }
  return { ok: true, patch };
}

export type ApplyResult =
  | { ok: true; state: HomemindState; changed: SettingKey[]; activity?: Activity }
  | { ok: false; status: 403 | 404; code: 'forbidden' | 'not_found'; message: string };

const sameQuiet = (a: Member['quietHours'], b: Member['quietHours']) => (a?.from ?? '') === (b?.from ?? '') && (a?.to ?? '') === (b?.to ?? '');

function newActivityId(state: HomemindState, now: number): string {
  const base = `act-${Math.max(0, Math.floor(now)).toString(36)}`;
  const taken = (id: string) => state.activity.some(a => a.id === id);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Applies a checked patch as `actorId`. Fields equal to what is stored are not changes. A member who
 * changes their quiet hours gets their held alerts re-timed: released at once if the new hours do not
 * cover now, otherwise at the new end.
 */
export function applySettings(state: HomemindState, patch: SettingsPatch, actorId: string, now: number): ApplyResult {
  const actor = state.family.members.find(m => m.id === actorId);
  if (!actor || !actor.hasAccount) return { ok: false, status: 404, code: 'not_found', message: 'No such member' };
  const familyFields = FAMILY_SETTINGS.filter(key => key in patch);
  if (familyFields.length && actor.role !== 'parent') return { ok: false, status: 403, code: 'forbidden', message: 'Only a parent can change family settings' };

  const family = state.family;
  const changed: SettingKey[] = [];
  let members = family.members;
  let heldAlerts = state.heldAlerts;

  if (patch.quietHours !== undefined && !sameQuiet(actor.quietHours, patch.quietHours ?? undefined)) {
    changed.push('quietHours');
    const updated: Member = { ...actor };
    if (patch.quietHours) updated.quietHours = { ...patch.quietHours };
    else delete updated.quietHours;
    members = members.map(m => (m.id === actor.id ? updated : m));
    if (heldAlerts?.some(h => h.recipientId === actor.id)) {
      const releaseAt = new Date(inQuietHours(updated, now, family.timezone) ? quietHoursEnd(updated, now, family.timezone) : now).toISOString();
      heldAlerts = heldAlerts.map((h): HeldAlert => (h.recipientId === actor.id ? { ...h, releaseAt } : h));
    }
  }

  let autonomy = family.autonomy;
  if (patch.autonomy !== undefined && patch.autonomy !== family.autonomy.default) {
    changed.push('autonomy');
    autonomy = { ...family.autonomy, default: patch.autonomy };
  }
  let paused = family.paused;
  if (patch.paused !== undefined && patch.paused !== family.paused) {
    changed.push('paused');
    paused = patch.paused;
  }
  let backupContact = family.backupContact;
  if (patch.backupContact !== undefined) {
    const old = family.backupContact;
    const next = patch.backupContact;
    if (next === null ? old !== undefined : !old || old.name !== next.name || old.channel !== next.channel) {
      changed.push('backupContact');
      // The seeded Chinese name belongs to the seeded name only.
      backupContact = next === null ? undefined : { name: next.name, ...(old?.nameZh && old.name === next.name ? { nameZh: old.nameZh } : {}), channel: next.channel, simulated: true };
    }
  }

  if (changed.length === 0) return { ok: true, state, changed };

  const nextFamily = { ...family, members, autonomy, paused };
  if (backupContact) nextFamily.backupContact = backupContact;
  else delete nextFamily.backupContact;
  const activity: Activity = {
    id: newActivityId(state, now),
    at: new Date(now).toISOString(),
    actor: actor.id,
    what: `changed settings: ${changed.join(', ')}`,
    kind: 'settings',
    memberId: actor.id,
    note: changed.join(',')
  };
  return {
    ok: true,
    changed,
    activity,
    state: { ...state, family: nextFamily, activity: [...state.activity, activity], ...(heldAlerts ? { heldAlerts } : {}) }
  };
}
