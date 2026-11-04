import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Keeps the Homemind core movable to a separate server (CLAUDE.md, "Code style"):
//   - nothing in server/homemind/ imports from src/, server/orbit.ts, server/fridge.ts or Vite,
//   - src/ imports from server/homemind/ only with `import type` / `export type`.

const ROOT = resolve(__dirname, '..');
const CORE_DIR = join(ROOT, 'server', 'homemind');
const SRC_DIR = join(ROOT, 'src');

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

/** Static imports, re-exports, bare imports, dynamic import() and require(). */
export function importsOf(source: string): ImportRef[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const refs: ImportRef[] = [];
  const fromRe = /\b(import|export)\s+(type\s+)?[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(fromRe)) refs.push({ specifier: m[3], typeOnly: !!m[2] });
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) refs.push({ specifier: m[1], typeOnly: false });
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) refs.push({ specifier: m[1], typeOnly: false });
  return refs;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

function resolvesInto(file: string, specifier: string, target: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const abs = resolve(dirname(file), specifier);
  return abs === target || abs.startsWith(target + sep);
}

function resolvesToModule(file: string, specifier: string, modulePath: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const abs = resolve(dirname(file), specifier).replace(/\.(ts|js)$/, '');
  return abs === modulePath;
}

export function coreViolations(file: string, source: string): string[] {
  const bad: string[] = [];
  for (const { specifier } of importsOf(source)) {
    if (
      resolvesInto(file, specifier, SRC_DIR) ||
      resolvesToModule(file, specifier, join(ROOT, 'server', 'orbit')) ||
      resolvesToModule(file, specifier, join(ROOT, 'server', 'fridge')) ||
      /^(vite|@vitejs\/|vite\/|vitest)/.test(specifier) ||
      /^(react|react-dom)(\/|$)/.test(specifier)
    ) {
      bad.push(specifier);
    }
  }
  return bad;
}

export function clientViolations(file: string, source: string): string[] {
  return importsOf(source)
    .filter(ref => !ref.typeOnly && resolvesInto(file, ref.specifier, CORE_DIR))
    .map(ref => ref.specifier);
}

describe('Homemind boundary', () => {
  it('finds the core files', () => {
    const files = filesUnder(CORE_DIR).map(f => relative(ROOT, f).split(sep).join('/'));
    expect(files).toEqual(expect.arrayContaining(['server/homemind/types.ts', 'server/homemind/store.ts']));
  });

  it('server/homemind/ imports nothing from src/, orbit, fridge, Vite or React', () => {
    const problems = filesUnder(CORE_DIR).flatMap(file =>
      coreViolations(file, readFileSync(file, 'utf8')).map(spec => `${relative(ROOT, file)}: ${spec}`)
    );
    expect(problems).toEqual([]);
  });

  it('types.ts has no imports at all, so the client can use it anywhere', () => {
    expect(importsOf(readFileSync(join(CORE_DIR, 'types.ts'), 'utf8'))).toEqual([]);
  });

  it('src/ imports from server/homemind/ only as types', () => {
    const problems = filesUnder(SRC_DIR).flatMap(file =>
      clientViolations(file, readFileSync(file, 'utf8')).map(spec => `${relative(ROOT, file)}: ${spec}`)
    );
    expect(problems).toEqual([]);
  });

  describe('the scanner itself', () => {
    const coreFile = join(CORE_DIR, 'core.ts');
    const clientFile = join(SRC_DIR, 'lib', 'homemindSurfaces.ts');

    it('catches each forbidden import in the core', () => {
      const source = [
        "import { tr } from '../../src/i18n';",
        "import type { A2uiAction } from '../../src/types';",
        "export { isSameOrigin } from '../orbit';",
        "import { handleFridgeRequest } from '../fridge.ts';",
        "import type { Plugin } from 'vite';",
        "import React from 'react';",
        "const m = await import('../../src/lib/x');",
        "import '../../src/styles.css';"
      ].join('\n');
      expect(coreViolations(coreFile, source)).toEqual([
        '../../src/i18n',
        '../../src/types',
        '../orbit',
        '../fridge.ts',
        'vite',
        'react',
        '../../src/styles.css',
        '../../src/lib/x'
      ]);
    });

    it('allows node built-ins and sibling core files', () => {
      const source = "import { readFile } from 'node:fs/promises';\nimport { toIso } from './clock';\nimport type { Item } from './types';";
      expect(coreViolations(coreFile, source)).toEqual([]);
    });

    it('ignores imports in comments', () => {
      expect(coreViolations(coreFile, "// import { x } from '../../src/a';\n/* import '../orbit'; */")).toEqual([]);
    });

    it('allows type imports from the client and catches value imports', () => {
      const source = [
        "import type { Item } from '../../server/homemind/types';",
        "export type { Member } from '../../server/homemind/types';",
        "import { ID_PATTERN } from '../../server/homemind/types';",
        "import {\n  seedState\n} from '../../server/homemind/seed';"
      ].join('\n');
      expect(clientViolations(clientFile, source)).toEqual(['../../server/homemind/types', '../../server/homemind/seed']);
    });
  });
});
