/**
 * Homemind -> A2UI surface builders.
 *
 * Pure functions: they take what the bridge knows about one member (their `MemberView`, already
 * filtered by the server) and produce a chat-style turn: one A2UI v0.9.1 JSONL surface per screen.
 * Nothing here touches the network, the clock or the filesystem; "now" is passed in. The bridge
 * (server/homemind.ts) calls these; the browser only parses and renders the JSONL.
 *
 * This file imports only types from server/homemind/types.ts (tests/homemindBoundary.test.ts).
 * It never sees an item the member may not see, so it adds no filtering of its own.
 *
 * `TaskList` and `CalendarBoard` (src/components/a2ui/homemindComponents.tsx) read the shapes below.
 * Everything simulated carries `simulated: true`, and the component renders a visible "Simulated / 模拟"
 * badge from it (TaskList, CalendarBoard, ApprovalCard, PaymentCard, ConfirmPanel, List, ExpandableCard).
 * Components that do not render the flag (rules, settings rows) say the word in their text instead.
 */
import type { A2uiAction, A2uiComponent } from '../types';
import type { ActionCard, Activity, Family, Item, Lang, Member, Preference, Reminder, Rule, Why } from '../../server/homemind/types';

export type HomemindLang = Lang;
export type HomemindScreenName = 'my-day' | 'family' | 'calendar' | 'search' | 'rules' | 'memory' | 'activity' | 'settings' | 'edit';

/** What the Add and edit screen opens: an existing item, a new preparation under an event, or a new item. */
export interface HomemindEditTarget {
  itemId?: string;
  parentId?: string;
}

/** The part of the bridge's `MemberView` that screens read. */
export interface HomemindViewData {
  memberId: string;
  family: Family;
  items: Item[];
  reminders: Reminder[];
  preferences: Preference[];
  rules: Rule[];
  actionCards: ActionCard[];
  activity: Activity[];
  whys: Why[];
}

export interface HomemindScreenData {
  lang: HomemindLang;
  /** ISO instant: the demo clock's "now". */
  now: string;
  view: HomemindViewData;
  query?: string;
  results?: Item[];
  /** Activity ids this member may undo. Decided by the server, since a view carries no Undo patches. */
  undoable?: string[];
  /** `off`: not configured. `offline`: configured but unreachable. */
  ppma?: 'off' | 'offline' | 'ok';
  llm?: 'live' | 'fake';
  /** For the `edit` screen. */
  edit?: HomemindEditTarget;
}

/** What the bridge sends the browser for every Homemind screen. Same shape as a Fridge2Table turn. */
export interface HomemindTurn {
  message: string;
  thinking: string[];
  followUps: string[];
  /** One A2UI surface as JSONL. */
  jsonl: string;
}

export type TaskState = 'open' | 'assigned' | 'confirmed' | 'proposed' | 'done';
export type TaskTone = 'muted' | 'warning' | 'danger' | 'success' | 'accent';

/** One row of `TaskList`. */
export interface TaskRow {
  id: string;
  title: string;
  meta: string;
  ownerLabel: string;
  state: TaskState;
  tone: TaskTone;
  simulated?: boolean;
  actions: A2uiAction[];
  /** Tapping the title opens the item in Add and edit (T3.2). */
  open?: A2uiAction;
}

/** One entry of `CalendarBoard`: local date and time in the family's zone, so no conversion on the client. */
export interface CalendarEntry {
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
  /** Item type, for the board's type filter. */
  type: Item['type'];
  tone: TaskTone;
  simulated?: boolean;
  unavailable?: string[];
  /** Tapping the entry opens the item in Add and edit (T3.2). */
  open?: A2uiAction;
}

// --- strings ----------------------------------------------------------------------------------------

