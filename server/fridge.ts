/**
 * Fridge2Table bridge.
 *
 * DigitalMate stays the only thing the browser talks to (same pattern as server/epic.ts). This
 * module runs in the bridge process and:
 *   - forwards a chat turn (multipart: message + photos + one place tag per photo) to Fridge2Table's
 *     POST /chat and turns the ChatResponse into a DigitalMate turn with an A2UI surface
 *     (src/lib/fridgeSurfaces.ts),
 *   - serves recipe steps, the kitchen inventory, "I made it", "I bought these" and undo the same way,
 *   - proxies dish photos so the browser never needs CORS.
 *
 * Fridge2Table identifies a household by an httponly `household` cookie on its own domain. The
 * bridge keeps that id in its own httponly cookie (path /api/fridge) and sends it upstream, so each
 * browser keeps its own kitchen. FRIDGE2TABLE_HOUSEHOLD pins every browser to one household (handy
 * for a demo seeded from Fridge2Table's own page). Fridge2Table itself is not changed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import {
  boughtTurn,
  chatTurn,
  fridgeErrorTurn,
  fridgeUnreachableTurn,
  inventoryTurn,
  madeTurn,
  recipeTurn
} from '../src/lib/fridgeSurfaces';
import type {
  FridgeBoughtState,
  FridgeChatResponse,
  FridgeInventoryState,
  FridgeLang,
  FridgeMadeState,
  FridgeRecipe,
  FridgeSubstitution,
  FridgeTurn
} from '../src/lib/fridgeSurfaces';
import { isSameOrigin } from './orbit';

const HOUSEHOLD = /^[0-9a-f]{32}$/;
const RECIPE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const UNDO_TOKEN = /^[0-9a-f]{32}$/;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_UPLOAD = 25 * 1024 * 1024; // Fridge2Table takes up to 4 photos; DigitalMate caps each at 5 MB
const COOKIE = 'dm_f2t_household';
// The agent turn takes 11-15 s; a sleeping Render instance can add up to a minute before that.
const TURN_TIMEOUT_MS = Number(process.env.FRIDGE2TABLE_TIMEOUT_MS ?? 120_000);
const SHORT_TIMEOUT_MS = 60_000;

export interface FridgeConfig {
  base: URL | null;
  household?: string;
}

export function readFridgeConfig(env: NodeJS.ProcessEnv = process.env): FridgeConfig {
  const raw = env.FRIDGE2TABLE_URL?.trim();
  const pinned = env.FRIDGE2TABLE_HOUSEHOLD?.trim();
  if (!raw) return { base: null };
  const base = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('FRIDGE2TABLE_URL must be http(s)');
  return { base, household: pinned && HOUSEHOLD.test(pinned) ? pinned : undefined };
}

function upstream(config: FridgeConfig, path: string): URL {
  if (!config.base) throw new Error('FRIDGE2TABLE_URL is not set');
  return new URL(path.replace(/^\//, ''), config.base);
}

function langOf(url: URL): FridgeLang {
  return url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
}

function turn(response: ServerResponse, value: FridgeTurn): void {
  json(response, 200, value);
}

// --- household cookie -------------------------------------------------------------------------------

export function householdFromCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) {
      const value = rest.join('=');
      return HOUSEHOLD.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export function householdFromSetCookie(headers: Headers): string | undefined {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
  for (const value of values) {
    const match = /(?:^|[;,]\s*)household=([0-9a-f]{32})/.exec(value);
    if (match) return match[1];
  }
  return undefined;
}

interface Session {
  household?: string;
}

function sessionOf(config: FridgeConfig, request: IncomingMessage): Session {
  return { household: config.household ?? householdFromCookie(request.headers.cookie) };
}

function upstreamHeaders(session: Session, extra: Record<string, string> = {}): Record<string, string> {
  return session.household ? { ...extra, cookie: `household=${session.household}` } : extra;
}

/** Remember the household Fridge2Table gave this browser (only when it is not pinned). */
function keepHousehold(config: FridgeConfig, session: Session, request: IncomingMessage, response: ServerResponse, res: Response): void {
  if (config.household) return;
  const id = householdFromSetCookie(res.headers);
  if (!id || id === session.household) return;
  session.household = id;
  const secure = String(request.headers['x-forwarded-proto'] ?? '').startsWith('https') ? '; Secure' : '';
  response.setHeader(
    'set-cookie',
    `${COOKIE}=${id}; Path=/api/fridge; HttpOnly; SameSite=Lax; Max-Age=${10 * 365 * 24 * 3600}${secure}`
  );
}

// --- upstream calls ---------------------------------------------------------------------------------

interface Upstream<T> {
  ok: boolean;
  status: number;
  body: T | null;
  detail: string;
}

