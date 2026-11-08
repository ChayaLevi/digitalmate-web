/**
 * PPMA client (T6.1): Homemind's side of the PPMA public HTTP contract (docs/homemind-spikes.md, T0.2).
 *
 * - Registers the Homemind manifest and mints an app token with the owner token. The app token lives
 *   in memory only; it is minted again after a restart or a 401.
 * - Reports family events through an **outgoing queue**. `emit()` only adds to the queue and returns at
 *   once: PPMA being slow or down never blocks a user action. The queue is saved to a small file beside
 *   the state file and retried with backoff, so nothing is lost across a bridge restart.
 * - Listens on one long-lived stream (`GET /stream?app=homemind`) and resumes with `Last-Event-ID`.
 *   Every command gets exactly one `command.outcome` (`causation_id` = the command id). Delivery is at
 *   least once, so handled command ids are saved and a repeat is never run twice.
 * - What a command does is the caller's handler (ppmaMap.ts). This file knows the wire, not the board.
 *
 * No UI and no imports from `src/`. Tokens are never logged; message text only with HOMEMIND_DEBUG=2.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './store';
import type { PpmaStatus } from './types';

export const PPMA_APP = 'homemind';
export const PPMA_APP_VERSION = '0.1.0';
/** One POST carries at most this many messages (the contract's limit). */
export const PPMA_BATCH = 100;
/** Oldest reports are dropped past this, with a log line. Outcomes are kept first. */
export const PPMA_OUTBOX_MAX = 1000;
/** How many handled command ids are remembered for de-duplication. */
export const PPMA_HANDLED_MAX = 2000;
export const PPMA_DEFAULT_TIMEOUT_MS = 10_000;
/** PPMA sends a heartbeat every 15 s; a stream silent for this long is treated as dead. */
export const PPMA_STREAM_IDLE_MS = 45_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

// --- config -------------------------------------------------------------------------------------------

export interface PpmaConfig {
  /** Base URL of PPMA. Absent: PPMA is off. */
  url?: string;
  ownerToken?: string;
  /** Read when `ownerToken` is not set. Defaults to PPMA's own setup-token file. */
  ownerTokenFile: string;
  space: string;
  timeoutMs: number;
  debug: 0 | 1 | 2;
}

export function ppmaConfigFromEnv(env: Record<string, string | undefined> = process.env): PpmaConfig {
  const timeout = Number(env.PPMA_TIMEOUT_MS);
  const space = env.PPMA_SPACE?.trim();
  return {
    url: env.PPMA_URL?.trim().replace(/\/+$/, '') || undefined,
    ownerToken: env.PPMA_OWNER_TOKEN?.trim() || undefined,
    ownerTokenFile: env.PPMA_OWNER_TOKEN_FILE?.trim() || join(homedir(), '.config', 'ppma', 'setup-token'),
    space: space && /^[A-Za-z0-9_.-]{1,64}$/.test(space) ? space : 'me',
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 60_000 ? timeout : PPMA_DEFAULT_TIMEOUT_MS,
    debug: env.HOMEMIND_DEBUG === '2' ? 2 : env.HOMEMIND_DEBUG === '1' ? 1 : 0
  };
}

/** `.homemind/state.json` → `.homemind/state.ppma.json`: the client's queue and stream position. */
export function ppmaSyncFileFor(dataFile: string): string {
  return /\.json$/i.test(dataFile) ? dataFile.replace(/\.json$/i, '.ppma.json') : `${dataFile}.ppma.json`;
}

// --- manifest -----------------------------------------------------------------------------------------

const str = (description: string, carries?: 'time' | 'title' | 'value') => ({ type: 'string', description, ...(carries ? { 'x-ppma-carries': carries } : {}) });

