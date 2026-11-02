/**
 * Epic Replay -> A2UI surface builders.
 *
 * Pure functions: they take what the Epic Replay server returns (styles, run state, play card)
 * and produce A2UI v0.9.1 JSONL envelopes. The bridge (server/epic.ts) streams these to the
 * browser, and the browser renders them with the normal A2UI store and renderer. Nothing here
 * touches the network.
 */
import type { A2uiComponent } from '../types';

export type EpicLang = 'en' | 'zh';

export const EPIC_SURFACE_ID = 'epic-replay';

export interface EpicStyle {
  id: string;
  name: string;
  description?: string;
  sample_line?: string;
  default?: boolean;
}

export interface EpicStep {
  n: number;
  name: string;
  status: 'waiting' | 'running' | 'waiting_user' | 'done' | 'failed';
  duration_s?: number | null;
}

export interface EpicRunState {
  run_id: string;
  status: string;
  style?: string | null;
  language?: string;
  cost_usd?: number;
  steps?: EpicStep[];
  step_n?: number;
  time_left?: string;
  message?: string | null;
  has_video?: boolean;
}

export interface EpicPlayEvent {
  id: string;
  action?: string;
  confidence?: number;
  source?: string;
  t_start?: number;
}

export interface EpicPlayCard {
  run_id: string;
  play_sheet: {
    activity?: { value?: string | null } | null;
    outcome_summary?: { value?: string | null } | null;
    events?: EpicPlayEvent[];
    actors?: Array<{ user_name?: string | null; followed?: boolean }>;
    sensitive?: { flag?: boolean; checked?: boolean };
  };
  climax: { frame: number; t: number; neighbours?: string[] };
  other_moments?: Array<{ frame: number; t: number; reason?: string }>;
  highlighted?: string[];
  cost_estimate_usd?: number;
}

const T = {
  title: { en: 'Epic Replay', zh: 'Epic Replay 精彩回放' },
  startSub: { en: 'Turn a short clip into a narrated slow-motion replay', zh: '把短视频变成带解说的慢动作回放' },
  intro: {
    en: 'Pick a 3 to 30 second clip, a narrator and a language. DigitalMate drives each step; the video is made on your Epic Replay server.',
    zh: '选择 3 到 30 秒的视频、解说风格和语言。每一步由 DigitalMate 驱动，视频在你的 Epic Replay 服务器上生成。'
  },
  clip: { en: 'Clip', zh: '视频' },
  pick: { en: 'Choose a clip', zh: '选择视频' },
  narrator: { en: 'Narrator', zh: '解说风格' },
  language: { en: 'Narration language', zh: '解说语言' },
  player: { en: 'Name to use for the person in focus (optional)', zh: '画面主角的名字（可选）' },
  consent: {
    en: 'Everyone in the clip is fine with it being narrated and processed by AI.',
    zh: '视频中的所有人都同意由 AI 处理并配上解说。'
  },
  start: { en: 'Start replay', zh: '开始制作' },
  working: { en: 'Making your replay', zh: '正在制作回放' },
  checkTitle: { en: 'Is this what happened?', zh: '这是发生的事吗？' },
  checkSub: { en: 'Confirm the key moment before the narration is written', zh: '写解说之前，请确认关键时刻' },
  pickMoment: { en: 'Pick the key moment', zh: '选择关键时刻' },
  activity: { en: 'What is going on', zh: '正在发生什么' },
  outcome: { en: 'What happened', zh: '结果如何' },
  keepEvent: { en: 'Keep: ', zh: '保留：' },
  clipOk: { en: 'Everyone in the clip is fine (nobody is hurt or in distress).', zh: '视频中的人都没事（无人受伤或处于困境）。' },
  confirm: { en: 'Yes, write the call', zh: '没错，开始写解说' },
  generic: { en: 'Use a general call', zh: '使用通用解说' },
  stop: { en: 'Stop', zh: '停止' },
  doneTitle: { en: 'Your replay is ready', zh: '回放已完成' },
  restyle: { en: 'Tell it in another style', zh: '换一种风格重新讲述' },
  another: { en: 'Make another', zh: '再做一个' },
  remove: { en: 'Delete this run', zh: '删除这次制作' },
  stopped: { en: 'This run stopped', zh: '本次制作已停止' },
  unreachable: {
    en: 'The Epic Replay server is not reachable. Check EPIC_REPLAY_URL and that the server is running.',
    zh: '无法连接 Epic Replay 服务器。请检查 EPIC_REPLAY_URL 以及服务器是否在运行。'
  },
  cost: { en: 'Estimated cost for the rest of the run', zh: '剩余步骤预估费用' }
} as const;

