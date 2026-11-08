/**
 * Action cards and the guard in front of every action that leaves the family board (T7.1).
 *
 * An action is an order, a message to someone outside the family, a sign-up claim: anything an
 * adapter does in the world. A rule or a chat turn only **prepares** a card (`prepareCard`). Nothing
 * runs until `executeAction`, which refuses unless one of two things holds:
 *
 * - **A tap.** A parent tapped the button on that card, and the request carries a confirmation token
 *   that `issueConfirmation` made for that card, that parent and that exact payload (its hash). The
 *   token is signed, single use and short-lived. Approving a standing rule once is never enough: each
 *   card needs its own token.
 * - **Autonomy level 4,** only for a `simulated` adapter that allows it, while the family is not paused.
 *   A `real` adapter never runs without a tap, at any level.
 *
 * A card nobody taps expires visibly (`expireCards`, from the scheduler tick). Every outcome writes an
 * Activity entry. There is no Undo: what an adapter did outside cannot be taken back from here.
 *
 * Pure apart from hashing and the adapter call itself: no HTTP, no UI. The caller (the bridge) owns the
 * state; `executeAction` reads and writes it through a small `StateRef`, so a second tap that arrives
 * while an adapter runs sees the card as `executing` and is refused.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Activity, ActionCard, AutonomyLevel, Family, HomemindState } from './types';
import { ID_PATTERN } from './types';

// --- adapters -----------------------------------------------------------------------------------------

export type AdapterResult = { ok: true; result?: Record<string, unknown> } | { ok: false; error: string };

export interface ActionAdapter {
  id: string;
  /** `real` reaches the world. The demo has none; the guard is built and tested anyway. */
  mode: 'real' | 'simulated';
  /** The autonomy area it belongs to, for `Family.autonomy.byArea`. */
  area: string;
  /** Simulated adapters only: may run at autonomy level 4 without a tap. Ignored for a real adapter. */
  autoAllowed?: boolean;
  /** An error message when the payload is not one this adapter accepts, else null. */
  validate(payload: Record<string, unknown>): string | null;
  execute(payload: Record<string, unknown>, signal: AbortSignal): Promise<AdapterResult>;
}

export type AdapterRegistry = Readonly<Record<string, ActionAdapter>>;

const adapterOf = (adapters: AdapterRegistry, id: string): ActionAdapter | undefined =>
  Object.prototype.hasOwnProperty.call(adapters, id) ? adapters[id] : undefined;

// --- payload hash -------------------------------------------------------------------------------------

/** JSON with object keys sorted at every level, so the same payload always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('payload holds a value JSON cannot carry');
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** sha256 (hex) of the canonical JSON. */
export const payloadHash = (payload: Record<string, unknown>): string => createHash('sha256').update(canonicalJson(payload)).digest('hex');

// --- refusals -----------------------------------------------------------------------------------------

export type ActionErrorCode =
  | 'not_found'
  | 'no_adapter'
  | 'invalid_payload'
  | 'not_parent'
  | 'not_pending'
  | 'expired'
  | 'no_token'
  | 'bad_token'
  | 'wrong_card'
  | 'wrong_member'
  | 'token_expired'
  | 'token_used'
  | 'payload_changed'
  | 'auto_not_allowed';

export interface ActionError {
  ok: false;
  code: ActionErrorCode;
  message: string;
  /** For `auto_not_allowed`: which condition stopped it. */
  reason?: 'real_adapter' | 'not_allowed' | 'paused' | 'level';
}

const refuse = (code: ActionErrorCode, message: string, reason?: ActionError['reason']): ActionError => ({ ok: false, code, message, ...(reason ? { reason } : {}) });

// --- helpers ------------------------------------------------------------------------------------------

const MAX_TOKEN_LENGTH = 1024;
/** A token lives at most this long, and never past the card's own expiry. */
export const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
/** How long an adapter may take before it counts as failed. */
export const ADAPTER_TIMEOUT_MS = 10_000;
const MAX_CARDS = 200;
/** The actor of what Homemind does on its own (autonomy level 4, expiry). */
export const HOMEMIND_ACTOR = 'homemind';

/** The family's autonomy level for an area: the area's override, else the default. */
export function autonomyLevelFor(family: Family, area: string | undefined): AutonomyLevel {
  const byArea = family.autonomy.byArea;
  if (area && byArea && Object.prototype.hasOwnProperty.call(byArea, area)) return byArea[area];
  return family.autonomy.default;
}

const isParent = (state: HomemindState, memberId: string) =>
  state.family.members.some(m => m.id === memberId && m.role === 'parent' && m.hasAccount);

const isoAt = (ms: number) => new Date(ms).toISOString();