/**
 * What Homemind tells PPMA it emits and accepts. Every event is `personal`. The tools only propose:
 * **nothing sends or orders** (CLAUDE.md), and a proposal lands as a `proposed` item a parent approves.
 * `ui_commands: []`: Homemind does not show PPMA's own notifications in this version, so PPMA sends none.
 */
export const HOMEMIND_MANIFEST = {
  app: PPMA_APP,
  version: PPMA_APP_VERSION,
  display_name: 'Homemind',
  emits: [
    {
      type: 'homemind.item_changed',
      description: 'A family board item (event, preparation or task) was created, changed, assigned, completed or removed. Never a Parents-only item.',
      payload_schema: { type: 'object', properties: { item_id: { type: 'string' }, change: { enum: ['created', 'changed', 'removed', 'hidden'] } }, required: ['item_id', 'change'] },
      sensitivity: 'personal'
    },
    {
      type: 'homemind.preference_stated',
      description: 'A family member stated, corrected or removed a preference, with their own reason and where it applies.',
      payload_schema: { type: 'object', properties: { preference_id: { type: 'string' }, change: { type: 'string' } }, required: ['preference_id', 'change'] },
      sensitivity: 'personal'
    },
    {
      type: 'homemind.member_unavailable',
      description: 'A family member is unavailable for a period, because of an event on the family board.',
      payload_schema: { type: 'object', properties: { member_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['member_id'] },
      sensitivity: 'personal'
    },
    {
      type: 'homemind.reminder_outcome',
      description: 'How a family member answered a reminder: got it, or remind me later.',
      payload_schema: { type: 'object', properties: { reminder_id: { type: 'string' }, item_id: { type: 'string' }, response: { type: 'string' } }, required: ['reminder_id'] },
      sensitivity: 'personal'
    },
    {
      type: 'homemind.message_received',
      description: 'A message from a family source, such as a kindergarten group.',
      payload_schema: { type: 'object' },
      sensitivity: 'personal',
      responds_to_ppma: false
    }
  ],
  tools: [
    {
      name: 'homemind.get_board',
      description: 'Read the family board: upcoming open and proposed items everyone in the family may see.',
      input_schema: { type: 'object', properties: {} },
      effect: 'none',
      reversible: true,
      requires_confirmation: false
    },
    {
      name: 'homemind.propose_item',
      description: 'Propose an event or task. It lands as a proposed item that a parent approves or dismisses.',
      input_schema: {
        type: 'object',
        properties: { title: str('Short title', 'title'), start: str('ISO 8601 date-time with offset', 'time'), notes: str('Optional note') },
        required: ['title']
      },
      effect: 'create',
      reversible: true,
      requires_confirmation: false
    },
    {
      name: 'homemind.propose_preparation',
      description: 'Propose a preparation under an existing event on the board. It lands as proposed.',
      input_schema: {
        type: 'object',
        properties: { event_id: str('Id of the event'), title: str('Short title', 'title'), due: str('ISO 8601 date-time with offset', 'time') },
        required: ['event_id', 'title']
      },
      effect: 'create',
      reversible: true,
      requires_confirmation: false
    },
    {
      name: 'homemind.add_to_shopping',
      description: 'Suggest an item for the family shopping list. Nothing is bought.',
      input_schema: { type: 'object', properties: { title: str('What to get', 'title') }, required: ['title'] },
      effect: 'create',
      reversible: true,
      requires_confirmation: false
    }
  ],
  resources: [],
  ui_commands: []
} as const;

// --- messages -----------------------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** A ULID: 48 bits of time, 80 random bits, Crockford base32. The contract's message id. */
export function ulid(nowMs: number, random: (n: number) => Uint8Array = n => randomBytes(n)): string {
  let time = '';
  let t = Math.max(0, Math.floor(nowMs));
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

export interface PpmaMessage {
  id: string;
  kind: 'event' | 'command';
  type: string;
  space: string;
  source: { app: string; app_version: string; device?: string };
  target?: string;
  occurred_at: string;
  causation_id?: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
  resources?: Array<{ uri: string; mime_type?: string; title?: string }>;
  confidence?: number;
  rationale?: string;
  decision_id?: string;
  expires_at?: string;
}

export interface PpmaCommand extends PpmaMessage {
  kind: 'command';
}

export type OutcomeStatus = 'executed' | 'rejected' | 'modified' | 'expired' | 'failed' | 'dismissed';

export interface CommandOutcome {
  status: OutcomeStatus;
  path: 'auto' | 'asked';
  result?: unknown;
  detail?: string;
  modified_args?: Record<string, unknown>;
}

/** Decides what a command does. May change the board. Must not throw (a throw is reported as `failed`). */
export type CommandHandler = (command: PpmaCommand) => CommandOutcome | Promise<CommandOutcome>;

/** Keeps an outcome inside the contract's rules, so PPMA never rejects the batch over it. */
export function normalizeOutcome(outcome: CommandOutcome): CommandOutcome {
  const status = outcome.status;
  const path = status === 'dismissed' ? 'asked' : outcome.path === 'asked' ? 'asked' : 'auto';
  const out: CommandOutcome = { status, path };
  if (outcome.result !== undefined) out.result = outcome.result;
  if (outcome.detail) out.detail = outcome.detail.slice(0, 500);
  if (status === 'modified') out.modified_args = outcome.modified_args ?? {};
  return out;
}

// --- saved sync state ---------------------------------------------------------------------------------

export interface PpmaSyncState {
  version: 1;
  /** Messages not yet accepted by PPMA, oldest first. */
  outbox: PpmaMessage[];
  /** The last stream frame id fully processed. Resume is exclusive: nothing at or before it comes back. */
  lastStreamId?: string;
  /** Command ids already answered, newest last. */
  handled: Array<{ id: string; at: string; status: OutcomeStatus }>;
}

export interface PpmaSyncStore {
  load(): Promise<PpmaSyncState | null>;
  save(state: PpmaSyncState): Promise<void>;
}

const emptySync = (): PpmaSyncState => ({ version: 1, outbox: [], handled: [] });

function isSync(value: unknown): value is PpmaSyncState {
  const v = value as PpmaSyncState | null;
  return !!v && v.version === 1 && Array.isArray(v.outbox) && Array.isArray(v.handled) && (v.lastStreamId === undefined || typeof v.lastStreamId === 'string');
}

/** The default store: one JSON file, written atomically. An unreadable file starts empty. */
export function fileSyncStore(file: string): PpmaSyncStore {
  let queue: Promise<void> = Promise.resolve();
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
        return isSync(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    save(state) {
      const snapshot = JSON.parse(JSON.stringify(state)) as PpmaSyncState;
      const run = queue.then(() => writeJsonAtomic(file, snapshot));
      queue = run.catch(() => undefined);
      return run;
    }
  };
}

export function memorySyncStore(initial?: PpmaSyncState): PpmaSyncStore & { current(): PpmaSyncState | null } {
  let saved: PpmaSyncState | null = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    async load() {
      return saved ? JSON.parse(JSON.stringify(saved)) : null;
    },
    async save(state) {
      saved = JSON.parse(JSON.stringify(state));
    },
    current: () => saved
  };
}

// --- SSE ----------------------------------------------------------------------------------------------

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Feeds text chunks, calls `onFrame` per complete frame. Comment lines (heartbeats) are skipped. */
export function sseParser(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffer = '';
  return chunk => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const frame: SseFrame = { data: '' };
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') frame.id = value;
        else if (field === 'event') frame.event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) onFrame({ ...frame, data: data.join('\n') });
    }
  };
}

