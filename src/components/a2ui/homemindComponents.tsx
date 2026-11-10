import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { A2uiAction, A2uiComponent, A2uiSurface } from '../../types';
import { Icon } from '../Icons';

/**
 * Homemind catalog components (T3.1):
 * - `TaskList`: rows with an owner, a meta line, a state, and per-row actions (same pattern as `RecipeOptions`).
 *   Data: Array<{id, title, meta, ownerLabel, state, tone, simulated?, actions: A2uiAction[], quantity?}>.
 *   `quantity: {value, label, less?, more?}` draws "− 3 +" before the actions (shopping); no `less`: "−" is off.
 * - `CalendarBoard`: day, week and month views with a person and a type filter.
 *   Data: {today, weekStartsOn, weekdays, members[{id,label}], entries[]}. Dates and times are already
 *   local to the family's zone, so nothing here converts time zones. Date math is on `YYYY-MM-DD` strings.
 * - `SimulatedBadge`: the visible "Simulated / 模拟" label, also used by some existing cards.
 *
 * Shapes match `TaskRow` and `CalendarEntry` in `src/lib/homemindSurfaces.ts`; they are re-declared here
 * loosely, because the data arrives as untrusted JSON and every field is read defensively.
 */
interface Ctx {
  surface: A2uiSurface;
  onAction: (action: A2uiAction) => void;
  tr: (en: string, zh: string) => string;
}

type Tr = Ctx['tr'];

function resolve(data: unknown, path?: string): unknown {
  if (!path || path === '/') return data;
  return path
    .split('/')
    .filter(Boolean)
    .reduce<unknown>((value, segment) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined), data);
}

const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const TONES = new Set(['muted', 'warning', 'danger', 'success', 'accent']);
const toneOf = (value: unknown): string => (typeof value === 'string' && TONES.has(value) ? value : 'muted');

export function SimulatedBadge({ tr }: { tr: Tr }) {
  return <span className="hm-sim-badge">{tr('Simulated', '模拟')}</span>;
}

/** For existing cards: a badge when the card's data or component says `simulated: true`. */
export function simulatedBadge(flag: unknown, tr: Tr): ReactNode {
  return flag === true ? <SimulatedBadge tr={tr} /> : null;
}

function actionButton(action: A2uiAction, onAction: Ctx['onAction'], key: string, context: string): ReactNode {
  const variant = action.variant === 'primary' ? 'is-primary' : action.variant === 'ghost' ? 'is-ghost' : 'is-secondary';
  return (
    <button key={key} type="button" className={`a2ui-button ${variant}`} onClick={() => onAction(action)} aria-label={context ? `${action.label}: ${context}` : undefined}>
      {action.label}
    </button>
  );
}

// --- TaskList ----------------------------------------------------------------------------------------

export type TaskStateName = 'open' | 'assigned' | 'confirmed' | 'proposed' | 'done';

export function taskStateLabel(state: string, tr: Tr): string {
  switch (state) {
    case 'open':
      return tr('Open', '待认领');
    case 'assigned':
      return tr('Assigned', '已分配');
    case 'confirmed':
      return tr('Confirmed', '已确认');
    case 'proposed':
      return tr('Proposed', '建议');
    case 'done':
      return tr('Done', '已完成');
    default:
      return '';
  }
}

interface TaskRowData {
  id: string;
  title: string;
  meta: string;
  ownerLabel: string;
  state: string;
  tone: string;
  simulated: boolean;
  actions: A2uiAction[];
  open?: A2uiAction;
  quantity?: { value: number; label: string; less?: A2uiAction; more?: A2uiAction };
}

const actionOf = (value: unknown): A2uiAction | undefined =>
  value && typeof value === 'object' && typeof (value as A2uiAction).label === 'string' && typeof (value as A2uiAction).id === 'string' ? (value as A2uiAction) : undefined;

/** A title that opens the item when the row carries an `open` action, plain text otherwise. */
function OpenTitle({ title, open, onAction, className }: { title: string; open?: A2uiAction; onAction: Ctx['onAction']; className: string }) {
  if (!open) return <strong className={className}>{title}</strong>;
  return (
    <button type="button" className={`${className} hm-open`} onClick={() => onAction(open)} aria-label={`${open.label}: ${title}`}>
      {title}
    </button>
  );
}