const T = {
  brand: { en: 'Homemind', zh: 'Homemind 家庭智囊' },
  simulated: { en: 'Simulated', zh: '模拟' },
  myDay: { en: 'My day', zh: '我的一天' },
  family: { en: 'Family', zh: '家庭' },
  calendar: { en: 'Calendar', zh: '日历' },
  search: { en: 'Search', zh: '搜索' },
  rules: { en: 'Rules', zh: '规则' },
  memory: { en: 'What we know', zh: '我们了解的' },
  activity: { en: 'Activity', zh: '动态' },
  settings: { en: 'Settings', zh: '设置' },
  needsYou: { en: 'Needs your answer', zh: '等你回复' },
  today: { en: 'Today', zh: '今天' },
  comingUp: { en: 'Coming up', zh: '接下来' },
  nothingToday: { en: 'Nothing for you today.', zh: '今天没有需要你处理的事。' },
  nothingHere: { en: 'Nothing here yet.', zh: '这里还没有内容。' },
  cards: { en: 'Waiting for your tap', zh: '等你点一下' },
  whoTakes: { en: "Who's taking this?", zh: '谁来负责？' },
  noOwner: { en: 'No owner yet', zh: '还没有负责人' },
  proposed: { en: 'Proposed', zh: '待确认' },
  critical: { en: 'Important', zh: '重要' },
  parentsOnly: { en: 'Parents only', zh: '仅限家长' },
  you: { en: 'You', zh: '你' },
  handedBack: { en: 'handed it back', zh: '已交还' },
  notConfirmed: { en: 'not confirmed yet', zh: '尚未确认' },
  confirmed: { en: 'confirmed', zh: '已确认' },
  claim: { en: "I'll take it", zh: '我来' },
  ack: { en: "I'm on it", zh: '我来处理' },
  done: { en: 'Done', zh: '完成' },
  handoff: { en: 'Hand off', zh: '交还' },
  approve: { en: 'Approve', zh: '确认添加' },
  dismiss: { en: 'Dismiss', zh: '忽略' },
  assignTo: { en: 'Assign to', zh: '分配给' },
  add: { en: 'Add', zh: '添加' },
  undo: { en: 'Undo', zh: '撤销' },
  why: { en: 'Why?', zh: '为什么？' },
  confirmCard: { en: 'Confirm', zh: '确认' },
  cancelCard: { en: 'Cancel', zh: '取消' },
  expires: { en: 'Expires', zh: '截止' },
  statusPending: { en: 'Waiting for a parent', zh: '等待家长确认' },
  metricOpen: { en: 'Open', zh: '待认领' },
  metricAwaiting: { en: 'Not confirmed', zh: '待确认' },
  metricProposed: { en: 'Proposed', zh: '待批准' },
  metricToday: { en: 'Today', zh: '今天' },
  unavailable: { en: 'Unavailable', zh: '不在' },
  unavailableNow: { en: 'Who is away', zh: '谁不在' },
  openItems: { en: "Who's taking this?", zh: '谁来负责？' },
  everyone: { en: 'Everyone', zh: '全家' },
  allDay: { en: 'all day', zh: '全天' },
  searchLabel: { en: 'Search the board', zh: '搜索家庭看板' },
  searchGo: { en: 'Search', zh: '搜索' },
  noResults: { en: 'No matches.', zh: '没有找到。' },
  results: { en: 'Matches', zh: '搜索结果' },
  rulesNote: { en: 'A rule only prepares a card. Nothing is bought or sent until a parent taps.', zh: '规则只会准备卡片。家长点一下之前，不会购买或发送任何东西。' },
  ruleOn: { en: 'On', zh: '已开启' },
  ruleOff: { en: 'Off', zh: '已关闭' },
  ruleCap: { en: 'cap', zh: '上限' },
  hard: { en: 'Never overridden', zh: '不可更改' },
  soft: { en: 'Can be overridden', zh: '可以变通' },
  because: { en: 'Because', zh: '原因' },
  appliesTo: { en: 'Applies to', zh: '适用于' },
  ppmaOff: { en: 'PPMA memory is not connected. Only what Homemind itself saved is shown.', zh: 'PPMA 记忆未连接，这里只显示 Homemind 自己保存的内容。' },
  ppmaOffline: { en: 'PPMA offline. Only what Homemind itself saved is shown.', zh: 'PPMA 离线，这里只显示 Homemind 自己保存的内容。' },
  autonomy: { en: 'Autonomy level', zh: '自主程度' },
  paused: { en: 'Automatic actions', zh: '自动操作' },
  pausedYes: { en: 'Paused. Reminders still fire.', zh: '已暂停，提醒仍会发送。' },
  pausedNo: { en: 'Running', zh: '运行中' },
  quiet: { en: 'Quiet hours', zh: '免打扰时段' },
  quietNone: { en: 'Not set', zh: '未设置' },
  backup: { en: 'Backup contact', zh: '备用联系人' },
  backupNone: { en: 'None', zh: '无' },
  signedIn: { en: 'Signed in as', zh: '当前身份' },
  demoSignIn: { en: 'Demo sign-in, not real authentication', zh: '演示登录，并非真实身份验证' },
  model: { en: 'Model', zh: '模型' },
  modelFake: { en: 'Simulated model', zh: '模拟模型' },
  modelLive: { en: 'Live model', zh: '真实模型' },
  zone: { en: 'Time zone', zh: '时区' },
  alertNote: { en: 'Homemind helps, but an alert can be missed.', zh: 'Homemind 会帮忙，但提醒仍可能被错过。' },
  level1: { en: '1 Suggests', zh: '1 仅建议' },
  level2: { en: '2 Organizes', zh: '2 整理' },
  level3: { en: '3 Advanced', zh: '3 进阶' },
  level4: { en: '4 Executes (simulated services only)', zh: '4 执行（仅限模拟服务）' },
  failed: { en: 'Homemind could not answer', zh: 'Homemind 暂时无法回答' },
  edit: { en: 'Edit', zh: '编辑' },
  addItem: { en: 'Add to the board', zh: '添加到家庭看板' },
  editItem: { en: 'Edit item', zh: '编辑事项' },
  addPrep: { en: 'Add preparation', zh: '添加准备事项' },
  fType: { en: 'What is it?', zh: '类型' },
  tEvent: { en: 'Event', zh: '活动' },
  tEventHint: { en: 'Something that happens at a time', zh: '在某个时间发生的事' },
  tTask: { en: 'Task', zh: '任务' },
  tTaskHint: { en: 'Something someone has to do', zh: '需要有人去做的事' },
  fTitle: { en: 'Title', zh: '标题' },
  fDate: { en: 'Date', zh: '日期' },
  fTime: { en: 'Start time (empty for all day)', zh: '开始时间（留空表示全天）' },
  fEnd: { en: 'End time', zh: '结束时间' },
  fNotes: { en: 'Notes', zh: '备注' },
  fFor: { en: 'Who is it for?', zh: '和谁有关？' },
  fAway: { en: 'Who is away during this?', zh: '这段时间谁没空？' },
  fOwner: { en: 'Who takes it?', zh: '谁来负责？' },
  fImportant: { en: 'Important (for example a child pickup)', zh: '重要（例如接孩子）' },
  fParents: { en: 'Parents only', zh: '仅限家长' },
  forName: { en: 'For', zh: '关于' },
  awayName: { en: 'is away', zh: '没空' },
  save: { en: 'Save', zh: '保存' },
  back: { en: 'Back', zh: '返回' },
  remove: { en: 'Remove', zh: '删除' },
  preparations: { en: 'Preparations', zh: '准备事项' },
  noPreps: { en: 'No preparations yet.', zh: '还没有准备事项。' },
  thisItem: { en: 'This item', zh: '当前事项' },
  under: { en: 'For the event', zh: '所属活动' },
  notFound: { en: 'This item is not on your board any more.', zh: '这个事项已不在你的看板上。' }
} as const;