// --- the client ---------------------------------------------------------------------------------------

export interface PpmaDeps {
  fetch?: typeof fetch;
  /** Real time (envelopes and command expiry are PPMA's time, not the demo clock). */
  now?: () => number;
  log?: (line: string) => void;
  sync?: PpmaSyncStore;
  /** Backoff steps, for tests. */
  backoffMs?: readonly number[];
  streamIdleMs?: number;
}

export interface PpmaInfo {
  status: PpmaStatus;
  queued: number;
  /** A short code for the last problem (`network`, `http_503`, `owner_token_missing`, ...). Never a secret. */
  lastError?: string;
  lastOkAt?: string;
}

export interface PpmaClient {
  readonly config: PpmaConfig;
  start(): void;
  stop(): Promise<void>;
  status(): PpmaStatus;
  info(): PpmaInfo;
  /** Queues one event and returns its id at once. Never throws, never waits for PPMA. */
  emit(type: string, payload: Record<string, unknown>, options?: { correlationId?: string }): string | null;
  onStatus(listener: (status: PpmaStatus) => void): () => void;
  setCommandHandler(handler: CommandHandler): void;
  /** For tests: resolves when the queue is empty and saved (or after `timeoutMs`). */
  drained(timeoutMs?: number): Promise<boolean>;
}

