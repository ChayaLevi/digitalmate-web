import { describe, expect, it } from 'vitest';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import type { Change } from '../server/homemind/core';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';
import { searchItems, viewFor } from '../server/homemind/visibility';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import { homemindErrorTurn, screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindLang, HomemindScreenData, HomemindScreenName } from '../src/lib/homemindSurfaces';
import type { A2uiSurface } from '../src/types';

const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const clock = fixedClock(NOW);
const SCREENS: HomemindScreenName[] = ['my-day', 'family', 'calendar', 'search', 'rules', 'memory', 'activity', 'settings'];

const seed = () => seedState({ now: NOW, timezone: 'Asia/Shanghai' });

function input(state: HomemindState, member: string, lang: HomemindLang, extra: Partial<HomemindScreenData> = {}): HomemindScreenData {
  const view = viewFor(state, member);
  if (!view) throw new Error('no member');
  return { lang, now: new Date(NOW).toISOString(), view, ...extra };
}

function parse(jsonl: string): A2uiSurface {
  const store = A2uiSurfaceStore.fromJsonl(jsonl);
  const surfaces = store.list();
  expect(surfaces).toHaveLength(1);
  return surfaces[0];
}

function dataAt(surface: A2uiSurface, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split('/').filter(Boolean).reduce<unknown>((cur, seg) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined), surface.data);
}

function actionsOf(surface: A2uiSurface) {
  const found: Array<{ id: string; label: string; kind?: string; args?: Record<string, unknown> }> = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      if (Array.isArray(rec.actions)) for (const a of rec.actions) found.push(a as never);
      Object.values(rec).forEach(walk);
    }
  };
  walk(surface.data);
  walk(Object.values(surface.components));
  return found;
}

function apply(state: HomemindState, change: Change, actor: string): HomemindState {
  const r = applyChange(state, change, actor, clock);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.state;
}

const item = (state: HomemindState, id: string) => state.items.find(i => i.id === id)!;

describe('every screen parses as one A2UI surface', () => {
  for (const lang of ['en', 'zh'] as const) {
    for (const screen of SCREENS) {
      for (const member of ['mom', 'dad', 'maya']) {
        it(`${screen} for ${member} in ${lang}`, () => {
          const state = seed();
          const turn = screenTurn(screen, input(state, member, lang, screen === 'search' ? { query: 'pickup', results: searchItems(state, member, 'pickup') } : {}));
          const surface = parse(turn.jsonl);
          expect(surface.status).toBe('ready');
          expect(surface.title).toBeTruthy();
          const root = surface.components[surface.root];
          expect(root.component).toBe('SurfaceRoot');
          // Every child exists, and every dataPath leads to data.
          for (const id of root.children ?? []) expect(surface.components[id], id).toBeDefined();
          for (const c of Object.values(surface.components)) {
            if (c.dataPath) expect(dataAt(surface, c.dataPath), `${c.id} ${c.dataPath}`).toBeDefined();
          }
          for (const a of actionsOf(surface)) expect(a.kind).toBe('homemind');
        });
      }
    }
  }

  it('uses stable surface ids, so a refresh replaces the surface', () => {
    const s = seed();
    expect(parse(screenTurn('my-day', input(s, 'mom', 'en')).jsonl).id).toBe(parse(screenTurn('my-day', input(s, 'mom', 'en')).jsonl).id);
    expect(parse(screenTurn('family', input(s, 'mom', 'en')).jsonl).id).not.toBe(parse(screenTurn('my-day', input(s, 'mom', 'en')).jsonl).id);
  });
});

