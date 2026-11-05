import { describe, expect, it } from 'vitest';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import { pendingRemindersFor, tickReminders } from '../server/homemind/reminders';
import { seedState } from '../server/homemind/seed';
import { applySettings, parseSettingsPatch } from '../server/homemind/settings';
import type { HeldAlert, HomemindState, Item } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import { buildSettingsSave, formValues } from '../src/lib/homemindForm';
import { screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindLang, HomemindScreenData } from '../src/lib/homemindSurfaces';
import type { A2uiAction, A2uiSurface } from '../src/types';

// T4.2: settings (quiet hours, autonomy, pause, backup contact) and reminder answers on board rows.
const TZ = 'Asia/Shanghai';
const MIN = 60_000;
const NOW = Date.parse('2026-11-04T09:00:00Z'); // 17:00 in Shanghai
const at = (minutes: number) => NOW + minutes * MIN;
const seed = (): HomemindState => seedState({ now: NOW, timezone: TZ });

function patch(body: unknown) {
  const parsed = parseSettingsPatch(body);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.patch;
}

function apply(st: HomemindState, body: unknown, actor: string, when = NOW): HomemindState {
  const result = applySettings(st, patch(body), actor, when);
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

const member = (st: HomemindState, id: string) => st.family.members.find(m => m.id === id);

describe('parseSettingsPatch', () => {
  it('accepts each field and null to turn quiet hours or the backup contact off', () => {
    expect(patch({ quietHours: { from: '21:30', to: '06:45' } })).toEqual({ quietHours: { from: '21:30', to: '06:45' } });
    expect(patch({ quietHours: null, backupContact: null })).toEqual({ quietHours: null, backupContact: null });
    expect(patch({ autonomy: 2, paused: true })).toEqual({ autonomy: 2, paused: true });
    expect(patch({ backupContact: { name: '  Aunt Wei ', channel: 'call' } })).toEqual({ backupContact: { name: 'Aunt Wei', channel: 'call' } });
    expect(patch({})).toEqual({});
  });

  it.each([
    [[], 'object'],
    [{ theme: 'dark' }, 'Unknown settings field'],
    [{ quietHours: { from: '22:00' } }, 'HH:MM'],
    [{ quietHours: { from: '24:00', to: '07:00' } }, 'HH:MM'],
    [{ quietHours: { from: '7:00', to: '08:00' } }, 'HH:MM'],
    [{ quietHours: { from: '22:00', to: '22:00' } }, 'different'],
    [{ quietHours: { from: '22:00', to: '07:00', extra: 1 } }, '{from, to}'],
    [{ autonomy: 5 }, 'autonomy'],
    [{ autonomy: '3' }, 'autonomy'],
    [{ paused: 'yes' }, 'paused'],
    [{ backupContact: { name: '', channel: 'sms' } }, 'name'],
    [{ backupContact: { name: 'x'.repeat(61), channel: 'sms' } }, 'name'],
    [{ backupContact: { name: 'Bad\nname', channel: 'sms' } }, 'name'],
    [{ backupContact: { name: 'Aunt Wei', channel: 'wechat' } }, 'channel'],
    [{ backupContact: { name: 'Aunt Wei', channel: 'sms', simulated: false } }, '{name, channel}']
  ])('refuses %j', (body, message) => {
    const parsed = parseSettingsPatch(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(message);
  });
});

describe('applySettings', () => {
  it('sets the signed-in member’s own quiet hours and logs one settings activity, with no Undo', () => {
    const result = applySettings(seed(), patch({ quietHours: { from: '23:00', to: '06:00' } }), 'maya', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toEqual(['quietHours']);
    expect(member(result.state, 'maya')?.quietHours).toEqual({ from: '23:00', to: '06:00' });
    expect(member(result.state, 'mom')?.quietHours).toEqual({ from: '22:00', to: '07:00' });
    expect(result.activity).toMatchObject({ kind: 'settings', actor: 'maya', note: 'quietHours' });
    expect(result.activity?.undo).toBeUndefined();
    // The teen sees her own settings change in her activity, though it names no item.
    expect(viewFor(result.state, 'maya')?.activity.map(a => a.kind)).toContain('settings');
  });

  it('turns quiet hours off', () => {
    expect(member(apply(seed(), { quietHours: null }, 'dad'), 'dad')?.quietHours).toBeUndefined();
  });

  it('lets only a parent change the family settings', () => {
    for (const body of [{ autonomy: 4 }, { paused: true }, { backupContact: null }, { quietHours: null, paused: true }]) {
      const result = applySettings(seed(), patch(body), 'maya', NOW);
      expect(result).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
    }
    expect(applySettings(seed(), patch({ quietHours: null }), 'noa', NOW)).toMatchObject({ ok: false, status: 404 });
    expect(applySettings(seed(), patch({ paused: true }), 'nobody', NOW)).toMatchObject({ ok: false, status: 404 });
  });

  it('a parent sets autonomy and pause; values equal to what is stored are no change', () => {
    const st = apply(seed(), { autonomy: 1, paused: true }, 'mom');
    expect(st.family.autonomy.default).toBe(1);
    expect(st.family.paused).toBe(true);
    const same = applySettings(st, patch({ autonomy: 1, paused: true, quietHours: { from: '22:00', to: '07:00' } }), 'dad', NOW);
    expect(same).toMatchObject({ ok: true, changed: [] });
    if (same.ok) {
      expect(same.state).toBe(st);
      expect(same.activity).toBeUndefined();
    }
  });

  it('the backup contact is always simulated; its Chinese name stays only with its own name', () => {
    const st = seed();
    const channel = apply(st, { backupContact: { name: 'Grandma Lin', channel: 'call' } }, 'mom').family.backupContact;
    expect(channel).toEqual({ name: 'Grandma Lin', nameZh: '林奶奶', channel: 'call', simulated: true });
    const renamed = apply(st, { backupContact: { name: 'Aunt Wei', channel: 'sms' } }, 'mom').family.backupContact;
    expect(renamed).toEqual({ name: 'Aunt Wei', channel: 'sms', simulated: true });
    expect(apply(st, { backupContact: null }, 'dad').family.backupContact).toBeUndefined();
    expect('backupContact' in apply(st, { backupContact: null }, 'dad').family).toBe(false);
  });

  it('without a backup contact, a critical pickup escalates to the other parent and stops there', () => {
    let st = { ...seed(), items: seed().items.filter(i => i.id === 'pickup-today') };
    const pickup = st.items[0] as Item;
    const assigned = applyChange(st, { kind: 'assign', itemId: pickup.id, version: pickup.version, ownerId: 'dad' }, 'mom', fixedClock(NOW));
    if (!assigned.ok) throw new Error(assigned.message);
    st = apply(assigned.state, { backupContact: null }, 'mom');
    const start = Date.parse(pickup.start as string);
    let backups = 0;
    for (let m = 0; at(m) <= start; m += 1) {
      const t = tickReminders(st, at(m));
      st = t.state;
      backups += t.deliveries.filter(d => d.alert.kind === 'backup').length;
    }
    expect(backups).toBe(0);
    expect(st.backupMessages ?? []).toEqual([]);
    expect(st.reminders.find(r => r.itemId === pickup.id)?.escalatedToIds).toEqual(['mom']);
  });

  it('new quiet hours re-time the member’s held alerts: released now when they no longer cover now', () => {
    const night = Date.parse('2026-11-04T15:00:00Z'); // 23:00 in Shanghai, inside 22:00–07:00
    const held: HeldAlert = {
      recipientId: 'dad',
      releaseAt: '2026-11-04T23:00:00.000Z',
      alert: { id: 'x.1.assigned', kind: 'assigned', itemId: 'pickup-today', itemVersion: 1, tier: 'timed', at: new Date(night).toISOString(), byId: 'mom', byName: 'Mom', sensitive: false }
    };
    const st = { ...seed(), heldAlerts: [held, { ...held, recipientId: 'mom' }] };
    const off = apply(st, { quietHours: null }, 'dad', night);
    expect(off.heldAlerts?.map(h => [h.recipientId, h.releaseAt])).toEqual([
      ['dad', new Date(night).toISOString()],
      ['mom', '2026-11-04T23:00:00.000Z']
    ]);
    const later = apply(st, { quietHours: { from: '22:00', to: '08:00' } }, 'dad', night);
    expect(later.heldAlerts?.[0].releaseAt).toBe('2026-11-05T00:00:00.000Z');
  });

  it('pause still lets reminders fire', () => {
    let st = { ...seed(), items: seed().items.filter(i => i.id === 'pickup-today') };
    const pickup = st.items[0] as Item;
    const assigned = applyChange(st, { kind: 'assign', itemId: pickup.id, version: pickup.version, ownerId: 'dad' }, 'mom', fixedClock(NOW));
    if (!assigned.ok) throw new Error(assigned.message);
    st = apply(assigned.state, { paused: true }, 'mom');
    const start = Date.parse(pickup.start as string);
    const t = tickReminders(st, start - 60 * MIN);
    expect(t.deliveries.map(d => [d.recipientId, d.alert.kind])).toContainEqual(['dad', 'reminder']);
  });
});

// --- the Settings screen and the reminder buttons on rows ------------------------------------------------

function input(st: HomemindState, memberId: string, lang: HomemindLang, now = NOW): HomemindScreenData {
  const view = viewFor(st, memberId);
  if (!view) throw new Error('no view');
  return { lang, now: new Date(now).toISOString(), view, llm: 'fake', reminders: pendingRemindersFor(st, memberId, now) };
}

function surfaceOf(jsonl: string): A2uiSurface {
  const surface = A2uiSurfaceStore.fromJsonl(jsonl).list()[0];
  if (!surface) throw new Error('no surface');
  return surface;
}

const named = (surface: A2uiSurface) => Object.values(surface.components).flatMap(c => (typeof c.name === 'string' ? [c.name] : []));
const texts = (surface: A2uiSurface) => Object.values(surface.components).map(c => String(c.text ?? ''));
const saveAction = (surface: A2uiSurface) => Object.values(surface.components).flatMap(c => c.actions ?? []).find(a => a.args?.verb === 'save-settings') as A2uiAction;

describe('the Settings screen', () => {
  it.each(['en', 'zh'] as const)('a parent gets the whole form in %s, with the alert note and the simulated label', lang => {
    const s = surfaceOf(screenTurn('settings', input(seed(), 'mom', lang)).jsonl);
    expect(named(s)).toEqual(['quietFrom', 'quietTo', 'autonomy', 'paused', 'backupName', 'backupChannel']);
    const all = texts(s).join('\n');
    expect(all).toContain(lang === 'zh' ? 'Homemind 会帮忙，但提醒仍可能被错过。' : 'Homemind helps, but an alert can be missed.');
    expect(all).toContain(lang === 'zh' ? '**模拟**' : '**Simulated**');
    expect(saveAction(s).args).toMatchObject({ family: true, backupStored: 'Grandma Lin', backupShown: lang === 'zh' ? '林奶奶' : 'Grandma Lin' });
    const name = Object.values(s.components).find(c => c.name === 'backupName');
    expect(name?.default).toBe(lang === 'zh' ? '林奶奶' : 'Grandma Lin');
    expect(Object.values(s.components).find(c => c.name === 'quietFrom')?.default).toBe('22:00');
  });

  it('a teen sets only her quiet hours and sees the family settings as rows', () => {
    const s = surfaceOf(screenTurn('settings', input(seed(), 'maya', 'en')).jsonl);
    expect(named(s)).toEqual(['quietFrom', 'quietTo']);
    expect(saveAction(s).args).toMatchObject({ family: false });
    expect(texts(s).join('\n')).toContain('Only a parent can change these.');
    expect(texts(s).join('\n')).toContain('Homemind helps, but an alert can be missed.');
  });
});

describe('buildSettingsSave', () => {
  const momSettings = (lang: HomemindLang = 'en') => surfaceOf(screenTurn('settings', input(seed(), 'mom', lang)).jsonl);
  const build = (form: Record<string, unknown>, lang: HomemindLang = 'en') => {
    const s = momSettings(lang);
    const { values, defaults } = formValues(s, form);
    return buildSettingsSave(saveAction(s).args ?? {}, values, defaults);
  };

  it('sends nothing when nothing changed, in either language', () => {
    expect(build({})).toEqual({ ok: true, body: null });
    expect(build({}, 'zh')).toEqual({ ok: true, body: null });
  });

  it('sends only what changed', () => {
    expect(build({ quietTo: '06:30' })).toEqual({ ok: true, body: { quietHours: { from: '22:00', to: '06:30' } } });
    expect(build({ quietFrom: '', quietTo: '' })).toEqual({ ok: true, body: { quietHours: null } });
    expect(build({ autonomy: '4', paused: true })).toEqual({ ok: true, body: { autonomy: 4, paused: true } });
    expect(build({ backupName: '' })).toEqual({ ok: true, body: { backupContact: null } });
    expect(build({ backupName: 'Aunt Wei' })).toEqual({ ok: true, body: { backupContact: { name: 'Aunt Wei', channel: 'sms' } } });
  });

  it('keeps the stored name when the Chinese name is shown and only the channel changes', () => {
    expect(build({ backupChannel: 'call' }, 'zh')).toEqual({ ok: true, body: { backupContact: { name: 'Grandma Lin', channel: 'call' } } });
  });

  it('refuses half-filled or equal quiet hours', () => {
    expect(build({ quietFrom: '' })).toEqual({ ok: false, problem: 'quietBoth' });
    expect(build({ quietFrom: '07:00' })).toEqual({ ok: false, problem: 'quietSame' });
    expect(build({ quietFrom: '7pm' })).toEqual({ ok: false, problem: 'quietTime' });
  });

  it('a teen’s form never sends family fields', () => {
    const s = surfaceOf(screenTurn('settings', input(seed(), 'maya', 'en')).jsonl);
    const { values, defaults } = formValues(s, { quietFrom: '23:00', paused: true, autonomy: '4' });
    expect(buildSettingsSave(saveAction(s).args ?? {}, values, defaults)).toEqual({ ok: true, body: { quietHours: { from: '23:00', to: '07:00' } } });
  });
});

describe('reminder answers on board rows', () => {
  /** Dad has the pickup, not confirmed, and the clock is at `minutesBefore` its start, ticked minute by minute. */
  function scene(minutesBefore: number): { st: HomemindState; now: number } {
    let st = seed();
    const pickup = st.items.find(i => i.id === 'pickup-today') as Item;
    const assigned = applyChange(st, { kind: 'assign', itemId: pickup.id, version: pickup.version, ownerId: 'dad' }, 'mom', fixedClock(NOW));
    if (!assigned.ok) throw new Error(assigned.message);
    st = assigned.state;
    const end = Date.parse(pickup.start as string) - minutesBefore * MIN;
    for (let t = NOW; t <= end; t += MIN) st = tickReminders(st, t).state;
    return { st, now: end };
  }

  const rowOf = (st: HomemindState, memberId: string, now: number, screen: 'my-day' | 'family' = 'family') => {
    const s = surfaceOf(screenTurn(screen, input(st, memberId, 'en', now)).jsonl);
    const rows = Object.values(s.data as Record<string, unknown>).flatMap(v => (Array.isArray(v) ? v : [])) as Array<{ id: string; meta: string; actions: A2uiAction[] }>;
    return rows.find(r => r.id === 'pickup-today');
  };

  it('no reminder yet: the rows are as before', () => {
    const { st, now } = scene(90);
    expect(pendingRemindersFor(st, 'dad', now)).toEqual([]);
    expect(rowOf(st, 'dad', now, 'my-day')?.actions.map(a => a.label)).toEqual(["I'm on it", 'Hand off']);
  });

  it('Dad, reminded: "I\'m on it", "Hand off", "Remind me later" (with the reminder id), and "reminder sent"', () => {
    const { st, now } = scene(55);
    const [pending] = pendingRemindersFor(st, 'dad', now);
    expect(pending).toMatchObject({ itemId: 'pickup-today', ask: 'confirm', escalated: false, snoozed: false });
    const row = rowOf(st, 'dad', now, 'my-day');
    expect(row?.actions.map(a => a.label)).toEqual(["I'm on it", 'Hand off', 'Remind me later']);
    expect(row?.actions[2].args).toMatchObject({ verb: 'snooze', itemId: 'pickup-today', reminderId: pending.reminderId });
    expect(row?.meta).toContain('reminder sent');
  });

  it('Mom, after the escalation: "I\'ll take it" (assigns it to her) and "Got it", no "Remind me later"', () => {
    const { st, now } = scene(25);
    const [pending] = pendingRemindersFor(st, 'mom', now);
    expect(pending).toMatchObject({ escalated: true });
    const row = rowOf(st, 'mom', now);
    expect(row?.actions.map(a => a.label)).toEqual(["I'll take it", 'Got it']);
    expect(row?.actions[0].args).toMatchObject({ verb: 'assign', memberId: 'mom' });
    expect(row?.actions[0].id).toBe('homemind.take:pickup-today');
    expect(row?.actions[1].args).toMatchObject({ verb: 'ack', reminderId: pending.reminderId });
  });

  it('Maya sees no reminder buttons: the reminder never reached her', () => {
    const { st, now } = scene(25);
    expect(pendingRemindersFor(st, 'maya', now)).toEqual([]);
    expect(rowOf(st, 'maya', now)?.actions ?? []).toEqual([]);
  });

  it('after "Remind me later", the row says so and offers it no more until the time comes', () => {
    const { st, now } = scene(55);
    const r = st.reminders.find(x => x.itemId === 'pickup-today');
    const snoozed = { ...st, reminders: st.reminders.map(x => (x === r ? { ...x, snoozedUntil: new Date(now + 10 * MIN).toISOString() } : x)) };
    const row = rowOf(snoozed, 'dad', now, 'my-day');
    expect(row?.actions.map(a => a.label)).toEqual(["I'm on it", 'Hand off']);
    expect(row?.meta).toContain('reminding again soon');
  });
});
