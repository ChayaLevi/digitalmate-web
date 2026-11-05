/**
 * Live alerts made by a change (T3.3): "Mom assigned you: pickup" to the new owner, and "Who's taking
 * this?" to the candidates of an item that just became open. Never to the member who made the change.
 *
 * Pure: no I/O, no clock reads (the time is passed in). The hub checks visibility again before it
 * delivers anything, so an alert can never carry a "Parents only" item to a teen.
 * Quiet hours and batching are applied afterwards by `reminders.ts` (`tickReminders`), which also
 * makes the reminder and escalation alerts.
 */
import type { CoreEvent } from './core';
import type { AlertKind, HomemindAlert, HomemindState, Item } from './types';
import { canSeeItem } from './visibility';

export interface AlertDelivery {
  recipientId: string;
  alert: HomemindAlert;
}

function hasAccount(state: HomemindState, memberId: string): boolean {
  return state.family.members.some(m => m.id === memberId && m.hasAccount);
}

function makeAlert(state: HomemindState, item: Item, kind: AlertKind, actorId: string, at: string): HomemindAlert {
  const by = state.family.members.find(m => m.id === actorId);
  return {
    id: `${item.id}.${item.version}.${kind}`,
    kind,
    itemId: item.id,
    itemVersion: item.version,
    // A critical item (a child's pickup) breaks quiet hours; anything else waits for them to end.
    tier: item.importance === 'critical' ? 'urgent' : 'timed',
    at,
    byId: actorId,
    byName: by?.name ?? actorId,
    ...(by?.nameZh ? { byNameZh: by.nameZh } : {}),
    ...(item.sensitive ? {} : { title: item.title, ...(item.titleZh ? { titleZh: item.titleZh } : {}) }),
    sensitive: item.sensitive
  };
}

/**
 * The alerts for one applied change. `before` is the state the change was applied to, `after` the
 * result. Only live items (`status: 'open'`) alert; a proposed or removed item does not.
 */
export function alertsForChange(before: HomemindState, after: HomemindState, events: readonly CoreEvent[], actorId: string, at: string): AlertDelivery[] {
  const out: AlertDelivery[] = [];
  for (const event of events) {
    const item = event.item;
    if (!item || item.status !== 'open') continue;
    const previous = before.items.find(i => i.id === item.id);
    const was = previous && previous.status === 'open' ? previous.ownership : undefined;
    const now = item.ownership;
    let recipients: string[] = [];
    let kind: AlertKind | null = null;
    if (now.state === 'assigned' && !now.confirmed && !(was?.state === 'assigned' && was.ownerId === now.ownerId)) {
      kind = 'assigned';
      recipients = [now.ownerId];
    } else if (now.state === 'open' && was?.state !== 'open') {
      kind = 'open';
      recipients = now.candidateIds;
    }
    if (!kind) continue;
    for (const recipientId of recipients) {
      if (recipientId === actorId || !hasAccount(after, recipientId) || !canSeeItem(after, recipientId, item)) continue;
      out.push({ recipientId, alert: makeAlert(after, item, kind, actorId, at) });
    }
  }
  return out;
}
