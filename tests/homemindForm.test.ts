import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../server/homemind/clock';
import { applyChange } from '../server/homemind/core';
import type { NewItem } from '../server/homemind/core';
import { seedState } from '../server/homemind/seed';
import type { HomemindState } from '../server/homemind/types';
import { viewFor } from '../server/homemind/visibility';
import { A2uiSurfaceStore } from '../src/protocol/a2ui/store';
import { buildSave, formValues, localToIso } from '../src/lib/homemindForm';
import { screenTurn } from '../src/lib/homemindSurfaces';
import type { HomemindEditTarget, HomemindLang } from '../src/lib/homemindSurfaces';
import { runHomemindAction, homemindHealth, SESSION_HEADER } from '../src/transport/homemind';
import type { A2uiAction, A2uiSurface } from '../src/types';

// T3.2: the Add and edit screen, the form helper behind Save, and the client's action mapping.

const NOW = Date.UTC(2026, 10, 4, 2, 0); // Wednesday 2026-11-04 10:00 in Shanghai
const ZONE = 'Asia/Shanghai';
const clock = fixedClock(NOW);
const seed = () => seedState({ now: NOW, timezone: ZONE });

function editSurface(state: HomemindState, member: string, edit: HomemindEditTarget, lang: HomemindLang = 'en'): A2uiSurface {
  const view = viewFor(state, member);
  if (!view) throw new Error('no member');
  const turn = screenTurn('edit', { lang, now: new Date(NOW).toISOString(), view, edit });
  const surfaces = A2uiSurfaceStore.fromJsonl(turn.jsonl).list();
  expect(surfaces).toHaveLength(1);
  return surfaces[0];
}

const components = (s: A2uiSurface) => Object.values(s.components);
const named = (s: A2uiSurface, name: string) => components(s).find(c => c.name === name);
const allActions = (s: A2uiSurface): A2uiAction[] => {
  const out: A2uiAction[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (Array.isArray(r.actions)) out.push(...(r.actions as A2uiAction[]));
      if (r.open && typeof r.open === 'object') out.push(r.open as A2uiAction);
      Object.values(r).forEach(walk);
    }
  };
  walk(s.data);
  walk(components(s));
  return out;
};
const saveArgs = (s: A2uiSurface) => allActions(s).find(a => a.args?.verb === 'save')!.args!;

function create(state: HomemindState, item: NewItem, actor = 'mom'): HomemindState {
  const r = applyChange(state, { kind: 'create', item }, actor, clock);
  if (!r.ok) throw new Error(r.message);
  return r.state;
}

describe('localToIso', () => {
  it('converts a Shanghai wall time to UTC', () => {
    expect(localToIso('2026-11-04', '16:30', ZONE)).toBe('2026-11-04T08:30:00.000Z');
    expect(localToIso('2026-11-05', '00:00', ZONE)).toBe('2026-11-04T16:00:00.000Z');
  });
  it('follows daylight saving in a zone that has it', () => {
    expect(localToIso('2026-07-01', '09:00', 'America/New_York')).toBe('2026-07-01T13:00:00.000Z');
    expect(localToIso('2026-12-01', '09:00', 'America/New_York')).toBe('2026-12-01T14:00:00.000Z');
  });
  it('refuses bad input', () => {
    expect(localToIso('2026-02-30', '09:00', ZONE)).toBeNull();
    expect(localToIso('2026-11-04', '25:00', ZONE)).toBeNull();
    expect(localToIso('tomorrow', '09:00', ZONE)).toBeNull();
    expect(localToIso('2026-11-04', '09:00', 'Not/AZone')).toBeNull();
  });
});

