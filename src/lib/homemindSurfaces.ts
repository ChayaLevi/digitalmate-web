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
import type { ActionCard, Activity, ExtractedEntry, Family, Item, ItemExplanation, Lang, Member, PendingReminder, PpmaExplanationData, PpmaMemoryData, Preference, Reminder, Rule, SignUpInfo, SkippedExtraction, Why } from '../../server/homemind/types';

export type HomemindLang = Lang;
export type HomemindScreenName = 'my-day' | 'family' | 'calendar' | 'search' | 'rules' | 'memory' | 'activity' | 'settings' | 'edit' | 'item';

/** What the Add and edit screen opens: an existing item, a new preparation under an event, or a new item.
 * The `item` screen (the short summary after a save) uses `itemId` only. */
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
  /** Reminders that reached this member and wait for an answer (T4.2). Set by `screenTurn` from the input. */
  pending?: PendingReminder[];
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
  /** `not_configured`: live mode without a base URL or model (llm.ts `llmStatus`). */
  llm?: 'live' | 'fake' | 'not_configured';
  /** For the `edit` screen. */
  edit?: HomemindEditTarget;
  /** For the `item` screen (T5.4): the preferences that apply to that item, decided by the server. */
  itemPreferences?: Preference[];
  /** Reminders waiting for this member's answer: rows get "Remind me later", "Got it" and so on (T4.2). */
  reminders?: PendingReminder[];
  /** For the `memory` screen (T6.2): what PPMA remembers, read in the background and cached. */
  ppmaMemory?: PpmaMemoryData;
  /** For the `item` screen (T6.2): PPMA's explanation of the decision behind the item's `Why`, if it has one. */
  itemPpma?: PpmaExplanationData;
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
  /** Empty: no state label (rows that are not board items, such as what PPMA remembers). */
  state: TaskState | '';
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
  later: { en: 'Remind me later', zh: '稍后提醒' },
  gotIt: { en: 'Got it', zh: '知道了' },
  reminded: { en: 'reminder sent', zh: '已提醒' },
  remindAgain: { en: 'reminding again soon', zh: '稍后再提醒' },
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
  modelOff: { en: 'Model not set up', zh: '模型未配置' },
  zone: { en: 'Time zone', zh: '时区' },
  alertNote: { en: 'Homemind helps, but an alert can be missed.', zh: 'Homemind 会帮忙，但提醒仍可能被错过。' },
  sFamily: { en: 'Family settings', zh: '家庭设置' },
  sQuietFrom: { en: 'Quiet from', zh: '免打扰开始' },
  sQuietTo: { en: 'Quiet until', zh: '免打扰结束' },
  sQuietHint: { en: 'Only urgent alerts, such as an important pickup, break quiet hours. Other alerts wait until they end. Leave both empty to turn quiet hours off.', zh: '只有紧急提醒（例如重要的接送）会在免打扰时段发出，其他提醒会等到时段结束。两项都留空即可关闭免打扰。' },
  sPause: { en: 'Pause automatic actions (reminders still fire)', zh: '暂停自动操作（提醒仍会发送）' },
  sPauseHint: { en: 'The stop button: rules and Homemind’s own changes stop until this is turned off.', zh: '停止按钮：规则和 Homemind 自己的操作会停止，直到关闭此项。' },
  sLevelHint1: { en: 'Nothing on its own. Only suggestions to approve', zh: '不自行操作，只提出建议供批准' },
  sLevelHint2: { en: 'Items, lists, personal reminders', zh: '事项、清单、个人提醒' },
  sLevelHint3: { en: 'Also calendar entries, message drafts, order preparation', zh: '另外还有日历条目、消息草稿、订单准备' },
  sLevelHint4: { en: 'Also standing rules, against simulated services only', zh: '另外执行长期规则，仅限模拟服务' },
  sEscalation: { en: 'Escalation', zh: '升级提醒' },
  sEscalationHint: { en: 'An important item that is still not confirmed goes to the other parent, then to the backup contact.', zh: '重要事项仍未确认时，会提醒另一位家长，然后联系备用联系人。' },
  sBackupName: { en: 'Backup contact name (empty for none)', zh: '备用联系人姓名（留空表示无）' },
  sBackupChannel: { en: 'How to reach them', zh: '联系方式' },
  sSms: { en: 'Text message', zh: '短信' },
  sCall: { en: 'Phone call', zh: '电话' },
  sBackupSimulated: { en: 'In this demo nothing is sent to the backup contact. The message would carry no reason and no details.', zh: '本演示不会真正联系备用联系人。消息不包含原因和任何细节。' },
  sParentsOnly: { en: 'Only a parent can change these.', zh: '只有家长可以修改这些设置。' },
  sSave: { en: 'Save settings', zh: '保存设置' },
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
  notFound: { en: 'This item is not on your board any more.', zh: '这个事项已不在你的看板上。' },
  details: { en: 'Details', zh: '详情' },
  dWhen: { en: 'When', zh: '时间' },
  dNoTime: { en: 'No date', zh: '没有日期' },
  dNotes: { en: 'Notes', zh: '备注' },
  dFor: { en: 'For', zh: '关于' },
  dAway: { en: 'Away', zh: '没空' },
  dSeen: { en: 'Who sees it', zh: '可见范围' },
  dFamily: { en: 'The whole family', zh: '全家' }
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

const pendingFor = (item: Item, view: HomemindViewData) => (item.status === 'open' ? view.pending?.find(p => p.itemId === item.id) : undefined);

/**
 * The row's buttons. When a reminder waits for this member, the answers it offers are on the row
 * too, the same ones as on the alert: "I'll take it" (from someone else), "Got it", "Remind me later".
 */
function itemActions(item: Item, view: HomemindViewData, lang: HomemindLang): A2uiAction[] {
  const base = boardActions(item, view, lang);
  const pending = pendingFor(item, view);
  if (!pending) return base;
  const me = view.memberId;
  const o = item.ownership;
  const mine = o.state === 'assigned' && o.ownerId === me;
  const extra: A2uiAction[] = [];
  if (o.state === 'assigned' && !mine) extra.push({ ...act('assign', item, hx(lang, 'claim'), 'primary', { memberId: me }), id: `homemind.take:${item.id}` });
  // "I'm on it" from an owner who has not confirmed already answers it.
  const unconfirmedOwner = o.state === 'assigned' && mine && !o.confirmed;
  if (!unconfirmedOwner && (pending.escalated || mine)) extra.push(act('ack', item, hx(lang, 'gotIt'), 'ghost', { reminderId: pending.reminderId }));
  if (!pending.snoozed && !pending.escalated) extra.push(act('snooze', item, hx(lang, 'later'), 'ghost', { reminderId: pending.reminderId }));
  return [...base, ...extra];
}

