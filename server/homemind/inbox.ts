/**
 * T8.3: the simulated mailbox becomes proposals. A member adds a sample email from an approved sender to the
 * board; the result is a `proposed` item that only the owners of the mailbox(es) that got the email can see,
 * until one of them approves it (then it is the family's, as any approved item). If both parents got the same
 * email there is one item, whichever of them adds it. Pure: it plans a core change, the bridge applies it.
 *
 * What an email asks for is written in the fixture (`MailAsk`); no model reads it, and everything here is
 * labelled simulated. A sender that is not approved is never shown and never turns into anything.
 */
import type { Change } from './core';
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import { approvedMail } from './fakes';
import type { SampleMail } from './fakes';
import type { HomemindState, Item } from './types';

export type InboxPlan =
  | { ok: true; duplicate: false; change: Extract<Change, { kind: 'create' }>; mail: SampleMail }
  /** The email already has an item (from this mailbox or another one that got it): nothing to create. */
  | { ok: true; duplicate: true; item: Item; mail: SampleMail }
  | { ok: false; status: 403 | 404 | 409; code: string; message: string };

const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The first date after `today` that falls on `weekday`. */
function nextWeekday(today: string, weekday: number): string {
  for (let n = 1; n <= 7; n++) {
    const date = addDays(today, n);
    if (weekdayOf(date) === weekday) return date;
  }
  return addDays(today, 7);
}

/** An item from this mail that is still alive (a dismissed one can be added again). */
function itemFromMail(state: HomemindState, mailId: string): Item | undefined {
  return state.items.find(i => i.status !== 'cancelled' && (i.sourceRefs ?? []).some(r => r.id === mailId));
}

/**
 * Plans the item for `mailId` as `memberId`. The mail must be in that member's own mailbox and from an
 * approved sender; anything else is "no such message" (nobody learns what is in another mailbox).
 */
export function planMailItem(state: HomemindState, memberId: string, mailId: string, now: number): InboxPlan {
  const member = state.family.members.find(m => m.id === memberId);
  if (!member || !member.hasAccount) return { ok: false, status: 403, code: 'forbidden', message: 'Only a member with an account has a mailbox' };
  const mail = approvedMail(now).find(m => m.id === mailId && m.to.includes(memberId));
  if (!mail) return { ok: false, status: 404, code: 'not_found', message: 'No such message in your mailbox' };
  if (!mail.ask) return { ok: false, status: 409, code: 'nothing_to_add', message: 'This message does not ask for anything' };

  const existing = itemFromMail(state, mail.id);
  if (existing) return { ok: true, duplicate: true, item: existing, mail };

  const zone = state.family.timezone;
  const today = localParts(now, zone).date;
  const date = mail.ask.weekday !== undefined ? nextWeekday(today, mail.ask.weekday) : addDays(today, mail.ask.daysAhead ?? 1);
  // Everyone with an account whose mailbox got it can see the proposal; a child with no account has no mailbox.
  const mailboxIds = state.family.members.filter(m => m.hasAccount && mail.to.includes(m.id)).map(m => m.id);
  const change: Extract<Change, { kind: 'create' }> = {
    kind: 'create',
    item: {
      type: mail.ask.type,
      title: mail.ask.title,
      titleZh: mail.ask.titleZh,
      notes: `“${mail.body}”`,
      start: toIso(zonedToUtc(date, '00:00', zone)),
      end: toIso(zonedToUtc(addDays(date, 1), '00:00', zone)),
      allDay: true,
      source: { kind: 'email', label: `${mail.fromName} (sample email)`, simulated: true },
      proposed: true,
      sourceRefs: [{ id: mail.id, version: mail.version }],
      mailboxIds
    }
  };
  return { ok: true, duplicate: false, change, mail };
}
