import { useCallback, useEffect, useRef, useState } from 'react';
import { A2uiSurfaceView } from './a2ui/A2uiSurfaceView';
import { AlertBanner } from './AlertBanner';
import { A2uiSurfaceStore } from '../protocol/a2ui/store';
import { useI18n } from '../i18n/I18nContext';
import { homemindErrorTurn } from '../lib/homemindSurfaces';
import type { HomemindScreenName } from '../lib/homemindSurfaces';
import { buildSave, formValues } from '../lib/homemindForm';
import type { FormProblem } from '../lib/homemindForm';
import { addAlert, applyItemChange, closeReminder } from '../lib/homemindAlerts';
import type { AlertVerb } from '../lib/homemindAlerts';
import {
  HomemindError,
  fetchHomemindMembers,
  fetchHomemindScreen,
  homemindSignIn,
  jumpHomemindClock,
  readHomemindSession,
  runHomemindAction,
  sendHomemindWrite,
  undoHomemind,
  writeHomemindSession
} from '../transport/homemind';
import type { HomemindHealth, HomemindMember, HomemindSession, MutationResult, ScreenParams } from '../transport/homemind';
import { connectHomemindEvents } from '../transport/homemindEvents';
import type { StreamStatus } from '../transport/homemindEvents';
import type { HomemindAlert } from '../../server/homemind/types';
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
  undo?: { itemId: string; activityId: string };
}

const TABS: Array<{ screen: HomemindScreenName; en: string; zh: string }> = [
  { screen: 'my-day', en: 'My day', zh: '我的一天' },
  { screen: 'family', en: 'Family', zh: '家庭' },
  { screen: 'calendar', en: 'Calendar', zh: '日历' },
  { screen: 'search', en: 'Search', zh: '搜索' },
  { screen: 'rules', en: 'Rules', zh: '规则' },
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
  const barId = children.find(id => surface.components[id]?.actions?.some(a => a.args?.verb === 'save'));
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

function clockText(view: DemoClockView, at: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: view.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(view.now + (at - view.heardAt)));
  } catch {
    return '';
  }
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
  onIncomingHandled
}: {
  health: HomemindHealth;
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
  const [clock, setClock] = useState<DemoClockView | null>(null);
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
          case 'demo.reset':
            setAlerts([]);
            history.current = [];
            setForm({});
            setNotice(null);
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

  const onAction = async (action: A2uiAction) => {
    if (!session || busy) return;
    if (action.kind !== 'homemind') return;
    const args = action.args ?? {};
    const verb = typeof args.verb === 'string' ? args.verb : '';
    const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
    if (verb === 'add') return go({ screen: 'edit', params: { parent: str(args.parentEventId) } });
    if (verb === 'edit') return go({ screen: 'edit', params: { id: str(args.itemId) } });
    if (verb === 'back') return back();
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
      const outcome = await runHomemindAction(action, session.token);
      if (outcome.kind === 'why') {
        const source = outcome.why.source === 'ppma' ? 'PPMA' : outcome.why.source === 'model' ? tr('the model', '模型') : tr('a Homemind rule', 'Homemind 规则');
        setNotice({ text: `${outcome.why.summary ?? ''} (${tr('Source', '来源')}: ${source})`, tone: 'info' });
        return;
      }
      const removedHere = verb === 'cancel' && (nav.screen === 'edit' || nav.screen === 'item') && nav.params.id === args.itemId;
      if (removedHere) back(true);
      else refresh();
      afterWrite(
        outcome.result,
        verb === 'undo'
          ? tr('Undone.', '已撤销。')
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

  const undo = async (target: { itemId: string; activityId: string }) => {
    if (!session) return;
    setBusy(true);
    try {
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

  const noticeBar = notice ? (
    <div className={`hm-notice ${notice.tone === 'error' ? 'is-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      {notice.undo ? (
        <button type="button" onClick={() => void undo(notice.undo as { itemId: string; activityId: string })} disabled={busy}>
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
      </nav>
      {health.demo && clock ? (
        <div className="hm-demo-clock" data-demo-clock={new Date(clock.now + (tickAt - clock.heardAt)).toISOString()} data-offset={clock.offsetMs}>
          <span>
            <span className="hm-demo-tag">{tr('Demo clock', '演示时钟')}</span> <strong>{clockText(clock, tickAt)}</strong>
            {clock.offsetMs > 0 ? <em> {tr(`+${Math.round(clock.offsetMs / 60_000)} min`, `+${Math.round(clock.offsetMs / 60_000)} 分钟`)}</em> : null}
          </span>
          <button type="button" onClick={() => void jumpClock(15)} disabled={busy} aria-label={tr('+15 min (demo clock)', '+15 分钟（演示时钟）')}>
            +15 {tr('min', '分钟')}
          </button>
          <button type="button" onClick={() => void jumpClock(60)} disabled={busy} aria-label={tr('+1 h (demo clock)', '+1 小时（演示时钟）')}>
            +1 {tr('h', '小时')}
          </button>
        </div>
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