function boardActions(item: Item, view: HomemindViewData, lang: HomemindLang): A2uiAction[] {
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
    openNote(item, view, lang),
    pendingFor(item, view) ? hx(lang, pendingFor(item, view)?.snoozed ? 'remindAgain' : 'reminded') : ''
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

/** One preference as a `List` row: what, about whom, why, where, and whether it can be overridden. */
function prefListRow(p: Preference, view: HomemindViewData, lang: HomemindLang): { title: string; subtitle: string; meta: string } {
  const about = nameOf(memberOf(view.family, p.aboutMemberId), lang);
  const reason = lang === 'zh' && p.reasonZh ? p.reasonZh : p.reason;
  return {
    title: lang === 'zh' && p.textZh ? p.textZh : p.text,
    subtitle: [about, reason ? `${hx(lang, 'because')}: ${reason}` : '', p.scope ? `${hx(lang, 'appliesTo')}: ${p.scope}` : ''].filter(Boolean).join(' · '),
    meta: p.strength === 'hard' ? hx(lang, 'hard') : hx(lang, 'soft')
  };
}

type PrefFields = { text: string; textZh?: string; reason?: string; reasonZh?: string; aboutMemberId?: string; strength: 'hard' | 'soft'; scope?: string };

/** One preference as `InfoRows`, so the member can check what was saved (T5.4). */
function prefInfoRows(p: PrefFields, view: HomemindViewData, lang: HomemindLang): Array<{ label: string; value: string; tone: string }> {
  const about = nameOf(memberOf(view.family, p.aboutMemberId), lang);
  const reason = lang === 'zh' && p.reasonZh ? p.reasonZh : p.reason;
  return [
    { label: C.prefWhat[lang], value: lang === 'zh' && p.textZh ? p.textZh : p.text, tone: 'muted' },
    { label: C.prefAbout[lang], value: about || C.prefEveryone[lang], tone: 'muted' },
    { label: hx(lang, 'because'), value: reason || '—', tone: 'muted' },
    { label: hx(lang, 'appliesTo'), value: p.scope || C.prefEverywhere[lang], tone: 'muted' },
    { label: C.prefStrength[lang], value: p.strength === 'hard' ? hx(lang, 'hard') : hx(lang, 'soft'), tone: p.strength === 'hard' ? 'accent' : 'muted' }
  ];
}

const M = {
  ppmaTitle: { en: 'What PPMA remembers', zh: 'PPMA 记住的内容' },
  ppmaNote: {
    en: 'These are PPMA’s own words, not Homemind’s. Only what the whole family may see is shared with it.',
    zh: '以下是 PPMA 自己的表述，不是 Homemind 的。只有全家人都能看到的内容才会分享给它。'
  },
  loading: { en: 'Reading from PPMA…', zh: '正在从 PPMA 读取…' },
  readFailed: { en: 'Could not read PPMA’s memory right now. What is shown is the last read, if there was one.', zh: '暂时无法读取 PPMA 的记忆。显示的是上次读取的内容（如有）。' },
  empty: { en: 'PPMA has not remembered anything about the family yet.', zh: 'PPMA 还没有记住任何关于这个家庭的内容。' },
  originUser: { en: 'You told PPMA', zh: '你告诉 PPMA 的' },
  originApp: { en: 'From an app', zh: '来自应用' },
  originInferred: { en: 'PPMA’s guess', zh: 'PPMA 的推断' },
  confidence: { en: (n: number) => `Confidence ${n}%`, zh: (n: number) => `把握度 ${n}%` },
  wrong: { en: 'That’s wrong', zh: '这是错的' },
  forget: { en: 'Forget', zh: '忘掉' },
  sent: { en: 'Correction sent. Waiting for PPMA to apply it.', zh: '已发送更正，等待 PPMA 处理。' },
  parentsCorrect: { en: 'Only a parent can correct what PPMA remembers.', zh: '只有家长可以更正 PPMA 的记忆。' },
  saved: { en: 'Saved by Homemind', zh: 'Homemind 保存的偏好' },
  savedNote: {
    en: 'These are on Homemind’s own board and decide what it suggests. Removing one also tells PPMA.',
    zh: '这些保存在 Homemind 自己的看板上，决定它的建议。删除一条也会通知 PPMA。'
  },
  remove: { en: 'Remove', zh: '删除' },
  whyPpmaTitle: { en: 'Why is this suggested?', zh: '为什么会有这个建议？' },
  ppmaReason: { en: 'PPMA’s reason', zh: 'PPMA 的理由' },
  considered: { en: 'Saved preferences considered', zh: '参考的已保存偏好' },
  ppmaExplains: { en: 'PPMA explains', zh: 'PPMA 的解释' },
  explainLoading: { en: 'Asking PPMA for its explanation…', zh: '正在向 PPMA 询问解释…' },
  explainNone: { en: 'PPMA has no explanation to show for this. Only Homemind’s own record is shown.', zh: 'PPMA 没有可显示的解释，这里只显示 Homemind 自己的记录。' },
  noDecision: { en: 'PPMA gave no decision record, so there is nothing more from PPMA.', zh: 'PPMA 没有提供决策记录，因此没有更多来自 PPMA 的内容。' }
} as const;

type Row = { label: string; value: string; tone: string };

/** The rows that explain a suggestion that came from PPMA: its reason, what Homemind weighed, and PPMA's own explanation. */
function ppmaWhyRows(why: Why, ppma: PpmaExplanationData | undefined, lang: HomemindLang): Row[] {
  const rows: Row[] = [{ label: M.ppmaReason[lang], value: why.summary, tone: 'muted' }];
  const considered = why.basis.filter(b => b.kind === 'preference').map(b => b.note);
  if (considered.length) rows.push({ label: M.considered[lang], value: considered.join(lang === 'zh' ? '；' : '; '), tone: 'muted' });
  if (!why.decisionId) rows.push({ label: M.ppmaExplains[lang], value: M.noDecision[lang], tone: 'muted' });
  else if (ppma?.state === 'ready') rows.push({ label: M.ppmaExplains[lang], value: ppma.summary || ppma.rationale || '—', tone: 'accent' });
  else if (ppma?.state === 'loading') rows.push({ label: M.ppmaExplains[lang], value: M.explainLoading[lang], tone: 'muted' });
  else rows.push({ label: M.ppmaExplains[lang], value: M.explainNone[lang], tone: 'muted' });
  return rows;
}

function ppmaMemoryRows(mem: PpmaMemoryData, canCorrect: boolean, lang: HomemindLang): TaskRow[] {
  return mem.statements.map(st => {
    const origin = st.origin === 'user' ? M.originUser : st.origin === 'app' ? M.originApp : M.originInferred;
    const actions: A2uiAction[] =
      canCorrect && st.editable && !st.correcting
        ? (['wrong', 'forget'] as const).map(action => ({
            id: `homemind.memory-correct:${st.id}:${action}`,
            label: M[action][lang],
            variant: action === 'wrong' ? ('secondary' as const) : ('ghost' as const),
            kind: 'homemind' as const,
            args: { verb: 'memory-correct', statementId: st.id, action }
          }))
        : [];
    return {
      id: `ppma-${st.id}`,
      title: st.text,
      meta: [st.correcting ? M.sent[lang] : '', M.confidence[lang](Math.round(st.confidence * 100))].filter(Boolean).join(' · '),
      ownerLabel: origin[lang],
      state: '',
      tone: st.correcting ? 'muted' : 'accent',
      actions
    };
  });
}

function memoryScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  const isParent = memberOf(view.family, view.memberId)?.role === 'parent';
  // Never invent memory: PPMA's own entries appear only when PPMA is connected and has answered.
  if (input.ppma !== 'ok') {
    children.push({ id: 'ppma', component: 'ErrorNotice', title: input.ppma === 'offline' ? 'PPMA offline' : 'PPMA', body: hx(lang, input.ppma === 'offline' ? 'ppmaOffline' : 'ppmaOff') });
  } else {
    const mem = input.ppmaMemory;
    if (!mem || (mem.state === 'loading' && !mem.statements.length)) children.push(text('ppma-loading', `**${M.ppmaTitle[lang]}**\n\n${M.loading[lang]}`));
    else {
      if (mem.state === 'error' || mem.error) children.push({ id: 'ppma-error', component: 'ErrorNotice', title: 'PPMA', body: M.readFailed[lang] });
      if (mem.statements.length) {
        children.push(text('ppma-note', M.ppmaNote[lang]));
        children.push(taskList('ppma-list', M.ppmaTitle[lang], '/ppma'));
        data.ppma = ppmaMemoryRows(mem, isParent, lang);
        if (!isParent) children.push(text('ppma-parents', M.parentsCorrect[lang]));
      } else if (mem.state === 'ready') children.push(text('ppma-empty', `**${M.ppmaTitle[lang]}**\n\n${M.empty[lang]}`));
    }
  }
  if (view.preferences.length) {
    children.push(text('prefs-note', M.savedNote[lang]));
    children.push(taskList('prefs', M.saved[lang], '/prefs'));
    data.prefs = view.preferences.map(p => {
      const row = prefListRow(p, view, lang);
      const canRemove = isParent || p.strength === 'soft';
      return {
        id: `pref-${p.id}`,
        title: row.title,
        meta: [row.subtitle, row.meta].filter(Boolean).join(' · '),
        ownerLabel: '',
        state: '',
        tone: p.strength === 'hard' ? 'accent' : 'muted',
        actions: canRemove
          ? [{ id: `homemind.remove-preference:${p.id}`, label: M.remove[lang], variant: 'ghost', kind: 'homemind', args: { verb: 'remove-preference', preferenceId: p.id } } as A2uiAction]
          : []
      } satisfies TaskRow;
    });
  } else if (!children.some(c => c.component === 'Text' || c.component === 'TaskList')) children.push(text('empty', hx(lang, 'nothingHere')));
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
    undo: ['undid a change to', '撤销了对以下内容的修改'],
    settings: ['changed the settings', '修改了设置']
  };
  if (a.kind === 'preference') {
    const pref = view.preferences.find(p => p.id === a.ref);
    const what = pref ? `“${lang === 'zh' && pref.textZh ? pref.textZh : pref.text}”` : '';
    const words: Record<string, [string, string]> = {
      added: ['saved the preference', '保存了偏好'],
      corrected: ['corrected the preference', '更正了偏好'],
      removed: ['removed a preference', '删除了一条偏好'],
      undone: ['undid a preference change', '撤销了一次偏好更改']
    };
    const w = words[a.note ?? ''] ?? words.corrected;
    return lang === 'zh' ? `${who} ${w[1]} ${a.note === 'removed' ? '' : what}`.trim() : `${who} ${w[0]} ${a.note === 'removed' ? '' : what}`.trim();
  }
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