function readRows(raw: unknown): TaskRowData[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row, index) => ({
      id: str(row.id) || `row-${index}`,
      title: str(row.title),
      meta: str(row.meta),
      ownerLabel: str(row.ownerLabel),
      state: str(row.state),
      tone: toneOf(row.tone),
      simulated: row.simulated === true,
      actions: Array.isArray(row.actions) ? (row.actions.filter(a => a && typeof a === 'object' && typeof (a as A2uiAction).label === 'string') as A2uiAction[]) : [],
      ...(actionOf(row.open) ? { open: actionOf(row.open) } : {}),
      ...(quantityOf(row.quantity) ? { quantity: quantityOf(row.quantity) } : {})
    }));
}

function quantityOf(raw: unknown): TaskRowData['quantity'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as Record<string, unknown>;
  if (typeof q.value !== 'number' || !Number.isFinite(q.value)) return undefined;
  return { value: q.value, label: str(q.label), less: actionOf(q.less), more: actionOf(q.more) };
}

/** "− 3 +": the number between its two buttons. A missing action turns its button off. */
function QuantityStepper({ quantity, title, onAction }: { quantity: NonNullable<TaskRowData['quantity']>; title: string; onAction: Ctx['onAction'] }) {
  const { value, label, less, more } = quantity;
  return (
    <span className="hm-qty" role="group" aria-label={`${label}: ${title}`}>
      <button type="button" className="hm-qty-btn" disabled={!less} onClick={() => less && onAction(less)} aria-label={less ? `${less.label}: ${title}` : undefined}>
        −
      </button>
      <output className="hm-qty-value" aria-live="polite">
        {value}
      </output>
      <button type="button" className="hm-qty-btn" disabled={!more} onClick={() => more && onAction(more)} aria-label={more ? `${more.label}: ${title}` : undefined}>
        +
      </button>
    </span>
  );
}

