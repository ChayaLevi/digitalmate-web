/**
 * Clock for Homemind: the real time plus a demo offset that only moves forward.
 *
 * All time logic takes a `Clock` instead of calling `Date.now()`, so tests use a fixed base and the
 * demo can jump ahead (`POST /api/homemind/demo/clock`). Also holds the time-zone helpers that turn a
 * family-local date and time into UTC. Pure: no node or browser APIs beyond `Intl`.
 */

export interface Clock {
  /** Milliseconds since the epoch, offset included. */
  now(): number;
}

export interface DemoClock extends Clock {
  offsetMs(): number;
  /** Jumps forward by `ms` (zero or more). Returns the new offset. */
  advance(ms: number): number;
  /** Sets the offset directly, for loading persisted state and for reset. */
  setOffset(ms: number): void;
}

function checkOffset(ms: number, what: string): void {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`${what} must be a finite number of ms, zero or more`);
}

export function createDemoClock(base: () => number = Date.now, initialOffsetMs = 0): DemoClock {
  checkOffset(initialOffsetMs, 'clock offset');
  let offset = initialOffsetMs;
  return {
    now: () => base() + offset,
    offsetMs: () => offset,
    advance(ms) {
      checkOffset(ms, 'clock jump');
      offset += ms;
      return offset;
    },
    setOffset(ms) {
      checkOffset(ms, 'clock offset');
      offset = ms;
    }
  };
}

/** A clock whose base time never moves. For tests. */
export function fixedClock(atMs: number, offsetMs = 0): DemoClock {
  return createDemoClock(() => atMs, offsetMs);
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface LocalParts {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:MM` */
  time: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClock(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour, mi: parts.minute, s: parts.second };
}

/** The zone's offset from UTC at `ms`, in ms (Asia/Shanghai gives +8 h). */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localParts(ms: number, timeZone: string): LocalParts {
  const w = wallClock(ms, timeZone);
  return {
    date: `${w.y}-${pad(w.mo)}-${pad(w.d)}`,
    time: `${pad(w.h)}:${pad(w.mi)}`,
    weekday: new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()
  };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The UTC instant of a local date and time in `timeZone`. In a daylight-saving gap the result is
 * shifted forward by the gap; in an overlap the earlier instant wins.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): number {
  const dm = DATE.exec(date);
  const tm = TIME.exec(time);
  if (!dm || !tm) throw new RangeError(`bad local date or time: ${date} ${time}`);
  const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  const candidates = [first, second];
  const exact = candidates.filter(ms => {
    const p = localParts(ms, timeZone);
    return p.date === date && p.time === time;
  });
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}

/** Adds whole days to a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  const dm = DATE.exec(date);
  if (!dm) throw new RangeError(`bad date: ${date}`);
  const d = new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]) + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
