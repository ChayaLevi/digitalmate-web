/**
 * Reads the Homemind live-update stream (`GET /api/homemind/events`) with `fetch`, not `EventSource`,
 * so the session token travels in a header and never in a URL. Reconnects with backoff.
 *
 * On every (re)connect the bridge sends `hello`; the host re-reads its screen then, which covers
 * anything missed while the stream was down.
 */
import { apiUrl } from '../lib/api';
import type { StreamMessage } from '../../server/homemind/types';

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
    case 'hello':
      return typeof record.memberId === 'string' && typeof record.now === 'string' ? { event: 'hello', data: { memberId: record.memberId, now: record.now } } : null;
    case 'item.changed':
      return typeof record.itemId === 'string' && 'item' in record ? { event: 'item.changed', data: { itemId: record.itemId, item: record.item as never } } : null;
    case 'demo.reset':
      return { event: 'demo.reset', data: {} };
    default:
      return null;
  }
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