/**
 * Settings (T4.2), as a form. Every member sets their own quiet hours; a parent also sets the autonomy
 * level, pause and the backup contact (others see those as rows). Save sends only what changed
 * (`buildSettingsSave` in src/lib/homemindForm.ts); the bridge decides who may change what.
 */
function settingsScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const me = memberOf(view.family, view.memberId);
  const fam = view.family;
  const levels = [hx(lang, 'level1'), hx(lang, 'level2'), hx(lang, 'level3'), hx(lang, 'level4')];
  const isParent = me?.role === 'parent';
  const contact = fam.backupContact;
  const contactName = contact ? (lang === 'zh' && contact.nameZh ? contact.nameZh : contact.name) : '';
  const about = [
    { label: hx(lang, 'signedIn'), value: nameOf(me, lang), tone: 'muted' },
    { label: hx(lang, 'zone'), value: fam.timezone, tone: 'muted' },
    ...(input.llm ? [{ label: hx(lang, 'model'), value: input.llm === 'fake' ? hx(lang, 'modelFake') : input.llm === 'live' ? hx(lang, 'modelLive') : hx(lang, 'modelOff'), tone: input.llm === 'live' ? 'muted' : 'accent' }] : [])
  ];
  const field = (name: string, label: string, value: string, extra: Record<string, unknown> = {}): A2uiComponent => ({ id: `f-${name}`, component: 'TextField', name, label, default: value, ...extra });
  const children: A2uiComponent[] = [{ id: 'about', component: 'InfoRows', title: hx(lang, 'settings'), dataPath: '/about' }];
  const data: Record<string, unknown> = { about };

  if (me?.hasAccount) {
    children.push(text('quiet-title', `**${hx(lang, 'quiet')}**\n\n${hx(lang, 'sQuietHint')}`));
    children.push(field('quietFrom', hx(lang, 'sQuietFrom'), me.quietHours?.from ?? '', { inputType: 'time' }));
    children.push(field('quietTo', hx(lang, 'sQuietTo'), me.quietHours?.to ?? '', { inputType: 'time' }));
  }

  if (isParent) {
    children.push({
      id: 'f-autonomy',
      component: 'ChoiceGroup',
      name: 'autonomy',
      title: hx(lang, 'autonomy'),
      default: String(fam.autonomy.default),
      options: (['sLevelHint1', 'sLevelHint2', 'sLevelHint3', 'sLevelHint4'] as const).map((hint, i) => ({ value: String(i + 1), label: levels[i], description: hx(lang, hint) }))
    });
    children.push(text('pause-hint', hx(lang, 'sPauseHint')));
    children.push({ id: 'f-paused', component: 'Toggle', name: 'paused', label: hx(lang, 'sPause'), default: fam.paused });
    children.push(text('esc-title', `**${hx(lang, 'sEscalation')}**\n\n${hx(lang, 'sEscalationHint')}\n\n**${hx(lang, 'alertNote')}**`));
    children.push(field('backupName', hx(lang, 'sBackupName'), contactName, { maxLength: 60 }));
    children.push({
      id: 'f-backupChannel',
      component: 'ChoiceGroup',
      name: 'backupChannel',
      title: hx(lang, 'sBackupChannel'),
      default: contact?.channel ?? 'sms',
      options: [
        { value: 'sms', label: hx(lang, 'sSms') },
        { value: 'call', label: hx(lang, 'sCall') }
      ]
    });
    children.push(text('backup-sim', `**${hx(lang, 'simulated')}**: ${hx(lang, 'sBackupSimulated')}`));
  } else {
    data.family = [
      { label: hx(lang, 'autonomy'), value: levels[fam.autonomy.default - 1] ?? String(fam.autonomy.default), tone: 'muted' },
      { label: hx(lang, 'paused'), value: fam.paused ? hx(lang, 'pausedYes') : hx(lang, 'pausedNo'), tone: fam.paused ? 'accent' : 'muted' },
      { label: hx(lang, 'backup'), value: contact ? `${contactName}${contact.simulated ? ` · ${hx(lang, 'simulated')}` : ''}` : hx(lang, 'backupNone'), tone: 'muted' }
    ];
    children.push({ id: 'family', component: 'InfoRows', title: hx(lang, 'sFamily'), dataPath: '/family' });
    children.push(text('parents-only', `${hx(lang, 'sParentsOnly')}\n\n**${hx(lang, 'alertNote')}**`));
  }

  if (me?.hasAccount) {
    // The contact's shown name may be its Chinese name; saving it unchanged must not rename the contact.
    const args: Record<string, unknown> = { verb: 'save-settings', family: isParent };
    if (contact) Object.assign(args, { backupStored: contact.name, backupShown: contactName });
    children.push({ id: 'actions', component: 'ActionBar', actions: [{ id: 'homemind.save-settings', label: hx(lang, 'sSave'), variant: 'primary', kind: 'homemind', args }] });
  }
  children.push(text('note', hx(lang, 'demoSignIn')));
  return turn('settings', hx(lang, 'settings'), undefined, children, data);
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

  if (item?.type === 'event') preparationsBlock(item, view, lang, today, children, data);
  return turn('edit', title, parent && !item ? titleOf(parent, lang) : undefined, children, data);
}