describe('the Add and edit screen', () => {
  it('a new item: type choice, empty title, today, owner choice, Parents-only toggle for a parent', () => {
    const s = editSurface(seed(), 'mom', {});
    expect(s.title).toBe('Add to the board');
    expect(named(s, 'type')?.component).toBe('ChoiceGroup');
    expect(named(s, 'title')?.default).toBe('');
    expect(named(s, 'date')).toMatchObject({ inputType: 'date', default: '2026-11-04' });
    expect(named(s, 'time')).toMatchObject({ inputType: 'time', default: '' });
    expect(named(s, 'owner')?.component).toBe('ChoiceGroup');
    const owners = (named(s, 'owner')?.options as Array<{ value: string }>).map(o => o.value);
    expect(owners).toEqual(['none', 'mom', 'dad', 'maya']); // Noa has no account
    expect(named(s, 'parentsOnly')?.component).toBe('Toggle');
    expect(named(s, 'away.noa')).toBeUndefined(); // a child is never "away" for the board
    expect(saveArgs(s)).toMatchObject({ verb: 'save', mode: 'create', zone: ZONE });
  });

  it('a teen gets no Parents-only toggle', () => {
    expect(named(editSurface(seed(), 'maya', {}), 'parentsOnly')).toBeUndefined();
  });

  it('an event opens with its values, its own buttons, its preparations and "Add preparation"', () => {
    const s = editSurface(seed(), 'mom', { itemId: 'family-dinner' });
    expect(s.title).toBe('Edit item');
    expect(named(s, 'type')).toBeUndefined();
    expect(named(s, 'owner')).toBeUndefined();
    expect(named(s, 'title')?.default).toBe(seed().items.find(i => i.id === 'family-dinner')!.title);
    expect(typeof named(s, 'date')?.default).toBe('string');
    const preps = s.data.preps as Array<{ id: string; actions: A2uiAction[]; open?: A2uiAction }>;
    expect(preps.map(p => p.id)).toContain('family-dinner-flowers');
    const flowers = preps.find(p => p.id === 'family-dinner-flowers')!;
    expect(flowers.actions.map(a => a.args?.verb)).toEqual(['cancel']);
    expect(flowers.open?.args).toMatchObject({ verb: 'edit', itemId: 'family-dinner-flowers' });
    const verbs = allActions(s).map(a => a.args?.verb);
    expect(verbs).toContain('add');
    expect(allActions(s).find(a => a.args?.verb === 'add')?.args).toMatchObject({ parentEventId: 'family-dinner' });
    expect(saveArgs(s)).toMatchObject({ mode: 'edit', itemId: 'family-dinner', type: 'event' });
    // The item's own row carries no "Edit" link to itself.
    expect((s.data.this as Array<{ open?: unknown }>)[0].open).toBeUndefined();
  });

  it('a new preparation is tied to its event and starts on the event date', () => {
    const state = seed();
    const s = editSurface(state, 'dad', { parentId: 'family-dinner' }, 'zh');
    expect(s.title).toBe('添加准备事项');
    expect(named(s, 'type')).toBeUndefined();
    expect(named(s, 'away.mom')).toBeUndefined();
    expect(named(s, 'parentsOnly')).toBeUndefined();
    expect(saveArgs(s)).toMatchObject({ mode: 'create', type: 'preparation', parentEventId: 'family-dinner' });
    const dinner = state.items.find(i => i.id === 'family-dinner')!;
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date(dinner.start!));
    expect(named(s, 'date')?.default).toBe(local);
  });

  it('a Parents-only item is "not on your board" for a teen, with no trace of it', () => {
    const s = editSurface(seed(), 'maya', { itemId: 'counselor-meeting' });
    expect(JSON.stringify(s)).not.toMatch(/counselor/i);
    expect(components(s).some(c => c.component === 'ErrorNotice')).toBe(true);
    expect(allActions(s).map(a => a.args?.verb)).toEqual(['back']);
  });

  it('rows and calendar entries open the item for editing', () => {
    const view = viewFor(seed(), 'mom')!;
    const my = A2uiSurfaceStore.fromJsonl(screenTurn('my-day', { lang: 'en', now: new Date(NOW).toISOString(), view }).jsonl).list()[0];
    const rows = Object.values(my.data).flatMap(v => (Array.isArray(v) ? v : [])) as Array<{ id: string; open?: A2uiAction }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.open?.args).toEqual({ verb: 'edit', itemId: row.id });
    const cal = A2uiSurfaceStore.fromJsonl(screenTurn('calendar', { lang: 'en', now: new Date(NOW).toISOString(), view }).jsonl).list()[0];
    const entries = (cal.data.board as { entries: Array<{ itemId: string; open?: A2uiAction }> }).entries;
    for (const e of entries) expect(e.open?.args).toEqual({ verb: 'edit', itemId: e.itemId });
  });
});

