/**
 * A day gone wrong (T8.1): "Noa is sick."
 *
 * The model only reads the message (chat intent `report_situation`: who, which day). Everything after that
 * is fixed rules over the board, so it is the same every time:
 *
 *   What falls through   that member's events that day (from the reporter's own view, so a teen never
 *                        sees a trace of a Parents-only item), and what that member was going to do.
 *   Who stays home       a child who is sick needs someone at home. The parents with an account who are
 *                        not marked away that day are the candidates of a new task, "Stay home with Noa",
 *                        which is "Who's taking this?". Homemind never picks one of them: a parent taps
 *                        "I'll take it". It compares availability only, never how much each parent does.
 *   What to change       suggestions, each with Apply / Not now, and Undo after Apply:
 *                          cancel    a pickup or drop-off (title words, see PICKUP_PATTERN): the child stays home
 *                          postpone  any other event for that member, to the same time a week later
 *                          skip      one occurrence, for a weekly event
 *                          open      something the sick member owned that day becomes "Who's taking this?"
 *   Outside the family   cards that need a parent's tap (actions.ts): a message to the class teacher on a
 *                        weekday, and a babysitter draft when no parent is free. Both simulated.
 *
 * At autonomy level 1, or while paused, the stay-home task is created as `proposed` (a suggestion to
 * approve). The other suggestions always wait for a tap: they cancel or move things people planned.
 *
 * Pure: no network, no clock reads ("now" and the clock are passed in), no imports from src/.
 */
import { prepareCard } from './actions';
import type { AdapterRegistry, CardInput } from './actions';
import { unavailabilityFor } from './availability';
import { addDays, localParts, toIso, zonedToUtc } from './clock';
import type { Clock } from './clock';
import { applyChange, eligibleOwners, occurrences } from './core';
import type { Change, ChangeError, CoreEvent, NewItem } from './core';
import { ADAPTER_IDS, BABYSITTERS, TEACHER, draftBabysitterMessage, draftTeacherMessage, groupAuthorFor, sitterAvailable } from './fakes';
import { canSeeItem } from './visibility';
import type { HomemindState, Item, Member, Situation, SituationProposal, SituationView, Why } from './types';
import { ID_PATTERN } from './types';

/** How many situations the state keeps (oldest go first). */
export const MAX_SITUATIONS = 30;
/** A situation stays on screens this long after its day ends, so the last decisions are still visible. */
const SHOW_AFTER_DAY_MS = 12 * 60 * 60 * 1000;
/** How far ahead a report may be ("Noa is sick tomorrow" is fine; next month is not a situation). */
export const MAX_DAYS_AHEAD = 6;

/**
 * Titles that mean taking a child to or from somewhere: not needed when the child stays home. Words, not
 * understanding: "Collect Noa" would be postponed instead of cancelled (say it out loud).
 */
export const PICKUP_PATTERN = /pick[\s-]?up|drop[\s-]?off|接孩子|接送|送孩子|接娃|送娃|接诺娅|送诺娅/i;

export interface SituationReport {
  kind: 'sick';
  /** Who is sick. */
  memberId: string;
  /** Local `YYYY-MM-DD`. */
  date: string;
  summary: string;
}

export type SituationError = { ok: false; status: 400 | 403 | 404 | 409; code: string; message: string; current?: Item };

const refuse = (status: SituationError['status'], code: string, message: string, current?: Item): SituationError => ({ ok: false, status, code, message, ...(current ? { current } : {}) });

const memberOf = (state: HomemindState, id: string | undefined): Member | undefined => state.family.members.find(m => m.id === id);
const nameEn = (m: Member | undefined) => m?.name ?? '';
const nameZh = (m: Member | undefined) => m?.nameZh ?? m?.name ?? '';
const situationsOf = (state: HomemindState): Situation[] => state.situations ?? [];

function dayBounds(date: string, timezone: string): { start: number; end: number } {
  return { start: zonedToUtc(date, '00:00', timezone), end: zonedToUtc(addDays(date, 1), '00:00', timezone) };
}

