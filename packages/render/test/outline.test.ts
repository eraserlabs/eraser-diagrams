import { createEntityOutline, type OutlineDescriptor } from '@eraserlabs/layout';
import { describe, expect, it } from 'vitest';
import type { Box, ResolvedConnection, ResolvedEntity } from '../src/index.js';
import { routeScene } from '../src/browser/route.js';

/**
 * True-boundary endpoint attachment: the closed-form outline geometry alone, then the corridor
 * bridge end to end — a route into an outlined entity must terminate on the drawn boundary, not
 * the bounding box, except where a caption extends the terminal plane.
 */

const NO_INTRINSICS = new Map<string, Box>();
const NO_TEXT = new Map<string, Box[]>();

const HEXAGON: OutlineDescriptor = {
  kind: 'polygon',
  vertices: [
    [0, 50],
    [25, 99.7965],
    [75, 99.7965],
    [100, 50],
    [75, 0.2035],
    [25, 0.2035],
  ],
};

const UNIT_BOX = { x: 0, y: 0, width: 100, height: 100 };

function node(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 60,
  props: Record<string, unknown> = {},
): ResolvedEntity {
  return { tag: 'Box', id, x, y, width, height, props };
}

function wire(id: string, from: string, to: string): ResolvedConnection {
  return { tag: 'Wire', id, x: 0, y: 0, props: { from, to } };
}

function pointsOf(d: string): [number, number][] {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** Hexagon left-face boundary x for a given y, in the 0–100 frame (sharp corners). */
function hexagonLeftX(y: number): number {
  const slopeSpan = 50 - 0.2035;

  return y <= 50 ? (25 * (50 - y)) / slopeSpan : (25 * (y - 50)) / slopeSpan;
}

describe('createEntityOutline', () => {
  it('walks an off-center ray to the hexagon slope', () => {
    const outline = createEntityOutline(HEXAGON, UNIT_BOX)!;
    const hit = outline.intersectRay({ x: 100, y: 25 }, { x: -1, y: 0 })!;

    // Right-top edge runs (75, 0.2035) → (100, 50); at y=25 the boundary sits at ≈87.45.
    expect(hit.x).toBeCloseTo(75 + (25 * (25 - 0.2035)) / (50 - 0.2035), 6);
    expect(hit.y).toBe(25);
  });

  it('keeps the mid-track attachment on the box face', () => {
    const outline = createEntityOutline(HEXAGON, UNIT_BOX)!;
    const hit = outline.intersectRay({ x: 100, y: 50 }, { x: -1, y: 0 })!;

    expect(hit.x).toBeCloseTo(100, 6);
    expect(hit.y).toBe(50);
  });

  it('attaches to the analytic ellipse', () => {
    const outline = createEntityOutline(
      { kind: 'ellipse' },
      { x: 0, y: 0, width: 100, height: 50 },
    )!;
    const hit = outline.intersectRay({ x: 100, y: 12.5 }, { x: -1, y: 0 })!;

    // Quarter-height chord of the inscribed ellipse: x = 50 + 50·√(1 − 0.5²).
    expect(hit.x).toBeCloseTo(50 + 50 * Math.sqrt(0.75), 6);
  });

  it('attaches to a rounded rectangle corner arc', () => {
    const outline = createEntityOutline(
      {
        kind: 'polygon',
        vertices: [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
        ],
        cornerRadius: 12,
      },
      UNIT_BOX,
    )!;
    const hit = outline.intersectRay({ x: 100, y: 6 }, { x: -1, y: 0 })!;

    // Corner arc center (88, 12), radius 12: x = 88 + √(12² − 6²).
    expect(hit.x).toBeCloseTo(88 + Math.sqrt(144 - 36), 6);
  });

  it('returns the outermost crossing of a non-convex star', () => {
    const star: OutlineDescriptor = {
      kind: 'polygon',
      vertices: [
        [50, 0],
        [66.1641, 28.3024],
        [97.5528, 38.0041],
        [76.1541, 65.1976],
        [79.3893, 99.4959],
        [50, 88],
        [20.6107, 99.4959],
        [23.8459, 65.1976],
        [2.4472, 38.0041],
        [33.8359, 28.3024],
      ],
    };
    const outline = createEntityOutline(star, UNIT_BOX)!;
    const hit = outline.intersectRay({ x: 110, y: 50 }, { x: -1, y: 0 })!;

    // First edge crossed from the right is (97.5528, 38.0041) → (76.1541, 65.1976).
    const t = (50 - 38.0041) / (65.1976 - 38.0041);
    expect(hit.x).toBeCloseTo(97.5528 + t * (76.1541 - 97.5528), 4);
  });
});

describe('routeScene with outlined entities', () => {
  it('terminates a route on the hexagon boundary instead of the bounding box', () => {
    const layout = routeScene(
      [node('a', 0, 0), node('b', 300, 0, 100, 100, { outline: HEXAGON })],
      [wire('w', 'a', 'b')],
      NO_INTRINSICS,
      NO_TEXT,
    );

    const points = pointsOf(layout.connections['w']!.d);
    const [endX, endY] = points[points.length - 1]!;

    // The path serializer rounds coordinates to three decimals; compare at that precision.
    expect(endX).toBeCloseTo(300 + hexagonLeftX(endY), 2);
    if (endY !== 50) {
      expect(endX).toBeGreaterThan(300);
    }
  });

  it('still attaches to a caption edge when text extends the terminal face', () => {
    const caption: Box = { x: 10, y: 105, width: 80, height: 20 };
    const layout = routeScene(
      [node('a', 300, 300), node('b', 300, 0, 100, 100, { outline: HEXAGON })],
      [wire('w', 'a', 'b')],
      NO_INTRINSICS,
      new Map([['b', [caption]]]),
    );

    const points = pointsOf(layout.connections['w']!.d);
    const [, endY] = points[points.length - 1]!;

    expect(endY).toBe(125);
  });

  it('stays a pure function of its input with outlines present', () => {
    const entities = () => [node('a', 0, 0), node('b', 300, 0, 100, 100, { outline: HEXAGON })];
    const connections = () => [wire('w', 'a', 'b')];

    const first = routeScene(entities(), connections(), NO_INTRINSICS, NO_TEXT);
    const second = routeScene(entities(), connections(), NO_INTRINSICS, NO_TEXT);

    expect(second.connections['w']!.d).toBe(first.connections['w']!.d);
  });
});
