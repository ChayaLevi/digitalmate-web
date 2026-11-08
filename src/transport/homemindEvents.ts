/**
 * Reads the Homemind live-update stream (`GET /api/homemind/events`) with `fetch`, not `EventSource`,
 * so the session token travels in a header and never in a URL. Reconnects with backoff.
 *
 * On every (re)connect the bridge sends `hello`; the host re-reads its screen then, which covers
 * anything missed while the stream was down.
 */
import { apiUrl } from '../lib/api';
import type { AlertBatchEntry, HomemindAlert, PpmaStatus, StreamMessage } from '../../server/homemind/types';

export const SESSION_HEADER = 'x-homemind-session';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'signed-out' | 'closed';

/** Splits a text stream into SSE frames. Comments (`: ping`) and unknown fields are ignored. */
export function createSseParser(onFrame: (frame: { event: string; data: string }) => void): { push(chunk: string): void } {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) onFrame({ event, data: data.join('\n') });
      }
    }
  };
}

/** A frame that is a known message with the right shape, else null. Anything else is ignored. */
export function toStreamMessage(frame: { event: string; data: string }): StreamMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  switch (frame.event) {
    case 'hello': {
      const clock = toClock(record);
      if (typeof record.memberId !== 'string' || !clock) return null;
      const ppma = toPpmaStatus(record.ppma);
      return { event: 'hello', data: { memberId: record.memberId, ...clock, ...(ppma ? { ppma } : {}) } };
    }
    case 'clock': {
      const clock = toClock(record);
      return clock ? { event: 'clock', data: clock } : null;
    }
    case 'item.changed':
      return typeof record.itemId === 'string' && 'item' in record ? { event: 'item.changed', data: { itemId: record.itemId, item: record.item as never } } : null;
    case 'alert': {
      const alert = toAlert(record);
      return alert ? { event: 'alert', data: alert } : null;
    }
    case 'alert.closed':
      return str(record.reminderId, 64) ? { event: 'alert.closed', data: { reminderId: record.reminderId } } : null;
    case 'settings.changed':
      return { event: 'settings.changed', data: {} };
    case 'preferences.changed':
      return { event: 'preferences.changed', data: {} };
    case 'memory.changed':
      return { event: 'memory.changed', data: {} };
    case 'ppma.status': {
      const status = toPpmaStatus(record.status);
      return status ? { event: 'ppma.status', data: { status } } : null;
    }
    case 'demo.reset':
      return { event: 'demo.reset', data: {} };
    default:
      return null;
  }
}

const PPMA_STATUSES: readonly PpmaStatus[] = ['off', 'connecting', 'ok', 'offline'];
const toPpmaStatus = (value: unknown): PpmaStatus | null => (PPMA_STATUSES.includes(value as PpmaStatus) ? (value as PpmaStatus) : null);

const str = (value: unknown, max = 300): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function toClock(record: Record<string, unknown>): { now: string; offsetMs: number; timezone: string } | null {
  const { now, offsetMs, timezone } = record;
  if (!str(now, 40) || !Number.isFinite(Date.parse(now)) || !str(timezone, 64)) return null;
  if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs) || offsetMs < 0) return null;
  return { now, offsetMs, timezone };
}

const ALERT_KINDS: readonly HomemindAlert['kind'][] = ['assigned', 'open', 'reminder', 'escalation', 'backup', 'batch'];
const ASKS = ['heads-up', 'confirm', 'open'] as const;
const MAX_ENTRIES = 20;

function toEntries(value: unknown): AlertBatchEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENTRIES) return null;
  const out: AlertBatchEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { itemId, title, titleZh, sensitive } = raw as Record<string, unknown>;
    if (!str(itemId, 64) || typeof sensitive !== 'boolean') return null;
    if ((title !== undefined && !str(title)) || (titleZh !== undefined && !str(titleZh))) return null;
    out.push({ itemId, sensitive, ...(!sensitive && title ? { title: title as string, ...(titleZh ? { titleZh: titleZh as string } : {}) } : {}) });
  }
  return out;
}