describe('buildSave', () => {
  it('a new event with a time, an end, people and someone away', () => {
    const s = editSurface(seed(), 'mom', {});
    const { values, defaults } = formValues(s, { title: ' Wedding ', time: '15:00', endTime: '22:00', 'for.mom': true, 'away.mom': true, important: true });
    const r = buildSave(saveArgs(s), values, defaults);
    expect(r).toEqual({
      ok: true,
      request: {
        method: 'POST',
        path: '/api/homemind/items',
        body: { type: 'event', title: 'Wedding', start: '2026-11-04T07:00:00.000Z', allDay: false, end: '2026-11-04T14:00:00.000Z', forMemberIds: ['mom'], unavailableMemberIds: ['mom'], importance: 'critical' }
      }
    });
  });

  it('a new task with an owner and no date; "away" is ignored for a task', () => {
    const s = editSurface(seed(), 'mom', {});
    const { values, defaults } = formValues(s, { type: 'task', title: 'Buy a gift', date: '', owner: 'dad', 'away.dad': true });
    const r = buildSave(saveArgs(s), values, defaults);
    expect(r).toEqual({ ok: true, request: { method: 'POST', path: '/api/homemind/items', body: { type: 'task', title: 'Buy a gift', ownerId: 'dad' } } });
  });

  it('no time means all day', () => {
    const s = editSurface(seed(), 'mom', {});
    const { values, defaults } = formValues(s, { title: 'Sports day' });
    const r = buildSave(saveArgs(s), values, defaults);
    expect(r.ok && r.request?.body).toMatchObject({ start: '2026-11-03T16:00:00.000Z', end: '2026-11-04T16:00:00.000Z', allDay: true });
  });

  it('a new preparation carries its event', () => {
    const s = editSurface(seed(), 'mom', { parentId: 'family-dinner' });
    const { values, defaults } = formValues(s, { title: 'Bake a cake' });
    const r = buildSave(saveArgs(s), values, defaults);
    expect(r.ok && r.request?.body).toMatchObject({ type: 'preparation', title: 'Bake a cake', parentEventId: 'family-dinner' });
  });

  it('an edit sends only what changed, with the version', () => {
    const state = seed();
    const s = editSurface(state, 'mom', { itemId: 'family-dinner' });
    const version = state.items.find(i => i.id === 'family-dinner')!.version;
    const untouched = formValues(s, {});
    expect(buildSave(saveArgs(s), untouched.values, untouched.defaults)).toEqual({ ok: true, request: null });
    const { values, defaults } = formValues(s, { notes: 'Bring the photo album', 'away.dad': true });
    const r = buildSave(saveArgs(s), values, defaults);
    expect(r).toEqual({ ok: true, request: { method: 'PATCH', path: '/api/homemind/items/family-dinner', body: { version, patch: { notes: 'Bring the photo album', unavailableMemberIds: ['dad'] } } } });
  });

  it('an edit in Chinese that keeps the seeded Chinese title does not overwrite the English one', () => {
    const s = editSurface(seed(), 'dad', { itemId: 'pickup-today' }, 'zh');
    const { values, defaults } = formValues(s, {});
    expect(buildSave(saveArgs(s), values, defaults)).toEqual({ ok: true, request: null });
  });

  it('refuses a missing title, an end before the start, and an end without a start', () => {
    const s = editSurface(seed(), 'mom', {});
    const check = (form: Record<string, unknown>) => {
      const { values, defaults } = formValues(s, form);
      const r = buildSave(saveArgs(s), values, defaults);
      return r.ok ? 'ok' : r.problem;
    };
    expect(check({ title: '  ' })).toBe('title');
    expect(check({ title: 'x', time: '10:00', endTime: '09:00' })).toBe('endBeforeStart');
    expect(check({ title: 'x', endTime: '09:00' })).toBe('endNeedsStart');
    expect(check({ title: 'x', date: '', time: '09:00' })).toBe('date');
    expect(check({ title: 'x', date: '2026-13-01' })).toBe('date');
    expect(check({ title: 'x', time: '15:00', 'away.mom': true })).toBe('awayNeedsEnd');
    expect(check({ title: 'x', 'away.mom': true })).toBe('ok'); // all day: the end is midnight
  });

  it('the request is accepted by the core', () => {
    let state = seed();
    const s = editSurface(state, 'mom', {});
    const { values, defaults } = formValues(s, { title: 'Wedding', 'away.mom': true });
    const r = buildSave(saveArgs(s), values, defaults);
    if (!r.ok || !r.request) throw new Error('no request');
    const { type, ...rest } = r.request.body as { type: 'event' };
    state = create(state, { type, ...(rest as { title: string }), source: { kind: 'manual', label: 'Mom' } });
    expect(state.items.find(i => i.title === 'Wedding')?.unavailableMemberIds).toEqual(['mom']);
  });
});

