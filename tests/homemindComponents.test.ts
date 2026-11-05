import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { A2uiSurfaceView } from '../src/components/a2ui/A2uiSurfaceView';
import {
  addDays,
  addMonths,
  entriesOn,
  filterEntries,
  monthGrid,
  rangeTitle,
  readBoard,
  startOfWeek,
  step,
  weekDates,
  weekdayOf
} from '../src/components/a2ui/homemindComponents';
import type { BoardEntry } from '../src/components/a2ui/homemindComponents';
import { I18nContext } from '../src/i18n/I18nContext';
import { screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindLang, HomemindScreenName } from '../src/lib/homemindSurfaces';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import type { A2uiComponent, A2uiSurface } from '../src/types';

const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const clock = fixedClock(NOW);
const seed = () => seedState({ now: NOW, timezone: 'Asia/Shanghai' });
const SCREENS: HomemindScreenName[] = ['my-day', 'family', 'calendar', 'search', 'rules', 'memory', 'activity', 'settings'];
const enTr = (en: string) => en;
const zhTr = (_en: string, zh: string) => zh;

function surfaceOf(state: HomemindState, screen: HomemindScreenName, member: string, lang: HomemindLang): A2uiSurface {
  const view = viewFor(state, member)!;
  const turn = screenTurn(screen, { lang, now: new Date(NOW).toISOString(), view, ...(screen === 'search' ? { query: 'pickup', results: [] } : {}) });
  return A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0];
}

function render(surface: A2uiSurface, lang: HomemindLang = 'en'): string {
  const value = { lang, setLang: () => {}, tr: lang === 'zh' ? zhTr : enTr, locale: lang === 'zh' ? 'zh-CN' : 'en-US' };
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value }, createElement(A2uiSurfaceView, { surface, onAction: () => {} })));
}

function single(component: A2uiComponent, data: Record<string, unknown>): A2uiSurface {
  return { id: 's', root: 'root', components: { root: { id: 'root', component: 'Column', children: [component.id] }, [component.id]: component }, data };
}

const count = (html: string, needle: string) => html.split(needle).length - 1;
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function withSimulatedItem(): HomemindState {
  const r = applyChange(
    seed(),
    { kind: 'create', item: { type: 'task', title: 'Bring apples', forMemberIds: ['mom'], source: { kind: 'group', label: 'Kindergarten group', simulated: true } } as never },
    'mom',
    clock
  );
  if (!r.ok) throw new Error(r.message);
  return r.state;
}

describe('every Homemind screen renders with no unknown component', () => {
  for (const lang of ['en', 'zh'] as const) {
    for (const screen of SCREENS) {
      it(`${screen} in ${lang}`, () => {
        const html = render(surfaceOf(seed(), screen, 'mom', lang), lang);
        expect(html).not.toContain('Unknown component');
        expect(html).not.toContain('未知组件');
      });
    }
  }
});

describe('TaskList', () => {
  it('renders each row with its title, owner, state label and action buttons', () => {
    const surface = surfaceOf(seed(), 'family', 'mom', 'en');
    const html = render(surface);
    const rows = [...((surface.data.open as Array<{ id: string; title: string; actions: Array<{ label: string }> }>) ?? [])];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(html).toContain(`data-task-id="${row.id}"`);
      for (const a of row.actions) expect(html).toContain(`>${esc(a.label)}</button>`);
    }
    expect(html).toContain('hm-task-state is-open');
    expect(html).toContain('>Open<');
  });

  it('gives each button an accessible name with the row title, so repeated "Claim" buttons differ', () => {
    const html = render(surfaceOf(seed(), 'family', 'mom', 'en'));
    expect(html).toMatch(/aria-label="[^"]+: [^"]+"/);
  });

  it('shows state labels in Chinese', () => {
    const html = render(surfaceOf(seed(), 'family', 'mom', 'zh'), 'zh');
    expect(html).toContain('待认领');
  });

  it('renders nothing for rows that are not objects, and survives missing fields', () => {
    const html = render(single({ id: 't', component: 'TaskList', title: 'Tasks', dataPath: '/rows' }, { rows: [null, 3, { title: 'Only a title' }] }));
    expect(count(html, '<li')).toBe(1);
    expect(html).toContain('Only a title');
  });
});

