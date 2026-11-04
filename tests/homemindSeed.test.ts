import { describe, expect, it } from 'vitest';
import { localParts } from '../server/homemind/clock';
import { machineTimezone, seedState } from '../server/homemind/seed';
import { ID_PATTERN } from '../server/homemind/types';

const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 10:00 in Asia/Shanghai
const HOUR = 3_600_000;
const TZ = 'Asia/Shanghai'; // explicit, so the tests do not depend on the machine's zone

describe('seed', () => {
  const state = seedState({ now: NOW, timezone: TZ });
  const byId = new Map(state.items.map(item => [item.id, item]));
  const memberIds = new Set(state.family.members.map(m => m.id));

  it('has the demo family: two parents, a teen of 15 and a child of 5 with no account', () => {
    expect(state.family.members.map(m => [m.id, m.role, m.age, m.hasAccount])).toEqual([
      ['mom', 'parent', undefined, true],
      ['dad', 'parent', undefined, true],
      ['maya', 'teen', 15, true],
      ['noa', 'child', 5, false]
    ]);
    expect(state.family.timezone).toBe(TZ);
    expect(state.family.autonomy.default).toBe(3);
    expect(state.family.paused).toBe(false);
    for (const m of state.family.members) expect(m.nameZh).toBeTruthy();
  });

  it("uses the machine's time zone when none is given", () => {
    expect(seedState({ now: NOW }).family.timezone).toBe(machineTimezone());
    expect(machineTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('labels the backup contact as simulated', () => {
    expect(state.family.backupContact?.simulated).toBe(true);
  });

  it('uses valid, unique ids and only references things that exist', () => {
    const ids = [
      ...state.family.members.map(m => m.id),
      ...state.items.map(i => i.id),
      ...state.preferences.map(p => p.id),
      ...state.rules.map(r => r.id)
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);

    for (const item of state.items) {
      expect(memberIds.has(item.createdBy)).toBe(true);
      for (const id of [...item.forMemberIds, ...item.unavailableMemberIds]) expect(memberIds.has(id)).toBe(true);
      if (item.ownership.state === 'assigned') expect(memberIds.has(item.ownership.ownerId)).toBe(true);
      if (item.ownership.state === 'open') for (const id of item.ownership.candidateIds) expect(memberIds.has(id)).toBe(true);
      if (item.parentEventId) expect(byId.get(item.parentEventId)?.type).toBe('event');
      expect(item.version).toBe(1);
      expect(item.titleZh).toBeTruthy();
    }
    for (const p of state.preferences) if (p.aboutMemberId) expect(memberIds.has(p.aboutMemberId)).toBe(true);
  });

  it("puts today's critical pickup about two hours ahead, with nobody owning it yet (Scene 1)", () => {
    const pickup = byId.get('pickup-today')!;
    const start = Date.parse(pickup.start!);
    expect(pickup.importance).toBe('critical');
    expect(pickup.ownership).toEqual({ state: 'none' });
    expect(start - NOW).toBeGreaterThanOrEqual(2 * HOUR);
    expect(start - NOW).toBeLessThan(2.5 * HOUR);
    expect(localParts(start, TZ).date).toBe('2026-11-04');
  });

  it("gives Mom next Tuesday's pickup, for the wedding conflict (Scene 4)", () => {
    const tuesday = byId.get('pickup-tuesday')!;
    expect(tuesday.ownership).toEqual({ state: 'assigned', ownerId: 'mom', confirmed: true });
    expect(localParts(Date.parse(tuesday.start!), TZ)).toEqual({ date: '2026-11-10', time: '16:30', weekday: 2 });
  });

  it('has one Parents-only, sensitive item, and everything else is family-visible', () => {
    const parentsOnly = state.items.filter(i => i.visibility === 'parents');
    expect(parentsOnly.map(i => i.id)).toEqual(['counselor-meeting']);
    expect(parentsOnly[0].sensitive).toBe(true);
  });

  it('has a preparation under an event and a "Who\'s taking this?" task', () => {
    expect(byId.get('family-dinner-flowers')).toMatchObject({ type: 'preparation', parentEventId: 'family-dinner' });
    expect(byId.get('library-books')?.ownership.state).toBe('open');
  });

  it('saves the cake preference with a reason and a scope, and a hard allergy (Scene 2)', () => {
    const cake = state.preferences.find(p => p.id === 'pref-noa-cake')!;
    expect(cake).toMatchObject({ aboutMemberId: 'noa', strength: 'soft', scope: 'kindergarten-party' });
    expect(cake.reason).toMatch(/enjoys/);
    expect(state.preferences.find(p => p.id === 'pref-noa-peanuts')?.strength).toBe('hard');
  });

  it('has the Friday pizza rule with a price cap', () => {
    expect(state.rules).toEqual([
      expect.objectContaining({ id: 'rule-friday-pizza', area: 'food', enabled: true, limits: { maxPrice: 250, currency: 'CNY' } })
    ]);
    expect(state.rules[0].trigger).toMatchObject({ weekday: 5, leadMinutes: 30 });
  });

  it('starts with an empty log, no reminders, no cards and a zero clock offset', () => {
    expect([state.activity, state.reminders, state.actionCards, state.whys]).toEqual([[], [], [], []]);
    expect(state.clockOffsetMs).toBe(0);
  });

  it('is deterministic for the same time, and follows the time zone', () => {
    expect(seedState({ now: NOW, timezone: TZ })).toEqual(state);
    const jerusalem = seedState({ now: NOW, timezone: 'Asia/Jerusalem' });
    const piano = jerusalem.items.find(i => i.id === 'piano-tomorrow')!;
    expect(localParts(Date.parse(piano.start!), 'Asia/Jerusalem')).toMatchObject({ date: '2026-11-05', time: '17:00' });
  });

  it('never schedules next Tuesday for today, even when today is Tuesday', () => {
    const tuesdayMorning = Date.UTC(2026, 10, 10, 1, 0); // Tue 2026-11-10 09:00 Shanghai
    const s = seedState({ now: tuesdayMorning, timezone: TZ });
    const start = s.items.find(i => i.id === 'pickup-tuesday')!.start!;
    expect(localParts(Date.parse(start), TZ).date).toBe('2026-11-17');
  });
});