function newActivityId(state: HomemindState, now: number): string {
  const base = `act-${Math.max(0, Math.floor(now)).toString(36)}`;
  const taken = (id: string) => state.activity.some(a => a.id === id);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

type Outcome = 'executed' | 'failed' | 'cancelled' | 'expired';

function logOutcome(state: HomemindState, card: ActionCard, outcome: Outcome, actor: string, now: number): { state: HomemindState; activity: Activity } {
  const activity: Activity = {
    id: newActivityId(state, now),
    at: isoAt(now),
    actor,
    what: `Action ${card.id} (${card.adapter}, ${card.mode}) ${outcome}`,
    kind: 'action',
    ref: card.id,
    note: outcome,
    whyId: card.whyId
  };
  return { activity, state: { ...state, activity: [...state.activity, activity] } };
}

const replaceCard = (state: HomemindState, card: ActionCard): HomemindState => ({
  ...state,
  actionCards: state.actionCards.map(c => (c.id === card.id ? card : c))
});

// --- prepare ------------------------------------------------------------------------------------------

export interface CardInput {
  id: string;
  adapter: string;
  payload: Record<string, unknown>;
  expiresAt: string;
  whyId: string;
  title?: string;
  titleZh?: string;
  ruleId?: string;
}

export type PrepareResult = { ok: true; state: HomemindState; card: ActionCard } | ActionError;

/**
 * Adds a pending card. Its `mode` and `area` come from the adapter, and its hash from the payload, so
 * whoever prepares a card cannot label a real action as simulated. Nothing runs here.
 */
export function prepareCard(state: HomemindState, input: CardInput, adapters: AdapterRegistry, now: number): PrepareResult {
  if (!ID_PATTERN.test(input.id)) return refuse('invalid_payload', 'The card id is not a valid id');
  if (state.actionCards.some(c => c.id === input.id)) return refuse('invalid_payload', 'A card with this id already exists');
  if (state.actionCards.length >= MAX_CARDS) return refuse('invalid_payload', 'Too many action cards');
  const adapter = adapterOf(adapters, input.adapter);
  if (!adapter) return refuse('no_adapter', `No adapter ${input.adapter}`);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) return refuse('invalid_payload', 'The card must expire in the future');
  let hash: string;
  try {
    hash = payloadHash(input.payload);
  } catch {
    return refuse('invalid_payload', 'The payload must be plain JSON');
  }
  const invalid = adapter.validate(input.payload);
  if (invalid) return refuse('invalid_payload', invalid);
  const card: ActionCard = {
    id: input.id,
    adapter: adapter.id,
    mode: adapter.mode,
    area: adapter.area,
    payload: structuredClone(input.payload),
    payloadHash: hash,
    status: 'pending',
    expiresAt: isoAt(expires),
    whyId: input.whyId,
    createdAt: isoAt(now),
    ...(input.title ? { title: input.title } : {}),
    ...(input.titleZh ? { titleZh: input.titleZh } : {}),
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    usedTokenIds: []
  };
  return { ok: true, card, state: { ...state, actionCards: [...state.actionCards, card] } };
}

// --- confirmation tokens ------------------------------------------------------------------------------

interface TokenBody {
  /** Token id (single use). */
  t: string;
  /** Card id. */
  c: string;
  /** Payload hash the parent saw. */
  h: string;
  /** Parent member id. */
  m: string;
  exp: number;
}

const TOKEN_CONTEXT = 'homemind.action-confirm.v1.';
const signToken = (body: string, key: string | Buffer) => createHmac('sha256', key).update(TOKEN_CONTEXT + body).digest('base64url');

function readToken(token: string, key: string | Buffer): TokenBody | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(signToken(body, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TokenBody>;
    if (typeof value.t !== 'string' || typeof value.c !== 'string' || typeof value.h !== 'string' || typeof value.m !== 'string' || typeof value.exp !== 'number') return null;
    return value as TokenBody;
  } catch {
    return null;
  }
}

export interface TokenDeps {
  /** The server-side signing key. Never sent to a client. */
  key: string | Buffer;
  now: number;
  /** For tests. */
  random?: (bytes: number) => Buffer;
}

export type IssueResult = { ok: true; token: string; tokenId: string; expiresAt: string } | ActionError;

/**
 * A confirmation token for one parent and one pending card, as the card is now (its payload hash).
 * The bridge puts it behind that card's button for that parent only. It does not run anything.
 */