/** An event's preparations: tap a title to edit it, remove it here, or add one. */
function preparationsBlock(event: Item, view: HomemindViewData, lang: HomemindLang, today: string, children: A2uiComponent[], data: Record<string, unknown>): void {
  const preps = view.items.filter(i => i.parentEventId === event.id && live(i)).sort(byStart);
  const rows = preps.map(p => ({ ...taskRow(p, view, lang, today), actions: [act('cancel', p, hx(lang, 'remove'), 'ghost')] }));
  section(children, data, 'preps', hx(lang, 'preparations'), rows, hx(lang, 'noPreps'));
  children.push({ id: 'prep-actions', component: 'ActionBar', actions: [{ id: `homemind.add:${event.id}`, label: hx(lang, 'addPrep'), variant: 'secondary', kind: 'homemind', args: { verb: 'add', parentEventId: event.id } }] });
}

/**
 * One item, short (T3.2): what the Family tab shows after a save, instead of the whole form.
 * Its details, its own row (claim, assign...), Edit (opens the form), Remove, and for an event its
 * preparations.
 */
function itemScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const id = input.edit?.itemId;
  const item = id ? view.items.find(i => i.id === id && live(i)) : undefined;
  const backBar: A2uiAction = { id: 'homemind.back', label: hx(lang, 'back'), variant: 'ghost', kind: 'homemind', args: { verb: 'back' } };
  if (!item) return turn('item', hx(lang, 'thisItem'), undefined, [{ id: 'gone', component: 'ErrorNotice', title: hx(lang, 'thisItem'), body: hx(lang, 'notFound') }, { id: 'actions', component: 'ActionBar', actions: [backBar] }], {});

  const names = (ids: string[]) => ids.map(m => nameOf(memberOf(view.family, m), lang)).filter(Boolean).join(lang === 'zh' ? '、' : ', ');
  const end = item.end && !item.allDay ? dateParts(item.end, zone) : null;
  const when = whenLabel(item, today, zone, lang);
  const parent = item.parentEventId ? view.items.find(i => i.id === item.parentEventId) : undefined;
  const rows = [
    { label: hx(lang, 'dWhen'), value: when ? `${when}${end ? `–${end.time}` : ''}` : hx(lang, 'dNoTime'), tone: 'muted' },
    ...(parent ? [{ label: hx(lang, 'under'), value: titleOf(parent, lang), tone: 'muted' }] : []),
    ...(item.forMemberIds.length ? [{ label: hx(lang, 'dFor'), value: names(item.forMemberIds), tone: 'muted' }] : []),
    ...(item.unavailableMemberIds.length ? [{ label: hx(lang, 'dAway'), value: names(item.unavailableMemberIds), tone: 'accent' }] : []),
    ...(item.notes ? [{ label: hx(lang, 'dNotes'), value: item.notes, tone: 'muted' }] : []),
    { label: hx(lang, 'dSeen'), value: item.visibility === 'parents' ? hx(lang, 'parentsOnly') : hx(lang, 'dFamily'), tone: 'muted' }
  ];
  const row: TaskRow = taskRow(item, view, lang, today);
  delete row.open;
  const children: A2uiComponent[] = [
    taskList('this', hx(lang, 'thisItem'), '/this'),
    { id: 'details', component: 'InfoRows', title: hx(lang, 'details'), dataPath: '/details' },
    {
      id: 'actions',
      component: 'ActionBar',
      actions: [
        { id: `homemind.edit:${item.id}`, label: hx(lang, 'edit'), variant: 'primary', kind: 'homemind', args: { verb: 'edit', itemId: item.id } },
        act('cancel', item, hx(lang, 'remove'), 'secondary'),
        backBar
      ]
    }
  ];
  const data: Record<string, unknown> = { this: [row], details: rows };
  if (input.itemPreferences?.length) {
    children.splice(2, 0, { id: 'prefs', component: 'List', title: C.prefApply[lang], dataPath: '/prefs' });
    data.prefs = input.itemPreferences.map(p => prefListRow(p, view, lang));
  }
  const why = view.whys.find(w => w.basis.some(b => b.ref === item.id));
  if (why?.source === 'ppma') {
    children.splice(2, 0, { id: 'why', component: 'InfoRows', title: M.whyPpmaTitle[lang], dataPath: '/why' });
    data.why = [...ppmaWhyRows(why, input.itemPpma, lang), { label: C.whySource[lang], value: C.srcPpma[lang], tone: 'muted' }];
  }
  if (item.type === 'event') preparationsBlock(item, view, lang, today, children, data);
  return turn('item', titleOf(item, lang), undefined, children, data);
}

