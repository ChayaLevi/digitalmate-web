/**
 * Family board fixture generator (HOPA family plan, task S.2).
 *
 *   npx tsx scripts/family-fixtures/generate.mts --out   <hopa>/spec/fixtures/family
 *   npx tsx scripts/family-fixtures/generate.mts --check <hopa>/spec/fixtures/family
 *
 * `--out` writes board-*.json and time-*.json (and checks seed.state.json there is Homemind's seed in the v1 shape).
 * `--check` regenerates in memory and fails if any file differs from what is on disk.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixtures, SEED_FILE } from './build';
import { canonicalJson } from './canonical';
import { buildTimeFixtures } from './time';

const [mode, dir] = process.argv.slice(2);
if ((mode !== '--out' && mode !== '--check') || !dir) {
  console.error('usage: generate.mts --out|--check <spec/fixtures/family>');
  process.exit(2);
}

const { seed, files: boardFiles } = buildFixtures();
const timeFiles = buildTimeFixtures();
const files = new Map<string, unknown>([...boardFiles, ...timeFiles]);
const problems: string[] = [];
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown;

const seedPath = join(dir, SEED_FILE);
if (!existsSync(seedPath)) problems.push(`${SEED_FILE} is missing`);
else if (canonicalJson(read(SEED_FILE)) !== canonicalJson(seed)) problems.push(`${SEED_FILE} is not Homemind's seed in the v1 shape`);

if (mode === '--out') {
  for (const [name, file] of files) writeFileSync(join(dir, name), text(file), 'utf8');
} else {
  for (const [name, file] of files) {
    if (!existsSync(join(dir, name))) problems.push(`${name} is missing`);
    else if (readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n') !== text(file)) problems.push(`${name} differs from the generator's output`);
  }
}
for (const name of readdirSync(dir)) {
  if (/^(board|time)-.*\.json$/.test(name) && !files.has(name)) problems.push(`${name} is not produced by the generator (stale file?)`);
}

const cases = [...boardFiles.values()].reduce((n, f) => n + f.cases.length, 0);
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(`ok ${cases} board cases and ${timeFiles.size} time files in ${files.size} files (${mode === '--out' ? 'written' : 'checked'})`);