/** The same local time `days` later (stays at 16:30 across a daylight-saving change). */
function shiftLocal(iso: string, days: number, timezone: string): string {
  const p = localParts(Date.parse(iso), timezone);
  return toIso(zonedToUtc(addDays(p.date, days), p.time, timezone));
}

function freeId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

const titleWords = (item: Item) => `${item.title} ${item.titleZh ?? ''}`;

// --- the plan -----------------------------------------------------------------------------------------------

export interface SituationPlan {
  proposals: SituationProposal[];
  available: string[];
  away: Situation['away'];
  /** Parents with an account, other than the sick member. */
  parents: string[];
}

/**
 * What falls through that day and what Homemind suggests, from `reporterId`'s view. Only the part of the
 * day still ahead counts (an event that already started is left alone).
 */
export function planSituation(state: HomemindState, reporterId: string, report: SituationReport, now: number): SituationPlan {
  const zone = state.family.timezone;
  const { start, end } = dayBounds(report.date, zone);
  const from = Math.max(start, now);
  const proposals: SituationProposal[] = [];
  const seen = new Set<string>();
  const add = (p: Omit<SituationProposal, 'id' | 'status'>) => {
    if (seen.has(p.itemId)) return;
    seen.add(p.itemId);
    proposals.push({ id: `p${proposals.length + 1}`, status: 'pending', ...p });
  };

  const live = state.items
    .filter(i => i.status === 'open' && i.start && canSeeItem(state, reporterId, i))
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.id.localeCompare(b.id));
  for (const item of live) {
    const occ = occurrences(item, from, end, zone)[0];
    if (!occ) continue;
    const attends = item.type === 'event' && item.forMemberIds.includes(report.memberId);
    const owns = item.ownership.state === 'assigned' && item.ownership.ownerId === report.memberId;
    if (attends) {
      if (item.recurrence) add({ kind: 'skip', itemId: item.id, start: item.start, date: occ.date });
      else if (PICKUP_PATTERN.test(titleWords(item))) add({ kind: 'cancel', itemId: item.id, start: item.start });
      else add({ kind: 'postpone', itemId: item.id, start: item.start, newStart: shiftLocal(item.start as string, 7, zone), ...(item.end ? { newEnd: shiftLocal(item.end, 7, zone) } : {}) });
    } else if (owns) {
      const candidateIds = eligibleOwners(state, item).filter(id => id !== report.memberId);
      if (candidateIds.length) add({ kind: 'open', itemId: item.id, start: item.start, candidateIds });
    }
  }

  // Who is away that day, as the reporter may know it (a Parents-only event leaves no trace for a teen).
  const parents = state.family.members.filter(m => m.role === 'parent' && m.hasAccount && m.id !== report.memberId).map(m => m.id);
  const away = unavailabilityFor(state, reporterId, from, end)
    .filter(u => parents.includes(u.memberId))
    .map(u => ({ memberId: u.memberId, eventId: u.eventId, start: u.start, end: u.end }));
  const available = parents.filter(id => !away.some(a => a.memberId === id));
  return { proposals, available, away, parents };
}

// --- starting one -------------------------------------------------------------------------------------------

export type StartResult =
  | { ok: true; created: true; state: HomemindState; events: CoreEvent[]; situation: Situation; activityId?: string }
  /** The same member and day was already reported: nothing new, the existing one is returned. */
  | { ok: true; created: false; state: HomemindState; events: CoreEvent[]; situation: Situation }
  | SituationError;

export interface StartOptions {
  now: number;
  clock: Clock;
  adapters: AdapterRegistry;
  /** Whether chat may change the board on its own (level 2 and up, not paused). Else the task is proposed. */
  mayWrite: boolean;
}

