/**
 * Homemind client (T3.2): the Family tab's calls to the bridge (server/homemind.ts).
 *
 * - Health: whether Homemind is on at all. Without `HOMEMIND_ENABLED=1` the bridge does not answer
 *   `/api/homemind/*`, so anything but a JSON `{enabled: true}` means "off" and the tab stays hidden.
 * - Demo sign-in: the signed token lives in `sessionStorage`, one per window, so two windows can be two
 *   members. It travels as `x-homemind-session`, never in a cookie.
 * - Screens come back as a turn with JSONL, parsed through the normal A2UI store.
 * - `runHomemindAction` maps a card button (`kind: 'homemind'`, `args.verb`) to its bridge call.
 *   Navigation verbs (add, edit, search, back, save) belong to the host and are not handled here.
 *
 * Chat (`HomemindTransport`) is T5.2.
 */
import type { A2uiAction, A2uiSurface, Language } from '../types';
import { apiUrl } from '../lib/api';
import { A2uiSurfaceStore } from '../protocol/a2ui/store';
import type { HomemindScreenName } from '../lib/homemindSurfaces';
import type { Item } from '../../server/homemind/types';

export const SESSION_HEADER = 'x-homemind-session';
const SESSION_KEY = 'homemind.session';

export interface HomemindHealth {
  enabled: boolean;
  ready: boolean;
  llm: 'live' | 'fake' | 'not_configured';
  ppma: string;
  demo: boolean;
}

export interface HomemindMember {
  id: string;
  name: string;
  nameZh?: string;
  role: 'parent' | 'teen' | 'child';
  hasAccount: boolean;
  lang: Language;
}

export interface HomemindSession {
  token: string;
  member: HomemindMember;
}

export class HomemindError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly current?: Item
  ) {
    super(message);
  }
}

// --- session (per window) ---------------------------------------------------------------------------

export function readHomemindSession(): HomemindSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HomemindSession;
    return typeof parsed?.token === 'string' && typeof parsed.member?.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeHomemindSession(session: HomemindSession | null): void {
  try {
    if (session) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage blocked: the member signs in again after a reload */
  }
}

// --- requests ---------------------------------------------------------------------------------------

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, headers, ...rest } = init;
  const response = await fetch(apiUrl(path), {
    ...rest,
    headers: {
      accept: 'application/json',
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { [SESSION_HEADER]: token } : {}),
      ...(headers as Record<string, string> | undefined)
    },
    signal: rest.signal ?? AbortSignal.timeout(15_000)
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const b = (body ?? {}) as { error?: string; message?: string; current?: Item };
    throw new HomemindError(response.status, b.error ?? 'http_error', b.message ?? `Homemind answered HTTP ${response.status}`, b.current);
  }
  return body as T;
}