/** An `alert` frame's data with every field checked, else null. Unknown fields are dropped. */
export function toAlert(record: Record<string, unknown>): HomemindAlert | null {
  const { id, kind, itemId, itemVersion, tier, at, byId, byName, byNameZh, title, titleZh, sensitive } = record;
  const { reminderId, ask, time, recurring, contactName, contactNameZh, simulated, entries } = record;
  if (!str(id) || !ALERT_KINDS.includes(kind as HomemindAlert['kind']) || !str(itemId, 64) || !str(byId, 64) || !str(byName) || !str(at, 40)) return null;
  if (typeof itemVersion !== 'number' || !Number.isInteger(itemVersion) || itemVersion < 1) return null;
  if (tier !== 'urgent' && tier !== 'timed' && tier !== 'summary') return null;
  if (typeof sensitive !== 'boolean') return null;
  for (const optional of [byNameZh, title, titleZh, contactName, contactNameZh]) if (optional !== undefined && !str(optional)) return null;
  if (reminderId !== undefined && !str(reminderId, 64)) return null;
  if (ask !== undefined && !ASKS.includes(ask as (typeof ASKS)[number])) return null;
  if (time !== undefined && !(typeof time === 'string' && /^\d{2}:\d{2}$/.test(time))) return null;
  if ((recurring !== undefined && typeof recurring !== 'boolean') || (simulated !== undefined && typeof simulated !== 'boolean')) return null;
  const batch = kind === 'batch' ? toEntries(entries) : undefined;
  if (batch === null) return null;
  // Reminder kinds must say which reminder and what they ask, or their buttons can't work.
  if ((kind === 'reminder' || kind === 'escalation' || kind === 'backup') && (!reminderId || !ask)) return null;
  if (kind === 'backup' && !contactName) return null;
  return {
    id,
    kind: kind as HomemindAlert['kind'],
    itemId,
    itemVersion,
    tier,
    at,
    byId,
    byName,
    ...(byNameZh ? { byNameZh: byNameZh as string } : {}),
    // A sensitive item never shows its title, even if one were sent.
    ...(!sensitive && title ? { title: title as string, ...(titleZh ? { titleZh: titleZh as string } : {}) } : {}),
    sensitive,
    ...(reminderId ? { reminderId: reminderId as string } : {}),
    ...(ask ? { ask: ask as HomemindAlert['ask'] } : {}),
    // The time is left out for a sensitive item too.
    ...(!sensitive && time ? { time: time as string } : {}),
    ...(recurring ? { recurring: true } : {}),
    ...(contactName ? { contactName: contactName as string, ...(contactNameZh ? { contactNameZh: contactNameZh as string } : {}) } : {}),
    ...(simulated ? { simulated: true } : {}),
    ...(batch ? { entries: batch } : {})
  };
}

export interface StreamOptions {
  token: string;
  onMessage: (message: StreamMessage) => void;
  onStatus?: (status: StreamStatus) => void;
  fetchImpl?: typeof fetch;
  /** Resolves after `ms`, or early when aborted. Injected by tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  path?: string;
}

export const BACKOFF = { startMs: 1000, maxMs: 15000 } as const;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });

/** Starts reading. Call the returned function to stop (for a sign-out, a member switch, or unmount). */
export function connectHomemindEvents(options: StreamOptions): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const status = (value: StreamStatus) => options.onStatus?.(value);

  void (async () => {
    let delay: number = BACKOFF.startMs;
    let first = true;
    while (!signal.aborted) {
      status(first ? 'connecting' : 'reconnecting');
      first = false;
      try {
        const response = await doFetch(apiUrl(options.path ?? '/api/homemind/events'), {
          headers: { [SESSION_HEADER]: options.token, accept: 'text/event-stream' },
          signal
        });
        if (response.status === 401) {
          status('signed-out');
          return;
        }
        if (response.ok && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const parser = createSseParser(frame => {
            const message = toStreamMessage(frame);
            if (!message) return;
            if (message.event === 'hello') {
              delay = BACKOFF.startMs;
              status('live');
            }
            options.onMessage(message);
          });
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
        }
      } catch {
        if (signal.aborted) break;
      }
      if (signal.aborted) break;
      status('reconnecting');
      await sleep(delay, signal);
      delay = Math.min(delay * 2, BACKOFF.maxMs);
    }
    status('closed');
  })();

  return () => controller.abort();
}