export function issueConfirmation(state: HomemindState, cardId: string, memberId: string, deps: TokenDeps, adapters: AdapterRegistry): IssueResult {
  const card = state.actionCards.find(c => c.id === cardId);
  if (!card) return refuse('not_found', 'No such action card');
  if (!adapterOf(adapters, card.adapter)) return refuse('no_adapter', `No adapter ${card.adapter}`);
  if (!isParent(state, memberId)) return refuse('not_parent', 'Only a parent can confirm an action');
  if (card.status !== 'pending') return refuse('not_pending', `This action is ${card.status}`);
  const cardExpires = Date.parse(card.expiresAt);
  if (!(cardExpires > deps.now)) return refuse('expired', 'This action has expired');
  const tokenId = (deps.random ?? randomBytes)(12).toString('base64url');
  const exp = Math.min(cardExpires, deps.now + CONFIRMATION_TTL_MS);
  const body = Buffer.from(JSON.stringify({ t: tokenId, c: card.id, h: card.payloadHash, m: memberId, exp } satisfies TokenBody)).toString('base64url');
  return { ok: true, token: `${body}.${signToken(body, deps.key)}`, tokenId, expiresAt: isoAt(exp) };
}

// --- authorize ----------------------------------------------------------------------------------------

/** A refusal when the card itself can't run now: not pending, or past its expiry. */
function cardState(card: ActionCard, now: number): ActionError | null {
  if (card.status !== 'pending') return refuse('not_pending', `This action is ${card.status}`);
  if (!(Date.parse(card.expiresAt) > now)) return refuse('expired', 'This action has expired');
  return null;
}

/** How an execution is allowed: a parent's tap with a token, or autonomy level 4 (simulated only). */
export type ExecuteAuth = { kind: 'tap'; memberId: string; token?: string } | { kind: 'auto' };

export type Authorized = { ok: true; card: ActionCard; adapter: ActionAdapter; tokenId?: string } | ActionError;

/**
 * Whether `auth` may execute the card now. Pure. Every refusal the task names is here: no token, a
 * token used before, an expired card or token, a payload changed since the token was made, a member
 * who is not a parent, and level 4 on a real adapter.
 */
export function authorize(state: HomemindState, cardId: string, auth: ExecuteAuth, adapters: AdapterRegistry, deps: { key: string | Buffer; now: number }): Authorized {
  const card = state.actionCards.find(c => c.id === cardId);
  if (!card) return refuse('not_found', 'No such action card');
  const adapter = adapterOf(adapters, card.adapter);
  if (!adapter) return refuse('no_adapter', `No adapter ${card.adapter}`);
  // The adapter decides what is real. A card that says "simulated" for a real adapter is treated as real.
  const real = adapter.mode === 'real' || card.mode === 'real';

  let tokenId: string | undefined;
  if (auth.kind === 'tap') {
    if (!isParent(state, auth.memberId)) return refuse('not_parent', 'Only a parent can confirm an action');
    if (!auth.token) return refuse('no_token', 'This action needs a confirmation from its card');
    const token = readToken(auth.token, deps.key);
    if (!token) return refuse('bad_token', 'The confirmation is not valid');
    if (token.c !== card.id) return refuse('wrong_card', 'The confirmation is for another action');
    if (token.m !== auth.memberId) return refuse('wrong_member', 'The confirmation was made for someone else');
    if ((card.usedTokenIds ?? []).includes(token.t)) return refuse('token_used', 'This confirmation was already used');
    const stale = cardState(card, deps.now);
    if (stale) return stale;
    if (token.exp <= deps.now) return refuse('token_expired', 'The confirmation has expired. Open the card again');
    if (token.h !== card.payloadHash) return refuse('payload_changed', 'This action changed after it was shown. Here is the latest');
    tokenId = token.t;
  } else {
    if (real) return refuse('auto_not_allowed', 'A real action always needs a parent to tap it', 'real_adapter');
    if (!adapter.autoAllowed) return refuse('auto_not_allowed', 'This action always needs a tap', 'not_allowed');
    if (state.family.paused) return refuse('auto_not_allowed', 'Automatic actions are paused', 'paused');
    if (autonomyLevelFor(state.family, card.area ?? adapter.area) < 4) return refuse('auto_not_allowed', 'The autonomy level does not allow this without a tap', 'level');
  }

  const stale = cardState(card, deps.now);
  if (stale) return stale;
  let hash: string;
  try {
    hash = payloadHash(card.payload);
  } catch {
    return refuse('payload_changed', 'The payload is no longer valid');
  }
  if (hash !== card.payloadHash) return refuse('payload_changed', 'This action changed after it was prepared');
  const invalid = adapter.validate(card.payload);
  if (invalid) return refuse('invalid_payload', invalid);
  return { ok: true, card, adapter, ...(tokenId ? { tokenId } : {}) };
}

// --- execute ------------------------------------------------------------------------------------------

