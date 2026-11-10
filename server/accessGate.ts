import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { isSameOrigin } from './orbit';

/**
 * The access code gate (T10.3). With `HOMEMIND_ACCESS_CODE` set, every request except `/healthz` needs the
 * `hm_access` cookie, which `POST /access {code}` sets. Without the cookie a page request gets a small gate
 * page and an `/api/*` request gets `401 access_code_required`. The cookie is a gate, not an identity: the
 * Homemind session stays in `sessionStorage` and its header, so two windows can still be two people.
 * Without the variable nothing here changes a request.
 */

type Env = Record<string, string | undefined>;

export const ACCESS_COOKIE = 'hm_access';
export const ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_ACCESS_CODE_LENGTH = 8;
const MIN_SECRET_LENGTH = 16;
export const ACCESS_MAX_FAILURES = 10;
export const ACCESS_WINDOW_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 2048;

// --- pure parts ---------------------------------------------------------------------------------------

export function accessCodeFromEnv(env: Env = process.env): string | null {
  return env.HOMEMIND_ACCESS_CODE?.trim() || null;
}

function secretFromEnv(env: Env): string | null {
  const value = env.HOMEMIND_SECRET?.trim();
  return value && value.length >= MIN_SECRET_LENGTH ? value : null;
}

/** What stops the bridge from starting. Names the variables, never their values. */
export function accessStartupErrors(env: Env = process.env): string[] {
  const code = accessCodeFromEnv(env);
  if (!code) return [];
  const errors: string[] = [];
  if (code.length < MIN_ACCESS_CODE_LENGTH) errors.push(`HOMEMIND_ACCESS_CODE must be ${MIN_ACCESS_CODE_LENGTH} characters or more`);
  if (!secretFromEnv(env)) errors.push(`HOMEMIND_ACCESS_CODE needs HOMEMIND_SECRET (${MIN_SECRET_LENGTH} characters or more) to sign its cookie`);
  return errors;
}

/** Cloud mode without a code: open to anyone with the link. Said at startup. */
export function accessWarnings(env: Env = process.env): string[] {
  if (env.HOMEMIND_CLOUD !== '1' || accessCodeFromEnv(env)) return [];
  return ['HOMEMIND_ACCESS_CODE is not set: the page is open to anyone with the link, and the Homemind member picker is off in cloud mode'];
}

/**
 * The cookie key: derived from `HOMEMIND_SECRET` under its own label, and from the code, so a session
 * token can never pass as a cookie and changing the code shuts out every cookie made with the old one.
 */
export function accessKey(secret: string, code: string): Buffer {
  return createHmac('sha256', secret).update(`homemind.access-gate\u0000${code}`).digest();
}

const signBody = (body: string, key: Buffer) => createHmac('sha256', key).update(body).digest('base64url');

/** `<expiry ms, base64url>.<signature>`. */
export function signAccess(key: Buffer, nowMs: number = Date.now()): string {
  const body = Buffer.from(String(nowMs + ACCESS_TTL_MS)).toString('base64url');
  return `${body}.${signBody(body, key)}`;
}

