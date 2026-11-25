/**
 * Runs Homemind's board core (`applyChange` in server/homemind/core.ts, unchanged) under HOPA's board
 * rules, so its behaviour can be written down as fixtures for the Kotlin port (HOPA `core/family`).
 *
 * The core is wrapped, not edited. This adapter is where HOPA's decisions live:
 *   - D10: the reducer never reads a clock and never mints an id. The core's clock is pinned to the op's
 *     `at`; the activity id the core makes is replaced by the op's `opId`; the ids the core makes for new
 *     split parts are replaced by the ids inside the op. A create must carry its item id.
 *   - D12: the actor is the server-attested `memberId` of the log entry, never a field of the op.
 *   - D11: the state is split into scopes, and an op only sees the scope it was written in: its items
 *     are handed to the core with `visibility` set to that scope, nothing else. So a `family` op that
 *     names a `parents` id finds nothing (`not_found`), and the other way round (the owner's choice for
 *     v1: no references across scopes in either direction).
 *   - D15: an op with `v` other than 1 or a `kind` this reader does not know stops the replay at that seq.
 * Everything else (versions, ownership, undo, split, recurrence) is the core's own behaviour.
 */
import { applyChange } from '../../server/homemind/core';
import type { Change, ChangeErrorCode } from '../../server/homemind/core';
import { ID_PATTERN } from '../../server/homemind/types';
import type { Activity, HomemindState, Item } from '../../server/homemind/types';

export type Scope = 'family' | 'parents';
export const SCOPES: readonly Scope[] = ['family', 'parents'];

export const OP_KINDS = [
  'create',
  'edit',
  'assign',
  'open',
  'unassign',
  'claim',
  'confirm',
  'handback',
  'done',
  'cancel',
  'cancel_occurrence',
  'approve',
  'dismiss',
  'split',
  'undo'
] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** One op as in HOPA's spec/schemas/family/op.v1.schema.json (kind-specific fields kept loose here). */
export interface Op {
  v: number;
  kind: string;
  opId: string;
  at: string;
  [field: string]: unknown;
}

/** `$defs/logEntry` of the op schema: what the server attests for one seq, plus the decrypted op. */
export interface LogEntry {
  seq: number;
  scope: Scope;
  memberId: string;
  fromDevice: string;
  op: Op;
}

export interface V1Member {
  id: string;
  name: string;
  nameZh?: string;
  role: 'parent' | 'teen' | 'child';
  hasAccount: boolean;
}

export interface V1Family {
  id: string;
  name: string;
  nameZh?: string;
  timezone: string;
  members: V1Member[];
}

/** An item without `visibility`: the scope it sits in is its visibility. */
export type V1Item = Omit<Item, 'visibility' | 'sourceRefs' | 'stale' | 'mailboxIds'>;

export interface V1UndoEntry {
  itemId: string;
  before: V1Item | null;
  afterVersion: number;
}

export interface V1Activity {
  id: string;
  at: string;
  actor: string;
  what: string;
  kind: string;
  itemId?: string;
  memberId?: string;
  note?: string;
  ref?: string;
  undo?: { items: V1UndoEntry[] };
  undone?: { at: string; by: string; activityId: string };
}

export interface Partition {
  items: V1Item[];
  activity: V1Activity[];
}

/** HOPA's spec/schemas/family/state.v1.schema.json. */
export interface V1State {
  schemaVersion: 1;
  family: V1Family;
  scopes: { family: Partition; parents?: Partition };
}

export type Outcome = { seq: number; outcome: 'applied' } | { seq: number; outcome: 'rejected'; code: ChangeErrorCode };

export type StepResult = { kind: 'applied'; state: V1State } | { kind: 'rejected'; code: ChangeErrorCode } | { kind: 'stop' };

// ---------------------------------------------------------------------------------------------
// Shape conversion

const clone = <T>(value: T): T => structuredClone(value);

