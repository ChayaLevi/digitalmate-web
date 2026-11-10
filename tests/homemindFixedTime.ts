/**
 * T9.1: tests that run the bridge on the real clock depend on the time of day (after about 21:30 the
 * seeded "today's pickup" is tomorrow) and on the weekday (on a Tuesday "Tuesday to Saturday" is today,
 * not the seeded pickup). These helpers fix the wall clock instead: `Date` only, still moving in real
 * time, so timers, streams and timeouts behave as before.
 */
import { vi } from 'vitest';
import { zonedToUtc } from '../server/homemind/clock';
import { machineTimezone } from '../server/homemind/seed';

/** Wednesday 2026-11-11, 14:30 in the machine's zone (the zone the seed uses): the seeded pickup is at 16:30 today. */
export const FIXED_DEMO_START = zonedToUtc('2026-11-11', '14:30', machineTimezone());

/** Call in `beforeEach`; undo with `useRealTime()` in `afterEach`. */
export function useFixedTime(at: number = FIXED_DEMO_START): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(at);
}

export function useRealTime(): void {
  vi.useRealTimers();
}
