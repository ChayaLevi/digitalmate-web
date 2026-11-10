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
import type { ActionCard, Activity, ExtractedEntry, Family, GroupMessage, GroupsView, Item, ItemExplanation, Lang, Member, MessageJudgment, PendingReminder, PpmaExplanationData, PpmaMemoryData, Preference, Reminder, Rule, RuleRun, ServicesView, SignUpInfo, SituationView, SkippedExtraction, SourceChangeView, ShoppingState, SummaryView, Why } from '../../server/homemind/types';

export type HomemindLang = Lang;
export type HomemindScreenName = 'my-day' | 'family' | 'calendar' | 'search' | 'rules' | 'memory' | 'activity' | 'settings' | 'edit' | 'item' | 'services' | 'summary' | 'shopping';

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
  /** T7.3: what the standing rules did (already filtered for this member). */
  ruleRuns?: RuleRun[];
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
  /** For the `services` screen (T7.2): the simulated services, the inbox already limited to this member's own. */
  services?: ServicesView;
  /** `HOMEMIND_DEMO=1`: the screen may offer demo controls (post the next group message, prepare a rule card now). */
  demo?: boolean;
  /** T7.3: a parent's confirmation token per pending card, put behind that card's Confirm button. */
  confirmations?: Record<string, { token: string; expiresAt: string }>;
  /** T7.4: the group claim setting and the sign-ups Homemind looked at (`my-day` and `services`). */
  groups?: GroupsView;
  /** T7.5: messages that changed after the family acted on them, limited by the server to what this member can see. */
  sourceChanges?: SourceChangeView[];
  /** T8.1: "Noa is sick" and the suggestions for that day (`my-day`), limited by the server to what this member can see. */
  situations?: SituationView[];
  /** T8.2, the `summary` screen: the evening summary or the week ahead, built by the server from this member's view. */
  summary?: SummaryView;
  /** T8.2 (`my-day`, `services`, parents only): how soon each group message is shown, and why. */
  judgments?: MessageJudgment[];
  /** T8.2, the `memory` screen (`?id=`): the saved preference to correct, in a small form. */
  correctPreferenceId?: string;
  /** T9.1, the `rules` screen (`?id=`): one rule's details, and (when it is on) when it next runs. */
  ruleId?: string;
  ruleNext?: { at: string; prepareAt: string };
  /** The `shopping` screen: the family's lists per store (the whole family sees them). */
  shopping?: ShoppingState;
  /** The `shopping` screen: an item someone tried to add again, and the quantity they asked for. */
  shoppingAsk?: { itemId: string; qty?: number };
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
  /** Shopping: "− 3 +" on the row. No `less`: the "−" is off (one is the least). */
  quantity?: { value: number; label: string; less?: A2uiAction; more?: A2uiAction };
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
  today: { en: 'Today', zh: '今天' },
  comingUp: { en: 'Coming up', zh: '接下来' },
  nothingToday: { en: 'Nothing for you today.', zh: '今天没有需要你处理的事。' },
  waitingElsewhen: { en: 'Still waiting: no date or not this week', zh: '仍在等待：没有日期或不在本周' },
  nothingHere: { en: 'Nothing here yet.', zh: '这里还没有内容。' },
  cards: { en: 'Waiting for your tap', zh: '等你点一下' },
  whoTakes: { en: "Who's taking this?", zh: '谁来负责？' },
  noOwner: { en: 'No owner yet', zh: '还没有负责人' },
  ownerNobody: { en: 'Nobody (an event can have only participants)', zh: '不指定（活动可以只有参与者）' },
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
  cardHeld: { en: 'On hold: a message it quotes changed.', zh: '已暂停：它引用的消息有变化。' },
  cardHeldShort: { en: 'On hold', zh: '已暂停' },
  staleMark: { en: 'Message changed', zh: '消息有变' },
  staleUnclear: { en: 'the edited message could not be read', zh: '修改后的消息读不懂' },
  staleChoiceGone: { en: 'no longer needed', zh: '已不需要' },
  recentCards: { en: 'Recently', zh: '最近' },
  cardExecuted: { en: 'done (simulated)', zh: '已完成（模拟）' },
  cardFailed: { en: 'did not go through', zh: '未能完成' },
  cardExpired: { en: 'expired: nobody tapped, so nothing happened', zh: '已过期：没有人确认，所以什么都没发生' },
  cardCancelled: { en: 'cancelled, nothing happened', zh: '已取消，什么都没发生' },
  cardReplaced: { en: 'replaced: the calendar changed', zh: '已替换：日程有变' },
  cardRuleOff: { en: 'withdrawn: the rule was turned off', zh: '已撤回：规则已关闭' },
  cardRuleChanged: { en: 'withdrawn: the rule was changed', zh: '已撤回：规则已修改' },
  ruleAhead: { en: 'card prepared {n} min before', zh: '提前 {n} 分钟准备卡片' },
  ruleTurnOff: { en: 'Turn off', zh: '关闭' },
  ruleTurnOn: { en: 'Turn on', zh: '开启' },
  rulePrepareNow: { en: 'Prepare the next card now (demo)', zh: '立即准备下一张卡片（演示）' },
  ruleParentsOnly: { en: 'Only a parent can turn a rule that spends money on or off.', zh: '只有家长可以开启或关闭会花钱的规则。' },
  ruleRuns: { en: 'What the rules did', zh: '规则做了什么' },
  runPrepared: { en: 'card prepared', zh: '已准备卡片' },
  runStopped: { en: 'stopped, no card', zh: '已停止，没有卡片' },
  runOverCap: { en: 'over the price cap', zh: '超过价格上限' },
  runClosed: { en: 'the shop is closed then', zh: '那时店铺不营业' },
  runNobody: { en: 'nobody is home then', zh: '那时家里没人' },
  runInvalid: { en: 'the order is not valid', zh: '订单无效' },
  runAtHome: { en: 'at home', zh: '人在家' },
  runAway: { en: 'away', zh: '不在家' },
  runSitter: { en: 'babysitter message drafted', zh: '已起草保姆消息' },
  runNoSitter: { en: 'no babysitter on the list is free', zh: '名单上的保姆都没空' },
  runSchedule: { en: 'on schedule', zh: '按时' },
  runCalendar: { en: 'after a calendar change', zh: '日程变化后' },
  runDemo: { en: 'demo control', zh: '演示控制' },
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

/**
 * Whether a live item is waiting for someone to take it. An event nobody was asked about (a wedding,
 * a class party) has participants, not an owner; only an important one (a child's pickup) needs one.
 * The same line reminders draw (`askFor` in server/homemind/reminders.ts). Tasks and preparations
 * always need someone.
 */
export function needsOwner(item: Item): boolean {
  if (item.status !== 'open') return false;
  const o = item.ownership;
  if (o.state === 'open') return true;
  return o.state === 'none' && (item.type !== 'event' || item.importance === 'critical');
}

/** An open event with nobody to own it and nobody asked: it shows who it is for instead. */
const participantsOnly = (item: Item) => item.status === 'open' && item.ownership.state === 'none' && !needsOwner(item);

const toneOf = (item: Item): TaskTone =>
  item.status === 'done' ? 'success' : item.status === 'proposed' ? 'accent' : item.importance === 'critical' ? 'danger' : item.ownership.state === 'assigned' || participantsOnly(item) ? 'muted' : 'warning';

function stateOf(item: Item): TaskState | '' {
  if (item.status === 'done') return 'done';
  if (item.status === 'proposed') return 'proposed';
  if (item.ownership.state === 'assigned') return item.ownership.confirmed ? 'confirmed' : 'assigned';
  return participantsOnly(item) ? '' : 'open';
}