type Wire = { ok: true; status: number; body: unknown } | { ok: false; code: string; status?: number; body?: unknown };

export function createPpmaClient(config: PpmaConfig, deps: PpmaDeps = {}): PpmaClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  const store = deps.sync ?? memorySyncStore();
  const backoff = deps.backoffMs ?? BACKOFF_MS;
  const idleMs = deps.streamIdleMs ?? PPMA_STREAM_IDLE_MS;
  const base = config.url;

  let sync: PpmaSyncState = emptySync();
  let loaded = false;
  let started = false;
  let stopped = false;
  let status: PpmaStatus = base ? 'connecting' : 'off';
  let lastError: string | undefined;
  let lastOkAt: string | undefined;
  let appToken: string | undefined;
  let authing: Promise<boolean> | null = null;
  let handler: CommandHandler = () => ({ status: 'rejected', path: 'auto', detail: 'Homemind does not handle this command' });
  let streamAbort: AbortController | null = null;
  let streamOpen = false;
  const listeners = new Set<(s: PpmaStatus) => void>();
  const loops: Promise<void>[] = [];
  /** Resolvers of sleeping loops; `kick()` wakes them early. */
  let sleepers: Array<() => void> = [];
  let saving: Promise<void> = Promise.resolve();
  let dirty = false;
  let flushing = false;

  const debug = (line: string) => {
    if (config.debug) log(`[homemind ppma] ${line}`);
  };

  const setStatus = (next: PpmaStatus, error?: string) => {
    if (error) lastError = error;
    if (next === 'ok') lastOkAt = new Date(now()).toISOString();
    if (status === next || status === 'off') return;
    status = next;
    debug(`status ${next}${error ? ` (${error})` : ''}`);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // A listener's failure never stops the client.
      }
    }
  };
  const fine = () => {
    lastError = undefined;
    if (streamOpen) setStatus('ok');
  };
  const trouble = (code: string) => setStatus('offline', code);

  const kick = () => {
    const waking = sleepers;
    sleepers = [];
    for (const wake of waking) wake();
  };
  const nap = (ms: number) =>
    new Promise<void>(resolve => {
      if (stopped) return resolve();
      const done = () => {
        clearTimeout(timer);
        sleepers = sleepers.filter(s => s !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      (timer as { unref?: () => void }).unref?.();
      sleepers.push(done);
    });

  const persist = () => {
    dirty = true;
    saving = saving.then(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await store.save(sync);
      } catch {
        log('[homemind ppma] could not save the PPMA queue; it will be retried with the next change');
      }
    });
    return saving;
  };

  const ready: Promise<void> = (async () => {
    const saved = await store.load().catch(() => null);
    if (saved) {
      // Messages queued before this load (none in practice: emit waits for nothing) go after the saved ones.
      sync = { ...saved, outbox: [...saved.outbox, ...sync.outbox] };
    }
    loaded = true;
  })();

  async function call(method: string, path: string, init: { token?: string; body?: unknown; purpose: string }): Promise<Wire> {
    const t0 = now();
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch (error) {
      const name = (error as Error)?.name;
      const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
      debug(`${init.purpose} fail ${code} ${now() - t0} ms`);
      return { ok: false, code };
    }
    let body: unknown;
    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    debug(`${init.purpose} ${response.status} ${now() - t0} ms`);
    if (!response.ok) return { ok: false, code: `http_${response.status}`, status: response.status, body };
    return { ok: true, status: response.status, body };
  }

  async function ownerToken(): Promise<string | undefined> {
    if (config.ownerToken) return config.ownerToken;
    try {
      return (await readFile(config.ownerTokenFile, 'utf8')).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Registers the manifest and mints an app token. Shared by both loops, one at a time. */
  function ensureAuth(): Promise<boolean> {
    if (appToken) return Promise.resolve(true);
    if (!authing) {
      authing = (async () => {
        const owner = await ownerToken();
        if (!owner) {
          trouble('owner_token_missing');
          return false;
        }
        const manifest = await call('PUT', `/v0/apps/${PPMA_APP}/manifest`, { token: owner, body: HOMEMIND_MANIFEST, purpose: 'manifest' });
        if (!manifest.ok) {
          trouble(manifest.status === 401 || manifest.status === 403 ? 'owner_token_refused' : manifest.status === 422 ? 'manifest_invalid' : manifest.code);
          if (manifest.status === 422 && config.debug) log(`[homemind ppma] manifest refused: ${JSON.stringify(manifest.body).slice(0, 500)}`);
          return false;
        }
        const minted = await call('POST', `/v0/apps/${PPMA_APP}/token`, { token: owner, body: { revoke_previous: false }, purpose: 'token' });
        const token = minted.ok ? (minted.body as { token?: unknown } | undefined)?.token : undefined;
        if (typeof token !== 'string' || !token) {
          trouble(minted.ok ? 'token_missing' : minted.status === 401 || minted.status === 403 ? 'owner_token_refused' : minted.code);
          return false;
        }
        appToken = token;
        return true;
      })().finally(() => {
        authing = null;
      });
    }
    return authing;
  }

  /** PPMA forgot our token (a restarted fake PPMA, or a revoke). */
  const tokenRefused = () => {
    appToken = undefined;
  };

  function envelope(type: string, payload: Record<string, unknown>, extra: Partial<PpmaMessage> = {}): PpmaMessage {
    const at = now();
    return {
      id: ulid(at),
      kind: 'event',
      type,
      space: config.space,
      source: { app: PPMA_APP, app_version: PPMA_APP_VERSION },
      occurred_at: new Date(at).toISOString(),
      payload,
      ...extra
    };
  }

  function enqueue(message: PpmaMessage): void {
    sync.outbox.push(message);
    if (sync.outbox.length > PPMA_OUTBOX_MAX) {
      // Drop the oldest reports, never an outcome (PPMA calibrates on those).
      const over = sync.outbox.length - PPMA_OUTBOX_MAX;
      let dropped = 0;
      sync.outbox = sync.outbox.filter(m => {
        if (dropped < over && m.type !== 'command.outcome') {
          dropped++;
          return false;
        }
        return true;
      });
      if (dropped) log(`[homemind ppma] queue full: dropped ${dropped} old report(s)`);
    }
    void persist();
    kick();
  }

  // --- outgoing loop ---

  async function flushOnce(): Promise<'empty' | 'sent' | 'retry'> {
    if (!sync.outbox.length) return 'empty';
    if (!(await ensureAuth())) return 'retry';
    const batch = sync.outbox.slice(0, PPMA_BATCH);
    const sent = await call('POST', `/v0/spaces/${encodeURIComponent(config.space)}/messages`, { token: appToken, body: { messages: batch }, purpose: `messages x${batch.length}` });
    if (config.debug === 2) for (const m of batch) log(`[homemind ppma] sent ${m.type} ${JSON.stringify(m.payload).slice(0, 500)}`);
    if (sent.ok) {
      const done = new Set(batch.map(m => m.id));
      sync.outbox = sync.outbox.filter(m => !done.has(m.id));
      await persist();
      fine();
      return 'sent';
    }
    if (sent.status === 401) {
      tokenRefused();
      trouble('app_token_refused');
      return 'retry';
    }
    if (sent.status === 422 || sent.status === 400) {
      // A message PPMA will never take must not block the rest: drop the named ones (else the batch).
      const named = (sent.body as { ids?: unknown } | undefined)?.ids;
      const bad = new Set(Array.isArray(named) && named.length ? named.filter((id): id is string => typeof id === 'string') : batch.map(m => m.id));
      const types = batch.filter(m => bad.has(m.id)).map(m => m.type);
      log(`[homemind ppma] PPMA refused ${bad.size} message(s) as invalid (${[...new Set(types)].join(', ')}); dropped`);
      if (config.debug) log(`[homemind ppma] refusal: ${JSON.stringify(sent.body).slice(0, 500)}`);
      sync.outbox = sync.outbox.filter(m => !bad.has(m.id));
      await persist();
      return 'sent';
    }
    trouble(sent.code);
    return 'retry';
  }

  async function flushLoop(): Promise<void> {
    await ready;
    let failures = 0;
    while (!stopped) {
      flushing = true;
      let result: 'empty' | 'sent' | 'retry';
      try {
        result = await flushOnce();
      } catch {
        result = 'retry';
      }
      flushing = false;
      if (stopped) break;
      if (result === 'sent') {
        failures = 0;
        continue;
      }
      if (result === 'empty') {
        failures = 0;
        await nap(60_000);
        continue;
      }
      await nap(backoff[Math.min(failures++, backoff.length - 1)]);
    }
  }

  // --- stream loop ---

  async function handleFrame(frame: SseFrame): Promise<void> {
    let message: PpmaMessage | undefined;
    try {
      message = JSON.parse(frame.data) as PpmaMessage;
    } catch {
      message = undefined;
    }
    if (message && message.kind === 'command' && typeof message.id === 'string' && typeof message.type === 'string' && (!message.target || message.target === PPMA_APP)) {
      await answer(message as PpmaCommand);
    } else if (message && config.debug) {
      debug(`stream ${message.kind ?? '?'} ${typeof message.type === 'string' ? message.type.slice(0, 80) : '?'} (not a command, ignored)`);
    }
    if (frame.id && /^\d{1,20}$/.test(frame.id)) {
      sync.lastStreamId = frame.id;
      void persist();
    }
  }

  async function answer(command: PpmaCommand): Promise<void> {
    if (sync.handled.some(h => h.id === command.id)) {
      debug(`command ${command.type} ${command.id} again: already answered`);
      return;
    }
    let outcome: CommandOutcome;
    const expires = command.expires_at ? Date.parse(command.expires_at) : NaN;
    if (Number.isFinite(expires) && expires <= now()) {
      outcome = { status: 'expired', path: 'auto', detail: 'The command arrived after its deadline' };
    } else {
      try {
        outcome = await handler(command);
      } catch {
        outcome = { status: 'failed', path: 'auto', detail: 'Homemind could not run this command' };
      }
    }
    outcome = normalizeOutcome(outcome);
    debug(`command ${command.type} → ${outcome.status}`);
    sync.handled.push({ id: command.id, at: new Date(now()).toISOString(), status: outcome.status });
    if (sync.handled.length > PPMA_HANDLED_MAX) sync.handled = sync.handled.slice(-PPMA_HANDLED_MAX);
    // The outcome and the handled id are saved together, so a crash never answers twice or not at all.
    enqueue(envelope('command.outcome', outcome as unknown as Record<string, unknown>, { causation_id: command.id, ...(command.correlation_id ? { correlation_id: command.correlation_id } : {}) }));
  }

  /** One connection. Returns when it ends, with how it ended. */
  async function streamOnce(): Promise<'ended' | 'retry' | 'reauth'> {
    if (!(await ensureAuth())) return 'retry';
    const controller = new AbortController();
    streamAbort = controller;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), idleMs);
      (idle as { unref?: () => void }).unref?.();
    };
    arm();
    const t0 = now();
    try {
      let response: Response;
      try {
        response = await doFetch(`${base}/v0/spaces/${encodeURIComponent(config.space)}/stream?app=${PPMA_APP}`, {
          headers: { accept: 'text/event-stream', authorization: `Bearer ${appToken}`, ...(sync.lastStreamId ? { 'last-event-id': sync.lastStreamId } : {}) },
          signal: controller.signal
        });
      } catch {
        if (!stopped) trouble('network');
        return 'retry';
      }
      debug(`stream ${response.status} ${now() - t0} ms${sync.lastStreamId ? ` from ${sync.lastStreamId}` : ''}`);
      if (response.status === 401) {
        // A PPMA that forgot our token may also have forgotten its ledger (fake profile): read from the
        // start. Commands are de-duplicated by id, so nothing runs twice.
        tokenRefused();
        sync.lastStreamId = undefined;
        void persist();
        trouble('app_token_refused');
        return 'reauth';
      }
      if (response.status === 422 && sync.lastStreamId) {
        sync.lastStreamId = undefined;
        void persist();
        return 'reauth';
      }
      if (!response.ok || !response.body) {
        trouble(`http_${response.status}`);
        return 'retry';
      }
      streamOpen = true;
      fine();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const frames: SseFrame[] = [];
      const feed = sseParser(frame => frames.push(frame));
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        feed(decoder.decode(value, { stream: true }));
        while (frames.length) await handleFrame(frames.shift() as SseFrame);
      }
      return 'ended';
    } catch {
      return 'ended';
    } finally {
      if (idle) clearTimeout(idle);
      streamAbort = null;
      if (streamOpen) {
        streamOpen = false;
        if (!stopped) trouble('stream_closed');
      }
    }
  }

  async function streamLoop(): Promise<void> {
    await ready;
    let failures = 0;
    while (!stopped) {
      const opened = now();
      const result = await streamOnce();
      if (stopped) break;
      if (result === 'reauth') continue;
      // A stream that stayed up a while resets the backoff.
      if (result === 'ended' && now() - opened > 30_000) failures = 0;
      await nap(backoff[Math.min(failures++, backoff.length - 1)]);
    }
  }

  return {
    config,
    start() {
      if (started || !base) return;
      started = true;
      loops.push(flushLoop(), streamLoop());
    },
    async stop() {
      stopped = true;
      streamAbort?.abort();
      kick();
      await Promise.allSettled(loops);
      await saving;
    },
    status: () => status,
    info: () => ({ status, queued: sync.outbox.length, ...(lastError ? { lastError } : {}), ...(lastOkAt ? { lastOkAt } : {}) }),
    emit(type, payload, options = {}) {
      if (!base || stopped) return null;
      try {
        const message = envelope(type, payload, options.correlationId ? { correlation_id: options.correlationId } : {});
        if (loaded) enqueue(message);
        else
          void ready.then(() => {
            enqueue(message);
          });
        return message.id;
      } catch {
        return null;
      }
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setCommandHandler(next) {
      handler = next;
    },
    async drained(timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      await ready;
      while (Date.now() < until) {
        if (!sync.outbox.length && !flushing) {
          await saving;
          return true;
        }
        kick();
        await new Promise(r => setTimeout(r, 20));
      }
      return false;
    }
  };
}
