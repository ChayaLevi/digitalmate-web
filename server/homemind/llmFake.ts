/**
 * The simulated model: canned, rule-based replies in the shape the real one gives. Used by
 * `HOMEMIND_LLM=fake` in process, and served over HTTP by `scripts/fake-llm.mjs` so the live client
 * can be tested end to end without a key. Screens say "Simulated model" whenever it is in use.
 *
 * It reads the same prompt the real model gets (intents.ts): the job line, today's date, the BOARD
 * and MESSAGE blocks. It understands a few English and Chinese phrasings, enough for tests and
 * rehearsal, and is not meant to be clever. Deterministic: same prompt, same reply.
 */
import { JOB_EXTRACT, JOB_INTENT } from './intents';

interface BoardItem {
  id: string;
  type: string;
  title: string;
  titleZh?: string;
  start?: string;
  owner?: string | null;
  confirmed?: boolean;
  whoIsTakingThis?: boolean;
  proposed?: boolean;
}
interface BoardMember {
  id: string;
  name: string;
  nameZh?: string;
  role: string;
}
interface Board {
  me: { id: string };
  members: BoardMember[];
  items: BoardItem[];
}

export interface FakeCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: 'stop' }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

type Message = { role: string; content: unknown };

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(p => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).join('\n')
      : '';

const hasImage = (content: unknown) => Array.isArray(content) && content.some(p => p && typeof p === 'object' && (p as { type?: string }).type === 'image_url');

/** An OpenAI-style completion for an OpenAI-style request body. */
export function fakeCompletion(body: Record<string, unknown>): FakeCompletion {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
  const system = textOf(messages.find(m => m.role === 'system')?.content);
  const user = messages.find(m => m.role === 'user');
  const content = fakeReply(system, textOf(user?.content), hasImage(user?.content));
  return {
    id: 'fake-completion',
    object: 'chat.completion',
    created: 0,
    model: typeof body.model === 'string' ? body.model : 'homemind-fake',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: Math.ceil((system.length + textOf(user?.content).length) / 4), completion_tokens: Math.ceil(content.length / 4) }
  };
}

export function fakeReply(system: string, user: string, image: boolean): string {
  const today = parseToday(system);
  if (system.startsWith(JOB_EXTRACT)) return JSON.stringify(fakeExtraction(today, block(user, 'SOURCE TEXT'), image));
  if (system.startsWith(JOB_INTENT)) {
    const lang = /Reply language: zh/.test(system) ? 'zh' : 'en';
    let board: Board;
    try {
      board = JSON.parse(block(user, 'BOARD') ?? '') as Board;
    } catch {
      board = { me: { id: '' }, members: [], items: [] };
    }
    return JSON.stringify(fakeIntent(today, board, block(user, 'MESSAGE') ?? '', lang));
  }
  return JSON.stringify({ error: 'unknown job' });
}

function block(text: string, name: string): string | undefined {
  const m = new RegExp(`<<<BEGIN ${name}>>>\\n([\\s\\S]*?)\\n<<<END ${name}>>>`).exec(text);
  return m?.[1];
}

// --- dates -------------------------------------------------------------------------------------------------

interface Today {
  date: string;
  time: string;
  weekday: number;
  offset: string;
}

const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];

function parseToday(system: string): Today {
  const m = /Today is (\w+) (\d{4}-\d{2}-\d{2}), (\d{2}:\d{2}) local time, time zone \S+ \(UTC([+-]\d{2}:\d{2})\)/.exec(system);
  if (!m) return { date: '2026-01-01', time: '12:00', weekday: 4, offset: '+00:00' };
  return { date: m[2], time: m[3], weekday: Math.max(0, WEEKDAYS_EN.indexOf(m[1].toLowerCase())), offset: m[4] };
}

function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** The next `weekday` from today, today included. */
const nextWeekday = (today: Today, weekday: number) => addDays(today.date, (weekday - today.weekday + 7) % 7);
const at = (today: Today, date: string, time: string) => `${date}T${time}:00${today.offset}`;