describe('language', () => {
  it('shows seeded Chinese titles in zh and English in en, with different chrome', () => {
    const s = seed();
    const en = screenTurn('my-day', input(s, 'mom', 'en')).jsonl;
    const zh = screenTurn('my-day', input(s, 'mom', 'zh')).jsonl;
    expect(en).toContain('Kindergarten pickup');
    expect(zh).toContain('幼儿园接孩子');
    expect(zh).not.toContain('Kindergarten pickup');
    expect(zh).toContain('我的一天');
    expect(en).toContain('My day');
  });

  it('falls back to the English title when a user item has no Chinese one', () => {
    const s = apply(seed(), { kind: 'create', item: { type: 'task', title: 'Buy glue sticks', forMemberIds: ['mom'], ownerId: 'mom' } as never }, 'mom');
    expect(screenTurn('family', input(s, 'mom', 'zh')).jsonl + screenTurn('my-day', input(s, 'mom', 'zh')).jsonl).toContain('Buy glue sticks');
  });
});

describe('My day, Scene 1', () => {
  it("offers 'I'll take it' and 'Assign to Dad' on the open pickup, to Mom", () => {
    const surface = parse(screenTurn('my-day', input(seed(), 'mom', 'en')).jsonl);
    const rows = (surface.data.needs as Array<{ id: string; ownerLabel: string; state: string; tone: string; meta: string; actions: Array<{ label: string; args: Record<string, unknown> }> }>) ?? [];
    const pickup = rows.find(r => r.id === 'pickup-today')!;
    expect(pickup.state).toBe('open');
    expect(pickup.ownerLabel).toBe('No owner yet');
    expect(pickup.tone).toBe('danger');
    expect(pickup.meta).toContain('Important');
    expect(pickup.actions.map(a => a.label)).toEqual(expect.arrayContaining(["I'll take it", 'Assign to Dad']));
    const assign = pickup.actions.find(a => a.label === 'Assign to Dad')!;
    expect(assign.args).toMatchObject({ verb: 'assign', itemId: 'pickup-today', memberId: 'dad', version: item(seed(), 'pickup-today').version });
  });

  it('after Mom assigns Dad, his screen asks him to confirm, and hers shows it waiting', () => {
    const s0 = seed();
    const s1 = apply(s0, { kind: 'assign', itemId: 'pickup-today', version: item(s0, 'pickup-today').version, ownerId: 'dad' }, 'mom');
    const dad = parse(screenTurn('my-day', input(s1, 'dad', 'en')).jsonl);
    const dadRow = (dad.data.needs as Array<{ id: string; state: string; ownerLabel: string; actions: Array<{ label: string }> }>).find(r => r.id === 'pickup-today')!;
    expect(dadRow.state).toBe('assigned');
    expect(dadRow.ownerLabel).toBe('You');
    expect(dadRow.actions.map(a => a.label)).toEqual(["I'm on it", 'Hand off']);
    const family = parse(screenTurn('family', input(s1, 'mom', 'en')).jsonl);
    expect((family.data.unconfirmed as Array<{ id: string; ownerLabel: string }>).map(r => [r.id, r.ownerLabel])).toContainEqual(['pickup-today', 'Dad']);
    // Dad confirms: it moves to Today with Done.
    const s2 = apply(s1, { kind: 'confirm', itemId: 'pickup-today', version: item(s1, 'pickup-today').version }, 'dad');
    const done = parse(screenTurn('my-day', input(s2, 'dad', 'en')).jsonl);
    const row = (done.data.today as Array<{ id: string; actions: Array<{ label: string }> }>).find(r => r.id === 'pickup-today')!;
    expect(row.actions.map(a => a.label)).toEqual(['Done', 'Hand off']);
  });

  it('a teen can claim but cannot assign', () => {
    const surface = parse(screenTurn('my-day', input(seed(), 'maya', 'en')).jsonl);
    const all = actionsOf(surface).map(a => a.label);
    expect(all.some(l => l.startsWith('Assign to'))).toBe(false);
  });
});

