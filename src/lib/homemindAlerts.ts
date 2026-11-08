/**
 * Pure helpers for the live alerts shown by `AlertBanner` (T3.3, reminders T4.1). No React, no I/O.
 *
 * Wording is neutral: it says what is waiting, never who failed to answer ("The pickup is not
 * confirmed yet", never "Dad didn't answer"). A sensitive item shows only "You have a reminder"
 * (CLAUDE.md), with no title and no time.
 */
import type { HomemindAlert, Item, Lang } from '../../server/homemind/types';

/** At most this many alerts are kept on screen; the oldest goes first. */
export const MAX_ALERTS = 3;

/**
 * Item verbs: `ack` ("I'm on it" / "Got it"), `claim` ("I'll take it" on an open item), `take` (a
 * parent takes an item assigned to someone else: assign to themselves), `handback`, `done`, `snooze`
 * ("Remind me later"). `open` shows the item; `dismiss` hides the alert in this window only.
 */
export type AlertVerb = 'ack' | 'claim' | 'take' | 'handback' | 'done' | 'snooze' | 'open' | 'dismiss';

export interface AlertButton {
  verb: AlertVerb;
  label: string;
}

/** The buttons that answer the alert, drawn as primary. */
export const PRIMARY_VERBS: readonly AlertVerb[] = ['ack', 'claim', 'take', 'done'];

const t = (lang: Lang, en: string, zh: string) => (lang === 'zh' ? zh : en);

const titleOf = (lang: Lang, title: string, titleZh?: string) => (lang === 'zh' && titleZh ? titleZh : title);

const GENERIC = { en: 'You have a reminder', zh: '你有一条提醒' };

export function alertTitle(alert: HomemindAlert, lang: Lang): string {
  if (alert.kind === 'batch') {
    const n = alert.entries?.length ?? 1;
    return t(lang, `${n} updates`, `${n} 条更新`);
  }
  if (alert.sensitive || !alert.title) return t(lang, GENERIC.en, GENERIC.zh);
  return titleOf(lang, alert.title, alert.titleZh);
}

export function alertText(alert: HomemindAlert, lang: Lang): string {
  if (alert.kind === 'batch') {
    const entries = alert.entries ?? [];
    const names = entries.map(e => (e.sensitive || !e.title ? t(lang, 'a reminder', '一条提醒') : titleOf(lang, e.title, e.titleZh)));
    return t(lang, `${entries.length} updates: ${names.join(', ')}`, `${entries.length} 条更新：${names.join('、')}`);
  }
  if (alert.kind === 'backup') {
    const contact = (lang === 'zh' && alert.contactNameZh) || alert.contactName || '';
    const label = alert.simulated ? t(lang, ' (Simulated)', '（模拟）') : '';
    return t(lang, `${contact} was sent a short message to get in touch.${label}`, `已给${contact}发了一条简短消息，请其联系家里。${label}`);
  }
  if (alert.kind === 'group') {
    // T7.4: Homemind signed the family up in a simulated group (or changed it). Always labelled simulated.
    const title = alertTitle(alert, lang);
    const choice = (lang === 'zh' ? alert.groupChoiceZh : alert.groupChoice) ?? '';
    const from = lang === 'zh' ? alert.groupFromZh : alert.groupFrom;
    return from
      ? t(lang, `Sign-up changed from ${from} to ${choice}: ${title}. (Simulated group)`, `接龙已从${from}改为${choice}：${title}。（模拟群）`)
      : t(lang, `Homemind signed the family up for ${choice}: ${title}. (Simulated group)`, `Homemind 已替家里认领${choice}：${title}。（模拟群）`);
  }
  if (alert.sensitive || !alert.title) return t(lang, GENERIC.en, GENERIC.zh);
  const title = alertTitle(alert, lang);
  const at = alert.time;
  switch (alert.kind) {
    case 'assigned': {
      const by = lang === 'zh' && alert.byNameZh ? alert.byNameZh : alert.byName;
      return t(lang, `${by} assigned you: ${title}`, `${by}把「${title}」交给了你`);
    }
    case 'open':
      return t(lang, `Who's taking this? ${title}`, `谁来负责？${title}`);
    case 'reminder':
      if (alert.ask === 'heads-up') return at ? t(lang, `Coming up at ${at}: ${title}`, `${at} 即将开始：${title}`) : t(lang, `Coming up: ${title}`, `即将开始：${title}`);
      if (alert.ask === 'confirm') return at ? t(lang, `Please confirm: ${title} at ${at}`, `请确认：${at} ${title}`) : t(lang, `Please confirm: ${title}`, `请确认：${title}`);
      return at ? t(lang, `Still open: ${title} at ${at}. Who's taking this?`, `${at} 的「${title}」还没有人负责，谁来？`) : t(lang, `Still open: ${title}. Who's taking this?`, `「${title}」还没有人负责，谁来？`);
    case 'escalation':
      if (alert.ask === 'confirm') return at ? t(lang, `${title} at ${at} is not confirmed yet.`, `${at} 的「${title}」还没有确认。`) : t(lang, `${title} is not confirmed yet.`, `「${title}」还没有确认。`);
      return at ? t(lang, `${title} at ${at} is still open.`, `${at} 的「${title}」还没有人负责。`) : t(lang, `${title} is still open.`, `「${title}」还没有人负责。`);
  }
}