/** Local `YYYY-MM-DD` and `HH:MM` of an ISO time, in the prompt's offset. */
function local(today: Today, iso: string): { date: string; time: string } {
  const sign = today.offset.startsWith('-') ? -1 : 1;
  const [h, m] = today.offset.slice(1).split(':').map(Number);
  const shifted = new Date(Date.parse(iso) + sign * (h * 60 + m) * 60000).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

function dayIn(today: Today, text: string): string | undefined {
  const t = text.toLowerCase();
  if (/\btomorrow\b|明天/.test(t)) return addDays(today.date, 1);
  if (/\btoday\b|tonight|今天|今晚/.test(t)) return today.date;
  for (let d = 0; d < 7; d++) {
    if (new RegExp(`\\b${WEEKDAYS_EN[d]}\\b`).test(t) || new RegExp(`(周|星期|礼拜)${WEEKDAYS_ZH[d]}`).test(text)) return nextWeekday(today, d);
  }
  return undefined;
}

function timeIn(text: string): string | undefined {
  const hm = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  if (hm) return `${hm[1].padStart(2, '0')}:${hm[2]}`;
  const ampm = /\b(1[0-2]|[1-9])\s*(am|pm)\b/i.exec(text);
  if (ampm) return `${String((Number(ampm[1]) % 12) + (ampm[2].toLowerCase() === 'pm' ? 12 : 0)).padStart(2, '0')}:00`;
  const zh = /(上午|下午|晚上)?\s*(\d{1,2})\s*点/.exec(text);
  if (zh) {
    const h = Number(zh[2]) + (zh[1] && zh[1] !== '上午' && Number(zh[2]) < 12 ? 12 : 0);
    if (h <= 23) return `${String(h).padStart(2, '0')}:00`;
  }
  return undefined;
}

// --- chat intents ------------------------------------------------------------------------------------------

const STOP = new Set(['with', 'from', 'that', 'this', 'take', 'make', 'have', "maya's", "noa's", 'grandma']);

function findItem(board: Board, text: string, filter: (i: BoardItem) => boolean = () => true): BoardItem | undefined {
  const t = text.toLowerCase();
  let best: BoardItem | undefined;
  let bestScore = 0;
  for (const item of board.items.filter(filter)) {
    let score = 0;
    if (t.includes(item.title.toLowerCase())) score += 10;
    if (item.titleZh && text.includes(item.titleZh)) score += 10;
    for (const word of item.title.toLowerCase().split(/[^a-z']+/)) if (word.length >= 4 && !STOP.has(word) && t.includes(word)) score += 2;
    const zh = item.titleZh ?? '';
    for (let i = 0; i + 1 < zh.length; i++) if (text.includes(zh.slice(i, i + 2))) score += 1;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function findMember(board: Board, text: string): BoardMember | undefined {
  const t = text.toLowerCase();
  return board.members.find(m => m.id !== board.me.id && (new RegExp(`\\b${m.name.toLowerCase()}\\b`).test(t) || (m.nameZh && text.includes(m.nameZh))));
}

const ask = (answer: string, itemIds: string[] = []) => ({ intent: 'ask', answer, itemIds });

function fakeIntent(today: Today, board: Board, text: string, lang: 'en' | 'zh'): Record<string, unknown> {
  const t = text.toLowerCase();
  const zh = lang === 'zh';
  const which = zh ? '是哪一项？请说出标题。' : 'Which item do you mean? Please name it.';

  if (/ignore (all |the )?(previous|above|prior|earlier)|disregard (all|the|your)|system prompt|忽略(之前|以上|所有|前面)/i.test(text)) {
    return ask(zh ? '我只能帮忙处理家庭看板上的事。' : 'I can only help with the family board.');
  }
  if (/\bwhy\b|为什么/.test(t)) {
    const item = findItem(board, text);
    return item ? { intent: 'why', itemId: item.id } : ask(which);
  }
  if (/\bsick\b|\bfever\b|\bill\b|生病|发烧|不舒服/.test(t)) {
    const who = findMember(board, text) ?? board.members.find(m => m.role === 'child');
    return { intent: 'report_situation', situation: 'sick', ...(who ? { memberId: who.id } : {}), date: dayIn(today, text) ?? today.date, summary: text.slice(0, 200) };
  }
  if (/allerg|过敏|\bprefer|\blikes?\b|enjoys?|loves?\b|喜欢|不吃|不能吃/.test(t)) {
    const because = /\bbecause\b\s*(.+)$|因为(.+)$/i.exec(text);
    const reason = because ? (because[1] ?? because[2]).trim().slice(0, 200) : null;
    const hard = /allerg|过敏|不能吃|kosher|halal/.test(t);
    return { intent: 'add_preference', text: text.trim().slice(0, 200), reason, aboutMemberId: findMember(board, text)?.id ?? null, strength: hard ? 'hard' : 'soft', scope: /\bpart(y|ies)\b|派对|聚会/.test(t) ? 'kindergarten-party' : null };
  }
  const every = /\bevery (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t) ?? /每(周|星期)([日一二三四五六])/.exec(text);
  if (every) {
    const weekday = WEEKDAYS_EN.includes(every[1]) ? WEEKDAYS_EN.indexOf(every[1]) : WEEKDAYS_ZH.indexOf(every[2]);
    return { intent: 'create_rule', title: text.trim().slice(0, 80), weekday, time: timeIn(text) ?? '18:00', leadMinutes: 30, action: text.trim().slice(0, 200) };
  }
  if (/\bdone\b|\bfinished\b|完成了|做完了|弄好了/.test(t)) {
    const item = findItem(board, text);
    return item ? { intent: 'mark_done', itemId: item.id } : ask(which);
  }
  if (/i'?ll (take|do|handle|get)|i will (take|do|handle)|i can (take|do)|我来/.test(t)) {
    const item = findItem(board, text);
    return item ? { intent: 'claim', itemId: item.id } : ask(which);
  }
  if (/\bassign\b|\bask \w+ to\b|\bgive\b.*\bto\b|让|交给|安排给/.test(t)) {
    const member = findMember(board, text);
    const item = findItem(board, text);
    if (item && member) return { intent: 'assign', itemId: item.id, memberId: member.id };
    return ask(which);
  }
  if (/\bbring\b|\bprepare\b|\bpack\b|准备|带上|要带/.test(t)) {
    const event = findItem(board, text, i => i.type === 'event');
    if (event) {
      const what = /\b(?:bring|prepare|pack)\s+(.+?)(?:\s+for\b.*)?$/i.exec(text)?.[1] ?? text.replace(/^.*?(准备|带上|要带)/, '');
      return { intent: 'add_preparation', eventId: event.id, title: what.trim().slice(0, 80) || text.slice(0, 80), due: null };
    }
  }
  if (/remind me|\btask\b|\btodo\b|to-do|提醒我|任务/.test(t)) {
    const day = dayIn(today, text);
    const due = day ? at(today, day, timeIn(text) ?? '09:00') : null;
    const title = text.replace(/^(please\s+)?(remind me to|add a task( to)?|提醒我)\s*/i, '').trim().slice(0, 80) || text.slice(0, 80);
    return { intent: 'create_task', title, due, ownerId: null, forMemberIds: [] };
  }
  const day = dayIn(today, text);
  if (day && /party|meeting|dinner|appointment|wedding|lesson|class|聚会|派对|会议|婚礼|晚饭|课|见面/.test(t)) {
    const start = at(today, day, timeIn(text) ?? '10:00');
    const away = /wedding|婚礼/.test(t) ? [board.me.id] : [];
    return { intent: 'create_event', title: text.trim().slice(0, 80), start, end: null, allDay: false, forMemberIds: [], unavailableMemberIds: away, visibility: 'family', importance: 'normal' };
  }
  return ask(...todaySummary(today, board, lang));
}

function todaySummary(today: Today, board: Board, lang: 'en' | 'zh'): [string, string[]] {
  const name = (id: string | null | undefined) => {
    const m = board.members.find(x => x.id === id);
    return m ? (lang === 'zh' ? (m.nameZh ?? m.name) : m.name) : '';
  };
  const items = board.items.filter(i => i.start && !i.proposed && local(today, i.start).date === today.date);
  if (!items.length) return [lang === 'zh' ? '今天看板上没有安排。' : 'Nothing on the board for today.', []];
  const lines = items.map(i => {
    const time = local(today, i.start as string).time;
    const title = lang === 'zh' ? (i.titleZh ?? i.title) : i.title;
    const who = i.owner ? `${name(i.owner)}${i.confirmed ? '' : lang === 'zh' ? '，尚未确认' : ', not confirmed yet'}` : i.whoIsTakingThis ? (lang === 'zh' ? '还没人认领' : 'still open') : '';
    return lang === 'zh' ? `${time} ${title}${who ? `（${who}）` : ''}` : `${title} at ${time}${who ? ` (${who})` : ''}`;
  });
  return [lang === 'zh' ? `今天的安排：${lines.join('；')}。` : `Today on the board: ${lines.join('; ')}.`, items.map(i => i.id).slice(0, 10)];
}

// --- extraction --------------------------------------------------------------------------------------------

const squash = (s: string) => s.replace(/[‹›<>]/g, '').replace(/\s+/g, '');

/**
 * The simulated 接龙 sample (e2e/fixtures/homemind/jielong-sample.html). Its party is "this
 * Thursday", so dates follow today. A screenshot gets all of it; a text gets only the entries whose
 * quote is in the text; anything else gets nothing.
 */
function fakeExtraction(today: Today, text: string | undefined, image: boolean): Record<string, unknown> {
  const party = nextWeekday(today, 4);
  const entries = {
    events: [
      { title: '秋季水果派对', start: at(today, party, '15:00'), end: null, confidence: 0.95, quote: '本周四（11月5日）下午3点在班里举办秋季水果派对' },
      { title: '全园体检', start: at(today, addDays(party, 1), '09:00'), end: null, confidence: 0.9, quote: '周五（11月6日）上午9点全园体检' }
    ],
    preparations: [
      { title: '切好装盒的水果（够8个小朋友）', due: at(today, party, '08:00'), for_event: '秋季水果派对', confidence: 0.9, quote: '切好装盒，够8个小朋友吃' },
      { title: '穿方便穿脱的衣服', due: at(today, addDays(party, 1), '08:00'), for_event: '全园体检', confidence: 0.85, quote: '请给孩子穿方便穿脱的衣服' }
    ],
    requests: [{ text: '接龙认领要带的水果', due: at(today, addDays(party, -1), '20:00'), confidence: 0.9, quote: '请家长们接龙认领要带的水果' }]
  };
  const signUp = {
    topic: '周四水果派对 认领水果',
    deadline: at(today, addDays(party, -1), '20:00'),
    taken: [
      { who: '乐乐妈妈', item: '苹果' },
      { who: '小雨爸爸', item: '香蕉' },
      { who: '朵朵妈妈', item: '葡萄' }
    ],
    confidence: 0.9,
    quote: '周四水果派对 认领水果'
  };
  if (image) return { ...entries, sign_up: signUp };
  const source = squash(text ?? '');
  const inSource = <T extends { quote: string }>(list: T[]) => list.filter(e => source && source.includes(squash(e.quote)));
  return {
    events: inSource(entries.events),
    preparations: inSource(entries.preparations),
    requests: inSource(entries.requests),
    sign_up: source && source.includes(squash(signUp.quote)) ? signUp : null
  };
}
