import { alignmentMoves, distributionMoves } from '../arrange.js';

const box = (id: string, x: number, width: number) => ({ id, x, y: x, width, height: width });

it('leaves rounding to the adapter and computes alignment on either axis', () => {
  const units = [box('a', 0, 10), box('b', 20, 11)];
  expect(alignmentMoves(units, 'x', 'center')).toEqual([
    { id: 'a', d: 10.5 },
    { id: 'b', d: -10 },
  ]);
  expect(alignmentMoves(units, 'y', 'end')).toEqual([
    { id: 'a', d: 21 },
    { id: 'b', d: 0 },
  ]);
});

it('distributes overlapping units by their centers, keeping outer units fixed', () => {
  expect(distributionMoves([box('c', 60, 100), box('a', 0, 100), box('b', 10, 100)], 'x')).toEqual([
    { id: 'b', d: 20 },
  ]);
});

it('preserves fractional gaps and does nothing without enough units', () => {
  expect(distributionMoves([box('c', 31, 10), box('b', 11, 10), box('a', 0, 10)], 'y')).toEqual([
    { id: 'a', d: 0 },
    { id: 'b', d: 4.5 },
    { id: 'c', d: 0 },
  ]);
  expect(alignmentMoves([], 'x', 'start')).toEqual([]);
  expect(distributionMoves([box('a', 0, 10)], 'y')).toEqual([]);
});