describe('Simulated badge', () => {
  it('is visible on a simulated task row in English and Chinese', () => {
    const s = withSimulatedItem();
    expect(render(surfaceOf(s, 'family', 'mom', 'en'))).toContain('<span class="hm-sim-badge">Simulated</span>');
    expect(render(surfaceOf(s, 'family', 'mom', 'zh'), 'zh')).toContain('<span class="hm-sim-badge">模拟</span>');
  });

  it('appears only on simulated rows', () => {
    const s = withSimulatedItem();
    const surface = surfaceOf(s, 'family', 'mom', 'en');
    const all = [...((surface.data.proposed as Array<{ simulated?: boolean }>) ?? []), ...((surface.data.open as Array<{ simulated?: boolean }>) ?? [])];
    expect(count(render(surface), 'hm-sim-badge')).toBe(all.filter(r => r.simulated).length);
  });

  it('is visible on a simulated action card, and absent on a real one', () => {
    const card = { id: 'card-1', adapter: 'pizza', mode: 'simulated' as const, payload: { title: 'Friday pizza', summary: '1 large margherita' }, payloadHash: 'h', status: 'pending' as const, expiresAt: new Date(NOW + 3600_000).toISOString(), whyId: 'why-1' };
    const sim = render(surfaceOf({ ...seed(), actionCards: [card] }, 'my-day', 'mom', 'zh'), 'zh');
    expect(sim).toContain('approval-card');
    expect(sim).toContain('hm-sim-badge');
    const real = render(surfaceOf({ ...seed(), actionCards: [{ ...card, mode: 'real' as const }] }, 'my-day', 'mom', 'en'));
    expect(real).toContain('approval-card');
    expect(real).not.toContain('hm-sim-badge');
  });

  it('renders on existing cards only when they say simulated: true, so other surfaces are unchanged', () => {
    const list = { id: 'l', component: 'List', dataPath: '/rows' };
    expect(render(single(list, { rows: [{ title: 'A', subtitle: 'b', meta: 'c' }] }))).not.toContain('hm-sim-badge');
    expect(render(single(list, { rows: [{ title: 'A', subtitle: 'b', meta: 'c', simulated: true }] }))).toContain('hm-sim-badge');
    for (const component of ['ConfirmPanel', 'ExpandableCard']) {
      expect(render(single({ id: 'c', component, title: 'X', dataPath: '/rows' }, { rows: [] }))).not.toContain('hm-sim-badge');
      expect(render(single({ id: 'c', component, title: 'X', dataPath: '/rows', simulated: true }, { rows: [] }))).toContain('hm-sim-badge');
    }
    expect(render(single({ id: 'p', component: 'PaymentCard', dataPath: '/p' }, { p: { title: 'Pay' } }))).not.toContain('hm-sim-badge');
    expect(render(single({ id: 'p', component: 'PaymentCard', dataPath: '/p' }, { p: { title: 'Pay', simulated: true } }))).toContain('hm-sim-badge');
  });
});

describe('CalendarBoard rendering', () => {
  it('opens on the week of today, marks today, and lists the seeded events', () => {
    const surface = surfaceOf(seed(), 'calendar', 'mom', 'en');
    const html = render(surface);
    expect(html).toContain('data-view="week"');
    expect(html).toContain('data-anchor="2026-11-04"');
    expect(count(html, '<li class="hm-cal-day')).toBe(7);
    expect(html).toContain('aria-current="date"');
    const board = readBoard(surface.data.board)!;
    const thisWeek = weekDates('2026-11-04', board.weekStartsOn);
    for (const e of board.entries.filter(x => thisWeek.includes(x.date))) expect(html).toContain(`data-entry-id="${e.id}"`);
  });

  it('renders the day and month views when asked, with a labelled month grid', () => {
    const surface = surfaceOf(seed(), 'calendar', 'mom', 'zh');
    const board = surface.components.board;
    const day = render({ ...surface, components: { ...surface.components, board: { ...board, view: 'day' } } }, 'zh');
    expect(day).toContain('data-view="day"');
    expect(day).toContain('11月4日');
    const month = render({ ...surface, components: { ...surface.components, board: { ...board, view: 'month' } } }, 'zh');
    expect(month).toContain('<table class="hm-cal-month">');
    expect(month).toContain('2026年11月');
    const weeks = monthGrid('2026-11-04', readBoard(surface.data.board)!.weekStartsOn).length;
    expect(count(month, 'class="hm-cal-cell"')).toBe(weeks * 7);
  });

  it('has labelled filters for person and type', () => {
    const html = render(surfaceOf(seed(), 'calendar', 'mom', 'en'));
    expect(html).toMatch(/<label for="[^"]+-member"><span>Person<\/span><select id="[^"]+-member"/);
    expect(html).toContain('Everyone');
  });

  it('shows an error notice, not an empty board, when the data is unreadable', () => {
    const html = render(single({ id: 'b', component: 'CalendarBoard', dataPath: '/board' }, { board: { today: 'soon' } }));
    expect(html).toContain('a2ui-error');
    expect(html).toContain('Calendar unavailable');
  });

  it('shows who is unavailable on an unavailability event', () => {
    const r = applyChange(
      seed(),
      { kind: 'create', item: { type: 'event', title: 'Wedding', start: new Date(NOW + 86_400_000).toISOString(), end: new Date(NOW + 86_400_000 + 4 * 3600_000).toISOString(), forMemberIds: ['mom'], unavailableMemberIds: ['mom'] } as never },
      'mom',
      clock
    );
    if (!r.ok) throw new Error(r.message);
    const html = render(surfaceOf(r.state, 'calendar', 'dad', 'en'));
    expect(html).toContain('Wedding');
    expect(html).toContain('<span class="hm-cal-away">Unavailable: Mom</span>');
  });
});

