import { describe, expect, it } from 'vitest';
import {
  authorize,
  autonomyLevelFor,
  canonicalJson,
  cancelCard,
  CONFIRMATION_TTL_MS,
  executeAction,
  expireCards,
  issueConfirmation,
  payloadHash,
  prepareCard
} from '../server/homemind/actions';
import type { ActionAdapter, AdapterRegistry, ExecuteAuth, StateRef } from '../server/homemind/actions';
import { seedState } from '../server/homemind/seed';
import type { ActionCard, HomemindState } from '../server/homemind/types';

const NOW = Date.parse('2026-11-06T09:00:00.000Z');
const KEY = 'action-test-key-0123456789';
const HOUR = 60 * 60 * 1000;

interface Spy {
  calls: Array<Record<string, unknown>>;
}

function adapter(id: string, mode: 'real' | 'simulated', extra: Partial<ActionAdapter> = {}, spy: Spy = { calls: [] }): ActionAdapter {
  return {
    id,
    mode,
    area: 'food',
    validate: payload => (typeof payload.item === 'string' ? null : 'item is required'),
    execute: async payload => {
      spy.calls.push(payload);
      return { ok: true, result: { orderId: `o-${spy.calls.length}` } };
    },
    ...extra
  };
}

function setup(opts: { level?: 1 | 2 | 3 | 4; paused?: boolean; adapters?: AdapterRegistry } = {}) {
  const spy: Spy = { calls: [] };
  const adapters: AdapterRegistry = opts.adapters ?? {
    'pizza-sim': adapter('pizza-sim', 'simulated', { autoAllowed: true }, spy),
    'pizza-real': adapter('pizza-real', 'real', { autoAllowed: true }, spy),
    'sitter-sim': adapter('sitter-sim', 'simulated', {}, spy)
  };
  let state: HomemindState = seedState({ now: NOW });
  state = { ...state, family: { ...state.family, autonomy: { default: opts.level ?? 3 }, paused: opts.paused ?? false } };
  const ref: StateRef & { saves: number } = {
    saves: 0,
    get: () => state,
    set: next => {
      state = next;
      ref.saves++;
    }
  };
  const add = (id: string, adapterId: string, payload: Record<string, unknown> = { item: 'pizza', size: 'small' }, expiresInMs = HOUR) => {
    const prepared = prepareCard(state, { id, adapter: adapterId, payload, expiresAt: new Date(NOW + expiresInMs).toISOString(), whyId: `why-${id}` }, adapters, NOW);
    if (!prepared.ok) throw new Error(prepared.message);
    state = prepared.state;
    return prepared.card;
  };
  const token = (cardId: string, memberId = 'mom', at = NOW) => {
    const issued = issueConfirmation(state, cardId, memberId, { key: KEY, now: at }, adapters);
    if (!issued.ok) throw new Error(issued.code);
    return issued.token;
  };
  const run = (cardId: string, auth: ExecuteAuth, at = NOW) => executeAction(ref, cardId, auth, { adapters, key: KEY, now: () => at });
  const card = (id: string) => state.actionCards.find(c => c.id === id) as ActionCard;
  return { spy, adapters, ref, add, token, run, card, get state() { return state; }, set state(s: HomemindState) { state = s; } };
}