// --- chat turns (T5.2) ------------------------------------------------------------------------------

/** What one chat message did, as the bridge decided it (server/homemind/chat.ts). */
export type ChatOutcome =
  | { kind: 'answer'; answer: string; itemIds: string[] }
  | {
      kind: 'written';
      intent: 'create_event' | 'create_task' | 'add_preparation' | 'assign' | 'claim' | 'mark_done';
      itemId: string;
      proposed: boolean;
      /** Set when this member may undo it. */
      activityId?: string;
      /** Items availability opened ("Who's taking this?"), and clashes left as suggestions. */
      opened: string[];
      conflicts: number;
    }
  | { kind: 'suggest'; intent: 'assign' | 'claim' | 'mark_done'; itemId: string; verb: 'assign' | 'claim' | 'done'; memberId?: string; reason: 'level1' | 'paused' }
  | { kind: 'why'; explanation: ItemExplanation; ppma?: PpmaExplanationData }
  /** T5.4: a preference saved (`added`, `corrected`) or already saved as said (`unchanged`). */
  | { kind: 'preference'; action: 'added' | 'corrected' | 'unchanged'; preference: Preference; activityId?: string }
  /** T5.4: level 1 or paused: nothing saved, a Save button instead. */
  | { kind: 'preference-suggest'; input: { text: string; reason?: string; aboutMemberId?: string; strength: 'hard' | 'soft'; scope?: string }; reason: 'level1' | 'paused' }
  /** T5.4: a hard preference rules this out. Nothing changed. */
  | { kind: 'blocked'; title: string; blocked: Array<{ preference: Preference; term: string }> }
  | { kind: 'later'; intent: 'create_rule' | 'report_situation' }
  | { kind: 'missing' }
  /** T5.3: a screenshot read by the model. Everything created is proposed. */
  | { kind: 'extracted'; created: ExtractedEntry[]; skipped: SkippedExtraction[]; dropped: number; signUp?: SignUpInfo }
  /** `model`: the model failed or gave nothing usable. `image`: the same, for a screenshot. `change`: the board refused the change. */
  | { kind: 'failed'; reason: 'model' | 'image' | 'change' | 'not_configured'; code: string; message: string };

export interface ChatTurnData {
  lang: HomemindLang;
  now: string;
  /** The member's view after the change. */
  view: HomemindViewData;
  llm: 'live' | 'fake' | 'not_configured';
  /** Makes the surface id unique, so every chat message keeps its own card. */
  turnId: string;
  outcome: ChatOutcome;
  reminders?: PendingReminder[];
}