type Key = keyof typeof T;
const tx = (lang: EpicLang, key: Key): string => T[key][lang];

export const EPIC_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文 (Mandarin)' }
];

function jsonl(stage: string, root: string, title: string, subtitle: string | undefined, components: A2uiComponent[], data: Record<string, unknown>, status = 'ready'): string {
  const surfaceId = EPIC_SURFACE_ID;
  const lines = [
    { version: 'v0.9.1', createSurface: { surfaceId, root, title, subtitle, status } },
    { version: 'v0.9.1', updateComponents: { surfaceId, components } },
    { version: 'v0.9.1', updateDataModel: { surfaceId, path: '/', value: { ...data, stage } } }
  ];
  return lines.map(line => JSON.stringify(line)).join('\n');
}

export function startSurface(styles: EpicStyle[], lang: EpicLang): string {
  const options = styles.map(style => ({
    value: style.id,
    label: style.name,
    description: style.description ?? '',
    sample: style.sample_line ?? ''
  }));
  const fallback = styles.find(style => style.default)?.id ?? styles[0]?.id ?? '';
  const components: A2uiComponent[] = [
    { id: 'root', component: 'SurfaceRoot', title: tx(lang, 'title'), children: ['intro', 'file', 'style', 'language', 'player', 'consent', 'actions'] },
    { id: 'intro', component: 'Text', text: tx(lang, 'intro') },
    { id: 'file', component: 'FilePicker', name: 'file', title: tx(lang, 'clip'), label: tx(lang, 'pick'), accept: 'video/*' },
    { id: 'style', component: 'ChoiceGroup', name: 'style', title: tx(lang, 'narrator'), options, default: fallback },
    { id: 'language', component: 'ChoiceGroup', name: 'language', title: tx(lang, 'language'), options: EPIC_LANGUAGES, default: lang },
    { id: 'player', component: 'TextField', name: 'player_name', label: tx(lang, 'player'), maxLength: 40 },
    { id: 'consent', component: 'Toggle', name: 'consent', label: tx(lang, 'consent'), default: false },
    {
      id: 'actions',
      component: 'ActionBar',
      actions: [{ id: 'epic.start', label: tx(lang, 'start'), variant: 'primary', kind: 'submit' }]
    }
  ];
  return jsonl('start', 'root', tx(lang, 'title'), tx(lang, 'startSub'), components, {});
}

export function errorSurface(message: string, lang: EpicLang, retry = true): string {
  const components: A2uiComponent[] = [
    { id: 'root', component: 'SurfaceRoot', title: tx(lang, 'title'), children: ['err', 'actions'] },
    { id: 'err', component: 'ErrorNotice', title: tx(lang, 'stopped'), body: message },
    {
      id: 'actions',
      component: 'ActionBar',
      actions: retry ? [{ id: 'epic.new', label: tx(lang, 'another'), variant: 'primary' }] : []
    }
  ];
  return jsonl('error', 'root', tx(lang, 'title'), undefined, components, {}, 'error');
}

export function unreachableSurface(lang: EpicLang): string {
  return errorSurface(tx(lang, 'unreachable'), lang, false);
}