async function call<T>(
  config: FridgeConfig,
  session: Session,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null; duplex?: 'half'; timeoutMs?: number } = {}
): Promise<Upstream<T>> {
  const res = await fetch(upstream(config, path), {
    method: init.method ?? 'GET',
    headers: upstreamHeaders(session, { accept: 'application/json', ...(init.headers ?? {}) }),
    body: init.body ?? undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? SHORT_TIMEOUT_MS),
    ...(init.duplex ? { duplex: init.duplex } : {})
  } as RequestInit);
  keepHousehold(config, session, request, response, res);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const detail = typeof (body as { detail?: unknown } | null)?.detail === 'string'
    ? String((body as { detail: string }).detail)
    : `Fridge2Table answered ${res.status}`;
  return { ok: res.ok, status: res.status, body: res.ok ? (body as T) : null, detail };
}

async function readJson(request: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function substitutionsFrom(value: unknown): FridgeSubstitution[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is FridgeSubstitution =>
      Boolean(item) && typeof (item as FridgeSubstitution).missing === 'string' && typeof (item as FridgeSubstitution).use_instead === 'string')
    .slice(0, 12)
    .map(item => ({ missing: item.missing.slice(0, 60), use_instead: item.use_instead.slice(0, 60) }));
}

async function proxyPhoto(config: FridgeConfig, session: Session, request: IncomingMessage, response: ServerResponse, recipeId: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  const onClose = () => abort.abort();
  response.on('close', onClose);
  try {
    const res = await fetch(upstream(config, `/recipe/${recipeId}/photo`), { headers: upstreamHeaders(session), signal: abort.signal });
    clearTimeout(timer);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/') || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      response.statusCode = res.ok ? 404 : res.status;
      response.setHeader('cache-control', 'no-store');
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', type);
    const length = res.headers.get('content-length');
    if (length) response.setHeader('content-length', length);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, max-age=86400');
    if (request.method === 'HEAD') {
      await res.body.cancel().catch(() => undefined);
      response.end();
      return;
    }
    await pipeline(Readable.fromWeb(res.body as never), response);
  } catch (error) {
    if (abort.signal.aborted && response.destroyed) return;
    if (!response.headersSent) {
      response.statusCode = 502;
      response.end();
      return;
    }
    response.destroy(error instanceof Error ? error : undefined);
  } finally {
    clearTimeout(timer);
    response.off('close', onClose);
  }
}

// --- dispatcher -------------------------------------------------------------------------------------

/**
 * Returns true when the request belonged to this bridge (the response is then finished), false when
 * it is not an /api/fridge/ request.
 */
export async function handleFridgeRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/fridge/')) return false;
  await dispatchFridge(request, response, url);
  return true;
}