describe('runHomemindAction', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(answer: unknown = { ok: true, activityId: 'a1', items: [], opened: [], conflicts: [] }, status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
    });
    return calls;
  }

  it('maps an item verb to POST /items/:id/:verb with the version and the session header', async () => {
    const calls = stubFetch();
    await runHomemindAction({ id: 'homemind.assign:pickup-today', label: 'Assign to Dad', kind: 'homemind', args: { verb: 'assign', itemId: 'pickup-today', version: 3, memberId: 'dad' } }, 'tok');
    expect(calls[0].url).toBe('/api/homemind/items/pickup-today/assign');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ version: 3, ownerId: 'dad' });
    expect((calls[0].init.headers as Record<string, string>)[SESSION_HEADER]).toBe('tok');
  });

  it('maps remove, undo and Why?', async () => {
    const calls = stubFetch({ ok: true, activityId: 'a2', items: [], opened: [], conflicts: [], why: { summary: 's', source: 'rule' } });
    await runHomemindAction({ id: 'x', label: 'Remove', kind: 'homemind', args: { verb: 'cancel', itemId: 'p1', version: 1 } }, 't');
    await runHomemindAction({ id: 'y', label: 'Undo', kind: 'homemind', args: { verb: 'undo', itemId: 'p1', activityId: 'a1' } }, 't');
    const why = await runHomemindAction({ id: 'z', label: 'Why?', kind: 'homemind', args: { verb: 'why', whyId: 'w1' } }, 't');
    expect(calls.map(c => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual(['POST /api/homemind/items/p1/cancel', 'POST /api/homemind/items/p1/undo', 'GET /api/homemind/why/w1']);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ activityId: 'a1' });
    expect(why).toEqual({ kind: 'why', why: { summary: 's', source: 'rule' } });
  });

  it('a 409 carries the latest item', async () => {
    stubFetch({ error: 'stale', message: 'this changed', current: { id: 'p1', version: 4 } }, 409);
    await expect(runHomemindAction({ id: 'x', label: 'Done', kind: 'homemind', args: { verb: 'done', itemId: 'p1', version: 1 } }, 't')).rejects.toMatchObject({ status: 409, code: 'stale', current: { version: 4 } });
  });

  it('an unknown verb is refused without a request', async () => {
    const calls = stubFetch();
    await expect(runHomemindAction({ id: 'x', label: 'Pay', kind: 'homemind', args: { verb: 'pay' } }, 't')).rejects.toMatchObject({ code: 'unknown_action' });
    expect(calls).toHaveLength(0);
  });
});