function progressSurface(run: EpicRunState, lang: EpicLang): string {
  const steps = run.steps ?? [];
  const failed = run.status === 'failed' || run.status === 'stopped';
  const components: A2uiComponent[] = [
    { id: 'root', component: 'SurfaceRoot', title: tx(lang, 'title'), children: failed ? ['err', 'steps', 'actions'] : ['steps', 'note', 'actions'] },
    { id: 'err', component: 'ErrorNotice', title: tx(lang, 'stopped'), body: run.message ?? '' },
    { id: 'steps', component: 'StepList', dataPath: '/steps' },
    { id: 'note', component: 'Text', text: run.time_left ?? '' },
    {
      id: 'actions',
      component: 'ActionBar',
      actions: failed ? [{ id: 'epic.new', label: tx(lang, 'another'), variant: 'primary' }] : []
    }
  ];
  return jsonl(`progress:${run.status}:${steps.map(step => step.status).join(',')}`, 'root', tx(lang, 'working'), run.time_left, components, { steps }, failed ? 'error' : 'thinking');
}

function checkSurface(run: EpicRunState, card: EpicPlayCard, proxy: (path: string) => string, lang: EpicLang): string {
  const sheet = card.play_sheet;
  const flagged = (card.highlighted ?? []).filter(id => id !== 'climax');
  const events = (sheet.events ?? []).filter(event => flagged.includes(event.id));
  const frames = [
    { frame: card.climax.frame, url: proxy(`frames/${card.climax.frame}.jpg`), label: `${card.climax.t.toFixed(1)}s`, main: true },
    ...(card.other_moments ?? []).map(moment => ({
      frame: moment.frame,
      url: proxy(`frames/${moment.frame}.jpg`),
      label: `${moment.t.toFixed(1)}s${moment.reason ? ` · ${moment.reason}` : ''}`,
      main: false
    }))
  ];
  const unchecked = sheet.sensitive?.checked === false;
  const followed = sheet.actors?.find(actor => actor.followed);
  const eventIds = events.map(event => `event_${event.id}`);
  const components: A2uiComponent[] = [
    {
      id: 'root',
      component: 'SurfaceRoot',
      title: tx(lang, 'checkTitle'),
      children: ['gallery', 'activity', 'outcome', 'player', ...eventIds, ...(unchecked ? ['clipok'] : []), 'cost', 'actions']
    },
    { id: 'gallery', component: 'FrameGallery', name: 'climax_frame', title: tx(lang, 'pickMoment'), frames, default: card.climax.frame },
    { id: 'activity', component: 'TextField', name: 'activity', label: tx(lang, 'activity'), default: sheet.activity?.value ?? '', maxLength: 80 },
    { id: 'outcome', component: 'TextField', name: 'outcome_summary', label: tx(lang, 'outcome'), default: sheet.outcome_summary?.value ?? '', maxLength: 160 },
    { id: 'player', component: 'TextField', name: 'player_name', label: tx(lang, 'player'), default: followed?.user_name ?? '', maxLength: 40 },
    ...events.map<A2uiComponent>(event => ({
      id: `event_${event.id}`,
      component: 'Toggle',
      name: `event:${event.id}`,
      label: `${tx(lang, 'keepEvent')}${event.action ?? event.id}`,
      default: true
    })),
    ...(unchecked ? [{ id: 'clipok', component: 'Toggle', name: 'clip_ok', label: tx(lang, 'clipOk'), default: false } as A2uiComponent] : []),
    {
      id: 'cost',
      component: 'Text',
      text: card.cost_estimate_usd ? `${tx(lang, 'cost')}: $${card.cost_estimate_usd.toFixed(2)}` : ''
    },
    {
      id: 'actions',
      component: 'ActionBar',
      actions: [
        { id: 'epic.confirm', label: tx(lang, 'confirm'), variant: 'primary', kind: 'submit' },
        { id: 'epic.generic', label: tx(lang, 'generic'), variant: 'secondary', kind: 'submit' },
        { id: 'epic.reject', label: tx(lang, 'stop'), variant: 'ghost', kind: 'submit' }
      ]
    }
  ];
  return jsonl(`check:${card.run_id}:${events.map(event => event.id).join(',')}:${unchecked}`, 'root', tx(lang, 'checkTitle'), tx(lang, 'checkSub'), components, {});
}