const C = {
  added: { en: 'Added to the board:', zh: '已添加到家庭看板：' },
  proposedAdd: { en: 'Suggested for the board, waiting for approval:', zh: '已作为建议放到看板上，等待批准：' },
  assigned: { en: (t: string, who: string) => `Assigned “${t}” to ${who}. ${who} still needs to confirm.`, zh: (t: string, who: string) => `已把“${t}”分配给${who}，还需要${who}确认。` },
  claimed: { en: (t: string) => `“${t}” is yours now.`, zh: (t: string) => `“${t}”现在由你负责。` },
  doneMsg: { en: (t: string) => `Marked done: “${t}”.`, zh: (t: string) => `已标记完成：“${t}”。` },
  undoHint: { en: 'You can undo it.', zh: '可以撤销。' },
  opened: { en: (n: number) => `${n} item(s) clash with it and are now “Who's taking this?”.`, zh: (n: number) => `有 ${n} 个事项与它冲突，现在标记为“谁来负责？”。` },
  conflicts: { en: (n: number) => `${n} item(s) clash with it. See the Family tab to decide who takes them.`, zh: (n: number) => `有 ${n} 个事项与它冲突，请到家庭标签页决定由谁负责。` },
  level1: { en: 'Autonomy is set to “Suggests”, so nothing was changed. Tap to do it:', zh: '自主程度设为“仅建议”，所以没有做任何更改。点一下即可执行：' },
  pausedMsg: { en: 'Automatic actions are paused, so nothing was changed. Tap to do it:', zh: '自动操作已暂停，所以没有做任何更改。点一下即可执行：' },
  suggestion: { en: 'Suggestion', zh: '建议' },
  prefAdded: { en: 'Saved as a family preference. Check that the reason is in your own words.', zh: '已保存为家庭偏好。请确认原因是你自己的说法。' },
  prefCorrected: { en: 'Updated the saved preference. Check that it reads right.', zh: '已更新保存的偏好。请确认内容无误。' },
  prefUnchanged: { en: 'This preference was already saved like this. Nothing changed.', zh: '这条偏好已经这样保存过了，没有更改。' },
  prefLevel1: { en: 'Autonomy is set to “Suggests”, so nothing was saved. Tap Save to keep it:', zh: '自主程度设为“仅建议”，所以没有保存。点“保存”即可保留：' },
  prefPaused: { en: 'Automatic actions are paused, so nothing was saved. Tap Save to keep it:', zh: '自动操作已暂停，所以没有保存。点“保存”即可保留：' },
  prefSave: { en: 'Save', zh: '保存' },
  prefTitle: { en: 'Family preference', zh: '家庭偏好' },
  prefWhat: { en: 'Preference', zh: '偏好' },
  prefAbout: { en: 'About', zh: '关于' },
  prefEveryone: { en: 'The whole family', zh: '全家' },
  prefEverywhere: { en: 'Everywhere', zh: '所有场合' },
  prefStrength: { en: 'Strength', zh: '程度' },
  prefApply: { en: 'Family preferences that apply', zh: '适用的家庭偏好' },
  blockedMsg: {
    en: (t: string) => `Not added: “${t}” goes against a preference that is never overridden. Nothing was changed.`,
    zh: (t: string) => `没有添加：“${t}”违反了一条不可更改的偏好，没有做任何更改。`
  },
  blockedTitle: { en: 'Ruled out by a preference', zh: '被偏好排除' },
  blockedWord: { en: 'Found', zh: '包含' },
  blockedWhy: { en: 'Hard preferences (allergies, dietary laws) are never overridden. Choose something else, or a parent can change the preference.', zh: '硬性偏好（过敏、饮食禁忌）不会被违反。请换一个选择，或由家长修改这条偏好。' },
  blockedList: { en: 'The preference', zh: '相关偏好' },
  laterRule: { en: 'Standing rules from chat are not built yet. Nothing was set up. A rule will only prepare a card that a parent taps.', zh: '通过对话设置长期规则的功能尚未完成，没有设置任何规则。规则只会准备卡片，由家长点一下确认。' },
  laterSituation: { en: 'Planning around a situation (who stays home, what to postpone) is not built yet. Nothing was changed.', zh: '根据突发情况重新安排（谁留在家、推迟什么）的功能尚未完成，没有做任何更改。' },
  missing: { en: 'That item is not on your board any more. Nothing was changed.', zh: '这个事项已不在你的看板上，没有做任何更改。' },
  failedModel: { en: 'The model could not read this message. Nothing was changed. Try again, or use the Family tab.', zh: '模型无法理解这条消息，没有做任何更改。请重试，或使用家庭标签页。' },
  failedOff: { en: 'The model is not set up, so chat cannot read messages. The Family tab still works.', zh: '模型未配置，对话无法理解消息。家庭标签页仍可正常使用。' },
  failedChange: { en: 'The board did not accept this change. Nothing was changed.', zh: '看板没有接受这个更改，没有做任何更改。' },
  whyTitle: { en: 'Why is this on the board?', zh: '为什么会在看板上？' },
  whyOwn: { en: 'From Homemind’s own board record (not from PPMA).', zh: '来自 Homemind 自己的看板记录（不是来自 PPMA）。' },
  whyLead: { en: (t: string) => `Here is what the board records about “${t}”.`, zh: (t: string) => `这是看板上关于“${t}”的记录。` },
  whyAdded: { en: 'Added by', zh: '添加人' },
  whyHow: { en: 'How', zh: '方式' },
  whyOwner: { en: 'Who has it', zh: '负责人' },
  whyLast: { en: 'Last change', zh: '最近的更改' },
  whyReason: { en: 'Note', zh: '说明' },
  whyRecord: { en: 'Explanation', zh: '解释' },
  whySource: { en: 'Source', zh: '来源' },
  srcRule: { en: 'a Homemind rule', zh: 'Homemind 规则' },
  srcModel: { en: 'the model', zh: '模型' },
  srcPpma: { en: 'PPMA', zh: 'PPMA' },
  related: { en: 'On your board', zh: '你的看板上' },
  readShot: { en: (n: number) => `I read the screenshot. ${n} suggestion(s) are on the board, waiting for approval. Nothing is final until someone taps Approve.`, zh: (n: number) => `已读取截图。${n} 条建议已放到看板上，等待批准。点“确认添加”之前都不会生效。` },
  readNothing: { en: 'I read the screenshot but found nothing new to add. Nothing was changed.', zh: '已读取截图，但没有发现需要添加的新内容，没有做任何更改。' },
  readDup: { en: (n: number) => `${n} entry(ies) were already on the board.`, zh: (n: number) => `有 ${n} 条已在看板上。` },
  readPast: { en: (n: number) => `${n} entry(ies) are already over or past their deadline, and were left out.`, zh: (n: number) => `有 ${n} 条已经结束或已过截止时间，没有添加。` },
  readPrepHint: { en: 'Approving an event also approves its preparations.', zh: '确认添加活动时，其准备事项也会一并添加。' },
  readCheck: { en: 'Read by the model from your screenshot. Check the quotes before approving.', zh: '由模型从你的截图中读取。确认添加前请核对原文。' },
  readWaiting: { en: 'Waiting for approval', zh: '等待批准' },
  readQuotes: { en: 'What the screenshot says', zh: '截图原文' },
  readSuggested: { en: 'time suggested by Homemind', zh: '时间由 Homemind 建议' },
  readUnsure: { en: 'unsure, check it', zh: '不确定，请核对' },
  signUpTitle: { en: 'Sign-up in the screenshot', zh: '截图中的接龙' },
  signUpTopic: { en: 'Topic', zh: '主题' },
  signUpDeadline: { en: 'Deadline', zh: '截止' },
  signUpTaken: { en: 'Already taken', zh: '已认领' },
  signUpNone: { en: 'nothing yet', zh: '暂无' },
  failedImage: { en: 'The model could not read this screenshot. Nothing was changed. Try a clearer image, or add the items on the Family tab.', zh: '模型无法读取这张截图，没有做任何更改。请换一张更清晰的图片，或在家庭标签页手动添加。' },
  whyQuote: { en: (t: string, q: string) => `The model read “${t}” from a screenshot. The source says: ${q}`, zh: (t: string, q: string) => `“${t}”是模型从截图中读取的。原文：${q}` },
  answered: { en: 'Answered from your board', zh: '根据你的看板回答' }
} as const;

const SOURCE_KIND: Record<string, [string, string]> = {
  manual: ['Typed in on the board', '在看板上手动添加'],
  chat: ['Asked for in chat', '通过对话添加'],
  screenshot: ['Read from a screenshot', '从截图中读取'],
  email: ['Read from an email', '从邮件中读取'],
  group: ['From the group chat', '来自群聊'],
  rule: ['Added by a Homemind rule', '由 Homemind 规则添加'],
  ppma: ['Suggested by PPMA', '由 PPMA 建议']
};

/**
 * Model text can't carry a link: the chat renders light markdown, and `[x](javascript:...)` would
 * become one. Breaking `](` keeps the words and drops the link.
 */
export const plainChatText = (value: string): string => value.replace(/\]\s*\(/g, '] (');

