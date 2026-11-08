/**
 * Live updates: a hub with one subscriber per open stream. Each member's stream only ever gets what
 * `visibility.ts` lets that member see, so a teen's stream carries no trace of a "Parents only" item.
 *
 * Pure of HTTP: a subscriber is a function. The bridge turns frames into SSE. No network, no timers.
 */
import type { AlertDelivery } from './alerts';
import type { CoreEvent } from './core';
import type { HomemindState, StreamMessage } from './types';
import { canSeeItem, eventFor } from './visibility';

export type Send = (message: StreamMessage) => void;

interface Subscriber {
  memberId: string;
  send: Send;
  /** Called when the hub drops this subscriber (too many streams, or `closeAll`). */
  close: () => void;
}

/** More open streams than this for one member (stale tabs): the oldest is closed. */
export const MAX_STREAMS_PER_MEMBER = 8;

export interface EventHub {
  /** Returns an unsubscribe function. */
  subscribe(memberId: string, send: Send, close: () => void): () => void;
  /** Sends each core event to each member who may see it, judged against `state` (the state after the change). */
  publishChanges(state: HomemindState, events: readonly CoreEvent[]): void;
  /** Each alert to its recipient's streams only, and only while that member may still see the item in `state`. */
  publishAlerts(state: HomemindState, deliveries: readonly AlertDelivery[]): void;
  /** A reminder was answered or stopped: close its alerts in these members' windows. */
  publishClosed(recipientIds: readonly string[], reminderId: string): void;
  /** Everyone, whatever they may see. Only for messages that carry no item. */
  broadcast(message: Extract<StreamMessage, { event: 'demo.reset' | 'clock' | 'settings.changed' | 'preferences.changed' | 'ppma.status' | 'memory.changed' | 'actions.changed' }>): void;
  count(memberId?: string): number;
  closeAll(): void;
}

export function createEventHub(): EventHub {
  let subscribers: Subscriber[] = [];

  const drop = (subscriber: Subscriber) => {
    subscribers = subscribers.filter(s => s !== subscriber);
  };

  // A failing subscriber (a dead socket) is dropped; it must never stop the others from being served.
  const deliver = (subscriber: Subscriber, message: StreamMessage) => {
    try {
      subscriber.send(message);
    } catch {
      drop(subscriber);
      try {
        subscriber.close();
      } catch {
        /* already gone */
      }
    }
  };

  return {
    subscribe(memberId, send, close) {
      const subscriber: Subscriber = { memberId, send, close };
      const mine = subscribers.filter(s => s.memberId === memberId);
      for (const old of mine.slice(0, Math.max(0, mine.length + 1 - MAX_STREAMS_PER_MEMBER))) {
        drop(old);
        old.close();
      }
      subscribers.push(subscriber);
      return () => drop(subscriber);
    },
    publishChanges(state, events) {
      for (const event of events) {
        for (const subscriber of [...subscribers]) {
          const visible = eventFor(state, subscriber.memberId, event);
          if (visible?.type === 'item.changed') deliver(subscriber, { event: 'item.changed', data: { itemId: visible.itemId, item: visible.item } });
        }
      }
    },
    publishAlerts(state, deliveries) {
      for (const { recipientId, alert } of deliveries) {
        const item = state.items.find(i => i.id === alert.itemId);
        if (!item || !canSeeItem(state, recipientId, item)) continue;
        for (const subscriber of subscribers.filter(s => s.memberId === recipientId)) deliver(subscriber, { event: 'alert', data: alert });
      }
    },
    publishClosed(recipientIds, reminderId) {
      for (const subscriber of subscribers.filter(s => recipientIds.includes(s.memberId))) deliver(subscriber, { event: 'alert.closed', data: { reminderId } });
    },
    broadcast(message) {
      for (const subscriber of [...subscribers]) deliver(subscriber, message);
    },
    count(memberId) {
      return memberId ? subscribers.filter(s => s.memberId === memberId).length : subscribers.length;
    },
    closeAll() {
      const all = subscribers;
      subscribers = [];
      for (const subscriber of all) {
        try {
          subscriber.close();
        } catch {
          /* already gone */
        }
      }
    }
  };
}