export function startSituation(state: HomemindState, reporterId: string, report: SituationReport, options: StartOptions): StartResult {
  const { now, clock, adapters } = options;
  const zone = state.family.timezone;
  const reporter = memberOf(state, reporterId);
  if (!reporter?.hasAccount) return refuse(403, 'forbidden', 'unknown member, or a member without an account');
  const sick = memberOf(state, report.memberId);
  if (!sick) return refuse(404, 'not_found', 'No such member');
  const today = localParts(now, zone).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date) || report.date < today) return refuse(409, 'past', 'That day is over');
  if (report.date > addDays(today, MAX_DAYS_AHEAD)) return refuse(400, 'too_far', `Only the next ${MAX_DAYS_AHEAD + 1} days`);

  const existing = situationsOf(state).find(s => s.memberId === report.memberId && s.date === report.date);
  if (existing) return { ok: true, created: false, state, events: [], situation: existing };

  const plan = planSituation(state, reporterId, report, now);
  const base = `sit-${Math.max(0, Math.floor(now)).toString(36)}`;
  const id = freeId(base, x => situationsOf(state).some(s => s.id === x) || state.whys.some(w => w.id === `why-${x}`));
  const whyId = `why-${id}`;
  let next = state;
  const events: CoreEvent[] = [];
  let stayHomeItemId: string | undefined;
  let activityId: string | undefined;

  // A child who is sick needs someone at home: "Who's taking this?" among the parents who are free.
  if (sick.role === 'child' && plan.parents.length) {
    const { start } = dayBounds(report.date, zone);
    const candidates = plan.available.length ? plan.available : plan.parents;
    const item: NewItem = {
      type: 'task',
      title: `Stay home with ${sick.name}`,
      titleZh: `在家照顾${nameZh(sick)}`,
      notes: `${sick.name} is sick (reported by ${reporter.name}).`,
      start: toIso(start),
      allDay: true,
      forMemberIds: [sick.id],
      ownership: { state: 'open', candidateIds: candidates },
      source: { kind: 'chat', label: reporter.name },
      ...(options.mayWrite ? {} : { proposed: true })
    };
    const created = applyChange(next, { kind: 'create', item }, reporterId, clock);
    if (!created.ok) return refuse(created.status as SituationError['status'], created.code, created.message);
    next = created.state;
    events.push(...created.events);
    stayHomeItemId = created.items[0]?.id;
    activityId = created.activity.id;
  }

  // Cards outside the family: each needs a parent's own tap (simulated services only).
  const cardIds: string[] = [];
  const { end } = dayBounds(report.date, zone);
  const expiresAt = toIso(end - 60_000);
  const sender = reporter.role === 'parent' ? reporter : memberOf(next, plan.available[0] ?? plan.parents[0]);
  const weekday = new Date(`${report.date}T12:00:00Z`).getUTCDay();
  const refs = plan.away.map(a => a.eventId);
  const tryCard = (input: CardInput) => {
    const prepared = prepareCard(next, input, adapters, now);
    if (prepared.ok) {
      next = prepared.state;
      cardIds.push(prepared.card.id);
    }
  };
  if (sick.role === 'child' && sender && weekday >= 1 && weekday <= 5 && end - 60_000 > now) {
    const text = draftTeacherMessage(sick, groupAuthorFor(next, sender).authorZh, report.date, today);
    tryCard({
      id: `${id}-teacher`,
      adapter: ADAPTER_IDS.teacher,
      payload: {
        teacherId: TEACHER.id,
        childId: sick.id,
        date: report.date,
        text: text.zh,
        asMemberId: sender.id,
        title: `Tell ${TEACHER.name} that ${sick.name} stays home`,
        titleZh: `告诉${TEACHER.nameZh}${nameZh(sick)}在家休息`,
        summary: `Message to ${TEACHER.name}: “${text.zh}” (${text.en}) It says only that ${sick.name} is unwell and stays home. Simulated: nothing is sent until a parent taps, and then only to the simulated teacher.`,
        summaryZh: `发给${TEACHER.nameZh}：“${text.zh}” 只说${nameZh(sick)}身体不舒服、在家休息。模拟：家长点一下之前不会发送，且只发给模拟老师。`
      },
      expiresAt,
      whyId,
      title: `Tell ${TEACHER.name} that ${sick.name} stays home`,
      titleZh: `告诉${TEACHER.nameZh}${nameZh(sick)}在家休息`,
      refs
    });
  }
  if (sick.role === 'child' && plan.parents.length && plan.available.length === 0) {
    const fromLocal = localParts(Math.max(now, dayBounds(report.date, zone).start), zone).time;
    const fromT = fromLocal > '09:00' ? roundUpHalfHour(fromLocal) : '09:00';
    const toT = '17:00';
    const sitter = [...BABYSITTERS].sort((a, b) => a.rank - b.rank).find(s => fromT < toT && sitterAvailable(s.id, report.date, fromT, toT));
    if (sitter) {
      const text = draftBabysitterMessage(sitter.id, report.date, fromT, toT, 'zh');
      const [, month, day] = report.date.split('-').map(Number);
      tryCard({
        id: `${id}-sitter`,
        adapter: ADAPTER_IDS.babysitter,
        payload: {
          sitterId: sitter.id,
          date: report.date,
          from: fromT,
          to: toT,
          text,
          title: `Babysitter for ${month}/${day} (${sick.name} stays home)`,
          titleZh: `${month}月${day}日请保姆（${nameZh(sick)}在家）`,
          summary: `No parent is free ${fromT}–${toT}. Message to ${sitter.name}, first free on the family's list: “${text}” Simulated: nothing is sent until a parent taps, and then only to the simulated sitter.`,
          summaryZh: `${fromT}–${toT} 没有家长有空。发给名单上第一位有空的${sitter.nameZh}：“${text}” 模拟：家长点一下之前不会发送，且只发给模拟保姆。`
        },
        expiresAt,
        whyId,
        title: `Babysitter for ${month}/${day} (${sick.name} stays home)`,
        titleZh: `${month}月${day}日请保姆（${nameZh(sick)}在家）`,
        refs
      });
    }
  }

  const situation: Situation = {
    id,
    at: toIso(now),
    reportedBy: reporterId,
    memberId: sick.id,
    kind: 'sick',
    date: report.date,
    summary: report.summary.slice(0, 200),
    proposals: plan.proposals,
    ...(stayHomeItemId ? { stayHomeItemId } : {}),
    ...(activityId ? { stayHomeActivityId: activityId } : {}),
    available: plan.available,
    away: plan.away,
    cardIds,
    whyId
  };
  const why = situationWhy(next, situation, reporter, sick);
  next = { ...next, whys: [...next.whys, why], situations: [...situationsOf(next), situation].slice(-MAX_SITUATIONS) };
  return { ok: true, created: true, state: next, events, situation, ...(activityId ? { activityId } : {}) };
}