/** Null when Homemind is off, or the bridge is unreachable. Never throws. */
export async function homemindHealth(signal?: AbortSignal): Promise<HomemindHealth | null> {
  try {
    const response = await fetch(apiUrl('/api/homemind/health'), { headers: { accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(5_000) });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return null;
    const body = (await response.json()) as Partial<HomemindHealth>;
    return body && body.enabled === true ? (body as HomemindHealth) : null;
  } catch {
    return null;
  }
}

export async function fetchHomemindMembers(): Promise<{ family: { name: string; nameZh?: string }; members: HomemindMember[] }> {
  return call('/api/homemind/members');
}

export async function homemindSignIn(memberId: string): Promise<HomemindSession> {
  const body = await call<{ token: string; member: HomemindMember }>('/api/homemind/session', { method: 'POST', body: JSON.stringify({ memberId }) });
  return { token: body.token, member: body.member };
}

export interface HomemindScreen {
  surface: A2uiSurface | null;
  now: string;
}

export interface ScreenParams {
  q?: string;
  id?: string;
  parent?: string;
}

export async function fetchHomemindScreen(token: string, name: HomemindScreenName, lang: Language, params: ScreenParams = {}): Promise<HomemindScreen> {
  const query = new URLSearchParams({ lang });
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const turn = await call<{ jsonl?: string; now: string }>(`/api/homemind/screen/${name}?${query}`, { token });
  const surface = turn.jsonl ? A2uiSurfaceStore.fromJsonl(turn.jsonl).list()[0] ?? null : null;
  return { surface, now: turn.now };
}

export interface MutationResult {
  ok: true;
  /** Absent for an answer to a reminder, which changes no item and has no Undo. */
  activityId?: string;
  items: Item[];
  opened: string[];
  conflicts: unknown[];
}

/** A bridge write (create, edit) built by src/lib/homemindForm.ts. */
export async function sendHomemindWrite(token: string, request: { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> }): Promise<MutationResult> {
  return call(request.path, { method: request.method, token, body: JSON.stringify(request.body) });
}

/** Undo one change. `itemId` is an item that change touched. */
export async function undoHomemind(token: string, itemId: string, activityId: string): Promise<MutationResult> {
  return call(`/api/homemind/items/${encodeURIComponent(itemId)}/undo`, { method: 'POST', token, body: JSON.stringify({ activityId }) });
}

/** Demo only (`HOMEMIND_DEMO=1`): moves the demo clock forward and ticks the reminders at once. */
export async function jumpHomemindClock(token: string, minutes: number): Promise<{ ok: true; now: string; offsetMs: number; timezone: string; delivered: number }> {
  return call('/api/homemind/demo/clock', { method: 'POST', token, body: JSON.stringify({ minutes }) });
}

/** Settings (T4.2): only the fields that changed. Quiet hours are the member's own; the rest is parents only. */
export async function saveHomemindSettings(token: string, body: Record<string, unknown>): Promise<{ ok: true; changed: string[]; activityId?: string }> {
  return call('/api/homemind/settings', { method: 'PUT', token, body: JSON.stringify(body) });
}

/** Verbs the host handles itself (navigation and forms). */
export const HOST_VERBS = ['add', 'edit', 'search', 'back', 'save', 'save-settings'] as const;

const ITEM_VERBS = new Set(['claim', 'assign', 'ack', 'handback', 'done', 'approve', 'dismiss', 'cancel', 'open', 'unassign', 'snooze']);

export type ActionOutcome = { kind: 'mutation'; result: MutationResult; verb: string } | { kind: 'why'; why: { summary?: string; source?: string } };

/**
 * One card button (`kind: 'homemind'`) as a bridge call. The server decides whether it is allowed:
 * a button on screen is never proof of permission.
 */
export async function runHomemindAction(action: A2uiAction, token: string): Promise<ActionOutcome> {
  const args = action.args ?? {};
  const verb = typeof args.verb === 'string' ? args.verb : '';
  const id = (value: unknown) => encodeURIComponent(typeof value === 'string' ? value : '');
  if (ITEM_VERBS.has(verb)) {
    const body: Record<string, unknown> = { version: args.version };
    if (verb === 'assign') body.ownerId = args.memberId;
    // From a reminder alert: which reminder is answered ("Got it", "Remind me later").
    if ((verb === 'ack' || verb === 'snooze') && typeof args.reminderId === 'string') body.reminderId = args.reminderId;
    const result = await call<MutationResult>(`/api/homemind/items/${id(args.itemId)}/${verb}`, { method: 'POST', token, body: JSON.stringify(body) });
    return { kind: 'mutation', result, verb };
  }
  if (verb === 'undo') {
    const result = await undoHomemind(token, typeof args.itemId === 'string' ? args.itemId : '', typeof args.activityId === 'string' ? args.activityId : '');
    return { kind: 'mutation', result, verb };
  }
  if (verb === 'confirm-card' || verb === 'cancel-card') {
    const result = await call<MutationResult>(`/api/homemind/actions/${id(args.cardId)}/${verb === 'confirm-card' ? 'confirm' : 'cancel'}`, { method: 'POST', token, body: '{}' });
    return { kind: 'mutation', result, verb };
  }
  if (verb === 'why') {
    const body = await call<{ why: { summary?: string; source?: string } }>(`/api/homemind/why/${id(args.whyId)}`, { token });
    return { kind: 'why', why: body.why };
  }
  throw new HomemindError(400, 'unknown_action', `Unknown Homemind action: ${verb || action.id}`);
}