describe('payload hash', () => {
  it('ignores key order and changes with any value', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
    expect(payloadHash({ a: 1, b: 2 })).not.toBe(payloadHash({ a: 1, b: 3 }));
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('prepareCard', () => {
  it('takes mode and area from the adapter and runs nothing', () => {
    const t = setup();
    const card = t.add('card-1', 'pizza-real');
    expect(card).toMatchObject({ status: 'pending', mode: 'real', area: 'food', adapter: 'pizza-real', payloadHash: payloadHash({ item: 'pizza', size: 'small' }) });
    expect(t.spy.calls).toHaveLength(0);
  });

  it('refuses an unknown adapter, a bad payload, a past expiry and a duplicate id', () => {
    const t = setup();
    const base = { id: 'c1', adapter: 'pizza-sim', payload: { item: 'pizza' }, expiresAt: new Date(NOW + HOUR).toISOString(), whyId: 'w' };
    expect(prepareCard(t.state, { ...base, adapter: 'nope' }, t.adapters, NOW)).toMatchObject({ ok: false, code: 'no_adapter' });
    expect(prepareCard(t.state, { ...base, adapter: 'constructor' }, t.adapters, NOW)).toMatchObject({ ok: false, code: 'no_adapter' });
    expect(prepareCard(t.state, { ...base, payload: {} }, t.adapters, NOW)).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(prepareCard(t.state, { ...base, expiresAt: new Date(NOW).toISOString() }, t.adapters, NOW)).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(prepareCard(t.state, { ...base, id: 'Bad Id' }, t.adapters, NOW)).toMatchObject({ ok: false, code: 'invalid_payload' });
    t.add('c1', 'pizza-sim');
    expect(prepareCard(t.state, base, t.adapters, NOW)).toMatchObject({ ok: false, code: 'invalid_payload' });
  });
});

describe('issueConfirmation', () => {
  it('is for parents only, pending cards only, and never outlives the card', () => {
    const t = setup();
    t.add('c1', 'pizza-real', undefined, 5 * 60 * 1000);
    expect(issueConfirmation(t.state, 'c1', 'maya', { key: KEY, now: NOW }, t.adapters)).toMatchObject({ ok: false, code: 'not_parent' });
    expect(issueConfirmation(t.state, 'c1', 'noa', { key: KEY, now: NOW }, t.adapters)).toMatchObject({ ok: false, code: 'not_parent' });
    expect(issueConfirmation(t.state, 'nope', 'mom', { key: KEY, now: NOW }, t.adapters)).toMatchObject({ ok: false, code: 'not_found' });
    const issued = issueConfirmation(t.state, 'c1', 'mom', { key: KEY, now: NOW }, t.adapters);
    expect(issued.ok && issued.expiresAt).toBe(new Date(NOW + 5 * 60 * 1000).toISOString());
    t.add('c2', 'pizza-real', undefined, 3 * HOUR);
    const long = issueConfirmation(t.state, 'c2', 'dad', { key: KEY, now: NOW }, t.adapters);
    expect(long.ok && long.expiresAt).toBe(new Date(NOW + CONFIRMATION_TTL_MS).toISOString());
    expect(issueConfirmation(t.state, 'c1', 'mom', { key: KEY, now: NOW + HOUR }, t.adapters)).toMatchObject({ ok: false, code: 'expired' });
  });
});

describe('executeAction: a parent tap', () => {
  it('runs a real adapter with a valid token, once, and logs it', async () => {
    const t = setup();
    t.add('c1', 'pizza-real');
    const result = await t.run('c1', { kind: 'tap', memberId: 'mom', token: t.token('c1') });
    expect(result).toMatchObject({ ok: true, card: { status: 'executed', executedBy: 'mom', result: { orderId: 'o-1' } } });
    expect(t.spy.calls).toEqual([{ item: 'pizza', size: 'small' }]);
    const log = t.state.activity.at(-1);
    expect(log).toMatchObject({ kind: 'action', ref: 'c1', note: 'executed', actor: 'mom', whyId: 'why-c1' });
    expect(log?.undo).toBeUndefined();
  });

  it('refuses without a token', async () => {
    const t = setup();
    t.add('c1', 'pizza-real');
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom' })).toMatchObject({ ok: false, code: 'no_token' });
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token: '' })).toMatchObject({ ok: false, code: 'no_token' });
    expect(t.spy.calls).toHaveLength(0);
    expect(t.card('c1').status).toBe('pending');
  });

  it('refuses a reused token, even after a failed run', async () => {
    const t = setup();
    t.add('c1', 'pizza-real');
    const token = t.token('c1');
    expect((await t.run('c1', { kind: 'tap', memberId: 'mom', token })).ok).toBe(true);
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token })).toMatchObject({ ok: false, code: 'token_used' });
    expect(t.spy.calls).toHaveLength(1);

    // A failed run spends the token too: the card is failed, and the old token stays used.
    const failing = setup({ adapters: { flaky: adapter('flaky', 'real', { execute: async () => ({ ok: false, error: 'Vendor said no' }) }) } });
    failing.add('c2', 'flaky');
    const once = failing.token('c2');
    expect(await failing.run('c2', { kind: 'tap', memberId: 'mom', token: once })).toMatchObject({ ok: false, code: 'action_failed', card: { status: 'failed', error: 'Vendor said no' } });
    expect(await failing.run('c2', { kind: 'tap', memberId: 'mom', token: once })).toMatchObject({ ok: false, code: 'token_used' });
  });

  it('refuses a second tap while the adapter is still running', async () => {
    let release: () => void = () => undefined;
    const t = setup({ adapters: { slow: adapter('slow', 'real', { execute: () => new Promise(resolve => { release = () => resolve({ ok: true }); }) }) } });
    t.add('c1', 'slow');
    const first = t.run('c1', { kind: 'tap', memberId: 'mom', token: t.token('c1') });
    await Promise.resolve();
    expect(t.card('c1').status).toBe('executing');
    // A fresh token can't even be issued, and Dad's earlier token is refused.
    const dadToken = issueConfirmation({ ...t.state, actionCards: t.state.actionCards.map(c => ({ ...c, status: 'pending' as const })) }, 'c1', 'dad', { key: KEY, now: NOW }, t.adapters);
    expect(dadToken.ok).toBe(true);
    expect(await t.run('c1', { kind: 'tap', memberId: 'dad', token: dadToken.ok ? dadToken.token : '' })).toMatchObject({ ok: false, code: 'not_pending' });
    release();
    expect((await first).ok).toBe(true);
  });

  it('refuses an expired card and marks it expired', async () => {
    const t = setup();
    t.add('c1', 'pizza-real', undefined, 10 * 60 * 1000);
    const token = t.token('c1');
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token }, NOW + 11 * 60 * 1000)).toMatchObject({ ok: false, code: 'expired', card: { status: 'expired' } });
    expect(t.state.activity.at(-1)).toMatchObject({ kind: 'action', ref: 'c1', note: 'expired', actor: 'homemind' });
    expect(t.spy.calls).toHaveLength(0);
  });

  it('refuses an expired token on a card that is still open', async () => {
    const t = setup();
    t.add('c1', 'pizza-real', undefined, 2 * HOUR);
    const token = t.token('c1');
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token }, NOW + CONFIRMATION_TTL_MS + 1)).toMatchObject({ ok: false, code: 'token_expired' });
    expect(t.card('c1').status).toBe('pending');
  });

  it('refuses when the payload changed after the token was made', async () => {
    const t = setup();
    t.add('c1', 'pizza-real');
    const token = t.token('c1');
    // Re-prepared with a bigger order: hash and payload changed together. The old token saw the small one.
    t.state = { ...t.state, actionCards: t.state.actionCards.map(c => (c.id === 'c1' ? { ...c, payload: { item: 'pizza', size: 'large' }, payloadHash: payloadHash({ item: 'pizza', size: 'large' }) } : c)) };
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token })).toMatchObject({ ok: false, code: 'payload_changed' });
    // Payload edited in place, hash left alone.
    t.add('c2', 'pizza-real');
    const token2 = t.token('c2');
    t.state = { ...t.state, actionCards: t.state.actionCards.map(c => (c.id === 'c2' ? { ...c, payload: { item: 'pizza', size: 'large' } } : c)) };
    expect(await t.run('c2', { kind: 'tap', memberId: 'mom', token: token2 })).toMatchObject({ ok: false, code: 'payload_changed' });
    expect(t.spy.calls).toHaveLength(0);
  });

  it('refuses a member who is not a parent, even with a parent token', async () => {
    const t = setup();
    t.add('c1', 'pizza-real');
    const momToken = t.token('c1', 'mom');
    expect(await t.run('c1', { kind: 'tap', memberId: 'maya', token: momToken })).toMatchObject({ ok: false, code: 'not_parent' });
    expect(await t.run('c1', { kind: 'tap', memberId: 'noa', token: momToken })).toMatchObject({ ok: false, code: 'not_parent' });
    expect(await t.run('c1', { kind: 'tap', memberId: 'dad', token: momToken })).toMatchObject({ ok: false, code: 'wrong_member' });
    expect(t.spy.calls).toHaveLength(0);
  });

  it('refuses a forged token, and a token for another card', async () => {
    const t = setup();
    t.add('c1', 'pizza-real');
    t.add('c2', 'pizza-real');
    const token = t.token('c1');
    const [body] = token.split('.');
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token: `${body}.AAAA` })).toMatchObject({ ok: false, code: 'bad_token' });
    const otherKey = issueConfirmation(t.state, 'c1', 'mom', { key: 'some-other-key-012345', now: NOW }, t.adapters);
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token: otherKey.ok ? otherKey.token : '' })).toMatchObject({ ok: false, code: 'bad_token' });
    expect(await t.run('c2', { kind: 'tap', memberId: 'mom', token })).toMatchObject({ ok: false, code: 'wrong_card' });
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token: 'x'.repeat(5000) })).toMatchObject({ ok: false, code: 'bad_token' });
  });

  it('a timed-out or throwing adapter fails the card, it never counts as done', async () => {
    const t = setup({ adapters: { boom: adapter('boom', 'simulated', { execute: async () => { throw new Error('secret detail'); } }) } });
    t.add('c1', 'boom');
    const result = await t.run('c1', { kind: 'tap', memberId: 'dad', token: t.token('c1', 'dad') });
    expect(result).toMatchObject({ ok: false, code: 'action_failed', card: { status: 'failed', error: 'The service failed' } });
    expect(t.state.activity.at(-1)).toMatchObject({ note: 'failed', actor: 'dad' });

    const hang = setup({ adapters: { hang: adapter('hang', 'simulated', { execute: (_p, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))) }) } });
    hang.add('c1', 'hang');
    const timed = await executeAction(hang.ref, 'c1', { kind: 'tap', memberId: 'mom', token: hang.token('c1') }, { adapters: hang.adapters, key: KEY, now: () => NOW, timeoutMs: 20 });
    expect(timed).toMatchObject({ ok: false, code: 'action_failed', card: { status: 'failed', error: 'The service did not answer in time' } });
  });
});