function roundUpHalfHour(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.ceil((h * 60 + m) / 30) * 30;
  return total >= 24 * 60 ? '23:59' : `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Homemind's own reason (`source: 'rule'`): what it looked at and by which rules. Never presented as PPMA's. */
function situationWhy(state: HomemindState, s: Situation, reporter: Member, sick: Member): Why {
  const items = (id: string) => state.items.find(i => i.id === id);
  const title = (id: string, zh: boolean) => {
    const i = items(id);
    return i ? (zh ? i.titleZh ?? i.title : i.title) : id;
  };
  const counts = { cancel: 0, postpone: 0, skip: 0, open: 0 };
  for (const p of s.proposals) counts[p.kind]++;
  const awayNames = [...new Set(s.away.map(a => a.memberId))];
  const freeEn = s.available.length ? `${s.available.map(id => nameEn(memberOf(state, id))).join(' and ')} ${s.available.length > 1 ? 'are' : 'is'} not marked away that day` : 'No parent is free that day';
  const freeZh = s.available.length ? `${s.available.map(id => nameZh(memberOf(state, id))).join('和')}当天没有标记外出` : '当天没有家长有空';
  const awayEn = awayNames.length ? ` (away: ${awayNames.map(id => nameEn(memberOf(state, id))).join(', ')})` : '';
  const awayZh = awayNames.length ? `（外出：${awayNames.map(id => nameZh(memberOf(state, id))).join('、')}）` : '';
  const parts = [
    counts.cancel ? `${counts.cancel} pickup${counts.cancel > 1 ? 's' : ''} not needed` : '',
    counts.postpone ? `${counts.postpone} to postpone a week` : '',
    counts.skip ? `${counts.skip} weekly to skip once` : '',
    counts.open ? `${counts.open} to hand to someone else` : ''
  ].filter(Boolean);
  const partsZh = [
    counts.cancel ? `${counts.cancel} 个接送不需要了` : '',
    counts.postpone ? `${counts.postpone} 项推迟一周` : '',
    counts.skip ? `${counts.skip} 项每周活动跳过一次` : '',
    counts.open ? `${counts.open} 项交给别人` : ''
  ].filter(Boolean);
  const [, month, day] = s.date.split('-').map(Number);
  return {
    id: s.whyId,
    summary:
      `${reporter.name} said ${sick.name} is sick on ${month}/${day}. Homemind looked at ${sick.name}'s day and at who is away, with fixed rules (the model only read the message). ` +
      `${parts.length ? `Suggestions: ${parts.join(', ')}.` : 'Nothing on the board falls through.'} ` +
      (sick.role === 'child' ? `${freeEn}${awayEn}, so ${s.available.length ? 'they are asked who stays home' : 'both parents are asked, and a babysitter draft is ready if one is free'}. Homemind does not choose between them.` : ''),
    summaryZh:
      `${nameZh(reporter)}说${nameZh(sick)}${month}月${day}日生病了。Homemind 按固定规则查看了${nameZh(sick)}当天的安排和谁外出（模型只读了这条消息）。` +
      `${partsZh.length ? `建议：${partsZh.join('，')}。` : '看板上没有受影响的事项。'}` +
      (sick.role === 'child' ? `${freeZh}${awayZh}，${s.available.length ? '所以请他们决定谁留在家' : '所以请两位家长决定；如有保姆有空，已准备好草稿'}。Homemind 不替他们选。` : ''),
    basis: [
      { kind: 'report', note: s.summary.slice(0, 200) },
      ...s.proposals.map(p => ({ kind: p.kind, ref: p.itemId, note: title(p.itemId, false) })),
      ...s.away.map(a => ({ kind: 'away', ref: a.eventId, note: nameEn(memberOf(state, a.memberId)) }))
    ],
    source: 'rule'
  };
}