describe('calendar date math', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('knows weekdays and starts weeks on Sunday or Monday', () => {
    expect(weekdayOf('2026-11-04')).toBe(3);
    expect(startOfWeek('2026-11-04', 0)).toBe('2026-11-01');
    expect(startOfWeek('2026-11-04', 1)).toBe('2026-11-02');
    expect(startOfWeek('2026-11-02', 1)).toBe('2026-11-02');
    expect(startOfWeek('2026-11-01', 1)).toBe('2026-10-26');
    expect(weekDates('2026-11-04', 1)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  });

  it('adds months and clamps to the month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('builds whole weeks covering the month', () => {
    const grid = monthGrid('2026-11-04', 1);
    expect(grid[0][0]).toBe('2026-10-26');
    expect(grid.every(w => w.length === 7)).toBe(true);
    expect(grid.flat()).toContain('2026-11-30');
    expect(grid.at(-1)![6] >= '2026-11-30').toBe(true);
    expect(monthGrid('2026-02-10', 0)).toHaveLength(4); // Feb 2026 starts on a Sunday and has 28 days
  });

  it('steps by day, week and month', () => {
    expect(step('day', '2026-11-04', 1)).toBe('2026-11-05');
    expect(step('week', '2026-11-04', -1)).toBe('2026-10-28');
    expect(step('month', '2026-11-30', 1)).toBe('2026-12-01');
  });

  it('titles a range in both languages', () => {
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    expect(rangeTitle('day', '2026-11-04', 1, wd, enTr)).toBe('Wed, Nov 4');
    expect(rangeTitle('week', '2026-11-04', 1, wd, enTr)).toBe('Nov 2 – Nov 8');
    expect(rangeTitle('month', '2026-11-04', 1, wd, zhTr)).toBe('2026年11月');
  });
});

describe('calendar filtering', () => {
  const e = (over: Partial<BoardEntry>): BoardEntry => ({ id: 'x', itemId: 'x', title: 'X', date: '2026-11-04', allDay: false, ownerLabel: '', memberIds: [], tone: 'muted', simulated: false, unavailable: [], ...over });
  const entries = [
    e({ id: 'a', title: 'Pickup', time: '16:00', memberIds: ['noa', 'dad'], type: 'task' }),
    e({ id: 'b', title: 'Trip', date: '2026-11-03', endDate: '2026-11-05', allDay: true, memberIds: ['mom'], type: 'event' }),
    e({ id: 'c', title: 'Breakfast', time: '08:00', memberIds: ['mom'], type: 'preparation' })
  ];

  it('filters by person and by type', () => {
    expect(filterEntries(entries, 'dad', 'all').map(x => x.id)).toEqual(['a']);
    expect(filterEntries(entries, 'mom', 'event').map(x => x.id)).toEqual(['b']);
    expect(filterEntries(entries, 'all', 'all')).toHaveLength(3);
  });

  it('puts all-day entries first, then by time, and spreads multi-day entries', () => {
    expect(entriesOn(entries, '2026-11-04').map(x => x.id)).toEqual(['b', 'c', 'a']);
    expect(entriesOn(entries, '2026-11-05').map(x => x.id)).toEqual(['b']);
    expect(entriesOn(entries, '2026-11-06')).toEqual([]);
  });

  it('reads untrusted board data defensively', () => {
    expect(readBoard(null)).toBeNull();
    expect(readBoard({ today: '2026/11/04' })).toBeNull();
    const b = readBoard({ today: '2026-11-04', entries: [{ date: 'bad' }, { date: '2026-11-04', title: 'Ok', tone: 'purple' }], members: [{ id: 'mom' }] })!;
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0].tone).toBe('muted');
    expect(b.members).toEqual([]);
    expect(b.weekdays).toHaveLength(7);
  });
});
