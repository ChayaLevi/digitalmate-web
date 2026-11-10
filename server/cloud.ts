import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * Cloud mode (`HOMEMIND_CLOUD=1`, P10): the build that runs on Render.
 *
 * The other DigitalMate bridges either spend the owner's keys (Orbit) or need servers that do not run in
 * the cloud (Epic Replay, Fridge2Table), so in cloud mode they answer 404 before any of them is reached,
 * whatever their env vars say. `/api/rss` (Discover) stays open; the access gate (T10.3) is in front of it.
 * Without the flag nothing here changes a request.
 */

type Env = Record<string, string | undefined>;

export const cloudMode = (env: Env = process.env): boolean => env.HOMEMIND_CLOUD === '1';

/** The bridges that are closed in cloud mode, always. */
export const CLOSED_IN_CLOUD = ['/api/orbit', '/api/epic', '/api/fridge'] as const;

/** Env var prefixes that must not be set on the cloud service (they hold keys or point at local servers). */
const NOT_IN_CLOUD = ['ORBIT_', 'EPIC_REPLAY_', 'FRIDGE2TABLE_', 'PPMA_'] as const;

export function isClosedInCloud(pathname: string): boolean {
  return CLOSED_IN_CLOUD.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Answers a request for a closed bridge with `404 not_available` and returns true. Returns false (and
 * touches nothing) outside cloud mode or for any other path.
 */
export function cloudGate(request: IncomingMessage, response: ServerResponse, env: Env = process.env): boolean {
  if (!cloudMode(env)) return false;
  let pathname: string;
  try {
    pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (!isClosedInCloud(pathname)) return false;
  response.statusCode = 404;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify({ error: 'not_available', message: 'This service is not available in the cloud demo' }));
  return true;
}

/** One warning per env var that should not be set in cloud mode. Names only, never values. */
export function cloudConfigWarnings(env: Env = process.env): string[] {
  if (!cloudMode(env)) return [];
  return Object.keys(env)
    .filter(name => env[name] !== undefined && env[name] !== '' && NOT_IN_CLOUD.some(prefix => name.startsWith(prefix)))
    .sort()
    .map(name => `${name} is set, but cloud mode ignores it (its bridge is closed). Remove it from the service.`);
}

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

/** Vite: registered before every other bridge plugin, so a closed bridge is never reached in dev either. */
export function cloudGatePlugin(): Plugin {
  const attach = (server: { middlewares: { use: (fn: Middleware) => void } }) => {
    for (const warning of cloudConfigWarnings()) console.warn(`[cloud] ${warning}`);
    server.middlewares.use((request, response, next) => {
      if (!cloudGate(request, response)) next();
    });
  };
  return { name: 'homemind-cloud-gate', configureServer: attach, configurePreviewServer: attach };
}
