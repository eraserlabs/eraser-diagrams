import { describe, expect, it } from 'vitest';
import { ELBOW_CORNER_RADIUS, toPathData } from '../src/browser/roundedPath.js';

/**
 * The corner-rounding kernel, checked against the geometry it must guarantee rather than against
 * literal path strings: tangency (an arc leaves and rejoins the legs on the legs themselves), the
 * half-leg clamp, and the sweep direction that decides whether a corner bulges in or out.
 */

type Point = [number, number];

interface Arc {
  radius: number;
  sweep: number;
  end: Point;
}

const COMMAND = /([MLA])([^MLA]*)/g;

function numbers(chunk: string): number[] {
  return [...chunk.matchAll(/-?[\d.]+/g)].map((match) => Number(match[0]));
}

/** Every point the path visits, in order — arc endpoints included, control values excluded. */
function vertices(d: string): Point[] {
  return [...d.matchAll(COMMAND)].map((match) => {
    const values = numbers(match[2]!);

    return [values[values.length - 2]!, values[values.length - 1]!] as Point;
  });
}

function arcs(d: string): Arc[] {
  return [...d.matchAll(COMMAND)]
    .filter((match) => match[1] === 'A')
    .map((match) => {
      const [radius, , , , sweep, x, y] = numbers(match[2]!);

      return { radius: radius!, sweep: sweep!, end: [x!, y!] as Point };
    });
}

describe('toPathData', () => {
  it('emits the bare polyline at zero radius', () => {
    const points: Point[] = [
      [0, 0],
      [60, 0],
      [60, 40],
    ];

    expect(toPathData(points, 0)).toBe('M0 0L60 0L60 40');
  });

  it('replaces a right-angle corner with a quarter arc tangent to both legs', () => {
    const d = toPathData(
      [
        [0, 0],
        [60, 0],
        [60, 40],
      ],
      ELBOW_CORNER_RADIUS,
    );

    // At a right angle the tangent point sits exactly one radius back from the corner.
    expect(d).toBe('M0 0L54 0A6 6 0 0 1 60 6L60 40');
  });

  it('sweeps the other way when the route turns the other way', () => {
    const right = toPathData(
      [
        [0, 0],
        [60, 0],
        [60, 40],
      ],
      ELBOW_CORNER_RADIUS,
    );
    const left = toPathData(
      [
        [0, 0],
        [60, 0],
        [60, -40],
      ],
      ELBOW_CORNER_RADIUS,
    );

    expect(arcs(right)[0]).toEqual({ radius: 6, sweep: 1, end: [60, 6] });
    expect(arcs(left)[0]).toEqual({ radius: 6, sweep: 0, end: [60, -6] });
  });

  it('keeps both terminals exact so arrowhead markers keep their direction', () => {
    const points: Point[] = [
      [0, 0],
      [60, 0],
      [60, 40],
    ];
    const visited = vertices(toPathData(points, ELBOW_CORNER_RADIUS));

    expect(visited[0]).toEqual([0, 0]);
    expect(visited[visited.length - 1]).toEqual([60, 40]);
  });

  it('clamps the radius to half the shorter leg', () => {
    const d = toPathData(
      [
        [0, 0],
        [7, 0],
        [7, 40],
      ],
      ELBOW_CORNER_RADIUS,
    );

    expect(arcs(d)[0]!.radius).toBe(3.5);
  });

  it('keeps two corners on one short segment apart', () => {
    // The middle leg is 8px: each corner may take 4px, so the arcs meet but never cross.
    const d = toPathData(
      [
        [0, 0],
        [40, 0],
        [40, 8],
        [80, 8],
      ],
      ELBOW_CORNER_RADIUS,
    );
    const [first, second] = arcs(d);

    expect(first!.end).toEqual([40, 4]);
    expect(second!.end).toEqual([44, 8]);
  });

  it('leaves a straight-through vertex square', () => {
    const d = toPathData(
      [
        [0, 0],
        [30, 0],
        [60, 0],
      ],
      ELBOW_CORNER_RADIUS,
    );

    expect(arcs(d)).toHaveLength(0);
    expect(d).toBe('M0 0L30 0L60 0');
  });

  it('leaves a repeated point square', () => {
    const d = toPathData(
      [
        [0, 0],
        [60, 0],
        [60, 0],
        [60, 40],
      ],
      ELBOW_CORNER_RADIUS,
    );

    expect(arcs(d)).toHaveLength(0);
  });

  it('stays tangent on a diagonal corner', () => {
    const d = toPathData(
      [
        [0, 0],
        [100, 0],
        [200, 100],
      ],
      ELBOW_CORNER_RADIUS,
    );
    const [arc] = arcs(d);
    const [, start] = vertices(d);

    // Tangent offset at a 135-degree turn: r / tan(67.5deg).
    const offset = 6 / Math.tan((135 / 2) * (Math.PI / 180));
    expect(start![0]).toBeCloseTo(100 - offset, 3);
    expect(start![1]).toBe(0);
    expect(arc!.end[0]).toBeCloseTo(100 + offset / Math.SQRT2, 3);
    expect(arc!.end[1]).toBeCloseTo(offset / Math.SQRT2, 3);
  });

  it('handles a two-point route and an empty route', () => {
    expect(
      toPathData(
        [
          [0, 0],
          [60, 0],
        ],
        ELBOW_CORNER_RADIUS,
      ),
    ).toBe('M0 0L60 0');
    expect(toPathData([], ELBOW_CORNER_RADIUS)).toBe('');
  });
});