describe('homemindHealth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is null when the bridge answers with the app page (Homemind off) or not at all', async () => {
    vi.stubGlobal('fetch', async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await homemindHealth()).toBeNull();
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    expect(await homemindHealth()).toBeNull();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    expect(await homemindHealth()).toBeNull();
  });

  it('is the health body when enabled', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ enabled: true, ready: true, llm: 'fake', ppma: 'off', demo: true }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
    expect(await homemindHealth()).toMatchObject({ enabled: true, demo: true });
  });
});

describe('after a save: the short item screen', () => {
  const itemSurface = (state: HomemindState, member: string, itemId: string, lang: HomemindLang = 'en') => {
    const view = viewFor(state, member)!;
    return A2uiSurfaceStore.fromJsonl(screenTurn('item', { lang, now: new Date(NOW).toISOString(), view, edit: { itemId } }).jsonl).list()[0];
  };

  it('shows details, the item row, Edit, Remove and Back, and no form fields', () => {
    const s = itemSurface(seed(), 'mom', 'family-dinner');
    expect(components(s).some(c => typeof c.name === 'string')).toBe(false);
    const bar = components(s).find(c => c.id === 'actions')!;
    expect(bar.actions!.map(a => a.args?.verb)).toEqual(['edit', 'cancel', 'back']);
    expect(bar.actions![0].args).toEqual({ verb: 'edit', itemId: 'family-dinner' });
    expect((s.data.details as Array<{ label: string }>).map(r => r.label)).toContain('When');
    expect((s.data.this as Array<{ id: string; open?: unknown }>)[0]).toMatchObject({ id: 'family-dinner' });
    expect((s.data.this as Array<{ open?: unknown }>)[0].open).toBeUndefined();
    // An event keeps its preparations and "Add preparation" here.
    expect((s.data.preps as Array<{ id: string }>).map(p => p.id)).toContain('family-dinner-flowers');
    expect(allActions(s).some(a => a.args?.verb === 'add' && a.args.parentEventId === 'family-dinner')).toBe(true);
  });

  it('a preparation names its event; Chinese labels', () => {
    const s = itemSurface(seed(), 'dad', 'family-dinner-flowers', 'zh');
    const labels = (s.data.details as Array<{ label: string }>).map(r => r.label);
    expect(labels).toContain('所属活动');
    expect(labels).toContain('时间');
    expect(s.data.preps).toBeUndefined();
  });

  it('a Parents-only item is "not on your board" for a teen, with no trace', () => {
    const s = itemSurface(seed(), 'maya', 'counselor-meeting');
    expect(JSON.stringify(s)).not.toMatch(/counselor/i);
    expect(allActions(s).map(a => a.args?.verb)).toEqual(['back']);
  });
});

describe('withFormError', () => {
  it('puts the error just before the bar that holds Save, and changes nothing else', async () => {
    const { withFormError } = await import('../src/components/FamilyView');
    const s = editSurface(seed(), 'mom', {});
    const out = withFormError(s, 'Not saved yet', 'Add a title.');
    const before = s.components[s.root].children!;
    const after = out.components[out.root].children!;
    expect(after.length).toBe(before.length + 1);
    expect(after[after.indexOf('hm-form-error') + 1]).toBe('actions');
    expect(out.components['hm-form-error']).toMatchObject({ component: 'ErrorNotice', body: 'Add a title.' });
    expect(s.components[s.root].children).toEqual(before); // the original surface is untouched
  });

  it('a surface without Save is left as it is', async () => {
    const { withFormError } = await import('../src/components/FamilyView');
    const view = viewFor(seed(), 'mom')!;
    const s = A2uiSurfaceStore.fromJsonl(screenTurn('family', { lang: 'en', now: new Date(NOW).toISOString(), view }).jsonl).list()[0];
    expect(withFormError(s, 't', 'm')).toBe(s);
  });
});