// --- deciding -----------------------------------------------------------------------------------------------

export type DecideResult =
  | { ok: true; state: HomemindState; events: CoreEvent[]; situation: Situation; applied: string[]; activityIds: string[]; failed: Array<{ proposalId: string; code: string; message: string }> }
  | SituationError;

function findSituation(state: HomemindState, id: string): Situation | undefined {
  return ID_PATTERN.test(id) ? situationsOf(state).find(s => s.id === id) : undefined;
}

const replaceSituation = (state: HomemindState, s: Situation): HomemindState => ({ ...state, situations: situationsOf(state).map(x => (x.id === s.id ? s : x)) });

/** The core change for one suggestion, against the item as it is now. */
function changeFor(state: HomemindState, p: SituationProposal): Change | SituationError {
  const item = state.items.find(i => i.id === p.itemId);
  if (!item || item.status !== 'open') return refuse(409, 'gone', 'This is no longer on the board', item);
  if (p.start && item.start !== p.start) return refuse(409, 'changed', 'This moved since the suggestion. Here is the latest.', item);
  switch (p.kind) {
    case 'cancel':
      return { kind: 'cancel', itemId: item.id, version: item.version };
    case 'skip':
      return { kind: 'cancel_occurrence', itemId: item.id, version: item.version, date: p.date as string };
    case 'postpone':
      return { kind: 'edit', itemId: item.id, version: item.version, patch: { start: p.newStart, ...(p.newEnd ? { end: p.newEnd } : {}) } };
    case 'open':
      if (item.ownership.state === 'open') return refuse(409, 'changed', 'Someone already asked who takes this', item);
      return { kind: 'open', itemId: item.id, version: item.version, ...(p.candidateIds?.length ? { candidateIds: p.candidateIds } : {}) };
  }
}