function doneSurface(run: EpicRunState, styles: EpicStyle[], proxy: (path: string) => string, lang: EpicLang): string {
  const others = styles.filter(style => style.id !== run.style);
  const components: A2uiComponent[] = [
    { id: 'root', component: 'SurfaceRoot', title: tx(lang, 'doneTitle'), children: ['video', 'steps', 'style', 'actions'] },
    { id: 'video', component: 'VideoPlayer', src: proxy('final.mp4'), title: tx(lang, 'doneTitle') },
    { id: 'steps', component: 'StepList', dataPath: '/steps' },
    {
      id: 'style',
      component: 'ChoiceGroup',
      name: 'style',
      title: tx(lang, 'restyle'),
      options: others.map(style => ({ value: style.id, label: style.name, description: style.description ?? '', sample: style.sample_line ?? '' })),
      default: others[0]?.id ?? ''
    },
    {
      id: 'actions',
      component: 'ActionBar',
      actions: [
        ...(others.length ? [{ id: 'epic.restyle', label: tx(lang, 'restyle'), variant: 'secondary', kind: 'submit' } as const] : []),
        { id: 'epic.new', label: tx(lang, 'another'), variant: 'primary' },
        { id: 'epic.delete', label: tx(lang, 'remove'), variant: 'ghost', kind: 'submit' }
      ]
    }
  ];
  return jsonl(`done:${run.run_id}:${run.style ?? ''}`, 'root', tx(lang, 'doneTitle'), undefined, components, { steps: run.steps ?? [] });
}

export interface RunSurfaceInput {
  run: EpicRunState;
  card?: EpicPlayCard | null;
  styles: EpicStyle[];
  /** Maps a path under /runs/{id}/ to the bridge URL the browser may load. */
  proxy: (path: string) => string;
  lang: EpicLang;
}

export function runSurface({ run, card, styles, proxy, lang }: RunSurfaceInput): string {
  if (run.status === 'done' && run.has_video) return doneSurface(run, styles, proxy, lang);
  const waiting = (run.steps ?? []).some(step => step.status === 'waiting_user');
  if (waiting && card) return checkSurface(run, card, proxy, lang);
  return progressSurface(run, lang);
}

export function isTerminal(run: EpicRunState): boolean {
  return run.status === 'done' || run.status === 'stopped' || run.status === 'failed';
}

/** Turn the form the user filled in into the body of the bridge's confirm/generic action. */
export function confirmBody(action: 'confirm' | 'generic', form: Record<string, unknown>): Record<string, unknown> {
  const edits: Record<string, unknown> = {};
  const frame = form.climax_frame;
  if (typeof frame === 'number') edits.climax_frame = frame;
  if (form.clip_ok !== undefined) edits.clip_ok = form.clip_ok === true;
  if (action === 'confirm') {
    const activity = String(form.activity ?? '').trim();
    const outcome = String(form.outcome_summary ?? '').trim();
    if (activity) edits.activity = activity.slice(0, 80);
    if (outcome) edits.outcome_summary = outcome.slice(0, 160);
    const events = Object.entries(form)
      .filter(([key]) => key.startsWith('event:'))
      .map(([key, value]) => ({ id: key.slice(6), keep: value !== false }));
    if (events.length) edits.events = events;
  }
  const context: Record<string, unknown> = {};
  const player = String(form.player_name ?? '').trim();
  if (action === 'confirm' && player) context.player_name = player.slice(0, 40);
  return { action, edits, context };
}
