import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import type { Resolver } from '@eraserlabs/resolve';
import { allElements, buildTestResolver } from './helper.js';

let resolver: Resolver;
beforeAll(async () => {
  resolver = await buildTestResolver();
});

// A recursive JSON-ish arbitrary that can produce hostile strings and odd shapes.
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.oneof(
      fc.constantFrom('<script>alert(1)</script>', 'javascript:x', 'red;}', '__proto__', '{{x}}'),
    ),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie('value'), { maxKeys: 5 }),
  ),
})).value;

const elementArb = fc.record({
  tag: fc.oneof(fc.constantFrom('Shape', 'Icon', 'Textbox', 'Relationship', 'Bogus'), fc.string()),
  id: fc.string(),
  x: fc.integer(),
  y: fc.integer(),
  texts: fc.array(fc.record({ text: fc.string() }), { maxLength: 3 }),
});

describe('fuzz', () => {
  it('never throws and always returns a well-formed envelope', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(elementArb, jsonValue), { maxLength: 20 }),
        async (input) => {
          const r = await resolver.resolve(input);
          expect(Array.isArray(r.errors)).toBe(true);
          expect(Array.isArray(r.warnings)).toBe(true);
          expect(typeof r.ok).toBe('boolean');

          // ok ⇒ an escaped element payload; failure ⇒ no payload at all.
          if (r.ok) {
            expect(Array.isArray(r.entities)).toBe(true);
            expect(Array.isArray(r.connections)).toBe(true);
            expect(r.icons).toBeDefined();
            expect(JSON.stringify(allElements(r))).not.toMatch(/<script/i);
          } else {
            expect(r.entities).toBeUndefined();
            expect(r.connections).toBeUndefined();
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never throws on non-array bodies', async () => {
    await fc.assert(
      fc.asyncProperty(jsonValue, async (input) => {
        const r = await resolver.resolve(input);
        expect(typeof r.ok).toBe('boolean');
      }),
      { numRuns: 200 },
    );
  });
});