/**
 * Apply one suggestion (`proposalId`) or every one still waiting (`'all'`), as `memberId`. Each is its own
 * core change with its own Undo. With `'all'`, one that no longer fits is skipped and reported; the rest go.
 */
export function applySuggestions(state: HomemindState, situationId: string, proposalId: string | 'all', memberId: string, clock: Clock): DecideResult {
  const s = findSituation(state, situationId);
  if (!s || !canSeeSituation(state, memberId, s)) return refuse(404, 'not_found', 'No such situation');
  const targets = proposalId === 'all' ? s.proposals.filter(p => p.status === 'pending') : s.proposals.filter(p => p.id === proposalId);
  if (!targets.length) return refuse(proposalId === 'all' ? 409 : 404, proposalId === 'all' ? 'nothing_waiting' : 'not_found', proposalId === 'all' ? 'Nothing is waiting' : 'No such suggestion');
  let next = state;
  const events: CoreEvent[] = [];
  const applied: string[] = [];
  const activityIds: string[] = [];
  const failed: Array<{ proposalId: string; code: string; message: string }> = [];
  let proposals = s.proposals;
  for (const p of targets) {
    if (p.status !== 'pending') {
      if (proposalId !== 'all') return refuse(409, 'decided', 'This suggestion was already decided');
      continue;
    }
    const change = changeFor(next, p);
    if ('ok' in change) {
      if (proposalId !== 'all') return change;
      failed.push({ proposalId: p.id, code: change.code, message: change.message });
      continue;
    }
    const result = applyChange(next, change, memberId, clock);
    if (!result.ok) {
      if (proposalId !== 'all') return fromCore(result);
      failed.push({ proposalId: p.id, code: result.code, message: result.message });
      continue;
    }
    next = result.state;
    events.push(...result.events);
    applied.push(p.id);
    activityIds.push(result.activity.id);
    const at = result.activity.at;
    proposals = proposals.map(x => (x.id === p.id ? { ...x, status: 'applied' as const, activityId: result.activity.id, by: memberId, at } : x));
  }
  const situation = { ...s, proposals };
  return { ok: true, state: replaceSituation(next, situation), events, situation, applied, activityIds, failed };
}

const fromCore = (e: ChangeError): SituationError => refuse(e.status as SituationError['status'], e.code, e.message, e.current);

/** "Not now": nothing changes on the board; the suggestion is put aside (Undo brings it back). */
export function dismissSuggestion(state: HomemindState, situationId: string, proposalId: string, memberId: string, now: number): DecideResult {
  const s = findSituation(state, situationId);
  if (!s || !canSeeSituation(state, memberId, s)) return refuse(404, 'not_found', 'No such situation');
  const p = s.proposals.find(x => x.id === proposalId);
  if (!p || !canSeeProposal(state, memberId, p)) return refuse(404, 'not_found', 'No such suggestion');
  if (p.status !== 'pending') return refuse(409, 'decided', 'This suggestion was already decided');
  const situation = { ...s, proposals: s.proposals.map(x => (x.id === p.id ? { ...x, status: 'dismissed' as const, by: memberId, at: toIso(now) } : x)) };
  return { ok: true, state: replaceSituation(state, situation), events: [], situation, applied: [], activityIds: [], failed: [] };
}

