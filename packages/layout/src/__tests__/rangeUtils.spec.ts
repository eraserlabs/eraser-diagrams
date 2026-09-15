import { describe, expect, it } from 'vitest';
import { intersectRanges, type LayoutRange } from '../index.js';

const box: LayoutRange = { minX: 0, minY: 0, maxX: 10, maxY: 20 };

describe('intersectRanges', () => {
  it.each([
    [
      'overlap',
      { minX: 5, minY: -5, maxX: 15, maxY: 15 },
      { minX: 5, minY: 0, maxX: 10, maxY: 15 },
    ],
    ['containment', { minX: 2, minY: 3, maxX: 8, maxY: 9 }, { minX: 2, minY: 3, maxX: 8, maxY: 9 }],
    [
      'edge contact',
      { minX: 10, minY: 5, maxX: 12, maxY: 15 },
      { minX: 10, minY: 5, maxX: 10, maxY: 15 },
    ],
    [
      'point contact',
      { minX: 10, minY: 20, maxX: 12, maxY: 25 },
      { minX: 10, minY: 20, maxX: 10, maxY: 20 },
    ],
    ['horizontal separation', { minX: 11, minY: 0, maxX: 12, maxY: 20 }, undefined],
    ['vertical separation', { minX: 0, minY: 21, maxX: 10, maxY: 22 }, undefined],
    ['unbounded clip', { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }, box],
    [
      'one-axis clip',
      { minX: -Infinity, minY: 5, maxX: Infinity, maxY: 15 },
      { minX: 0, minY: 5, maxX: 10, maxY: 15 },
    ],
  ] as const)('handles %s symmetrically without mutating inputs', (_name, other, expected) => {
    const first = Object.freeze({ ...box });
    const second = Object.freeze({ ...other });
    expect(intersectRanges(first, second)).toEqual(expected);
    expect(intersectRanges(second, first)).toEqual(expected);
  });
});
