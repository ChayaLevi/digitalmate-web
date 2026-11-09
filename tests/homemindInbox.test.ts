import { describe, expect, it } from 'vitest';
import { applyChange } from '../server/homemind/core';
import { fixedClock } from '../server/homemind/clock';
import { approvedMail, inboxFor, servicesViewFor } from '../server/homemind/fakes';
import { planMailItem } from '../server/homemind/inbox';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';
import { eventFor, searchItems, viewFor, visibleItems } from '../server/homemind/visibility';

const ZONE = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 9, 2, 0); // Monday 2026-11-09 10:00 in Shanghai
const clock = fixedClock(NOW);
const seed = () => seedState({ now: NOW, timezone: ZONE });

/** Plans and applies the item for a mail as a member; throws if it does not create. */
function addMail(state: HomemindState, memberId: string, mailId: string) {
  const plan = planMailItem(state, memberId, mailId, NOW);
  if (!plan.ok || plan.duplicate) throw new Error(`no new item: ${JSON.stringify(plan)}`);
  const result = applyChange(state, plan.change, memberId, clock);
  if (!result.ok) throw new Error(result.message);
  return { state: result.state, item: result.items[0], events: result.events, activityId: result.activity.id };
}

describe('sample inbox: items from email (T8.3)', () => {
  it('only shows mail from approved senders, in the right mailboxes', () => {
    expect(inboxFor('mom', NOW).map(m => m.id).sort()).toEqual(['mail-1', 'mail-2']);
    expect(inboxFor('dad', NOW).map(m => m.id).sort()).toEqual(['mail-1', 'mail-3']);
    expect(inboxFor('maya', NOW)).toEqual([]);
    // The sale mail is in Mom's mailbox but its sender is not approved.
    expect(approvedMail(NOW).some(m => m.id === 'mail-4')).toBe(false);
  });

  it('creates a proposed all-day item from the mail, with its source and the quote', () => {
    const { item } = addMail(seed(), 'mom', 'mail-2');
    expect(item).toMatchObject({ type: 'task', status: 'proposed', allDay: true, title: 'Return the library books', titleZh: '归还图书馆的书' });
    expect(item.source).toMatchObject({ kind: 'email', simulated: true });
    expect(item.source.label).toContain('sample email');
    expect(item.sourceRefs).toEqual([{ id: 'mail-2', version: 1 }]);
    expect(item.notes).toContain('Two books on your card are due tomorrow.');
    expect(item.ownership).toEqual({ state: 'none' });
    // "due tomorrow" from Monday 9 Nov: Tuesday the 10th, local midnight to midnight.
    expect(item.start).toBe('2026-11-09T16:00:00.000Z');
    expect(item.end).toBe('2026-11-10T16:00:00.000Z');
  });

  it('resolves "next Wednesday" and "next Saturday" against the clock', () => {
    const wed = addMail(seed(), 'mom', 'mail-1').item;
    expect(wed.start).toBe('2026-11-10T16:00:00.000Z'); // Wed 11 Nov 00:00 Shanghai
    const sat = addMail(seed(), 'dad', 'mail-3').item;
    expect(sat.type).toBe('event');
    expect(sat.start).toBe('2026-11-13T16:00:00.000Z'); // Sat 14 Nov 00:00 Shanghai
  });

  it('is visible only to the mailbox owner until approved: not the other parent, not the teen', () => {
    const { state, item } = addMail(seed(), 'mom', 'mail-2');
    expect(item.mailboxIds).toEqual(['mom']);
    expect(visibleItems(state, 'mom').some(i => i.id === item.id)).toBe(true);
    for (const other of ['dad', 'maya']) {
      expect(visibleItems(state, other).some(i => i.id === item.id)).toBe(false);
      expect(viewFor(state, other)!.items.some(i => i.id === item.id)).toBe(false);
      expect(searchItems(state, other, 'Two books')).toEqual([]);
      // No trace in the activity either.
      expect(viewFor(state, other)!.activity.some(a => a.itemId === item.id)).toBe(false);
    }
    expect(searchItems(state, 'mom', 'Two books').map(i => i.id)).toEqual([item.id]);
  });

  it('sends no live event about it to anyone but the mailbox owner', () => {
    const { state, events } = addMail(seed(), 'mom', 'mail-2');
    expect(eventFor(state, 'mom', events[0])).not.toBeNull();
    expect(eventFor(state, 'dad', events[0])).toBeNull();
    expect(eventFor(state, 'maya', events[0])).toBeNull();
  });

  it('the other parent cannot approve it by id either', () => {
    const { state, item } = addMail(seed(), 'mom', 'mail-2');
    const approve = applyChange(state, { kind: 'approve', itemId: item.id, version: item.version }, 'dad', clock);
    expect(approve).toMatchObject({ ok: false, status: 404 });
  });

  it('approving makes it the whole family item, and Undo makes it private again', () => {
    const { state, item } = addMail(seed(), 'mom', 'mail-2');
    const approved = applyChange(state, { kind: 'approve', itemId: item.id, version: item.version }, 'mom', clock);
    if (!approved.ok) throw new Error(approved.message);
    const live = approved.items[0];
    expect(live.status).toBe('open');
    expect(live.mailboxIds).toBeUndefined();
    for (const who of ['mom', 'dad', 'maya']) expect(visibleItems(approved.state, who).some(i => i.id === item.id)).toBe(true);

    const undone = applyChange(approved.state, { kind: 'undo', activityId: approved.activity.id }, 'mom', clock);
    if (!undone.ok) throw new Error(undone.message);
    expect(visibleItems(undone.state, 'dad').some(i => i.id === item.id)).toBe(false);
    expect(visibleItems(undone.state, 'mom').some(i => i.id === item.id)).toBe(true);
  });

  it('one item when both parents got the same mail: it is in both mailboxes, and the second add creates nothing', () => {
    const { state, item } = addMail(seed(), 'mom', 'mail-1');
    expect(item.mailboxIds).toEqual(['mom', 'dad']);
    expect(visibleItems(state, 'dad').some(i => i.id === item.id)).toBe(true);
    expect(visibleItems(state, 'maya').some(i => i.id === item.id)).toBe(false);

    const again = planMailItem(state, 'dad', 'mail-1', NOW);
    expect(again).toMatchObject({ ok: true, duplicate: true });
    if (again.ok && again.duplicate) expect(again.item.id).toBe(item.id);
    expect(state.items.filter(i => i.sourceRefs?.some(r => r.id === 'mail-1'))).toHaveLength(1);

    // Either of them can approve it; then the whole family sees it.
    const approved = applyChange(state, { kind: 'approve', itemId: item.id, version: item.version }, 'dad', clock);
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(visibleItems(approved.state, 'maya').some(i => i.id === item.id)).toBe(true);
  });

  it('the same mail added twice by the same person is one item; a dismissed one can be added again', () => {
    const first = addMail(seed(), 'mom', 'mail-2');
    expect(planMailItem(first.state, 'mom', 'mail-2', NOW)).toMatchObject({ ok: true, duplicate: true });
    const dismissed = applyChange(first.state, { kind: 'dismiss', itemId: first.item.id, version: first.item.version }, 'mom', clock);
    if (!dismissed.ok) throw new Error(dismissed.message);
    expect(planMailItem(dismissed.state, 'mom', 'mail-2', NOW)).toMatchObject({ ok: true, duplicate: false });
  });

  it('refuses a mail that is not in your mailbox, an unapproved sender, and a member with no account', () => {
    const state = seed();
    expect(planMailItem(state, 'dad', 'mail-2', NOW)).toMatchObject({ ok: false, status: 404 }); // Mom's library mail
    expect(planMailItem(state, 'mom', 'mail-4', NOW)).toMatchObject({ ok: false, status: 404 }); // sender not approved
    expect(planMailItem(state, 'mom', 'mail-99', NOW)).toMatchObject({ ok: false, status: 404 });
    expect(planMailItem(state, 'noa', 'mail-1', NOW)).toMatchObject({ ok: false, status: 403 });
    expect(planMailItem(state, 'maya', 'mail-1', NOW)).toMatchObject({ ok: false, status: 404 });
  });

  it('a client cannot make an item private to a mailbox it is not in, or a non-proposed one', () => {
    const state = seed();
    const base = { type: 'task' as const, title: 'x' };
    expect(applyChange(state, { kind: 'create', item: { ...base, proposed: true, mailboxIds: ['dad'] } }, 'mom', clock)).toMatchObject({ ok: false, status: 400 });
    expect(applyChange(state, { kind: 'create', item: { ...base, mailboxIds: ['mom'] } }, 'mom', clock)).toMatchObject({ ok: false, status: 400 });
    expect(applyChange(state, { kind: 'create', item: { ...base, proposed: true, mailboxIds: ['mom', 'nobody'] } }, 'mom', clock)).toMatchObject({ ok: false, status: 400 });
  });

  it('the Services view marks mails that are already on the board, for those who can see the item', () => {
    const { state } = addMail(seed(), 'mom', 'mail-1');
    const mom = servicesViewFor(state, 'mom', NOW).inbox.messages;
    expect(mom.find(m => m.id === 'mail-1')?.added).toBe(true);
    expect(mom.find(m => m.id === 'mail-2')?.added).toBeUndefined();
    // Dad got the same mail, so it is on his board too.
    expect(servicesViewFor(state, 'dad', NOW).inbox.messages.find(m => m.id === 'mail-1')?.added).toBe(true);
    expect(servicesViewFor(state, 'dad', NOW).inbox.messages.find(m => m.id === 'mail-3')?.added).toBeUndefined();
  });
});
