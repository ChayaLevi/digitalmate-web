import { describe, expect, it } from 'vitest';
import { alertsForChange } from '../server/homemind/alerts';
import { applyChange } from '../server/homemind/core';
import type { Change } from '../server/homemind/core';
import { createEventHub } from '../server/homemind/events';
import { seedState } from '../server/homemind/seed';
import type { HomemindAlert, HomemindState, Item, StreamMessage } from '../server/homemind/types';
import { MAX_ALERTS, addAlert, alertButtons, alertText, applyItemChange, stillRelevant } from '../src/lib/homemindAlerts';
import { toAlert, toStreamMessage } from '../src/transport/homemindEvents';

const NOW = Date.parse('2026-11-04T09:00:00Z');
const clock = { now: () => NOW };
const AT = new Date(NOW).toISOString();
const state = (): HomemindState => seedState({ now: NOW, timezone: 'Asia/Shanghai' });
const item = (st: HomemindState, id: string) => st.items.find(i => i.id === id) as Item;

function change(st: HomemindState, c: Change, actor: string) {
  const result = applyChange(st, c, actor, clock);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return { after: result.state, alerts: alertsForChange(st, result.state, result.events, actor, AT) };
}

const alert = (over: Partial<HomemindAlert> = {}): HomemindAlert => ({
  id: 'pickup-today.2.assigned',
  kind: 'assigned',
  itemId: 'pickup-today',
  itemVersion: 2,
  tier: 'timed',
  at: AT,
  byId: 'mom',
  byName: 'Mom',
  byNameZh: '妈妈',
  title: 'Kindergarten pickup',
  titleZh: '幼儿园接孩子',
  sensitive: false,
  ...over
});

describe('alerts made by a change', () => {
  it('Scene 1: Mom assigns the pickup to Dad, and only Dad gets "Mom assigned you"', () => {
    const st = state();
    const pickup = item(st, 'pickup-today');
    const { alerts } = change(st, { kind: 'assign', itemId: pickup.id, version: pickup.version, ownerId: 'dad' }, 'mom');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ recipientId: 'dad', alert: { kind: 'assigned', itemId: 'pickup-today', itemVersion: pickup.version + 1, byId: 'mom', byName: 'Mom', title: pickup.title, sensitive: false, tier: 'urgent' } });
    expect(alerts[0].alert.id).toBe(`pickup-today.${pickup.version + 1}.assigned`);
  });

  it('no alert to yourself: a claim, or assigning to yourself', () => {
    const st = state();
    const open = st.items.find(i => i.status === 'open' && i.ownership.state === 'open' && i.visibility === 'family') as Item;
    expect(open).toBeTruthy();
    expect(change(st, { kind: 'claim', itemId: open.id, version: open.version }, 'dad').alerts).toEqual([]);
    expect(change(st, { kind: 'assign', itemId: open.id, version: open.version, ownerId: 'mom' }, 'mom').alerts).toEqual([]);
  });

  it('confirming ("I\'m on it") or editing an item already assigned to you alerts nobody', () => {
    const st = state();
    const pickup = item(st, 'pickup-today');
    const assigned = change(st, { kind: 'assign', itemId: pickup.id, version: pickup.version, ownerId: 'dad' }, 'mom').after;
    const now = item(assigned, 'pickup-today');
    expect(change(assigned, { kind: 'confirm', itemId: now.id, version: now.version }, 'dad').alerts).toEqual([]);
    expect(change(assigned, { kind: 'edit', itemId: now.id, version: now.version, patch: { notes: 'Gate B' } }, 'mom').alerts).toEqual([]);
  });

  it('handing back opens the item: the other candidates get "Who\'s taking this?", the one who handed back does not', () => {
    const st = state();
    const pickup = item(st, 'pickup-today');
    const assigned = change(st, { kind: 'assign', itemId: pickup.id, version: pickup.version, ownerId: 'dad' }, 'mom').after;
    const now = item(assigned, 'pickup-today');
    const { alerts } = change(assigned, { kind: 'handback', itemId: now.id, version: now.version, note: 'Late meeting' }, 'dad');
    expect(alerts.map(a => a.recipientId)).toContain('mom');
    expect(alerts.map(a => a.recipientId)).not.toContain('dad');
    expect(alerts.every(a => a.alert.kind === 'open' && a.alert.byId === 'dad')).toBe(true);
  });

  it('a Parents-only, sensitive item never alerts a teen, and its title is left out for a parent', () => {
    const st = state();
    const secret = item(st, 'counselor-meeting');
    expect(secret.visibility).toBe('parents');
    expect(secret.sensitive).toBe(true);
    const { alerts } = change(st, { kind: 'assign', itemId: secret.id, version: secret.version, ownerId: 'dad' }, 'mom');
    expect(alerts.map(a => a.recipientId)).toEqual(['dad']);
    expect(alerts[0].alert.title).toBeUndefined();
    expect(alerts[0].alert.titleZh).toBeUndefined();
    expect(JSON.stringify(alerts)).not.toContain(secret.title);
    const opened = change(st, { kind: 'open', itemId: secret.id, version: secret.version }, 'mom').alerts;
    expect(opened.map(a => a.recipientId)).not.toContain('maya');
  });

  it('a proposed item alerts nobody', () => {
    const st = state();
    const created = applyChange(st, { kind: 'create', item: { type: 'task', title: 'From the group', forMemberIds: [], visibility: 'family', source: { kind: 'group', label: 'Group' }, ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } } } as Change, 'mom', clock);
    if (!created.ok) throw new Error(created.message);
    expect(item(created.state, created.items[0].id).status).toBe('proposed');
    expect(alertsForChange(st, created.state, created.events, 'mom', AT)).toEqual([]);
  });
});

