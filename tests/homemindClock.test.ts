import { describe, expect, it } from 'vitest';
import { addDays, createDemoClock, fixedClock, localParts, toIso, zonedToUtc } from '../server/homemind/clock';

const BASE = Date.UTC(2026, 10, 4, 2, 0); // 2026-11-04 10:00 in Asia/Shanghai
const MINUTE = 60_000;

describe('demo clock', () => {
  it('starts at the base time with no offset', () => {
    const clock = fixedClock(BASE);
    expect(clock.now()).toBe(BASE);
    expect(clock.offsetMs()).toBe(0);
  });

  it('jumps forward and keeps the offset', () => {
    const clock = fixedClock(BASE);
    expect(clock.advance(30 * MINUTE)).toBe(30 * MINUTE);
    expect(clock.advance(15 * MINUTE)).toBe(45 * MINUTE);
    expect(clock.now()).toBe(BASE + 45 * MINUTE);
  });

  it('adds the offset to a moving base', () => {
    let real = BASE;
    const clock = createDemoClock(() => real, 10 * MINUTE);
    real += MINUTE;
    expect(clock.now()).toBe(BASE + 11 * MINUTE);
  });

  it('refuses to go back, or to take a bad number', () => {
    const clock = fixedClock(BASE);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => clock.setOffset(-5)).toThrow(RangeError);
    expect(() => createDemoClock(Date.now, -1)).toThrow(RangeError);
    expect(clock.now()).toBe(BASE);
  });

  it('can be set back to zero, as reset does', () => {
    const clock = fixedClock(BASE, 2 * 60 * MINUTE);
    clock.setOffset(0);
    expect(clock.now()).toBe(BASE);
  });
});

describe('time-zone helpers', () => {
  it('reads local date, time and weekday', () => {
    expect(localParts(BASE, 'Asia/Shanghai')).toEqual({ date: '2026-11-04', time: '10:00', weekday: 3 });
    // 02:00 UTC is still the evening before in New York
    expect(localParts(BASE, 'America/New_York')).toEqual({ date: '2026-11-03', time: '21:00', weekday: 2 });
  });

  it('turns a local time into UTC', () => {
    expect(toIso(zonedToUtc('2026-11-04', '16:30', 'Asia/Shanghai'))).toBe('2026-11-04T08:30:00.000Z');
    expect(toIso(zonedToUtc('2026-11-05', '00:00', 'Asia/Shanghai'))).toBe('2026-11-04T16:00:00.000Z');
    expect(toIso(zonedToUtc('2026-07-01', '12:00', 'Asia/Jerusalem'))).toBe('2026-07-01T09:00:00.000Z');
  });

  it('round-trips through localParts', () => {
    for (const zone of ['Asia/Shanghai', 'Asia/Jerusalem', 'America/New_York', 'UTC']) {
      const ms = zonedToUtc('2026-11-04', '07:45', zone);
      expect(localParts(ms, zone)).toMatchObject({ date: '2026-11-04', time: '07:45' });
    }
  });

  it('handles daylight-saving changes', () => {
    // New York springs forward on 2026-03-08: 02:30 does not exist, so it moves forward
    expect(localParts(zonedToUtc('2026-03-08', '02:30', 'America/New_York'), 'America/New_York').time).toBe('03:30');
    // Falls back on 2026-11-01: 01:30 happens twice, and the earlier one wins
    expect(toIso(zonedToUtc('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects malformed input', () => {
    expect(() => zonedToUtc('2026-11-4', '10:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtc('2026-11-04', '24:00', 'UTC')).toThrow(RangeError);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
