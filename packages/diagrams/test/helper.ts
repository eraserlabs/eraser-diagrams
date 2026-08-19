import {
  createResolver,
  type ResolveResult,
  type Resolver,
  type ResolverSetup,
} from '@eraserlabs/resolve';
import type { ResolvedElement } from '@eraserlabs/protocol';
import { stubIconLoader } from './support/stubIcons.js';
import { stockLibrary, stockNormalizers } from '../src/index.js';

type TestSetup = Partial<Omit<ResolverSetup, 'library'>>;

export function buildTestResolver(extra: TestSetup = {}): Promise<Resolver> {
  return createResolver({
    library: stockLibrary,
    iconLoader: stubIconLoader,
    normalizers: stockNormalizers,
    ...extra,
  });
}

/**
 * The resolved document as one list, entities then connections — for assertions that care about
 * the whole payload rather than the kind split.
 */
export function allElements(result: ResolveResult): ResolvedElement[] {
  return [...(result.entities ?? []), ...(result.connections ?? [])];
}

export async function readFixture(name: string): Promise<unknown> {
  const url = new URL(`../../../fixtures/features/${name}.json`, import.meta.url);
  const { readFile } = await import('node:fs/promises');

  return JSON.parse(await readFile(url, 'utf8'));
}
