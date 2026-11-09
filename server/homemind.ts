/**
 * Homemind bridge: the thin adapter between the browser and the Homemind core.
 *
 * It validates requests, identifies the member, calls `server/homemind/*` (the source of truth) and
 * answers. The core never sees HTTP, and this file holds no business rules. Active only with
 * `HOMEMIND_ENABLED=1`: without it `handleHomemindRequest` returns false and the request goes on to
 * whatever handled it before Homemind existed.
 *
 * Identity is a demo sign-in (pick a member, no password). The bridge signs a token that holds the
 * member id; the client keeps it in `sessionStorage` and sends it as `x-homemind-session`, so two
 * windows can be two people. Roles (for example "Parents only") are enforced here and in the core.
 *
 * Routes whose task has not been built yet are whitelisted and answer 501 `not_implemented`, so
 * nothing pretends to work. Chat (`POST /chat`, T5.2) reads a message
 * through the model (server/homemind/intents.ts) and plans it with server/homemind/chat.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { findConflicts, conflictsVisibleTo, mayOpenOnItsOwn, proposeForConflicts } from './homemind/availability';
import type { Conflict } from './homemind/availability';
import { createDemoClock } from './homemind/clock';
import type { DemoClock } from './homemind/clock';
import { applyChange } from './homemind/core';
import type { CoreEvent } from './homemind/core';
import { alertsForChange } from './homemind/alerts';
import type { AlertDelivery } from './homemind/alerts';
import { activeReminderFor, pendingRemindersFor, respondToReminder, tickReminders } from './homemind/reminders';
import type { ReminderResponse, TickResult } from './homemind/reminders';
import { startScheduler, stopScheduler } from './homemind/scheduler';
import { createEventHub } from './homemind/events';
import type { EventHub } from './homemind/events';
import type { Change, ChangeError, ItemPatch, NewItem } from './homemind/core';
import { seedState } from './homemind/seed';
import { cancelCard, executeAction, expireCards, issueConfirmation } from './homemind/actions';
import type { ActionErrorCode, AdapterRegistry } from './homemind/actions';
import { applySettings, parseSettingsPatch } from './homemind/settings';
import { applyRuleRequest, parseRuleBody, prepareRuleNow, runRules } from './homemind/rules';
import { afterGroupCard, applyGroupPolicy, considerSignUps, groupAutoAllowed, groupsView, parseGroupPolicyBody, reconsiderSignUp, requestGroupChange } from './homemind/groupClaims';
import { planMailItem } from './homemind/inbox';
import { KINDERGARTEN_GROUP, createSimulatedAdapters, postNextGroupMessage, servicesViewFor, updateGroupMessages } from './homemind/fakes';
import { detectSourceChanges, resolveSourceChange, sourceChangesView, undoSourceChange } from './homemind/sourceChanges';
import { createLlmClient, llmConfigFromEnv, llmStatus } from './homemind/llm';
import type { LlmClient } from './homemind/llm';
import { isImageDataUrl, MAX_IMAGE_DATA_URL, runExtraction, runIntent, LIMITS as INTENT_LIMITS } from './homemind/intents';
import type { ChatLine } from './homemind/intents';
import { applyExtraction } from './homemind/extraction';
import { chatMayWrite, planChat } from './homemind/chat';
import { applySuggestions, dismissSuggestion, situationsView, startSituation, undoSuggestion } from './homemind/situations';
import { judgeMessage } from './homemind/judgment';
import { summaryFor, tickSummaries } from './homemind/summary';
import { applyPreferenceRequest, blockedChange, parsePreferenceBody, preferencesForItem } from './homemind/preferences';
import type { BlockedChoice, PreferenceRequest, PreferenceResult } from './homemind/preferences';
import { HomemindStore, dataFileFromEnv } from './homemind/store';
import { createPpmaClient, fileSyncStore, isStatementId, ppmaConfigFromEnv, ppmaSyncFileFor } from './homemind/ppma';
import type { PpmaClient } from './homemind/ppma';
import { groupMessageReport, handlePpmaCommand, preferenceReport, reminderReport, reportsForChange } from './homemind/ppmaMap';
import type { PpmaReport } from './homemind/ppmaMap';
import type { LoadSource } from './homemind/store';
import { ID_PATTERN } from './homemind/types';
import type { GroupClaim, HomemindState, Item, Lang, Member, PpmaStatus, StreamMessage } from './homemind/types';
import { redactItem, searchItems, viewFor } from './homemind/visibility';
import { isSameOrigin } from './orbit';
import { chatTurn, screenTurn } from '../src/lib/homemindSurfaces';
import type { ChatOutcome } from '../src/lib/homemindSurfaces';

export const SESSION_HEADER = 'x-homemind-session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 16;
const MAX_BODY = 64 * 1024;
/** `POST /chat` may carry one screenshot as a data URL (T5.3). */
const MAX_CHAT_BODY = MAX_IMAGE_DATA_URL + 64 * 1024;
const HEARTBEAT_MS = 15_000;
const CONFLICT_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
/** The demo clock jumps at most a week at a time. */
const MAX_JUMP_MINUTES = 7 * 24 * 60;

const SCREENS = ['my-day', 'family', 'calendar', 'search', 'rules', 'memory', 'activity', 'settings', 'edit', 'item', 'services', 'summary'] as const;
type Screen = (typeof SCREENS)[number];

/** Verbs on `POST /items/:id/:verb` that map straight to a core change. `ack` is the core's `confirm`. */
const CORE_VERBS = ['assign', 'open', 'unassign', 'claim', 'ack', 'handback', 'done', 'cancel', 'cancel_occurrence', 'approve', 'dismiss', 'undo'] as const;
type CoreVerb = (typeof CORE_VERBS)[number];

const CREATE_KEYS = ['type', 'title', 'notes', 'start', 'end', 'allDay', 'forMemberIds', 'visibility', 'sensitive', 'importance', 'unavailableMemberIds', 'recurrence', 'parentEventId', 'ownerId'];
const PATCH_KEYS = ['title', 'notes', 'start', 'end', 'allDay', 'forMemberIds', 'visibility', 'sensitive', 'importance', 'unavailableMemberIds', 'recurrence'];

// --- small helpers ------------------------------------------------------------------------------------

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
}

const fail = (response: ServerResponse, status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json(response, status, { error, message, ...extra });

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function readBody(request: IncomingMessage, limit: number = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // Past the limit, keep reading (and dropping) up to 4x, so the client gets the 413 instead of a
    // reset connection while it is still uploading. Beyond that, stop reading at once.
    if (size > limit * 4) throw new HttpError(413, 'too_large', 'The request body is too large');
    if (size <= limit) chunks.push(chunk as Buffer);
  }
  if (size > limit) throw new HttpError(413, 'too_large', 'The request body is too large');
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid', 'The body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid', 'The body must be a JSON object');
  return parsed as Record<string, unknown>;
}

const enabled = () => process.env.HOMEMIND_ENABLED === '1';
const demo = () => process.env.HOMEMIND_DEMO === '1';
const langOf = (url: URL): Lang => (url.searchParams.get('lang') === 'zh' ? 'zh' : 'en');

// --- session token ------------------------------------------------------------------------------------

function secret(): string | null {
  const value = process.env.HOMEMIND_SECRET?.trim();
  return value && value.length >= MIN_SECRET_LENGTH ? value : null;
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');
const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest('base64url');

/** `<payload>.<signature>`; the payload holds the member id and an expiry. */
export function signSession(memberId: string, key: string, nowMs: number = Date.now()): string {
  const body = b64(JSON.stringify({ m: memberId, exp: nowMs + SESSION_TTL_MS }));
  return `${body}.${sign(body, key)}`;
}

/** The member id in a valid, unexpired token, else null. */
export function verifySession(token: string | undefined, key: string, nowMs: number = Date.now()): string | null {
  return readSession(token, key, nowMs)?.memberId ?? null;
}

function readSession(token: string | undefined, key: string, nowMs: number): { memberId: string; exp: number } | null {
  if (!token || token.length > 512) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { m?: unknown; exp?: unknown };
    if (typeof payload.m !== 'string' || typeof payload.exp !== 'number' || payload.exp < nowMs) return null;
    return { memberId: payload.m, exp: payload.exp };
  } catch {
    return null;
  }
}

// --- runtime: the one state, store and clock of this process ------------------------------------------

interface Runtime {
  file: string;
  state: HomemindState;
  clock: DemoClock;
  store: HomemindStore;
  source: LoadSource;
  /** Open live-update streams, one subscriber each. */
  hub: EventHub;
  /** One model client per runtime, made again only when the model settings change. */
  llm?: { key: string; client: LlmClient };
  /** The PPMA client (T6.1), when `PPMA_URL` is set. Memory and advice only: never awaited in a request. */
  ppma?: PpmaClient;
  /** The simulated services' adapters (T7.2), bound to this runtime's state and clock. */
  adapters?: AdapterRegistry;
  /** Each member's recent chat lines, in memory only, so "yes" or "no, I meant..." reaches the model with
   * what it answers. Never shared between members; dropped after a quiet spell and on a demo reset. */
  chats?: Map<string, { lines: ChatLine[]; at: number }>;
}

interface Holder {
  file: string;
  ready: Promise<Runtime>;
}

// A global, so a Vite reload of this module does not load the state a second time.
const HOLDER = Symbol.for('homemind.runtime');
type GlobalWithHolder = typeof globalThis & { [HOLDER]?: Holder };