export function alertButtons(alert: HomemindAlert, lang: Lang): AlertButton[] {
  const b = (verb: AlertVerb, en: string, zh: string): AlertButton => ({ verb, label: t(lang, en, zh) });
  const open = b('open', 'Open', '查看');
  const dismiss = b('dismiss', 'Dismiss', '关闭');
  const later = b('snooze', 'Remind me later', '稍后提醒');
  switch (alert.kind) {
    case 'assigned':
      return [b('ack', "I'm on it", '我来处理'), open, dismiss];
    case 'open':
      return [b('claim', "I'll take it", '我来'), open, dismiss];
    case 'reminder':
      if (alert.ask === 'confirm') return [b('ack', "I'm on it", '我来处理'), b('handback', 'Hand off', '交给别人'), later, open];
      if (alert.ask === 'heads-up') return [...(alert.recurring ? [] : [b('done', 'Done', '已完成')]), b('ack', 'Got it', '知道了'), later, open];
      return [b('claim', "I'll take it", '我来'), later, open];
    case 'escalation':
      return [alert.ask === 'confirm' ? b('take', "I'll take it", '我来') : b('claim', "I'll take it", '我来'), b('ack', 'Got it', '知道了'), open];
    case 'backup':
    case 'group':
      return [open, dismiss];
    case 'batch':
      return [dismiss];
  }
}

/** Whether the alert still asks something of `memberId`, given the item as it is now (`null`: gone or hidden). */
export function stillRelevant(alert: HomemindAlert, item: Item | null, memberId: string): boolean {
  // A batch only lists things; it stays until dismissed.
  if (alert.kind === 'batch') return true;
  if (!item || item.status !== 'open') return false;
  const own = item.ownership;
  const confirmed = own.state === 'assigned' && own.confirmed;
  switch (alert.kind) {
    case 'assigned':
      return own.state === 'assigned' && own.ownerId === memberId && !own.confirmed;
    case 'open':
      return own.state === 'open' && own.candidateIds.includes(memberId);
    case 'reminder':
      if (alert.ask === 'confirm') return own.state === 'assigned' && own.ownerId === memberId && !own.confirmed;
      if (alert.ask === 'open') return own.state !== 'assigned';
      return true;
    case 'escalation':
      return !confirmed;
    case 'backup':
    case 'group':
      return true;
  }
}

/** Notices only tell; they never push out an alert that asks for an answer. */
const isNotice = (alert: HomemindAlert) => alert.kind === 'batch' || alert.kind === 'backup' || alert.kind === 'group';

/**
 * The list after a new alert arrives: one alert that asks something per item (the newest), plus
 * notices, newest first, at most `MAX_ALERTS`.
 */
export function addAlert(list: readonly HomemindAlert[], alert: HomemindAlert): HomemindAlert[] {
  const replaces = (a: HomemindAlert) => a.id === alert.id || (!isNotice(alert) && !isNotice(a) && a.itemId === alert.itemId);
  return [alert, ...list.filter(a => !replaces(a))].slice(0, MAX_ALERTS);
}

/** The list after an item changed: alerts it answered are gone, the rest carry the item's new version. */
export function applyItemChange(list: readonly HomemindAlert[], itemId: string, item: Item | null, memberId: string): HomemindAlert[] {
  return list.flatMap(alert => {
    if (alert.itemId !== itemId) return [alert];
    if (!stillRelevant(alert, item, memberId)) return [];
    return [item && item.version !== alert.itemVersion ? { ...alert, itemVersion: item.version } : alert];
  });
}

/** The list after someone answered a reminder: its alerts are gone, in every window. */
export function closeReminder(list: readonly HomemindAlert[], reminderId: string): HomemindAlert[] {
  return list.filter(alert => alert.reminderId !== reminderId);
}