/** The caller's state, read and replaced. `set` may persist; it is awaited. */
export interface StateRef {
  get(): HomemindState;
  set(state: HomemindState): void | Promise<void>;
}

export interface ExecuteDeps {
  adapters: AdapterRegistry;
  key: string | Buffer;
  now: () => number;
  timeoutMs?: number;
}

export type ExecuteResult =
  | { ok: true; card: ActionCard; activity: Activity }
  /** The guard passed and the adapter ran, but it failed (or timed out). The card is `failed`. */
  | { ok: false; code: 'action_failed'; message: string; card: ActionCard; activity: Activity }
  | (ActionError & { card?: ActionCard });

/**
 * Runs the card's adapter if `authorize` allows it. The token is spent and the card set to
 * `executing` **before** the adapter is called, so a second tap is refused while it runs. A pending card
 * found past its expiry is marked `expired` on the way out.
 */
export async function executeAction(ref: StateRef, cardId: string, auth: ExecuteAuth, deps: ExecuteDeps): Promise<ExecuteResult> {
  const start = deps.now();
  const checked = authorize(ref.get(), cardId, auth, deps.adapters, { key: deps.key, now: start });
  if (!checked.ok) {
    if (checked.code === 'expired') {
      const expired = expireCards(ref.get(), start);
      if (expired.expired.length) await ref.set(expired.state);
      return { ...checked, card: ref.get().actionCards.find(c => c.id === cardId) };
    }
    return checked;
  }
  const actor = auth.kind === 'tap' ? auth.memberId : HOMEMIND_ACTOR;
  const running: ActionCard = {
    ...checked.card,
    status: 'executing',
    usedTokenIds: checked.tokenId ? [...(checked.card.usedTokenIds ?? []), checked.tokenId] : checked.card.usedTokenIds ?? [],
    executedBy: actor
  };
  await ref.set(replaceCard(ref.get(), running));

  let outcome: AdapterResult;
  try {
    outcome = await checked.adapter.execute(structuredClone(running.payload), AbortSignal.timeout(deps.timeoutMs ?? ADAPTER_TIMEOUT_MS));
    if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') outcome = { ok: false, error: 'The service gave no answer' };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    outcome = { ok: false, error: timedOut ? 'The service did not answer in time' : 'The service failed' };
  }

  const end = deps.now();
  const latest = ref.get().actionCards.find(c => c.id === cardId) ?? running;
  const finished: ActionCard = {
    ...latest,
    status: outcome.ok ? 'executed' : 'failed',
    finishedAt: isoAt(end),
    ...(outcome.ok && outcome.result ? { result: outcome.result } : {}),
    ...(!outcome.ok ? { error: outcome.error.slice(0, 300) } : {})
  };
  const logged = logOutcome(replaceCard(ref.get(), finished), finished, outcome.ok ? 'executed' : 'failed', actor, end);
  await ref.set(logged.state);
  return outcome.ok
    ? { ok: true, card: finished, activity: logged.activity }
    : { ok: false, code: 'action_failed', message: finished.error ?? 'The service failed', card: finished, activity: logged.activity };
}

// --- cancel and expire --------------------------------------------------------------------------------

export type CancelResult = { ok: true; state: HomemindState; card: ActionCard; activity: Activity } | ActionError;

/** A parent cancels a pending card. Nothing runs, and its tokens are worthless from now on. */
export function cancelCard(state: HomemindState, cardId: string, memberId: string, now: number): CancelResult {
  const card = state.actionCards.find(c => c.id === cardId);
  if (!card) return refuse('not_found', 'No such action card');
  if (!isParent(state, memberId)) return refuse('not_parent', 'Only a parent can cancel an action');
  if (card.status !== 'pending') return refuse('not_pending', `This action is ${card.status}`);
  const cancelled: ActionCard = { ...card, status: 'cancelled', finishedAt: isoAt(now), executedBy: memberId };
  const logged = logOutcome(replaceCard(state, cancelled), cancelled, 'cancelled', memberId, now);
  return { ok: true, state: logged.state, card: cancelled, activity: logged.activity };
}

/** Marks every pending card past its expiry as `expired`, with an Activity entry each. Pure. */
export function expireCards(state: HomemindState, now: number): { state: HomemindState; expired: ActionCard[] } {
  const due = state.actionCards.filter(c => c.status === 'pending' && !(Date.parse(c.expiresAt) > now));
  let next = state;
  const expired: ActionCard[] = [];
  for (const card of due) {
    const done: ActionCard = { ...card, status: 'expired', finishedAt: isoAt(now) };
    next = logOutcome(replaceCard(next, done), done, 'expired', HOMEMIND_ACTOR, now).state;
    expired.push(done);
  }
  return { state: next, expired };
}