async function dispatchFridge(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const lang = langOf(url);
  const method = request.method ?? 'GET';
  const path = url.pathname.slice('/api/fridge'.length);
  let config: FridgeConfig;
  try {
    config = readFridgeConfig();
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : 'Bad FRIDGE2TABLE_URL' });
    return;
  }

  if (path === '/health' && method === 'GET') {
    if (!config.base) {
      json(response, 200, { configured: false, reachable: false });
      return;
    }
    let reachable = false;
    try {
      const res = await fetch(upstream(config, '/health'), { signal: AbortSignal.timeout(8_000) });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    json(response, 200, { configured: true, reachable, upstream: config.base.host, pinnedHousehold: Boolean(config.household) });
    return;
  }

  if (!config.base) {
    json(response, 503, { error: 'FRIDGE2TABLE_URL is not set on the DigitalMate bridge' });
    return;
  }
  if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(request)) {
    json(response, 403, { error: 'Cross-origin bridge request rejected' });
    return;
  }

  const session = sessionOf(config, request);

  try {
    if (path === '/chat' && method === 'POST') {
      const contentType = String(request.headers['content-type'] ?? '');
      if (!contentType.startsWith('multipart/form-data')) {
        json(response, 400, { error: 'Send the turn as multipart/form-data' });
        return;
      }
      const declared = Number(request.headers['content-length'] ?? 0);
      if (declared > MAX_UPLOAD) {
        json(response, 413, { error: 'The photos are larger than 25 MB in total' });
        return;
      }
      let lastMessage = '';
      try {
        lastMessage = decodeURIComponent(String(request.headers['x-fridge-message'] ?? '')).slice(0, 500);
      } catch {
        lastMessage = '';
      }
      const res = await call<FridgeChatResponse>(config, session, request, response, '/chat', {
        method: 'POST',
        headers: { 'content-type': contentType, ...(declared ? { 'content-length': String(declared) } : {}) },
        body: Readable.toWeb(request) as never,
        duplex: 'half',
        timeoutMs: TURN_TIMEOUT_MS
      });
      turn(response, res.ok && res.body ? chatTurn(res.body, lang, { lastMessage }) : fridgeErrorTurn(res.detail, lang));
      return;
    }

    if (path === '/opening' && method === 'GET') {
      const sessionId = url.searchParams.get('session_id') ?? '';
      if (!SESSION_ID.test(sessionId)) {
        json(response, 400, { error: 'Bad session id' });
        return;
      }
      const res = await call<FridgeChatResponse>(config, session, request, response, `/opening?session_id=${encodeURIComponent(sessionId)}`, {
        timeoutMs: TURN_TIMEOUT_MS
      });
      turn(response, res.ok && res.body ? chatTurn(res.body, lang) : fridgeErrorTurn(res.detail, lang));
      return;
    }

    if (path === '/inventory' && method === 'GET') {
      const res = await call<FridgeInventoryState>(config, session, request, response, '/inventory');
      turn(response, res.ok && res.body ? inventoryTurn(res.body, lang) : fridgeErrorTurn(res.detail, lang));
      return;
    }

    if (path === '/inventory/bought' && method === 'POST') {
      const body = (await readJson(request)) as { items?: unknown };
      const items = (Array.isArray(body.items) ? body.items : [])
        .filter((item): item is { name: string; category?: string | null } => Boolean(item) && typeof (item as { name?: unknown }).name === 'string')
        .slice(0, 40)
        .map(item => ({ name: item.name.slice(0, 60), category: typeof item.category === 'string' ? item.category : null }));
      if (!items.length) {
        json(response, 400, { error: 'Nothing to mark as bought' });
        return;
      }
      const res = await call<FridgeBoughtState>(config, session, request, response, '/inventory/bought', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(items)
      });
      turn(response, res.ok && res.body ? boughtTurn(res.body, items.map(item => item.name), lang) : fridgeErrorTurn(res.detail, lang));
      return;
    }

    if (path === '/inventory/undo' && method === 'POST') {
      const body = (await readJson(request)) as { tokens?: unknown };
      const tokens = (Array.isArray(body.tokens) ? body.tokens : []).filter(
        (token): token is string => typeof token === 'string' && UNDO_TOKEN.test(token)
      );
      if (!tokens.length) {
        json(response, 400, { error: 'Nothing to undo' });
        return;
      }
      let last: Upstream<FridgeInventoryState> | null = null;
      for (const token of tokens.slice(0, 40)) {
        const res = await call<FridgeInventoryState>(config, session, request, response, `/inventory/undo/${token}`, { method: 'POST' });
        if (res.ok) last = res;
      }
      if (!last?.body) {
        turn(response, fridgeErrorTurn(lang === 'zh' ? '没有可撤销的操作（可能已经撤销过）。' : 'Nothing to undo (it may already be undone).', lang));
        return;
      }
      turn(response, inventoryTurn(last.body, lang, { message: lang === 'zh' ? '已撤销。' : 'Undone.' }));
      return;
    }

    const recipe = /^\/recipe\/([^/]+)\/(steps|made|photo)$/.exec(path);
    if (recipe && RECIPE_ID.test(recipe[1])) {
      const [, recipeId, rest] = recipe;
      if (rest === 'photo' && (method === 'GET' || method === 'HEAD')) {
        await proxyPhoto(config, session, request, response, recipeId);
        return;
      }
      if (rest === 'steps' && method === 'GET') {
        const subs = url.searchParams
          .getAll('sub')
          .map(value => value.split(':'))
          .filter(pair => pair.length === 2 && pair[0].trim() && pair[1].trim())
          .slice(0, 12)
          .map(([missing, useInstead]) => ({ missing: missing.trim().slice(0, 60), use_instead: useInstead.trim().slice(0, 60) }));
        const query = subs.map(item => `sub=${encodeURIComponent(`${item.missing}:${item.use_instead}`)}`).join('&');
        const res = await call<FridgeRecipe>(config, session, request, response, `/recipe/${recipeId}/steps${query ? `?${query}` : ''}`, {
          timeoutMs: TURN_TIMEOUT_MS
        });
        turn(response, res.ok && res.body ? recipeTurn(res.body, lang, subs) : fridgeErrorTurn(res.detail, lang));
        return;
      }
      if (rest === 'made' && method === 'POST') {
        const body = (await readJson(request)) as { substitutions?: unknown };
        const res = await call<FridgeMadeState>(config, session, request, response, `/recipe/${recipeId}/made`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ substitutions: substitutionsFrom(body.substitutions) })
        });
        turn(response, res.ok && res.body ? madeTurn(res.body, lang) : fridgeErrorTurn(res.detail, lang));
        return;
      }
    }

    json(response, 404, { error: 'Not found' });
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.destroy();
      return;
    }
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const reason = error instanceof Error ? error.message : '';
    turn(response, timedOut || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(reason) ? fridgeUnreachableTurn(lang) : fridgeErrorTurn(reason || 'Request failed', lang));
  }
}

export function fridgeBridgePlugin(): Plugin {
  const attach = (server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((request, response, next) => {
      handleFridgeRequest(request, response).then(
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
    name: 'digitalmate-fridge2table-bridge',
    configureServer: attach,
    configurePreviewServer: attach
  };
}
