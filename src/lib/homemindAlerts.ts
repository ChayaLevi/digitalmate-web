/**
 * Pure helpers for the live alerts shown by `AlertBanner` (T3.3). No React, no I/O.
 *
 * Wording is neutral: it says what is waiting, never who failed to answer. A sensitive item shows only
 * "You have a reminder" (CLAUDE.md), with no title.
 */
import type { HomemindAlert, Item, Lang } from '../../server/homemind/types';

/** At most this many alerts are kept on screen; the oldest goes first. */
export const MAX_ALERTS = 3;

export interface AlertButton {
  /** `ack` ("I'm on it") and `claim` ("I'll take it") are item verbs; `open` shows the item; `dismiss` hides the alert here. */
  verb: 'ack' | 'claim' | 'open' | 'dismiss';
  label: string;
}

const t = (lang: Lang, en: string, zh: string) => (lang === 'zh' ? zh : en);

export function alertTitle(alert: HomemindAlert, lang: Lang): string {
  if (alert.sensitive || !alert.title) return t(lang, 'You have a reminder', '你有一条提醒');
  return lang === 'zh' && alert.titleZh ? alert.titleZh : alert.title;
}

export function alertText(alert: HomemindAlert, lang: Lang): string {
  if (alert.sensitive || !alert.title) return t(lang, 'You have a reminder', '你有一条提醒');
  const title = alertTitle(alert, lang);
  const by = lang === 'zh' && alert.byNameZh ? alert.byNameZh : alert.byName;
  return alert.kind === 'assigned' ? t(lang, `${by} assigned you: ${title}`, `${by}把「${title}」交给了你`) : t(lang, `Who's taking this? ${title}`, `谁来负责？${title}`);
}

export function alertButtons(alert: HomemindAlert, lang: Lang): AlertButton[] {
  const main: AlertButton = alert.kind === 'assigned' ? { verb: 'ack', label: t(lang, "I'm on it", '我来处理') } : { verb: 'claim', label: t(lang, "I'll take it", '我来') };
  return [main, { verb: 'open', label: t(lang, 'Open', '查看') }, { verb: 'dismiss', label: t(lang, 'Dismiss', '关闭') }];
}

/** Whether the alert still asks something of `memberId`, given the item as it is now (`null`: gone or hidden). */
export function stillRelevant(alert: HomemindAlert, item: Item | null, memberId: string): boolean {
  if (!item || item.status !== 'open') return false;
  const own = item.ownership;
  if (alert.kind === 'assigned') return own.state === 'assigned' && own.ownerId === memberId && !own.confirmed;
  return own.state === 'open' && own.candidateIds.includes(memberId);
}

/** The list after a new alert arrives: no repeat of the same id, newest first, at most `MAX_ALERTS`. */
export function addAlert(list: readonly HomemindAlert[], alert: HomemindAlert): HomemindAlert[] {
  return [alert, ...list.filter(a => a.id !== alert.id && !(a.itemId === alert.itemId && a.kind === alert.kind))].slice(0, MAX_ALERTS);
}

/** The list after an item changed: alerts it answered are gone, the rest carry the item's new version. */
export function applyItemChange(list: readonly HomemindAlert[], itemId: string, item: Item | null, memberId: string): HomemindAlert[] {
  return list.flatMap(alert => {
    if (alert.itemId !== itemId) return [alert];
    if (!stillRelevant(alert, item, memberId)) return [];
    return [item && item.version !== alert.itemVersion ? { ...alert, itemVersion: item.version } : alert];
  });
}