describe('Scene 4: availability on the screens', () => {
  function withWedding(): HomemindState {
    const s0 = seed();
    const pickup = item(s0, 'pickup-tuesday');
    const start = new Date(Date.parse(pickup.start!) - 90 * 60_000).toISOString();
    const end = new Date(Date.parse(pickup.start!) + 5 * 3600_000).toISOString();
    return apply(s0, { kind: 'create', item: { type: 'event', title: 'Wedding', titleZh: '婚礼', start, end, forMemberIds: ['mom'], unavailableMemberIds: ['mom'] } as never }, 'mom');
  }

  it('lists who is away, and the open pickup with its reason', () => {
    const s0 = withWedding();
    const wedding = s0.items.find(i => i.title === 'Wedding')!;
    const s1 = apply(s0, { kind: 'open', itemId: 'pickup-tuesday', version: item(s0, 'pickup-tuesday').version, candidateIds: ['dad', 'maya'], reason: { kind: 'unavailable', memberId: 'mom', eventId: wedding.id, date: '2026-11-10' } } as never, 'mom');
    const fam = parse(screenTurn('family', input(s1, 'dad', 'en')).jsonl);
    expect(JSON.stringify(fam.data.away)).toContain('Mom');
    expect(JSON.stringify(fam.data.away)).toContain('Wedding');
    const openRow = (fam.data.open as Array<{ id: string; meta: string }>).find(r => r.id === 'pickup-tuesday')!;
    expect(openRow.meta).toContain('Mom is unavailable (Wedding)');
    const zh = parse(screenTurn('family', input(s1, 'dad', 'zh')).jsonl);
    expect(JSON.stringify(zh.data)).toContain('妈妈那时没空（Wedding）');
  });

  it('puts the wedding on the calendar with who is unavailable', () => {
    const board = parse(screenTurn('calendar', input(withWedding(), 'dad', 'en')).jsonl).data.board as { entries: Array<{ title: string; unavailable?: string[]; date: string; time?: string }>; members: unknown[]; weekStartsOn: number };
    const e = board.entries.find(x => x.title === 'Wedding')!;
    expect(e.unavailable).toEqual(['Mom']);
    expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e.time).toMatch(/^\d{2}:\d{2}$/);
    expect(board.members).toHaveLength(5);
  });
});

describe('calendar', () => {
  it('expands a weekly item at the same local time, skipping a cancelled date', () => {
    const s0 = seed();
    const piano = item(s0, 'piano-tomorrow');
    expect(piano).toBeDefined();
    const s1 = apply(s0, { kind: 'edit', itemId: piano.id, version: piano.version, patch: { recurrence: { freq: 'weekly', byWeekday: [4] } } } as never, 'mom');
    const entries = (parse(screenTurn('calendar', input(s1, 'mom', 'en')).jsonl).data.board as { entries: Array<{ itemId: string; date: string; time?: string; id: string }> }).entries.filter(e => e.itemId === piano.id);
    expect(entries.length).toBeGreaterThan(5);
    expect(new Set(entries.map(e => e.time)).size).toBe(1);
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
    const skip = entries[1].date;
    const s2 = apply(s1, { kind: 'cancel_occurrence', itemId: piano.id, version: item(s1, piano.id).version, date: skip } as never, 'mom');
    const after = (parse(screenTurn('calendar', input(s2, 'mom', 'en')).jsonl).data.board as { entries: Array<{ itemId: string; date: string }> }).entries.filter(e => e.itemId === piano.id);
    expect(after.map(e => e.date)).not.toContain(skip);
    expect(after.length).toBe(entries.length - 1);
  });
});

describe('Parents-only never reaches a teen', () => {
  it('has no trace of the counselor meeting on any screen, and shows it to a parent', () => {
    const s = seed();
    for (const lang of ['en', 'zh'] as const) {
      for (const screen of SCREENS) {
        const turn = screenTurn(screen, input(s, 'maya', lang, screen === 'search' ? { query: 'meeting', results: searchItems(s, 'maya', 'meeting') } : {}));
        expect(turn.jsonl, `${screen} ${lang}`).not.toMatch(/counselor|辅导老师|counselor-meeting/i);
      }
    }
    expect(screenTurn('family', input(s, 'mom', 'en')).jsonl + screenTurn('calendar', input(s, 'mom', 'en')).jsonl).toMatch(/counselor/i);
  });
});