export function verifyAccess(value: string | undefined, key: Buffer, nowMs: number = Date.now()): boolean {
  if (!value || value.length > 256) return false;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) return false;
  const expected = Buffer.from(signBody(body, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const exp = Number(Buffer.from(body, 'base64url').toString('utf8'));
  return Number.isFinite(exp) && exp >= nowMs;
}

/** Constant time over the digests, so neither the length nor the content leaks through timing. */
export function codeMatches(given: string, code: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(code).digest();
  return timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Wrong codes per client, in memory. Over the limit every try is refused until the window ends. */
export function createFailureLimiter(max = ACCESS_MAX_FAILURES, windowMs = ACCESS_WINDOW_MS) {
  const entries = new Map<string, { count: number; resetAt: number }>();
  const current = (id: string, now: number) => {
    const entry = entries.get(id);
    if (entry && entry.resetAt <= now) entries.delete(id);
    return entries.get(id);
  };
  return {
    blocked(id: string, now: number): boolean {
      return (current(id, now)?.count ?? 0) >= max;
    },
    fail(id: string, now: number): void {
      const entry = current(id, now);
      if (entry) entry.count += 1;
      else {
        // Keeps the map small if many addresses try: drop the expired ones first, then the oldest.
        if (entries.size >= 10_000) {
          for (const [key, value] of entries) if (value.resetAt <= now) entries.delete(key);
          if (entries.size >= 10_000) entries.delete(entries.keys().next().value as string);
        }
        entries.set(id, { count: 1, resetAt: now + windowMs });
      }
    },
    clear(): void {
      entries.clear();
    }
  };
}

/**
 * The client address for the limit. Behind Render's proxy the socket is the proxy, so in cloud mode the
 * last `x-forwarded-for` entry (the one the proxy added, which a client cannot forge) is used. Which entry
 * is right is still to be checked against Render's documentation on the first deploy (T14.2).
 */
export function clientAddress(request: IncomingMessage, cloud: boolean): string {
  if (cloud) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return request.socket.remoteAddress ?? 'unknown';
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export type GateMessage = 'wrong' | 'too_many' | null;

/** The gate page: inline, English and Chinese, no script and no external asset (the CSP allows it). */
export function gatePage(message: GateMessage = null): string {
  const notice =
    message === 'wrong'
      ? '<p class="error" role="alert">That code is not right. <span lang="zh-CN">访问码不正确。</span></p>'
      : message === 'too_many'
        ? '<p class="error" role="alert">Too many wrong codes. Try again in 15 minutes. <span lang="zh-CN">错误次数过多，请 15 分钟后再试。</span></p>'
        : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Homemind demo · 访问码</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1d2330; --muted: #5a6475; --accent: #2f6fdf; --error: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #1b212b; --text: #e8ecf2; --muted: #a3adbd; --accent: #7aa7ff; --error: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { width: 100%; max-width: 380px; background: var(--card); border-radius: 16px; padding: 24px; box-shadow: 0 2px 12px rgb(0 0 0 / 0.08); }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: var(--muted); }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid var(--muted); border-radius: 10px; background: transparent; color: var(--text); }
  button { margin-top: 16px; width: 100%; font: inherit; font-weight: 600; padding: 10px 12px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
  .error { color: var(--error); font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Homemind demo <span lang="zh-CN">演示</span></h1>
  <p>Enter the access code you were given. <span lang="zh-CN">请输入您收到的访问码。</span></p>
  ${notice}
  <form method="post" action="/access">
    <label for="code">Access code <span lang="zh-CN">访问码</span></label>
    <input id="code" name="code" type="password" autocomplete="off" required maxlength="128" autofocus>
    <button type="submit">Continue <span lang="zh-CN">继续</span></button>
  </form>
</main>
</body>
</html>
`;
}

// --- the handler --------------------------------------------------------------------------------------

const LIMITER = Symbol.for('homemind.access-limiter');
type GlobalWithLimiter = typeof globalThis & { [LIMITER]?: ReturnType<typeof createFailureLimiter> };
function limiter() {
  const g = globalThis as GlobalWithLimiter;
  g[LIMITER] ??= createFailureLimiter();
  return g[LIMITER];
}

/** For tests: forget the wrong-code counts. */
export function resetAccessGateForTests(): void {
  limiter().clear();
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

function sendGate(request: IncomingMessage, response: ServerResponse, status: number, message: GateMessage = null): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(request.method === 'HEAD' ? undefined : gatePage(message));
}

async function readSmallBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function codeFromBody(text: string, contentType: string): string | null {
  if (contentType.includes('application/x-www-form-urlencoded')) return new URLSearchParams(text).get('code');
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

function isHttps(request: IncomingMessage): boolean {
  return String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

async function handleAccessPost(request: IncomingMessage, response: ServerResponse, code: string, key: Buffer, env: Env): Promise<void> {
  const contentType = String(request.headers['content-type'] ?? '');
  const fromForm = contentType.includes('application/x-www-form-urlencoded');
  if (!isSameOrigin(request)) return sendJson(response, 403, { error: 'forbidden', message: 'Cross-origin request rejected' });
  const now = Date.now();
  const who = clientAddress(request, env.HOMEMIND_CLOUD === '1');
  if (limiter().blocked(who, now)) {
    response.setHeader('retry-after', String(Math.ceil(ACCESS_WINDOW_MS / 1000)));
    if (fromForm) return sendGate(request, response, 429, 'too_many');
    return sendJson(response, 429, { error: 'too_many_attempts', message: 'Too many wrong codes. Try again in 15 minutes' });
  }
  const text = await readSmallBody(request);
  if (text === null) return sendJson(response, 413, { error: 'too_large', message: 'The request body is too large' });
  const given = codeFromBody(text, contentType);
  if (given === null || !codeMatches(given.trim(), code)) {
    limiter().fail(who, now);
    if (fromForm) return sendGate(request, response, 401, 'wrong');
    return sendJson(response, 401, { error: 'wrong_code', message: 'That code is not right' });
  }
  const cookie = [`${ACCESS_COOKIE}=${signAccess(key, now)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(ACCESS_TTL_MS / 1000)}`];
  if (isHttps(request)) cookie.push('Secure');
  response.setHeader('set-cookie', cookie.join('; '));
  if (fromForm) {
    response.statusCode = 303;
    response.setHeader('location', '/');
    response.setHeader('cache-control', 'no-store');
    return void response.end();
  }
  sendJson(response, 200, { ok: true });
}

/**
 * Returns true when the gate answered (no cookie, or `/access`), false when the request goes on as before:
 * no code configured, `/healthz`, or a valid cookie.
 */
export async function handleAccessGate(request: IncomingMessage, response: ServerResponse, env: Env = process.env): Promise<boolean> {
  const code = accessCodeFromEnv(env);
  if (!code) return false;
  let pathname: string;
  try {
    pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (pathname === '/healthz') return false;
  const secret = secretFromEnv(env);
  if (!secret || code.length < MIN_ACCESS_CODE_LENGTH) {
    // The startup check refuses this; answer safely if it was skipped.
    sendJson(response, 503, { error: 'not_configured', message: 'The access code gate is not configured' });
    return true;
  }
  const key = accessKey(secret, code);
  const method = request.method ?? 'GET';
  if (pathname === '/access') {
    if (method === 'POST') await handleAccessPost(request, response, code, key, env);
    else if (method === 'GET' || method === 'HEAD') sendGate(request, response, 200);
    else sendJson(response, 405, { error: 'method_not_allowed', message: 'Use POST' });
    return true;
  }
  if (verifyAccess(readCookie(request.headers.cookie, ACCESS_COOKIE), key)) return false;
  if (pathname.startsWith('/api/') || (method !== 'GET' && method !== 'HEAD')) {
    sendJson(response, 401, { error: 'access_code_required', message: 'Enter the access code first' });
  } else {
    sendGate(request, response, 401);
  }
  return true;
}

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

/** Vite: registered right after the cloud gate, before every other plugin. */
export function accessGatePlugin(): Plugin {
  const attach = (server: { middlewares: { use: (fn: Middleware) => void } }) => {
    const errors = accessStartupErrors();
    if (errors.length) throw new Error(`[access] cannot start: ${errors.join('; ')}`);
    for (const warning of accessWarnings()) console.warn(`[access] ${warning}`);
    server.middlewares.use((request, response, next) => {
      handleAccessGate(request, response).then(
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
  return { name: 'homemind-access-gate', configureServer: attach, configurePreviewServer: attach };
}
