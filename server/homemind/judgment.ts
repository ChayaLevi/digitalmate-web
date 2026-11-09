/**
 * Judgment (T8.2): how soon the family should see a message from a simulated group, and why.
 *
 *   urgent   it breaks quiet hours: an alert at once, to the parents
 *   timed    an alert now, held by quiet hours and batched like any small update
 *   summary  no alert: it waits for the evening summary (20:00), and the screens say so and why
 *
 * Decided by **fixed rules over the message's words**, never by the model, so the reason shown is the
 * real reason. The order matters: "urgent" words win, a 接龙 is shown now (the sign-up rules of T7.4 read
 * it), the sender's own "不着急" wins over a date, then dates: today, tomorrow or this week is shown now;
 * next week waits; a message with no date and no request waits.
 *
 * Pure: no I/O, no clock reads (`now` is passed in). Wording is the screens' job; this returns the
 * reason code and the words it matched.
 */
import type { AlertDelivery } from './alerts';
import { toIso } from './clock';
import { HOMEMIND_SENDER, nextSummaryAt } from './reminders';
import type { GroupMessage, HomemindAlert, HomemindState, JudgmentReason, MessageJudgment, Tier } from './types';

/** At most this many judgments are kept (newest last). */
export const MAX_JUDGMENTS = 100;
/** An alert quotes at most this many characters of the message. */
export const ALERT_TEXT_LIMIT = 140;

/** The rules, in order. Each matches words in English or Chinese. */
const RULES: ReadonlyArray<{ reason: JudgmentReason; tier: Tier; pattern: RegExp }> = [
  { reason: 'urgent-words', tier: 'urgent', pattern: /紧急|马上|立刻|立即|尽快|停课|提前放学|\burgent\b|\bimmediately\b|\bright away\b|\basap\b|\bemergency\b/i },
  // The list itself ("#接龙", or a line starting with 接龙), not a message that only asks people to sign up.
  { reason: 'sign-up', tier: 'timed', pattern: /#接龙|^\s*接龙|\bsign[- ]?up (?:sheet|list)\b/im },
  { reason: 'not-urgent', tier: 'summary', pattern: /不着急|不急|不用急|不赶时间|\bno rush\b|\bnot urgent\b|\bno hurry\b|\bwhenever you can\b/i },
  { reason: 'soon', tier: 'timed', pattern: /今天|今晚|明天|明早|本周|这周|这个星期|\btoday\b|\btonight\b|\btomorrow\b|\bthis week\b/i },
  { reason: 'next-week', tier: 'summary', pattern: /下周|下星期|下个星期|下个月|\bnext week\b|\bnext month\b/i },
  { reason: 'soon', tier: 'timed', pattern: /(?:周|星期)[一二三四五六日天]|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i }
];

export interface Judged {
  tier: Tier;
  reason: JudgmentReason;
  /** The words the rule matched. Absent for `no-date`. */
  quote?: string;
}

/** The tier of a message and why, from its words alone. */
export function judgeText(text: string): Judged {
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) return { tier: rule.tier, reason: rule.reason, quote: match[0].trim() };
  }
  return { tier: 'summary', reason: 'no-date' };
}

export const judgmentId = (messageId: string, version: number) => `jdg-${messageId}-v${version}`;

function parentsWithAccount(state: HomemindState): string[] {
  return state.family.members.filter(m => m.role === 'parent' && m.hasAccount).map(m => m.id);
}

/** The alert for a message that should be seen now. Neutral: who wrote, what, and why it is shown now. */
function messageAlert(message: GroupMessage, judgment: MessageJudgment): HomemindAlert {
  const text = message.text.replace(/\s+/g, ' ').trim();
  return {
    id: `msg.${message.id}.v${message.version}`,
    kind: 'message',
    itemId: message.id,
    itemVersion: message.version,
    tier: judgment.tier,
    at: judgment.at,
    byId: HOMEMIND_SENDER.id,
    byName: HOMEMIND_SENDER.name,
    byNameZh: HOMEMIND_SENDER.nameZh,
    sensitive: false,
    messageAuthor: message.author,
    ...(message.authorZh ? { messageAuthorZh: message.authorZh } : {}),
    messageText: text.length > ALERT_TEXT_LIMIT ? `${text.slice(0, ALERT_TEXT_LIMIT - 1)}…` : text,
    judgmentReason: judgment.reason,
    simulated: true
  };
}

export interface JudgeResult {
  state: HomemindState;
  judgment: MessageJudgment;
  /** Alerts to route (quiet hours, batching) and deliver. Empty for `summary` and for a sign-up already told. */
  deliveries: AlertDelivery[];
}

/**
 * Judges a message that just arrived in a group and records it. `handled`: the sign-up rules (T7.4)
 * already sent the family their own notice about it, so no second alert. A reply the family posted is
 * not judged (`null`), and a message already judged at that version keeps its judgment and sends nothing.
 */
export function judgeMessage(state: HomemindState, message: GroupMessage, groupId: string, now: number, handled = false): JudgeResult | null {
  if (message.from === 'family') return null;
  const id = judgmentId(message.id, message.version);
  const existing = (state.messageJudgments ?? []).find(j => j.id === id);
  if (existing) return { state, judgment: existing, deliveries: [] };
  const judged = judgeText(message.text);
  const parents = parentsWithAccount(state);
  const alertNow = judged.tier !== 'summary' && !handled;
  const judgment: MessageJudgment = {
    id,
    messageId: message.id,
    version: message.version,
    groupId,
    at: toIso(now),
    tier: judged.tier,
    reason: judged.reason,
    ...(judged.quote ? { quote: judged.quote } : {}),
    ...(judged.tier === 'summary' ? { summaryAt: toIso(nextSummaryAt(now, state.family.timezone)) } : {}),
    ...(judged.tier !== 'summary' ? { alertedIds: alertNow ? parents : [] } : {}),
    ...(handled && judged.tier !== 'summary' ? { handledBy: 'group-claim' as const } : {})
  };
  const deliveries = alertNow ? parents.map(recipientId => ({ recipientId, alert: messageAlert(message, judgment) })) : [];
  return {
    state: { ...state, messageJudgments: [...(state.messageJudgments ?? []), judgment].slice(-MAX_JUDGMENTS) },
    judgment,
    deliveries
  };
}

/** Group messages waiting for an evening summary that has not gone out yet, oldest first. */
export function waitingForSummary(state: HomemindState): MessageJudgment[] {
  return (state.messageJudgments ?? []).filter(j => j.tier === 'summary' && !j.deliveredIn);
}