async function runtime(): Promise<Runtime> {
  const holders = globalThis as GlobalWithHolder;
  const file = dataFileFromEnv(process.env);
  if (!holders[HOLDER] || holders[HOLDER].file !== file) {
    const store = new HomemindStore({ file, seed: () => seedState({ now: Date.now() }) });
    const ready = store.load().then(({ state, source, movedTo }) => {
      if (source === 'recovered') console.warn(`[homemind] the state file was unreadable; moved to ${movedTo} and reseeded`);
      const rt: Runtime = { file, state, source, store, hub: createEventHub(), clock: createDemoClock(Date.now, state.clockOffsetMs) };
      startPpma(rt);
      return rt;
    });
    holders[HOLDER] = { file, ready };
    // One tick loop per process. It ticks only the runtime that is loaded, and never loads one.
    startScheduler(scheduledTick);
    ready.catch(() => {
      if (holders[HOLDER]?.ready === ready) delete holders[HOLDER];
    });
  }
  return holders[HOLDER].ready;
}

/** For tests: forget the loaded state so the next request loads `HOMEMIND_DATA_FILE` again. */
export function resetHomemindRuntime(): void {
  const holder = (globalThis as GlobalWithHolder)[HOLDER];
  delete (globalThis as GlobalWithHolder)[HOLDER];
  stopScheduler();
  // Close the streams of the runtime being dropped, so none is left open on a state nobody updates.
  holder?.ready.then(
    rt => {
      rt.hub.closeAll();
      void rt.ppma?.stop();
    },
    () => undefined
  );
}

// --- PPMA (T6.1) --------------------------------------------------------------------------------------

/**
 * Starts the PPMA client for this runtime when `PPMA_URL` is set. Its queue and stream position live in
 * a file beside the state file (`state.ppma.json`), which a demo reset does not touch, so commands
 * PPMA sent before a reset are never run again.
 */
function startPpma(rt: Runtime): void {
  const config = ppmaConfigFromEnv();
  if (!config.url) return;
  const client = createPpmaClient(config, { sync: fileSyncStore(ppmaSyncFileFor(rt.file)) });
  client.setCommandHandler(async command => {
    const handled = handlePpmaCommand(rt.state, command, rt.clock.now());
    // A proposal is a change like any other: saved, shown to every stream, reminders ticked. No actor:
    // it is PPMA's, so nobody gets an alert "from" a parent, and PPMA's report names no member.
    if (handled.state) await commit(rt, handled.state, handled.events ?? []);
    return handled.outcome;
  });
  client.onStatus(status => rt.hub.broadcast({ event: 'ppma.status', data: { status } }));
  // The memory or an explanation arrived or changed: open screens read again (the news carries nothing).
  client.onMemory(() => rt.hub.broadcast({ event: 'memory.changed', data: {} }));
  rt.ppma = client;
  client.start();
}

const ppmaStatusOf = (rt: Runtime): PpmaStatus => rt.ppma?.status() ?? 'off';
/** Screens know three states: a connection still being made counts as offline until it works. */
const ppmaForScreens = (rt: Runtime): 'off' | 'offline' | 'ok' => {
  const status = ppmaStatusOf(rt);
  return status === 'connecting' ? 'offline' : status;
};

/** Queues reports for PPMA. Never throws and never waits: PPMA must not slow down or fail a user action. */
function reportToPpma(rt: Runtime, reports: readonly (PpmaReport | null)[]): void {
  if (!rt.ppma) return;
  for (const report of reports) {
    if (!report) continue;
    try {
      rt.ppma.emit(report.type, report.payload);
    } catch {
      // emit does not throw; this guards the request path anyway.
    }
  }
}

let llmOverride: LlmClient | undefined;
/** For tests: answer chat with this client instead of the one `HOMEMIND_LLM` describes. */
export function setHomemindLlmForTests(client: LlmClient | undefined): void {
  llmOverride = client;
}

function llmOf(rt: Runtime): LlmClient {
  if (llmOverride) return llmOverride;
  const config = llmConfigFromEnv();
  const key = JSON.stringify(config);
  if (rt.llm?.key !== key) rt.llm = { key, client: createLlmClient(config) };
  return rt.llm.client;
}

let heartbeatMs = HEARTBEAT_MS;
/** For tests: how often an idle stream gets a comment line. */
export function setHomemindHeartbeatMs(ms: number | undefined): void {
  heartbeatMs = ms ?? HEARTBEAT_MS;
}

/**
 * Saves, then tells the open streams. A change is visible to others only once it is the state. The
 * reminders follow the change in the same step (a confirmation closes its reminder for everyone), and
 * the change's own alerts go through quiet hours and batching with them.
 */
async function commit(rt: Runtime, state: HomemindState, events: readonly CoreEvent[] = [], actorId?: string, extraAlerts: readonly AlertDelivery[] = []): Promise<void> {
  const before = rt.state;
  const now = rt.clock.now();
  // `extraAlerts`: notices Homemind itself makes with the change (T7.4: "signed up in the group").
  const alerts = [...(actorId ? alertsForChange(before, state, events, actorId, new Date(now).toISOString()) : []), ...extraAlerts];
  const ticked = tickReminders(state, now, alerts);
  rt.state = ticked.state;
  await rt.store.save(ticked.state);
  rt.hub.publishChanges(ticked.state, events);
  publishTick(rt, ticked);
  // A calendar change can change what a waiting rule card should say (who is home): check at once.
  if (events.length) await applyRules(rt);
  if (rt.ppma && events.length) {
    try {
      reportToPpma(rt, reportsForChange(before, ticked.state, events, actorId));
    } catch {
      console.warn('[homemind] could not prepare the PPMA report for a change');
    }
  }
}

function publishTick(rt: Runtime, ticked: TickResult): void {
  for (const closed of ticked.closed) rt.hub.publishClosed(closed.recipientIds, closed.reminderId);
  rt.hub.publishAlerts(rt.state, ticked.deliveries);
}

/**
 * T7.3: the standing rules look at their next occurrence (rules.ts). A rule only prepares cards; when it
 * prepared, replaced or stopped one, the state is saved and every window re-reads. Returns whether it did.
 */
async function applyRules(rt: Runtime): Promise<boolean> {
  const step = runRules(rt.state, rt.clock.now(), adaptersOf(rt));
  if (!step.changed) return false;
  rt.state = step.state;
  await rt.store.save(step.state);
  rt.hub.broadcast({ event: 'actions.changed', data: {} });
  return true;
}

/**
 * One tick on the loaded state: the standing rules (T7.3), action cards past their time expire
 * (visibly, T7.1), then reminders. Reads and replaces the state with no await in between.
 */
async function tickNow(rt: Runtime): Promise<TickResult> {
  await applyRules(rt);
  const expired = expireCards(rt.state, rt.clock.now());
  if (expired.expired.length) {
    rt.state = expired.state;
    rt.hub.broadcast({ event: 'actions.changed', data: {} });
  }
  // T8.2: the evening summary goes out when a tick crosses 20:00; its notices are routed like any alert.
  const summaries = tickSummaries(rt.state, rt.clock.now());
  if (summaries.changed) rt.state = summaries.state;
  if (summaries.sent) rt.hub.broadcast({ event: 'services.changed', data: {} });
  const ticked = tickReminders(rt.state, rt.clock.now(), summaries.deliveries);
  if ((expired.expired.length || summaries.changed) && !ticked.changed) await rt.store.save(rt.state);
  if (!ticked.changed && ticked.deliveries.length === 0 && ticked.closed.length === 0) return ticked;
  rt.state = ticked.state;
  await rt.store.save(ticked.state);
  publishTick(rt, ticked);
  return ticked;
}

/** The scheduler's task: tick the runtime that is loaded, if Homemind is on. */
async function scheduledTick(): Promise<void> {
  const holder = (globalThis as GlobalWithHolder)[HOLDER];
  if (!holder || !enabled()) return;
  await tickNow(await holder.ready);
}

// --- action cards (T7.1) ------------------------------------------------------------------------------

/**
 * The adapters actions may run: the simulated services (fakes.ts: group reply, pizza, babysitter), bound
 * to this runtime. An adapter replaces `rt.state` without saving; `executeAction` saves right after it.
 * There are no real adapters in the demo.
 */
let adaptersOverride: AdapterRegistry | undefined;

/** For tests: the adapters to use (`undefined` puts back the built-in set). */
export function setHomemindAdaptersForTests(registry: AdapterRegistry | undefined): void {
  adaptersOverride = registry;
}

function adaptersOf(rt: Runtime): AdapterRegistry {
  if (adaptersOverride) return adaptersOverride;
  rt.adapters ??= createSimulatedAdapters({
    get: () => rt.state,
    set: state => {
      rt.state = state;
    },
    now: () => rt.clock.now()
  });
  return rt.adapters;
}

/** The confirmation-token key: derived from `HOMEMIND_SECRET`, so a session token can't pass as one. */
const actionKey = (key: string) => createHmac('sha256', key).update('homemind.action-confirm').digest();

/** Tokens for this parent's pending cards, one per card, for the card's button. Nothing for anyone else. */
function confirmationsFor(rt: Runtime, member: Member): Record<string, { token: string; expiresAt: string }> {
  const key = secret();
  const out: Record<string, { token: string; expiresAt: string }> = {};
  if (!key || member.role !== 'parent') return out;
  for (const card of rt.state.actionCards) {
    if (card.status !== 'pending') continue;
    const issued = issueConfirmation(rt.state, card.id, member.id, { key: actionKey(key), now: rt.clock.now() }, adaptersOf(rt));
    if (issued.ok) out[card.id] = { token: issued.token, expiresAt: issued.expiresAt };
  }
  return out;
}

const ACTION_STATUS: Record<ActionErrorCode, number> = {
  not_found: 404,
  no_adapter: 409,
  invalid_payload: 422,
  not_parent: 403,
  wrong_member: 403,
  bad_token: 403,
  wrong_card: 403,
  no_token: 400,
  not_pending: 409,
  expired: 409,
  token_expired: 409,
  token_used: 409,
  payload_changed: 409,
  auto_not_allowed: 403,
  held: 409
};

