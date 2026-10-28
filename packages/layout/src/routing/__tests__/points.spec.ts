import type { LayoutConnection } from '../../types.js';
import { hasValidConnectionGeometry } from '../points.js';

describe('hasValidConnectionGeometry', () => {
  it.each<[Partial<LayoutConnection>, boolean]>([
    [{}, true],
    [{ x: undefined }, false],
    [{ y: Number.NaN }, false],
    [{ points: undefined }, false],
    [{ points: [[0, 0]] }, false],
    [
      {
        points: [
          [1, 0],
          [10, 0],
        ],
      },
      false,
    ],
    [
      {
        points: [
          [0, 0],
          [10, 10],
        ],
      },
      false,
    ],
    [
      {
        points: [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      },
      false,
    ],
    [
      {
        points: [
          [0, 0],
          [Infinity, 0],
        ],
      },
      false,
    ],
    [
      {
        points: [
          [0, 0],
          [0, Number.NaN],
        ],
      },
      false,
    ],
  ])('checks reusable connection geometry: %j', (geometry, valid) => {
    expect(
      hasValidConnectionGeometry({
        id: 'ab',
        from: 'a',
        to: 'b',
        x: 80,
        y: 20,
        points: [
          [0, 0],
          [10, 0],
          [10, 20],
        ],
        ...geometry,
      }),
    ).toBe(valid);
  });
});