type Key = keyof typeof T;
export const hx = (lang: HomemindLang, key: Key): string => T[key][lang];

// --- people, titles, time ---------------------------------------------------------------------------

const memberOf = (family: Family, id: string | undefined): Member | undefined => family.members.find(m => m.id === id);
const nameOf = (member: Member | undefined, lang: HomemindLang): string => (member ? (lang === 'zh' && member.nameZh ? member.nameZh : member.name) : '');
const titleOf = (item: Item, lang: HomemindLang): string => (lang === 'zh' && item.titleZh ? item.titleZh : item.title);

function dateParts(iso: string, zone: string): { date: string; time: string; weekday: number } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}`, weekday };
}

const addDaysToDate = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d + days);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
};
const weekdayOfDate = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const WEEKDAYS = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
} as const;

/** "Today 16:30", "Tue 16:30" or "Tue 3 Nov" for all-day items. Empty when the item has no time. */
function whenLabel(item: Item, today: string, zone: string, lang: HomemindLang): string {
  if (!item.start) return '';
  const p = dateParts(item.start, zone);
  if (!p) return '';
  const day = p.date === today ? hx(lang, 'today') : p.date === addDaysToDate(today, 1) ? (lang === 'zh' ? '明天' : 'Tomorrow') : `${WEEKDAYS[lang][p.weekday]} ${p.date.slice(5)}`;
  return item.allDay ? `${day} · ${hx(lang, 'allDay')}` : `${day} ${p.time}`;
}

// InfoRows text uses `accent`, not `warning`: `.tone-warning` text fails axe contrast at InfoRows size (T3.1).

// --- item rows --------------------------------------------------------------------------------------

const toneOf = (item: Item): TaskTone =>
  item.status === 'done' ? 'success' : item.status === 'proposed' ? 'accent' : item.importance === 'critical' ? 'danger' : item.ownership.state === 'assigned' ? 'muted' : 'warning';

function stateOf(item: Item): TaskState {
  if (item.status === 'done') return 'done';
  if (item.status === 'proposed') return 'proposed';
  if (item.ownership.state === 'assigned') return item.ownership.confirmed ? 'confirmed' : 'assigned';
  return 'open';
}

function ownerLabelOf(item: Item, view: HomemindViewData, lang: HomemindLang): string {
  const o = item.ownership;
  if (o.state === 'assigned') return o.ownerId === view.memberId ? hx(lang, 'you') : nameOf(memberOf(view.family, o.ownerId), lang);
  return o.state === 'open' ? hx(lang, 'whoTakes') : hx(lang, 'noOwner');
}

function openNote(item: Item, view: HomemindViewData, lang: HomemindLang): string {
  const o = item.ownership;
  if (o.state !== 'open') return '';
  const parts: string[] = [];
  if (o.reason) {
    const who = nameOf(memberOf(view.family, o.reason.memberId), lang);
    const event = view.items.find(i => i.id === o.reason?.eventId);
    // The reason is already redacted by the server for a member who can't see the event.
    if (who && event) parts.push(lang === 'zh' ? `${who}那时没空（${titleOf(event, lang)}）` : `${who} is unavailable (${titleOf(event, lang)})`);
  }
  if (o.handedBackBy) {
    const who = nameOf(memberOf(view.family, o.handedBackBy), lang);
    parts.push(`${who} ${hx(lang, 'handedBack')}${o.note ? `: “${o.note}”` : ''}`);
  }
  return parts.join(' · ');
}

function act(verb: string, item: Item, label: string, variant: A2uiAction['variant'], extra: Record<string, unknown> = {}): A2uiAction {
  return { id: `homemind.${verb}:${item.id}`, label, variant, kind: 'homemind', args: { verb, itemId: item.id, version: item.version, ...extra } };
}

function canOwn(member: Member, item: Item): boolean {
  return member.hasAccount && (item.visibility !== 'parents' || member.role === 'parent');
}

function itemActions(item: Item, view: HomemindViewData, lang: HomemindLang): A2uiAction[] {
  const me = memberOf(view.family, view.memberId);
  if (!me || item.status === 'done' || item.status === 'cancelled') return [];
  if (item.status === 'proposed') return [act('approve', item, hx(lang, 'approve'), 'primary'), act('dismiss', item, hx(lang, 'dismiss'), 'ghost')];
  const o = item.ownership;
  if (o.state === 'assigned') {
    if (o.ownerId !== me.id) return [];
    return o.confirmed
      ? [act('done', item, hx(lang, 'done'), 'primary'), act('handback', item, hx(lang, 'handoff'), 'ghost')]
      : [act('ack', item, hx(lang, 'ack'), 'primary'), act('handback', item, hx(lang, 'handoff'), 'ghost')];
  }
  const actions: A2uiAction[] = [];
  if (canOwn(me, item) && (o.state === 'none' || o.candidateIds.length === 0 || o.candidateIds.includes(me.id))) actions.push(act('claim', item, hx(lang, 'claim'), 'primary'));
  if (me.role === 'parent') {
    for (const other of view.family.members) {
      if (other.id !== me.id && canOwn(other, item) && other.role !== 'child') {
        actions.push(act('assign', item, `${hx(lang, 'assignTo')} ${nameOf(other, lang)}`, 'secondary', { memberId: other.id }));
      }
    }
  }
  return actions;
}

/** "Edit" on a row or calendar entry: opens the item in Add and edit. Only for items still on the board. */
function openAction(item: Item, view: HomemindViewData, lang: HomemindLang): A2uiAction | undefined {
  const me = memberOf(view.family, view.memberId);
  if (!me?.hasAccount || !live(item)) return undefined;
  return { id: `homemind.edit:${item.id}`, label: hx(lang, 'edit'), variant: 'ghost', kind: 'homemind', args: { verb: 'edit', itemId: item.id } };
}

function taskRow(item: Item, view: HomemindViewData, lang: HomemindLang, today: string): TaskRow {
  const zone = view.family.timezone;
  const meta = [
    whenLabel(item, today, zone, lang),
    item.status === 'proposed' ? hx(lang, 'proposed') : '',
    item.importance === 'critical' && item.status !== 'done' ? hx(lang, 'critical') : '',
    item.visibility === 'parents' ? hx(lang, 'parentsOnly') : '',
    item.ownership.state === 'assigned' && item.status !== 'done' ? (item.ownership.confirmed ? hx(lang, 'confirmed') : hx(lang, 'notConfirmed')) : '',
    openNote(item, view, lang)
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: item.id,
    title: titleOf(item, lang),
    meta,
    ownerLabel: ownerLabelOf(item, view, lang),
    state: stateOf(item),
    tone: toneOf(item),
    ...(item.source.simulated ? { simulated: true } : {}),
    actions: itemActions(item, view, lang),
    ...withOpen(openAction(item, view, lang))
  };
}

const withOpen = (open: A2uiAction | undefined) => (open ? { open } : {});

const byStart = (a: Item, b: Item) => (a.start ?? '9').localeCompare(b.start ?? '9') || a.id.localeCompare(b.id);
const live = (item: Item) => item.status === 'open' || item.status === 'proposed';

// --- surface plumbing -------------------------------------------------------------------------------

/** Stable per screen, so a refresh replaces the surface instead of stacking a new one. */
function surfaceJsonl(kind: string, title: string, subtitle: string | undefined, components: A2uiComponent[], data: Record<string, unknown>, status = 'ready'): string {
  const surfaceId = `homemind-${kind}`;
  return [
    { version: 'v0.9.1', createSurface: { surfaceId, root: 'root', title, subtitle, status } },
    { version: 'v0.9.1', updateComponents: { surfaceId, components } },
    { version: 'v0.9.1', updateDataModel: { surfaceId, path: '/', value: data } }
  ]
    .map(line => JSON.stringify(line))
    .join('\n');
}

function turn(kind: string, title: string, subtitle: string | undefined, children: A2uiComponent[], data: Record<string, unknown>, message = ''): HomemindTurn {
  const components: A2uiComponent[] = [{ id: 'root', component: 'SurfaceRoot', title, children: children.map(c => c.id) }, ...children];
  return { message, thinking: [], followUps: [], jsonl: surfaceJsonl(kind, title, subtitle, components, data) };
}

const text = (id: string, value: string): A2uiComponent => ({ id, component: 'Text', text: value });
const taskList = (id: string, title: string, path: string): A2uiComponent => ({ id, component: 'TaskList', title, dataPath: path });

/** A list that is empty becomes a line of text, never an empty box. */
function section(children: A2uiComponent[], data: Record<string, unknown>, id: string, title: string, rows: TaskRow[], emptyText?: string): void {
  if (rows.length) {
    children.push(taskList(id, title, `/${id}`));
    data[id] = rows;
  } else if (emptyText) {
    children.push(text(`${id}-empty`, `**${title}**\n\n${emptyText}`));
  }
}

function pendingCards(view: HomemindViewData, lang: HomemindLang, now: string): { children: A2uiComponent[]; data: Record<string, unknown> } {
  const me = memberOf(view.family, view.memberId);
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  // Only a parent can confirm an action, so only a parent is shown the card.
  if (me?.role !== 'parent') return { children, data };
  for (const card of view.actionCards.filter(c => c.status === 'pending' && Date.parse(c.expiresAt) > Date.parse(now))) {
    const payload = card.payload;
    const simulated = card.mode === 'simulated';
    const expires = dateParts(card.expiresAt, view.family.timezone);
    data[card.id] = {
      title: typeof payload.title === 'string' ? payload.title : card.adapter,
      body: typeof payload.summary === 'string' ? payload.summary : '',
      expires: expires ? `${hx(lang, 'expires')} ${expires.time}` : undefined,
      scope: hx(lang, 'statusPending'),
      simulated
    };
    children.push({
      id: `card-${card.id}`,
      component: 'ApprovalCard',
      dataPath: `/cards/${card.id}`,
      actions: [
        { id: `homemind.confirm-card:${card.id}`, label: hx(lang, 'confirmCard'), variant: 'primary', kind: 'homemind', args: { verb: 'confirm-card', cardId: card.id } },
        { id: `homemind.cancel-card:${card.id}`, label: hx(lang, 'cancelCard'), variant: 'ghost', kind: 'homemind', args: { verb: 'cancel-card', cardId: card.id } },
        { id: `homemind.why:${card.whyId}`, label: hx(lang, 'why'), variant: 'secondary', kind: 'homemind', args: { verb: 'why', whyId: card.whyId } }
      ]
    });
  }
  return { children, data: children.length ? { cards: data } : {} };
}

// --- screens ----------------------------------------------------------------------------------------

function myDay(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const weekEnd = addDaysToDate(today, 7);
  const dayOf = (item: Item) => (item.start ? dateParts(item.start, zone)?.date : undefined);
  const mine = (item: Item) => (item.ownership.state === 'assigned' && item.ownership.ownerId === view.memberId) || item.forMemberIds.includes(view.memberId);
  const items = view.items.filter(live).sort(byStart);

  const needs = items.filter(i => i.status === 'proposed' || i.ownership.state !== 'assigned' || (i.ownership.ownerId === view.memberId && !i.ownership.confirmed));
  const taken = new Set(needs.map(i => i.id));
  const rest = items.filter(i => !taken.has(i.id) && mine(i));
  const todays = rest.filter(i => dayOf(i) === today);
  const later = rest.filter(i => { const d = dayOf(i); return d !== undefined && d > today && d <= weekEnd; });

  const cards = pendingCards(view, lang, input.now);
  const children: A2uiComponent[] = [...cards.children];
  const data: Record<string, unknown> = { ...cards.data };
  if (cards.children.length) children.unshift(text('cards-title', `**${hx(lang, 'cards')}**`));
  section(children, data, 'needs', hx(lang, 'needsYou'), needs.map(i => taskRow(i, view, lang, today)));
  section(children, data, 'today', hx(lang, 'today'), todays.map(i => taskRow(i, view, lang, today)), hx(lang, 'nothingToday'));
  section(children, data, 'later', hx(lang, 'comingUp'), later.map(i => taskRow(i, view, lang, today)));
  children.push({ id: 'actions', component: 'ActionBar', actions: [{ id: 'homemind.add', label: hx(lang, 'add'), variant: 'secondary', kind: 'homemind', args: { verb: 'add' } }] });
  return turn('my-day', hx(lang, 'myDay'), nameOf(memberOf(view.family, view.memberId), lang), children, data);
}

function familyScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const items = view.items.filter(live).sort(byStart);
  const open = items.filter(i => i.status === 'open' && i.ownership.state !== 'assigned');
  const unconfirmed = items.filter(i => i.status === 'open' && i.ownership.state === 'assigned' && !i.ownership.confirmed);
  const proposed = items.filter(i => i.status === 'proposed');
  const todayCount = items.filter(i => i.start && dateParts(i.start, zone)?.date === today).length;

  const away = items
    .filter(i => i.type === 'event' && i.unavailableMemberIds.length)
    .flatMap(i => i.unavailableMemberIds.map(id => ({ label: nameOf(memberOf(view.family, id), lang), value: `${titleOf(i, lang)} · ${whenLabel(i, today, zone, lang)}`.replace(/ · $/, ''), tone: 'accent' })));

  const children: A2uiComponent[] = [{ id: 'counts', component: 'MetricGrid', title: lang === 'zh' && view.family.nameZh ? view.family.nameZh : view.family.name, dataPath: '/counts' }];
  const data: Record<string, unknown> = {
    counts: [
      { label: hx(lang, 'metricOpen'), value: String(open.length), tone: open.length ? 'warning' : 'muted' },
      { label: hx(lang, 'metricAwaiting'), value: String(unconfirmed.length), tone: unconfirmed.length ? 'warning' : 'muted' },
      { label: hx(lang, 'metricProposed'), value: String(proposed.length), tone: proposed.length ? 'accent' : 'muted' },
      { label: hx(lang, 'metricToday'), value: String(todayCount), tone: 'muted' }
    ]
  };
  section(children, data, 'open', hx(lang, 'openItems'), open.map(i => taskRow(i, view, lang, today)));
  section(children, data, 'unconfirmed', hx(lang, 'metricAwaiting'), unconfirmed.map(i => taskRow(i, view, lang, today)));
  section(children, data, 'proposed', hx(lang, 'metricProposed'), proposed.map(i => taskRow(i, view, lang, today)));
  if (away.length) {
    children.push({ id: 'away', component: 'InfoRows', title: hx(lang, 'unavailableNow'), dataPath: '/away' });
    data.away = away;
  }
  if (!open.length && !unconfirmed.length && !proposed.length && !away.length) children.push(text('calm', hx(lang, 'nothingHere')));
  return turn('family', hx(lang, 'family'), undefined, children, data);
}

/** Weekly items expand across a window of local dates, at the same local time. */
function calendarEntries(view: HomemindViewData, lang: HomemindLang, today: string): CalendarEntry[] {
  const zone = view.family.timezone;
  const from = addDaysToDate(today, -7);
  const to = addDaysToDate(today, 60);
  const entries: CalendarEntry[] = [];
  for (const item of view.items.filter(live)) {
    if (!item.start) continue;
    const start = dateParts(item.start, zone);
    const end = item.end ? dateParts(item.end, zone) : null;
    if (!start) continue;
    const owner = item.ownership.state === 'assigned' ? item.ownership.ownerId : undefined;
    const base = {
      itemId: item.id,
      title: titleOf(item, lang),
      time: item.allDay ? undefined : start.time,
      endTime: item.allDay || !end ? undefined : end.time,
      allDay: item.allDay === true,
      ownerLabel: ownerLabelOf(item, view, lang),
      memberIds: [...new Set([...item.forMemberIds, ...(owner ? [owner] : [])])],
      type: item.type,
      tone: toneOf(item),
      ...(item.source.simulated ? { simulated: true } : {}),
      ...(item.unavailableMemberIds.length ? { unavailable: item.unavailableMemberIds.map(id => nameOf(memberOf(view.family, id), lang)) } : {}),
      ...withOpen(openAction(item, view, lang))
    };
    const duration = end && end.date > start.date ? end.date : undefined;
    const dates: string[] = [];
    const rec = item.recurrence;
    if (rec) {
      for (let d = from > start.date ? from : start.date; d <= to; d = addDaysToDate(d, 1)) {
        if (rec.byWeekday.includes(weekdayOfDate(d)) && !rec.exceptions?.includes(d) && (!rec.until || d <= rec.until)) dates.push(d);
      }
    } else if (start.date >= from && start.date <= to) dates.push(start.date);
    for (const date of dates) entries.push({ ...base, id: rec ? `${item.id}@${date}` : item.id, date, ...(duration && !rec ? { endDate: duration } : {}) });
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id));
}

function calendarScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const today = dateParts(input.now, view.family.timezone)?.date ?? '';
  const entries = calendarEntries(view, lang, today);
  const children: A2uiComponent[] = [{ id: 'board', component: 'CalendarBoard', title: hx(lang, 'calendar'), dataPath: '/board' }];
  if (!entries.length) children.push(text('calm', hx(lang, 'nothingHere')));
  return turn('calendar', hx(lang, 'calendar'), undefined, children, {
    board: {
      today,
      weekStartsOn: view.family.weekStartsOn,
      weekdays: WEEKDAYS[lang],
      members: [{ id: 'all', label: hx(lang, 'everyone') }, ...view.family.members.map(m => ({ id: m.id, label: nameOf(m, lang) }))],
      entries
    }
  });
}

function searchScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const today = dateParts(input.now, view.family.timezone)?.date ?? '';
  const query = (input.query ?? '').trim();
  const children: A2uiComponent[] = [
    { id: 'q', component: 'TextField', name: 'q', label: hx(lang, 'searchLabel'), default: query, maxLength: 100 },
    { id: 'actions', component: 'ActionBar', actions: [{ id: 'homemind.search', label: hx(lang, 'searchGo'), variant: 'primary', kind: 'homemind', args: { verb: 'search' } }] }
  ];
  const data: Record<string, unknown> = {};
  if (query) section(children, data, 'results', hx(lang, 'results'), (input.results ?? []).map(i => taskRow(i, view, lang, today)), hx(lang, 'noResults'));
  return turn('search', hx(lang, 'search'), undefined, children, data);
}

function rulesScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const rules = view.rules.map(rule => {
    const cap = rule.limits.maxPrice !== undefined ? `${hx(lang, 'ruleCap')} ${rule.limits.maxPrice} ${rule.limits.currency ?? ''}`.trim() : '';
    return {
      title: lang === 'zh' && rule.titleZh ? rule.titleZh : rule.title,
      subtitle: [rule.enabled ? hx(lang, 'ruleOn') : hx(lang, 'ruleOff'), cap, hx(lang, 'simulated')].filter(Boolean).join(' · '),
      meta: rule.enabled ? hx(lang, 'ruleOn') : hx(lang, 'ruleOff')
    };
  });
  const children: A2uiComponent[] = [text('note', hx(lang, 'rulesNote'))];
  const data: Record<string, unknown> = {};
  if (rules.length) {
    children.push({ id: 'rules', component: 'List', title: hx(lang, 'rules'), dataPath: '/rules' });
    data.rules = rules;
  } else children.push(text('empty', hx(lang, 'nothingHere')));
  return turn('rules', hx(lang, 'rules'), undefined, children, data);
}

function memoryScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  // Never invent memory: PPMA's own entries are not here, and the screen says so.
  if (input.ppma !== 'ok') children.push({ id: 'ppma', component: 'ErrorNotice', title: input.ppma === 'offline' ? 'PPMA offline' : 'PPMA', body: hx(lang, input.ppma === 'offline' ? 'ppmaOffline' : 'ppmaOff') });
  const prefs = view.preferences.map(p => {
    const about = nameOf(memberOf(view.family, p.aboutMemberId), lang);
    const reason = lang === 'zh' && p.reasonZh ? p.reasonZh : p.reason;
    return {
      title: lang === 'zh' && p.textZh ? p.textZh : p.text,
      subtitle: [about, reason ? `${hx(lang, 'because')}: ${reason}` : '', p.scope ? `${hx(lang, 'appliesTo')}: ${p.scope}` : ''].filter(Boolean).join(' · '),
      meta: p.strength === 'hard' ? hx(lang, 'hard') : hx(lang, 'soft')
    };
  });
  if (prefs.length) {
    children.push({ id: 'prefs', component: 'List', title: hx(lang, 'memory'), dataPath: '/prefs' });
    data.prefs = prefs;
  } else children.push(text('empty', hx(lang, 'nothingHere')));
  return turn('memory', hx(lang, 'memory'), undefined, children, data);
}

function activityLine(a: Activity, view: HomemindViewData, lang: HomemindLang): string {
  const item = view.items.find(i => i.id === a.itemId);
  const who = nameOf(memberOf(view.family, a.actor), lang) || a.actor;
  const target = nameOf(memberOf(view.family, a.memberId), lang);
  const title = item ? `“${titleOf(item, lang)}”` : '';
  const verbs: Record<string, [string, string]> = {
    create: ['added', '添加了'],
    edit: ['edited', '修改了'],
    assign: [`assigned to ${target}`, `分配给 ${target}`],
    open: ['asked who takes', '询问谁来负责'],
    unassign: ['removed the owner of', '移除了负责人'],
    claim: ['took', '认领了'],
    confirm: ["is on", '确认处理'],
    handback: ['handed back', '交还了'],
    done: ['finished', '完成了'],
    cancel: ['removed', '删除了'],
    cancel_occurrence: ['skipped one of', '跳过了一次'],
    approve: ['approved', '批准了'],
    dismiss: ['dismissed', '忽略了'],
    undo: ['undid a change to', '撤销了对以下内容的修改']
  };
  const verb = verbs[a.kind ?? 'edit'] ?? verbs.edit;
  return lang === 'zh' ? `${who} ${verb[1]} ${title}`.trim() : `${who} ${verb[0]} ${title}`.trim();
}

function activityScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const undoable = new Set(input.undoable ?? []);
  const rows = [...view.activity]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30)
    .map(a => {
      const p = dateParts(a.at, zone);
      return {
        id: a.id,
        title: activityLine(a, view, lang),
        meta: [p ? `${p.date.slice(5)} ${p.time}` : '', a.undone ? hx(lang, 'undo') + ' ✓' : ''].filter(Boolean).join(' · '),
        ownerLabel: '',
        state: 'done' as TaskState,
        tone: 'muted' as TaskTone,
        actions: undoable.has(a.id) && !a.undone ? [{ id: `homemind.undo:${a.id}`, label: hx(lang, 'undo'), variant: 'ghost' as const, kind: 'homemind', args: { verb: 'undo', activityId: a.id, itemId: a.itemId } }] : []
      };
    });
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  section(children, data, 'log', hx(lang, 'activity'), rows, hx(lang, 'nothingHere'));
  return turn('activity', hx(lang, 'activity'), undefined, children, data);
}

function settingsScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const me = memberOf(view.family, view.memberId);
  const fam = view.family;
  const levels = [hx(lang, 'level1'), hx(lang, 'level2'), hx(lang, 'level3'), hx(lang, 'level4')];
  const q = me?.quietHours;
  const rows = [
    { label: hx(lang, 'signedIn'), value: nameOf(me, lang), tone: 'muted' },
    { label: hx(lang, 'autonomy'), value: levels[fam.autonomy.default - 1] ?? String(fam.autonomy.default), tone: 'muted' },
    { label: hx(lang, 'paused'), value: fam.paused ? hx(lang, 'pausedYes') : hx(lang, 'pausedNo'), tone: fam.paused ? 'accent' : 'muted' },
    { label: hx(lang, 'quiet'), value: q ? `${q.from}–${q.to}` : hx(lang, 'quietNone'), tone: 'muted' },
    {
      label: hx(lang, 'backup'),
      value: fam.backupContact ? `${lang === 'zh' && fam.backupContact.nameZh ? fam.backupContact.nameZh : fam.backupContact.name}${fam.backupContact.simulated ? ` · ${hx(lang, 'simulated')}` : ''}` : hx(lang, 'backupNone'),
      tone: 'muted'
    },
    { label: hx(lang, 'zone'), value: fam.timezone, tone: 'muted' },
    ...(input.llm ? [{ label: hx(lang, 'model'), value: input.llm === 'fake' ? hx(lang, 'modelFake') : hx(lang, 'modelLive'), tone: input.llm === 'fake' ? 'accent' : 'muted' }] : [])
  ];
  const children: A2uiComponent[] = [
    { id: 'rows', component: 'InfoRows', title: hx(lang, 'settings'), dataPath: '/rows' },
    text('note', `${hx(lang, 'alertNote')}\n\n${hx(lang, 'demoSignIn')}`)
  ];
  return turn('settings', hx(lang, 'settings'), undefined, children, { rows });
}

/**
 * Add and edit (T3.2). Form components carry their starting value in `default`; the host keeps what
 * the member typed in its `form` map and, on Save, sends only the fields that changed
 * (src/lib/homemindForm.ts). The Save action's args say what to save; times are local to the family's
 * zone, and the host converts them with the zone in those args.
 */
function editScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const me = memberOf(view.family, view.memberId);
  const target = input.edit ?? {};
  const item = target.itemId ? view.items.find(i => i.id === target.itemId && live(i)) : undefined;
  const parentId = item ? item.parentEventId : target.parentId;
  const parent = parentId ? view.items.find(i => i.id === parentId && i.type === 'event' && live(i)) : undefined;

  const title = item ? hx(lang, 'editItem') : parent ? hx(lang, 'addPrep') : hx(lang, 'addItem');
  const backBar = (): A2uiComponent => ({ id: 'actions', component: 'ActionBar', actions: [{ id: 'homemind.back', label: hx(lang, 'back'), variant: 'ghost', kind: 'homemind', args: { verb: 'back' } }] });
  // A missing item (removed, or never visible to this member) and a missing parent look the same.
  if ((target.itemId && !item) || (target.parentId && !item && !parent) || !me?.hasAccount) {
    return turn('edit', title, undefined, [{ id: 'gone', component: 'ErrorNotice', title, body: hx(lang, 'notFound') }, backBar()], {});
  }

  const type: Item['type'] | undefined = item ? item.type : parent ? 'preparation' : undefined;
  const start = item?.start ? dateParts(item.start, zone) : null;
  const end = item?.end ? dateParts(item.end, zone) : null;
  const parentStart = parent?.start ? dateParts(parent.start, zone) : null;
  const isParent = me.role === 'parent';

  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  if (item) {
    // The item itself, with its usual buttons (claim, assign, I'm on it...), so ownership is changed here too.
    const row: TaskRow = taskRow(item, view, lang, today);
    delete row.open;
    children.push(taskList('this', hx(lang, 'thisItem'), '/this'));
    data.this = [row];
  }
  if (parent) children.push(text('parent', `${hx(lang, 'under')}: **${titleOf(parent, lang)}**`));
  if (!type) {
    children.push({
      id: 'f-type',
      component: 'ChoiceGroup',
      name: 'type',
      title: hx(lang, 'fType'),
      default: 'event',
      options: [
        { value: 'event', label: hx(lang, 'tEvent'), description: hx(lang, 'tEventHint') },
        { value: 'task', label: hx(lang, 'tTask'), description: hx(lang, 'tTaskHint') }
      ]
    });
  }
  const field = (name: string, label: string, value: string, extra: Record<string, unknown> = {}): A2uiComponent => ({ id: `f-${name}`, component: 'TextField', name, label, default: value, ...extra });
  const newDate = type === 'preparation' ? parentStart?.date ?? '' : today;
  children.push(field('title', hx(lang, 'fTitle'), item ? titleOf(item, lang) : '', { maxLength: 200 }));
  children.push(field('date', hx(lang, 'fDate'), item ? start?.date ?? '' : newDate, { inputType: 'date' }));
  children.push(field('time', hx(lang, 'fTime'), start && !item?.allDay ? start.time : '', { inputType: 'time' }));
  children.push(field('endTime', hx(lang, 'fEnd'), end && !item?.allDay ? end.time : '', { inputType: 'time' }));
  children.push(field('notes', hx(lang, 'fNotes'), item?.notes ?? '', { maxLength: 2000 }));

  const toggles = (prefix: string, heading: string, ids: string[], label: (m: Member) => string, members: Member[]) => {
    children.push(text(`${prefix}-title`, `**${heading}**`));
    for (const m of members) children.push({ id: `f-${prefix}-${m.id}`, component: 'Toggle', name: `${prefix}.${m.id}`, label: label(m), default: ids.includes(m.id) });
  };
  const everyone = view.family.members;
  toggles('for', hx(lang, 'fFor'), item?.forMemberIds ?? [], m => (lang === 'zh' ? `${hx(lang, 'forName')}${nameOf(m, lang)}` : `${hx(lang, 'forName')} ${nameOf(m, lang)}`), everyone);
  if (type === 'event' || !type) {
    // Shown for a new item too; the host sends it only when the type is "event".
    toggles('away', hx(lang, 'fAway'), item?.unavailableMemberIds ?? [], m => (lang === 'zh' ? `${nameOf(m, lang)}${hx(lang, 'awayName')}` : `${nameOf(m, lang)} ${hx(lang, 'awayName')}`), everyone.filter(m => m.role !== 'child'));
  }
  if (!item) {
    const owners = everyone.filter(m => m.hasAccount);
    children.push({
      id: 'f-owner',
      component: 'ChoiceGroup',
      name: 'owner',
      title: hx(lang, 'fOwner'),
      default: 'none',
      options: [{ value: 'none', label: hx(lang, 'noOwner') }, ...owners.map(m => ({ value: m.id, label: m.id === me.id ? `${nameOf(m, lang)} (${hx(lang, 'you')})` : nameOf(m, lang) }))]
    });
  }
  children.push({ id: 'f-important', component: 'Toggle', name: 'important', label: hx(lang, 'fImportant'), default: item?.importance === 'critical' });
  // Only a parent can change who sees an item; a preparation follows its event, so it has no toggle.
  if (isParent && type !== 'preparation') children.push({ id: 'f-parents', component: 'Toggle', name: 'parentsOnly', label: hx(lang, 'fParents'), default: item?.visibility === 'parents' });

  const saveArgs: Record<string, unknown> = item
    ? { verb: 'save', mode: 'edit', itemId: item.id, version: item.version, type: item.type, zone }
    : { verb: 'save', mode: 'create', zone, ...(type ? { type } : {}), ...(parent ? { parentEventId: parent.id } : {}) };
  const actions: A2uiAction[] = [
    { id: 'homemind.save', label: hx(lang, 'save'), variant: 'primary', kind: 'homemind', args: saveArgs },
    { id: 'homemind.back', label: hx(lang, 'back'), variant: 'ghost', kind: 'homemind', args: { verb: 'back' } }
  ];
  if (item) actions.push(act('cancel', item, hx(lang, 'remove'), 'secondary'));
  children.push({ id: 'actions', component: 'ActionBar', actions });

  if (item?.type === 'event') {
    const preps = view.items.filter(i => i.parentEventId === item.id && live(i)).sort(byStart);
    // Each preparation: tap its title to edit it, or remove it here.
    const rows = preps.map(p => ({ ...taskRow(p, view, lang, today), actions: [act('cancel', p, hx(lang, 'remove'), 'ghost')] }));
    section(children, data, 'preps', hx(lang, 'preparations'), rows, hx(lang, 'noPreps'));
    children.push({ id: 'prep-actions', component: 'ActionBar', actions: [{ id: `homemind.add:${item.id}`, label: hx(lang, 'addPrep'), variant: 'secondary', kind: 'homemind', args: { verb: 'add', parentEventId: item.id } }] });
  }
  return turn('edit', title, parent && !item ? titleOf(parent, lang) : undefined, children, data);
}

// --- public API -------------------------------------------------------------------------------------

const SCREEN_BUILDERS: Record<HomemindScreenName, (input: HomemindScreenData) => HomemindTurn> = {
  'my-day': myDay,
  family: familyScreen,
  calendar: calendarScreen,
  search: searchScreen,
  rules: rulesScreen,
  memory: memoryScreen,
  activity: activityScreen,
  settings: settingsScreen,
  edit: editScreen
};

/** One screen as a turn. */
export function screenTurn(screen: HomemindScreenName, input: HomemindScreenData): HomemindTurn {
  return SCREEN_BUILDERS[screen](input);
}

export function homemindErrorTurn(message: string, lang: HomemindLang): HomemindTurn {
  const components: A2uiComponent[] = [
    { id: 'root', component: 'SurfaceRoot', title: hx(lang, 'brand'), children: ['err'] },
    { id: 'err', component: 'ErrorNotice', title: hx(lang, 'failed'), body: message }
  ];
  return { message: '', thinking: [], followUps: [], jsonl: surfaceJsonl('error', hx(lang, 'brand'), undefined, components, {}, 'error') };
}
