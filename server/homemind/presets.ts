/**
 * Demo presets (T9.1): where the demo clock should stand for each scene of the script, whatever the
 * real day and time are. A preset is a reset to a fresh seed made **at** that moment (so "today's
 * pickup" is today, two hours ahead), with the clock offset that puts the demo clock there.
 *
 *   scene-1  the next weekday 14:30: today's pickup at 16:30, nobody has it yet
 *   scene-2  the next Monday 10:00, claims on for the class group (posting on its own, level 4): the
 *            party is "this Thursday" and the sign-up closes Wednesday 20:00, so it is still open
 *   scene-3  the next weekday 14:30: the pickup (16:30) and swimming are still ahead, for "Noa is sick"
 *   scene-4  the next Sunday 12:00: the pizza shop is open (not Mondays, 11:00–21:30), and Tuesday to
 *            Saturday covers the coming Friday and the seeded Tuesday pickup
 *   scene-5  the next Monday 19:30, claims on, the teacher's message and the 接龙 already posted: the
 *            "不着急" note is the next message, and the evening summary is 30 minutes away
 *
 * The clock only moves forward, so "next" means at or after the real now. Pure: no I/O.
 */
import { addDays, localParts, zonedToUtc } from './clock';
import type { HomemindState } from './types';

export const PRESET_IDS = ['scene-1', 'scene-2', 'scene-3', 'scene-4', 'scene-5'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface Preset {
  id: PresetId;
  /** Local weekdays it may land on (0 = Sunday). */
  weekdays: readonly number[];
  /** Local `HH:MM`. */
  time: string;
  /** Turn on claims for the simulated class group, posting on its own (level 4). */
  claims?: boolean;
  /** How many of the sample group messages to post at once (in order). */
  groupMessages?: number;
}

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

export const PRESETS: Record<PresetId, Preset> = {
  'scene-1': { id: 'scene-1', weekdays: WEEKDAYS, time: '14:30' },
  'scene-2': { id: 'scene-2', weekdays: [1], time: '10:00', claims: true },
  'scene-3': { id: 'scene-3', weekdays: WEEKDAYS, time: '14:30' },
  'scene-4': { id: 'scene-4', weekdays: [0], time: '12:00' },
  'scene-5': { id: 'scene-5', weekdays: [1], time: '19:30', claims: true, groupMessages: 2 }
};

export const isPresetId = (value: unknown): value is PresetId => typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value);

/**
 * The first instant at or after `now` whose local weekday is one of `weekdays` and whose local time is
 * `time`, in `timezone`. Always within the next 8 days.
 */
export function nextLocalTime(now: number, timezone: string, weekdays: readonly number[], time: string): number {
  if (!weekdays.length) throw new RangeError('weekdays must not be empty');
  const today = localParts(now, timezone).date;
  for (let d = 0; d <= 8; d++) {
    const date = addDays(today, d);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (!weekdays.includes(weekday)) continue;
    const at = zonedToUtc(date, time, timezone);
    if (at >= now) return at;
  }
  throw new RangeError('no such local time in the next 8 days');
}

/**
 * "Jump to next reminder": the next moment after `now` at which Homemind will tell someone something on
 * its own: a reminder's next attempt, or an evening summary that has something waiting for it (a
 * reminder moved to the summary, or a group message judged "not now"). `null` when nothing is due.
 */
export function nextDueAt(state: HomemindState, now: number): { at: number; kind: 'reminder' | 'summary' } | null {
  let best: { at: number; kind: 'reminder' | 'summary' } | null = null;
  const consider = (iso: string | undefined, kind: 'reminder' | 'summary') => {
    const at = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(at) && at > now && (!best || at < best.at)) best = { at, kind };
  };
  for (const r of state.reminders) {
    if (r.status === 'scheduled' || r.status === 'sent') {
      consider(r.fireAt, 'reminder');
      // The next escalation step (to the other parent, both parents, the backup) counts from the first attempt.
      const step = (r.escalation ?? [])[r.escalationsDone ?? 0];
      const first = r.firstAt ? Date.parse(r.firstAt) : NaN;
      if (step && Number.isFinite(first)) consider(new Date(first + step.afterMinutes * 60_000).toISOString(), 'reminder');
    }
    if (r.status === 'sent' && r.tier === 'summary') consider(r.summaryAt, 'summary');
  }
  for (const j of state.messageJudgments ?? []) if (j.tier === 'summary' && !j.deliveredIn) consider(j.summaryAt, 'summary');
  return best;
}

/** Where the demo clock goes for a preset, from the real time `now`. */
export const presetTime = (preset: PresetId, now: number, timezone: string): number => nextLocalTime(now, timezone, PRESETS[preset].weekdays, PRESETS[preset].time);
