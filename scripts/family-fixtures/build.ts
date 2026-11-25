/**
 * Turns the cases into fixture files. For every case it:
 *   1. builds the log (seq, opId, at, server-attested member and device) from the steps;
 *   2. replays it on a parent device (both scopes) and checks every outcome is what the case expects;
 *   3. replays it again and checks the state hash is the same (no hidden clock or random input);
 *   4. replays only the family entries on a teen device (family scope only) and checks it reaches the
 *      identical family partition, with the same outcomes for the family entries (D11).
 * Any difference throws, so a written fixture is always one the TS core passes.
 */
import { zonedToUtc } from '../../server/homemind/clock';
import { seedState } from '../../server/homemind/seed';
import { ID_PATTERN } from '../../server/homemind/types';
import { replay, SCOPES, toV1State } from './adapter';
import type { LogEntry, Outcome, Replay, V1State } from './adapter';
import { CASES, MIN_CASES, REQUIRED_COVERAGE } from './cases';
import type { CaseDef, Member } from './cases';
import { canonicalJson, hashOf } from './canonical';

export const SEED_FILE = 'seed.state.json';
export const TIMEZONE = 'Asia/Jerusalem';
/** The demo clock of the seed: Wednesday 2026-11-11 14:30 in Jerusalem (12:30 UTC). */
export const SEED_NOW = zonedToUtc('2026-11-11', '14:30', TIMEZONE);
const MINUTE = 60_000;

/** Server-attested devices: one per member with an account (Noa's is there only to show the core refuses her). */
const DEVICE: Record<Member, string> = { mom: 'mom-phone', dad: 'dad-laptop', maya: 'maya-phone', noa: 'noa-tablet' };

export function seedV1(): V1State {
  return toV1State(seedState({ now: SEED_NOW, timezone: TIMEZONE }));
}

export function buildLog(def: CaseDef): LogEntry[] {
  const opIds: string[] = [];
  return def.steps.map((step, n) => {
    const seq = n + 1;
    const opId = step.sameOpIdAs ? opIds[step.sameOpIdAs - 1] : `op${seq}-${def.name}`;
    if (!opId || !ID_PATTERN.test(opId)) throw new Error(`${def.name}: bad op id ${opId}`);
    opIds.push(opId);
    const { targetStep, kind, ...fields } = step.op as { targetStep?: number; kind: string };
    const op: LogEntry['op'] = { v: step.v ?? 1, kind, opId, at: new Date(SEED_NOW + seq * MINUTE).toISOString(), ...fields };
    if (targetStep !== undefined) {
      if (targetStep >= seq) throw new Error(`${def.name}: step ${seq} undoes a later step`);
      op.targetOpId = opIds[targetStep - 1];
    }
    return { seq, scope: step.scope ?? 'family', memberId: step.by, fromDevice: DEVICE[step.by], op };
  });
}

export interface FixtureCase {
  name: string;
  covers: string[];
  description: string;
  log: LogEntry[];
  results: Outcome[];
  stoppedAt?: number;
  after: V1State;
  hashes: { state: string; family: string; parents: string };
}

const outcomeText = (o: Outcome | undefined) => (!o ? 'stop' : o.outcome === 'applied' ? 'applied' : o.code);

export function runCase(seed: V1State, def: CaseDef): FixtureCase {
  const log = buildLog(def);
  const parent = replay(seed, log, SCOPES);

  def.steps.forEach((step, n) => {
    const seq = n + 1;
    const got = parent.stoppedAt !== undefined && seq >= parent.stoppedAt ? 'stop' : outcomeText(parent.results.find(r => r.seq === seq));
    if (got !== step.expect) throw new Error(`${def.name}: seq ${seq} (${step.op.kind}) expected ${step.expect}, the core gave ${got}`);
  });

  const again = replay(seed, log, SCOPES);
  if (hashOf(again.state) !== hashOf(parent.state)) throw new Error(`${def.name}: two replays of the same log differ`);

  const teen: Replay = replay(seed, log, ['family']);
  const family = hashOf(parent.state.scopes.family);
  if (hashOf(teen.state.scopes.family) !== family) {
    throw new Error(`${def.name}: a family-only device reaches a different family partition`);
  }
  const familySeqs = new Set(log.filter(e => e.scope === 'family').map(e => e.seq));
  if (canonicalJson(teen.results) !== canonicalJson(parent.results.filter(r => familySeqs.has(r.seq)))) {
    throw new Error(`${def.name}: a family-only device gives different outcomes`);
  }

  const out: FixtureCase = {
    name: def.name,
    covers: def.covers,
    description: def.description,
    log,
    results: parent.results,
    after: parent.state,
    hashes: { state: hashOf(parent.state), family, parents: hashOf(parent.state.scopes.parents) }
  };
  if (parent.stoppedAt !== undefined) out.stoppedAt = parent.stoppedAt;
  return out;
}

export interface FixtureFile {
  description: string;
  generator: string;
  seed: string;
  hash: string;
  cases: FixtureCase[];
}

const HASH_RULE =
  'Lowercase hex SHA-256 of the UTF-8 canonical JSON: object keys sorted, no whitespace, strings escaped as JSON.stringify does, integers in decimal (RFC 8785 for these types). `state` hashes the whole state, `family` and `parents` the scope partitions (`scopes.family`, `scopes.parents`).';

/** Every fixture file, by file name. Throws if a case fails or the coverage is short. */
export function buildFixtures(): { seed: V1State; files: Map<string, FixtureFile> } {
  const seed = seedV1();
  if (CASES.length < MIN_CASES) throw new Error(`only ${CASES.length} cases, at least ${MIN_CASES} are needed`);
  const names = new Set<string>();
  for (const def of CASES) {
    if (names.has(def.name)) throw new Error(`two cases are named ${def.name}`);
    names.add(def.name);
  }
  const covered = new Set(CASES.flatMap(c => c.covers));
  const missing = REQUIRED_COVERAGE.filter(c => !covered.has(c));
  if (missing.length) throw new Error(`no case covers ${missing.join(', ')}`);

  const files = new Map<string, FixtureFile>();
  for (const def of CASES) {
    const file = `board-${def.group}.json`;
    if (!files.has(file)) {
      files.set(file, {
        description: `Family board fixtures, group "${def.group}". Each case starts from ${SEED_FILE}, replays \`log\` in seq order through the board reducer on a parent device (both scopes), and must end with \`results\` (one per applied or rejected entry; none from \`stoppedAt\` on) and \`after\`. A family-only device replaying the family entries reaches the same \`hashes.family\`. Generated; do not edit by hand.`,
        generator: 'scripts/family-fixtures (ChayaLevi/digitalmate-web, branch feat/family-fixtures), running Homemind core.ts applyChange',
        seed: SEED_FILE,
        hash: HASH_RULE,
        cases: []
      });
    }
    files.get(file)!.cases.push(runCase(seed, def));
  }
  return { seed, files };
}
