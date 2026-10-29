import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * layout runs on its own, so it declares one runtime dependency. Which modules may import what is
 * checked by depcruise (`layout-*` rules in .dependency-cruiser.cjs).
 */
const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

describe('layout package dependencies', () => {
  it('declares exactly one runtime dependency, @eraserlabs/utils', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@eraserlabs/utils']);
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });
});
