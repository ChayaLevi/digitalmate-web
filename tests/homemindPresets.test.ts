import { describe, expect, it } from 'vitest';
import { localParts, zonedToUtc } from '../server/homemind/clock';
import { PRESETS, PRESET_IDS, isPresetId, nextDueAt, nextLocalTime, presetTime } from '../server/homemind/presets';
import { seedState } from '../server/homemind/seed';
import type { HomemindState, MessageJudgment, Reminder } from '../server/homemind/types';

const ZONE = 'Asia/Shanghai';
const at = (date: string, time: string) => zonedToUtc(date, time, ZONE);
const local = (ms: number) => localParts(ms, ZONE);

describe('nextLocalTime (T9.1)', () => {
  it('is today when the time is still ahead, and never in the past', () => {
    expect(nextLocalTime(at('2026-11-11', '09:00'), ZONE, [3], '14:30')).toBe(at('2026-11-11', '14:30'));
    expect(nextLocalTime(at('2026-11-11', '14:30'), ZONE, [3], '14:30')).toBe(at('2026-11-11', '14:30'));
    expect(nextLocalTime(at('2026-11-11', '14:31'), ZONE, [3], '14:30')).toBe(at('2026-11-18', '14:30'));
  });

  it('picks the first allowed weekday', () => {
    // Friday evening: the next weekday is Monday.
    expect(nextLocalTime(at('2026-11-13', '22:00'), ZONE, [1, 2, 3, 4, 5], '14:30')).toBe(at('2026-11-16', '14:30'));
    expect(() => nextLocalTime(Date.now(), ZONE, [], '10:00')).toThrow(RangeError);
  });
});

describe('scene presets (T9.1)', () => {
  // Every day of a week, at 06:00, 13:00, 21:45 and 23:59: the presets never land in the past or more than a week ahead.
  const starts: number[] = [];
  for (let d = 9; d <= 15; d++) for (const t of ['06:00', '13:00', '21:45', '23:59']) starts.push(at(`2026-11-${String(d).padStart(2, '0')}`, t));

  it.each(PRESET_IDS)('%s lands on its weekday and time, at or after now, within 8 days', id => {
    for (const now of starts) {
      const target = presetTime(id, now, ZONE);
      expect(target).toBeGreaterThanOrEqual(now);
      expect(target - now).toBeLessThanOrEqual(8 * 24 * 3600 * 1000);
      expect(PRESETS[id].weekdays).toContain(local(target).weekday);
      expect(local(target).time).toBe(PRESETS[id].time);
    }
  });

  it('Scenes 1 and 3: the seed made at the preset has today’s pickup ahead, today (even when the real time is 23:59)', () => {
    for (const id of ['scene-1', 'scene-3'] as const) {
      const target = presetTime(id, at('2026-11-10', '23:59'), ZONE);
      const pickup = seedState({ now: target, timezone: ZONE }).items.find(i => i.id === 'pickup-today');
      expect(local(Date.parse(pickup?.start as string)).date).toBe(local(target).date);
      expect(Date.parse(pickup?.start as string)).toBeGreaterThan(target);
    }
  });

  it('Scene 4: Sunday noon, when the simulated pizza shop is open, with the seeded Tuesday pickup two days ahead', () => {
    const target = presetTime('scene-4', at('2026-11-10', '23:00'), ZONE);
    expect(local(target)).toMatchObject({ weekday: 0, time: '12:00' });
    const tuesday = seedState({ now: target, timezone: ZONE }).items.find(i => i.id === 'pickup-tuesday');
    expect(Date.parse(tuesday?.start as string) - target).toBeLessThan(3 * 24 * 3600 * 1000);
  });

  it('knows its ids', () => {
    expect(isPresetId('scene-2')).toBe(true);
    expect(isPresetId('scene-9')).toBe(false);
    expect(isPresetId(2)).toBe(false);
  });
});

describe('nextDueAt: "Jump to next reminder" (T9.1)', () => {
  const now = at('2026-11-11', '14:30');
  const base = (): HomemindState => seedState({ now, timezone: ZONE });
  const reminder = (fields: Partial<Reminder>): Reminder => ({ id: 'r', itemId: 'pickup-today', recipientIds: ['dad'], tier: 'timed', attempts: 0, status: 'scheduled', ...fields });

  it('is null on a fresh board', () => {
    expect(nextDueAt(base(), now)).toBeNull();
  });

  it('takes the earliest attempt or summary still ahead, and skips answered ones', () => {
    const state: HomemindState = {
      ...base(),
      reminders: [
        reminder({ id: 'r1', fireAt: new Date(now + 90 * 60_000).toISOString() }),
        reminder({ id: 'r2', fireAt: new Date(now + 30 * 60_000).toISOString(), status: 'acknowledged' }),
        reminder({ id: 'r3', fireAt: new Date(now - 60_000).toISOString() }),
        reminder({ id: 'r4', fireAt: new Date(now + 60 * 60_000).toISOString(), status: 'sent' })
      ]
    };
    expect(nextDueAt(state, now)).toEqual({ at: now + 60 * 60_000, kind: 'reminder' });
  });

  it('stops at the next escalation step too, counted from the first attempt (Scene 1: Mom is told before the pickup)', () => {
    const firstAt = new Date(now + 60 * 60_000).toISOString();
    const r = reminder({ status: 'sent', attempts: 3, firstAt, fireAt: undefined, escalationsDone: 0, escalation: [{ afterMinutes: 30, to: 'next-parent' }, { afterMinutes: 40, to: 'backup' }] });
    expect(nextDueAt({ ...base(), reminders: [r] }, now + 85 * 60_000)).toEqual({ at: now + 90 * 60_000, kind: 'reminder' });
    expect(nextDueAt({ ...base(), reminders: [{ ...r, escalationsDone: 1 }] }, now + 91 * 60_000)).toEqual({ at: now + 100 * 60_000, kind: 'reminder' });
    expect(nextDueAt({ ...base(), reminders: [{ ...r, escalationsDone: 2 }] }, now + 101 * 60_000)).toBeNull();
  });

  it('includes the evening summary when a group message waits for it', () => {
    const judgment = { messageId: 'm', groupId: 'g', tier: 'summary', summaryAt: new Date(at('2026-11-11', '20:00')).toISOString() } as unknown as MessageJudgment;
    expect(nextDueAt({ ...base(), messageJudgments: [judgment] }, now)).toEqual({ at: at('2026-11-11', '20:00'), kind: 'summary' });
    expect(nextDueAt({ ...base(), messageJudgments: [{ ...judgment, deliveredIn: 'sum-1' }] }, now)).toBeNull();
  });
});
