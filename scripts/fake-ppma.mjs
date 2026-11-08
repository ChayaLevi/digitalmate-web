#!/usr/bin/env node
/**
 * A small fake of PPMA's public HTTP contract, for Homemind's tests and rehearsals without PPMA (T6.1).
 *
 * `ppma serve --profile fake` is the real thing and should be preferred for contract checks
 * (scripts/ppma-smoke.sh), but it never issues commands, so the command and `command.outcome` loop
 * can't be tested against it. This fake can: `POST /_fake/command` puts a command on the stream.
 *
 * Implements, with the field names checked in T0.2 (docs/homemind-spikes.md):
 *   PUT  /v0/apps/homemind/manifest      owner or app token
 *   POST /v0/apps/homemind/token         owner token: mints an app token (the old one stays valid)
 *   POST /v0/spaces/{space}/messages     app token: MessageBatch -> 202 {accepted, duplicates} or 422
 *   GET  /v0/spaces/{space}/stream       app token: SSE of PPMA-originated messages, Last-Event-ID resume
 * Test controls (not part of PPMA):
 *   GET  /_fake/messages                 every message Homemind sent, in order
 *   POST /_fake/command {type, payload, expiresInMs?, id?}   issue a command on the stream
 *   POST /_fake/forget-tokens            like a restarted fake PPMA: app tokens stop working
 *   POST /_fake/down {down: true|false}  answer 503 to everything while down
 *
 * Run: `node scripts/fake-ppma.mjs` (FAKE_PPMA_PORT, default 18766; FAKE_PPMA_OWNER_TOKEN, default a fixed
 * test value printed at start). Then set PPMA_URL and PPMA_OWNER_TOKEN for the bridge.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const COMMAND_ONLY = ['confidence', 'rationale', 'decision_id', 'expires_at'];

function ulid(now = Date.now()) {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

export function createFakePpma(options = {}) {
  const ownerToken = options.ownerToken ?? 'fake-ppma-owner-token-0123456789abcdef';
  const app = 'homemind';
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const state = {
    manifest: null,
    manifestPuts: 0,
    tokens: new Set(),
    tokensMinted: 0,
    /** Every message, both directions, with its ledger seq. */
    ledger: [],
    seq: 0,
    seen: new Set(),
    down: false,
    streams: new Set(),
    streamConnects: 0,
    lastEventIds: []
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, code, detail, ids = []) => json(res, status, { error: code, detail, ids });
  const bearer = req => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const isOwner = req => bearer(req) === ownerToken;
  const isApp = req => state.tokens.has(bearer(req));

  async function body(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function frame(entry) {
    return `id: ${entry.seq}\nevent: ${entry.message.kind}\ndata: ${JSON.stringify(entry.message)}\n\n`;
  }

  function append(message) {
    const entry = { seq: ++state.seq, message };
    state.ledger.push(entry);
    if (message.source?.app === 'ppma') for (const stream of state.streams) stream.write(frame(entry));
    return entry;
  }

  function checkMessage(m, space) {
    if (!m || typeof m !== 'object') return 'not an object';
    if (typeof m.id !== 'string' || !ULID.test(m.id)) return 'id is not a ULID';
    if (m.kind !== 'event') return 'apps send events only';
    if (typeof m.type !== 'string' || !TYPE.test(m.type)) return 'bad type';
    if (m.space !== space) return 'space_mismatch';
    if (!m.source || m.source.app !== app || typeof m.source.app_version !== 'string' || !m.source.app_version) return 'source.app must be homemind';
    if (typeof m.occurred_at !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(m.occurred_at) || !Number.isFinite(Date.parse(m.occurred_at))) return 'occurred_at needs a time zone';
    if (!m.payload || typeof m.payload !== 'object' || Array.isArray(m.payload)) return 'payload must be an object';
    for (const key of COMMAND_ONLY) if (m[key] !== undefined) return `event messages must not set: ${key}`;
    if (m.type === 'command.outcome') {
      if (!m.causation_id) return 'command.outcome requires causation_id';
      const statuses = ['executed', 'rejected', 'modified', 'expired', 'failed', 'dismissed'];
      if (!statuses.includes(m.payload.status) || !['auto', 'asked'].includes(m.payload.path)) return 'bad outcome payload';
      if (m.payload.status === 'dismissed' && m.payload.path !== 'asked') return 'dismissed outcomes must have path asked';
    } else if (!m.type.startsWith(`${app}.`) && m.type !== 'user.correction') {
      return `type ${m.type} is not declared`;
    } else if (m.type.startsWith(`${app}.`) && !state.manifest?.emits?.some(e => e.type === m.type)) {
      return `type ${m.type} is not in the manifest`;
    }
    return null;
  }

  function stream(req, res, space, url) {
    if (url.searchParams.get('app') !== app) return error(res, 422, 'validation_error', 'app is required');
    const last = req.headers['last-event-id'];
    let after = 0;
    if (last !== undefined) {
      if (!/^\d+$/.test(String(last))) return error(res, 422, 'validation_error', 'Last-Event-ID must be an integer');
      after = Number(last);
    }
    state.streamConnects++;
    state.lastEventIds.push(last === undefined ? null : String(last));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(': connected\n\n');
    for (const entry of state.ledger) if (entry.seq > after && entry.message.source?.app === 'ppma' && entry.message.space === space) res.write(frame(entry));
    state.streams.add(res);
    const beat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    const end = () => {
      clearInterval(beat);
      state.streams.delete(res);
    };
    req.on('close', end);
    res.on('close', end);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/_fake/messages' && req.method === 'GET') {
        return json(res, 200, { messages: state.ledger.filter(e => e.message.source?.app === app).map(e => e.message) });
      }
      if (path === '/_fake/command' && req.method === 'POST') {
        const b = await body(req);
        return json(res, 200, { seq: api.issueCommand(b.type, b.payload ?? {}, b).seq, id: state.ledger.at(-1).message.id });
      }
      if (path === '/_fake/forget-tokens' && req.method === 'POST') {
        api.forgetTokens();
        return json(res, 200, { ok: true });
      }
      if (path === '/_fake/down' && req.method === 'POST') {
        state.down = Boolean((await body(req)).down);
        return json(res, 200, { down: state.down });
      }
      if (state.down) return error(res, 503, 'unavailable', 'fake PPMA is down');
      if (!bearer(req)) return error(res, 401, 'unauthorized', 'a bearer token is required');

      if (path === `/v0/apps/${app}/manifest` && req.method === 'PUT') {
        if (!isOwner(req) && !isApp(req)) return error(res, 401, 'unauthorized', 'unknown token');
        const m = await body(req);
        const bad =
          m.app !== app
            ? 'app mismatch'
            : !Array.isArray(m.emits) || m.emits.some(e => !TYPE.test(e.type) || !e.type.startsWith(`${app}.`))
              ? 'every event type must start with homemind.'
              : !Array.isArray(m.tools) || m.tools.some(t => !t.name?.startsWith(`${app}.`) || !t.effect)
                ? 'every tool must start with homemind. and have an effect'
                : m.ui_commands && m.ui_commands.some(c => !String(c).startsWith('ui.'))
                  ? 'ui commands must be ui.*'
                  : m.tools.some(t => t.effect === 'send' || t.effect === 'external')
                    ? 'test fake: Homemind must not expose a tool that sends or acts outside'
                    : null;
        if (bad) return error(res, 422, 'validation_error', bad);
        state.manifest = m;
        state.manifestPuts++;
        return json(res, 200, { app, version: m.version, registered_at: new Date().toISOString() });
      }
      if (path === `/v0/apps/${app}/token` && req.method === 'POST') {
        if (!isOwner(req)) return error(res, isApp(req) ? 403 : 401, isApp(req) ? 'forbidden' : 'unauthorized', 'owner token required');
        await body(req);
        const token = `fake-app-${randomBytes(20).toString('hex')}`;
        state.tokens.add(token);
        state.tokensMinted++;
        return json(res, 200, { app, token, issued_at: new Date().toISOString(), previous_valid_until: null });
      }
      const spaceMatch = /^\/v0\/spaces\/([^/]+)\/(messages|stream)$/.exec(path);
      if (spaceMatch) {
        const space = decodeURIComponent(spaceMatch[1]);
        if (isOwner(req) && spaceMatch[2] === 'messages') return error(res, 403, 'forbidden', "the owner token is not an app's");
        if (!isApp(req)) return error(res, 401, 'unauthorized', 'unknown token');
        if (spaceMatch[2] === 'stream' && req.method === 'GET') return stream(req, res, space, url);
        if (spaceMatch[2] === 'messages' && req.method === 'POST') {
          const b = await body(req);
          if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 100) return error(res, 422, 'validation_error', 'messages must hold 1 to 100');
          const bad = [];
          let detail = '';
          for (const m of b.messages) {
            const problem = checkMessage(m, space);
            if (problem) {
              bad.push(typeof m?.id === 'string' ? m.id : '?');
              detail ||= problem;
            }
          }
          if (bad.length) return error(res, 422, 'validation_error', detail, bad);
          const accepted = [];
          const duplicates = [];
          for (const m of b.messages) {
            if (state.seen.has(m.id)) duplicates.push(m.id);
            else {
              state.seen.add(m.id);
              accepted.push(m.id);
              append(m);
            }
          }
          return json(res, 202, { accepted, duplicates });
        }
      }
      return error(res, 404, 'not_found', 'not found');
    } catch (e) {
      return error(res, 400, 'bad_request', e instanceof Error ? e.message : 'bad request');
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  const api = {
    server,
    ownerToken,
    state,
    url: '',
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise(resolve => server.listen(port, host, resolve));
      api.url = `http://${host}:${server.address().port}`;
      return api.url;
    },
    async close() {
      for (const s of state.streams) s.destroy();
      state.streams.clear();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    },
    /** Messages Homemind sent, in order. */
    received: () => state.ledger.filter(e => e.message.source?.app === app).map(e => e.message),
    issueCommand(type, payload = {}, opts = {}) {
      const now = Date.now();
      return append({
        id: opts.id ?? ulid(now),
        kind: 'command',
        type,
        space: opts.space ?? 'me',
        source: { app: 'ppma', app_version: 'fake' },
        target: app,
        occurred_at: new Date(now).toISOString(),
        payload,
        resources: [],
        confidence: 0.5,
        rationale: opts.rationale ?? 'fake PPMA test command',
        decision_id: ulid(now),
        expires_at: new Date(now + (opts.expiresInMs ?? 10 * 60_000)).toISOString()
      });
    },
    /** Re-sends an earlier PPMA message as a new ledger entry (at-least-once delivery). */
    redeliver(id) {
      const entry = state.ledger.find(e => e.message.id === id);
      return entry ? append(entry.message) : null;
    },
    forgetTokens() {
      state.tokens.clear();
      for (const s of state.streams) s.destroy();
    },
    /** Ends open streams, as a network blip would. */
    dropStreams() {
      for (const s of state.streams) s.destroy();
    },
    setDown(down) {
      state.down = down;
      if (down) for (const s of state.streams) s.destroy();
    }
  };
  return api;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_PPMA_PORT ?? 18766);
  const fake = createFakePpma({ ownerToken: process.env.FAKE_PPMA_OWNER_TOKEN || undefined });
  fake.listen(port).then(url => {
    console.log(`fake PPMA (simulated, for tests) on ${url}`);
    console.log(`  PPMA_URL=${url} PPMA_OWNER_TOKEN=<FAKE_PPMA_OWNER_TOKEN or the built-in test token>`);
  });
}
