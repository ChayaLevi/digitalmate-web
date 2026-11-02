/**
 * Epic Replay bridge.
 *
 * DigitalMate stays the only thing the browser talks to. This module sits in the same Node
 * process as the Orbit bridge and:
 *   - reads the Epic Replay server's documented HTTP API (styles, run state, play card),
 *   - turns it into A2UI JSONL surfaces (src/lib/epicSurface.ts),
 *   - streams surface changes to the browser as server-sent events,
 *   - forwards uploads, checkpoint answers, restyle and delete,
 *   - proxies the video, the frames and the clip (with Range) so the browser never needs CORS.
 *
 * Epic Replay has no authentication and no CORS of its own. Keep it on localhost or behind your
 * own authenticated proxy, and set EPIC_REPLAY_TOKEN if that proxy expects a Bearer token. The
 * token is only ever sent upstream, never to the browser.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import {
  errorSurface,
  isTerminal,
  parsePastHtml,
  pastSurface,
  runSurface,
  startSurface,
  unreachableSurface
} from '../src/lib/epicSurface';
import type { EpicLang, EpicPlayCard, EpicRunState, EpicStyle } from '../src/lib/epicSurface';
import { isSameOrigin } from './orbit';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const MAX_UPLOAD = 210 * 1024 * 1024;
const POLL_MS = Number(process.env.EPIC_REPLAY_POLL_MS ?? 1500);
const MEDIA = new Set(['final.mp4', 'clip.mp4']);

export interface EpicConfig {
  base: URL;
  token?: string;
}

export function readEpicConfig(env: NodeJS.ProcessEnv = process.env): EpicConfig {
  const raw = env.EPIC_REPLAY_URL?.trim() || 'http://127.0.0.1:8010';
  const base = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  return { base, token: env.EPIC_REPLAY_TOKEN?.trim() || undefined };
}

function upstream(config: EpicConfig, path: string): URL {
  return new URL(path.replace(/^\//, ''), config.base);
}

function headers(config: EpicConfig, extra: Record<string, string> = {}): Record<string, string> {
  return config.token ? { ...extra, authorization: `Bearer ${config.token}` } : extra;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
}

function langOf(url: URL): EpicLang {
  return url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
}

async function getJson<T>(config: EpicConfig, path: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const res = await fetch(upstream(config, path), { headers: headers(config), signal: AbortSignal.timeout(10_000) });
  let body: T | null = null;
  try {
    body = (await res.json()) as T;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

function upstreamMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: { message?: string } } | null)?.error;
  return error?.message ?? fallback;
}

/** Epic Replay only offers Past replays as a server-rendered page (GET /past): read its cards. */
export async function loadPast(config: EpicConfig) {
  const res = await fetch(upstream(config, '/past'), { headers: headers(config), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Epic Replay answered ${res.status} for /past`);
  return parsePastHtml(await res.text(), (runId, path) => `/api/epic/runs/${runId}/${path}`);
}

export async function loadStyles(config: EpicConfig): Promise<EpicStyle[]> {
  const res = await getJson<EpicStyle[]>(config, '/styles');
  return res.ok && Array.isArray(res.body) ? res.body : [];
}

/** Build the surface that matches the run's current state. */
export async function surfaceForRun(config: EpicConfig, runId: string, lang: EpicLang): Promise<{ jsonl: string; terminal: boolean }> {
  const state = await getJson<EpicRunState>(config, `/runs/${runId}`);
  if (state.status === 404) return { jsonl: errorSurface(lang === 'zh' ? '找不到这次制作。' : 'That run no longer exists.', lang), terminal: true };
  if (!state.ok || !state.body) throw new Error(upstreamMessage(state.body, `Epic Replay answered ${state.status}`));
  const run = state.body;
  const waiting = (run.steps ?? []).some(step => step.status === 'waiting_user');
  let card: EpicPlayCard | null = null;
  if (waiting) {
    const res = await getJson<EpicPlayCard>(config, `/runs/${runId}/play-card`);
    card = res.ok ? res.body : null;
  }
  const styles = run.status === 'done' ? await loadStyles(config) : [];
  const proxy = (path: string) => `/api/epic/runs/${runId}/${path}`;
  return { jsonl: runSurface({ run, card, styles, proxy, lang }), terminal: isTerminal(run) };
}

function sse(response: ServerResponse, event: string | null, data: string): void {
  if (event) response.write(`event: ${event}\n`);
  for (const line of data.split('\n')) response.write(`data: ${line}\n`);
  response.write('\n');
}

async function streamRun(config: EpicConfig, request: IncomingMessage, response: ServerResponse, runId: string, lang: EpicLang): Promise<void> {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('x-accel-buffering', 'no');
  response.write(': connected\n\n');

  let closed = false;
  request.on('close', () => {
    closed = true;
  });
  const heartbeat = setInterval(() => {
    if (!closed) response.write(': keep-alive\n\n');
  }, 15_000);

  let last = '';
  try {
    while (!closed) {
      let next: { jsonl: string; terminal: boolean };
      try {
        next = await surfaceForRun(config, runId, lang);
      } catch {
        next = { jsonl: unreachableSurface(lang), terminal: false };
      }
      if (next.jsonl !== last) {
        last = next.jsonl;
        sse(response, null, next.jsonl);
      }
      if (next.terminal) {
        sse(response, 'end', 'terminal');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}

async function readBody(request: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
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

async function relay(response: ServerResponse, res: Response): Promise<void> {
  response.statusCode = res.status;
  response.setHeader('content-type', res.headers.get('content-type') ?? 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  const text = await res.text();
  response.end(text);
}

async function proxyMedia(config: EpicConfig, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const extra: Record<string, string> = {};
  if (typeof request.headers.range === 'string') extra.range = request.headers.range;
  // Give up on the upstream if it does not answer, or if the browser goes away mid-video.
  const abort = new AbortController();
  const headerTimer = setTimeout(() => abort.abort(), 30_000);
  const onClose = () => abort.abort();
  response.on('close', onClose);
  try {
    const res = await fetch(upstream(config, path), { headers: headers(config, extra), signal: abort.signal });
    clearTimeout(headerTimer);
    response.statusCode = res.status;
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = res.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, max-age=60');
    if (!res.body || request.method === 'HEAD') {
      await res.body?.cancel().catch(() => undefined);
      response.end();
      return;
    }
    // Own the response until the last byte is written. Returning earlier would let the next
    // middleware (Vite's HTML fallback) answer the same request.
    await pipeline(Readable.fromWeb(res.body as never), response);
  } catch (error) {
    if (abort.signal.aborted && response.destroyed) return; // the browser left (seeking, tab closed)
    if (!response.headersSent) throw error;
    response.destroy(); // headers are out: the only honest signal left is a broken stream
  } finally {
    clearTimeout(headerTimer);
    response.off('close', onClose);
  }
}

const ACTIONS = new Set(['confirm', 'generic', 'reject', 'restyle', 'delete']);

/**
 * Returns true when the request belonged to this bridge (the response is then finished or
 * destroyed and nobody else may touch it), false when it is not an /api/epic/ request.
 */
export async function handleEpicRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/epic/')) return false;
  await dispatchEpic(request, response, url);
  return true;
}

async function dispatchEpic(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const config = readEpicConfig();
  const lang = langOf(url);
  const method = request.method ?? 'GET';
  const path = url.pathname.slice('/api/epic'.length);

  try {
    if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(request)) {
      json(response, 403, { error: 'Cross-origin bridge request rejected' });
      return;
    }

    if (path === '/health') {
      try {
        const styles = await loadStyles(config);
        json(response, 200, { configured: true, reachable: styles.length > 0, upstream: config.base.host, authToken: Boolean(config.token) });
      } catch {
        json(response, 200, { configured: true, reachable: false, upstream: config.base.host, authToken: Boolean(config.token) });
      }
      return;
    }

    if (path === '/start' && method === 'GET') {
      let styles: EpicStyle[] = [];
      let pastCount = 0;
      try {
        styles = await loadStyles(config);
        pastCount = (await loadPast(config).catch(() => [])).length;
      } catch {
        styles = [];
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(styles.length ? startSurface(styles, lang, pastCount) : unreachableSurface(lang));
      return;
    }

    if (path === '/past' && method === 'GET') {
      const items = await loadPast(config);
      response.statusCode = 200;
      response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(pastSurface(items, lang));
      return;
    }

    if (path === '/runs' && method === 'POST') {
      const declared = Number(request.headers['content-length'] ?? 0);
      if (declared > MAX_UPLOAD) {
        json(response, 413, { error: { code: 'invalid_upload', message: 'The clip is larger than 200 MB.' } });
        return;
      }
      const contentType = String(request.headers['content-type'] ?? '');
      if (!contentType.startsWith('multipart/form-data')) {
        json(response, 400, { error: { code: 'invalid_request', message: 'Upload must be multipart/form-data.' } });
        return;
      }
      const res = await fetch(upstream(config, '/runs'), {
        method: 'POST',
        headers: headers(config, { 'content-type': contentType, ...(declared ? { 'content-length': String(declared) } : {}) }),
        body: Readable.toWeb(request) as never,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' });
      await relay(response, res);
      return;
    }

    const match = /^\/runs\/([^/]+)\/(.+)$/.exec(path);
    if (!match || !RUN_ID.test(match[1])) {
      json(response, 404, { error: 'Not found' });
      return;
    }
    const [, runId, rest] = match;

    if (rest === 'stream' && method === 'GET') {
      await streamRun(config, request, response, runId, lang);
      return;
    }
    if (rest === 'surface' && method === 'GET') {
      const out = await surfaceForRun(config, runId, lang);
      response.statusCode = 200;
      response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(out.jsonl);
      return;
    }
    if ((MEDIA.has(rest) || /^frames\/\d{1,6}\.jpg$/.test(rest)) && (method === 'GET' || method === 'HEAD')) {
      await proxyMedia(config, request, response, `/runs/${runId}/${rest}`);
      return;
    }
    if (rest === 'action' && method === 'POST') {
      const body = (await readBody(request)) as Record<string, unknown>;
      const action = String(body.action ?? '');
      if (!ACTIONS.has(action)) {
        json(response, 400, { error: { code: 'invalid_request', message: 'Unknown action.' } });
        return;
      }
      if (action === 'delete') {
        const res = await fetch(upstream(config, `/runs/${runId}`), { method: 'DELETE', headers: headers(config) });
        json(response, res.status === 204 ? 200 : res.status, res.status === 204 ? { deleted: true } : await res.json().catch(() => ({})));
        return;
      }
      if (action === 'restyle') {
        const style = String(body.style ?? '');
        if (!/^[a-z0-9_-]{1,60}$/i.test(style)) {
          json(response, 400, { error: { code: 'unknown_style', message: 'Pick a narrator.' } });
          return;
        }
        const payload: Record<string, string> = { style };
        if (typeof body.language === 'string' && /^[a-z]{2}$/.test(body.language)) payload.language = body.language;
        const res = await fetch(upstream(config, `/runs/${runId}/restyle`), {
          method: 'POST',
          headers: headers(config, { 'content-type': 'application/json' }),
          body: JSON.stringify(payload)
        });
        await relay(response, res);
        return;
      }
      const payload = { action, edits: body.edits ?? {}, context: body.context ?? {} };
      const res = await fetch(upstream(config, `/runs/${runId}/play-card`), {
        method: 'POST',
        headers: headers(config, { 'content-type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      await relay(response, res);
      return;
    }
    json(response, 404, { error: 'Not found' });
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.destroy();
      return;
    }
    json(response, 502, { error: { code: 'upstream_unreachable', message: error instanceof Error ? error.message : 'Epic Replay request failed' } });
  }
}

export function epicBridgePlugin(): Plugin {
  const attach = (server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((request, response, next) => {
      handleEpicRequest(request, response).then(
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
    name: 'digitalmate-epic-replay-bridge',
    configureServer: attach,
    configurePreviewServer: attach
  };
}