describe('proposals', () => {
  it('shows Approve and Dismiss on a proposed item', () => {
    const s = apply(seed(), { kind: 'create', item: { type: 'event', title: 'Class photo day', forMemberIds: ['mom'], source: { kind: 'screenshot', label: 'Screenshot' } } as never, proposed: true } as never, 'mom');
    const surface = parse(screenTurn('family', input(s, 'mom', 'en')).jsonl);
    const row = (surface.data.proposed as Array<{ title: string; state: string; actions: Array<{ label: string }> }>).find(r => r.title === 'Class photo day')!;
    expect(row.state).toBe('proposed');
    expect(row.actions.map(a => a.label)).toEqual(['Approve', 'Dismiss']);
  });
});

describe('simulated is always labeled', () => {
  // The visible badge comes from the flag; tests/homemindComponents.test.ts checks it renders in both languages.
  it('flags a simulated item, without repeating the word in its meta line', () => {
    const s = apply(
      seed(),
      { kind: 'create', item: { type: 'task', title: 'Bring apples', forMemberIds: ['mom'], source: { kind: 'group', label: 'Kindergarten group', simulated: true } } as never },
      'mom'
    );
    const en = parse(screenTurn('family', input(s, 'mom', 'en')).jsonl);
    const rows = [...((en.data.proposed as unknown[]) ?? []), ...((en.data.open as unknown[]) ?? [])] as Array<{ title: string; meta: string; simulated?: boolean }>;
    const row = rows.find(r => r.title === 'Bring apples')!;
    expect(row.simulated).toBe(true);
    expect(row.meta).not.toContain('Simulated');
  });

  it('labels the simulated backup contact, the pizza rule and the fake model', () => {
    const s = seed();
    expect(JSON.stringify(parse(screenTurn('settings', input(s, 'mom', 'en', { llm: 'fake' })).jsonl).data)).toContain('Simulated model');
    expect(JSON.stringify(parse(screenTurn('settings', input(s, 'mom', 'zh', { llm: 'fake' })).jsonl).data)).toContain('模拟模型');
    // A parent edits the contact in the form, with the label right under it; others see it as a row.
    const momSettings = screenTurn('settings', input(s, 'mom', 'en')).jsonl;
    expect(momSettings).toContain('**Simulated**: In this demo nothing is sent to the backup contact.');
    expect(JSON.stringify(parse(screenTurn('settings', input(s, 'maya', 'en')).jsonl).data)).toMatch(/Grandma Lin · Simulated/);
    expect(JSON.stringify(parse(screenTurn('rules', input(s, 'mom', 'en')).jsonl).data)).toContain('Simulated');
  });

  it('shows a pending action card to a parent only, labeled when simulated, with Why? and no card once expired', () => {
    const s = seed();
    const card = { id: 'card-1', adapter: 'pizza', mode: 'simulated' as const, payload: { title: 'Friday pizza', summary: '1 large margherita, 88 CNY' }, payloadHash: 'h', status: 'pending' as const, expiresAt: new Date(NOW + 3600_000).toISOString(), whyId: 'why-1' };
    const withCard = { ...s, actionCards: [card] };
    const mom = parse(screenTurn('my-day', input(withCard, 'mom', 'en')).jsonl);
    expect(mom.data.cards).toMatchObject({ 'card-1': { simulated: true } });
    expect(actionsOf(mom).map(a => a.label)).toEqual(expect.arrayContaining(['Confirm', 'Cancel', 'Why?']));
    expect(actionsOf(mom).find(a => a.label === 'Confirm')!.args).toMatchObject({ verb: 'confirm-card', cardId: 'card-1' });
    expect(screenTurn('my-day', input(withCard, 'maya', 'en')).jsonl).not.toContain('Friday pizza');
    const expired = { ...s, actionCards: [{ ...card, expiresAt: new Date(NOW - 1000).toISOString() }] };
    expect(screenTurn('my-day', input(expired, 'mom', 'en')).jsonl).not.toContain('Friday pizza');
  });
});