/** Undo of Apply (the core Undo of that change) or of "Not now". The suggestion waits again. */
export function undoSuggestion(state: HomemindState, situationId: string, proposalId: string, memberId: string, clock: Clock): DecideResult {
  const s = findSituation(state, situationId);
  if (!s || !canSeeSituation(state, memberId, s)) return refuse(404, 'not_found', 'No such situation');
  const p = s.proposals.find(x => x.id === proposalId);
  if (!p || !canSeeProposal(state, memberId, p)) return refuse(404, 'not_found', 'No such suggestion');
  const reopen = (st: HomemindState, events: CoreEvent[], activityIds: string[]): DecideResult => {
    const situation = { ...s, proposals: s.proposals.map(x => (x.id === p.id ? { id: x.id, kind: x.kind, itemId: x.itemId, ...pickPlan(x), status: 'pending' as const } : x)) };
    return { ok: true, state: replaceSituation(st, situation), events, situation, applied: [], activityIds, failed: [] };
  };
  if (p.status === 'dismissed') return reopen(state, [], []);
  if (p.status !== 'applied' || !p.activityId) return refuse(409, 'nothing_to_undo', 'Nothing to undo');
  const result = applyChange(state, { kind: 'undo', activityId: p.activityId }, memberId, clock);
  if (!result.ok) return fromCore(result);
  return reopen(result.state, result.events, [result.activity.id]);
}

function pickPlan(p: SituationProposal): Partial<SituationProposal> {
  return {
    ...(p.start ? { start: p.start } : {}),
    ...(p.newStart ? { newStart: p.newStart } : {}),
    ...(p.newEnd ? { newEnd: p.newEnd } : {}),
    ...(p.date ? { date: p.date } : {}),
    ...(p.candidateIds ? { candidateIds: [...p.candidateIds] } : {})
  };
}

// --- what a member sees -------------------------------------------------------------------------------------

function canSeeProposal(state: HomemindState, memberId: string, p: SituationProposal): boolean {
  const item = state.items.find(i => i.id === p.itemId);
  return !!item && canSeeItem(state, memberId, item);
}

/** Every member with an account sees a situation about their family; its parts are filtered item by item. */
function canSeeSituation(state: HomemindState, memberId: string, _s: Situation): boolean {
  return !!memberOf(state, memberId)?.hasAccount;
}

/**
 * The situations a member's screens show: from today on (and the last one until 12 hours after its day),
 * with only the suggestions, items and away entries that member may see.
 */
export function situationsView(state: HomemindState, memberId: string, now: number): SituationView[] {
  const zone = state.family.timezone;
  return situationsOf(state)
    .filter(s => canSeeSituation(state, memberId, s) && dayBounds(s.date, zone).end + SHOW_AFTER_DAY_MS > now)
    .map(s => situationViewFor(state, memberId, s))
    .reverse();
}

export function situationViewFor(state: HomemindState, memberId: string, s: Situation): SituationView {
  const proposals = s.proposals.filter(p => canSeeProposal(state, memberId, p));
  const away = s.away.filter(a => {
    const event = state.items.find(i => i.id === a.eventId);
    return !!event && canSeeItem(state, memberId, event);
  });
  const ids = [...new Set([...proposals.map(p => p.itemId), ...(s.stayHomeItemId ? [s.stayHomeItemId] : []), ...away.map(a => a.eventId)])];
  const items = ids.flatMap(id => {
    const item = state.items.find(i => i.id === id);
    if (!item || !canSeeItem(state, memberId, item)) return [];
    return [{ id: item.id, title: item.title, ...(item.titleZh ? { titleZh: item.titleZh } : {}), ...(item.start ? { start: item.start } : {}), type: item.type, status: item.status }];
  });
  const cardIds = s.cardIds.filter(id => {
    const card = state.actionCards.find(c => c.id === id);
    return !!card && !(card.refs ?? []).some(ref => {
      const item = state.items.find(i => i.id === ref);
      return item ? !canSeeItem(state, memberId, item) : false;
    });
  });
  // The member's own words go to parents and to whoever said them; a teen gets what Homemind made of them.
  const viewer = memberOf(state, memberId);
  const summary = viewer?.role === 'parent' || memberId === s.reportedBy ? s.summary : '';
  const situation: Situation = { ...s, summary, proposals, away, cardIds };
  if (!s.stayHomeItemId || !items.some(i => i.id === s.stayHomeItemId)) delete situation.stayHomeItemId;
  return { situation, items };
}
