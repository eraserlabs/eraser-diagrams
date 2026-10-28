import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package boundary: layout runs on its own, so its sources may import only
 * `@eraserlabs/utils` besides each other, and routing never reaches editing code.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = join(SRC, '..', 'package.json');

const IMPORT =
  /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
const isTest = (file: string) =>
  file.includes('__tests__') || /\.(spec|test)\.ts$/.test(file) || file.endsWith('TestUtils.ts');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

function specifiers(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT)].map(
    (match) => (match[1] ?? match[2] ?? match[3])!,
  );
}

const runtimeSources = sources(SRC).filter((file) => !isTest(file));

describe('layout package dependencies', () => {
  it('imports no package except @eraserlabs/utils', () => {
    const bare = runtimeSources.flatMap((file) =>
      specifiers(file)
        .filter((spec) => !spec.startsWith('.') && spec !== '@eraserlabs/utils')
        .map((spec) => `${relative(SRC, file)}: ${spec}`),
    );
    expect(bare).toEqual([]);
  });

  it('declares exactly one runtime dependency, @eraserlabs/utils', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@eraserlabs/utils']);
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('keeps routing free of editing code', () => {
    const editing = [
      'calculateChanges.ts',
      'bumpUtils.ts',
      'moveUtils.ts',
      'newPosition.ts',
      'mergeOps.ts',
      'sortOps.ts',
      'modifyUtils.ts',
      'parentageUtils.ts',
      'overlaps.ts',
    ].map((file) => join(SRC, file));
    const reached = new Set<string>();
    const queue = runtimeSources.filter((file) => relative(SRC, file).startsWith('routing'));
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (reached.has(file)) {
        continue;
      }
      reached.add(file);
      for (const spec of specifiers(file)) {
        if (spec.startsWith('.')) {
          queue.push(normalize(join(dirname(file), spec.replace(/\.js$/, '.ts'))));
        }
      }
    }
    const leaks = [...reached]
      .filter((file) => editing.includes(file) || relative(SRC, file).startsWith('structure'))
      .map((file) => relative(SRC, file));
    expect(leaks).toEqual([]);
  });
});