/** Saves a state that changed only action cards (and their Activity), and tells every window to re-read. */
async function commitCards(rt: Runtime, state: HomemindState): Promise<void> {
  rt.state = state;
  await rt.store.save(state);
  rt.hub.broadcast({ event: 'actions.changed', data: {} });
}

/** `POST /actions/:id/confirm {token}`: a parent's tap on that card. The guard is in actions.ts. */
async function confirmAction(ctx: Ctx): Promise<void> {
  const body = pick(await readBody(ctx.request), ['token'], 'confirm');
  if (body.token !== undefined && (typeof body.token !== 'string' || body.token.length > 1024)) throw new HttpError(400, 'invalid', 'token must be a string');
  const { rt } = ctx;
  const result = await executeAction(
    { get: () => rt.state, set: state => commitCards(rt, state) },
    ctx.params[0],
    { kind: 'tap', memberId: ctx.member.id, token: body.token as string | undefined },
    { adapters: adaptersOf(rt), key: actionKey(secret() as string), now: () => rt.clock.now() }
  );
  // T7.4: a group claim or correction that ran puts its party and preparations on the board.
  if (result.ok || result.code === 'action_failed') await afterGroupAction(rt, ctx.params[0]);
  if (result.ok) return json(ctx.response, 200, { ok: true, card: result.card, activityId: result.activity.id });
  if (result.code === 'action_failed') return fail(ctx.response, 502, 'action_failed', result.message, { card: result.card, activityId: result.activity.id });
  // "This changed. Here is the latest": the card as it is now, when the member may see it.
  const card = rt.state.actionCards.find(c => c.id === ctx.params[0]);
  fail(ctx.response, ACTION_STATUS[result.code], result.code, result.message, card && result.code !== 'not_found' ? { card } : {});
}

/** `POST /actions/:id/cancel`: a parent cancels a pending card. */
async function cancelAction(ctx: Ctx): Promise<void> {
  pick(await readBody(ctx.request), [], 'cancel');
  const result = cancelCard(ctx.rt.state, ctx.params[0], ctx.member.id, ctx.rt.clock.now());
  if (!result.ok) return fail(ctx.response, ACTION_STATUS[result.code], result.code, result.message);
  await commitCards(ctx.rt, result.state);
  json(ctx.response, 200, { ok: true, card: result.card, activityId: result.activity.id });
}

// --- group sign-up claims (T7.4) ----------------------------------------------------------------------

/**
 * After a group card ran (a claim or a correction, by a tap or at level 4): the party and preparations go
 * on the board as one committed change, with the family's notice. Nothing for any other card.
 */
async function afterGroupAction(rt: Runtime, cardId: string): Promise<void> {
  const card = rt.state.actionCards.find(c => c.id === cardId);
  if (!card) return;
  const done = afterGroupCard(rt.state, card, rt.clock.now(), rt.clock);
  if (!done) return;
  await commit(rt, done.state, done.events, undefined, done.alerts);
  rt.hub.broadcast({ event: 'services.changed', data: {} });
}

/** Runs a waiting group card on its own (autonomy level 4). The guard in actions.ts decides; a refusal leaves it waiting. */
async function autoRunGroupCard(rt: Runtime, cardId: string): Promise<void> {
  const key = secret();
  if (!key || !groupAutoAllowed(rt.state)) return;
  await executeAction({ get: () => rt.state, set: state => commitCards(rt, state) }, cardId, { kind: 'auto' }, { adapters: adaptersOf(rt), key: actionKey(key), now: () => rt.clock.now() });
  await afterGroupAction(rt, cardId);
}

/**
 * New sign-ups in a group whose claims are on: record what was read, prepare the claim card, and post it
 * at once when the group is set to post on its own. Returns the claims as they are afterwards.
 */
async function runGroupClaims(rt: Runtime): Promise<GroupClaim[]> {
  const step = considerSignUps(rt.state, rt.clock.now(), adaptersOf(rt));
  if (!step.changed) return [];
  await commitCards(rt, step.state);
  rt.hub.broadcast({ event: 'services.changed', data: {} });
  for (const claim of step.claims) if (claim.status === 'waiting' && claim.cardId) await autoRunGroupCard(rt, claim.cardId);
  return step.claims.map(c => (rt.state.groupClaims ?? []).find(x => x.id === c.id) ?? c);
}

/** T7.5: stopped sign-ups whose message changed are read again (and may claim, at level 4 at once). */
async function rereadSignUps(rt: Runtime, messageIds: readonly string[]): Promise<void> {
  for (const messageId of messageIds) {
    const step = reconsiderSignUp(rt.state, messageId, rt.clock.now(), adaptersOf(rt));
    if (!step.changed) continue;
    await commitCards(rt, step.state);
    rt.hub.broadcast({ event: 'services.changed', data: {} });
    for (const claim of step.claims) if (claim.status === 'waiting' && claim.cardId) await autoRunGroupCard(rt, claim.cardId);
  }
}

/**
 * T7.5: after a group message got a new version: compare it in code with what the family's work was made
 * from, mark what depends on it, hold the cards that quote it, and tell the owners. Returns the new changes.
 */
async function runSourceChanges(rt: Runtime): Promise<string[]> {
  const step = detectSourceChanges(rt.state, rt.clock.now(), rt.clock);
  if (step.changed) {
    await commit(rt, step.state, step.events, undefined, step.alerts);
    rt.hub.broadcast({ event: 'actions.changed', data: {} });
    rt.hub.broadcast({ event: 'services.changed', data: {} });
  }
  await rereadSignUps(rt, step.reread);
  return step.changes.map(c => c.id);
}

const claimSummary = (c: GroupClaim) => ({ id: c.id, status: c.status, ...(c.reason ? { reason: c.reason } : {}), ...(c.choice ? { choice: c.choice } : {}) });

// --- requests -----------------------------------------------------------------------------------------

interface Ctx {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: string[];
  rt: Runtime;
  /** The signed-in member. Set for routes that need a session. */
  member: Member;
  /** When the session token expires (ms since epoch). Set with `member`. */
  sessionExpiresAt: number;
  lang: Lang;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  pattern: RegExp;
  /** Whether a session is needed. */
  auth: boolean;
  /** Only when `HOMEMIND_DEMO=1`; otherwise the route does not exist (404). */
  demoOnly?: boolean;
  handler: Handler;
}

/** A change refused because a hard preference rules it out (T5.4). Hard preferences are never overridden. */
interface BlockedByPreference {
  ok: false;
  status: 422;
  code: 'blocked_by_preference';
  message: string;
  blocked: BlockedChoice[];
  current?: undefined;
}
type Refusal = ChangeError | BlockedByPreference;

function changeFailed(ctx: Ctx, error: Refusal): void {
  if (error.code === 'blocked_by_preference') {
    const preferences = error.blocked.map(b => ({ id: b.preference.id, text: b.preference.text, textZh: b.preference.textZh, aboutMemberId: b.preference.aboutMemberId, term: b.term }));
    return fail(ctx.response, error.status, error.code, error.message, { preferences });
  }
  const current = error.current ? redactItem(ctx.rt.state, ctx.member.id, error.current) : undefined;
  fail(ctx.response, error.status, error.code, error.message, current ? { current } : {});
}

function itemsById(state: HomemindState, memberId: string, ids: string[]): Item[] {
  return ids.flatMap(id => {
    const item = state.items.find(i => i.id === id);
    return item ? [redactItem(state, memberId, item)] : [];
  });
}

/**
 * After an event that makes someone unavailable is created or edited: find the items it clashes with.
 * When Homemind may act on its own, open them ("Who's taking this?") as the same member, so they have
 * Undo. Otherwise return the conflicts as suggestions. Never fails the change that caused it.
 */
async function checkAvailability(ctx: Ctx, eventId: string): Promise<{ conflicts: Conflict[]; opened: string[] }> {
  const { rt, member } = ctx;
  const event = rt.state.items.find(i => i.id === eventId);
  if (!event || event.type !== 'event' || event.status !== 'open' || event.unavailableMemberIds.length === 0) return { conflicts: [], opened: [] };
  const now = rt.clock.now();
  const found = findConflicts(rt.state, now, now + CONFLICT_HORIZON_MS, { eventId });
  if (found.length === 0) return { conflicts: [], opened: [] };
  if (!mayOpenOnItsOwn(rt.state.family)) {
    return { conflicts: conflictsVisibleTo(rt.state, member.id, found), opened: [] };
  }
  const proposal = proposeForConflicts(rt.state, found, member.id, rt.clock);
  if (!proposal.ok) return { conflicts: conflictsVisibleTo(rt.state, member.id, found), opened: [] };
  await commit(rt, proposal.state, proposal.events, member.id);
  return { conflicts: [], opened: proposal.openedItemIds };
}

interface Applied {
  ok: true;
  activityId: string;
  changedIds: string[];
  items: Item[];
  opened: string[];
  conflicts: Conflict[];
}

/** Applies one change as the member, saves and publishes it, then runs the availability check. */
async function applyAndCommit(ctx: Ctx, change: Change, afterEventId?: (changedIds: string[]) => string | undefined): Promise<Applied | Refusal> {
  const { rt, member } = ctx;
  // A preparation or task that a hard preference rules out never reaches the board, from any path.
  const blocked = blockedChange(rt.state, change);
  if (blocked.length) {
    const words = blocked.map(b => `${b.preference.text} (${b.term})`).join('; ');
    return { ok: false, status: 422, code: 'blocked_by_preference', message: `A preference that is never overridden rules this out: ${words}`, blocked };
  }
  const result = applyChange(rt.state, change, member.id, rt.clock);
  if (!result.ok) return result;
  await commit(rt, result.state, result.events, member.id);
  const changedIds = result.items.map(i => i.id);
  const eventId = afterEventId?.(changedIds);
  const availability = eventId ? await checkAvailability(ctx, eventId) : { conflicts: [], opened: [] };
  return {
    ok: true,
    activityId: result.activity.id,
    changedIds,
    items: itemsById(rt.state, member.id, [...changedIds, ...availability.opened]),
    opened: availability.opened,
    conflicts: availability.conflicts
  };
}

