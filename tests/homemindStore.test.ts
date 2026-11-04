import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../server/homemind/clock';
import { seedState } from '../server/homemind/seed';
import { DEFAULT_DATA_FILE, HomemindStore, dataFileFromEnv, isHomemindState, writeJsonAtomic } from '../server/homemind/store';
import type { HomemindState } from '../server/homemind/types';

const NOW = Date.UTC(2026, 10, 4, 2, 0);
let dir = '';
let file = '';
let seeds = 0;

function makeStore(): HomemindStore {
  return new HomemindStore({
    file,
    seed: () => {
      seeds++;
      return seedState({ now: NOW });
    },
    now: () => NOW
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'homemind-store-'));
  file = join(dir, 'nested', 'state.json');
  seeds = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('HomemindStore', () => {
  it('seeds and writes the file on first load, creating the folder', async () => {
    const { state, source } = await makeStore().load();
    expect(source).toBe('seed');
    expect(seeds).toBe(1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state);
  });

  it('saves and loads back the same state', async () => {
    const store = makeStore();
    const { state } = await store.load();
    state.items[0].title = 'Changed';
    state.clockOffsetMs = 90 * 60_000;
    await store.save(state);

    const again = await makeStore().load();
    expect(again.source).toBe('file');
    expect(again.state.items[0].title).toBe('Changed');
    expect(again.state.clockOffsetMs).toBe(90 * 60_000);
    expect(seeds).toBe(1);
  });

  it('saves a snapshot, so later changes to the object are not written', async () => {
    const store = makeStore();
    const { state } = await store.load();
    const pending = store.save(state);
    state.items[0].title = 'After save was called';
    await pending;
    expect((await makeStore().load()).state.items[0].title).not.toBe('After save was called');
  });

  it('runs saves in order, so the last one wins, and leaves no temp files', async () => {
    const store = makeStore();
    const { state } = await store.load();
    const saves = Array.from({ length: 20 }, (_, i) => {
      const next: HomemindState = { ...state, clockOffsetMs: i };
      return store.save(next);
    });
    await Promise.all(saves);
    expect((await makeStore().load()).state.clockOffsetMs).toBe(19);
    expect(await readdir(join(dir, 'nested'))).toEqual(['state.json']);
  });

  it('reset replaces everything with a fresh seed, clock offset included', async () => {
    const store = makeStore();
    const { state } = await store.load();
    state.items = [];
    state.clockOffsetMs = 3_600_000;
    await store.save(state);

    const fresh = await store.reset();
    expect(fresh.items.length).toBeGreaterThan(0);
    expect(fresh.clockOffsetMs).toBe(0);
    expect((await makeStore().load()).state).toEqual(fresh);
  });

  it('moves an unreadable file aside instead of deleting it, and says so', async () => {
    await writeJsonAtomic(file, { not: 'homemind' });
    await writeFile(file, '{ broken json', 'utf8');
    const result = await makeStore().load();
    expect(result.source).toBe('recovered');
    expect(result.movedTo).toBe(`${file}.unreadable-${NOW}`);
    expect(await readFile(result.movedTo!, 'utf8')).toBe('{ broken json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(result.state);
  });

  it('treats a file from another schema version as unreadable', async () => {
    await writeJsonAtomic(file, { ...seedState({ now: NOW }), schemaVersion: 99 });
    expect((await makeStore().load()).source).toBe('recovered');
  });
});

describe('store helpers', () => {
  it('isHomemindState accepts a seed and rejects partial or bad state', () => {
    const good = seedState({ now: NOW });
    expect(isHomemindState(good)).toBe(true);
    expect(isHomemindState(null)).toBe(false);
    expect(isHomemindState({ ...good, items: undefined })).toBe(false);
    expect(isHomemindState({ ...good, clockOffsetMs: -1 })).toBe(false);
    expect(isHomemindState({ ...good, family: { ...good.family, members: 'x' } })).toBe(false);
  });

  it('reads the data file from the environment', () => {
    expect(dataFileFromEnv({})).toBe(DEFAULT_DATA_FILE);
    expect(dataFileFromEnv({ HOMEMIND_DATA_FILE: '  ' })).toBe(DEFAULT_DATA_FILE);
    expect(dataFileFromEnv({ HOMEMIND_DATA_FILE: 'x/y.json' })).toBe('x/y.json');
  });

  it('a demo clock built from loaded state keeps the jumped time', async () => {
    const store = makeStore();
    const { state } = await store.load();
    const clock = fixedClock(NOW, state.clockOffsetMs);
    state.clockOffsetMs = clock.advance(45 * 60_000);
    await store.save(state);

    const reloaded = (await makeStore().load()).state;
    expect(fixedClock(NOW, reloaded.clockOffsetMs).now()).toBe(NOW + 45 * 60_000);
  });
});