describe('executeAction: autonomy level 4', () => {
  it('refuses a real adapter at level 4, even when it says auto is allowed', async () => {
    const t = setup({ level: 4 });
    t.add('c1', 'pizza-real');
    expect(await t.run('c1', { kind: 'auto' })).toMatchObject({ ok: false, code: 'auto_not_allowed', reason: 'real_adapter' });
    expect(t.spy.calls).toHaveLength(0);
  });

  it('treats a card that claims simulated as real when its adapter is real', () => {
    const t = setup({ level: 4 });
    t.add('c1', 'pizza-real');
    t.state = { ...t.state, actionCards: t.state.actionCards.map(c => ({ ...c, mode: 'simulated' as const })) };
    expect(authorize(t.state, 'c1', { kind: 'auto' }, t.adapters, { key: KEY, now: NOW })).toMatchObject({ ok: false, reason: 'real_adapter' });
  });

  it('runs a simulated adapter that allows it, only at level 4 and not paused', async () => {
    const low = setup({ level: 3 });
    low.add('c1', 'pizza-sim');
    expect(await low.run('c1', { kind: 'auto' })).toMatchObject({ ok: false, code: 'auto_not_allowed', reason: 'level' });

    const paused = setup({ level: 4, paused: true });
    paused.add('c1', 'pizza-sim');
    expect(await paused.run('c1', { kind: 'auto' })).toMatchObject({ ok: false, code: 'auto_not_allowed', reason: 'paused' });

    const notAllowed = setup({ level: 4 });
    notAllowed.add('c1', 'sitter-sim');
    expect(await notAllowed.run('c1', { kind: 'auto' })).toMatchObject({ ok: false, code: 'auto_not_allowed', reason: 'not_allowed' });

    const ok = setup({ level: 4 });
    ok.add('c1', 'pizza-sim');
    expect(await ok.run('c1', { kind: 'auto' })).toMatchObject({ ok: true, card: { status: 'executed', executedBy: 'homemind' } });
    expect(ok.state.activity.at(-1)).toMatchObject({ actor: 'homemind', note: 'executed' });
  });

  it('uses the area override over the default level', async () => {
    const t = setup({ level: 4 });
    t.state = { ...t.state, family: { ...t.state.family, autonomy: { default: 4, byArea: { food: 2 } } } };
    expect(autonomyLevelFor(t.state.family, 'food')).toBe(2);
    expect(autonomyLevelFor(t.state.family, 'other')).toBe(4);
    t.add('c1', 'pizza-sim');
    expect(await t.run('c1', { kind: 'auto' })).toMatchObject({ ok: false, reason: 'level' });
  });
});