function stripItem(item: Item): V1Item {
  const { visibility: _visibility, sourceRefs: _refs, stale: _stale, mailboxIds: _mailbox, ...rest } = item;
  return rest;
}

/** Homemind's seed (or any HomemindState) in the v1 shape: each item moved into its visibility's scope. */
export function toV1State(state: HomemindState): V1State {
  const scope = (visibility: Scope): Partition => ({
    items: state.items.filter(item => item.visibility === visibility).map(item => stripItem(clone(item))),
    activity: []
  });
  const { id, name, nameZh, timezone } = state.family;
  return {
    schemaVersion: 1,
    family: {
      id,
      name,
      ...(nameZh ? { nameZh } : {}),
      timezone,
      members: state.family.members.map(m => ({ id: m.id, name: m.name, ...(m.nameZh ? { nameZh: m.nameZh } : {}), role: m.role, hasAccount: m.hasAccount }))
    },
    scopes: { family: scope('family'), parents: scope('parents') }
  };
}

/** The state a device that holds only `scopes` starts from (a teen device holds `family` only). */
export function viewOf(state: V1State, scopes: readonly Scope[]): V1State {
  const out: V1State = { schemaVersion: 1, family: clone(state.family), scopes: { family: clone(state.scopes.family) } };
  if (scopes.includes('parents') && state.scopes.parents) out.scopes.parents = clone(state.scopes.parents);
  return out;
}

function withVisibility(item: V1Item, scope: Scope): Item {
  return { ...clone(item), visibility: scope } as Item;
}

/** What the core sees for one op: the roster and the op's own scope, nothing else. */
function coreState(state: V1State, partition: Partition, scope: Scope): HomemindState {
  return {
    family: { ...clone(state.family), members: state.family.members.map(m => ({ ...m, lang: 'en' })) },
    items: partition.items.map(item => withVisibility(item, scope)),
    activity: partition.activity.map(a => ({
      ...clone(a),
      ...(a.undo
        ? { undo: { items: a.undo.items.map(e => ({ ...e, before: e.before ? withVisibility(e.before, scope) : null })) } }
        : {})
    }))
  } as unknown as HomemindState;
}

function fromCore(items: Item[], activity: Activity[], scope: Scope): Partition {
  const back = (item: Item): V1Item => {
    if (item.visibility !== scope) throw new Error(`item ${item.id} left scope ${scope}`);
    return stripItem(item);
  };
  return {
    items: items.map(back),
    activity: activity.map(a => {
      const { undo, ...rest } = a;
      const out = rest as V1Activity;
      if (undo) out.undo = { items: undo.items.map(e => ({ itemId: e.itemId, before: e.before ? back(e.before) : null, afterVersion: e.afterVersion })) };
      return out;
    })
  };
}

// ---------------------------------------------------------------------------------------------
// One log entry

const KNOWN = new Set<string>(OP_KINDS);

function toChange(op: Op, scope: Scope): Change | { error: ChangeErrorCode } {
  const { v: _v, opId: _opId, at: _at, kind, ...fields } = op;
  switch (kind) {
    case 'create':
      // No visibility in a v1 op (D11): the item is created in the op's scope.
      return { kind: 'create', item: { ...(fields.item as object), visibility: scope } } as Change;
    case 'edit':
      if (fields.patch && typeof fields.patch === 'object' && 'visibility' in fields.patch) return { error: 'invalid' };
      return { kind, ...fields } as Change;
    case 'split': {
      const parts = Array.isArray(fields.parts) ? (fields.parts as Array<Record<string, unknown>>) : [];
      return { kind, ...fields, parts: parts.map(({ id: _id, ...part }) => part) } as unknown as Change;
    }
    case 'undo':
      return { kind: 'undo', activityId: fields.targetOpId as string };
    default:
      return { kind, ...fields } as Change;
  }
}

/**
 * Applies one log entry to a device's state. Pure: `state` is not changed. A rejected entry leaves the
 * state as it was (the op stays in the server's log; every device rejects it the same way).
 */