function whyRows(e: ItemExplanation, view: HomemindViewData, lang: HomemindLang, ppma?: PpmaExplanationData): Array<{ label: string; value: string; tone: string }> {
  const item = view.items.find(i => i.id === e.itemId);
  const zone = view.family.timezone;
  const rows: Array<{ label: string; value: string; tone: string }> = [];
  if (e.why) {
    const src = e.why.source === 'ppma' ? C.srcPpma : e.why.source === 'model' ? C.srcModel : C.srcRule;
    rows.push({ label: C.whyRecord[lang], value: e.why.summary, tone: 'muted' }, { label: C.whySource[lang], value: src[lang], tone: 'muted' });
    if (e.why.source === 'ppma') rows.push(...ppmaWhyRows(e.why, ppma, lang).slice(1));
  }
  const created = e.createdAt ? dateParts(e.createdAt, zone) : null;
  rows.push({ label: C.whyAdded[lang], value: `${nameOf(memberOf(view.family, e.createdBy), lang) || e.createdBy}${created ? ` · ${created.date.slice(5)} ${created.time}` : ''}`, tone: 'muted' });
  const how = SOURCE_KIND[e.source.kind];
  rows.push({ label: C.whyHow[lang], value: `${how ? how[lang === 'zh' ? 1 : 0] : e.source.kind}${e.source.simulated ? ` (${hx(lang, 'simulated')})` : ''}`, tone: 'muted' });
  if (item) {
    rows.push({ label: C.whyOwner[lang], value: ownerLabelOf(item, view, lang), tone: 'muted' });
    const note = openNote(item, view, lang);
    if (note) rows.push({ label: C.whyReason[lang], value: note, tone: 'accent' });
  }
  const last = e.lastActivityId ? view.activity.find(a => a.id === e.lastActivityId) : undefined;
  if (last) {
    const at = dateParts(last.at, zone);
    rows.push({ label: C.whyLast[lang], value: `${activityLine(last, view, lang)}${at ? ` · ${at.date.slice(5)} ${at.time}` : ''}`, tone: 'muted' });
  }
  return rows;
}

/**
 * One chat message's answer: the text for the bubble, and a card with the rows it touched, Undo, a
 * suggestion button, an explanation or an error. With the simulated model the card says so.
 */
