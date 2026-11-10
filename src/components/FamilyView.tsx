import { useCallback, useEffect, useRef, useState } from 'react';
import { A2uiSurfaceView } from './a2ui/A2uiSurfaceView';
import { AlertBanner } from './AlertBanner';
import { A2uiSurfaceStore } from '../protocol/a2ui/store';
import { useI18n } from '../i18n/I18nContext';
import { homemindErrorTurn } from '../lib/homemindSurfaces';
import type { HomemindScreenName } from '../lib/homemindSurfaces';
import { buildSave, buildSettingsSave, formValues } from '../lib/homemindForm';
import type { FormProblem, SettingsProblem } from '../lib/homemindForm';
import { addAlert, applyItemChange, closeReminder } from '../lib/homemindAlerts';
import type { AlertVerb } from '../lib/homemindAlerts';
import {
  HomemindError,
  fetchHomemindMembers,
  fetchHomemindScreen,
  homemindShopping,
  homemindSignIn,
  jumpHomemindClock,
  jumpHomemindToNext,
  readHomemindSession,
  resetHomemindDemo,
  runHomemindAction,
  saveHomemindSettings,
  sendHomemindWrite,
  undoHomemind,
  writeHomemindSession
} from '../transport/homemind';
import type { HomemindHealth, HomemindMember, HomemindPreset, HomemindSession, MutationResult, ScreenParams } from '../transport/homemind';
import { connectHomemindEvents } from '../transport/homemindEvents';
import type { StreamStatus } from '../transport/homemindEvents';
import type { HomemindAlert, PpmaStatus } from '../../server/homemind/types';
import type { A2uiAction, A2uiSurface } from '../types';

/**
 * The Family tab (T3.2): demo sign-in, sub-navigation, and the Homemind screens. Every screen is an
 * A2UI surface built by the bridge; this component only renders it, keeps the form values, and turns
 * button taps into bridge calls. The server decides what a member may see and do.
 */

interface Nav {
  screen: HomemindScreenName;
  params: ScreenParams;
}

interface Notice {
  text: string;
  tone: 'info' | 'error';
  /** An item change (`itemId`), or a deleted rule (`rule`, T9.1): Undo puts it back. */
  undo?: { itemId?: string; activityId: string; rule?: boolean };
}

/** T9.1: the demo panel's scene presets, with what the presenter does next. */
const PRESETS: Array<{ id: HomemindPreset; en: string; zh: string; nextEn: string; nextZh: string }> = [
  { id: 'scene-1', en: 'Prepare Scene 1', zh: '准备场景 1', nextEn: 'Mom assigns the pickup to Dad, then "Jump to next reminder".', nextZh: '妈妈把接孩子交给爸爸，然后点“跳到下一个提醒”。' },
  { id: 'scene-2', en: 'Prepare Scene 2', zh: '准备场景 2', nextEn: 'Claims are on. Tap "Post group message" twice.', nextZh: '认领已开启。点两次“发布群消息”。' },
  { id: 'scene-3', en: 'Prepare Scene 3', zh: '准备场景 3', nextEn: 'In the Family chat: "Noa is sick today".', nextZh: '在家庭聊天里说：“诺娅今天生病了”。' },
  { id: 'scene-4', en: 'Prepare Scene 4', zh: '准备场景 4', nextEn: 'In the Family chat: "I\'m at my cousin\'s wedding from Tuesday to Saturday".', nextZh: '在家庭聊天里说：“我周二到周六参加表妹的婚礼”。' },
  { id: 'scene-5', en: 'Prepare Scene 5', zh: '准备场景 5', nextEn: 'The party and the 接龙 are in. Tap "Post group message" once.', nextZh: '派对消息和接龙已到。点一次“发布群消息”。' }
];

const TABS: Array<{ screen: HomemindScreenName; en: string; zh: string }> = [
  { screen: 'my-day', en: 'My day', zh: '我的一天' },
  { screen: 'summary', en: 'Summary', zh: '摘要' },
  { screen: 'family', en: 'Family', zh: '家庭' },
  { screen: 'shopping', en: 'Shopping', zh: '购物' },
  { screen: 'calendar', en: 'Calendar', zh: '日历' },
  { screen: 'search', en: 'Search', zh: '搜索' },
  { screen: 'rules', en: 'Rules', zh: '规则' },
  { screen: 'memory', en: 'Memory', zh: '记忆' },
  { screen: 'services', en: 'Services', zh: '服务' },
  { screen: 'activity', en: 'Activity', zh: '动态' },
  { screen: 'settings', en: 'Settings', zh: '设置' }
];

const HOME: Nav = { screen: 'my-day', params: {} };

/** Several changes in a row (a wedding opening two pickups) cause one screen read, not several. */
const REFRESH_DELAY_MS = 150;

/**
 * The surface with an error notice placed just above the bar that holds Save, so a form problem is
 * seen where the member tapped. Host-side only: the bridge's surface is not changed.
 */
export function withFormError(surface: A2uiSurface, title: string, message: string): A2uiSurface {
  const root = surface.components[surface.root];
  const children = root?.children ?? [];
  const barId = children.find(id => surface.components[id]?.actions?.some(a => a.args?.verb === 'save' || a.args?.verb === 'save-settings'));
  if (!root || !barId) return surface;
  const at = children.indexOf(barId);
  return {
    ...surface,
    components: {
      ...surface.components,
      'hm-form-error': { id: 'hm-form-error', component: 'ErrorNotice', title, body: message },
      [surface.root]: { ...root, children: [...children.slice(0, at), 'hm-form-error', ...children.slice(at)] }
    }
  };
}

/** The demo clock as last heard from the bridge, and when (real time), so the chip keeps running. */
interface DemoClockView {
  now: number;
  offsetMs: number;
  timezone: string;
  heardAt: number;
}

