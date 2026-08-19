import { describe, it, expect } from 'vitest';
import { buildTestResolver } from './helper.js';

describe('performance', () => {
  // Generous ceiling: catches only catastrophic regressions (accidental O(n²), recompiled
  // schemas per call) without flaking on loaded CI machines.
  it('validates 2000 elements in under 250ms', async () => {
    const resolver = await buildTestResolver();
    const input = {
      elements: Array.from({ length: 2000 }, (_, i) => ({
        tag: 'Shape',
        id: `s${i}`,
        x: i,
        y: 0,
        texts: [{ text: `n${i}` }],
      })),
    };

    // Warm once (JIT), then measure.
    await resolver.validate(input);
    const start = performance.now();
    const r = await resolver.validate(input);
    const elapsed = performance.now() - start;

    expect(r.ok).toBe(true);
    console.info(`2000-element validate: ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(250);
  });
});
