import {
  clampToSpan,
  coordinateInSpan,
  insetSpan,
  intersectSpans,
  midpoint,
  spanContains,
  spanLength,
} from '../../rangeUtils.js';

const EPSILON = 1e-6;

describe('routing corridor geometry', () => {
  it('makes tolerance explicit in span operations', () => {
    expect(midpoint([10, 20])).toBe(15);
    expect(spanLength([10, 20])).toBe(10);
    expect(insetSpan([10, 20], 4, EPSILON)).toEqual([14, 16]);
    expect(intersectSpans([0, 10], [10 + EPSILON / 2, 20], EPSILON)).toEqual([
      10 + EPSILON / 2,
      10 + EPSILON / 2,
    ]);
    expect(spanContains([0, 10], [-EPSILON / 2, 10 + EPSILON / 2], EPSILON)).toBe(true);
    expect(coordinateInSpan(10 + EPSILON / 2, [0, 10], EPSILON)).toBe(true);
    expect(clampToSpan(12, [0, 10])).toBe(10);
  });
});