function ownerLabelOf(item: Item, view: HomemindViewData, lang: HomemindLang): string {
  const o = item.ownership;
  if (participantsOnly(item)) return item.forMemberIds.map(id => (id === view.memberId ? hx(lang, 'you') : nameOf(memberOf(view.family, id), lang))).filter(Boolean).join(lang === 'zh' ? '、' : ', ');
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
function itemActions(item: Item, view: HomemindViewData, lang: HomemindLang, offerOwner = false): A2uiAction[] {
  const base = participantsOnly(item) && !offerOwner ? [] : boardActions(item, view, lang);
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

/** `offerOwner`: the item's own screen, where an event without an owner can still be given one. */
function taskRow(item: Item, view: HomemindViewData, lang: HomemindLang, today: string, offerOwner = false): TaskRow {
  const zone = view.family.timezone;
  const meta = [
    whenLabel(item, today, zone, lang),
    item.status === 'proposed' ? hx(lang, 'proposed') : '',
    item.importance === 'critical' && item.status !== 'done' ? hx(lang, 'critical') : '',
    item.visibility === 'parents' ? hx(lang, 'parentsOnly') : '',
    item.ownership.state === 'assigned' && item.status !== 'done' ? (item.ownership.confirmed ? hx(lang, 'confirmed') : hx(lang, 'notConfirmed')) : '',
    openNote(item, view, lang),
    staleNote(item, zone, lang),
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
    tone: item.stale ? 'warning' : toneOf(item),
    ...(item.source.simulated ? { simulated: true } : {}),
    actions: itemActions(item, view, lang, offerOwner),
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

const cardText = (card: ActionCard, key: 'title' | 'summary', lang: HomemindLang): string => {
  const p = card.payload;
  const zh = p[`${key}Zh`];
  if (lang === 'zh' && typeof zh === 'string') return zh;
  if (typeof p[key] === 'string') return p[key] as string;
  return key === 'title' ? (lang === 'zh' && card.titleZh ? card.titleZh : card.title ?? card.adapter) : '';
};

/** How a finished card ended, in a few words. A card Homemind withdrew keeps its reason. */
function cardEnd(card: ActionCard, lang: HomemindLang): string {
  if (card.status === 'executed') return hx(lang, 'cardExecuted');
  if (card.status === 'failed') return `${hx(lang, 'cardFailed')}${card.error ? `: ${card.error}` : ''}`;
  if (card.status === 'expired') return hx(lang, 'cardExpired');
  if (card.executedBy === 'homemind' && card.error?.startsWith('The calendar changed')) return hx(lang, 'cardReplaced');
  if (card.executedBy === 'homemind' && card.error?.startsWith('The rule was turned off')) return hx(lang, 'cardRuleOff');
  if (card.executedBy === 'homemind' && card.error?.startsWith('The rule changed')) return hx(lang, 'cardRuleChanged');
  return hx(lang, 'cardCancelled');
}

const RECENT_MS = 12 * 60 * 60 * 1000;

function pendingCards(view: HomemindViewData, lang: HomemindLang, now: string, confirmations: HomemindScreenData['confirmations'] = {}): { children: A2uiComponent[]; data: Record<string, unknown> } {
  const me = memberOf(view.family, view.memberId);
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  // Only a parent can confirm an action, so only a parent is shown the card.
  if (me?.role !== 'parent') return { children, data };
  for (const card of view.actionCards.filter(c => c.status === 'pending' && Date.parse(c.expiresAt) > Date.parse(now))) {
    const simulated = card.mode === 'simulated';
    const expires = dateParts(card.expiresAt, view.family.timezone);
    // T7.5: a held card quotes a message that changed. It shows why and offers no Confirm until a parent decides.
    const held = card.held ? `${hx(lang, 'cardHeld')}${lang === 'zh' ? '：' : ': '}${lang === 'zh' ? card.held.reasonZh : card.held.reason}` : '';
    data[card.id] = {
      title: cardText(card, 'title', lang),
      body: [cardText(card, 'summary', lang), held].filter(Boolean).join(' '),
      expires: expires ? `${hx(lang, 'expires')} ${expires.time}` : undefined,
      scope: held ? hx(lang, 'cardHeldShort') : hx(lang, 'statusPending'),
      simulated
    };
    // The token binds this card, its exact contents and this parent (T7.1). Without one the server refuses the tap.
    const token = Object.prototype.hasOwnProperty.call(confirmations, card.id) ? confirmations[card.id].token : undefined;
    children.push({
      id: `card-${card.id}`,
      component: 'ApprovalCard',
      dataPath: `/cards/${card.id}`,
      actions: [
        ...(card.held ? [] : [{ id: `homemind.confirm-card:${card.id}`, label: hx(lang, 'confirmCard'), variant: 'primary' as const, kind: 'homemind', args: { verb: 'confirm-card', cardId: card.id, ...(token ? { token } : {}) } }]),
        { id: `homemind.cancel-card:${card.id}`, label: hx(lang, 'cancelCard'), variant: 'ghost', kind: 'homemind', args: { verb: 'cancel-card', cardId: card.id } },
        { id: `homemind.why:${card.whyId}`, label: hx(lang, 'why'), variant: 'secondary', kind: 'homemind', args: { verb: 'why', whyId: card.whyId } }
      ]
    });
  }
  // T7.3: a card that ended in the last hours stays visible as one line, so an expired card is seen, not just gone.
  const nowMs = Date.parse(now);
  const recent = view.actionCards
    .filter(c => c.status !== 'pending' && c.status !== 'executing' && c.finishedAt && nowMs - Date.parse(c.finishedAt) < RECENT_MS)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    .slice(0, 4);
  if (recent.length) {
    const lines = recent.map(c => `- ${cardText(c, 'title', lang)}: ${cardEnd(c, lang)}${c.mode === 'simulated' ? ` (${hx(lang, 'simulated')})` : ''}`);
    children.push(text('cards-recent', `**${hx(lang, 'recentCards')}**\n\n${lines.join('\n')}`));
  }
  return { children, data: Object.keys(data).length ? { cards: data } : {} };
}

// --- screens ----------------------------------------------------------------------------------------

function myDay(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const weekEnd = addDaysToDate(today, 7);
  const dayOf = (item: Item) => (item.start ? dateParts(item.start, zone)?.date : undefined);
  // The last day an item covers: a wedding from Tuesday to Saturday is on each of those days. An end at
  // midnight belongs to the day before.
  const lastDayOf = (item: Item) => (item.end && Date.parse(item.end) > Date.parse(item.start ?? '') ? dateParts(new Date(Date.parse(item.end) - 1).toISOString(), zone)?.date : undefined) ?? dayOf(item);
  const me = memberOf(view.family, view.memberId);
  const childIds = new Set(view.family.members.filter(m => m.role === 'child').map(m => m.id));
  const mine = (item: Item) =>
    (item.ownership.state === 'assigned' && item.ownership.ownerId === view.memberId) ||
    item.forMemberIds.includes(view.memberId) ||
    // Not for anyone in particular: it is the whole family's.
    (item.forMemberIds.length === 0 && item.ownership.state === 'none') ||
    // A child has no screen of their own: their day is on the parents', until someone owns the item;
    // then it is on the owner's day.
    (me?.role === 'parent' && item.ownership.state !== 'assigned' && item.forMemberIds.some(id => childIds.has(id)));
  // Waiting for someone: to be approved, to be taken, or for this member's "I'm on it".
  const waiting = (item: Item) =>
    item.status === 'proposed' || needsOwner(item) || (item.ownership.state === 'assigned' && item.ownership.ownerId === view.memberId && !item.ownership.confirmed);
  const items = view.items.filter(live).filter(i => waiting(i) || mine(i)).sort(byStart);

  // By day, so Today is really today: what waits for someone sits on its own day, with its buttons.
  const todays = items.filter(i => { const d = dayOf(i); return d !== undefined && d <= today && (lastDayOf(i) ?? d) >= today; });
  const shown = new Set(todays.map(i => i.id));
  const later = items.filter(i => { const d = dayOf(i); return !shown.has(i.id) && d !== undefined && d > today && d <= weekEnd; });
  for (const i of later) shown.add(i.id);
  // Still waiting with no date, from an earlier day, or after this week: listed last, never lost.
  const elsewhen = items.filter(i => !shown.has(i.id) && waiting(i));

  const cards = pendingCards(view, lang, input.now, input.confirmations);
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = { ...cards.data };
  // T8.1: a day gone wrong comes first: it changes what the rest of the day looks like.
  for (const s of input.situations ?? []) situationBlocks(s, view, lang, today, children, data);
  if (cards.data.cards) children.push(text('cards-title', `**${hx(lang, 'cards')}**`));
  children.push(...cards.children);
  sourceChangeBlocks(input, children, data);
  if (input.groups) groupClaimBlocks(input, 'my-day', children, data);
  heldMessagesBlock(input, children);
  section(children, data, 'today', hx(lang, 'today'), todays.map(i => taskRow(i, view, lang, today)), hx(lang, 'nothingToday'));
  section(children, data, 'later', hx(lang, 'comingUp'), later.map(i => taskRow(i, view, lang, today)));
  section(children, data, 'waiting', hx(lang, 'waitingElsewhen'), elsewhen.map(i => taskRow(i, view, lang, today)));
  children.push({ id: 'actions', component: 'ActionBar', actions: [{ id: 'homemind.add', label: hx(lang, 'add'), variant: 'secondary', kind: 'homemind', args: { verb: 'add' } }] });
  return turn('my-day', hx(lang, 'myDay'), nameOf(memberOf(view.family, view.memberId), lang), children, data);
}

function familyScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const items = view.items.filter(live).sort(byStart);
  const open = items.filter(needsOwner);
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

function runLine(run: RuleRun, view: HomemindViewData, lang: HomemindLang): string {
  const rule = view.rules.find(r => r.id === run.ruleId);
  const name = rule ? (lang === 'zh' && rule.titleZh ? rule.titleZh : rule.title) : run.ruleId;
  const when = dateParts(run.occurrence, view.family.timezone);
  const reasons: Record<string, keyof typeof T> = { over_cap: 'runOverCap', closed: 'runClosed', nobody_home: 'runNobody', invalid: 'runInvalid' };
  const outcome = run.outcome === 'prepared' ? hx(lang, 'runPrepared') : `${hx(lang, 'runStopped')}: ${hx(lang, reasons[run.reason ?? 'invalid'])}`;
  const away = run.away.map(a => nameOf(memberOf(view.family, a.memberId), lang)).filter(Boolean);
  const people = `${run.home.length} ${hx(lang, 'runAtHome')}${away.length ? ` (${away.join(lang === 'zh' ? '、' : ', ')} ${hx(lang, 'runAway')})` : ''}`;
  const money = run.total !== undefined ? `${run.total} ${run.currency ?? ''}`.trim() : '';
  const sitter = run.sitter === 'drafted' ? hx(lang, 'runSitter') : run.sitter === 'none_free' ? hx(lang, 'runNoSitter') : '';
  const trigger = hx(lang, run.trigger === 'calendar' ? 'runCalendar' : run.trigger === 'demo' ? 'runDemo' : 'runSchedule');
  const day = when ? `${when.date.slice(5)} ${when.time}` : run.date;
  return [`${name} · ${day}`, outcome, people, money, sitter, trigger].filter(Boolean).join(' · ');
}

/** T9.1: words of the rule details screen. */
const R = {
  details: { en: 'About this rule', zh: '规则详情' },
  status: { en: 'Status', zh: '状态' },
  paused: { en: 'Paused: automatic actions are stopped in Settings', zh: '已暂停：设置里停止了自动操作' },
  trigger: { en: 'When', zh: '时间' },
  every: { en: 'Every {day} at {time}', zh: '每{day} {time}' },
  what: { en: 'What it prepares', zh: '准备什么' },
  order: { en: 'An order from the simulated pizza shop, usually {total} {cur}. The size follows who is home.', zh: '向模拟披萨店下单，平时 {total} {cur}。份量按在家人数调整。' },
  limits: { en: 'Limits', zh: '限制' },
  cap: { en: 'Price cap {cap} {cur}. Over it, no card is prepared.', zh: '价格上限 {cap} {cur}。超过就不准备卡片。' },
  noCap: { en: 'No price cap', zh: '没有价格上限' },
  area: { en: 'Area', zh: '领域' },
  areas: { food: { en: 'Food', zh: '饮食' } } as Record<string, { en: string; zh: string }>,
  setBy: { en: 'Set by', zh: '设置人' },
  lastRun: { en: 'Last run', zh: '上次运行' },
  never: { en: 'Not run yet', zh: '还没有运行过' },
  nextRun: { en: 'Next run', zh: '下次运行' },
  nextAt: { en: '{when}: the card is prepared at {prep} and waits for a parent’s tap', zh: '{when}：{prep} 准备卡片，等家长点一下' },
  noNext: { en: 'None while the rule is off', zh: '规则关闭时不会运行' },
  noNextPaused: { en: 'None while automatic actions are paused', zh: '自动操作暂停时不会运行' },
  why: { en: 'Why? (the last run)', zh: '为什么？（上次运行）' },
  whySource: { en: 'Source: a Homemind rule, not PPMA', zh: '来源：Homemind 规则，不是 PPMA' },
  edit: { en: 'Change the rule', zh: '修改规则' },
  editNote: { en: 'A card that waits is withdrawn and prepared again from the new rule, so a tap always runs what is shown.', zh: '正在等待的卡片会撤回，并按新规则重新准备，确保点一下执行的就是显示的内容。' },
  capField: { en: 'Price cap ({cur})', zh: '价格上限（{cur}）' },
  timeField: { en: 'Delivery time', zh: '送达时间' },
  save: { en: 'Save changes', zh: '保存修改' },
  delete: { en: 'Delete rule', zh: '删除规则' },
  open: { en: 'Details', zh: '详情' },
  gone: { en: 'This rule is not here any more. It may have been deleted (Undo is on the notice or in Activity).', zh: '这条规则已经不在了，可能已被删除（可以在通知上撤销）。' }
} as const;
const rx = (lang: HomemindLang, key: Exclude<keyof typeof R, 'areas'>, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce<string>((s, [k, v]) => s.split(`{${k}}`).join(String(v)), R[key][lang]);

/** T9.1: one rule, opened from the Rules list: trigger, limits, area, on or off, last and next run, Why, and a parent's edits. */
function ruleDetail(input: HomemindScreenData, ruleId: string): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const isParent = memberOf(view.family, view.memberId)?.role === 'parent';
  const back: A2uiAction = { id: 'homemind.back', label: hx(lang, 'back'), variant: 'ghost', kind: 'homemind', args: { verb: 'back' } };
  const rule = view.rules.find(r => r.id === ruleId);
  if (!rule) return turn('rules', hx(lang, 'rules'), undefined, [{ id: 'gone', component: 'ErrorNotice', title: hx(lang, 'rules'), body: rx(lang, 'gone') }, { id: 'actions', component: 'ActionBar', actions: [back] }], {});
  const cur = rule.limits.currency ?? (typeof rule.actionTemplate.payload.currency === 'string' ? rule.actionTemplate.payload.currency : 'CNY');
  const total = typeof rule.actionTemplate.payload.total === 'number' ? rule.actionTemplate.payload.total : '?';
  const runs = (view.ruleRuns ?? []).filter(r => r.ruleId === rule.id);
  const last = runs[runs.length - 1];
  const at = (iso: string) => {
    const p = dateParts(iso, zone);
    return p ? `${WEEKDAYS[lang][p.weekday]} ${p.date.slice(5)} ${p.time}` : iso;
  };
  const next = input.ruleNext;
  const author = nameOf(memberOf(view.family, rule.createdBy), lang) || rule.createdBy;
  const area = R.areas[rule.area]?.[lang] ?? rule.area;
  const rows = [
    { label: rx(lang, 'status'), value: rule.enabled ? (view.family.paused ? `${hx(lang, 'ruleOn')} · ${rx(lang, 'paused')}` : hx(lang, 'ruleOn')) : hx(lang, 'ruleOff'), tone: rule.enabled && !view.family.paused ? 'accent' : 'muted' },
    { label: rx(lang, 'trigger'), value: `${rx(lang, 'every', { day: WEEKDAYS[lang][rule.trigger.weekday] ?? '', time: rule.trigger.time })} · ${hx(lang, 'ruleAhead').replace('{n}', String(rule.trigger.leadMinutes))}`, tone: 'muted' },
    { label: rx(lang, 'what'), value: `${rx(lang, 'order', { total, cur })} (${hx(lang, 'simulated')})`, tone: 'muted' },
    { label: rx(lang, 'limits'), value: rule.limits.maxPrice !== undefined ? rx(lang, 'cap', { cap: rule.limits.maxPrice, cur }) : rx(lang, 'noCap'), tone: 'muted' },
    { label: rx(lang, 'area'), value: area, tone: 'muted' },
    { label: rx(lang, 'setBy'), value: author, tone: 'muted' },
    { label: rx(lang, 'lastRun'), value: last ? `${runLine(last, view, lang)} (${at(last.at)})` : rx(lang, 'never'), tone: 'muted' },
    { label: rx(lang, 'nextRun'), value: next ? rx(lang, 'nextAt', { when: at(next.at), prep: at(next.prepareAt).split(' ').pop() ?? '' }) : rx(lang, !rule.enabled ? 'noNext' : 'noNextPaused'), tone: 'muted' }
  ];
  const children: A2uiComponent[] = [text('note', hx(lang, 'rulesNote')), { id: 'details', component: 'InfoRows', title: rx(lang, 'details'), dataPath: '/details' }];
  const data: Record<string, unknown> = { details: rows };
  const why = last ? view.whys.find(w => w.id === last.whyId) : undefined;
  if (why) {
    children.push({ id: 'why', component: 'InfoRows', title: rx(lang, 'why'), dataPath: '/why' });
    data.why = [
      { label: hx(lang, 'why'), value: (lang === 'zh' && why.summaryZh ? why.summaryZh : why.summary) ?? '', tone: 'muted' },
      { label: hx(lang, 'simulated'), value: rx(lang, 'whySource'), tone: 'muted' }
    ];
  }
  const actions: A2uiAction[] = [];
  if (isParent) {
    const field = (name: string, label: string, value: string, extra: Record<string, unknown>): A2uiComponent => ({ id: `f-${name}`, component: 'TextField', name, label, default: value, ...extra });
    children.push(text('edit-title', `**${rx(lang, 'edit')}**\n\n${rx(lang, 'editNote')}`));
    children.push(field('ruleMaxPrice', rx(lang, 'capField', { cur }), rule.limits.maxPrice !== undefined ? String(rule.limits.maxPrice) : '', { maxLength: 4 }));
    children.push(field('ruleTime', rx(lang, 'timeField'), rule.trigger.time, { inputType: 'time' }));
    actions.push(
      { id: `homemind.save-rule:${rule.id}`, label: rx(lang, 'save'), variant: 'primary', kind: 'homemind', args: { verb: 'save-rule', ruleId: rule.id } },
      { id: `homemind.rule-toggle:${rule.id}`, label: hx(lang, rule.enabled ? 'ruleTurnOff' : 'ruleTurnOn'), variant: 'secondary', kind: 'homemind', args: { verb: 'rule-toggle', ruleId: rule.id, action: rule.enabled ? 'disable' : 'enable' } },
      { id: `homemind.rule-delete:${rule.id}`, label: rx(lang, 'delete'), variant: 'secondary', kind: 'homemind', args: { verb: 'rule-delete', ruleId: rule.id } }
    );
  } else children.push(text('rules-parents', hx(lang, 'ruleParentsOnly')));
  actions.push(back);
  children.push({ id: 'actions', component: 'ActionBar', actions });
  return turn('rules', lang === 'zh' && rule.titleZh ? rule.titleZh : rule.title, undefined, children, data);
}

function rulesScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  if (input.ruleId) return ruleDetail(input, input.ruleId);
  const me = memberOf(view.family, view.memberId);
  const isParent = me?.role === 'parent';
  const rows: TaskRow[] = view.rules.map(rule => {
    const cap = rule.limits.maxPrice !== undefined ? `${hx(lang, 'ruleCap')} ${rule.limits.maxPrice} ${rule.limits.currency ?? ''}`.trim() : '';
    const when = `${WEEKDAYS[lang][rule.trigger.weekday] ?? ''} ${rule.trigger.time}`;
    const ahead = hx(lang, 'ruleAhead').replace('{n}', String(rule.trigger.leadMinutes));
    const actions: A2uiAction[] = [];
    if (isParent) {
      actions.push({ id: `homemind.rule-toggle:${rule.id}`, label: hx(lang, rule.enabled ? 'ruleTurnOff' : 'ruleTurnOn'), variant: 'secondary', kind: 'homemind', args: { verb: 'rule-toggle', ruleId: rule.id, action: rule.enabled ? 'disable' : 'enable' } });
      if (input.demo && rule.enabled) actions.push({ id: `homemind.run-rule:${rule.id}`, label: hx(lang, 'rulePrepareNow'), variant: 'ghost', kind: 'homemind', args: { verb: 'run-rule', ruleId: rule.id } });
    }
    return {
      id: rule.id,
      title: lang === 'zh' && rule.titleZh ? rule.titleZh : rule.title,
      meta: [when, ahead, cap, hx(lang, 'simulated')].filter(Boolean).join(' · '),
      ownerLabel: '',
      state: '',
      tone: rule.enabled ? 'accent' : 'muted',
      // The rule acts only on a simulated service, and the badge says so on the row.
      simulated: true,
      actions,
      // T9.1: tapping the rule opens its details (trigger, limits, last and next run, Why, edits).
      open: { id: `homemind.open-rule:${rule.id}`, label: rx(lang, 'open'), kind: 'homemind', args: { verb: 'open-rule', ruleId: rule.id } }
    };
  });
  const children: A2uiComponent[] = [text('note', hx(lang, 'rulesNote'))];
  const data: Record<string, unknown> = {};
  if (rows.length) {
    // The state is in the row's meta line too, for screen readers and for a teen who has no buttons.
    data.rules = rows.map(r => ({ ...r, meta: `${view.rules.find(x => x.id === r.id)?.enabled ? hx(lang, 'ruleOn') : hx(lang, 'ruleOff')} · ${r.meta}` }));
    children.push(taskList('rules', hx(lang, 'rules'), '/rules'));
  }
  if (!isParent) children.push(text('rules-parents', hx(lang, 'ruleParentsOnly')));
  const runs = [...(view.ruleRuns ?? [])].reverse().slice(0, 8);
  if (runs.length) {
    children.push({ id: 'runs', component: 'List', title: hx(lang, 'ruleRuns'), dataPath: '/runs' });
    data.runs = runs.map(run => ({ title: runLine(run, view, lang), subtitle: hx(lang, 'simulated') }));
  }
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
  correct: { en: 'Edit', zh: '编辑' },
  correctTitle: { en: 'Correct a saved preference', zh: '更正一条已保存的偏好' },
  correctNote: {
    en: 'Write it the way it is true now. The next suggestions use the corrected words; the old ones are kept in Activity for Undo.',
    zh: '按现在的实际情况写。之后的建议会用更正后的内容；原来的内容记在“动态”里，可以撤销。'
  },
  correctText: { en: 'What Homemind should remember', zh: 'Homemind 应该记住的内容' },
  correctReason: { en: 'Why (optional)', zh: '原因（可不填）' },
  correctSave: { en: 'Save the correction', zh: '保存更正' },
  correctCancel: { en: 'Cancel', zh: '取消' },
  correctGone: { en: 'That preference is no longer saved.', zh: '这条偏好已经不在了。' },
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
  // T8.2 (Scene 5): correct one saved preference. A soft one by anyone with an account, a hard one by a parent.
  if (input.correctPreferenceId) {
    const p = view.preferences.find(x => x.id === input.correctPreferenceId);
    if (!p || (p.strength === 'hard' && !isParent)) {
      children.push(text('correct-gone', M.correctGone[lang]));
    } else {
      const field = (name: string, label: string, value: string): A2uiComponent => ({ id: `f-${name}`, component: 'TextField', name, label, default: value, maxLength: 200 });
      children.push(text('correct-title', `**${M.correctTitle[lang]}**\n\n${M.correctNote[lang]}`));
      children.push(field('prefText', M.correctText[lang], lang === 'zh' && p.textZh ? p.textZh : p.text));
      children.push(field('prefReason', M.correctReason[lang], (lang === 'zh' && p.reasonZh ? p.reasonZh : p.reason) ?? ''));
      children.push({
        id: 'correct-actions',
        component: 'ActionBar',
        actions: [
          { id: `homemind.correct-preference:${p.id}`, label: M.correctSave[lang], variant: 'primary', kind: 'homemind', args: { verb: 'correct-preference', preferenceId: p.id, strength: p.strength, ...(p.aboutMemberId ? { aboutMemberId: p.aboutMemberId } : {}), ...(p.scope ? { scope: p.scope } : {}) } },
          { id: 'homemind.back', label: M.correctCancel[lang], variant: 'ghost', kind: 'homemind', args: { verb: 'back' } }
        ]
      });
    }
    return turn('memory', hx(lang, 'memory'), undefined, children, data);
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
          ? [
              // T8.2: correct it in a small form (Scene 5); the next suggestions use the new words.
              { id: `homemind.open-correct-preference:${p.id}`, label: M.correct[lang], variant: 'secondary', kind: 'homemind', args: { verb: 'open-correct-preference', preferenceId: p.id } } as A2uiAction,
              { id: `homemind.remove-preference:${p.id}`, label: M.remove[lang], variant: 'ghost', kind: 'homemind', args: { verb: 'remove-preference', preferenceId: p.id } } as A2uiAction
            ]
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
  // A rule's own Activity says "Rule <id> ..."; a group's claim setting does not.
  if (a.kind === 'rule' && !a.what.startsWith('Rule ') && /^(enabled|disabled|auto|ask)(,|$)/.test(a.note ?? '')) {
    // T7.4: a group's claim setting. `ref` is the group id.
    const words: Record<string, [string, string]> = {
      enabled: ['turned on sign-up claims in the group', '开启了群接龙认领'],
      disabled: ['turned off sign-up claims in the group', '关闭了群接龙认领'],
      auto: ['let Homemind post claims on its own (level 4)', '允许 Homemind 自动发送认领（等级 4）'],
      ask: ['asked to tap each claim first', '设置为每次认领前先确认']
    };
    const parts = (a.note ?? '').split(',').map(n => words[n]).filter(Boolean).map(w => (lang === 'zh' ? w[1] : w[0]));
    return `${who} ${parts.join(lang === 'zh' ? '，' : ', ')} (${hx(lang, 'simulated')})`;
  }
  if (a.kind === 'rule') {
    // A deleted rule is named from the Activity that kept it for Undo.
    const rule = view.rules.find(r => r.id === a.ref) ?? view.activity.find(x => x.ruleUndo?.id === a.ref)?.ruleUndo;
    const what = rule ? `“${lang === 'zh' && rule.titleZh ? rule.titleZh : rule.title}”` : '';
    const words: Record<string, [string, string]> = {
      created: ['created the rule', '创建了规则'],
      enabled: ['turned on the rule', '开启了规则'],
      disabled: ['turned off the rule', '关闭了规则'],
      changed: ['changed the rule', '修改了规则'],
      deleted: ['deleted the rule', '删除了规则'],
      restored: ['put back the rule', '恢复了规则']
    };
    const w = words[a.note ?? ''] ?? words.enabled;
    return lang === 'zh' ? `${who} ${w[1]} ${what}`.trim() : `${who} ${w[0]} ${what}`.trim();
  }
  if (a.kind === 'source') {
    // T7.5: items marked or decided because a message they came from changed.
    const actor = a.actor === 'homemind' ? 'Homemind' : who;
    const words: Record<string, [string, string]> = {
      marked: ['flagged items whose message changed', '标记了消息有变的事项'],
      applied: ['applied a changed message', '应用了消息的更改'],
      kept: ['kept items as they were after a message changed', '在消息变化后保持了原样'],
      discarded: ['discarded items after a message changed', '在消息变化后舍弃了相关事项'],
      synced: ['updated where items came from', '更新了事项的来源']
    };
    const w = words[a.note ?? ''] ?? words.marked;
    return `${actor} ${lang === 'zh' ? w[1] : w[0]} (${hx(lang, 'simulated')})`;
  }
  if (a.kind === 'action') {
    // T7.1/T7.3: an action card's outcome. Homemind itself expires or replaces cards.
    const card = view.actionCards.find(c => c.id === a.ref);
    const actor = a.actor === 'homemind' ? 'Homemind' : who;
    const what = card ? `“${cardText(card, 'title', lang)}”` : '';
    const words: Record<string, [string, string]> = { executed: ['confirmed', '确认了'], failed: ['tried', '尝试了'], cancelled: ['cancelled', '取消了'], expired: ['let expire', '让其过期：'] };
    const w = words[a.note ?? ''] ?? words.cancelled;
    const sim = card?.mode === 'simulated' ? ` (${hx(lang, 'simulated')})` : '';
    return (lang === 'zh' ? `${actor} ${w[1]} ${what}${sim}` : `${actor} ${w[0]} ${what}${sim}`).trim();
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
    const row: TaskRow = taskRow(item, view, lang, today, true);
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
      options: [{ value: 'none', label: hx(lang, 'ownerNobody') }, ...owners.map(m => ({ value: m.id, label: m.id === me.id ? `${nameOf(m, lang)} (${hx(lang, 'you')})` : nameOf(m, lang) }))]
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
  const row: TaskRow = taskRow(item, view, lang, today, true);
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
      intent: 'create_event' | 'create_task' | 'add_preparation' | 'assign' | 'claim' | 'mark_done' | 'update_item' | 'split_item' | 'delete_item';
      itemId: string;
      /** A split: the new parts beside `itemId`. */
      alsoIds?: string[];
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
  /** An edit or a split at level 1, or paused: nothing changed. */
  | { kind: 'held'; intent: 'update_item' | 'split_item' | 'delete_item'; itemId: string; reason: 'level1' | 'paused' }
  | { kind: 'later'; intent: 'create_rule' | 'report_situation' }
  /** T8.1: someone is sick. `created: false`: that member and day were already reported (the same card again). */
  | { kind: 'situation'; situationId: string; created: boolean; activityId?: string }
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
  /** T8.1: the member's situations (server-filtered), for a `situation` outcome. */
  situations?: SituationView[];
}

const C = {
  added: { en: 'Added to the board:', zh: '已添加到家庭看板：' },
  proposedAdd: { en: 'Suggested for the board, waiting for approval:', zh: '已作为建议放到看板上，等待批准：' },
  assigned: { en: (t: string, who: string) => `Assigned “${t}” to ${who}. ${who} still needs to confirm.`, zh: (t: string, who: string) => `已把“${t}”分配给${who}，还需要${who}确认。` },
  claimed: { en: (t: string) => `“${t}” is yours now.`, zh: (t: string) => `“${t}”现在由你负责。` },
  doneMsg: { en: (t: string) => `Marked done: “${t}”.`, zh: (t: string) => `已标记完成：“${t}”。` },
  updated: { en: (t: string) => `Updated: “${t}”.`, zh: (t: string) => `已更新：“${t}”。` },
  removed: { en: (t: string) => `Removed from the board: “${t}”.`, zh: (t: string) => `已从看板移除：“${t}”。` },
  removedPreps: { en: (n: number) => `Its ${n} preparation(s) were removed with it.`, zh: (n: number) => `它的 ${n} 项准备也一起移除了。` },
  noOwnerHint: { en: 'Nobody has it yet, so nobody will be reminded. Take it or assign it.', zh: '目前还没有人负责，所以不会有人收到提醒。请认领或指派。' },
  splitMsg: { en: (titles: string[]) => `Split into ${titles.length}: ${titles.map(t => `“${t}”`).join(', ')}.`, zh: (titles: string[]) => `已拆分为 ${titles.length} 项：${titles.map(t => `“${t}”`).join('、')}。` },
  heldLevel1: { en: 'Autonomy is set to “Suggests”, so nothing was changed. You can edit it on the board:', zh: '自主程度设为“仅建议”，所以没有做任何更改。你可以在看板上修改：' },
  heldPaused: { en: 'Automatic actions are paused, so nothing was changed. You can edit it on the board:', zh: '自动操作已暂停，所以没有做任何更改。你可以在看板上修改：' },
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
  laterSituation: { en: 'Only “someone is sick” is built for planning around a situation. Nothing was changed.', zh: '目前只支持“有人生病”的情况重新安排，没有做任何更改。' },
  sitCreated: { en: 'Sorry to hear that. Here is what changes today and what I suggest. Nothing is cancelled or moved until someone taps.', zh: '听到这个消息很遗憾。下面是今天受影响的安排和建议。有人点按之前，不会取消或移动任何事项。' },
  sitAgain: { en: 'This was already reported. Here is where it stands.', zh: '这件事已经报告过了，下面是目前的情况。' },
  sitTaskUndo: { en: 'Undo the stay-home task', zh: '撤销“在家照顾”任务' },
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
  ppma: ['Suggested by PPMA', '由 PPMA 建议'],
  shopping: ['From the shopping list', '来自购物清单']
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
      else if (outcome.intent === 'update_item') parts.push(C.updated[lang](t));
      else if (outcome.intent === 'delete_item') {
        parts.push(C.removed[lang](t));
        const preps = view.items.filter(i => i.parentEventId === outcome.itemId && i.status === 'cancelled' && (outcome.alsoIds ?? []).includes(i.id)).length;
        if (preps) parts.push(C.removedPreps[lang](preps));
      }
      else if (outcome.intent === 'split_item') parts.push(C.splitMsg[lang]([t, ...(outcome.alsoIds ?? []).map(titleById)].filter(Boolean)));
      else parts.push(`${outcome.proposed ? C.proposedAdd[lang] : C.added[lang]} “${t}”`);
      if (outcome.opened.length) parts.push(C.opened[lang](outcome.opened.length));
      else if (outcome.conflicts) parts.push(C.conflicts[lang](outcome.conflicts));
      // An edit or a split often sets a time "for a reminder": say plainly when no one would get one.
      if ((outcome.intent === 'update_item' || outcome.intent === 'split_item') && [outcome.itemId, ...(outcome.alsoIds ?? [])].some(id => view.items.some(i => i.id === id && i.type !== 'event' && i.ownership.state === 'none'))) {
        parts.push(C.noOwnerHint[lang]);
      }
      if (outcome.activityId) parts.push(C.undoHint[lang]);
      message = parts.join(' ');
      const rows = rowsFor([outcome.itemId, ...(outcome.alsoIds ?? []), ...outcome.opened]);
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
    case 'held': {
      message = outcome.reason === 'paused' ? C.heldPaused[lang] : C.heldLevel1[lang];
      const rows = rowsFor([outcome.itemId]);
      if (rows.length) {
        children.push(taskList('rows', hx(lang, 'thisItem'), '/rows'));
        data.rows = rows;
        title = titleById(outcome.itemId) || title;
      } else {
        message = C.missing[lang];
      }
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
    case 'situation': {
      const v = (input.situations ?? []).find(x => x.situation.id === outcome.situationId);
      message = outcome.created ? C.sitCreated[lang] : C.sitAgain[lang];
      if (v) {
        situationBlocks(v, view, lang, today, children, data);
        title = situationHeadline(v, view, lang, today);
      }
      if (outcome.activityId && v?.situation.stayHomeItemId) {
        children.push({
          id: 'actions-undo',
          component: 'ActionBar',
          actions: [{ id: `homemind.undo:${outcome.activityId}`, label: C.sitTaskUndo[lang], variant: 'ghost', kind: 'homemind', args: { verb: 'undo', activityId: outcome.activityId, itemId: v.situation.stayHomeItemId } }]
        });
      }
      break;
    }
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

// --- simulated services (T7.2) ---------------------------------------------------------------------

const S = {
  services: { en: 'Services', zh: '服务' },
  servicesNote: {
    en: 'These services are **simulated** for the demo. Nothing is sent, bought or ordered for real. Anything that would act still needs a parent to tap its own card.',
    zh: '这些服务均为**模拟**，仅用于演示。不会真的发送、购买或下单。任何操作仍需家长在对应卡片上亲自点按。'
  },
  group: { en: 'Kindergarten group', zh: '幼儿园群' },
  groupEmpty: { en: 'No messages yet.', zh: '还没有消息。' },
  postNext: { en: 'Post next group message (demo)', zh: '发送下一条群消息（演示）' },
  updateMessage: { en: 'Update message (demo)', zh: '修改群消息（演示）' },
  edited: { en: 'edited', zh: '已修改' },
  fromFamily: { en: 'posted by Homemind', zh: '由 Homemind 发送' },
  claim: { en: 'claim', zh: '认领' },
  correction: { en: 'correction', zh: '更正' },
  pizzaOpen: { en: 'Open now', zh: '营业中' },
  pizzaClosed: { en: 'Closed now', zh: '现在休息' },
  hours: { en: 'Hours', zh: '营业时间' },
  serves: { en: 'serves', zh: '份量：' },
  people: { en: '', zh: '人' },
  lastOrder: { en: 'Last order (simulated)', zh: '最近订单（模拟）' },
  deliveryAt: { en: 'delivery', zh: '送达' },
  sitters: { en: "Babysitters, in the family's order", zh: '保姆（按家庭排序）' },
  teacher: { en: 'Messages to the class teacher', zh: '发给班主任的消息' },
  freeToday: { en: 'Free today', zh: '今天有空' },
  notToday: { en: 'Not free today', zh: '今天没空' },
  inbox: { en: 'Inbox (approved senders only)', zh: '收件箱（仅白名单发件人）' },
  inboxAdd: { en: 'Add to my board', zh: '加到我的看板' },
  inboxAdded: { en: 'On your board', zh: '已在你的看板上' },
  inboxEmpty: { en: 'No messages from approved senders in your mailbox.', zh: '你的邮箱里没有白名单发件人的邮件。' },
  weather: { en: 'Weather', zh: '天气' },
  todayW: { en: 'Today', zh: '今天' },
  tomorrowW: { en: 'Tomorrow', zh: '明天' },
  rain: { en: 'rain', zh: '降雨概率' }
} as const;
const sx = (lang: HomemindLang, key: keyof typeof S): string => S[key][lang];

/**
 * The simulated services, one card each: the kindergarten group (with the demo control), the pizza shop,
 * babysitters, the member's own inbox and the weather. Every row carries `simulated: true`, so each card
 * shows the "Simulated / 模拟" badge, and an empty card says the word in its text.
 */
function servicesScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const sim = hx(lang, 'simulated');
  const children: A2uiComponent[] = [text('note', sx(lang, 'servicesNote'))];
  const data: Record<string, unknown> = {};
  const services = input.services;
  if (!services) {
    children.push(text('empty', hx(lang, 'nothingHere')));
    return turn('services', sx(lang, 'services'), sim, children, data);
  }
  const timeOf = (iso: string) => {
    const parts = dateParts(iso, zone);
    if (!parts) return '';
    return parts.date === today ? parts.time : `${parts.date.slice(5).replace('-', '/')} ${parts.time}`;
  };
  const list = (id: string, title: string, rows: Array<{ title: string; subtitle: string; meta: string }>) => {
    children.push({ id, component: 'List', title, dataPath: `/${id}` });
    data[id] = rows.map(row => ({ ...row, simulated: true }));
  };

  const group = services.group;
  const groupTitle = `${sx(lang, 'group')} · ${lang === 'zh' ? group.nameZh : group.name}`;
  if (group.messages.length) {
    list(
      'group',
      groupTitle,
      group.messages.map(m => ({
        title: lang === 'zh' ? m.authorZh ?? m.author : m.author,
        subtitle: m.text,
        meta: [
          timeOf(m.at),
          m.editedAt ? `${sx(lang, 'edited')} ${timeOf(m.editedAt)}` : '',
          m.from === 'family' ? sx(lang, 'fromFamily') : '',
          m.replyKind ? sx(lang, m.replyKind) : '',
          // T8.2: how soon Homemind showed it, and why (parents only). The first version's judgment.
          judgmentLine(input.judgments?.find(j => j.messageId === m.id), zone, lang)
        ]
          .filter(Boolean)
          .join(' · ')
      }))
    );
  } else children.push(text('group-empty', `**${groupTitle}** · ${sim}\n\n${sx(lang, 'groupEmpty')}`));
  const demoActions: A2uiAction[] = [];
  if (input.demo && group.remaining > 0) demoActions.push({ id: 'homemind.post-group-message', label: `${sx(lang, 'postNext')} (${group.remaining})`, variant: 'secondary', kind: 'homemind', args: { verb: 'post-group-message' } });
  // T7.5: the senders edit their messages (once the party message and the sign-up are there).
  if (input.demo && (group.updates ?? 0) > 0 && group.messages.some(m => m.id === 'grp-msg-2')) {
    demoActions.push({ id: 'homemind.update-group-message', label: sx(lang, 'updateMessage'), variant: 'secondary', kind: 'homemind', args: { verb: 'update-group-message' } });
  }
  if (demoActions.length) children.push({ id: 'group-demo', component: 'ActionBar', actions: demoActions });
  sourceChangeBlocks(input, children, data);
  if (input.groups) groupClaimBlocks(input, 'services', children, data);

  const pizza = services.pizza;
  const status = pizza.open ? sx(lang, 'pizzaOpen') : sx(lang, 'pizzaClosed');
  list(
    'pizza',
    `${lang === 'zh' ? pizza.nameZh : pizza.name} · ${status} · ${sx(lang, 'hours')} ${pizza.opensAt}–${pizza.closesAt}`,
    pizza.menu.map(d => ({
      title: lang === 'zh' ? d.nameZh : d.name,
      subtitle: lang === 'zh' ? `${sx(lang, 'serves')}${d.serves}${sx(lang, 'people')}` : `${sx(lang, 'serves')} ${d.serves}`,
      meta: `${d.price} ${pizza.currency}`
    }))
  );
  if (pizza.lastOrder) {
    const o = pizza.lastOrder;
    list('pizza-order', sx(lang, 'lastOrder'), [
      { title: o.id, subtitle: o.deliverAt ? `${sx(lang, 'deliveryAt')} ${timeOf(o.deliverAt)}` : '', meta: `${o.total} ${o.currency}` }
    ]);
  }

  list(
    'sitters',
    sx(lang, 'sitters'),
    services.babysitters.sitters.map(s => ({
      title: `${s.rank}. ${lang === 'zh' ? s.nameZh : s.name}`,
      subtitle: lang === 'zh' ? s.noteZh : s.note,
      meta: s.available ? `${sx(lang, 'freeToday')} ${s.from}–${s.to}` : sx(lang, 'notToday')
    }))
  );

  // T8.1: messages the family sent the (simulated) class teacher, each after a parent's tap, with her canned answer.
  if (services.teacher?.messages.length) {
    const teacherName = lang === 'zh' ? services.teacher.nameZh : services.teacher.name;
    list(
      'teacher',
      `${sx(lang, 'teacher')} · ${teacherName}`,
      services.teacher.messages.map(m => ({
        title: m.text,
        subtitle: `${teacherName}: ${lang === 'zh' ? m.reply : m.replyEn}`,
        meta: timeOf(m.at)
      }))
    );
  }

  if (services.inbox.messages.length) {
    list(
      'inbox',
      sx(lang, 'inbox'),
      services.inbox.messages.map(m => ({
        title: lang === 'zh' ? m.subjectZh : m.subject,
        subtitle: `${lang === 'zh' ? m.fromNameZh : m.fromName} · ${lang === 'zh' ? m.bodyZh : m.body}`,
        meta: [timeOf(m.at), m.added ? sx(lang, 'inboxAdded') : ''].filter(Boolean).join(' · ')
      }))
    );
    // T8.3: one button per mail not on the board yet; the item is private to the mailbox owners until approved.
    const addable = services.inbox.messages.filter(m => !m.added);
    if (addable.length) {
      children.push({
        id: 'inbox-actions',
        component: 'ActionBar',
        actions: addable.map(m => ({
          id: `homemind.inbox-add-${m.id}`,
          label: `${sx(lang, 'inboxAdd')}: ${lang === 'zh' ? m.subjectZh : m.subject}`,
          variant: 'secondary' as const,
          kind: 'homemind' as const,
          args: { verb: 'inbox-add', mailId: m.id }
        }))
      });
    }
  } else children.push(text('inbox-empty', `**${sx(lang, 'inbox')}** · ${sim}\n\n${sx(lang, 'inboxEmpty')}`));

  list(
    'weather',
    sx(lang, 'weather'),
    services.weather.days.map((d, i) => ({
      title: i === 0 ? sx(lang, 'todayW') : i === 1 ? sx(lang, 'tomorrowW') : d.date.slice(5).replace('-', '/'),
      subtitle: `${lang === 'zh' ? d.summaryZh : d.summary} · ${sx(lang, 'rain')} ${d.rainChance}%`,
      meta: `${d.low}–${d.high} °C`
    }))
  );
  return turn('services', sx(lang, 'services'), sim, children, data);
}

// --- group sign-up claims (T7.4) -------------------------------------------------------------------

const G = {
  title: { en: 'Kindergarten sign-ups', zh: '幼儿园接龙' },
  settingTitle: { en: 'Homemind in this group', zh: 'Homemind 在这个群' },
  off: { en: 'Off. Homemind does not sign the family up for anything here.', zh: '已关闭。Homemind 不会在这里替家里认领任何东西。' },
  on: { en: 'On, approved by {who} on {when}: food only, up to {cap} per claim, posted as {who}.', zh: '已开启，由{who}于 {when} 批准：仅限食物，每次不超过 {cap}，以{who}的身份发送。' },
  auto: { en: 'Posts a claim on its own (level 4, simulated group only).', zh: '会自动发送认领（等级 4，仅限模拟群）。' },
  ask: { en: 'Each claim waits for a parent to tap its card.', zh: '每次认领都要等家长在卡片上点一下。' },
  pausedNote: { en: 'Automatic actions are paused, so nothing is claimed now.', zh: '自动操作已暂停，现在不会认领。' },
  limits: { en: 'Homemind claims only food to buy, never something a person has to make, and stops when a message is unclear.', zh: 'Homemind 只认领需要购买的食物，不会替家人承诺要动手做的东西；消息不清楚时会停下。' },
  turnOnAsk: { en: 'Turn on: ask me each time', zh: '开启：每次先问我' },
  turnOnAuto: { en: 'Turn on: post on its own (level 4)', zh: '开启：自动发送（等级 4）' },
  turnOff: { en: 'Turn off', zh: '关闭' },
  toAuto: { en: 'Post on its own (level 4)', zh: '改为自动发送（等级 4）' },
  toAsk: { en: 'Ask me each time', zh: '改为每次先问我' },
  parentsOnly: { en: 'Only a parent can change this.', zh: '只有家长可以修改。' },
  signedUp: { en: 'Signed up', zh: '已认领' },
  waiting: { en: 'Claim waiting for a parent’s tap (see the card)', zh: '认领等待家长确认（见卡片）' },
  notPosted: { en: 'not posted', zh: '未发送' },
  didNot: { en: 'Did not sign up', zh: '没有认领' },
  postedAs: { en: 'posted by Homemind in {group}', zh: '由 Homemind 发到{group}' },
  readBy: { en: 'read by fixed rules, not the model', zh: '用固定规则读取，未使用模型' },
  closes: { en: 'closes', zh: '截止' },
  changeTo: { en: 'Change to', zh: '改为' },
  change: { en: 'Change', zh: '改成这个' },
  changeWaiting: { en: 'Change to {x} waits for a parent’s tap (see the card).', zh: '改为{x}正在等待家长确认（见卡片）。' },
  pref: { en: 'Saved preference', zh: '已保存的偏好' },
  because: { en: 'because', zh: '因为' },
  makes: { en: 'someone has to make it', zh: '需要有人动手做' },
  about: { en: 'about', zh: '约' },
  changed: { en: 'changed', zh: '已更改' },
  unclear: { en: 'the message was unclear', zh: '消息不清楚' },
  closed: { en: 'the sign-up had closed', zh: '接龙已截止' },
  nothing: { en: 'nothing left is food Homemind may claim on its own', zh: '剩下的没有 Homemind 可以自行认领的食物' },
  already: { en: 'the family is already on the list', zh: '家里已经在名单上' },
  paused: { en: 'automatic actions were paused', zh: '自动操作已暂停' },
  failed: { en: 'the simulated group did not take the post', zh: '模拟群没有收到' },
  withdrawn: { en: 'the family was taken off the list', zh: '已把家里从名单上撤下' },
  cardCancelled: { en: 'the card was cancelled, nothing was posted', zh: '卡片已取消，没有发送' },
  cardExpired: { en: 'nobody tapped before the sign-up closed, nothing was posted', zh: '截止前没有人确认，没有发送' }
} as const;
const gx = (lang: HomemindLang, key: keyof typeof G): string => G[key][lang];
/** A colon in the reader's language. */
const colon = (lang: HomemindLang) => (lang === 'zh' ? '：' : ': ');
const fill = (s: string, values: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');

/**
 * The group's claim setting (Services only) and the sign-ups Homemind looked at: what it took, with
 * "Why?" and the choices a parent can change to (a saved preference first, with its reason). My day shows
 * the claims whose party is still ahead, and stops from the last 12 hours.
 */
function groupClaimBlocks(input: HomemindScreenData, where: 'my-day' | 'services', children: A2uiComponent[], data: Record<string, unknown>): void {
  const { lang, view } = input;
  const groups = input.groups;
  if (!groups) return;
  const zone = view.family.timezone;
  const me = memberOf(view.family, view.memberId);
  const isParent = me?.role === 'parent';
  const nowMs = Date.parse(input.now);
  const sim = hx(lang, 'simulated');
  const when = (iso: string | undefined) => {
    const parts = iso ? dateParts(iso, zone) : null;
    return parts ? `${WEEKDAYS[lang][parts.weekday] ?? ''} ${parts.date.slice(5).replace('-', '/')} ${parts.time}`.trim() : '';
  };

  if (where === 'services') {
    for (const p of groups.policies) {
      const who = nameOf(memberOf(view.family, p.approvedBy), lang);
      const lines = [`**${gx(lang, 'settingTitle')}** · ${sim}`, ''];
      if (p.enabled) {
        lines.push(fill(gx(lang, 'on'), { who, when: when(p.approvedAt), cap: `${p.maxCost} ${p.currency}` }));
        lines.push(gx(lang, p.level >= 4 ? 'auto' : 'ask'));
        if (p.paused) lines.push(gx(lang, 'pausedNote'));
      } else lines.push(gx(lang, 'off'));
      lines.push(gx(lang, 'limits'));
      if (!isParent) lines.push(gx(lang, 'parentsOnly'));
      children.push(text(`group-setting-${p.groupId}`, lines.join('\n\n')));
      if (isParent) {
        const a = (key: keyof typeof G, args: Record<string, unknown>, variant: A2uiAction['variant']): A2uiAction => ({ id: `homemind.group-policy:${p.groupId}:${key}`, label: gx(lang, key), variant, kind: 'homemind', args: { verb: 'group-policy', groupId: p.groupId, ...args } });
        const actions = p.enabled
          ? [a(p.level >= 4 ? 'toAsk' : 'toAuto', { auto: p.level < 4 }, 'secondary'), a('turnOff', { enabled: false }, 'ghost')]
          : [a('turnOnAsk', { enabled: true, auto: false }, 'secondary'), a('turnOnAuto', { enabled: true, auto: true }, 'primary')];
        children.push({ id: `group-setting-actions-${p.groupId}`, component: 'ActionBar', actions });
      }
    }
  }

  const shown = groups.claims
    .filter(c => {
      if (where === 'services') return true;
      if (c.claim.status === 'stopped') return nowMs - Date.parse(c.claim.at) < RECENT_MS;
      return Date.parse(c.claim.eventStart ?? '') > nowMs;
    })
    .slice(0, 3);
  if (!shown.length) return;
  const stopWords: Record<string, keyof typeof G> = { unclear: 'unclear', closed: 'closed', nothing_suitable: 'nothing', already_signed_up: 'already', paused: 'paused', failed: 'failed', withdrawn: 'withdrawn' };
  const rows: TaskRow[] = [];
  const after: Array<{ claimId: string; rows: TaskRow[]; note?: string }> = [];
  for (const c of shown) {
    const claim = c.claim;
    const group = lang === 'zh' ? c.groupNameZh : c.groupName;
    const event = lang === 'zh' ? claim.eventTitleZh ?? claim.eventTitle ?? '' : claim.eventTitle ?? '';
    const whyAction: A2uiAction = { id: `homemind.why:${claim.whyId}`, label: hx(lang, 'why'), variant: 'secondary', kind: 'homemind', args: { verb: 'why', whyId: claim.whyId } };
    if (claim.status === 'stopped') {
      const reason = gx(lang, stopWords[claim.reason ?? 'failed'] ?? 'failed');
      const problem = claim.reason === 'unclear' ? (lang === 'zh' ? claim.problemZh : claim.problem) : '';
      rows.push({ id: `claim-${claim.id}`, title: `${gx(lang, 'didNot')}${colon(lang)}${reason}`, meta: [problem, group, gx(lang, 'readBy')].filter(Boolean).join(' · '), ownerLabel: '', state: '', tone: 'warning', simulated: true, actions: [whyAction] });
      continue;
    }
    const choice = c.choice ? (lang === 'zh' ? c.choice.label : `${c.choice.label} (${c.choice.en})`) : '';
    if (claim.status === 'waiting') {
      const ended = c.cardStatus === 'cancelled' ? 'cardCancelled' : c.cardStatus === 'expired' ? 'cardExpired' : undefined;
      rows.push({
        id: `claim-${claim.id}`,
        title: `${choice} · ${event}`,
        meta: [ended ? `${gx(lang, 'notPosted')}${colon(lang)}${gx(lang, ended)}` : gx(lang, 'waiting'), when(claim.eventStart), group].filter(Boolean).join(' · '),
        ownerLabel: '',
        state: '',
        tone: ended ? 'muted' : 'accent',
        simulated: true,
        actions: [whyAction]
      });
      continue;
    }
    const changedNote = (claim.changes ?? []).some(ch => ch.status === 'posted') ? gx(lang, 'changed') : '';
    rows.push({
      id: `claim-${claim.id}`,
      title: `${gx(lang, 'signedUp')}${colon(lang)}${choice} · ${event}`,
      meta: [when(claim.eventStart), claim.deadline ? `${gx(lang, 'closes')} ${when(claim.deadline)}` : '', fill(gx(lang, 'postedAs'), { group }), changedNote, gx(lang, 'readBy')].filter(Boolean).join(' · '),
      ownerLabel: '',
      state: '',
      tone: 'success',
      simulated: true,
      actions: [whyAction]
    });
    if (c.changeWaiting) {
      after.push({ claimId: claim.id, rows: [], note: fill(gx(lang, 'changeWaiting'), { x: c.changeWaiting.label }) });
    } else if (c.alternatives.length) {
      after.push({
        claimId: claim.id,
        rows: c.alternatives.map(alt => {
          const pref = alt.preferences[0];
          const reason = pref ? (lang === 'zh' ? pref.reasonZh ?? pref.reason : pref.reason) : undefined;
          const prefText = pref ? `${gx(lang, 'pref')}${colon(lang)}“${lang === 'zh' ? pref.textZh ?? pref.text : pref.text}”${reason ? ` ${gx(lang, 'because')} ${reason}` : ''}` : '';
          return {
            id: `alt-${claim.id}-${alt.key}`,
            title: lang === 'zh' ? alt.label : `${alt.label} (${alt.en})`,
            meta: [prefText, alt.effort === 'make' ? gx(lang, 'makes') : '', `${gx(lang, 'about')} ${alt.cost} ${alt.currency}`].filter(Boolean).join(' · '),
            ownerLabel: '',
            state: '',
            tone: pref ? 'accent' : 'muted',
            simulated: true,
            actions: isParent ? [{ id: `homemind.group-change:${claim.id}:${alt.key}`, label: gx(lang, 'change'), variant: pref ? 'primary' : 'secondary', kind: 'homemind', args: { verb: 'group-change', claimId: claim.id, option: alt.key } }] : []
          } satisfies TaskRow;
        })
      });
    }
  }
  children.push(taskList('group-claims', gx(lang, 'title'), '/groupClaims'));
  data.groupClaims = rows;
  for (const block of after) {
    if (block.note) {
      children.push(text(`group-change-note-${block.claimId}`, block.note));
      continue;
    }
    const id = `groupAlt-${block.claimId}`;
    children.push(taskList(`group-alt-${block.claimId}`, gx(lang, 'changeTo'), `/${id}`));
    data[id] = block.rows;
  }
}

// --- changed messages (T7.5) -----------------------------------------------------------------------

const SC = {
  title: { en: 'Changed messages', zh: '消息有变化' },
  moved: { en: 'The kindergarten changed the party to {day}.', zh: '幼儿园把派对改到了{day}。' },
  list: { en: 'The kindergarten changed the sign-up list.', zh: '幼儿园修改了接龙清单。' },
  unclear: { en: 'A kindergarten message was edited, and Homemind could not read the new version.', zh: '幼儿园的一条消息被修改了，Homemind 读不懂新版本。' },
  edited: { en: 'A kindergarten message was edited.', zh: '幼儿园的一条消息被修改了。' },
  depend: { en: '{n} items depend on it.', zh: '有 {n} 项与它有关。' },
  dependOne: { en: '1 item depends on it.', zh: '有 1 项与它有关。' },
  dependNone: { en: 'Nothing on the board depends on it.', zh: '看板上没有与它有关的事项。' },
  waiting: { en: 'Reminders for these wait until a parent decides. Compared in code, not by the model.', zh: '家长决定之前，相关提醒先暂停。由代码比较，没有用模型。' },
  apply: { en: 'Apply changes', zh: '应用更改' },
  keep: { en: 'Keep as is', zh: '保持原样' },
  discard: { en: 'Discard', zh: '舍弃' },
  undo: { en: 'Undo', zh: '撤销' },
  applied: { en: 'Applied by {who}', zh: '{who}已应用更改' },
  kept: { en: 'Kept as it was by {who}', zh: '{who}选择保持原样' },
  discarded: { en: 'Discarded by {who}', zh: '{who}已舍弃' },
  noUndo: { en: 'No Undo: a message was already posted in the simulated group', zh: '无法撤销：已在模拟群里发过消息' },
  parentsDecide: { en: 'A parent decides.', zh: '由家长决定。' },
  noApply: { en: 'Apply is not offered: the new version could not be read.', zh: '无法应用：新版本读不懂。' },
  depends: { en: 'What depends on it', zh: '有关事项' }
} as const;
const scx = (lang: HomemindLang, key: keyof typeof SC): string => SC[key][lang];
const FULL_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function localWhen(iso: string | undefined, zone: string, lang: HomemindLang): string {
  const p = iso ? dateParts(iso, zone) : null;
  return p ? `${WEEKDAYS[lang][p.weekday] ?? ''} ${p.date.slice(5).replace('-', '/')} ${p.time}`.trim() : '';
}

/** "Message changed: Thu 11/12 15:00 → Fri 11/13 15:00" on a board row whose message changed. */
function staleNote(item: Pick<Item, 'stale'>, zone: string, lang: HomemindLang): string {
  const mark = item.stale;
  if (!mark) return '';
  const label = hx(lang, 'staleMark');
  const sep = lang === 'zh' ? '：' : ': ';
  if (mark.field === 'start' && mark.oldValue && mark.newValue) return `${label}${sep}${localWhen(mark.oldValue, zone, lang)} → ${localWhen(mark.newValue, zone, lang)}`;
  if (mark.field === 'choice') return `${label}${sep}${hx(lang, 'staleChoiceGone')}`;
  if (mark.field === 'unclear') return `${label}${sep}${hx(lang, 'staleUnclear')}`;
  return label;
}

/** The differences in a few words, from the diffs (computed in code on the server). */
function describeChange(diffs: SourceChangeView['change']['diffs'], zone: string, lang: HomemindLang): string {
  const out: string[] = [];
  for (const d of diffs) {
    if (d.field === 'eventStart') out.push(lang === 'zh' ? `时间：${localWhen(d.old, zone, lang)} → ${localWhen(d.new, zone, lang)}` : `When: ${localWhen(d.old, zone, lang)} → ${localWhen(d.new, zone, lang)}`);
    else if (d.field === 'deadline') out.push(lang === 'zh' ? `截止：${localWhen(d.new, zone, lang) || '未写'}` : `Closes: ${localWhen(d.new, zone, lang) || 'not given'}`);
    else if (d.field === 'options') {
      if (d.removed.length) out.push(lang === 'zh' ? `已不需要：${d.removed.join('、')}` : `No longer needed: ${d.removed.join(', ')}`);
      if (d.added.length) out.push(lang === 'zh' ? `新增：${d.added.join('、')}` : `New: ${d.added.join(', ')}`);
    } else if (d.field === 'choice') {
      out.push(
        lang === 'zh'
          ? d.switchTo
            ? `家里的${d.oldLabel}将改为${d.switchToLabel}，并在群里更正`
            : `家里的${d.oldLabel}已不需要，将从名单撤下`
          : d.switchTo
            ? `The family's ${d.oldLabel} → ${d.switchToLabel}, with a correction in the group`
            : `The family's ${d.oldLabel} is no longer needed; its name comes off the list`
      );
    } else if (d.field === 'unclear') out.push(lang === 'zh' ? d.problemZh : d.problem);
  }
  return out.join(' · ');
}

/**
 * One row per changed message: the headline ("The kindergarten changed the party to Friday. 3 items depend
 * on it."), what changed (compared in code), and Apply / Keep / Discard for a parent; after a decision, who
 * made it and Undo. Then the affected items, each with what changes for it.
 */
function sourceChangeBlocks(input: HomemindScreenData, children: A2uiComponent[], data: Record<string, unknown>): void {
  const { lang, view } = input;
  const list = input.sourceChanges ?? [];
  if (!list.length) return;
  const zone = view.family.timezone;
  const isParent = memberOf(view.family, view.memberId)?.role === 'parent';
  const rows: TaskRow[] = [];
  const blocks: Array<{ id: string; rows: TaskRow[] }> = [];
  for (const v of list) {
    const c = v.change;
    let newStart: string | undefined;
    for (const d of c.diffs) if (d.field === 'eventStart') newStart = d.new;
    const wd = newStart ? dateParts(newStart, zone)?.weekday ?? 0 : 0;
    const day = newStart ? (lang === 'zh' ? WEEKDAYS.zh[wd] : FULL_WEEKDAYS[wd]) : '';
    const head = c.diffs.some(d => d.field === 'unclear')
      ? scx(lang, 'unclear')
      : newStart
        ? fill(scx(lang, 'moved'), { day })
        : c.diffs.some(d => d.field === 'options' || d.field === 'choice')
          ? scx(lang, 'list')
          : scx(lang, 'edited');
    const n = v.items.length;
    const depend = n === 0 ? scx(lang, 'dependNone') : n === 1 ? scx(lang, 'dependOne') : fill(scx(lang, 'depend'), { n: String(n) });
    const group = lang === 'zh' ? v.groupNameZh : v.groupName;
    const who = nameOf(memberOf(view.family, c.resolvedBy), lang);
    const why: A2uiAction = { id: `homemind.why:${c.whyId}`, label: hx(lang, 'why'), variant: 'secondary', kind: 'homemind', args: { verb: 'why', whyId: c.whyId } };
    const a = (action: 'apply' | 'keep' | 'discard' | 'undo', variant: A2uiAction['variant']): A2uiAction => ({
      id: `homemind.source-change:${c.id}:${action}`,
      label: scx(lang, action),
      variant,
      kind: 'homemind',
      args: { verb: 'source-change', changeId: c.id, action }
    });
    let actions: A2uiAction[] = [why];
    let status: string;
    if (c.status === 'pending') {
      status = isParent ? (v.canApply ? scx(lang, 'waiting') : scx(lang, 'noApply')) : `${scx(lang, 'waiting')} ${scx(lang, 'parentsDecide')}`;
      if (isParent) actions = [...(v.canApply ? [a('apply', 'primary')] : []), a('keep', 'secondary'), a('discard', 'ghost'), why];
    } else {
      status = fill(scx(lang, c.status), { who });
      if (isParent && v.undoable) actions = [a('undo', 'secondary'), why];
      else if (!v.undoable) status = `${status} · ${scx(lang, 'noUndo')}`;
    }
    rows.push({
      id: `source-${c.id}`,
      title: lang === 'zh' ? `${head}${depend}` : `${head} ${depend}`,
      meta: [describeChange(c.diffs, zone, lang), status, group].filter(Boolean).join(' · '),
      ownerLabel: '',
      state: '',
      tone: c.status === 'pending' ? 'warning' : 'muted',
      simulated: true,
      actions
    });
    if (c.status === 'pending' && v.items.length) {
      blocks.push({
        id: c.id,
        rows: v.items.map(item => ({
          id: `stale-${item.id}`,
          title: lang === 'zh' ? item.titleZh ?? item.title : item.title,
          meta: staleNote(item, zone, lang),
          ownerLabel: '',
          state: '',
          tone: 'warning',
          simulated: true,
          actions: []
        }))
      });
    }
  }
  children.push(taskList('source-changes', scx(lang, 'title'), '/sourceChanges'));
  data.sourceChanges = rows;
  for (const b of blocks) {
    const key = `staleItems-${b.id}`;
    children.push(taskList(`stale-items-${b.id}`, scx(lang, 'depends'), `/${key}`));
    data[key] = b.rows;
  }
}

// --- a day gone wrong (T8.1) -----------------------------------------------------------------------

const SIT = {
  sickToday: { en: '{who} is sick today', zh: '{who}今天生病了' },
  sickOn: { en: '{who} is sick on {day}', zh: '{who}{day}生病了' },
  reported: { en: 'Reported by {who}', zh: '{who}报告' },
  whoHome: { en: 'Who could stay home', zh: '谁可以留在家' },
  free: { en: 'Not marked away that day', zh: '当天没有标记外出' },
  away: { en: 'Away', zh: '外出' },
  noOneFree: { en: 'No parent is free that day. A babysitter message is ready if one is free (simulated).', zh: '当天没有家长有空。如有保姆有空，已准备好消息（模拟）。' },
  task: { en: 'Who stays home?', zh: '谁留在家？' },
  taskNote: { en: 'Homemind does not pick: one of you taps “I’ll take it”.', zh: 'Homemind 不替你们选：请其中一位点“我来”。' },
  changes: { en: 'What falls through, and what Homemind suggests', zh: '受影响的安排和建议' },
  nothing: { en: 'Nothing else on the board falls through that day.', zh: '当天看板上没有其他受影响的事项。' },
  cancel: { en: 'Not needed: {who} stays home', zh: '不需要了：{who}在家' },
  postpone: { en: 'Postpone a week, to {when}', zh: '推迟一周，改到{when}' },
  skip: { en: 'Skip this week only', zh: '只跳过这一周' },
  open: { en: '{who} can’t do it: ask who takes it', zh: '{who}做不了：问问谁来负责' },
  apply: { en: 'Apply', zh: '采纳' },
  notNow: { en: 'Not now', zh: '暂不' },
  applyAll: { en: 'Apply all ({n})', zh: '全部采纳（{n}）' },
  applied: { en: 'Done by {who}', zh: '{who}已采纳' },
  dismissed: { en: 'Left as is by {who}', zh: '{who}选择暂不' },
  gone: { en: 'No longer on the board', zh: '已不在看板上' },
  undo: { en: 'Undo', zh: '撤销' },
  cards: { en: 'A message outside the family (simulated) is ready under “Waiting for your tap”: nothing is sent until a parent taps it.', zh: '发给家庭以外的消息（模拟）在“等你点一下”里：家长点一下之前不会发送。' },
  cardsOther: { en: 'A message outside the family (simulated) waits for a parent’s tap.', zh: '发给家庭以外的消息（模拟）等家长点一下。' },
  rules: { en: 'Fixed rules over the board; the model only read the message.', zh: '按固定规则查看看板；模型只读了这条消息。' }
} as const;
const sit = (lang: HomemindLang, key: keyof typeof SIT, values: Record<string, string> = {}): string => fill(SIT[key][lang], values);

function situationHeadline(v: SituationView, view: HomemindViewData, lang: HomemindLang, today: string): string {
  const s = v.situation;
  const who = nameOf(memberOf(view.family, s.memberId), lang);
  if (s.date === today) return sit(lang, 'sickToday', { who });
  const wd = new Date(`${s.date}T12:00:00Z`).getUTCDay();
  const day = `${WEEKDAYS[lang][wd] ?? ''} ${s.date.slice(5).replace('-', '/')}`.trim();
  return sit(lang, 'sickOn', { who, day });
}

/**
 * One situation: the headline and who said it, who could stay home (availability only, never who does
 * more), the stay-home task with its own "I'll take it", and each suggestion with Apply / Not now (or who
 * decided, with Undo). Ids carry the situation id, so a chat card and My day never clash.
 */
function situationBlocks(v: SituationView, view: HomemindViewData, lang: HomemindLang, today: string, children: A2uiComponent[], data: Record<string, unknown>): void {
  const s = v.situation;
  const zone = view.family.timezone;
  const key = s.id.replace(/[^a-z0-9]/g, '');
  const me = memberOf(view.family, view.memberId);
  const sickName = nameOf(memberOf(view.family, s.memberId), lang);
  const quote = s.summary ? ` · “${plainChatText(s.summary)}”` : '';
  children.push(text(`sit-head-${key}`, `**${situationHeadline(v, view, lang, today)}**\n\n${sit(lang, 'reported', { who: nameOf(memberOf(view.family, s.reportedBy), lang) })}${quote}`));

  const itemOf = (id: string) => v.items.find(i => i.id === id);
  const isLive = (id: string) => {
    const status = itemOf(id)?.status;
    return status === 'open' || status === 'proposed';
  };
  const parents = [...new Set([...s.available, ...s.away.map(a => a.memberId)])];
  if (parents.length) {
    const rows = parents.map(id => {
      const away = s.away.filter(a => a.memberId === id);
      const value = away.length
        ? away
            .map(a => {
              const ev = itemOf(a.eventId);
              const from = dateParts(a.start, zone);
              const to = dateParts(a.end, zone);
              const span = from && to ? `${from.time}–${to.time}` : '';
              return [sit(lang, 'away'), span, ev ? (lang === 'zh' ? ev.titleZh ?? ev.title : ev.title) : ''].filter(Boolean).join(' · ');
            })
            .join('; ')
        : sit(lang, 'free');
      return { label: nameOf(memberOf(view.family, id), lang), value, tone: away.length ? 'accent' : 'success' };
    });
    children.push({ id: `sit-home-${key}`, component: 'InfoRows', title: sit(lang, 'whoHome'), dataPath: `/sitHome_${key}` });
    data[`sitHome_${key}`] = rows;
    if (!s.available.length) children.push(text(`sit-nofree-${key}`, sit(lang, 'noOneFree')));
  }

  const task = s.stayHomeItemId ? view.items.find(i => i.id === s.stayHomeItemId && live(i)) : undefined;
  if (task) {
    children.push(taskList(`sit-task-${key}`, sit(lang, 'task'), `/sitTask_${key}`));
    const row = taskRow(task, view, lang, today);
    data[`sitTask_${key}`] = [task.ownership.state === 'open' ? { ...row, meta: [row.meta, sit(lang, 'taskNote')].filter(Boolean).join(' · ') } : row];
  }

  const act = (verb: 'apply' | 'dismiss' | 'undo', proposalId: string, label: string, variant: A2uiAction['variant']): A2uiAction => ({
    id: `homemind.situation:${s.id}:${verb}:${proposalId}`,
    label,
    variant,
    kind: 'homemind',
    args: { verb: 'situation', situationId: s.id, action: verb, proposalId }
  });
  const rows: TaskRow[] = s.proposals.map(p => {
    const item = itemOf(p.itemId);
    const title = item ? (lang === 'zh' ? item.titleZh ?? item.title : item.title) : '';
    const when = item?.start && p.kind !== 'skip' ? localWhen(p.start ?? item.start, zone, lang) : '';
    const what =
      p.kind === 'cancel'
        ? sit(lang, 'cancel', { who: sickName })
        : p.kind === 'postpone'
          ? sit(lang, 'postpone', { when: localWhen(p.newStart, zone, lang) })
          : p.kind === 'skip'
            ? sit(lang, 'skip')
            : sit(lang, 'open', { who: sickName });
    const who = nameOf(memberOf(view.family, p.by), lang);
    let status = '';
    let actions: A2uiAction[] = [];
    if (p.status === 'pending') {
      if (isLive(p.itemId)) actions = [act('apply', p.id, sit(lang, 'apply'), 'primary'), act('dismiss', p.id, sit(lang, 'notNow'), 'ghost')];
      else status = sit(lang, 'gone');
    } else {
      status = p.status === 'applied' ? sit(lang, 'applied', { who }) : sit(lang, 'dismissed', { who });
      actions = [act('undo', p.id, sit(lang, 'undo'), 'secondary')];
    }
    return {
      id: `sit-${key}-${p.id}`,
      title,
      meta: [when, what, status].filter(Boolean).join(' · '),
      ownerLabel: '',
      state: '',
      tone: p.status === 'pending' && isLive(p.itemId) ? 'warning' : 'muted',
      actions
    };
  });
  if (rows.length) {
    children.push(taskList(`sit-changes-${key}`, sit(lang, 'changes'), `/sitChanges_${key}`));
    data[`sitChanges_${key}`] = rows;
  } else {
    children.push(text(`sit-nothing-${key}`, sit(lang, 'nothing')));
  }
  const pending = s.proposals.filter(p => p.status === 'pending' && isLive(p.itemId));
  const bar: A2uiAction[] = [];
  if (pending.length > 1) bar.push(act('apply', 'all', sit(lang, 'applyAll', { n: String(pending.length) }), 'primary'));
  bar.push({ id: `homemind.why:${s.whyId}`, label: hx(lang, 'why'), variant: 'secondary', kind: 'homemind', args: { verb: 'why', whyId: s.whyId } });
  children.push({ id: `sit-actions-${key}`, component: 'ActionBar', actions: bar });
  const cardWaiting = s.cardIds.some(id => view.actionCards.some(c => c.id === id && c.status === 'pending'));
  const notes = [sit(lang, 'rules'), cardWaiting ? sit(lang, me?.role === 'parent' ? 'cards' : 'cardsOther') : ''].filter(Boolean);
  children.push(text(`sit-note-${key}`, notes.join(' ')));
}

// --- judgment and summaries (T8.2) ------------------------------------------------------------------

const SUM = {
  daily: { en: 'Evening summary', zh: '晚间摘要' },
  weekly: { en: 'The week ahead', zh: '下周概览' },
  tonight: { en: 'Tonight', zh: '今晚' },
  weekAhead: { en: 'Week ahead', zh: '下周' },
  sentAt: { en: 'Sent at {time}, {day}.', zh: '已于{day} {time}送达。' },
  preview: { en: 'Preview: it goes out at {time} tonight.', zh: '预览：今晚 {time} 送达。' },
  previewWeek: { en: 'Preview: the week ahead goes out on {day} at {time}.', zh: '预览：下周概览将于{day} {time}送达。' },
  covers: { en: 'Covers {from} to {to}.', zh: '涵盖{from}至{to}。' },
  toDo: { en: 'What you need to do', zh: '你需要做的事' },
  toDoEmpty: { en: 'Nothing for you in this period.', zh: '这段时间没有需要你做的事。' },
  whyOwner: { en: 'Yours', zh: '你负责' },
  whyUnconfirmed: { en: 'Given to you: please confirm', zh: '交给你了：请确认' },
  whyAsked: { en: 'You could take it', zh: '你可以负责' },
  whyUnanswered: { en: 'A reminder got no answer', zh: '提醒还没有回应' },
  away: { en: 'Who is away', zh: '谁不在' },
  everyone: { en: 'For everyone', zh: '全家知道就好' },
  everyoneEmpty: { en: 'No other events in this period.', zh: '这段时间没有其他活动。' },
  messages: { en: 'Messages that waited for this summary', zh: '等到摘要再看的消息' },
  messagesPreview: { en: 'Messages waiting for tonight', zh: '等到今晚再看的消息' },
  held: { en: "Waiting for tonight's summary", zh: '等今晚的摘要' },
  heldNote: { en: 'No alert was sent for these.', zh: '这些消息没有发提醒。' },
  rule: { en: 'Decided by a Homemind rule (fixed words in the message), not by the model.', zh: '由 Homemind 规则（消息里的固定词语）决定，不是由模型决定。' },
  note: { en: 'Homemind helps, but it can miss things.', zh: 'Homemind 会帮忙，但也可能遗漏。' },
  inSummary: { en: 'Went out in the evening summary', zh: '已放入晚间摘要' },
  urgent: { en: 'Shown at once: it says “{quote}”', zh: '立即提醒：消息里写着“{quote}”' },
  signUp: { en: 'Shown now: a sign-up (“{quote}”) has a deadline', zh: '现在提醒：接龙（“{quote}”）有截止时间' },
  soon: { en: 'Shown now: it is about “{quote}”', zh: '现在提醒：和“{quote}”有关' },
  notUrgent: { en: 'Waits for the evening summary ({time}): the sender wrote “{quote}” (not urgent)', zh: '等到晚间摘要（{time}）：发消息的人写了“{quote}”（不着急）' },
  nextWeek: { en: 'Waits for the evening summary ({time}): it is about “{quote}”, not the next few days', zh: '等到晚间摘要（{time}）：说的是“{quote}”，不是这几天的事' },
  noDate: { en: 'Waits for the evening summary ({time}): no date and nothing asked for today', zh: '等到晚间摘要（{time}）：没有日期，也不用今天处理' }
} as const;

const sum = (lang: HomemindLang, key: keyof typeof SUM, values: Record<string, string> = {}): string => fill(SUM[key][lang], values);

/** "Waits for the evening summary (20:00): the sender wrote “不着急” (not urgent)", or why it was shown now. */
export function judgmentLine(j: MessageJudgment | undefined, zone: string, lang: HomemindLang): string {
  if (!j) return '';
  if (j.tier === 'summary' && j.deliveredIn) return sum(lang, 'inSummary');
  const quote = j.quote ?? '';
  const time = (j.summaryAt ? dateParts(j.summaryAt, zone)?.time : undefined) ?? '20:00';
  switch (j.reason) {
    case 'urgent-words':
      return sum(lang, 'urgent', { quote });
    case 'sign-up':
      return sum(lang, 'signUp', { quote });
    case 'soon':
      return sum(lang, 'soon', { quote });
    case 'not-urgent':
      return sum(lang, 'notUrgent', { quote, time });
    case 'next-week':
      return sum(lang, 'nextWeek', { quote, time });
    case 'no-date':
      return sum(lang, 'noDate', { time });
  }
}

const authorOf = (m: GroupMessage, lang: HomemindLang) => (lang === 'zh' ? m.authorZh ?? m.author : m.author);
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/** My day (parents): the group messages that wait for tonight's summary, each with its reason. No alert went out for them. */
function heldMessagesBlock(input: HomemindScreenData, children: A2uiComponent[]): void {
  const { lang, view } = input;
  const waiting = (input.judgments ?? []).filter(j => j.tier === 'summary' && !j.deliveredIn);
  if (!waiting.length) return;
  const messages = input.services?.group.messages ?? [];
  const zone = view.family.timezone;
  const lines = waiting.map(j => {
    const m = messages.find(x => x.id === j.messageId);
    const lead = m ? `${authorOf(m, lang)}${lang === 'zh' ? '：' : ': '}“${oneLine(m.text)}” ` : '';
    return `- ${lead}${judgmentLine(j, zone, lang)}`;
  });
  children.push(text('held-messages', `**${sum(lang, 'held')}** · ${hx(lang, 'simulated')}\n\n${lines.join('\n')}\n\n${sum(lang, 'heldNote')} ${sum(lang, 'rule')}`));
}

function shortDate(date: string, lang: HomemindLang): string {
  return `${WEEKDAYS[lang][weekdayOfDate(date)] ?? ''} ${date.slice(5).replace('-', '/')}`.trim();
}

const WHY_LABEL: Record<SummaryView['toDo'][number]['why'], keyof typeof SUM> = { owner: 'whyOwner', unconfirmed: 'whyUnconfirmed', asked: 'whyAsked', unanswered: 'whyUnanswered' };

function summaryScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const zone = view.family.timezone;
  const today = dateParts(input.now, zone)?.date ?? '';
  const me = memberOf(view.family, view.memberId);
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  const v = input.summary;
  const weekly = v?.kind === 'weekly';
  children.push({
    id: 'period',
    component: 'ActionBar',
    actions: [
      { id: 'homemind.summary-period:day', label: sum(lang, 'tonight'), variant: weekly ? 'secondary' : 'primary', kind: 'homemind', args: { verb: 'summary-period', period: 'day' } },
      { id: 'homemind.summary-period:week', label: sum(lang, 'weekAhead'), variant: weekly ? 'primary' : 'secondary', kind: 'homemind', args: { verb: 'summary-period', period: 'week' } }
    ]
  });
  const title = sum(lang, weekly ? 'weekly' : 'daily');
  if (!v) {
    children.push(text('empty', hx(lang, 'nothingHere')));
    return turn('summary', title, nameOf(me, lang), children, data);
  }
  const at = dateParts(v.deliveredAt ?? v.scheduledAt, zone);
  const day = at ? (at.date === today ? hx(lang, 'today') : shortDate(at.date, lang)) : '';
  const status = v.deliveredAt ? sum(lang, 'sentAt', { time: at?.time ?? '', day }) : sum(lang, weekly ? 'previewWeek' : 'preview', { time: at?.time ?? '20:00', day });
  children.push(text('status', `${status} ${sum(lang, 'covers', { from: shortDate(v.from, lang), to: shortDate(v.to, lang) })}`));

  // 1. What you need to do, first.
  const toDoRows: TaskRow[] = [];
  for (const entry of v.toDo) {
    const item = view.items.find(i => i.id === entry.itemId);
    if (!item) continue;
    const row = taskRow(item, view, lang, today);
    toDoRows.push({ ...row, meta: [sum(lang, WHY_LABEL[entry.why]), row.meta].filter(Boolean).join(' · '), tone: entry.why === 'owner' ? row.tone : 'warning' });
  }
  section(children, data, 'todo', sum(lang, 'toDo'), toDoRows, sum(lang, 'toDoEmpty'));

  // 2. Who is away, from events this member can see.
  const awayLines = v.away.flatMap(a => {
    const event = view.items.find(i => i.id === a.eventId);
    const who = nameOf(memberOf(view.family, a.memberId), lang);
    if (!event || !who) return [];
    const last = dateParts(new Date(Date.parse(a.end) - 1).toISOString(), zone)?.date ?? a.date;
    const span = last > a.date ? `${shortDate(a.date, lang)} – ${shortDate(last, lang)}` : shortDate(a.date, lang);
    return [`- ${who}${lang === 'zh' ? '：' : ': '}${titleOf(event, lang)} (${span})`];
  });
  if (awayLines.length) children.push(text('away', `**${sum(lang, 'away')}**\n\n${awayLines.join('\n')}`));

  // 3. General events, for everyone to know.
  const everyoneRows = v.everyone.flatMap(e => {
    const item = view.items.find(i => i.id === e.itemId);
    return item ? [taskRow(item, view, lang, today)] : [];
  });
  section(children, data, 'everyone', sum(lang, 'everyone'), everyoneRows, sum(lang, 'everyoneEmpty'));

  // 4. Parents: the group messages that waited, each with the reason it waited.
  if (v.messages.length) {
    children.push({ id: 'messages', component: 'List', title: sum(lang, v.deliveredAt ? 'messages' : 'messagesPreview'), dataPath: '/messages' });
    data.messages = v.messages.map(({ judgment, message }) => ({
      title: authorOf(message, lang),
      subtitle: message.text,
      meta: judgmentLine({ ...judgment, deliveredIn: undefined }, zone, lang),
      simulated: true
    }));
    children.push(text('messages-rule', sum(lang, 'rule')));
  }
  children.push(text('note', sum(lang, 'note')));
  return turn('summary', title, nameOf(me, lang), children, data);
}

// --- shopping ---------------------------------------------------------------------------------------

/**
 * The family's shopping lists, per store. One form adds an item to the chosen store's list; each store
 * with something on it (or a run, or that the family added) gets its own list: Bought / Not bought and
 * Remove per item, "I'll go" or Release for the run, and Clear bought. The words are the family's own.
 */
function shoppingScreen(input: HomemindScreenData): HomemindTurn {
  const { lang, view } = input;
  const t = (en: string, zh: string) => (lang === 'zh' ? zh : en);
  const shopping = input.shopping ?? { stores: [], items: [] };
  const who = (id: string) => (id === view.memberId ? t('you', '你') : nameOf(memberOf(view.family, id), lang) || t('someone', '有人'));
  const storeName = (s: ShoppingState['stores'][number]) => (lang === 'zh' && s.nameZh ? s.nameZh : s.name);
  const shop = (verb: string, label: string, variant: A2uiAction['variant'], args: Record<string, unknown>, id: string): A2uiAction => ({ id: `homemind.${verb}:${id}`, label, variant, kind: 'homemind', args: { verb, ...args } });
  const children: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  // Tried to add something that is already waiting at that store: ask, instead of listing it twice.
  const twin = input.shoppingAsk ? shopping.items.find(i => i.id === input.shoppingAsk?.itemId && !i.bought) : undefined;
  if (twin) {
    // The family's own words go inside screen text, so link and bold marks are dropped there.
    const plain = (s: string) => s.replace(/[[\]()*`_\\]/g, '');
    const twinStore = shopping.stores.find(s => s.id === twin.storeId);
    const twinName = plain(lang === 'zh' && twin.nameZh ? twin.nameZh : twin.name);
    const has = twin.qty ?? 1;
    const asked = input.shoppingAsk?.qty;
    const where = twinStore ? storeName(twinStore) : '';
    children.push(
      text(
        'shop-ask',
        t(`**${twinName}** is already on the ${where} list (quantity ${has}), added by ${who(twin.addedBy)}. Change the quantity?`, `**${twinName}**已经在${where}清单上了（数量 ${has}），是${who(twin.addedBy)}加的。要改数量吗？`)
      )
    );
    const asks: A2uiAction[] = [shop('shop-bump', '+1', 'primary', { itemId: twin.id }, twin.id)];
    if (asked && asked !== has) asks.push(shop('shop-set-qty', t(`Make it ${asked}`, `改成 ${asked}`), 'secondary', { itemId: twin.id, qty: asked }, twin.id));
    asks.push(shop('shop-keep', t('Keep it as it is', '保持不变'), 'ghost', {}, twin.id));
    children.push({ id: 'shop-ask-actions', component: 'ActionBar', actions: asks });
  }

  if (shopping.stores.length) {
    children.push({ id: 'f-shopItem', component: 'TextField', name: 'shopItem', label: t('What to buy', '要买什么'), default: '', maxLength: 80 });
    children.push({ id: 'f-shopQty', component: 'TextField', name: 'shopQty', label: t('Quantity', '数量'), default: '1', inputType: 'number', maxLength: 2 });
    children.push({ id: 'f-shopNote', component: 'TextField', name: 'shopNote', label: t('Note (optional)', '备注（可选）'), default: '', maxLength: 120 });
    children.push({ id: 'f-shopStore', component: 'ChoiceGroup', name: 'shopStore', title: t('Where', '在哪儿买'), default: shopping.stores[0].id, options: shopping.stores.map(s => ({ value: s.id, label: storeName(s) })) });
    children.push({ id: 'shop-add', component: 'ActionBar', actions: [shop('shop-add', t('Add to list', '加到清单'), 'primary', {}, 'form')] });
  }

  const quantityOf = (i: ShoppingState['items'][number]): NonNullable<TaskRow['quantity']> => {
    const value = i.qty ?? 1;
    const open = !i.bought;
    return {
      value,
      label: t('Quantity', '数量'),
      ...(open && value > 1 ? { less: shop('shop-unbump', t('One less', '减一'), 'ghost', { itemId: i.id }, i.id) } : {}),
      ...(open && value < 99 ? { more: shop('shop-bump', t('One more', '加一'), 'ghost', { itemId: i.id }, i.id) } : {})
    };
  };

  const quiet: string[] = [];
  for (const store of shopping.stores) {
    const items = shopping.items.filter(i => i.storeId === store.id);
    if (!items.length && !store.run && !store.custom) {
      quiet.push(storeName(store));
      continue;
    }
    const open = items.filter(i => !i.bought);
    const bought = items.filter(i => i.bought);
    const runLine = store.run ? (store.run.memberId === view.memberId ? t("You're going (on your My day)", '你去买（在“我的一天”里）') : t(`${who(store.run.memberId)} is going`, `${who(store.run.memberId)}去买`)) : t('Nobody is going yet', '还没人认领');
    const key = `shop-${store.id}`;
    const rows: TaskRow[] = [...open, ...bought].map(i => ({
      id: i.id,
      title: lang === 'zh' && i.nameZh ? i.nameZh : i.name,
      meta: [lang === 'zh' && i.noteZh ? i.noteZh : i.note, i.bought ? t(`Bought by ${who(i.bought.by)}`, `${who(i.bought.by)}已买`) : t(`Added by ${who(i.addedBy)}`, `${who(i.addedBy)}添加`)].filter(Boolean).join(' · '),
      ownerLabel: '',
      state: i.bought ? 'done' : '',
      tone: i.bought ? 'success' : 'muted',
      actions: [
        i.bought ? shop('shop-bought', t('Not bought', '没买到'), 'ghost', { itemId: i.id, bought: false }, i.id) : shop('shop-bought', t('Bought', '已买'), 'secondary', { itemId: i.id, bought: true }, i.id),
        shop('shop-remove', t('Remove', '删除'), 'ghost', { itemId: i.id }, i.id)
      ],
      // The quantity: "− 3 +". One is the least (Remove takes the item off); a bought item keeps its number.
      quantity: quantityOf(i)
    }));
    const title = `${storeName(store)} · ${runLine}`;
    if (rows.length) {
      children.push(taskList(key, title, `/${key}`));
      data[key] = rows;
    } else {
      children.push(text(`${key}-empty`, `**${title}**\n\n${t('Nothing on this list.', '清单是空的。')}`));
    }
    const actions: A2uiAction[] = [];
    if (!store.run && open.length) actions.push(shop('shop-claim', t("I'll go", '我去买'), 'secondary', { storeId: store.id }, store.id));
    if (store.run?.memberId === view.memberId) actions.push(shop('shop-release', t('Release the run', '不去了'), 'ghost', { storeId: store.id }, store.id));
    if (bought.length) actions.push(shop('shop-clear', t(`Clear bought (${bought.length})`, `清除已买（${bought.length}）`), 'ghost', { storeId: store.id }, store.id));
    if (store.custom && !items.length) actions.push(shop('shop-remove-store', t('Remove this store', '删除这家店'), 'ghost', { storeId: store.id }, store.id));
    if (actions.length) children.push({ id: `${key}-actions`, component: 'ActionBar', actions });
  }
  if (quiet.length) children.push(text('shop-quiet', `${t('Nothing on the list for', '这些商店的清单是空的')}${colon(lang)}${quiet.join(lang === 'zh' ? '、' : ', ')}`));

  children.push(text('shop-store-title', `**${t('Another store', '其他商店')}**`));
  children.push({ id: 'f-shopStoreName', component: 'TextField', name: 'shopStoreName', label: t('Store name (bakery, pet shop…)', '商店名称（面包店、宠物店…）'), default: '', maxLength: 40 });
  children.push({ id: 'shop-store-actions', component: 'ActionBar', actions: [shop('shop-add-store', t('Add store', '添加商店'), 'secondary', {}, 'form')] });
  return turn('shopping', t('Shopping', '购物'), undefined, children, data);
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
  item: itemScreen,
  services: servicesScreen,
  summary: summaryScreen,
  shopping: shoppingScreen
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
