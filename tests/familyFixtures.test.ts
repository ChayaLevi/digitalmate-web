import { describe, expect, it } from 'vitest';
import { applyEntry, replay, SCOPES, viewOf } from '../scripts/family-fixtures/adapter';
import type { LogEntry } from '../scripts/family-fixtures/adapter';
import { buildFixtures, seedV1 } from '../scripts/family-fixtures/build';
import { CASES, MIN_CASES, REQUIRED_COVERAGE } from '../scripts/family-fixtures/cases';
import { canonicalJson, hashOf } from '../scripts/family-fixtures/canonical';

const entry = (seq: number, op: Record<string, unknown>, extra: Partial<LogEntry> = {}): LogEntry => ({
  seq,
  scope: 'family',
  memberId: 'mom',
  fromDevice: 'mom-phone',
  op: { v: 1, opId: `op-${seq}`, at: '2026-11-11T12:31:00.000Z', ...op } as LogEntry['op'],
  ...extra
});

describe('family board fixtures (HOPA S.2)', () => {
  it('every case runs through the core with the outcomes it expects, on parent and teen devices alike', () => {
    const { files } = buildFixtures();
    const cases = [...files.values()].flatMap(f => f.cases);
    expect(cases.length).toBe(CASES.length);
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES);
    const covered = new Set(cases.flatMap(c => c.covers));
    for (const need of REQUIRED_COVERAGE) expect(covered, need).toContain(need);
  });

  it('is deterministic: building twice gives byte-identical files', () => {
    const a = buildFixtures();
    const b = buildFixtures();
    expect(canonicalJson([...a.files])).toBe(canonicalJson([...b.files]));
  });

  it('hashes canonical JSON: sorted keys, no whitespace, JSON.stringify escapes, raw UTF-8', () => {
    expect(canonicalJson({ b: 1, a: ['é\n', null, true], c: undefined })).toBe('{"a":["é\\n",null,true],"b":1}');
    expect(hashOf({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('takes the activity id from opId, the time from at, the actor from the log entry (D10, D12)', () => {
    const step = applyEntry(seedV1(), entry(1, { kind: 'claim', itemId: 'library-books', version: 1 }, { memberId: 'maya' }));
    if (step.kind !== 'applied') throw new Error(step.kind);
    const activity = step.state.scopes.family.activity.at(-1)!;
    expect(activity).toMatchObject({ id: 'op-1', at: '2026-11-11T12:31:00.000Z', actor: 'maya', kind: 'claim' });
  });

  it('refuses a create without an item id instead of minting one (D10)', () => {
    const step = applyEntry(seedV1(), entry(1, { kind: 'create', item: { type: 'task', title: 'No id' } }));
    expect(step).toEqual({ kind: 'rejected', code: 'invalid' });
  });

  it('never lets a family op see a parents item, and a teen device never gets parents ops (D11)', () => {
    const seed = seedV1();
    const log = [
      entry(1, { kind: 'claim', itemId: 'counselor-meeting', version: 1 }, { memberId: 'dad' }),
      entry(2, { kind: 'assign', itemId: 'counselor-meeting', version: 1, ownerId: 'dad' }, { scope: 'parents', memberId: 'dad' })
    ];
    const parent = replay(seed, log, SCOPES);
    const teen = replay(seed, log, ['family']);
    expect(parent.results).toEqual([
      { seq: 1, outcome: 'rejected', code: 'not_found' },
      { seq: 2, outcome: 'applied' }
    ]);
    expect(teen.state.scopes.parents).toBeUndefined();
    expect(hashOf(teen.state.scopes.family)).toBe(hashOf(parent.state.scopes.family));
    expect(viewOf(seed, ['family']).scopes.parents).toBeUndefined();
  });
});