function TaskList({ component, ctx, id }: { component: A2uiComponent; ctx: Ctx; id: string }) {
  const rows = readRows(resolve(ctx.surface.data, typeof component.dataPath === 'string' ? component.dataPath : undefined));
  const titleId = `${id}-title`;
  return (
    <div className="options-block hm-tasks">
      {component.title ? (
        <div className="block-title" id={titleId}>
          {component.title}
        </div>
      ) : null}
      <ul className="hm-task-list" aria-labelledby={component.title ? titleId : undefined}>
        {rows.map(row => (
          <li className={`hm-task is-${row.tone} state-${row.state || 'none'}`} key={row.id} data-task-id={row.id} data-state={row.state}>
            <div className="hm-task-head">
              <OpenTitle className="hm-task-title" title={row.title} open={row.open} onAction={ctx.onAction} />
              <span className={`hm-task-state is-${row.state || 'none'}`}>{taskStateLabel(row.state, ctx.tr)}</span>
            </div>
            <div className="hm-task-sub">
              {row.ownerLabel ? (
                <span className="hm-task-owner">
                  <Icon name="user" size={11} />
                  {row.ownerLabel}
                </span>
              ) : null}
              {row.simulated ? <SimulatedBadge tr={ctx.tr} /> : null}
            </div>
            {row.meta ? <p className="hm-task-meta">{row.meta}</p> : null}
            {row.actions.length || row.quantity ? (
              <div className="hm-task-actions">
                {row.quantity ? <QuantityStepper quantity={row.quantity} title={row.title} onAction={ctx.onAction} /> : null}
                {row.actions.map((action, index) => actionButton(action, ctx.onAction, `${row.id}-${index}`, row.title))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- calendar date math (pure, exported for tests) -------------------------------------------------

export type CalendarView = 'day' | 'week' | 'month';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * 86_400_000);
}

/** 0 = Sunday. */
export function weekdayOf(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

export function startOfWeek(date: string, weekStartsOn: number): string {
  return addDays(date, -((weekdayOf(date) - weekStartsOn + 7) % 7));
}

export function addMonths(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const first = Date.UTC(y, m, 1);
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(Number(date.slice(8, 10)), lastDay);
  return fromUtc(first + (day - 1) * 86_400_000);
}

export function weekDates(date: string, weekStartsOn: number): string[] {
  const start = startOfWeek(date, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Whole weeks covering the month of `date`, so every row has 7 days. */
export function monthGrid(date: string, weekStartsOn: number): string[][] {
  const first = `${date.slice(0, 7)}-01`;
  const last = addDays(addMonths(first, 1), -1);
  const weeks: string[][] = [];
  for (let d = startOfWeek(first, weekStartsOn); d <= last; d = addDays(d, 7)) weeks.push(weekDates(d, weekStartsOn));
  return weeks;
}

export interface BoardEntry {
  id: string;
  itemId: string;
  title: string;
  date: string;
  endDate?: string;
  time?: string;
  endTime?: string;
  allDay: boolean;
  ownerLabel: string;
  memberIds: string[];
  type?: string;
  tone: string;
  simulated: boolean;
  unavailable: string[];
  open?: A2uiAction;
}

export interface BoardData {
  today: string;
  weekStartsOn: number;
  weekdays: string[];
  members: Array<{ id: string; label: string }>;
  entries: BoardEntry[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

export function readBoard(raw: unknown): BoardData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const today = str(r.today);
  if (!DATE_RE.test(today)) return null;
  const weekdays = strings(r.weekdays);
  const entries = (Array.isArray(r.entries) ? r.entries : [])
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object' && DATE_RE.test(str((e as Record<string, unknown>).date)))
    .map((e, index) => ({
      id: str(e.id) || `entry-${index}`,
      itemId: str(e.itemId),
      title: str(e.title),
      date: str(e.date),
      ...(DATE_RE.test(str(e.endDate)) ? { endDate: str(e.endDate) } : {}),
      ...(str(e.time) ? { time: str(e.time) } : {}),
      ...(str(e.endTime) ? { endTime: str(e.endTime) } : {}),
      allDay: e.allDay === true,
      ownerLabel: str(e.ownerLabel),
      memberIds: strings(e.memberIds),
      ...(str(e.type) ? { type: str(e.type) } : {}),
      tone: toneOf(e.tone),
      simulated: e.simulated === true,
      unavailable: strings(e.unavailable),
      ...(actionOf(e.open) ? { open: actionOf(e.open) } : {})
    }));
  return {
    today,
    weekStartsOn: r.weekStartsOn === 1 ? 1 : 0,
    weekdays: weekdays.length === 7 ? weekdays : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    members: (Array.isArray(r.members) ? r.members : [])
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
      .map(m => ({ id: str(m.id), label: str(m.label) }))
      .filter(m => m.id && m.label),
    entries
  };
}

/** `member` is a member id or `all`; `type` is an item type or `all`. */
export function filterEntries(entries: BoardEntry[], member: string, type: string): BoardEntry[] {
  return entries.filter(e => (member === 'all' || e.memberIds.includes(member)) && (type === 'all' || e.type === type));
}

/** Entries on one date, all-day first, then by time. A multi-day entry shows on every day it spans. */
export function entriesOn(entries: BoardEntry[], date: string): BoardEntry[] {
  return entries
    .filter(e => e.date <= date && date <= (e.endDate ?? e.date))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title));
}

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const monthIndex = (date: string) => Number(date.slice(5, 7)) - 1;
const dayNumber = (date: string) => Number(date.slice(8, 10));

export function shortDate(date: string, tr: Tr): string {
  return tr(`${MONTHS_EN[monthIndex(date)].slice(0, 3)} ${dayNumber(date)}`, `${monthIndex(date) + 1}月${dayNumber(date)}日`);
}

export function dayTitle(date: string, weekdays: string[], tr: Tr): string {
  const wd = weekdays[weekdayOf(date)] ?? '';
  return tr(`${wd}, ${shortDate(date, tr)}`, `${shortDate(date, tr)} ${wd}`);
}

export function rangeTitle(view: CalendarView, anchor: string, weekStartsOn: number, weekdays: string[], tr: Tr): string {
  if (view === 'day') return dayTitle(anchor, weekdays, tr);
  if (view === 'week') {
    const days = weekDates(anchor, weekStartsOn);
    return `${shortDate(days[0], tr)} – ${shortDate(days[6], tr)}`;
  }
  const y = anchor.slice(0, 4);
  return tr(`${MONTHS_EN[monthIndex(anchor)]} ${y}`, `${y}年${monthIndex(anchor) + 1}月`);
}

export function step(view: CalendarView, anchor: string, direction: 1 | -1): string {
  if (view === 'day') return addDays(anchor, direction);
  if (view === 'week') return addDays(anchor, 7 * direction);
  return addMonths(`${anchor.slice(0, 7)}-01`, direction);
}

// --- CalendarBoard -----------------------------------------------------------------------------------

const TYPES = ['event', 'preparation', 'task'] as const;

function typeLabel(type: string, tr: Tr): string {
  if (type === 'event') return tr('Events', '活动');
  if (type === 'preparation') return tr('Preparations', '准备事项');
  if (type === 'task') return tr('Tasks', '任务');
  return tr('All types', '全部类型');
}

function timeLabel(entry: BoardEntry, tr: Tr): string {
  if (entry.allDay || !entry.time) return tr('All day', '全天');
  return entry.endTime ? `${entry.time}–${entry.endTime}` : entry.time;
}

function EntryRow({ entry, tr, onAction }: { entry: BoardEntry; tr: Tr; onAction: Ctx['onAction'] }) {
  return (
    <li className={`hm-cal-entry is-${entry.tone}`} data-entry-id={entry.id} data-item-id={entry.itemId}>
      <span className="hm-cal-time">{timeLabel(entry, tr)}</span>
      <span className="hm-cal-main">
        <OpenTitle className="hm-cal-entry-title" title={entry.title} open={entry.open} onAction={onAction} />
        <span className="hm-cal-sub">
          {entry.ownerLabel ? <span>{entry.ownerLabel}</span> : null}
          {entry.unavailable.length ? (
            <span className="hm-cal-away">
              {tr('Unavailable', '没空')}: {entry.unavailable.join(tr(', ', '、'))}
            </span>
          ) : null}
          {entry.simulated ? <SimulatedBadge tr={tr} /> : null}
        </span>
      </span>
    </li>
  );
}

function DayList({ date, entries, tr, emptyText, onAction }: { date: string; entries: BoardEntry[]; tr: Tr; emptyText: string; onAction: Ctx['onAction'] }) {
  const list = entriesOn(entries, date);
  if (!list.length) return <p className="hm-cal-empty">{emptyText}</p>;
  return (
    <ul className="hm-cal-entries">
      {list.map(entry => (
        <EntryRow key={`${date}-${entry.id}`} entry={entry} tr={tr} onAction={onAction} />
      ))}
    </ul>
  );
}

function CalendarBoard({ component, ctx, id }: { component: A2uiComponent; ctx: Ctx; id: string }) {
  const { tr } = ctx;
  const board = useMemo(() => readBoard(resolve(ctx.surface.data, typeof component.dataPath === 'string' ? component.dataPath : undefined)), [ctx.surface.data, component.dataPath]);
  const initialView: CalendarView = component.view === 'day' || component.view === 'month' ? component.view : 'week';
  const [view, setView] = useState<CalendarView>(initialView);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [member, setMember] = useState('all');
  const [type, setType] = useState('all');

  if (!board) {
    return (
      <div className="a2ui-error">
        <Icon name="info" size={16} />
        <div>
          <strong>{tr('Calendar unavailable', '日历暂不可用')}</strong>
          <p>{tr('The board data could not be read.', '无法读取日程数据。')}</p>
        </div>
      </div>
    );
  }

  const at = anchor ?? board.today;
  const shown = filterEntries(board.entries, member, type);
  const presentTypes = TYPES.filter(t => board.entries.some(e => e.type === t));
  const emptyDay = tr('Nothing planned', '没有安排');
  const views: Array<[CalendarView, string]> = [
    ['day', tr('Day', '日')],
    ['week', tr('Week', '周')],
    ['month', tr('Month', '月')]
  ];
  const memberSelect = `${id}-member`;
  const typeSelect = `${id}-type`;
  const title = rangeTitle(view, at, board.weekStartsOn, board.weekdays, tr);

  let body: ReactNode;
  if (view === 'day') {
    body = <DayList date={at} entries={shown} tr={tr} emptyText={emptyDay} onAction={ctx.onAction} />;
  } else if (view === 'week') {
    body = (
      <ol className="hm-cal-week">
        {weekDates(at, board.weekStartsOn).map(date => (
          <li key={date} className={`hm-cal-day${date === board.today ? ' is-today' : ''}`} aria-current={date === board.today ? 'date' : undefined}>
            <div className="hm-cal-day-head">
              <span>{dayTitle(date, board.weekdays, tr)}</span>
              {date === board.today ? <em>{tr('Today', '今天')}</em> : null}
            </div>
            <DayList date={date} entries={shown} tr={tr} emptyText={emptyDay} onAction={ctx.onAction} />
          </li>
        ))}
      </ol>
    );
  } else {
    const order = Array.from({ length: 7 }, (_, i) => (board.weekStartsOn + i) % 7);
    const month = at.slice(0, 7);
    body = (
      <table className="hm-cal-month">
        <caption className="hm-visually-hidden">{title}</caption>
        <thead>
          <tr>
            {order.map(wd => (
              <th key={wd} scope="col">
                {board.weekdays[wd]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(at, board.weekStartsOn).map(week => (
            <tr key={week[0]}>
              {week.map(date => {
                const list = entriesOn(shown, date);
                const outside = date.slice(0, 7) !== month;
                const count = list.length;
                const label = `${dayTitle(date, board.weekdays, tr)}, ${count ? tr(`${count} ${count === 1 ? 'item' : 'items'}`, `${count} 项`) : emptyDay}`;
                return (
                  <td key={date} className={`${outside ? 'is-outside' : ''}${date === board.today ? ' is-today' : ''}`}>
                    <button
                      type="button"
                      className="hm-cal-cell"
                      aria-label={label}
                      aria-current={date === board.today ? 'date' : undefined}
                      data-date={date}
                      onClick={() => {
                        setAnchor(date);
                        setView('day');
                      }}
                    >
                      <span className="hm-cal-num">{dayNumber(date)}</span>
                      {count ? (
                        <span className="hm-cal-dots" aria-hidden="true">
                          {list.slice(0, 3).map(e => (
                            <i key={e.id} className={`is-${e.tone}`} />
                          ))}
                          {count > 3 ? <b>+{count - 3}</b> : null}
                        </span>
                      ) : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const inRange =
    view === 'day' ? entriesOn(shown, at).length : view === 'week' ? weekDates(at, board.weekStartsOn).reduce((n, d) => n + entriesOn(shown, d).length, 0) : monthGrid(at, board.weekStartsOn).flat().filter(d => d.slice(0, 7) === at.slice(0, 7)).reduce((n, d) => n + entriesOn(shown, d).length, 0);

  return (
    <section className="options-block hm-cal" aria-label={component.title ?? tr('Calendar', '日历')} data-view={view} data-anchor={at}>
      <div className="hm-cal-toolbar">
        <div className="hm-seg" role="group" aria-label={tr('Calendar view', '日历视图')}>
          {views.map(([value, label]) => (
            <button key={value} type="button" className={view === value ? 'is-active' : ''} aria-pressed={view === value} onClick={() => setView(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="hm-cal-nav">
          <button type="button" className="hm-icon-button" aria-label={tr('Previous', '上一页')} onClick={() => setAnchor(step(view, at, -1))}>
            <Icon name="chevronRight" size={14} className="hm-flip" aria-hidden="true" />
          </button>
          <button type="button" className="hm-today-button" onClick={() => setAnchor(board.today)} disabled={at === board.today}>
            {tr('Today', '今天')}
          </button>
          <button type="button" className="hm-icon-button" aria-label={tr('Next', '下一页')} onClick={() => setAnchor(step(view, at, 1))}>
            <Icon name="chevronRight" size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="hm-cal-filters">
        <label htmlFor={memberSelect}>
          <span>{tr('Person', '成员')}</span>
          <select id={memberSelect} value={member} onChange={event => setMember(event.target.value)}>
            {(board.members.some(m => m.id === 'all') ? board.members : [{ id: 'all', label: tr('Everyone', '所有人') }, ...board.members]).map(m => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {presentTypes.length > 1 ? (
          <label htmlFor={typeSelect}>
            <span>{tr('Type', '类型')}</span>
            <select id={typeSelect} value={type} onChange={event => setType(event.target.value)}>
              {['all', ...presentTypes].map(t => (
                <option key={t} value={t}>
                  {typeLabel(t, tr)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <h4 className="hm-cal-title" aria-live="polite">
        {title}
      </h4>
      {body}
      {!inRange && view !== 'day' && board.entries.length ? <p className="hm-cal-empty">{tr('Nothing in this view', '此视图中没有安排')}</p> : null}
    </section>
  );
}

export function renderHomemindComponent(component: A2uiComponent, ctx: Ctx, key: string): ReactNode {
  const id = `hm-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  if (component.component === 'TaskList') return <TaskList key={key} component={component} ctx={ctx} id={id} />;
  if (component.component === 'CalendarBoard') return <CalendarBoard key={key} component={component} ctx={ctx} id={id} />;
  return null;
}
