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
 * Routes whose task has not been built yet (live events, chat, actions, rules, ...) are whitelisted
 * and answer 501 `not_implemented`, so nothing pretends to work.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { findConflicts, conflictsVisibleTo, mayOpenOnItsOwn, proposeForConflicts } from './homemind/availability';
import type { Conflict } from './homemind/availability';
import { createDemoClock } from './homemind/clock';
import type { DemoClock } from './homemind/clock';
import { applyChange } from './homemind/core';
import type { CoreEvent } from './homemind/core';
import { createEventHub } from './homemind/events';
import type { EventHub } from './homemind/events';
import type { Change, ChangeError, ItemPatch, NewItem } from './homemind/core';
import { seedState } from './homemind/seed';
import { HomemindStore, dataFileFromEnv } from './homemind/store';
import type { LoadSource } from './homemind/store';
import { ID_PATTERN } from './homemind/types';
import type { HomemindState, Item, Lang, Member, StreamMessage } from './homemind/types';
import { redactItem, searchItems, viewFor } from './homemind/visibility';
import { isSameOrigin } from './orbit';
import { screenTurn } from '../src/lib/homemindSurfaces';

export const SESSION_HEADER = 'x-homemind-session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 16;
const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const CONFLICT_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

const SCREENS = ['my-day', 'family', 'calendar', 'search', 'rules', 'memory', 'activity', 'settings', 'edit', 'item'] as const;
type Screen = (typeof SCREENS)[number];

/** Verbs on `POST /items/:id/:verb` that map straight to a core change. `ack` is the core's `confirm`. */
const CORE_VERBS = ['assign', 'open', 'unassign', 'claim', 'ack', 'handback', 'done', 'cancel', 'cancel_occurrence', 'approve', 'dismiss', 'undo'] as const;
type CoreVerb = (typeof CORE_VERBS)[number];
/** Whitelisted, built by a later task. */
const LATER_VERBS = ['snooze'] as const;

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

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'The request body is too large');
    chunks.push(chunk as Buffer);
  }
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
      return { file, state, source, store, hub: createEventHub(), clock: createDemoClock(Date.now, state.clockOffsetMs) };
    });
    holders[HOLDER] = { file, ready };
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
  // Close the streams of the runtime being dropped, so none is left open on a state nobody updates.
  holder?.ready.then(rt => rt.hub.closeAll(), () => undefined);
}

let heartbeatMs = HEARTBEAT_MS;
/** For tests: how often an idle stream gets a comment line. */
export function setHomemindHeartbeatMs(ms: number | undefined): void {
  heartbeatMs = ms ?? HEARTBEAT_MS;
}

/** Saves, then tells the open streams. A change is visible to others only once it is the state. */
async function commit(rt: Runtime, state: HomemindState, events: readonly CoreEvent[] = []): Promise<void> {
  rt.state = state;
  await rt.store.save(state);
  rt.hub.publishChanges(state, events);
}

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

const notBuilt = (task: string): Handler => ({ response }) =>
  fail(response, 501, 'not_implemented', `This part of Homemind is not built yet (${task})`, { task });

function changeFailed(ctx: Ctx, error: ChangeError): void {
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
  await commit(rt, proposal.state, proposal.events);
  return { conflicts: [], opened: proposal.openedItemIds };
}