describe('memory', () => {
  it('says PPMA is not connected or offline, and shows the saved preference with its reason', () => {
    const s = seed();
    const off = screenTurn('memory', input(s, 'mom', 'en', { ppma: 'off' })).jsonl;
    expect(off).toContain('not connected');
    expect(off).toContain('ErrorNotice');
    expect(off).toMatch(/Because/);
    expect(screenTurn('memory', input(s, 'mom', 'en', { ppma: 'offline' })).jsonl).toContain('PPMA offline');
    expect(screenTurn('memory', input(s, 'mom', 'zh', { ppma: 'offline' })).jsonl).toContain('PPMA 离线');
    expect(screenTurn('memory', input(s, 'mom', 'en', { ppma: 'ok' })).jsonl).not.toContain('ErrorNotice');
  });
});

describe('activity and undo', () => {
  it('offers Undo only on the activity ids the server lists', () => {
    const s0 = seed();
    const s1 = apply(s0, { kind: 'assign', itemId: 'pickup-today', version: item(s0, 'pickup-today').version, ownerId: 'dad' }, 'mom');
    const last = s1.activity[s1.activity.length - 1];
    const without = parse(screenTurn('activity', input(s1, 'mom', 'en')).jsonl);
    expect(actionsOf(without).filter(a => a.label === 'Undo')).toHaveLength(0);
    const withUndo = parse(screenTurn('activity', input(s1, 'mom', 'en', { undoable: [last.id] })).jsonl);
    const undo = actionsOf(withUndo).filter(a => a.label === 'Undo');
    expect(undo).toHaveLength(1);
    expect(undo[0].args).toMatchObject({ verb: 'undo', activityId: last.id });
    expect(JSON.stringify(withUndo.data)).toContain('Mom assigned to Dad');
    expect(JSON.stringify(parse(screenTurn('activity', input(s1, 'mom', 'zh')).jsonl).data)).toContain('妈妈 分配给 爸爸');
  });
});

describe('empty and error states', () => {
  it('shows a line of text instead of an empty list', () => {
    const s = { ...seed(), items: [], activity: [], rules: [], preferences: [] };
    for (const screen of SCREENS) {
      const turn = screenTurn(screen, input(s, 'mom', 'en'));
      const surface = parse(turn.jsonl);
      expect(Object.values(surface.components).some(c => c.component === 'Text' || c.component === 'ActionBar' || c.component === 'InfoRows' || c.component === 'CalendarBoard' || c.component === 'MetricGrid'), screen).toBe(true);
      for (const [path, v] of Object.entries(surface.data)) if (Array.isArray(v)) expect(v.length, `${screen} ${path}`).toBeGreaterThan(0);
    }
    expect(screenTurn('my-day', input(s, 'mom', 'en')).jsonl).toContain('Nothing for you today.');
    expect(screenTurn('my-day', input(s, 'mom', 'zh')).jsonl).toContain('今天没有需要你处理的事。');
  });

  it('search says when nothing matches', () => {
    const s = seed();
    expect(screenTurn('search', input(s, 'mom', 'en', { query: 'zzz', results: [] })).jsonl).toContain('No matches.');
    expect(screenTurn('search', input(s, 'mom', 'en')).jsonl).not.toContain('No matches.');
  });

  it('builds an error surface in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const surface = parse(homemindErrorTurn('Boom', lang).jsonl);
      expect(surface.status).toBe('error');
      expect(Object.values(surface.components).find(c => c.component === 'ErrorNotice')?.body).toBe('Boom');
    }
  });

  it('survives a bad time zone without throwing', () => {
    const s = seed();
    const bad = { ...s, family: { ...s.family, timezone: 'Not/AZone' } };
    expect(() => screenTurn('my-day', input(bad, 'mom', 'en'))).not.toThrow();
  });
});

describe('settings', () => {
  it('states that an alert can be missed and that sign-in is a demo', () => {
    const text = JSON.stringify(parse(screenTurn('settings', input(seed(), 'dad', 'en')).jsonl).components);
    expect(text).toContain('an alert can be missed');
    expect(text).toContain('Demo sign-in');
  });
});
