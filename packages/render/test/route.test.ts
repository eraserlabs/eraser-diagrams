import { anchorFromStored, resolveManualLabel } from '@eraserlabs/layout';
import { describe, expect, it } from 'vitest';
import type { Box, ResolvedConnection, ResolvedEntity } from '../src/index.js';
import { routeScene } from '../src/browser/route.js';

/**
 * The corridor bridge, driven in Node: the router is DOM-free, so everything except measurement
 * runs here. Tags are deliberately non-stock — routing keys off `from`/`to` props and measured
 * boxes, never off a vocabulary. The entity/connection split is the caller's contract (the
 * resolver classifies from `x-schema-kind` in production), so each call passes the two lists
 * directly.
 */

const NO_INTRINSICS = new Map<string, Box>();
const NO_TEXT = new Map<string, Box[]>();

function node(id: string, x: number, y: number, width = 100, height = 60): ResolvedEntity {
  return { tag: 'Box', id, x, y, width, height, props: {} };
}

function wire(
  id: string,
  from: string,
  to: string,
  props: Record<string, unknown> = {},
): ResolvedConnection {
  return {
    tag: 'Wire',
    id,
    x: 0,
    y: 0,
    props: { from, to, ...props },
  };
}

function pointsOf(d: string): [number, number][] {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

function crosses(points: [number, number][], box: Box): boolean {
  return points.slice(1).some(([bx, by], index) => {
    const [ax, ay] = points[index]!;

    return (
      Math.min(ax, bx) < box.x + box.width &&
      Math.max(ax, bx) > box.x &&
      Math.min(ay, by) < box.y + box.height &&
      Math.max(ay, by) > box.y
    );
  });
}

function isOrthogonal(points: [number, number][]): boolean {
  return points.slice(1).every(([bx, by], index) => {
    const [ax, ay] = points[index]!;

    return ax === bx || ay === by;
  });
}

describe('routeScene', () => {
  it('routes around an entity standing between the endpoints', () => {
    const obstacle = { x: 200, y: -40, width: 60, height: 140 };
    const layout = routeScene(
      [
        node('a', 0, 0),
        node('o', obstacle.x, obstacle.y, obstacle.width, obstacle.height),
        node('b', 400, 0),
      ],
      [wire('w', 'a', 'b')],
      NO_INTRINSICS,
      NO_TEXT,
    );

    const points = pointsOf(layout.connections['w']!.d);
    expect(points.length).toBeGreaterThan(2);
    expect(crosses(points, obstacle)).toBe(false);
  });

  it('is a pure function of its input', () => {
    const entities = () => [node('a', 0, 0), node('o', 200, -40, 60, 140), node('b', 400, 0)];
    const connections = () => [wire('w', 'a', 'b')];

    const first = routeScene(entities(), connections(), NO_INTRINSICS, NO_TEXT);
    const second = routeScene(entities(), connections(), NO_INTRINSICS, NO_TEXT);

    expect(second.connections['w']!.d).toBe(first.connections['w']!.d);
    expect(second.scene).toEqual(first.scene);
  });

  it('adopts authored geometry the router accepts, verbatim', () => {
    const layout = routeScene(
      [node('a', 0, 0), node('b', 400, 0)],
      [
        // Orthogonal, clear of every other entity: pinnable.
        wire('w', 'a', 'b', {
          points: [
            { x: 100, y: 30 },
            { x: 250, y: 30 },
            { x: 250, y: 200 },
            { x: 400, y: 200 },
          ],
        }),
      ],
      NO_INTRINSICS,
      NO_TEXT,
    );

    expect(layout.connections['w']!.d).toBe('M100 30L250 30L250 200L400 200');
    expect(layout.connections['w']!.label).toEqual({ x: 250, y: 115 });
    expect(layout.connections['w']!.labelBox).toBeUndefined();
  });

  it('keeps the authored object shape separate from internal tuple geometry', () => {
    const layout = routeScene(
      [node('a', 0, 0), node('b', 400, 0)],
      [
        // Router tuples are not part of the authored payload; an unrecognized value reroutes.
        wire('w', 'a', 'b', {
          points: [
            [100, 200],
            [400, 200],
          ],
        }),
      ],
      NO_INTRINSICS,
      NO_TEXT,
    );

    expect(layout.connections['w']!.d).not.toBe('M100 200L400 200');
    expect(layout.connections['w']!.points.every(Array.isArray)).toBe(true);
  });

  it("rounds the corners of a cornerStyle:'elbow' route, and nothing else", () => {
    const points = [
      { x: 100, y: 30 },
      { x: 250, y: 30 },
      { x: 250, y: 200 },
      { x: 400, y: 200 },
    ];
    const elements = [node('a', 0, 0), node('b', 400, 0)];
    const square = routeScene(elements, [wire('w', 'a', 'b', { points })], NO_INTRINSICS, NO_TEXT);
    const rounded = routeScene(
      elements,
      [wire('w', 'a', 'b', { points, cornerStyle: 'elbow' })],
      NO_INTRINSICS,
      NO_TEXT,
    );

    expect(rounded.connections['w']!.d).toBe(
      'M100 30L244 30A6 6 0 0 1 250 36L250 194A6 6 0 0 0 256 200L400 200',
    );
    // Paint only: the label anchor and the scene box still measure the router's polyline.
    expect(rounded.connections['w']!.label).toEqual(square.connections['w']!.label);
    expect(rounded.scene).toEqual(square.scene);
  });

  it.each([
    ['auto-stored', undefined],
    ['manual on-line', 0],
    ['manual offset', 24],
  ])("uses an adopted path's %s label placement", (_, lineOffset) => {
    const labels = new Map<string, Box[]>([['w', [{ x: 0, y: 0, width: 72, height: 18 }]]]);
    const layout = routeScene(
      [node('a', 0, 0), node('b', 400, 0)],
      [
        {
          ...wire('w', 'a', 'b', {
            label: 'stored',
            points: [
              { x: 0, y: -20 },
              { x: 300, y: -20 },
            ],
            labelPlacement: {
              x: 80,
              y: -48,
              // The painted box wins for size and is re-centred on the persisted box's centre —
              // scene centre (213, 10), not the persisted top-left paired with a painted size.
              width: 66,
              height: 16,
              ...(lineOffset === undefined ? {} : { lineOffset }),
            },
          }),
          x: 100,
          y: 50,
        },
      ],
      NO_INTRINSICS,
      labels,
    );

    expect(layout.connections['w']).toMatchObject({
      d: 'M100 30L400 30',
      label: { x: 213, y: 10 },
      labelBox: { x: 177, y: 1, width: 72, height: 18 },
    });
  });

  it('uses external-text, not a stock label prop, to identify a custom-template label', () => {
    const customText = new Map<string, Box[]>([['w', [{ x: 0, y: 0, width: 64, height: 20 }]]]);
    const layout = routeScene(
      [node('a', 0, 0), node('b', 400, 0)],
      [
        wire('w', 'a', 'b', {
          caption: { text: 'custom property shape' },
          points: [
            { x: 100, y: 30 },
            { x: 400, y: 30 },
          ],
          labelPlacement: { x: 150, y: 2, width: 58, height: 18 },
        }),
      ],
      NO_INTRINSICS,
      customText,
    );

    expect(layout.connections['w']).toMatchObject({
      label: { x: 179, y: 11 },
      labelBox: { x: 147, y: 1, width: 64, height: 20 },
    });
  });

  it('ignores stored label placement when the template renders no external-text role', () => {
    const layout = routeScene(
      [node('a', 0, 0), node('b', 400, 0)],
      [
        wire('w', 'a', 'b', {
          label: 'data alone does not mean the template painted it',
          points: [
            { x: 100, y: 30 },
            { x: 400, y: 30 },
          ],
          labelPlacement: { x: 155, y: 4, width: 50, height: 16 },
        }),
      ],
      NO_INTRINSICS,
      NO_TEXT,
    );

    expect(layout.connections['w']!.labelBox).toBeUndefined();
    expect(layout.connections['w']!.label).toEqual({ x: 250, y: 30 });
  });

  it('falls back to persisted dimensions when measured external-text has no usable size', () => {
    const unsizedText = new Map<string, Box[]>([['w', [{ x: 0, y: 0, width: 0, height: 0 }]]]);
    const layout = routeScene(
      [node('a', 0, 0), node('b', 400, 0)],
      [
        wire('w', 'a', 'b', {
          label: 'stored',
          points: [
            { x: 100, y: 30 },
            { x: 400, y: 30 },
          ],
          labelPlacement: { x: 155, y: 4, width: 50, height: 16 },
        }),
      ],
      NO_INTRINSICS,
      unsizedText,
    );

    expect(layout.connections['w']).toMatchObject({
      label: { x: 180, y: 12 },
      labelBox: { x: 155, y: 4, width: 50, height: 16 },
    });
  });

  it('re-routes authored geometry the router would reject', () => {
    const labels = new Map<string, Box[]>([['w', [{ x: 0, y: 0, width: 80, height: 20 }]]]);
    const diagonal = routeScene(
      [node('a', 0, 0), node('b', 400, 0)],
      [
        wire('w', 'a', 'b', {
          label: 'stale',
          points: [
            { x: 100, y: 30 },
            { x: 400, y: 200 },
          ],
          // This is stale with the rejected route and must not override the router's fresh label.
          labelPlacement: { x: 900, y: 900, width: 80, height: 20 },
        }),
      ],
      NO_INTRINSICS,
      labels,
    );

    // Unadoptable as authored, so it comes back as a corridor route: orthogonal throughout.
    const points = pointsOf(diagonal.connections['w']!.d);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(isOrthogonal(points)).toBe(true);
    expect(diagonal.connections['w']!.labelBox).toMatchObject({ width: 80, height: 20 });
    expect(diagonal.connections['w']!.labelBox).not.toMatchObject({ x: 900, y: 900 });
  });

  it.each([
    ['offset from the line', 24, 6],
    ['explicitly on the line', 0, 30],
  ])(
    'preserves a manual label %s when its authored route is rejected',
    (_, lineOffset, centerY) => {
      const dims = { width: 80, height: 20 };
      const labels = new Map<string, Box[]>([['w', [{ x: 0, y: 0, ...dims }]]]);
      const oldRoute: [number, number][] = [
        [100, 30],
        [400, 30],
      ];
      const oldCenter: [number, number] = [150, centerY];
      const obstacle = { x: 200, y: 0, width: 60, height: 60 };
      const layout = routeScene(
        [
          node('a', 0, 0),
          node('o', obstacle.x, obstacle.y, obstacle.width, obstacle.height),
          node('b', 400, 0),
        ],
        [
          wire('w', 'a', 'b', {
            caption: { text: 'custom property shape' },
            points: oldRoute.map(([x, y]) => ({ x, y })),
            labelPlacement: {
              // Current DOM measurements still win over persisted dimensions; the persisted box
              // contributes its centre, so a stale size never drags the label off its anchor.
              x: oldCenter[0] - 999 / 2,
              y: oldCenter[1] - 999 / 2,
              width: 999,
              height: 999,
              lineOffset,
            },
          }),
        ],
        NO_INTRINSICS,
        labels,
      );

      const connection = layout.connections['w']!;
      const newRoute = pointsOf(connection.d);
      expect(newRoute).not.toEqual(oldRoute);
      expect(crosses(newRoute, obstacle)).toBe(false);

      const anchor = anchorFromStored(oldRoute, oldCenter, lineOffset)!;
      expect(anchor).toMatchObject({ mode: 'mid', offset: lineOffset });
      const expected = resolveManualLabel(newRoute, anchor, dims)!;
      expect(expected.anchor.offset).toBe(lineOffset);
      expect(connection.label.x).toBeCloseTo(expected.center[0]);
      expect(connection.label.y).toBeCloseTo(expected.center[1]);
      expect(connection.labelBox).toMatchObject({ width: dims.width, height: dims.height });

      const onLine = resolveManualLabel(newRoute, { ...anchor, offset: 0 }, dims)!;
      const perpendicularDistance = Math.hypot(
        expected.center[0] - onLine.center[0],
        expected.center[1] - onLine.center[1],
      );
      if (lineOffset === 0) {
        expect(perpendicularDistance).toBe(0);
      } else {
        // The nominal offset survives; the engine may increase it to clear a wide label on a
        // vertical run (here 40px half-width + 4px gap).
        expect(perpendicularDistance).toBeGreaterThanOrEqual(Math.abs(lineOffset));
      }
    },
  );

  it('re-routes authored geometry that cuts a third entity', () => {
    const obstacle = { x: 200, y: 0, width: 60, height: 60 };
    const layout = routeScene(
      [
        node('a', 0, 0),
        node('o', obstacle.x, obstacle.y, obstacle.width, obstacle.height),
        node('b', 400, 0),
      ],
      [
        wire('w', 'a', 'b', {
          points: [
            { x: 100, y: 30 },
            { x: 400, y: 30 },
          ],
        }),
      ],
      NO_INTRINSICS,
      NO_TEXT,
    );

    expect(crosses(pointsOf(layout.connections['w']!.d), obstacle)).toBe(false);
  });

  it('sizes boxes from resolved dimensions, else the authored fallback', () => {
    const intrinsics = new Map<string, Box>([['m', { x: 0, y: 0, width: 123.4, height: 45.6 }]]);
    const layout = routeScene(
      [{ tag: 'Box', id: 'm', x: 10.2, y: 20.7, props: {} }, node('f', 300, 0, 80, 40)],
      [],
      intrinsics,
      NO_TEXT,
    );

    // Snapped to the integer grid the router works on.
    expect(layout.boxes['m']).toEqual({ x: 10, y: 21, width: 124, height: 46 });
    expect(layout.boxes['f']).toEqual({ x: 300, y: 0, width: 80, height: 40 });
  });

  it("routes around a node's caption, not through it", () => {
    // An icon-style caption: painted below the 50×50 body, wider than it, wrapper-relative.
    const caption = new Map<string, Box[]>([['a', [{ x: -40, y: 55, width: 130, height: 40 }]]]);
    const entities = [node('a', 300, 85, 50, 50), node('b', 105, 295, 220, 110)];
    const connections = [wire('w', 'a', 'b', { fromPort: 'bottom', toPort: 'top' })];

    const captioned = routeScene(entities, connections, NO_INTRINSICS, caption);
    const bare = routeScene(entities, connections, NO_INTRINSICS, NO_TEXT);

    const captionBox = { x: 300 - 40, y: 85 + 55, width: 130, height: 40 };
    expect(crosses(pointsOf(bare.connections['w']!.d), captionBox)).toBe(true);
    expect(crosses(pointsOf(captioned.connections['w']!.d), captionBox)).toBe(false);
  });

  it('keeps routes clear of a measured connection label', () => {
    const labels = new Map<string, Box[]>([['w', [{ x: 0, y: 0, width: 80, height: 20 }]]]);
    const layout = routeScene(
      [node('a', 0, 0), node('b', 400, 0)],
      [wire('w', 'a', 'b')],
      NO_INTRINSICS,
      labels,
    );

    const placed = layout.connections['w']!.labelBox;
    expect(placed).toBeDefined();
    expect(placed).toMatchObject({ width: 80, height: 20 });
    expect(layout.connections['w']!.label).toEqual({
      x: placed!.x + 40,
      y: placed!.y + 10,
    });
  });
});

describe("routeScene with connectorStyle: 'straight'", () => {
  it('draws one direct segment between the boundary points, deterministically', () => {
    const entities = () => [node('a', 0, 0, 100, 100), node('b', 200, 200, 100, 100)];
    const connections = () => [wire('w', 'a', 'b', { connectorStyle: 'straight' })];

    const layout = routeScene(entities(), connections(), NO_INTRINSICS, NO_TEXT);

    // Centers (50,50) and (250,250): the sight line leaves each box at its corner.
    expect(layout.connections['w']!.d).toBe('M100 100L200 200');
    expect(layout.connections['w']!.label).toEqual({ x: 150, y: 150 });
    expect(routeScene(entities(), connections(), NO_INTRINSICS, NO_TEXT).connections['w']!.d).toBe(
      'M100 100L200 200',
    );
  });

  it('pins straight endpoints to authored ports', () => {
    const layout = routeScene(
      [node('a', 0, 0, 100, 100), node('b', 200, 200, 100, 100)],
      [wire('w', 'a', 'b', { connectorStyle: 'straight', fromPort: 'right', toPort: 'bottom' })],
      NO_INTRINSICS,
      NO_TEXT,
    );

    expect(layout.connections['w']!.d).toBe('M100 50L250 300');
  });

  it('adopts authored diagonal geometry on a straight connection verbatim', () => {
    const layout = routeScene(
      [node('a', 0, 0, 100, 100), node('b', 400, 0, 100, 100)],
      [
        wire('w', 'a', 'b', {
          connectorStyle: 'straight',
          points: [
            { x: 100, y: 50 },
            { x: 400, y: 20 },
          ],
        }),
      ],
      NO_INTRINSICS,
      NO_TEXT,
    );

    expect(layout.connections['w']!.d).toBe('M100 50L400 20');
  });

  it('keeps corridor routes intact alongside a straight connection', () => {
    const obstacle = { x: 200, y: -40, width: 60, height: 140 };
    const layout = routeScene(
      [
        node('a', 0, 0),
        node('o', obstacle.x, obstacle.y, obstacle.width, obstacle.height),
        node('b', 400, 0),
        node('c', 0, 300, 100, 60),
        node('e', 400, 500, 100, 60),
      ],
      [wire('w', 'a', 'b'), wire('s', 'c', 'e', { connectorStyle: 'straight' })],
      NO_INTRINSICS,
      NO_TEXT,
    );

    // The diagonal segment never entered the router's world, so the elbow route still avoids the
    // obstacle instead of degrading to direct fallback geometry.
    const elbow = pointsOf(layout.connections['w']!.d);
    expect(elbow.length).toBeGreaterThan(2);
    expect(isOrthogonal(elbow)).toBe(true);
    expect(crosses(elbow, obstacle)).toBe(false);

    const straight = pointsOf(layout.connections['s']!.d);
    expect(straight).toHaveLength(2);
    expect(isOrthogonal(straight)).toBe(false);
  });
});