async function runChange(ctx: Ctx, change: Change, afterEventId?: (changedIds: string[]) => string | undefined): Promise<void> {
  const { rt, member, response } = ctx;
  const result = applyChange(rt.state, change, member.id, rt.clock);
  if (!result.ok) return changeFailed(ctx, result);
  await commit(rt, result.state, result.events);
  const changedIds = result.items.map(i => i.id);
  const eventId = afterEventId?.(changedIds);
  const availability = eventId ? await checkAvailability(ctx, eventId) : { conflicts: [], opened: [] };
  json(response, 200, {
    ok: true,
    activityId: result.activity.id,
    items: itemsById(rt.state, member.id, [...changedIds, ...availability.opened]),
    opened: availability.opened,
    conflicts: availability.conflicts
  });
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
  send({ event: 'hello', data: { memberId: member.id, now: new Date(rt.clock.now()).toISOString() } });

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

// --- handlers -----------------------------------------------------------------------------------------

const MEMBER_VIEW = (m: Member) => ({ id: m.id, name: m.name, nameZh: m.nameZh, role: m.role, hasAccount: m.hasAccount, lang: m.lang });

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    auth: false,
    handler: ({ response }) =>
      json(response, 200, {
        enabled: true,
        ready: secret() !== null,
        // The model and PPMA are built in later tasks; "off" says so plainly.
        llm: process.env.HOMEMIND_LLM === 'live' ? 'live' : 'fake',
        ppma: 'off',
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
      if (name === 'memory') return notBuilt('T6.2')(ctx);
      const view = viewFor(ctx.rt.state, ctx.member.id);
      if (!view) return fail(ctx.response, 404, 'not_found', 'No such member');
      const query = (ctx.url.searchParams.get('q') ?? '').slice(0, 100);
      const now = new Date(ctx.rt.clock.now()).toISOString();
      const results = name === 'search' ? searchItems(ctx.rt.state, ctx.member.id, query) : undefined;
      // Add and edit: `?id=` opens an item, `?parent=` adds a preparation under an event. A bad id is a 400.
      const edit = name === 'edit' || name === 'item' ? editTarget(ctx.url) : undefined;
      const isParent = ctx.member.role === 'parent';
      // A view carries no Undo patches, so the server says which changes this member may undo.
      const undoable = ctx.rt.state.activity.filter(a => a.undo && !a.undone && (isParent || a.actor === ctx.member.id)).map(a => a.id);
      const turn = screenTurn(name, {
        lang: ctx.lang,
        now,
        view,
        query: name === 'search' ? query : undefined,
        results,
        undoable,
        ppma: 'off',
        llm: process.env.HOMEMIND_LLM === 'live' ? 'live' : 'fake',
        ...(edit ? { edit } : {})
      });
      // The surface is what screens render. `view` stays for the client's forms (ids, versions).
      json(ctx.response, 200, { ...turn, screen: name, lang: ctx.lang, now, view, ...(results ? { query, results } : {}) });
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
      if ((LATER_VERBS as readonly string[]).includes(verb)) return notBuilt('T4.1')(ctx);
      if (!(CORE_VERBS as readonly string[]).includes(verb)) return fail(ctx.response, 404, 'not_found', 'Not found');
      const change = coreChange(verb as CoreVerb, itemId, await readBody(ctx.request));
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
      json(ctx.response, 200, { why });
    }
  },
  { method: 'POST', pattern: /^\/chat$/, auth: true, handler: notBuilt('T5.2') },
  { method: 'POST', pattern: /^\/actions\/([a-z0-9][a-z0-9_-]{0,63})\/(confirm|cancel)$/, auth: true, handler: notBuilt('T7.1') },
  { method: 'POST', pattern: /^\/preferences$/, auth: true, handler: notBuilt('T5.4') },
  { method: 'POST', pattern: /^\/rules$/, auth: true, handler: notBuilt('T7.3') },
  { method: 'PUT', pattern: /^\/settings$/, auth: true, handler: notBuilt('T4.2') },
  { method: 'POST', pattern: /^\/demo\/clock$/, auth: true, demoOnly: true, handler: notBuilt('T4.1') },
  { method: 'POST', pattern: /^\/demo\/post-group-message$/, auth: true, demoOnly: true, handler: notBuilt('T7.2') },
  {
    method: 'POST',
    pattern: /^\/demo\/reset$/,
    auth: true,
    demoOnly: true,
    handler: async ctx => {
      await readBody(ctx.request);
      const state = await ctx.rt.store.reset();
      ctx.rt.state = state;
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