const CHIP_WEEKDAYS = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] } as const;

/** The demo clock's weekday and time (a preset can move it days ahead, so the weekday matters). */
function clockText(view: DemoClockView, at: number, lang: 'en' | 'zh'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: view.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(view.now + (at - view.heardAt)));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return `${day >= 0 ? `${CHIP_WEEKDAYS[lang][day]} ` : ''}${get('hour')}:${get('minute')}`;
  } catch {
    return '';
  }
}

/** How far ahead the demo clock is: "+95 min", or "+2 d 3 h" once it is a day or more. */
function offsetText(offsetMs: number, lang: 'en' | 'zh'): string {
  const minutes = Math.round(offsetMs / 60_000);
  if (minutes < 24 * 60) return lang === 'zh' ? `+${minutes} 分钟` : `+${minutes} min`;
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  return lang === 'zh' ? `+${days} 天 ${hours} 小时` : `+${days} d ${hours} h`;
}

function demoMemberFromUrl(): string | null {
  try {
    const id = new URL(window.location.href).searchParams.get('member');
    return id && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function FamilyView({
  health,
  incoming,
  onIncomingHandled,
  onOpenChat
}: {
  health: HomemindHealth;
  /** Opens the chat with the Family companion, where the board can be changed in words. */
  onOpenChat?: () => void;
  /** A Homemind button tapped outside this tab (for example on a chat card), to carry out here. */
  incoming?: A2uiAction | null;
  onIncomingHandled?: () => void;
}) {
  const { lang, tr } = useI18n();
  const [session, setSession] = useState<HomemindSession | null>(readHomemindSession);
  const [members, setMembers] = useState<HomemindMember[] | null>(null);
  const [nav, setNav] = useState<Nav>(HOME);
  const history = useRef<Nav[]>([]);
  const [surface, setSurface] = useState<A2uiSurface | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** A problem with the form being saved, shown next to Save (not in the notice at the top). */
  const [formError, setFormError] = useState<string | null>(null);
  const autoSignIn = useRef(health.demo ? demoMemberFromUrl() : null);
  const loadSeq = useRef(0);
  /** Live alerts from the stream, newest first. */
  const [alerts, setAlerts] = useState<HomemindAlert[]>([]);
  const [stream, setStream] = useState<StreamStatus | null>(null);
  /** PPMA connection (T6.1), from the stream. Shown only when it is offline. */
  const [ppma, setPpma] = useState<PpmaStatus | null>(null);
  const [clock, setClock] = useState<DemoClockView | null>(null);
  /** T9.1: the notice to show when this window's own demo reset arrives on the stream. */
  const afterReset = useRef<Notice | null>(null);
  /** Re-renders the clock chip every 20 s. */
  const [tickAt, setTickAt] = useState(() => Date.now());
  useEffect(() => {
    if (!health.demo) return;
    const timer = setInterval(() => setTickAt(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, [health.demo]);

  const errorSurface = useCallback((message: string) => A2uiSurfaceStore.fromJsonl(homemindErrorTurn(message, lang).jsonl).list()[0] ?? null, [lang]);

  const signOut = useCallback((text?: string) => {
    writeHomemindSession(null);
    setSession(null);
    setSurface(null);
    history.current = [];
    setNav(HOME);
    setNotice(text ? { text, tone: 'error' } : null);
  }, []);

  const describe = useCallback(
    (error: unknown): string => {
      if (error instanceof HomemindError) {
        if (error.status === 409 && error.code === 'stale') return tr('This changed. Here is the latest.', '内容已更新，这是最新版本。');
        if (error.code === 'blocked_by_preference') return tr('Not saved: a family preference that is never overridden rules this out (for example an allergy).', '没有保存：一条不可更改的家庭偏好排除了这一项（例如过敏）。');
        if (error.status === 501) return tr('This part of Homemind is not built yet.', 'Homemind 的这部分还没有完成。');
        if (error.status === 503) return tr('Homemind is not configured on the bridge (HOMEMIND_SECRET).', '桥接服务未配置 Homemind（HOMEMIND_SECRET）。');
        return error.message;
      }
      return error instanceof Error && error.name === 'TimeoutError' ? tr('Homemind did not answer in time.', 'Homemind 响应超时。') : tr('Homemind could not be reached.', '无法连接 Homemind。');
    },
    [tr]
  );

  const load = useCallback(
    async (target: Nav, token: string) => {
      const seq = ++loadSeq.current;
      try {
        const screen = await fetchHomemindScreen(token, target.screen, lang, target.params);
        if (seq !== loadSeq.current) return;
        setSurface(screen.surface);
      } catch (error) {
        if (seq !== loadSeq.current) return;
        if (error instanceof HomemindError && error.status === 401) return signOut(tr('Your demo sign-in ended. Pick a member again.', '演示登录已结束，请重新选择成员。'));
        setSurface(errorSurface(describe(error)));
      }
    },
    [lang, signOut, tr, describe, errorSurface]
  );

  // The member picker: the family, for a window that has no session yet.
  useEffect(() => {
    if (session) return;
    let live = true;
    fetchHomemindMembers().then(
      body => {
        if (!live) return;
        setMembers(body.members);
        const wanted = autoSignIn.current;
        autoSignIn.current = null;
        if (wanted && body.members.some(m => m.id === wanted && m.hasAccount)) void pick(wanted);
      },
      error => live && setNotice({ text: describe(error), tone: 'error' })
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Every screen change, member change and language change reads the screen again.
  useEffect(() => {
    if (session) void load(nav, session.token);
  }, [session, nav, load]);

  // The stream handler outlives renders, so it reads the current screen and loader through a ref.
  const latest = useRef({ nav, load, signOut, tr });
  latest.current = { nav, load, signOut, tr };

  // Live updates (T3.3): one stream per signed-in window. A change re-reads the screen, except the
  // form being typed in (its Save gets "This changed. Here is the latest." instead).
  useEffect(() => {
    if (!session) return;
    const { token } = session;
    const memberId = session.member.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A stopped stream still reports 'closed' a moment later; by then it may belong to an old member.
    let active = true;
    const refreshSoon = (force = false) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { nav: current, load: read } = latest.current;
        if (force || current.screen !== 'edit') void read(current, token);
      }, REFRESH_DELAY_MS);
    };
    setAlerts([]);
    const stop = connectHomemindEvents({
      token,
      onStatus: status => {
        if (!active) return;
        setStream(status);
        if (status === 'signed-out') {
          const { signOut: out, tr: t } = latest.current;
          out(t('Your demo sign-in ended. Pick a member again.', '演示登录已结束，请重新选择成员。'));
        }
      },
      onMessage: message => {
        if (!active) return;
        switch (message.event) {
          case 'hello':
            setPpma(message.data.ppma ?? null);
            setClock({ now: Date.parse(message.data.now), offsetMs: message.data.offsetMs, timezone: message.data.timezone, heardAt: Date.now() });
            // Covers anything missed while the stream was down.
            return refreshSoon();
          case 'clock':
            setClock({ now: Date.parse(message.data.now), offsetMs: message.data.offsetMs, timezone: message.data.timezone, heardAt: Date.now() });
            setTickAt(Date.now());
            return refreshSoon();
          case 'alert.closed':
            return setAlerts(list => closeReminder(list, message.data.reminderId));
          case 'item.changed':
            setAlerts(list => applyItemChange(list, message.data.itemId, message.data.item, memberId));
            return refreshSoon();
          case 'alert':
            return setAlerts(list => addAlert(list, message.data));
          case 'settings.changed':
          case 'preferences.changed':
          case 'memory.changed':
          case 'actions.changed':
          case 'services.changed':
          case 'shopping.changed':
            return refreshSoon();
          case 'ppma.status':
            return setPpma(message.data.status);
          case 'demo.reset':
            setAlerts([]);
            history.current = [];
            setForm({});
            // T9.1: the window that pressed a preset keeps its "ready, next do..." notice.
            setNotice(afterReset.current);
            afterReset.current = null;
            setNav(HOME);
            return refreshSoon(true);
        }
      }
    });
    return () => {
      active = false;
      clearTimeout(timer);
      stop();
      setStream(null);
      setPpma(null);
    };
  }, [session]);

  useEffect(() => {
    setFormError(null);
    // Only this element's own scrollTop: scrollTo() here also moved the stage sideways.
    const main = document.getElementById('main-content');
    if (main) main.scrollTop = 0;
  }, [nav]);

  // A new form error is scrolled into view with the Save bar under it. Only the main area scrolls
  // (scrollIntoView would also move the stage sideways).
  useEffect(() => {
    if (!formError) return;
    const main = document.getElementById('main-content');
    const error = main?.querySelector('.hm-family .a2ui-error');
    if (!main || !error) return;
    const bar = error.nextElementSibling ?? error;
    const box = main.getBoundingClientRect();
    const top = error.getBoundingClientRect().top;
    const bottom = bar.getBoundingClientRect().bottom;
    // Bottom of the Save bar a little above the bottom of the area, unless the error would leave the top.
    main.scrollTop += Math.min(bottom - box.bottom + 24, top - box.top - 8);
  }, [formError]);

  const pick = async (memberId: string) => {
    setBusy(true);
    try {
      const next = await homemindSignIn(memberId);
      writeHomemindSession(next);
      history.current = [];
      setNav(HOME);
      setNotice(null);
      setSession(next);
    } catch (error) {
      setNotice({ text: describe(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const go = (next: Nav, { replace = false, keepNotice = false } = {}) => {
    if (!replace) history.current = [...history.current, nav].slice(-20);
    setForm({});
    if (!keepNotice) setNotice(null);
    setNav(next);
  };

  const back = (keepNotice = false) => {
    const previous = history.current.pop() ?? HOME;
    setForm({});
    if (!keepNotice) setNotice(null);
    setNav(previous);
  };

  const refresh = () => {
    if (session) void load(nav, session.token);
  };

  const afterWrite = (result: MutationResult, text: string) => {
    const opened = result.opened?.length ?? 0;
    const conflicts = result.conflicts?.length ?? 0;
    const extra = opened
      ? tr(` Someone is away then, so ${opened} item(s) now ask "Who's taking this?".`, ` 有人那时没空，${opened} 个事项已改为"谁来负责？"。`)
      : conflicts
        ? tr(` ${conflicts} item(s) clash with who is away. Check the Family screen.`, ` ${conflicts} 个事项与不在的成员冲突，请查看家庭页面。`)
        : '';
    const first = result.items?.[0]?.id;
    setNotice({ text: text + extra, tone: 'info', ...(first && result.activityId ? { undo: { itemId: first, activityId: result.activityId } } : {}) });
  };

  const problemText = (problem: FormProblem): string => {
    switch (problem) {
      case 'title':
        return tr('Add a title.', '请填写标题。');
      case 'date':
        return tr('Check the date.', '请检查日期。');
      case 'time':
      case 'endTime':
        return tr('Check the time.', '请检查时间。');
      case 'endBeforeStart':
        return tr('The end time must be after the start time.', '结束时间必须晚于开始时间。');
      case 'endNeedsStart':
        return tr('Add a start time before an end time.', '请先填写开始时间。');
      case 'awayNeedsEnd':
        return tr('Add an end time, so Homemind knows how long they are away.', '请填写结束时间，这样 Homemind 才知道对方离开多久。');
      default:
        return tr('Choose what kind of item this is.', '请选择事项类型。');
    }
  };

  const save = async (args: Record<string, unknown>, token: string) => {
    if (!surface) return;
    const { values, defaults } = formValues(surface, form);
    const plan = buildSave(args, values, defaults);
    if (!plan.ok) return setFormError(problemText(plan.problem));
    setFormError(null);
    const showItem = (itemId: string) => {
      // After a save, the short view of the item (details, Edit, Remove), not the whole form again.
      const previous = history.current[history.current.length - 1];
      if (previous?.screen === 'item' && previous.params.id === itemId) back(true);
      else go({ screen: 'item', params: { id: itemId } }, { replace: true, keepNotice: true });
    };
    if (!plan.request) {
      if (typeof args.itemId === 'string') showItem(args.itemId);
      else back();
      return;
    }
    let result: MutationResult;
    try {
      result = await sendHomemindWrite(token, plan.request);
    } catch (error) {
      if (error instanceof HomemindError && (error.status === 400 || error.status === 403)) return setFormError(error.message);
      throw error;
    }
    const saved = result.items?.[0];
    if (saved && saved.type !== 'preparation') {
      showItem(saved.id);
      afterWrite(result, saved.type === 'event' && plan.request.method === 'POST' ? tr('Saved. You can add preparations below.', '已保存。可以在下方添加准备事项。') : tr('Saved.', '已保存。'));
      return;
    }
    // A preparation goes back to its event.
    back(true);
    afterWrite(result, tr('Saved.', '已保存。'));
  };

  const settingsProblemText = (problem: SettingsProblem): string => {
    switch (problem) {
      case 'quietBoth':
        return tr('Fill in both quiet-hours times, or leave both empty.', '请填写免打扰的开始和结束时间，或两项都留空。');
      case 'quietSame':
        return tr('Quiet hours must start and end at different times.', '免打扰的开始和结束时间不能相同。');
      case 'quietTime':
        return tr('Check the time.', '请检查时间。');
      default:
        return tr('The backup contact name is too long.', '备用联系人姓名太长。');
    }
  };

  const saveSettings = async (args: Record<string, unknown>, token: string) => {
    if (!surface) return;
    const { values, defaults } = formValues(surface, form);
    const plan = buildSettingsSave(args, values, defaults);
    if (!plan.ok) return setFormError(settingsProblemText(plan.problem));
    setFormError(null);
    if (!plan.body) return setNotice({ text: tr('Nothing changed.', '没有修改。'), tone: 'info' });
    try {
      await saveHomemindSettings(token, plan.body);
    } catch (error) {
      if (error instanceof HomemindError && (error.status === 400 || error.status === 403)) return setFormError(error.message);
      throw error;
    }
    setForm({});
    refresh();
    setNotice({ text: tr('Settings saved.', '设置已保存。'), tone: 'info' });
  };

  /** Shopping: one request, then the screen again. Form fields that were sent are emptied. */
  const shoppingRequest = async (request: Parameters<typeof homemindShopping>[1], clear: string[], done: string) => {
    if (!session) return;
    setBusy(true);
    try {
      const result = await homemindShopping(session.token, request);
      if (result.duplicateOf) {
        // Already on that list: the Shopping screen says which item it is.
        go({ screen: 'shopping', params: { id: result.duplicateOf } }, { replace: nav.screen === 'shopping' });
        return;
      }
      if (clear.length) setForm(f => Object.fromEntries(Object.entries(f).filter(([k]) => !clear.includes(k))));
      // An answered "already on the list?" question goes away with the change.
      if (nav.screen === 'shopping' && nav.params.id) go({ screen: 'shopping', params: {} }, { replace: true });
      else refresh();
      setNotice({ text: done, tone: 'info' });
    } catch (error) {
      if (error instanceof HomemindError && error.status === 401) return signOut(tr('Your demo sign-in ended. Pick a member again.', '演示登录已结束，请重新选择成员。'));
      setNotice({ text: describe(error), tone: 'error' });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const onAction = async (action: A2uiAction) => {
    if (!session || busy) return;
    if (action.kind !== 'homemind') return;
    const args = action.args ?? {};
    const verb = typeof args.verb === 'string' ? args.verb : '';
    const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
    if (verb === 'add') return go({ screen: 'edit', params: { parent: str(args.parentEventId) } });
    if (verb === 'edit') return go({ screen: 'edit', params: { id: str(args.itemId) } });
    if (verb === 'back') return back();
    // T8.2: correct a saved preference (Scene 5): the Memory tab's small form.
    if (verb === 'open-correct-preference') return go({ screen: 'memory', params: { id: str(args.preferenceId) } });
    if (verb === 'correct-preference') {
      const { values } = surface ? formValues(surface, form) : { values: {} as Record<string, unknown> };
      const textValue = String(values.prefText ?? '').trim();
      const reasonValue = String(values.prefReason ?? '').trim();
      if (!textValue) return setNotice({ text: tr('Write what Homemind should remember.', '请写下 Homemind 应该记住的内容。'), tone: 'error' });
      setBusy(true);
      try {
        await runHomemindAction(
          { ...action, args: { verb: 'save-preference', id: args.preferenceId, text: textValue, ...(reasonValue ? { reason: reasonValue } : {}), strength: args.strength, ...(args.aboutMemberId ? { aboutMemberId: args.aboutMemberId } : {}), ...(args.scope ? { scope: args.scope } : {}) } },
          session.token
        );
        back(true);
        setNotice({ text: tr('Preference corrected. The next suggestions use it.', '偏好已更正，之后的建议会按它来。'), tone: 'info' });
      } catch (error) {
        setNotice({ text: describe(error), tone: 'error' });
      } finally {
        setBusy(false);
      }
      return;
    }
    // Shopping: add to a store's list, mark bought, take or release a store's run, clear, add a store.
    if (verb.startsWith('shop-')) {
      const { values } = surface ? formValues(surface, form) : { values: {} as Record<string, unknown> };
      const field = (name: string) => String(values[name] ?? '').trim();
      switch (verb) {
        case 'shop-add': {
          if (!field('shopItem')) return setNotice({ text: tr('Write what to buy first.', '请先写下要买什么。'), tone: 'error' });
          return shoppingRequest({ action: 'add-item', storeId: field('shopStore'), name: field('shopItem'), ...(field('shopNote') ? { note: field('shopNote') } : {}) }, ['shopItem', 'shopNote'], tr('Added to the list.', '已加到清单。'));
        }
        case 'shop-add-store': {
          if (!field('shopStoreName')) return setNotice({ text: tr('Write the name of the store first.', '请先写下商店名称。'), tone: 'error' });
          return shoppingRequest({ action: 'add-store', name: field('shopStoreName') }, ['shopStoreName'], tr('Store added.', '已添加商店。'));
        }
        case 'shop-bought':
          return shoppingRequest({ action: 'bought', itemId: str(args.itemId) ?? '', bought: args.bought === true }, [], args.bought === true ? tr('Marked as bought.', '已标记为已买。') : tr('Back on the list.', '已放回清单。'));
        case 'shop-remove':
          return shoppingRequest({ action: 'remove-item', itemId: str(args.itemId) ?? '' }, [], tr('Removed from the list.', '已从清单删除。'));
        case 'shop-claim':
          return shoppingRequest({ action: 'claim', storeId: str(args.storeId) ?? '' }, [], tr("You're going. The family sees it.", '你去买，全家都看得到。'));
        case 'shop-release':
          return shoppingRequest({ action: 'release', storeId: str(args.storeId) ?? '' }, [], tr('Released. Someone else can take it.', '已放弃，其他人可以认领。'));
        case 'shop-clear':
          return shoppingRequest({ action: 'clear-bought', storeId: str(args.storeId) ?? '' }, [], tr('Bought items cleared.', '已清除已买的东西。'));
        case 'shop-keep':
          return go({ screen: 'shopping', params: {} }, { replace: true });
        case 'shop-remove-store':
          return shoppingRequest({ action: 'remove-store', storeId: str(args.storeId) ?? '' }, [], tr('Store removed.', '已删除商店。'));
      }
      return;
    }
    // T9.1: a rule's details, and a parent's changes to it.
    if (verb === 'open-rule') return go({ screen: 'rules', params: { id: str(args.ruleId) } });
    if (verb === 'save-rule' || verb === 'rule-delete') {
      setBusy(true);
      try {
        if (verb === 'rule-delete') {
          const outcome = await runHomemindAction(action, session.token);
          const activityId = outcome.kind === 'mutation' ? outcome.result.activityId : undefined;
          back(true);
          setNotice({ text: tr('Rule deleted. Its waiting cards were withdrawn.', '规则已删除，等待中的卡片已撤回。'), tone: 'info', ...(activityId ? { undo: { activityId, rule: true } } : {}) });
          return;
        }
        const { values, defaults } = surface ? formValues(surface, form) : { values: {} as Record<string, unknown>, defaults: {} as Record<string, unknown> };
        const capText = String(values.ruleMaxPrice ?? '').trim();
        const timeText = String(values.ruleTime ?? '').trim();
        const cap = Number(capText);
        if (!/^\d{1,4}$/.test(capText) || cap < 1 || cap > 5000) return setNotice({ text: tr('The price cap is a whole number from 1 to 5000.', '价格上限是 1 到 5000 之间的整数。'), tone: 'error' });
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeText)) return setNotice({ text: tr('Check the time (HH:MM).', '请检查时间（HH:MM）。'), tone: 'error' });
        const update = { ...(capText !== String(defaults.ruleMaxPrice ?? '') ? { maxPrice: cap } : {}), ...(timeText !== String(defaults.ruleTime ?? '') ? { time: timeText } : {}) };
        if (!Object.keys(update).length) return setNotice({ text: tr('Nothing changed.', '没有修改。'), tone: 'info' });
        await runHomemindAction({ ...action, args: { verb: 'rule-update', ruleId: args.ruleId, ...update } }, session.token);
        setForm({});
        refresh();
        setNotice({ text: tr('Rule saved. A card that was waiting is prepared again from the new rule.', '规则已保存。正在等待的卡片会按新规则重新准备。'), tone: 'info' });
      } catch (error) {
        if (error instanceof HomemindError && error.status === 401) return signOut(tr('Your demo sign-in ended. Pick a member again.', '演示登录已结束，请重新选择成员。'));
        setNotice({ text: describe(error), tone: 'error' });
        refresh();
      } finally {
        setBusy(false);
      }
      return;
    }
    // T8.2: the evening summary or the week ahead.
    if (verb === 'summary-period') return go({ screen: 'summary', params: args.period === 'week' ? { period: 'week' } : {} }, { replace: nav.screen === 'summary' });
    if (verb === 'search') {
      const q = String(form.q ?? (surface ? formValues(surface, {}).values.q : '') ?? '').trim();
      return go({ screen: 'search', params: { q } }, { replace: nav.screen === 'search' });
    }
    setBusy(true);
    try {
      if (verb === 'save') {
        await save(args, session.token);
        return;
      }
      if (verb === 'save-settings') {
        await saveSettings(args, session.token);
        return;
      }
      const outcome = await runHomemindAction(action, session.token);
      if (outcome.kind === 'why') {
        const source = outcome.why.source === 'ppma' ? 'PPMA' : outcome.why.source === 'model' ? tr('the model', '模型') : tr('a Homemind rule', 'Homemind 规则');
        const explained = outcome.ppma?.state === 'ready' ? ` ${tr('PPMA explains', 'PPMA 的解释')}: ${outcome.ppma.summary || outcome.ppma.rationale || ''}` : outcome.ppma?.state === 'loading' ? ` ${tr('Asking PPMA for its explanation…', '正在向 PPMA 询问解释…')}` : '';
        const summary = lang === 'zh' && outcome.why.summaryZh ? outcome.why.summaryZh : outcome.why.summary ?? '';
        setNotice({ text: `${summary} (${tr('Source', '来源')}: ${source})${explained}`, tone: 'info' });
        return;
      }
      const removedHere = verb === 'cancel' && (nav.screen === 'edit' || nav.screen === 'item') && nav.params.id === args.itemId;
      if (removedHere) back(true);
      else refresh();
      afterWrite(
        outcome.result,
        verb === 'undo' || verb === 'undo-preference'
          ? tr('Undone.', '已撤销。')
          : verb === 'save-preference'
            ? tr('Preference saved.', '偏好已保存。')
          : verb === 'memory-correct'
            ? tr('Correction sent to PPMA. It shows here until PPMA has applied it.', '更正已发送给 PPMA，在 PPMA 处理完成前会显示在这里。')
          : verb === 'inbox-add'
            ? tr("Added as a suggestion that only the mailbox owners see. Approve it to make it the family's.", '已作为建议加入，只有收件箱的主人看得到。批准后才会成为全家的事项。')
          : verb === 'post-group-message'
            ? tr('A new message arrived in the simulated group.', '模拟群里收到一条新消息。')
          : verb === 'update-group-message'
            ? tr('The messages in the simulated group were edited. See My day for what depends on them.', '模拟群里的消息被修改了。与之有关的事项见“我的一天”。')
          : verb === 'source-change'
            ? args.action === 'apply'
              ? tr('Changes applied. Undo is on the card.', '已应用更改，卡片上可以撤销。')
              : args.action === 'keep'
                ? tr('Kept as it was. Undo is on the card.', '已保持原样，卡片上可以撤销。')
                : args.action === 'discard'
                  ? tr('Discarded. Undo is on the card.', '已舍弃，卡片上可以撤销。')
                  : tr('Undone. The change waits for a decision again.', '已撤销，这项更改重新等待决定。')
          : verb === 'situation'
            ? args.action === 'apply'
              ? args.proposalId === 'all'
                ? tr('All suggestions applied. Each has its own Undo.', '已全部采纳，每一项都可以单独撤销。')
                : tr('Applied. Undo is on the row.', '已采纳，可以在这一行撤销。')
              : args.action === 'dismiss'
                ? tr('Left as it is. Undo is on the row.', '保持原样，可以在这一行撤销。')
                : tr('Undone. The suggestion waits again.', '已撤销，这条建议重新等待决定。')
          : verb === 'confirm-card'
            ? tr('Done. It went to the simulated service only.', '已完成，只发送到模拟服务。')
          : verb === 'cancel-card'
            ? tr('Cancelled. Nothing happened.', '已取消，什么都没发生。')
          : verb === 'rule-toggle'
            ? tr('Rule updated.', '规则已更新。')
          : verb === 'group-policy'
            ? tr('Group setting saved.', '群设置已保存。')
          : verb === 'group-change'
            ? tr('Change sent to the simulated group. See the sign-up and the new preparations.', '更改已发到模拟群。请看接龙和新的准备事项。')
          : verb === 'run-rule'
            ? tr('The rule looked at the calendar. See the result here and on My day.', '规则已查看日程。结果见此处和“我的一天”。')
          : verb === 'remove-preference'
            ? tr('Preference removed. PPMA was told.', '偏好已删除，已通知 PPMA。')
          : verb === 'cancel'
            ? tr('Removed.', '已删除。')
            : verb === 'snooze'
              ? tr('OK, a reminder again in 10 minutes.', '好的，10 分钟后再提醒。')
              : tr('Done.', '已完成。')
      );
    } catch (error) {
      if (error instanceof HomemindError && error.status === 401) return signOut(tr('Your demo sign-in ended. Pick a member again.', '演示登录已结束，请重新选择成员。'));
      setNotice({ text: describe(error), tone: 'error' });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // A Homemind button tapped elsewhere (chat cards, T5.2) is carried out here.
  useEffect(() => {
    if (!incoming || !session) return;
    void onAction(incoming);
    onIncomingHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, session]);

  const undo = async (target: NonNullable<Notice['undo']>) => {
    if (!session) return;
    setBusy(true);
    try {
      if (target.rule) {
        // T9.1: a deleted rule comes back as it was.
        await runHomemindAction({ id: `homemind.rule-restore:${target.activityId}`, label: 'undo', kind: 'homemind', args: { verb: 'rule-restore', activityId: target.activityId } }, session.token);
        setNotice({ text: tr('Undone. The rule is back.', '已撤销，规则已恢复。'), tone: 'info' });
        refresh();
        return;
      }
      if (!target.itemId) return;
      await undoHomemind(session.token, target.itemId, target.activityId);
      setNotice({ text: tr('Undone.', '已撤销。'), tone: 'info' });
      // An undone create removes the item, so an edit screen for it would show "not on your board".
      if ((nav.screen === 'edit' || nav.screen === 'item') && nav.params.id === target.itemId) back(true);
      else refresh();
    } catch (error) {
      setNotice({ text: describe(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const onAlertButton = (alert: HomemindAlert, verb: AlertVerb) => {
    setAlerts(list => list.filter(a => a.id !== alert.id));
    if (verb === 'dismiss') return;
    // T8.2: a group message opens the group on Services; the evening summary opens the summary.
    if (verb === 'open' && alert.kind === 'message') return go({ screen: 'services', params: {} });
    if (verb === 'open' && alert.kind === 'summary') return go({ screen: 'summary', params: {} });
    if (verb === 'open') return go({ screen: 'item', params: { id: alert.itemId } });
    const args: Record<string, unknown> = { verb, itemId: alert.itemId, version: alert.itemVersion };
    // "I'll take it" on an item assigned to someone else: assign it to yourself.
    if (verb === 'take') Object.assign(args, { verb: 'assign', memberId: session?.member.id });
    if (alert.reminderId && (verb === 'ack' || verb === 'snooze')) args.reminderId = alert.reminderId;
    void onAction({ id: `homemind.${String(args.verb)}:${alert.itemId}`, label: verb, kind: 'homemind', args });
  };

  const jumpClock = async (minutes: number) => {
    if (!session || busy) return;
    setBusy(true);
    try {
      const result = await jumpHomemindClock(session.token, minutes);
      setClock({ now: Date.parse(result.now), offsetMs: result.offsetMs, timezone: result.timezone, heardAt: Date.now() });
      setTickAt(Date.now());
      refresh();
    } catch (error) {
      setNotice({ text: describe(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // --- T9.1: the demo panel ---------------------------------------------------------------------------

  /** Runs one panel control: busy while it runs, its error as a notice. */
  const demoControl = async (run: (token: string) => Promise<void>) => {
    if (!session || busy) return;
    setBusy(true);
    try {
      await run(session.token);
    } catch (error) {
      if (error instanceof HomemindError && error.status === 401) return signOut(tr('Your demo sign-in ended. Pick a member again.', '演示登录已结束，请重新选择成员。'));
      afterReset.current = null;
      setNotice({ text: describe(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const heard = (result: { now: string; offsetMs: number; timezone: string }) => {
    setClock({ now: Date.parse(result.now), offsetMs: result.offsetMs, timezone: result.timezone, heardAt: Date.now() });
    setTickAt(Date.now());
  };

  /** A reset clears every window's notice when its `demo.reset` arrives; this window then shows what to do next. */
  const reset = async (token: string, preset: HomemindPreset | undefined, done: Notice) => {
    afterReset.current = done;
    const result = await resetHomemindDemo(token, preset);
    heard(result);
    history.current = [];
    setForm({});
    setNav(HOME);
    setNotice(done);
  };

  const prepareScene = (p: (typeof PRESETS)[number]) => async (token: string) => {
    await reset(token, p.id, { text: `${tr(`${p.en.replace('Prepare ', '')} is ready.`, `${p.zh.replace('准备', '')}已就绪。`)} ${tr(p.nextEn, p.nextZh)}`, tone: 'info' });
  };

  const resetNow = (token: string) => reset(token, undefined, { text: tr('Reset: a fresh board at the current time.', '已重置：按当前时间生成新的看板。'), tone: 'info' });

  const jumpToNext = async (token: string) => {
    const result = await jumpHomemindToNext(token);
    heard(result);
    refresh();
    setNotice({ text: result.kind === 'summary' ? tr('The demo clock moved to the evening summary.', '演示时钟已跳到晚间摘要。') : tr('The demo clock moved to the next reminder.', '演示时钟已跳到下一个提醒。'), tone: 'info' });
  };

  /** A panel button that is also a card button elsewhere (group message, rule card): the same path and notice. */
  const demoAction = (verb: 'post-group-message' | 'update-group-message' | 'run-rule') => onAction({ id: `homemind.${verb}:panel`, label: verb, kind: 'homemind', args: { verb } });

  const noticeBar = notice ? (
    <div className={`hm-notice ${notice.tone === 'error' ? 'is-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      {notice.undo ? (
        <button type="button" onClick={() => void undo(notice.undo as NonNullable<Notice['undo']>)} disabled={busy}>
          {tr('Undo', '撤销')}
        </button>
      ) : null}
    </div>
  ) : null;

  if (!session) {
    return (
      <section className="hm-family hm-picker" aria-labelledby="hm-picker-title">
        <h2 id="hm-picker-title">{tr('Who is using Homemind?', '谁在使用 Homemind？')}</h2>
        <p>
          <span className="hm-demo-tag">{tr('Demo sign-in', '演示登录')}</span> {tr('Pick a member. This is not real authentication.', '选择一位成员。这不是真实的身份验证。')}
        </p>
        {noticeBar}
        {members ? (
          <ul className="hm-picker-list">
            {members
              .filter(m => m.hasAccount)
              .map(m => (
                <li key={m.id}>
                  <button type="button" onClick={() => void pick(m.id)} disabled={busy} data-member={m.id}>
                    <strong>{lang === 'zh' && m.nameZh ? m.nameZh : m.name}</strong>
                    <em>{m.role === 'parent' ? tr('Parent', '家长') : m.role === 'teen' ? tr('Teen', '青少年') : tr('Child', '孩子')}</em>
                  </button>
                </li>
              ))}
          </ul>
        ) : notice ? null : (
          <p>{tr('Loading the family…', '正在加载家庭成员…')}</p>
        )}
      </section>
    );
  }

  const name = lang === 'zh' && session.member.nameZh ? session.member.nameZh : session.member.name;
  return (
    <section className="hm-family" aria-label="Homemind" data-member={session.member.id} data-screen={nav.screen}>
      <div className="hm-who">
        <span>
          {tr('Signed in as', '当前身份')} <strong>{name}</strong> · <span className="hm-demo-tag">{tr('Demo sign-in', '演示登录')}</span>
          {stream ? (
            <>
              {' '}
              <span className={`hm-live is-${stream}`} data-stream={stream}>
                {stream === 'live' ? tr('Live', '实时') : stream === 'connecting' ? tr('Connecting…', '连接中…') : tr('Reconnecting…', '重新连接中…')}
              </span>
            </>
          ) : null}
          {ppma === 'offline' ? (
            <>
              {' '}
              <span className="hm-live is-ppma-offline" data-ppma="offline" title={tr('Long-term memory is not reachable. The board, reminders and alerts keep working.', '长期记忆暂时无法连接。看板、提醒和通知照常工作。')}>
                {tr('PPMA offline', 'PPMA 离线')}
              </span>
            </>
          ) : null}
        </span>
        <button type="button" onClick={() => signOut()}>
          {tr('Switch member', '切换成员')}
        </button>
      </div>
      <nav className="hm-subnav" aria-label={tr('Family screens', '家庭页面')}>
        {TABS.map(tab => (
          <button
            key={tab.screen}
            type="button"
            aria-current={nav.screen === tab.screen ? 'page' : undefined}
            onClick={() => {
              history.current = [];
              setForm({});
              setNotice(null);
              setNav({ screen: tab.screen, params: {} });
            }}
          >
            {tr(tab.en, tab.zh)}
          </button>
        ))}
        <button type="button" aria-current={nav.screen === 'edit' && !nav.params.id ? 'page' : undefined} onClick={() => go({ screen: 'edit', params: {} })}>
          + {tr('Add', '添加')}
        </button>
        {onOpenChat ? (
          <button type="button" className="hm-subnav-chat" onClick={onOpenChat}>
            {tr('Chat with Homemind', '和 Homemind 聊天')}
          </button>
        ) : null}
      </nav>
      {health.demo && clock ? (
        <div className="hm-demo-clock" data-demo-clock={new Date(clock.now + (tickAt - clock.heardAt)).toISOString()} data-offset={clock.offsetMs}>
          <span>
            <span className="hm-demo-tag">{tr('Demo clock', '演示时钟')}</span> <strong>{clockText(clock, tickAt, lang)}</strong>
            {clock.offsetMs > 0 ? <em> {offsetText(clock.offsetMs, lang)}</em> : null}
          </span>
          <button type="button" onClick={() => void jumpClock(15)} disabled={busy} aria-label={tr('+15 min (demo clock)', '+15 分钟（演示时钟）')}>
            +15 {tr('min', '分钟')}
          </button>
          <button type="button" onClick={() => void jumpClock(60)} disabled={busy} aria-label={tr('+1 h (demo clock)', '+1 小时（演示时钟）')}>
            +1 {tr('h', '小时')}
          </button>
        </div>
      ) : null}
      {health.demo ? (
        // T9.1: the presenter's panel. Closed by default, so the audience sees the product, not the controls.
        <details className="hm-demo-panel" data-demo-panel>
          <summary>
            <span className="hm-demo-tag">{tr('Demo panel', '演示面板')}</span> {tr('Scenes, clock and simulated messages', '场景、时钟和模拟消息')}
          </summary>
          <p className="hm-demo-panel-note">{tr('Each scene starts from a fresh board, with the demo clock where that scene works. Both windows follow.', '每个场景都从新的看板开始，演示时钟会调到适合该场景的时间。两个窗口会一起更新。')}</p>
          <div className="hm-demo-panel-row" role="group" aria-label={tr('Scene presets', '场景预设')}>
            {PRESETS.map(p => (
              <button key={p.id} type="button" onClick={() => void demoControl(prepareScene(p))} disabled={busy} data-preset={p.id}>
                {tr(p.en, p.zh)}
              </button>
            ))}
          </div>
          <div className="hm-demo-panel-row" role="group" aria-label={tr('Demo clock', '演示时钟')}>
            <button type="button" onClick={() => void jumpClock(15)} disabled={busy}>
              +15 {tr('min', '分钟')}
            </button>
            <button type="button" onClick={() => void jumpClock(60)} disabled={busy}>
              +1 {tr('h', '小时')}
            </button>
            <button type="button" onClick={() => void demoControl(jumpToNext)} disabled={busy}>
              {tr('Jump to next reminder', '跳到下一个提醒')}
            </button>
          </div>
          <div className="hm-demo-panel-row" role="group" aria-label={tr('Simulated services', '模拟服务')}>
            <button type="button" onClick={() => void demoAction('post-group-message')} disabled={busy}>
              {tr('Post group message', '发布群消息')}
            </button>
            <button type="button" onClick={() => void demoAction('update-group-message')} disabled={busy}>
              {tr('Update message', '修改群消息')}
            </button>
            <button type="button" onClick={() => void demoAction('run-rule')} disabled={busy}>
              {tr('Prepare the next card now', '立即准备下一张卡片')}
            </button>
          </div>
          <div className="hm-demo-panel-row" role="group" aria-label={tr('Reset', '重置')}>
            <button type="button" className="is-danger" onClick={() => void demoControl(resetNow)} disabled={busy}>
              {tr('Reset (now)', '重置（当前时间）')}
            </button>
          </div>
        </details>
      ) : null}
      <AlertBanner alerts={alerts} lang={lang} busy={busy} onButton={onAlertButton} />
      {noticeBar}
      {formError ? (
        <span className="hm-visually-hidden" role="alert">
          {formError}
        </span>
      ) : null}
      {surface ? (
        <A2uiSurfaceView
          key={`${surface.id}-${nav.params.id ?? ''}-${nav.params.parent ?? ''}`}
          surface={formError ? withFormError(surface, tr('Not saved yet', '还没有保存'), formError) : surface}
          onAction={action => void onAction(action)}
          form={form}
          onInput={(field, value) => setForm(previous => ({ ...previous, [field]: value }))}
        />
      ) : (
        <p className="hm-loading">{tr('Loading…', '加载中…')}</p>
      )}
    </section>
  );
}
