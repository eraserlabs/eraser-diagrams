import { describe, expect, it } from 'vitest';
import { addUniqueNumber, insertIntoSortedBy } from '../corridor/sortedArrayUtils.js';

describe('sorted corridor arrays', () => {
  it('inserts unique coordinates at their sorted position, including hinted searches', () => {
    const coordinates: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const coordinate = ((index * 37) % 113) / 2 - 25;
      const duplicate = coordinates.includes(coordinate);
      const expected = [...new Set([...coordinates, coordinate])].sort((a, b) => a - b);
      expect(addUniqueNumber(coordinates, coordinate, 0)).toBe(
        duplicate ? -1 : expected.indexOf(coordinate),
      );
      expect(coordinates).toEqual(expected);
    }
    expect(addUniqueNumber(coordinates, 100, coordinates.length)).toBe(coordinates.length - 1);
    expect(coordinates.at(-1)).toBe(100);
  });

  it('preserves insertion order among comparator ties', () => {
    const entries: { rank: number; index: number }[] = [];
    const compare = (a: (typeof entries)[number], b: (typeof entries)[number]) => a.rank - b.rank;
    for (let index = 0; index < 100; index += 1) {
      const entry = { rank: (index * 13) % 17, index };
      const expected = [...entries, entry].sort(compare);
      insertIntoSortedBy(entries, entry, compare);
      expect(entries).toEqual(expected);
    }
  });
});
