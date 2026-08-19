import { describe, it, expect, beforeAll } from 'vitest';
import type { Resolver } from '@eraserlabs/resolve';
import { allElements, buildTestResolver, readFixture } from './helper.js';

// Element counts pinned per fixture: a silently dropped element is exactly the regression this
// smoke suite exists to catch. (all-tags and connections retired as fixtures; their documents
// live inline in test/support/documents.ts.)
const RESOLVE_FIXTURES: Record<string, number> = {
  'minimal-shape': 1,
  'unicode-and-hostile-text': 1,
  'warnings-only': 1,
};

let resolver: Resolver;
beforeAll(async () => {
  resolver = await buildTestResolver();
});

describe('contract fixtures → element payload', () => {
  for (const [name, count] of Object.entries(RESOLVE_FIXTURES)) {
    it(`${name}: resolves to an escaped element payload`, async () => {
      const r = await resolver.resolve(await readFixture(name));
      expect(r.ok, JSON.stringify(r.errors)).toBe(true);
      expect(allElements(r)).toHaveLength(count);
      expect(r.icons).toBeDefined();
      // The core guarantee: content strings are pre-escaped, so no live markup can hide in props.
      expect(JSON.stringify(allElements(r))).not.toMatch(/<script/i);
    });
  }

  it('warnings-only emits warnings but still succeeds', async () => {
    const r = await resolver.resolve(await readFixture('warnings-only'));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['W_UNKNOWN_PROP', 'W_UNKNOWN_ICON']),
    );
  });

  it('errors fixture returns the expected error', async () => {
    const r = await resolver.validate(await readFixture('errors-unknown-tag'));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('E_UNKNOWN_TAG');
    expect(r.errors[0]?.suggestion).toBe('Shape');
  });
});