describe('cancel and expire', () => {
  it('a parent cancels a pending card; its token is worthless afterwards', async () => {
    const t = setup();
    t.add('c1', 'pizza-real');
    const token = t.token('c1');
    expect(cancelCard(t.state, 'c1', 'maya', NOW)).toMatchObject({ ok: false, code: 'not_parent' });
    const cancelled = cancelCard(t.state, 'c1', 'dad', NOW);
    expect(cancelled).toMatchObject({ ok: true, card: { status: 'cancelled' }, activity: { note: 'cancelled', actor: 'dad' } });
    if (cancelled.ok) t.state = cancelled.state;
    expect(await t.run('c1', { kind: 'tap', memberId: 'mom', token })).toMatchObject({ ok: false, code: 'not_pending' });
    expect(cancelCard(t.state, 'c1', 'mom', NOW)).toMatchObject({ ok: false, code: 'not_pending' });
  });

  it('expireCards marks only pending cards past their time', () => {
    const t = setup();
    t.add('soon', 'pizza-sim', undefined, 10 * 60 * 1000);
    t.add('later', 'pizza-sim', undefined, 2 * HOUR);
    const none = expireCards(t.state, NOW);
    expect(none.expired).toHaveLength(0);
    expect(none.state).toBe(t.state);
    const some = expireCards(t.state, NOW + HOUR);
    expect(some.expired.map(c => c.id)).toEqual(['soon']);
    expect(some.state.actionCards.find(c => c.id === 'later')?.status).toBe('pending');
    expect(some.state.activity.at(-1)).toMatchObject({ kind: 'action', ref: 'soon', note: 'expired' });
    expect(expireCards(some.state, NOW + HOUR).expired).toHaveLength(0);
  });
});
