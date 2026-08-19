import type { LayoutEntity } from '../../types.js';
import { straightConnectionEndpoints } from '../straightConnection.js';

function box(id: string, x: number, y: number, width = 100, height = 60): LayoutEntity {
  return { id, x, y, width, height };
}

describe('straightConnectionEndpoints', () => {
  it('attaches both terminals where the sight line leaves each bounding box', () => {
    const from = box('a', 0, 0, 100, 100);
    const to = box('b', 200, 200, 100, 100);

    const [start, end] = straightConnectionEndpoints(from, to);

    // Centers (50,50) and (250,250): the 45° sight line exits each box at its corner.
    expect(start).toEqual([100, 100]);
    expect(end).toEqual([200, 200]);
  });

  it('exits through the facing sides when the offset is mostly horizontal', () => {
    const from = box('a', 0, 0, 100, 100);
    const to = box('b', 300, 50, 100, 100);

    const [start, end] = straightConnectionEndpoints(from, to);

    // Mostly-horizontal sight line: both exits land on left/right faces, y interpolated.
    expect(start[0]).toBe(100);
    expect(end[0]).toBe(300);
    expect(start[1]).toBeGreaterThan(50);
    expect(start[1]).toBeLessThan(100);
    expect(end[1]).toBeGreaterThan(50);
    expect(end[1]).toBeLessThan(100);
  });

  it('pins an endpoint to its authored face and aims the free endpoint at it', () => {
    const from = box('a', 0, 0, 100, 100);
    const to = box('b', 200, 200, 100, 100);

    const [start, end] = straightConnectionEndpoints(from, to, { fromFace: 'up' });

    // Face port: top-center of `a`.
    expect(start).toEqual([50, 0]);
    // Free endpoint sits on b's boundary, on the segment from b's center (250,250) to `start`.
    expect(end[0]).toBeGreaterThanOrEqual(200);
    expect(end[1]).toBe(200);
    expect(
      (end[0] - start[0]) * (250 - start[1]) - (250 - start[0]) * (end[1] - start[1]),
    ).toBeCloseTo(0, 6);
  });

  it('honors both authored faces verbatim', () => {
    const from = box('a', 0, 0, 100, 100);
    const to = box('b', 200, 200, 100, 100);

    const [start, end] = straightConnectionEndpoints(from, to, {
      fromFace: 'right',
      toFace: 'down',
    });

    expect(start).toEqual([100, 50]);
    expect(end).toEqual([250, 300]);
  });

  it('attaches to an ellipse outline instead of its bounding box', () => {
    const from: LayoutEntity = { ...box('a', 0, 0, 100, 100), outline: { kind: 'ellipse' } };
    const to = box('b', 200, 200, 100, 100);

    const [start] = straightConnectionEndpoints(from, to);

    // 45° ray from (50,50) hits the r=50 circle at 50/√2 along each axis — inside the box corner.
    expect(start[0]).toBeCloseTo(50 + 50 / Math.SQRT2, 6);
    expect(start[1]).toBeCloseTo(50 + 50 / Math.SQRT2, 6);
  });

  it('degrades to centers when the entities share one', () => {
    const from = box('a', 0, 0, 100, 100);
    const to = box('b', 25, 25, 50, 50);

    const [start, end] = straightConnectionEndpoints(from, to);

    expect(start).toEqual([50, 50]);
    expect(end).toEqual([50, 50]);
  });
});