describe('the hub delivers alerts', () => {
  it('only to the recipient, and not when the recipient can no longer see the item', () => {
    const st = state();
    const hub = createEventHub();
    const got: Record<string, StreamMessage[]> = { mom: [], dad: [], maya: [] };
    for (const id of Object.keys(got)) hub.subscribe(id, m => got[id].push(m), () => {});
    hub.publishAlerts(st, [{ recipientId: 'dad', alert: alert() }]);
    expect(got.dad).toEqual([{ event: 'alert', data: alert() }]);
    expect(got.mom).toEqual([]);
    expect(got.maya).toEqual([]);
    // A delivery addressed to a teen about a Parents-only item is dropped by the hub itself.
    hub.publishAlerts(st, [{ recipientId: 'maya', alert: alert({ itemId: 'counselor-meeting', id: 'counselor-meeting.2.assigned' }) }]);
    expect(got.maya).toEqual([]);
  });
});

describe('the client', () => {
  it('reads an alert frame and checks every field', () => {
    expect(toStreamMessage({ event: 'alert', data: JSON.stringify(alert()) })).toEqual({ event: 'alert', data: alert() });
    for (const bad of [{ kind: 'x' }, { itemVersion: 0 }, { itemVersion: '2' }, { tier: 'loud' }, { sensitive: 'no' }, { title: 5 }, { id: '' }]) {
      expect(toAlert({ ...alert(), ...bad } as Record<string, unknown>)).toBeNull();
    }
    // Unknown fields are dropped; a sensitive alert never keeps a title, even if one arrives.
    expect(toAlert({ ...alert(), extra: 'x' } as Record<string, unknown>)).not.toHaveProperty('extra');
    expect(toAlert({ ...alert(), sensitive: true } as Record<string, unknown>)).not.toHaveProperty('title');
  });

  it('words alerts neutrally in both languages, and a sensitive one says only "You have a reminder"', () => {
    expect(alertText(alert(), 'en')).toBe('Mom assigned you: Kindergarten pickup');
    expect(alertText(alert(), 'zh')).toBe('妈妈把「幼儿园接孩子」交给了你');
    expect(alertText(alert({ kind: 'open' }), 'en')).toBe("Who's taking this? Kindergarten pickup");
    expect(alertText(alert({ kind: 'open' }), 'zh')).toBe('谁来负责？幼儿园接孩子');
    const secret = alert({ sensitive: true, title: undefined, titleZh: undefined });
    expect(alertText(secret, 'en')).toBe('You have a reminder');
    expect(alertText(secret, 'zh')).toBe('你有一条提醒');
    expect(alertButtons(alert(), 'en').map(b => b.verb)).toEqual(['ack', 'open', 'dismiss']);
    expect(alertButtons(alert({ kind: 'open' }), 'zh').map(b => b.label)).toEqual(['我来', '查看', '关闭']);
  });

  it('keeps one alert per item and kind, newest first, at most MAX_ALERTS', () => {
    let list: HomemindAlert[] = [];
    list = addAlert(list, alert());
    list = addAlert(list, alert());
    expect(list).toHaveLength(1);
    list = addAlert(list, alert({ id: 'pickup-today.3.assigned', itemVersion: 3 }));
    expect(list.map(a => a.id)).toEqual(['pickup-today.3.assigned']);
    for (let i = 0; i < 5; i++) list = addAlert(list, alert({ id: `x${i}.1.open`, itemId: `x${i}`, kind: 'open' }));
    expect(list).toHaveLength(MAX_ALERTS);
    expect(list[0].itemId).toBe('x4');
  });

  it('an alert goes away once answered anywhere, and follows the item\'s version otherwise', () => {
    const st = state();
    const pickup = item(st, 'pickup-today');
    const mine: Item = { ...pickup, version: 5, ownership: { state: 'assigned', ownerId: 'dad', confirmed: false } };
    expect(stillRelevant(alert(), mine, 'dad')).toBe(true);
    expect(applyItemChange([alert()], 'pickup-today', mine, 'dad')).toEqual([alert({ itemVersion: 5 })]);
    expect(applyItemChange([alert()], 'pickup-today', { ...mine, ownership: { state: 'assigned', ownerId: 'dad', confirmed: true } }, 'dad')).toEqual([]);
    expect(applyItemChange([alert()], 'pickup-today', { ...mine, ownership: { state: 'assigned', ownerId: 'mom', confirmed: false } }, 'dad')).toEqual([]);
    expect(applyItemChange([alert()], 'pickup-today', null, 'dad')).toEqual([]);
    expect(applyItemChange([alert()], 'other', null, 'dad')).toEqual([alert()]);
    const openAlert = alert({ kind: 'open', id: 'pickup-today.5.open' });
    expect(applyItemChange([openAlert], 'pickup-today', { ...mine, ownership: { state: 'open', candidateIds: ['dad', 'mom'] } }, 'dad')).toHaveLength(1);
    // Someone else took it: the "Who's taking this?" alert closes for everyone.
    expect(applyItemChange([openAlert], 'pickup-today', { ...mine, ownership: { state: 'assigned', ownerId: 'mom', confirmed: true } }, 'dad')).toEqual([]);
  });
});
