/**
 * JSON persistence for Homemind state.
 *
 * One file (`HOMEMIND_DATA_FILE`, default `.homemind/state.json`). Writes go to a temp file beside it
 * and are renamed into place, so a crash never leaves half a file. Saves are serialized, so the
 * last save wins. A file that can't be read as Homemind state is moved aside (never deleted) and the
 * seed is used, and `load()` says so. No networking.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STATE_SCHEMA_VERSION } from './types';
import type { HomemindState } from './types';

export const DEFAULT_DATA_FILE = '.homemind/state.json';

export function dataFileFromEnv(env: Record<string, string | undefined>): string {
  return env.HOMEMIND_DATA_FILE?.trim() || DEFAULT_DATA_FILE;
}

/** Structural check, enough to refuse a file from another schema or another app. */
export function isHomemindState(value: unknown): value is HomemindState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const family = v.family as Record<string, unknown> | undefined;
  return (
    v.schemaVersion === STATE_SCHEMA_VERSION &&
    !!family &&
    typeof family === 'object' &&
    Array.isArray(family.members) &&
    typeof family.timezone === 'string' &&
    ['items', 'reminders', 'preferences', 'rules', 'actionCards', 'activity', 'whys'].every(k => Array.isArray(v[k])) &&
    typeof v.clockOffsetMs === 'number' &&
    Number.isFinite(v.clockOffsetMs) &&
    v.clockOffsetMs >= 0
  );
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Windows can refuse a rename for a moment while another process (an editor, antivirus) has the file open. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      await sleep(20 * (attempt + 1));
    }
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export type LoadSource = 'file' | 'seed' | 'recovered';

export interface LoadResult {
  state: HomemindState;
  /** `seed`: there was no file. `recovered`: the file was unreadable, moved to `movedTo`, and the seed used. */
  source: LoadSource;
  movedTo?: string;
}

export interface StoreOptions {
  file: string;
  /** Builds fresh demo state. Called on first start and on reset. */
  seed: () => HomemindState;
  /** Real time, for naming a moved-aside file. Injected for tests. */
  now?: () => number;
}

export class HomemindStore {
  readonly file: string;
  private readonly seed: () => HomemindState;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: StoreOptions) {
    this.file = options.file;
    this.seed = options.seed;
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<LoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state = this.seed();
      await this.save(state);
      return { state, source: 'seed' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (isHomemindState(parsed)) return { state: parsed, source: 'file' };
    const movedTo = `${this.file}.unreadable-${this.now()}`;
    await renameWithRetry(this.file, movedTo);
    const state = this.seed();
    await this.save(state);
    return { state, source: 'recovered', movedTo };
  }

  /** Saves a snapshot. Calls run one after another, in call order. */
  save(state: HomemindState): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(state)) as HomemindState;
    const run = this.queue.then(() => writeJsonAtomic(this.file, snapshot));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Replaces the state with a fresh seed (the demo clock offset goes back to 0) and saves it. */
  async reset(): Promise<HomemindState> {
    const state = this.seed();
    await this.save(state);
    return state;
  }
}