async function runChange(ctx: Ctx, change: Change, afterEventId?: (changedIds: string[]) => string | undefined): Promise<void> {
  const result = await applyAndCommit(ctx, change, afterEventId);
  if (!result.ok) return changeFailed(ctx, result);
  json(ctx.response, 200, { ok: true, activityId: result.activityId, items: result.items, opened: result.opened, conflicts: result.conflicts });
}

// --- body validation ----------------------------------------------------------------------------------

function pick(body: Record<string, unknown>, keys: string[], what: string): Record<string, unknown> {
  const extra = Object.keys(body).filter(key => !keys.includes(key));
  if (extra.length) throw new HttpError(400, 'invalid', `Unknown ${what} field: ${extra[0].slice(0, 40)}`);
  return body;
}

function versionOf(body: Record<string, unknown>): number {
  const { version } = body;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new HttpError(400, 'invalid', 'version must be a whole number');
  return version;
}

function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new HttpError(400, 'invalid', `${what} is not a valid id`);
  return value;
}

/** Builds the core change for a verb. Never takes a `reason` or a `source` from a client. */
function coreChange(verb: CoreVerb, itemId: string, body: Record<string, unknown>): Change {
  if (verb === 'undo') {
    pick(body, ['activityId'], 'undo');
    return { kind: 'undo', activityId: idOf(body.activityId, 'activityId') };
  }
  const version = versionOf(body);
  switch (verb) {
    case 'assign':
      pick(body, ['version', 'ownerId'], 'assign');
      return { kind: 'assign', itemId, version, ownerId: idOf(body.ownerId, 'ownerId') };
    case 'open': {
      pick(body, ['version', 'candidateIds'], 'open');
      const ids = body.candidateIds;
      if (ids === undefined) return { kind: 'open', itemId, version };
      if (!Array.isArray(ids) || ids.length > 16) throw new HttpError(400, 'invalid', 'candidateIds must be a short list');
      return { kind: 'open', itemId, version, candidateIds: ids.map(id => idOf(id, 'candidateIds')) };
    }
    case 'handback': {
      pick(body, ['version', 'note'], 'handback');
      if (body.note !== undefined && typeof body.note !== 'string') throw new HttpError(400, 'invalid', 'note must be text');
      return { kind: 'handback', itemId, version, ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.slice(0, 500) } : {}) };
    }
    case 'cancel_occurrence': {
      pick(body, ['version', 'date'], 'cancel_occurrence');
      if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new HttpError(400, 'invalid', 'date must be YYYY-MM-DD');
      return { kind: 'cancel_occurrence', itemId, version, date: body.date };
    }
    default: {
      pick(body, ['version'], verb);
      const kind = verb === 'ack' ? 'confirm' : verb;
      return { kind, itemId, version } as Change;
    }
  }
}

function newItemFrom(ctx: Ctx, body: Record<string, unknown>): NewItem {
  pick(body, CREATE_KEYS, 'item');
  if (body.type !== 'event' && body.type !== 'task' && body.type !== 'preparation') throw new HttpError(400, 'invalid', 'type is event, task or preparation');
  const { type, ownerId, parentEventId, ...fields } = body;
  const item: NewItem = {
    ...(fields as Record<string, unknown>),
    title: fields.title as string,
    type,
    // The client never chooses the source: a person typing it in is "manual".
    source: { kind: 'manual', label: ctx.member.name }
  };
  if (parentEventId !== undefined) item.parentEventId = idOf(parentEventId, 'parentEventId');
  if (ownerId !== undefined) item.ownership = { state: 'assigned', ownerId: idOf(ownerId, 'ownerId'), confirmed: false };
  return item;
}

function editTarget(url: URL): { itemId?: string; parentId?: string } {
  const id = url.searchParams.get('id');
  const parent = url.searchParams.get('parent');
  return { ...(id ? { itemId: idOf(id, 'id') } : {}), ...(parent ? { parentId: idOf(parent, 'parent') } : {}) };
}

// --- live updates (SSE) -------------------------------------------------------------------------------

