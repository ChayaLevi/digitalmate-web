import { describe, expect, it } from 'vitest';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import { postNextGroupMessage, servicesViewFor } from '../server/homemind/fakes';
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
    const rows = (surface.data.today as Array<{ id: string; ownerLabel: string; state: string; tone: string; meta: string; actions: Array<{ label: string; args: Record<string, unknown> }> }>) ?? [];
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
    const dadRow = (dad.data.today as Array<{ id: string; state: string; ownerLabel: string; actions: Array<{ label: string }> }>).find(r => r.id === 'pickup-today')!;
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

describe('My day by day, and events without an owner', () => {
  type Row = { id: string; title: string; ownerLabel: string; state: string; tone: string; actions: Array<{ label: string }> };
  const rows = (surface: A2uiSurface, id: string) => (surface.data[id] as Row[] | undefined) ?? [];
  const ids = (surface: A2uiSurface, id: string) => rows(surface, id).map(r => r.title);
  // Shanghai is UTC+8: 16:00 UTC the day before is local midnight.
  const at = (date: string, hour: number) => new Date(Date.parse(`${date}T00:00:00+08:00`) + hour * 3600_000).toISOString();

  function withItems(): HomemindState {
    let s = seed();
    // A wedding from Wednesday (today) to Friday: participants only.
    s = apply(s, { kind: 'create', item: { type: 'event', title: 'Wedding', start: at('2026-11-04', 12), end: at('2026-11-06', 23), forMemberIds: ['mom', 'dad'] } as never }, 'mom');
    // A class party for Noa on Friday: participants only, still on a parent's day.
    s = apply(s, { kind: 'create', item: { type: 'event', title: 'Class party', start: at('2026-11-06', 10), forMemberIds: ['noa'] } as never }, 'dad');
    // Tasks nobody took yet: today, on Saturday, in two weeks, and with no date.
    s = apply(s, { kind: 'create', item: { type: 'task', title: 'Sign the form', start: at('2026-11-04', 0), end: at('2026-11-05', 0), allDay: true } as never }, 'mom');
    s = apply(s, { kind: 'create', item: { type: 'task', title: 'Buy a gift', start: at('2026-11-07', 0), end: at('2026-11-08', 0), allDay: true } as never }, 'mom');
    s = apply(s, { kind: 'create', item: { type: 'task', title: 'Renew passports', start: at('2026-11-18', 0), end: at('2026-11-19', 0), allDay: true } as never }, 'mom');
    s = apply(s, { kind: 'create', item: { type: 'task', title: 'Fix the shelf' } as never }, 'mom');
    return s;
  }

  it('an event nobody was asked to own shows its participants, not "No owner yet", and has no take or assign buttons', () => {
    const day = parse(screenTurn('my-day', input(withItems(), 'mom', 'en')).jsonl);
    const wedding = rows(day, 'today').find(r => r.title === 'Wedding')!;
    expect(wedding.ownerLabel).toBe('You, Dad');
    expect(wedding.state).toBe('');
    expect(wedding.tone).toBe('muted');
    expect(wedding.actions).toEqual([]);
    const zh = parse(screenTurn('my-day', input(withItems(), 'mom', 'zh')).jsonl);
    expect(rows(zh, 'today').find(r => r.title === 'Wedding')!.ownerLabel).toBe('你、爸爸');
  });

  it("a child's event is on both parents' days until someone owns it, then on the owner's", () => {
    const s0 = withItems();
    const party = s0.items.find(i => i.title === 'Class party')!;
    for (const member of ['mom', 'dad']) expect(ids(parse(screenTurn('my-day', input(s0, member, 'en')).jsonl), 'later')).toContain('Class party');
    const s1 = apply(s0, { kind: 'assign', itemId: party.id, version: party.version, ownerId: 'dad' }, 'mom');
    expect(ids(parse(screenTurn('my-day', input(s1, 'dad', 'en')).jsonl), 'later')).toContain('Class party');
    expect(ids(parse(screenTurn('my-day', input(s1, 'mom', 'en')).jsonl), 'later')).not.toContain('Class party');
  });

  it('an event for nobody in particular is on everyone\'s day', () => {
    const s = apply(seed(), { kind: 'create', item: { type: 'event', title: 'Building meeting', start: at('2026-11-04', 19) } as never }, 'mom');
    for (const member of ['mom', 'dad', 'maya']) {
      expect(ids(parse(screenTurn('my-day', input(s, member, 'en')).jsonl), 'today')).toContain('Building meeting');
    }
  });

  it("the important pickup and a task with no owner still ask who's taking them", () => {
    const day = parse(screenTurn('my-day', input(withItems(), 'mom', 'en')).jsonl);
    const pickup = rows(day, 'today').find(r => r.id === 'pickup-today')!;
    const form = rows(day, 'today').find(r => r.title === 'Sign the form')!;
    for (const r of [pickup, form]) {
      expect(r.state).toBe('open');
      expect(r.actions.map(a => a.label)).toContain("I'll take it");
    }
  });

  it('puts each item on its day: Today has today (a multi-day wedding too), Coming up has the week, the rest waits at the end', () => {
    const day = parse(screenTurn('my-day', input(withItems(), 'mom', 'en')).jsonl);
    expect(ids(day, 'today')).toEqual(expect.arrayContaining(['Wedding', 'Sign the form', 'Kindergarten pickup']));
    expect(ids(day, 'today')).not.toContain('Buy a gift');
    expect(ids(day, 'later')).toEqual(expect.arrayContaining(['Buy a gift', 'Class party']));
    expect(ids(day, 'later')).not.toContain('Wedding');
    expect(ids(day, 'waiting')).toEqual(expect.arrayContaining(['Renew passports', 'Fix the shelf']));
    expect(ids(day, 'waiting')).not.toContain('Buy a gift');
    expect(day.data.needs).toBeUndefined();
    // The wedding is still on Thursday's Today.
    const thursday = parse(screenTurn('my-day', { ...input(withItems(), 'mom', 'en'), now: at('2026-11-05', 9) }).jsonl);
    expect(ids(thursday, 'today')).toContain('Wedding');
  });

  it("the Family board's \"Who's taking this?\" leaves out events that need no owner", () => {
    const fam = parse(screenTurn('family', input(withItems(), 'mom', 'en')).jsonl);
    const open = (fam.data.open as Row[]).map(r => r.title);
    expect(open).toEqual(expect.arrayContaining(['Kindergarten pickup', 'Sign the form']));
    expect(open).not.toContain('Wedding');
    expect(open).not.toContain('Class party');
  });

  it("the event's own screen can still give it an owner", () => {
    const s = withItems();
    const wedding = s.items.find(i => i.title === 'Wedding')!;
    const screen = parse(screenTurn('item', input(s, 'mom', 'en', { edit: { itemId: wedding.id } })).jsonl);
    expect((screen.data.this as Row[])[0].actions.map(a => a.label)).toEqual(expect.arrayContaining(["I'll take it", 'Assign to Dad']));
  });

  it('the Add form offers "Nobody" as the owner choice', () => {
    const add = screenTurn('edit', input(seed(), 'mom', 'en', { edit: {} })).jsonl;
    expect(add).toContain('Nobody (an event can have only participants)');
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
    // Since T7.4 the core keeps a created item's `titleZh`, so the Chinese screen names the event in Chinese.
    expect(JSON.stringify(zh.data)).toContain('妈妈那时没空（婚礼）');
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
    // Live mode without a URL or model says so instead of claiming a live model.
    expect(JSON.stringify(parse(screenTurn('settings', input(s, 'mom', 'en', { llm: 'not_configured' })).jsonl).data)).toContain('Model not set up');
    expect(JSON.stringify(parse(screenTurn('settings', input(s, 'mom', 'zh', { llm: 'not_configured' })).jsonl).data)).toContain('模型未配置');
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

  const statements = [
    { id: 'st-1', text: 'Noa enjoys cake most', origin: 'user' as const, confidence: 0.9, editable: true, view: 'about_me' },
    { id: 'st-2', text: 'Thursday is swimming day', origin: 'inferred' as const, confidence: 0.5, editable: false, view: 'about_me' },
    { id: 'st-3', text: 'Maya likes quiet mornings', origin: 'app' as const, confidence: 0.6, editable: true, view: 'about_me', correcting: 'wrong' as const }
  ];
  const ppmaRows = (jsonl: string) => (parse(jsonl).data.ppma ?? []) as Array<{ id: string; title: string; meta: string; ownerLabel: string; actions: Array<{ label: string; args: Record<string, unknown> }> }>;

  it("shows what PPMA remembers as PPMA's words, with That's wrong and Forget for a parent on what can be changed", () => {
    const s = seed();
    const turn = screenTurn('memory', input(s, 'mom', 'en', { ppma: 'ok', ppmaMemory: { state: 'ready', statements } }));
    const rows = ppmaRows(turn.jsonl);
    expect(rows.map(r => r.title)).toEqual(['Noa enjoys cake most', 'Thursday is swimming day', 'Maya likes quiet mornings']);
    expect(rows[0].ownerLabel).toBe('You told PPMA');
    expect(rows[0].actions.map(a => a.label)).toEqual(['That’s wrong', 'Forget']);
    expect(rows[0].actions[0].args).toEqual({ verb: 'memory-correct', statementId: 'st-1', action: 'wrong' });
    // Not editable: no buttons. Already corrected: no buttons, and it says the correction is on its way.
    expect(rows[1].actions).toEqual([]);
    expect(rows[2].actions).toEqual([]);
    expect(rows[2].meta).toContain('Correction sent');
    expect(turn.jsonl).toContain('PPMA’s own words');
  });

  it('gives a teen the list without buttons, and says only a parent can correct it', () => {
    const s = seed();
    const turn = screenTurn('memory', input(s, 'maya', 'en', { ppma: 'ok', ppmaMemory: { state: 'ready', statements } }));
    expect(ppmaRows(turn.jsonl).every(r => r.actions.length === 0)).toBe(true);
    expect(turn.jsonl).toContain('Only a parent can correct');
  });

  it('says loading, failed or empty instead of inventing anything, and shows nothing of PPMA when it is off or offline', () => {
    const s = seed();
    expect(screenTurn('memory', input(s, 'mom', 'en', { ppma: 'ok', ppmaMemory: { state: 'loading', statements: [] } })).jsonl).toContain('Reading from PPMA');
    expect(screenTurn('memory', input(s, 'mom', 'en', { ppma: 'ok' })).jsonl).toContain('Reading from PPMA');
    expect(screenTurn('memory', input(s, 'mom', 'en', { ppma: 'ok', ppmaMemory: { state: 'error', statements: [], error: 'network' } })).jsonl).toContain('Could not read PPMA');
    expect(screenTurn('memory', input(s, 'mom', 'en', { ppma: 'ok', ppmaMemory: { state: 'ready', statements: [] } })).jsonl).toContain('has not remembered anything');
    // The last read is kept when a refresh fails, and the screen says so.
    const stale = screenTurn('memory', input(s, 'mom', 'en', { ppma: 'ok', ppmaMemory: { state: 'ready', statements, error: 'timeout' } })).jsonl;
    expect(stale).toContain('Could not read PPMA');
    expect(stale).toContain('Noa enjoys cake most');
    for (const ppma of ['off', 'offline'] as const) {
      expect(screenTurn('memory', input(s, 'mom', 'en', { ppma, ppmaMemory: { state: 'ready', statements } })).jsonl).not.toContain('Noa enjoys cake most');
    }
  });

  it('lets a parent remove any saved preference and anyone else only a soft one, and speaks Chinese', () => {
    const s = seed();
    const prefRows = (member: string) => (parse(screenTurn('memory', input(s, member, 'en', { ppma: 'off' })).jsonl).data.prefs ?? []) as Array<{ id: string; actions: Array<{ args: Record<string, unknown> }> }>;
    const mom = prefRows('mom');
    expect(mom.length).toBeGreaterThan(1);
    expect(mom.every(r => r.actions.length === 1 && r.actions[0].args.verb === 'remove-preference')).toBe(true);
    const maya = prefRows('maya');
    expect(maya.find(r => r.id === 'pref-pref-noa-cake')?.actions).toHaveLength(1);
    expect(maya.find(r => r.id === 'pref-pref-noa-peanuts')?.actions).toHaveLength(0);
    const zh = screenTurn('memory', input(s, 'mom', 'zh', { ppma: 'ok', ppmaMemory: { state: 'ready', statements } })).jsonl;
    expect(zh).toContain('这是错的');
    expect(zh).toContain('忘掉');
    expect(zh).toContain('PPMA 记住的内容');
  });
});

describe('the Why of a PPMA suggestion (T6.2)', () => {
  function withPpmaItem() {
    const s = seed();
    const item = { ...s.items.find(i => i.id === 'library-books')!, id: 'ppma-1', title: 'Bring cut fruit', status: 'proposed' as const, source: { kind: 'ppma' as const, label: 'PPMA' } };
    const why = {
      id: 'why-ppma-1',
      summary: 'The group asked for fruit',
      basis: [
        { kind: 'ppma_rationale', ref: 'ppma-1', note: 'The group asked for fruit' },
        { kind: 'preference', note: 'No peanuts (hard)' }
      ],
      source: 'ppma' as const,
      decisionId: 'dec-1'
    };
    return { ...s, items: [...s.items, item], whys: [...s.whys, why] };
  }
  const rows = (jsonl: string) => (parse(jsonl).data.why ?? []) as Array<{ label: string; value: string }>;

  it("shows PPMA's reason, what Homemind weighed and PPMA's own explanation, loading then ready", () => {
    const s = withPpmaItem();
    const itemScreen = (extra: Partial<HomemindScreenData>) => screenTurn('item', input(s, 'mom', 'en', { edit: { itemId: 'ppma-1' }, ...extra })).jsonl;
    const loading = rows(itemScreen({ itemPpma: { state: 'loading' } }));
    expect(loading.find(r => r.label === 'PPMA’s reason')?.value).toBe('The group asked for fruit');
    expect(loading.find(r => r.label === 'Saved preferences considered')?.value).toContain('No peanuts');
    expect(loading.find(r => r.label === 'PPMA explains')?.value).toContain('Asking PPMA');
    expect(rows(itemScreen({ itemPpma: { state: 'ready', summary: 'PPMA saw the group message' } })).find(r => r.label === 'PPMA explains')?.value).toBe('PPMA saw the group message');
    expect(rows(itemScreen({ itemPpma: { state: 'unavailable' } })).find(r => r.label === 'PPMA explains')?.value).toContain('no explanation');
    expect(rows(itemScreen({})).find(r => r.label === 'Source')?.value).toBe('PPMA');
  });

  it('does not claim a PPMA explanation when there is no decision record', () => {
    const s = withPpmaItem();
    s.whys = s.whys.map(w => (w.id === 'why-ppma-1' ? { ...w, decisionId: undefined } : w));
    const shown = rows(screenTurn('item', input(s, 'mom', 'en', { edit: { itemId: 'ppma-1' } })).jsonl);
    expect(shown.find(r => r.label === 'PPMA explains')?.value).toContain('no decision record');
  });

  it('shows nothing extra for an item that did not come from PPMA', () => {
    const s = seed();
    expect(screenTurn('item', input(s, 'mom', 'en', { edit: { itemId: 'library-books' } })).jsonl).not.toContain('Why is this suggested?');
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

describe('services screen (T7.2)', () => {
  const at18 = Date.UTC(2026, 10, 4, 10, 0); // Wednesday 18:00 in Shanghai: the shop is open
  const servicesInput = (state: HomemindState, member: string, lang: HomemindLang, demo: boolean) =>
    input(state, member, lang, { now: new Date(at18).toISOString(), services: servicesViewFor(state, member, at18), demo });
  const lists = (surface: A2uiSurface) => Object.values(surface.components).filter(c => c.component === 'List');

  it('parses in both languages, and every card is labelled simulated', () => {
    const posted = postNextGroupMessage(seed(), at18);
    if (!posted.ok) throw new Error('fixture');
    for (const lang of ['en', 'zh'] as const) {
      const surface = parse(screenTurn('services', servicesInput(posted.state, 'mom', lang, true)).jsonl);
      const cards = lists(surface);
      expect(cards.map(c => c.id).sort()).toEqual(['group', 'inbox', 'pizza', 'sitters', 'weather']);
      for (const card of cards) {
        const rows = dataAt(surface, card.dataPath) as Array<Record<string, unknown>>;
        expect(rows.length, card.id).toBeGreaterThan(0);
        expect(rows.every(r => r.simulated === true), card.id).toBe(true);
      }
      const all = JSON.stringify(surface);
      expect(all).toContain(lang === 'zh' ? '模拟' : 'Simulated');
      expect(all).toContain('各位家长好');
      expect(all).toContain(lang === 'zh' ? '营业中' : 'Open now');
    }
  });

  it('an empty group and an empty mailbox still say simulated in their text', () => {
    const surface = parse(screenTurn('services', servicesInput(seed(), 'maya', 'zh', false)).jsonl);
    expect(lists(surface).map(c => c.id)).not.toContain('group');
    expect(lists(surface).map(c => c.id)).not.toContain('inbox');
    const texts = Object.values(surface.components).filter(c => c.component === 'Text').map(c => String(c.text));
    expect(texts.find(t => t.includes('幼儿园群'))).toContain('模拟');
    expect(texts.find(t => t.includes('收件箱'))).toContain('模拟');
  });

  it('offers "post next group message" only in demo mode and while messages are left', () => {
    const post = (state: HomemindState, demo: boolean) => actionsOf(parse(screenTurn('services', servicesInput(state, 'dad', 'en', demo)).jsonl)).filter(a => a.args?.verb === 'post-group-message');
    expect(post(seed(), true)).toHaveLength(1);
    expect(post(seed(), true)[0].label).toContain('(3)');
    expect(post(seed(), false)).toHaveLength(0);
    let state = seed();
    for (let n = 0; n < 3; n++) {
      const next = postNextGroupMessage(state, at18);
      if (!next.ok) throw new Error('fixture');
      state = next.state;
    }
    expect(post(state, true)).toHaveLength(0);
  });

  it("shows only the member's own inbox", () => {
    const mom = JSON.stringify(parse(screenTurn('services', servicesInput(seed(), 'mom', 'en', false)).jsonl));
    const dad = JSON.stringify(parse(screenTurn('services', servicesInput(seed(), 'dad', 'en', false)).jsonl));
    expect(mom).toContain('Your books are due tomorrow');
    expect(dad).not.toContain('Your books are due tomorrow');
    expect(dad).toContain('Pool closed next Saturday');
    expect(mom).not.toContain('Big sale');
  });
});

describe('rule cards and the Rules screen (T7.3)', () => {
  const card = { id: 'card-1', adapter: 'pizza', mode: 'simulated' as const, payload: { title: 'Friday pizza night: order', titleZh: '周五披萨之夜：下单', summary: '1 × Large margherita · 89 CNY', summaryZh: '大号玛格丽特披萨 × 1 · 89 CNY' }, payloadHash: 'h', status: 'pending' as const, expiresAt: new Date(NOW + 3600_000).toISOString(), whyId: 'why-1' };

  it("puts the parent's own token behind the card's Confirm button, and none without one", () => {
    const s = { ...seed(), actionCards: [card] };
    const withToken = parse(screenTurn('my-day', input(s, 'dad', 'zh', { confirmations: { 'card-1': { token: 'tok.sig', expiresAt: card.expiresAt } } })).jsonl);
    expect(actionsOf(withToken).find(a => a.args?.verb === 'confirm-card')!.args).toMatchObject({ cardId: 'card-1', token: 'tok.sig' });
    expect(JSON.stringify(withToken.data)).toContain('周五披萨之夜：下单');
    expect(JSON.stringify(withToken.data)).toContain('大号玛格丽特披萨');
    const without = parse(screenTurn('my-day', input(s, 'dad', 'en')).jsonl);
    expect(actionsOf(without).find(a => a.args?.verb === 'confirm-card')!.args!.token).toBeUndefined();
  });

  it('shows a finished card as one line for a while, so an expired one is seen', () => {
    const done = { ...card, status: 'expired' as const, finishedAt: new Date(NOW - 60_000).toISOString() };
    const s = { ...seed(), actionCards: [done] };
    expect(screenTurn('my-day', input(s, 'mom', 'en')).jsonl).toContain('Friday pizza night: order: expired: nobody tapped, so nothing happened (Simulated)');
    expect(screenTurn('my-day', input(s, 'dad', 'zh')).jsonl).toContain('已过期');
    expect(screenTurn('my-day', input(s, 'maya', 'en')).jsonl).not.toContain('Friday pizza');
  });

  it('gives parents Turn off (and the demo button only in demo mode); a teen gets no buttons and a note', () => {
    const s = seed();
    const mom = parse(screenTurn('rules', input(s, 'mom', 'en', { demo: true })).jsonl);
    expect(actionsOf(mom).map(a => a.args?.verb)).toEqual(expect.arrayContaining(['rule-toggle', 'run-rule']));
    expect(actionsOf(mom).find(a => a.args?.verb === 'rule-toggle')!.args).toMatchObject({ ruleId: 'rule-friday-pizza', action: 'disable' });
    expect(actionsOf(parse(screenTurn('rules', input(s, 'mom', 'en')).jsonl)).some(a => a.args?.verb === 'run-rule')).toBe(false);
    const maya = parse(screenTurn('rules', input(s, 'maya', 'en', { demo: true })).jsonl);
    expect(actionsOf(maya)).toHaveLength(0);
    expect(JSON.stringify(maya.data) + JSON.stringify(maya.components)).toContain('Only a parent can turn a rule');
    expect(JSON.stringify(parse(screenTurn('rules', input(s, 'dad', 'zh')).jsonl).data)).toContain('周五 18:30');
  });
});