export function applyEntry(state: V1State, entry: LogEntry): StepResult {
  const { op, scope } = entry;
  if (op.v !== 1 || !KNOWN.has(op.kind)) return { kind: 'stop' };
  const partition = state.scopes[scope];
  if (!partition) throw new Error(`seq ${entry.seq}: this device does not hold scope ${scope}`);
  if (typeof op.opId !== 'string' || !ID_PATTERN.test(op.opId)) return { kind: 'rejected', code: 'invalid' };
  // An op id names its activity, so it must be new in the scope (the server already refuses a reused op id).
  if (partition.activity.some(a => a.id === op.opId)) return { kind: 'rejected', code: 'conflict' };
  const atMs = Date.parse(op.at);
  if (typeof op.at !== 'string' || !Number.isFinite(atMs) || new Date(atMs).toISOString() !== op.at) return { kind: 'rejected', code: 'invalid' };
  if (op.kind === 'create') {
    const item = op.item as { id?: unknown } | undefined;
    if (!item || typeof item.id !== 'string') return { kind: 'rejected', code: 'invalid' };
  }

  const change = toChange(op, scope);
  if ('error' in change) return { kind: 'rejected', code: change.error };
  const before = coreState(state, partition, scope);
  const result = applyChange(before, change, entry.memberId, { now: () => atMs });
  if (!result.ok) return { kind: 'rejected', code: result.code };

  // D10: replace every id the core minted with the one the op carries.
  const rename = new Map<string, string>([[result.activity.id, op.opId]]);
  if (op.kind === 'split') {
    const ids = (op.parts as Array<{ id?: unknown }>).slice(1).map(p => p.id);
    const known = new Set(before.items.map(i => i.id));
    if (ids.some(id => typeof id !== 'string' || !ID_PATTERN.test(id))) return { kind: 'rejected', code: 'invalid' };
    if (new Set(ids).size !== ids.length) return { kind: 'rejected', code: 'invalid' };
    if (ids.some(id => known.has(id as string))) return { kind: 'rejected', code: 'conflict' };
    const minted = result.state.items.filter(i => !known.has(i.id)).map(i => i.id);
    if (minted.length !== ids.length) throw new Error(`split made ${minted.length} items for ${ids.length} parts`);
    minted.forEach((id, n) => rename.set(id, ids[n] as string));
  }
  const renamed = JSON.parse(JSON.stringify({ items: result.state.items, activity: result.state.activity }), (key, value) =>
    (key === 'id' || key === 'itemId' || key === 'activityId') && typeof value === 'string' && rename.has(value) ? rename.get(value) : value
  ) as { items: Item[]; activity: Activity[] };

  const next = viewOf(state, state.scopes.parents ? SCOPES : ['family']);
  next.scopes[scope] = fromCore(renamed.items, renamed.activity, scope);
  return { kind: 'applied', state: next };
}

export interface Replay {
  state: V1State;
  results: Outcome[];
  /** The seq where replay stopped on an op this reader does not know (D15). */
  stoppedAt?: number;
}

/** Replays `log` in seq order on a device that holds `scopes`; entries of other scopes never reach it. */
export function replay(start: V1State, log: readonly LogEntry[], scopes: readonly Scope[]): Replay {
  let state = viewOf(start, scopes);
  const results: Outcome[] = [];
  let last = 0;
  for (const entry of log) {
    if (entry.seq <= last) throw new Error(`seq ${entry.seq} is not after ${last}`);
    last = entry.seq;
    if (!scopes.includes(entry.scope)) continue;
    const step = applyEntry(state, entry);
    if (step.kind === 'stop') return { state, results, stoppedAt: entry.seq };
    if (step.kind === 'applied') {
      state = step.state;
      results.push({ seq: entry.seq, outcome: 'applied' });
    } else {
      results.push({ seq: entry.seq, outcome: 'rejected', code: step.code });
    }
  }
  return { state, results };
}