const frame = (message: StreamMessage) => `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;

/**
 * `GET /events`: one SSE stream for the signed-in member. The token travels in the header (the client
 * reads it with `fetch`, not `EventSource`). A comment line every 15 s keeps proxies from closing it;
 * it ends when the token expires, so a stale session cannot listen on. Anything missed while the client
 * was away is covered by `hello`, on which the client re-reads its screen.
 */
function openStream(ctx: Ctx): void {
  const { request, response, member, rt } = ctx;
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-store, no-transform');
  response.setHeader('x-accel-buffering', 'no');
  request.socket.setTimeout(0);
  request.socket.setNoDelay(true);
  response.flushHeaders();

  let timers: NodeJS.Timeout[] = [];
  let unsubscribe = () => {};
  const end = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    unsubscribe();
    if (!response.writableEnded) response.end();
  };
  const send = (message: StreamMessage) => {
    if (response.destroyed || response.writableEnded) throw new Error('stream closed');
    response.write(frame(message));
  };

  response.write('retry: 3000\n\n');
  unsubscribe = rt.hub.subscribe(member.id, send, end);
  send({ event: 'hello', data: { memberId: member.id, ...clockData(rt), ppma: ppmaStatusOf(rt) } });

  const beat = setInterval(() => {
    if (response.destroyed || response.writableEnded) return end();
    response.write(': ping\n\n');
  }, heartbeatMs);
  beat.unref();
  timers.push(beat);
  const expiry = setTimeout(end, Math.max(0, Math.min(ctx.sessionExpiresAt - Date.now(), 2 ** 31 - 1)));
  expiry.unref();
  timers.push(expiry);
  request.on('close', end);
  response.on('close', end);
}

const clockData = (rt: Runtime) => ({ now: new Date(rt.clock.now()).toISOString(), offsetMs: rt.clock.offsetMs(), timezone: rt.state.family.timezone });

/**
 * "Got it" and "Remind me later" on a reminder alert. Without `reminderId` it is the member's newest
 * active reminder for the item. (`ack` from the owner of an unconfirmed item is the item's own
 * confirmation instead; the route handles that, so the board shows it.)
 */
async function answerReminder(ctx: Ctx, itemId: string, response: ReminderResponse, body: Record<string, unknown>): Promise<void> {
  const { rt, member, response: res } = ctx;
  pick(body, ['version', 'reminderId'], response);
  const reminderId = body.reminderId === undefined ? activeReminderFor(rt.state, itemId, member.id)?.id : idOf(body.reminderId, 'reminderId');
  const reminder = reminderId ? rt.state.reminders.find(r => r.id === reminderId && r.itemId === itemId) : undefined;
  if (!reminder) return fail(res, 404, 'not_found', 'No such reminder');
  const result = respondToReminder(rt.state, reminder.id, member.id, response, rt.clock.now());
  if (!result.ok) return fail(res, result.status, result.code, result.message);
  rt.state = result.state;
  await rt.store.save(result.state);
  for (const closed of result.closed) rt.hub.publishClosed(closed.recipientIds, closed.reminderId);
  reportToPpma(rt, [reminderReport(rt.state, reminder.id, itemId, response, member.id)]);
  json(res, 200, {
    ok: true,
    reminderId: reminder.id,
    ...(result.reminder.snoozedUntil ? { snoozedUntil: result.reminder.snoozedUntil } : {}),
    items: itemsById(rt.state, member.id, [itemId]),
    opened: [],
    conflicts: []
  });
}

// --- chat ---------------------------------------------------------------------------------------------

/** Applies a preference request as the member, saves it and tells every open stream (T5.4). */
async function savePreference(ctx: Ctx, request: PreferenceRequest): Promise<PreferenceResult> {
  const { rt, member } = ctx;
  const result = applyPreferenceRequest(rt.state, request, member.id, rt.clock.now());
  if (result.ok && result.changed) {
    rt.state = result.state;
    await rt.store.save(result.state);
    rt.hub.broadcast({ event: 'preferences.changed', data: {} });
    const id = result.preference?.id ?? result.activity?.ref;
    if (id) reportToPpma(rt, [preferenceReport(rt.state, result.action, id, result.preference, member.id)]);
  }
  return result;
}

/** A conversation quiet for this long starts over. Real time: a demo clock jump does not end it. */
const CHAT_MEMORY_MS = 20 * 60 * 1000;

function recentChat(rt: Runtime, memberId: string): ChatLine[] {
  const entry = rt.chats?.get(memberId);
  if (!entry || Date.now() - entry.at > CHAT_MEMORY_MS) return [];
  return entry.lines;
}

function rememberChat(rt: Runtime, memberId: string, lines: ChatLine[]): void {
  rt.chats ??= new Map();
  const kept = [...recentChat(rt, memberId), ...lines.filter(l => l.text.trim())].slice(-INTENT_LIMITS.recentLines);
  rt.chats.set(memberId, { lines: kept, at: Date.now() });
}

/**
 * `POST /chat {text}`: one chat message. The model reads it against the member's own view and returns
 * one validated intent (intents.ts); `planChat` decides what that does under the family's autonomy;
 * a write goes through the core like a tap on the board, with Undo. The answer is a turn (text and a
 * card), the same shape as a screen. A model failure is a card with an error, never a guess.
 */
async function chatHandler(ctx: Ctx): Promise<void> {
  const body = pick(await readBody(ctx.request, MAX_CHAT_BODY), ['text', 'image'], 'chat');
  const image = body.image;
  if (image !== undefined && (typeof image !== 'string' || !isImageDataUrl(image))) throw new HttpError(400, 'invalid', 'image must be a PNG, JPEG, WebP or GIF data URL under 6 MB');
  if (image === undefined && (typeof body.text !== 'string' || !body.text.trim())) throw new HttpError(400, 'invalid', 'text must be a message');
  if (body.text !== undefined && typeof body.text !== 'string') throw new HttpError(400, 'invalid', 'text must be a message');
  if (typeof body.text === 'string' && body.text.length > INTENT_LIMITS.message) throw new HttpError(400, 'invalid', `text is longer than ${INTENT_LIMITS.message} characters`);
  if (typeof image === 'string') return screenshotHandler(ctx, image, typeof body.text === 'string' ? body.text.trim() : '');
  const text = (body.text as string).trim();
  const { rt, member, lang } = ctx;
  const llm = llmStatus(llmConfigFromEnv());
  const before = viewFor(rt.state, member.id);
  if (!before) return fail(ctx.response, 404, 'not_found', 'No such member');

  const started = Date.now();
  const result = await runIntent(llmOf(rt), { view: before, now: rt.clock.now(), lang, text, recent: recentChat(rt, member.id) });
  const answer = async (outcome: ChatOutcome, extra: Record<string, unknown> = {}) => {
    // The state may have changed while the model was thinking: the card is built from the latest view.
    const view = viewFor(rt.state, member.id) ?? before;
    const now = new Date(rt.clock.now()).toISOString();
    const turn = chatTurn({ lang, now, view, llm, turnId: randomBytes(6).toString('hex'), outcome, reminders: pendingRemindersFor(rt.state, member.id, rt.clock.now()), situations: situationsView(rt.state, member.id, rt.clock.now()) });
    rememberChat(rt, member.id, [{ from: 'member', text }, { from: 'homemind', text: turn.message }]);
    json(ctx.response, 200, { ...turn, ok: outcome.kind !== 'failed', outcome: outcome.kind, llm, ms: Date.now() - started, ...extra });
  };
  if (!result.ok) {
    return answer({ kind: 'failed', reason: result.code === 'not_configured' ? 'not_configured' : 'model', code: result.code, message: result.message });
  }

  const view = viewFor(rt.state, member.id);
  if (!view) return fail(ctx.response, 404, 'not_found', 'No such member');
  const plan = planChat(view, result.value);
  const intent = result.value.intent;
  switch (plan.kind) {
    case 'answer':
      return answer({ kind: 'answer', answer: plan.answer, itemIds: plan.itemIds }, { intent });
    case 'why':
      // A stored Why from PPMA carries its decision id: PPMA's own explanation comes from the cache (never waited for).
      return answer({ kind: 'why', explanation: plan.explanation, ...(plan.explanation.why?.source === 'ppma' && plan.explanation.why.decisionId && rt.ppma ? { ppma: rt.ppma.explanation(plan.explanation.why.decisionId) } : {}) }, { intent });
    case 'suggest':
      return answer({ kind: 'suggest', intent: plan.intent, itemId: plan.itemId, verb: plan.verb, ...(plan.memberId ? { memberId: plan.memberId } : {}), reason: plan.reason }, { intent });
    case 'later':
      return answer({ kind: 'later', intent: plan.intent }, { intent, task: plan.task });
    case 'blocked':
      return answer({ kind: 'blocked', title: plan.title, blocked: plan.blocked }, { intent });
    case 'held':
      return answer({ kind: 'held', intent: plan.intent, itemId: plan.itemId, reason: plan.reason }, { intent });
    case 'preference': {
      if (!plan.save) return answer({ kind: 'preference-suggest', input: plan.input, reason: plan.reason ?? 'level1' }, { intent });
      const saved = await savePreference(ctx, { op: 'save', input: plan.input });
      if (!saved.ok) return answer({ kind: 'failed', reason: 'change', code: saved.code, message: saved.message }, { intent, status: saved.status });
      const action = saved.changed ? (saved.action === 'added' ? 'added' : 'corrected') : 'unchanged';
      return answer(
        { kind: 'preference', action, preference: saved.preference as NonNullable<typeof saved.preference>, ...(saved.activity ? { activityId: saved.activity.id } : {}) },
        { intent, preferenceId: saved.preference?.id, ...(saved.activity ? { activityId: saved.activity.id } : {}) }
      );
    }
    case 'missing':
      return answer({ kind: 'missing' }, { intent });
    case 'situation': {
      // T8.1: someone is sick. Fixed rules decide what falls through and who could stay home (situations.ts).
      const started = startSituation(rt.state, member.id, { kind: 'sick', memberId: plan.memberId, date: plan.date, summary: plan.summary }, {
        now: rt.clock.now(),
        clock: rt.clock,
        adapters: adaptersOf(rt),
        mayWrite: chatMayWrite(rt.state.family)
      });
      if (!started.ok) return answer({ kind: 'failed', reason: 'change', code: started.code, message: started.message }, { intent, status: started.status });
      if (started.created) {
        await commit(rt, started.state, started.events, member.id);
        rt.hub.broadcast({ event: 'actions.changed', data: {} });
      }
      const undoable = started.created && started.activityId && rt.state.activity.some(a => a.id === started.activityId && a.undo && !a.undone);
      return answer(
        { kind: 'situation', situationId: started.situation.id, created: started.created, ...(undoable ? { activityId: started.activityId } : {}) },
        { intent, situationId: started.situation.id }
      );
    }
    case 'write': {
      const isEvent = plan.change.kind === 'create' && plan.change.item.type === 'event';
      const applied = await applyAndCommit(ctx, plan.change, ids => (isEvent ? ids[0] : undefined));
      if (!applied.ok && applied.code === 'blocked_by_preference' && plan.change.kind === 'create') {
        return answer({ kind: 'blocked', title: plan.change.item.title, blocked: applied.blocked }, { intent });
      }
      if (!applied.ok) return answer({ kind: 'failed', reason: 'change', code: applied.code, message: applied.message }, { intent, status: applied.status });
      const itemId = 'itemId' in plan.change ? plan.change.itemId : applied.changedIds[0];
      // A split: the other parts are shown too. A removal: the preparations that went with the event.
      const alsoIds = plan.change.kind === 'split' || plan.change.kind === 'cancel' ? applied.changedIds.filter(id => id !== itemId) : [];
      // Undo, as on the board: the member made this change, so they may undo it.
      const undoable = rt.state.activity.some(a => a.id === applied.activityId && a.undo && !a.undone);
      return answer(
        { kind: 'written', intent: plan.intent, itemId, ...(alsoIds.length ? { alsoIds } : {}), proposed: plan.proposed, ...(undoable ? { activityId: applied.activityId } : {}), opened: applied.opened, conflicts: applied.conflicts.length },
        { intent, activityId: applied.activityId, items: applied.items }
      );
    }
  }
}

/**
 * `POST /chat {image, text?}` (T5.3): a screenshot. The model extracts events, preparations and requests
 * (validated, intents.ts), and `applyExtraction` puts them on the board as **proposed** items, all in
 * one commit. Nothing is final until someone taps Approve. A model failure changes nothing.
 * Any text with it is read as part of the source (data, like the image).
 */
async function screenshotHandler(ctx: Ctx, image: string, text: string): Promise<void> {
  const { rt, member, lang } = ctx;
  const llm = llmStatus(llmConfigFromEnv());
  if (!viewFor(rt.state, member.id)) return fail(ctx.response, 404, 'not_found', 'No such member');
  const started = Date.now();
  const result = await runExtraction(llmOf(rt), { now: rt.clock.now(), timezone: rt.state.family.timezone, imageDataUrl: image, ...(text ? { text } : {}) });
  const answer = (outcome: ChatOutcome, extra: Record<string, unknown> = {}) => {
    const view = viewFor(rt.state, member.id);
    if (!view) return fail(ctx.response, 404, 'not_found', 'No such member');
    const now = new Date(rt.clock.now()).toISOString();
    const turn = chatTurn({ lang, now, view, llm, turnId: randomBytes(6).toString('hex'), outcome, reminders: pendingRemindersFor(rt.state, member.id, rt.clock.now()), situations: situationsView(rt.state, member.id, rt.clock.now()) });
    json(ctx.response, 200, { ...turn, ok: outcome.kind !== 'failed', outcome: outcome.kind, intent: 'extract', llm, ms: Date.now() - started, ...extra });
  };
  if (!result.ok) {
    return answer({ kind: 'failed', reason: result.code === 'not_configured' ? 'not_configured' : 'image', code: result.code, message: result.message });
  }
  // Applied to the state as it is now (the model took a few seconds), and committed in one step.
  const applied = applyExtraction(rt.state, result.value, member.id, rt.clock, { source: { kind: 'screenshot', label: member.name } });
  if (!applied.ok) return answer({ kind: 'failed', reason: 'change', code: applied.code, message: applied.message }, { status: applied.status });
  if (applied.created.length) await commit(rt, applied.state, applied.events, member.id);
  const signUp = result.value.signUp;
  return answer(
    {
      kind: 'extracted',
      created: applied.created,
      skipped: applied.skipped,
      dropped: result.value.dropped,
      ...(signUp ? { signUp: { topic: signUp.topic, ...(signUp.deadline ? { deadline: signUp.deadline } : {}), taken: signUp.taken } } : {})
    },
    { items: itemsById(rt.state, member.id, applied.created.map(c => c.itemId)) }
  );
}

/** `POST /rules {action: 'group-claims', groupId, enabled?, auto?}` (T7.4): parents only. */
async function groupPolicyHandler(ctx: Ctx, body: Record<string, unknown>): Promise<void> {
  const parsed = parseGroupPolicyBody(body);
  if (!parsed.ok) throw new HttpError(400, 'invalid', parsed.message);
  const { rt, member } = ctx;
  const result = applyGroupPolicy(rt.state, parsed.value, member.id, rt.clock.now());
  if (!result.ok) return fail(ctx.response, result.status, result.code, result.message);
  if (result.changed) {
    await commitCards(rt, result.state);
    // The group area's autonomy level is a family setting too.
    rt.hub.broadcast({ event: 'settings.changed', data: {} });
    rt.hub.broadcast({ event: 'services.changed', data: {} });
  }
  // A sign-up posted before the claims were turned on is looked at now.
  const claims = result.policy.enabled ? await runGroupClaims(rt) : [];
  json(ctx.response, 200, { ok: true, changed: result.changed, policy: result.policy, claims: claims.map(claimSummary), ...(result.activityId ? { activityId: result.activityId } : {}) });
}

// --- handlers -----------------------------------------------------------------------------------------

const MEMBER_VIEW = (m: Member) => ({ id: m.id, name: m.name, nameZh: m.nameZh, role: m.role, hasAccount: m.hasAccount, lang: m.lang });

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    auth: false,
    handler: ({ response, rt }) =>
      json(response, 200, {
        enabled: true,
        ready: secret() !== null,
        llm: llmStatus(llmConfigFromEnv()),
        // `off` (no PPMA_URL), `connecting`, `ok` or `offline`; the queue keeps what PPMA has not taken yet.
        ppma: ppmaStatusOf(rt),
        ...(rt.ppma ? { ppmaQueued: rt.ppma.info().queued } : {}),
        demo: demo()
      })
  },
  {
    method: 'GET',
    pattern: /^\/members$/,
    auth: false,
    handler: ({ response, rt }) => json(response, 200, { family: { id: rt.state.family.id, name: rt.state.family.name, nameZh: rt.state.family.nameZh }, members: rt.state.family.members.map(MEMBER_VIEW) })
  },
  {
    method: 'POST',
    pattern: /^\/session$/,
    auth: false,
    handler: async ctx => {
      const body = pick(await readBody(ctx.request), ['memberId'], 'session');
      const memberId = idOf(body.memberId, 'memberId');
      const member = ctx.rt.state.family.members.find(m => m.id === memberId);
      if (!member || !member.hasAccount) return fail(ctx.response, 404, 'not_found', 'No such member');
      json(ctx.response, 200, {
        token: signSession(member.id, secret() as string),
        member: MEMBER_VIEW(member),
        // Not authentication: anyone who can reach the bridge can pick anyone. Said on screen too.
        demoSignIn: true
      });
    }
  },
  {
    method: 'GET',
    pattern: /^\/screen\/([a-z-]{1,20})$/,
    auth: true,
    handler: ctx => {
      const name = ctx.params[0] as Screen;
      if (!SCREENS.includes(name)) return fail(ctx.response, 404, 'not_found', 'No such screen');
      const view = viewFor(ctx.rt.state, ctx.member.id);
      if (!view) return fail(ctx.response, 404, 'not_found', 'No such member');
      const query = (ctx.url.searchParams.get('q') ?? '').slice(0, 100);
      const now = new Date(ctx.rt.clock.now()).toISOString();
      const results = name === 'search' ? searchItems(ctx.rt.state, ctx.member.id, query) : undefined;
      // Add and edit: `?id=` opens an item, `?parent=` adds a preparation under an event. A bad id is a 400.
      const edit = name === 'edit' || name === 'item' ? editTarget(ctx.url) : undefined;
      // The item screen lists the preferences that apply to that item, from the member's own view.
      const shown = name === 'item' && edit?.itemId ? view.items.find(i => i.id === edit.itemId) : undefined;
      const itemPreferences = shown ? preferencesForItem(view, shown) : [];
      // PPMA's explanation of an item it suggested: from the cache, never waited for (it is read in the background).
      const shownWhy = shown ? view.whys.find(w => w.source === 'ppma' && w.decisionId && w.basis.some(b => b.ref === shown.id)) : undefined;
      const itemPpma = shownWhy?.decisionId ? ctx.rt.ppma?.explanation(shownWhy.decisionId) : undefined;
      // "What we know": PPMA's memory from the cache. Asking starts a background read; `memory.changed` brings the answer.
      let ppmaMemory;
      if (name === 'memory' && ctx.rt.ppma) {
        ctx.rt.ppma.refreshMemory();
        ppmaMemory = ctx.rt.ppma.memory();
      }
      const isParent = ctx.member.role === 'parent';
      // A view carries no Undo patches, so the server says which changes this member may undo.
      // T7.5: a source change is undone from its own card, never item by item.
      const undoable = ctx.rt.state.activity.filter(a => a.undo && !a.undone && a.kind !== 'source' && (isParent || a.actor === ctx.member.id)).map(a => a.id);
      // A parent's confirmation tokens for pending action cards (T7.1): each binds that card, its payload and this parent.
      // T7.3: they also go behind each card's own Confirm button, so a tap sends the token for exactly that card.
      const confirmations = confirmationsFor(ctx.rt, ctx.member);
      const turn = screenTurn(name, {
        lang: ctx.lang,
        now,
        view,
        query: name === 'search' ? query : undefined,
        results,
        undoable,
        ppma: ppmaForScreens(ctx.rt),
        llm: llmStatus(llmConfigFromEnv()),
        reminders: pendingRemindersFor(ctx.rt.state, ctx.member.id, ctx.rt.clock.now()),
        ...(edit ? { edit } : {}),
        ...(name === 'item' && itemPreferences.length ? { itemPreferences } : {}),
        ...(itemPpma ? { itemPpma } : {}),
        ...(ppmaMemory ? { ppmaMemory } : {}),
        // The simulated services (T7.2); the inbox is this member's own mailbox only.
        ...(name === 'services' ? { services: servicesViewFor(ctx.rt.state, ctx.member.id, ctx.rt.clock.now()), demo: demo() } : {}),
        // T8.2: My day lists the group messages that wait for tonight's summary (parents), so it needs the group too.
        ...(name === 'my-day' && isParent && (ctx.rt.state.messageJudgments ?? []).some(j => j.tier === 'summary' && !j.deliveredIn) ? { services: servicesViewFor(ctx.rt.state, ctx.member.id, ctx.rt.clock.now()) } : {}),
        // T7.4: the group's claim setting and what Homemind signed up for (family-wide).
        ...(name === 'services' || name === 'my-day' ? { groups: groupsView(ctx.rt.state), sourceChanges: sourceChangesView(ctx.rt.state, ctx.member.id, ctx.rt.clock.now()) } : {}),
        // T8.1: "Noa is sick" and what Homemind suggested for that day, limited to what this member can see.
        ...(name === 'my-day' ? { situations: situationsView(ctx.rt.state, ctx.member.id, ctx.rt.clock.now()) } : {}),
        ...(name === 'rules' ? { demo: demo() } : {}),
        // T8.2: the memory screen's correction form for one saved preference (`?id=`, checked like any id).
        ...(name === 'memory' && ctx.url.searchParams.get('id') ? { correctPreferenceId: idOf(ctx.url.searchParams.get('id') as string, 'id') } : {}),
        // T8.2: the evening summary or the week ahead (`?period=week`), from this member's view only.
        ...(name === 'summary' ? { summary: summaryFor(ctx.rt.state, ctx.member.id, ctx.url.searchParams.get('period') === 'week' ? 'weekly' : 'daily', ctx.rt.clock.now()) ?? undefined } : {}),
        // T8.2: how soon each group message is shown, and why (the group is the parents': parents only).
        ...((name === 'services' || name === 'my-day') && isParent ? { judgments: ctx.rt.state.messageJudgments ?? [] } : {}),
        confirmations
      });
      // The surface is what screens render. `view` stays for the client's forms (ids, versions).
      json(ctx.response, 200, {
        ...turn,
        screen: name,
        lang: ctx.lang,
        now,
        view,
        ppma: ppmaStatusOf(ctx.rt),
        ...(results ? { query, results } : {}),
        ...(Object.keys(confirmations).length ? { confirmations } : {})
      });
    }
  },
  { method: 'GET', pattern: /^\/events$/, auth: true, handler: openStream },
  {
    method: 'POST',
    pattern: /^\/items$/,
    auth: true,
    handler: async ctx => {
      const item = newItemFrom(ctx, await readBody(ctx.request));
      await runChange(ctx, { kind: 'create', item }, ids => (item.type === 'event' ? ids[0] : undefined));
    }
  },
  {
    method: 'PATCH',
    pattern: /^\/items\/([a-z0-9][a-z0-9_-]{0,63})$/,
    auth: true,
    handler: async ctx => {
      const body = pick(await readBody(ctx.request), ['version', 'patch'], 'edit');
      const version = versionOf(body);
      if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw new HttpError(400, 'invalid', 'patch must be an object');
      const patch = pick(body.patch as Record<string, unknown>, PATCH_KEYS, 'patch') as ItemPatch;
      const itemId = ctx.params[0];
      await runChange(ctx, { kind: 'edit', itemId, version, patch }, () => itemId);
    }
  },
  {
    method: 'POST',
    pattern: /^\/items\/([a-z0-9][a-z0-9_-]{0,63})\/([a-z_]{1,20})$/,
    auth: true,
    handler: async ctx => {
      const [itemId, verb] = ctx.params;
      if (verb !== 'snooze' && !(CORE_VERBS as readonly string[]).includes(verb)) return fail(ctx.response, 404, 'not_found', 'Not found');
      const body = await readBody(ctx.request);
      if (verb === 'snooze') return answerReminder(ctx, itemId, 'snooze', body);
      if (verb === 'ack' && body.reminderId !== undefined) {
        // From a reminder alert: the owner who has not confirmed yet confirms the item; anyone else it reached says "Got it".
        const own = ctx.rt.state.items.find(i => i.id === itemId)?.ownership;
        const confirms = own?.state === 'assigned' && own.ownerId === ctx.member.id && !own.confirmed;
        if (!confirms) return answerReminder(ctx, itemId, 'ack', body);
        delete body.reminderId;
      }
      const change = coreChange(verb as CoreVerb, itemId, body);
      if (change.kind === 'undo') {
        // The id in the path must be an item that activity touched, so one URL can't undo another item's change.
        const activity = ctx.rt.state.activity.find(a => a.id === change.activityId);
        if (!activity?.undo?.items.some(entry => entry.itemId === itemId)) return fail(ctx.response, 404, 'not_found', 'Nothing to undo');
      }
      await runChange(ctx, change);
    }
  },
  {
    method: 'GET',
    pattern: /^\/why\/([a-z0-9][a-z0-9_-]{0,63})$/,
    auth: true,
    handler: ctx => {
      // From the member's own view, so a "Why?" about a Parents-only item is a plain 404 for a teen.
      const why = viewFor(ctx.rt.state, ctx.member.id)?.whys.find(w => w.id === ctx.params[0]);
      if (!why) return fail(ctx.response, 404, 'not_found', 'No such explanation');
      // A PPMA decision's own explanation comes from the cache; the first ask starts the read and answers `loading`.
      const ppma = why.source === 'ppma' && why.decisionId ? ctx.rt.ppma?.explanation(why.decisionId) : undefined;
      json(ctx.response, 200, { why, ...(ppma ? { ppma } : {}) });
    }
  },
  {
    method: 'POST',
    pattern: /^\/memory\/correct$/,
    auth: true,
    // "That's wrong" / "Forget" on one thing PPMA remembers. Parents only. Queued like every report: PPMA being down never blocks it.
    handler: async ctx => {
      const body = pick(await readBody(ctx.request), ['statementId', 'action'], 'correction');
      if (!isStatementId(body.statementId)) throw new HttpError(400, 'invalid', 'statementId must be an id PPMA gave');
      if (body.action !== 'wrong' && body.action !== 'forget') throw new HttpError(400, 'invalid', 'action is wrong or forget');
      if (ctx.member.role !== 'parent') return fail(ctx.response, 403, 'forbidden', 'only a parent can correct what PPMA remembers');
      if (!ctx.rt.ppma) return fail(ctx.response, 409, 'ppma_off', 'PPMA is not connected');
      // Only a statement PPMA itself showed us, and one it says can be changed: never an id made up by a client.
      const statement = ctx.rt.ppma.memory().statements.find(s => s.id === body.statementId);
      if (!statement || !statement.editable) return fail(ctx.response, 404, 'not_found', 'No such editable statement');
      if (statement.correcting) return fail(ctx.response, 409, 'conflict', 'A correction for this is already on its way');
      const id = ctx.rt.ppma.correct({ statementId: statement.id, action: body.action, text: statement.text });
      if (!id) return fail(ctx.response, 409, 'ppma_off', 'PPMA is not connected');
      json(ctx.response, 200, { ok: true, queued: true, correctionId: id, ppma: ppmaStatusOf(ctx.rt) });
    }
  },
  { method: 'POST', pattern: /^\/chat$/, auth: true, handler: chatHandler },
  { method: 'POST', pattern: /^\/actions\/([a-z0-9][a-z0-9_-]{0,63})\/confirm$/, auth: true, handler: confirmAction },
  { method: 'POST', pattern: /^\/actions\/([a-z0-9][a-z0-9_-]{0,63})\/cancel$/, auth: true, handler: cancelAction },
  {
    method: 'POST',
    pattern: /^\/preferences$/,
    auth: true,
    // Save (new, or a correction by `id`), remove, or undo one change. Hard ones: parents only to change.
    handler: async ctx => {
      const parsed = parsePreferenceBody(await readBody(ctx.request), ctx.rt.state.family.members);
      if (!parsed.ok) throw new HttpError(400, 'invalid', parsed.message);
      const result = await savePreference(ctx, parsed.value);
      if (!result.ok) return fail(ctx.response, result.status, result.code, result.message);
      json(ctx.response, 200, { ok: true, action: result.action, changed: result.changed, preference: result.preference, ...(result.activity ? { activityId: result.activity.id } : {}) });
    }
  },
  {
    method: 'POST',
    pattern: /^\/rules$/,
    auth: true,
    // Create a weekly pizza rule, or turn one on or off. Every rule here spends money, so parents only.
    handler: async ctx => {
      const body = await readBody(ctx.request);
      if (body.action === 'group-claims') return groupPolicyHandler(ctx, body);
      const parsed = parseRuleBody(body);
      if (!parsed.ok) throw new HttpError(400, 'invalid', parsed.message);
      const { rt, member } = ctx;
      const result = applyRuleRequest(rt.state, parsed.value, member.id, rt.clock.now());
      if (!result.ok) return fail(ctx.response, result.status, result.code, result.message);
      if (result.changed) {
        await commitCards(rt, result.state);
        // A rule just turned on may be inside its lead time already.
        await applyRules(rt);
      }
      json(ctx.response, 200, { ok: true, changed: result.changed, rule: result.rule, ...(result.activityId ? { activityId: result.activityId } : {}) });
    }
  },
  {
    method: 'POST',
    pattern: /^\/group-claims\/([a-z0-9][a-z0-9_-]{0,63})\/change$/,
    auth: true,
    // T7.4: "Change" on a claim: a correction is posted in the simulated group (at level 4 at once, else after a tap).
    handler: async ctx => {
      const body = pick(await readBody(ctx.request), ['option'], 'change');
      const option = idOf(body.option, 'option');
      const { rt } = ctx;
      const result = requestGroupChange(rt.state, ctx.params[0], option, ctx.member.id, rt.clock.now(), adaptersOf(rt));
      if (!result.ok) return fail(ctx.response, result.status, result.code, result.message);
      await commitCards(rt, result.state);
      rt.hub.broadcast({ event: 'services.changed', data: {} });
      await autoRunGroupCard(rt, result.card.id);
      const claim = (rt.state.groupClaims ?? []).find(c => c.id === result.claim.id) ?? result.claim;
      const card = rt.state.actionCards.find(c => c.id === result.card.id) ?? result.card;
      json(ctx.response, 200, { ok: true, claim: claimSummary(claim), card: { id: card.id, status: card.status }, posted: card.status === 'executed' });
    }
  },
  {
    method: 'POST',
    pattern: /^\/inbox\/([a-z0-9][a-z0-9_-]{0,63})\/add$/,
    auth: true,
    // T8.3: a sample email from an approved sender becomes a proposal, visible only to the mailbox owners until approved.
    handler: async ctx => {
      pick(await readBody(ctx.request), [], 'inbox');
      const { rt, member } = ctx;
      const plan = planMailItem(rt.state, member.id, ctx.params[0], rt.clock.now());
      if (!plan.ok) return fail(ctx.response, plan.status, plan.code, plan.message);
      if (plan.duplicate) return json(ctx.response, 200, { ok: true, duplicate: true, items: itemsById(rt.state, member.id, [plan.item.id]) });
      const applied = await applyAndCommit(ctx, plan.change);
      if (!applied.ok) return changeFailed(ctx, applied);
      rt.hub.broadcast({ event: 'services.changed', data: {} });
      json(ctx.response, 200, { ok: true, duplicate: false, activityId: applied.activityId, items: applied.items });
    }
  },
  {
    method: 'POST',
    pattern: /^\/source-changes\/([a-z0-9][a-z0-9_-]{0,63})\/(apply|keep|discard|undo)$/,
    auth: true,
    // T7.5: a parent's decision about a message that changed after the family acted on it, or its Undo.
    handler: async ctx => {
      pick(await readBody(ctx.request), [], 'source-change');
      const { rt, member } = ctx;
      const [changeId, verb] = ctx.params;
      const now = rt.clock.now();
      if (verb === 'undo') {
        const undone = undoSourceChange(rt.state, changeId, member.id, now, rt.clock);
        if (!undone.ok) return fail(ctx.response, undone.status, undone.code, undone.message);
        await commit(rt, undone.state, undone.events, member.id);
        rt.hub.broadcast({ event: 'actions.changed', data: {} });
        rt.hub.broadcast({ event: 'services.changed', data: {} });
        return json(ctx.response, 200, { ok: true, change: { id: undone.change.id, status: undone.change.status } });
      }
      const result = resolveSourceChange(rt.state, changeId, verb as 'apply' | 'keep' | 'discard', member.id, now, rt.clock, adaptersOf(rt));
      if (!result.ok) return fail(ctx.response, result.status, result.code, result.message);
      await commit(rt, result.state, result.events, member.id);
      rt.hub.broadcast({ event: 'actions.changed', data: {} });
      rt.hub.broadcast({ event: 'services.changed', data: {} });
      // A correction in the simulated group goes through the guard like any card (at level 4 at once).
      if (result.correctionCardId) await autoRunGroupCard(rt, result.correctionCardId);
      if (result.reread) await rereadSignUps(rt, [result.reread]);
      const card = result.correctionCardId ? rt.state.actionCards.find(c => c.id === result.correctionCardId) : undefined;
      json(ctx.response, 200, {
        ok: true,
        change: { id: result.change.id, status: result.change.status },
        ...(result.activityId ? { activityId: result.activityId } : {}),
        ...(card ? { correction: { id: card.id, status: card.status, posted: card.status === 'executed' } } : {})
      });
    }
  },
  {
    method: 'POST',
    pattern: /^\/situations\/([a-z0-9][a-z0-9_-]{0,63})\/(apply|dismiss|undo)$/,
    auth: true,
    // T8.1: Apply / Not now on a suggestion made because someone is sick, or its Undo. Anyone with an account
    // may decide, as for any family item; the core refuses an item the member can't see (404).
    handler: async ctx => {
      const body = pick(await readBody(ctx.request), ['proposalId'], 'situation');
      const { rt, member } = ctx;
      const [situationId, verb] = ctx.params;
      const proposalId = body.proposalId === 'all' && verb === 'apply' ? 'all' : idOf(body.proposalId, 'proposalId');
      const result =
        verb === 'apply'
          ? applySuggestions(rt.state, situationId, proposalId, member.id, rt.clock)
          : verb === 'dismiss'
            ? dismissSuggestion(rt.state, situationId, proposalId, member.id, rt.clock.now())
            : undoSuggestion(rt.state, situationId, proposalId, member.id, rt.clock);
      if (!result.ok) {
        const current = result.current ? redactItem(rt.state, member.id, result.current) : undefined;
        return fail(ctx.response, result.status, result.code, result.message, current ? { current } : {});
      }
      await commit(rt, result.state, result.events, member.id);
      rt.hub.broadcast({ event: 'actions.changed', data: {} });
      const changedIds = [...new Set(result.events.map(e => e.itemId))];
      json(ctx.response, 200, {
        ok: true,
        situation: { id: result.situation.id, proposals: result.situation.proposals.map(p => ({ id: p.id, status: p.status })) },
        applied: result.applied,
        failed: result.failed,
        ...(result.activityIds.length ? { activityId: result.activityIds[result.activityIds.length - 1], activityIds: result.activityIds } : {}),
        items: itemsById(rt.state, member.id, changedIds),
        opened: [],
        conflicts: []
      });
    }
  },
  {
    method: 'PUT',
    pattern: /^\/settings$/,
    auth: true,
    // Quiet hours are the member's own; autonomy, pause and the backup contact are the family's (parents only).
    handler: async ctx => {
      const parsed = parseSettingsPatch(await readBody(ctx.request));
      if (!parsed.ok) throw new HttpError(400, 'invalid', parsed.message);
      const { rt, member } = ctx;
      const result = applySettings(rt.state, parsed.patch, member.id, rt.clock.now());
      if (!result.ok) return fail(ctx.response, result.status, result.code, result.message);
      if (result.changed.length) {
        rt.state = result.state;
        await rt.store.save(result.state);
        rt.hub.broadcast({ event: 'settings.changed', data: {} });
        // A new backup contact or new quiet hours apply from this tick, not 5 seconds later.
        await tickNow(rt);
      }
      json(ctx.response, 200, { ok: true, changed: result.changed, ...(result.activity ? { activityId: result.activity.id } : {}) });
    }
  },
  {
    method: 'POST',
    pattern: /^\/demo\/clock$/,
    auth: true,
    demoOnly: true,
    // Jumps the demo clock forward and ticks at once, so whatever came due shows now.
    handler: async ctx => {
      const body = pick(await readBody(ctx.request), ['minutes'], 'clock');
      const minutes = body.minutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_JUMP_MINUTES) {
        throw new HttpError(400, 'invalid', `minutes must be a whole number from 1 to ${MAX_JUMP_MINUTES}`);
      }
      const { rt } = ctx;
      const offsetMs = rt.clock.advance(minutes * 60_000);
      rt.state = { ...rt.state, clockOffsetMs: offsetMs };
      rt.hub.broadcast({ event: 'clock', data: clockData(rt) });
      const ticked = await tickNow(rt);
      await rt.store.save(rt.state);
      json(ctx.response, 200, { ok: true, ...clockData(rt), delivered: ticked.deliveries.length });
    }
  },
  {
    method: 'POST',
    pattern: /^\/demo\/post-group-message$/,
    auth: true,
    demoOnly: true,
    // The next sample message arrives in the simulated kindergarten group. PPMA hears of it (queued, never awaited).
    handler: async ctx => {
      pick(await readBody(ctx.request), [], 'post-group-message');
      const { rt } = ctx;
      const posted = postNextGroupMessage(rt.state, rt.clock.now());
      if (!posted.ok) return fail(ctx.response, 409, posted.code, posted.message);
      rt.state = posted.state;
      await rt.store.save(posted.state);
      rt.hub.broadcast({ event: 'services.changed', data: {} });
      reportToPpma(rt, [groupMessageReport(posted.message, KINDERGARTEN_GROUP)]);
      // T7.4: a sign-up in a group whose claims are on is read, and claimed or stopped on, at once.
      const claims = await runGroupClaims(rt);
      // T8.2: how soon the family should see it, and why. A sign-up Homemind just claimed already sent its own notice.
      const handled = claims.some(c => c.messageId === posted.message.id && c.status === 'claimed');
      const judged = judgeMessage(rt.state, posted.message, KINDERGARTEN_GROUP.id, rt.clock.now(), handled);
      if (judged) await commit(rt, judged.state, [], undefined, judged.deliveries);
      json(ctx.response, 200, {
        ok: true,
        message: posted.message,
        remaining: posted.remaining,
        claims: claims.map(claimSummary),
        ...(judged ? { judgment: { tier: judged.judgment.tier, reason: judged.judgment.reason, ...(judged.judgment.summaryAt ? { summaryAt: judged.judgment.summaryAt } : {}) } } : {})
      });
    }
  },
  {
    method: 'POST',
    pattern: /^\/demo\/update-group-message$/,
    auth: true,
    demoOnly: true,
    // T7.5: the senders edit their messages (the party moves to Friday, apples are no longer needed).
    handler: async ctx => {
      pick(await readBody(ctx.request), [], 'update-group-message');
      const { rt } = ctx;
      const updated = updateGroupMessages(rt.state, rt.clock.now());
      if (!updated.ok) return fail(ctx.response, 409, updated.code, updated.message);
      rt.state = updated.state;
      await rt.store.save(updated.state);
      rt.hub.broadcast({ event: 'services.changed', data: {} });
      reportToPpma(rt, updated.messages.map(m => groupMessageReport(m, KINDERGARTEN_GROUP)));
      const changes = await runSourceChanges(rt);
      json(ctx.response, 200, { ok: true, messages: updated.messages.map(m => ({ id: m.id, version: m.version })), remaining: updated.remaining, changes });
    }
  },
  {
    method: 'POST',
    pattern: /^\/demo\/run-rule$/,
    auth: true,
    demoOnly: true,
    // T7.3: a rule looks at its next occurrence now, instead of waiting for its lead time. Parents only:
    // it prepares a card that spends money (the card still needs its own tap).
    handler: async ctx => {
      const body = pick(await readBody(ctx.request), ['ruleId'], 'run-rule');
      const ruleId = idOf(body.ruleId, 'ruleId');
      if (ctx.member.role !== 'parent') return fail(ctx.response, 403, 'forbidden', 'Only a parent can run a rule');
      const { rt } = ctx;
      const result = prepareRuleNow(rt.state, ruleId, rt.clock.now(), adaptersOf(rt));
      if (!result.ok) return fail(ctx.response, result.status, result.code, result.message);
      if (!result.existing) await commitCards(rt, result.state);
      json(ctx.response, 200, { ok: true, run: result.run, existing: result.existing });
    }
  },
  {
    method: 'POST',
    pattern: /^\/demo\/reset$/,
    auth: true,
    demoOnly: true,
    handler: async ctx => {
      await readBody(ctx.request);
      const state = await ctx.rt.store.reset();
      ctx.rt.state = state;
      ctx.rt.chats?.clear();
      ctx.rt.clock.setOffset(state.clockOffsetMs);
      ctx.rt.hub.broadcast({ event: 'demo.reset', data: {} });
      json(ctx.response, 200, { ok: true });
    }
  },
  {
    method: 'GET',
    pattern: /^\/debug\/state$/,
    auth: false,
    demoOnly: true,
    // The whole state, Parents-only items included. Demo machines only (HOMEMIND_DEMO=1).
    handler: ({ response, rt }) => json(response, 200, rt.state)
  }
];

// --- dispatcher ---------------------------------------------------------------------------------------

/**
 * Returns true when the request was handled (the response is finished), false when Homemind is off or
 * the path is not `/api/homemind/...`, so the caller treats it exactly as before.
 */
export async function handleHomemindRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (!enabled()) return false;
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/homemind/')) return false;
  try {
    await dispatch(request, response, url);
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.destroy();
    } else if (error instanceof HttpError) {
      fail(response, error.status, error.code, error.message);
    } else {
      console.error('[homemind] request failed:', error instanceof Error ? error.message : 'unknown error');
      fail(response, 500, 'server_error', 'Homemind could not complete the request');
    }
  }
  return true;
}

async function dispatch(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? 'GET';
  const path = url.pathname.slice('/api/homemind'.length);

  let params: string[] = [];
  const route = routes.find(candidate => {
    if (candidate.method !== method) return false;
    const match = candidate.pattern.exec(path);
    if (match) params = match.slice(1);
    return match !== null;
  });
  if (!route || (route.demoOnly && !demo())) return fail(response, 404, 'not_found', 'Not found');

  if (method !== 'GET' && !isSameOrigin(request)) return fail(response, 403, 'forbidden', 'Cross-origin bridge request rejected');
  const key = secret();
  if (!key && path !== '/health') return fail(response, 503, 'not_configured', 'HOMEMIND_SECRET is not set (16 characters or more)');

  const rt = await runtime();
  const base = { request, response, url, params, rt, lang: langOf(url) };
  if (!route.auth) {
    await route.handler({ ...base, member: undefined as unknown as Member, sessionExpiresAt: 0 });
    return;
  }
  const token = request.headers[SESSION_HEADER];
  const session = key ? readSession(typeof token === 'string' ? token : undefined, key, Date.now()) : null;
  const member = session ? rt.state.family.members.find(m => m.id === session.memberId && m.hasAccount) : undefined;
  if (!member || !session) return fail(response, 401, 'unauthorized', 'Sign in first');
  await route.handler({ ...base, member, sessionExpiresAt: session.exp });
}

export function homemindBridgePlugin(): Plugin {
  const attach = (server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((request, response, next) => {
      handleHomemindRequest(request, response).then(
        handled => {
          if (!handled) next();
        },
        () => {
          if (!response.headersSent) response.statusCode = 500;
          response.end();
        }
      );
    });
  };
  return {
    name: 'digitalmate-homemind-bridge',
    configureServer: attach,
    configurePreviewServer: attach
  };
}