export function chatTurn(input: ChatTurnData): HomemindTurn {
  const { lang, outcome } = input;
  const view = input.reminders ? { ...input.view, pending: input.reminders } : input.view;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  const rowsFor = (ids: string[]) => ids.flatMap(id => view.items.filter(i => i.id === id && live(i)).map(i => taskRow(i, view, lang, today)));
  const titleById = (id: string) => {
    const item = view.items.find(i => i.id === id);
    return item ? titleOf(item, lang) : '';
  };
  let message = '';
  let title = hx(lang, 'brand');

  switch (outcome.kind) {
    case 'answer': {
      message = plainChatText(outcome.answer);
      const rows = rowsFor(outcome.itemIds);
      if (rows.length) {
        children.push(taskList('rows', C.related[lang], '/rows'));
        data.rows = rows;
      }
      title = C.answered[lang];
      break;
    }
    case 'written': {
      const t = titleById(outcome.itemId);
      const item = view.items.find(i => i.id === outcome.itemId);
      const owner = item?.ownership.state === 'assigned' ? nameOf(memberOf(view.family, item.ownership.ownerId), lang) : '';
      const parts: string[] = [];
      if (outcome.intent === 'assign') parts.push(C.assigned[lang](t, owner));
      else if (outcome.intent === 'claim') parts.push(C.claimed[lang](t));
      else if (outcome.intent === 'mark_done') parts.push(C.doneMsg[lang](t));
      else parts.push(`${outcome.proposed ? C.proposedAdd[lang] : C.added[lang]} “${t}”`);
      if (outcome.opened.length) parts.push(C.opened[lang](outcome.opened.length));
      else if (outcome.conflicts) parts.push(C.conflicts[lang](outcome.conflicts));
      if (outcome.activityId) parts.push(C.undoHint[lang]);
      message = parts.join(' ');
      const rows = rowsFor([outcome.itemId, ...outcome.opened]);
      if (rows.length) {
        children.push(taskList('rows', hx(lang, 'thisItem'), '/rows'));
        data.rows = rows;
      }
      if (outcome.activityId) {
        children.push({
          id: 'actions',
          component: 'ActionBar',
          actions: [{ id: `homemind.undo:${outcome.activityId}`, label: hx(lang, 'undo'), variant: 'secondary', kind: 'homemind', args: { verb: 'undo', activityId: outcome.activityId, itemId: outcome.itemId } }]
        });
      }
      title = t || title;
      break;
    }
    case 'suggest': {
      const item = view.items.find(i => i.id === outcome.itemId && live(i));
      message = outcome.reason === 'paused' ? C.pausedMsg[lang] : C.level1[lang];
      if (item) {
        const who = nameOf(memberOf(view.family, outcome.memberId), lang);
        const label =
          outcome.verb === 'done' ? hx(lang, 'done') : outcome.verb === 'claim' || outcome.memberId === view.memberId ? hx(lang, 'claim') : `${hx(lang, 'assignTo')} ${who}`;
        const row = taskRow(item, view, lang, today);
        children.push(taskList('rows', C.suggestion[lang], '/rows'));
        data.rows = [row];
        children.push({ id: 'actions', component: 'ActionBar', actions: [act(outcome.verb, item, label, 'primary', outcome.memberId ? { memberId: outcome.memberId } : {})] });
        title = titleOf(item, lang);
      } else {
        message = C.missing[lang];
      }
      break;
    }
    case 'why': {
      const e = outcome.explanation;
      const quoted = e.why?.source === 'model' && e.why.basis.some(b => b.kind === 'quote');
      message = e.why ? (quoted ? C.whyQuote[lang](plainChatText(titleById(e.itemId)), plainChatText(e.why.summary)) : e.why.summary) : C.whyLead[lang](titleById(e.itemId));
      const rows = rowsFor([e.itemId]);
      if (rows.length) {
        children.push(taskList('rows', hx(lang, 'thisItem'), '/rows'));
        data.rows = rows;
      }
      children.push({ id: 'why', component: 'InfoRows', title: C.whyTitle[lang], dataPath: '/why' });
      data.why = whyRows(e, view, lang, outcome.ppma);
      if (!e.why) children.push(text('why-note', C.whyOwn[lang]));
      title = titleById(e.itemId) || C.whyTitle[lang];
      break;
    }
    case 'preference': {
      message = outcome.action === 'added' ? C.prefAdded[lang] : outcome.action === 'corrected' ? C.prefCorrected[lang] : C.prefUnchanged[lang];
      if (outcome.activityId) message = `${message} ${C.undoHint[lang]}`;
      children.push({ id: 'pref', component: 'InfoRows', title: C.prefTitle[lang], dataPath: '/pref' });
      data.pref = prefInfoRows(outcome.preference, view, lang);
      if (outcome.activityId) {
        children.push({
          id: 'actions',
          component: 'ActionBar',
          actions: [{ id: `homemind.undo-preference:${outcome.activityId}`, label: hx(lang, 'undo'), variant: 'secondary', kind: 'homemind', args: { verb: 'undo-preference', activityId: outcome.activityId } }]
        });
      }
      title = C.prefTitle[lang];
      break;
    }
    case 'preference-suggest': {
      message = outcome.reason === 'paused' ? C.prefPaused[lang] : C.prefLevel1[lang];
      children.push({ id: 'pref', component: 'InfoRows', title: C.suggestion[lang], dataPath: '/pref' });
      data.pref = prefInfoRows(outcome.input, view, lang);
      children.push({
        id: 'actions',
        component: 'ActionBar',
        actions: [{ id: 'homemind.save-preference', label: C.prefSave[lang], variant: 'primary', kind: 'homemind', args: { verb: 'save-preference', ...outcome.input } }]
      });
      title = C.prefTitle[lang];
      break;
    }
    case 'blocked': {
      message = C.blockedMsg[lang](plainChatText(outcome.title));
      children.push({ id: 'err', component: 'ErrorNotice', title: C.blockedTitle[lang], body: C.blockedWhy[lang] });
      children.push({ id: 'blocked', component: 'List', title: C.blockedList[lang], dataPath: '/blocked' });
      data.blocked = outcome.blocked.map(b => {
        const row = prefListRow(b.preference, view, lang);
        return { ...row, subtitle: [row.subtitle, `${C.blockedWord[lang]}: ${b.term}`].filter(Boolean).join(' · ') };
      });
      title = C.blockedTitle[lang];
      break;
    }
    case 'later':
      message = outcome.intent === 'create_rule' ? C.laterRule[lang] : C.laterSituation[lang];
      break;
    case 'missing':
      message = C.missing[lang];
      break;
    case 'extracted': {
      const created = outcome.created.filter(c => view.items.some(i => i.id === c.itemId));
      const dups = outcome.skipped.filter(s => s.reason === 'duplicate').length;
      const past = outcome.skipped.filter(s => s.reason === 'past').length;
      const parts = [created.length ? C.readShot[lang](created.length) : C.readNothing[lang]];
      if (dups) parts.push(C.readDup[lang](dups));
      if (past) parts.push(C.readPast[lang](past));
      if (created.some(c => c.kind === 'preparation') && created.some(c => c.kind === 'event')) parts.push(C.readPrepHint[lang]);
      message = parts.join(' ');
      // Events first, each followed by its preparations; then the rest, in the order read.
      const byId = new Map(created.map(c => [c.itemId, c]));
      const items = created.map(c => view.items.find(i => i.id === c.itemId)).filter((i): i is Item => !!i);
      const ordered: Item[] = [];
      for (const item of items) {
        if (item.type === 'preparation' && items.some(e => e.id === item.parentEventId)) continue;
        ordered.push(item, ...items.filter(p => p.type === 'preparation' && p.parentEventId === item.id));
      }
      if (ordered.length) {
        children.push(taskList('rows', C.readWaiting[lang], '/rows'));
        data.rows = ordered.map(item => {
          const row = taskRow(item, view, lang, today);
          const c = byId.get(item.id);
          const marks = [c?.suggestedTime ? C.readSuggested[lang] : '', c?.unsure ? C.readUnsure[lang] : ''].filter(Boolean);
          return marks.length ? { ...row, meta: [row.meta, ...marks].filter(Boolean).join(' · ') } : row;
        });
        children.push({ id: 'quotes', component: 'InfoRows', title: C.readQuotes[lang], dataPath: '/quotes' });
        data.quotes = ordered.map(item => ({ label: titleOf(item, lang), value: byId.get(item.id)?.quote ? `“${byId.get(item.id)?.quote}”` : '—', tone: byId.get(item.id)?.unsure ? 'accent' : 'muted' }));
      }
      if (outcome.signUp) {
        const s = outcome.signUp;
        const deadline = s.deadline ? dateParts(s.deadline, zone) : null;
        children.push({ id: 'signup', component: 'InfoRows', title: C.signUpTitle[lang], dataPath: '/signup' });
        data.signup = [
          { label: C.signUpTopic[lang], value: s.topic, tone: 'muted' },
          ...(deadline ? [{ label: C.signUpDeadline[lang], value: `${deadline.date.slice(5)} ${deadline.time}`, tone: 'muted' }] : []),
          { label: C.signUpTaken[lang], value: s.taken.length ? s.taken.map(t => `${t.item} (${t.who})`).join(lang === 'zh' ? '、' : ', ') : C.signUpNone[lang], tone: 'muted' }
        ];
      }
      if (ordered.length || outcome.signUp) children.push(text('check', C.readCheck[lang]));
      title = hx(lang, 'brand');
      break;
    }
    case 'failed': {
      const body = outcome.reason === 'not_configured' ? C.failedOff[lang] : outcome.reason === 'model' ? C.failedModel[lang] : outcome.reason === 'image' ? C.failedImage[lang] : C.failedChange[lang];
      children.push({ id: 'err', component: 'ErrorNotice', title: hx(lang, 'failed'), body: outcome.reason === 'change' && outcome.message ? `${body} (${outcome.message})` : body });
      break;
    }
  }

  // The simulated model is labelled on the card itself.
  if (input.llm === 'fake' && outcome.kind !== 'failed') children.push(text('model', `**${hx(lang, 'modelFake')}**`));
  if (!children.length) return { message, thinking: [], followUps: [], jsonl: '' };
  const kind = `chat-${input.turnId}`;
  const components: A2uiComponent[] = [{ id: 'root', component: 'SurfaceRoot', title, children: children.map(c => c.id) }, ...children];
  return { message, thinking: [], followUps: [], jsonl: surfaceJsonl(kind, title, undefined, components, data, outcome.kind === 'failed' ? 'error' : 'ready') };
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
  edit: editScreen,
  item: itemScreen
};

/** One screen as a turn. */
export function screenTurn(screen: HomemindScreenName, input: HomemindScreenData): HomemindTurn {
  const view = input.reminders ? { ...input.view, pending: input.reminders } : input.view;
  return SCREEN_BUILDERS[screen]({ ...input, view });
}

export function homemindErrorTurn(message: string, lang: HomemindLang): HomemindTurn {
  const components: A2uiComponent[] = [
    { id: 'root', component: 'SurfaceRoot', title: hx(lang, 'brand'), children: ['err'] },
    { id: 'err', component: 'ErrorNotice', title: hx(lang, 'failed'), body: message }
  ];
  return { message: '', thinking: [], followUps: [], jsonl: surfaceJsonl('error', hx(lang, 'brand'), undefined, components, {}, 'error') };
}
