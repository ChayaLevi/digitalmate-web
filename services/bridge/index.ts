import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { handleOrbitRequest, bridgeConfigWarnings, readOrbitConfig } from '../../server/orbit';
import { handleRssRequest } from '../../server/rss';
import { handleEpicRequest } from '../../server/epic';
import { handleFridgeRequest } from '../../server/fridge';
import { handleHomemindRequest } from '../../server/homemind';
import { cloudConfigWarnings, cloudGate, cloudMode } from '../../server/cloud';

const root = resolve(process.cwd(), 'dist');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "media-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function applySecurityHeaders(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim();
  if (forwardedProto === 'https') {
    response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

function notFound(response: ServerResponse): void {
  response.statusCode = 404;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end('Not found');
}

function sendFile(request: IncomingMessage, response: ServerResponse, filePath: string): void {
  const extension = extname(filePath);
  response.statusCode = 200;
  response.setHeader('content-type', MIME[extension] ?? 'application/octet-stream');
  if (filePath.includes(`${sep}assets${sep}`)) {
    response.setHeader('cache-control', 'public, max-age=31536000, immutable');
  } else if (extension === '.js' || extension === '.webmanifest' || extension === '.html') {
    response.setHeader('cache-control', 'no-cache');
  }
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  applySecurityHeaders(request, response);
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(JSON.stringify({ ok: true, app: 'digitalmate-web' }));
      return;
    }

    // Cloud mode (P10): the Orbit, Epic and Fridge bridges answer 404 before any of them is reached.
    if (cloudGate(request, response)) return;

    if (url.pathname === '/api/rss') {
      await handleRssRequest(request, response);
      return;
    }
    if (url.pathname.startsWith('/api/epic/')) {
      await handleEpicRequest(request, response);
      return;
    }
    if (url.pathname.startsWith('/api/fridge/')) {
      await handleFridgeRequest(request, response);
      return;
    }
    // Homemind answers only with HOMEMIND_ENABLED=1; otherwise this falls through as before.
    if (url.pathname.startsWith('/api/homemind/') && (await handleHomemindRequest(request, response))) {
      return;
    }
    if (url.pathname.startsWith('/api/orbit/')) {
      await handleOrbitRequest(request, response);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.end();
      return;
    }

    const pathname = decodeURIComponent(url.pathname);
    const candidate = resolve(root, `.${pathname}`);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      response.statusCode = 403;
      response.end();
      return;
    }

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      sendFile(request, response, candidate);
      return;
    }

    if (pathname.startsWith('/assets/')) {
      notFound(response);
      return;
    }

    sendFile(request, response, join(root, 'index.html'));
  } catch (error) {
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Bridge server error' })
    );
  }
});

server.listen(port, host, () => {
  console.log(`DigitalMate bridge listening on http://${host}:${port}`);
  console.log(`Static root: ${root}`);
  const config = readOrbitConfig();
  console.log(`Orbit mode: ${config ? `live (${config.url.host})` : 'unconfigured (local mode)'}`);
  for (const warning of bridgeConfigWarnings(config)) {
    console.warn(`[config] ${warning}`);
  }
  if (cloudMode()) console.log('Cloud mode: on (Orbit, Epic and Fridge bridges closed)');
  for (const warning of cloudConfigWarnings()) {
    console.warn(`[cloud] ${warning}`);
  }
});

const shutdown = (signal: string) => {
  console.log(`Received ${signal}; draining connections.`);
  const force = setTimeout(() => process.exit(0), 10_000);
  if (typeof (force as { unref?: () => void }).unref === 'function') {
    (force as unknown as { unref: () => void }).unref();
  }
  server.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
