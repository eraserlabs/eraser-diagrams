import { vi } from 'vitest';
import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutConnection, LayoutEntity } from '../../types.js';
import { routeConnections } from '../routeConnections.js';
import * as execution from '../executeCorridorRouting.js';
import type { EndpointSide, Point } from '../types.js';
import { makeRoughFallbackPoints } from '../fallbackConnection.js';
import { absoluteConnectionPoints, determineDirectionsFromPoints } from '../points.js';
import { expectOrthogonal } from '../routingTestUtils.js';

const baseEntities: LayoutEntity[] = [
  { id: 'a', x: 0, y: 0, width: 80, height: 40 },
  { id: 'b', x: 240, y: 0, width: 80, height: 40 },
];

const bound: LayoutConnection = {
  id: 'drag',
  from: 'a',
  to: 'b',
  x: 80,
  y: 20,
  points: [
    [0, 0],
    [160, 0],
  ],
  relativeFromPort: [1, 0.5],
  relativeToPort: [0, 0.5],
};

function route(
  connection: LayoutConnection,
  point: Point,
  entities = baseEntities,
  side: EndpointSide = 'to',
) {
  const manager = new LayoutManager({
    entities,
    connections: [connection],
    primaryDirection: 'right',
  });
  const { fallbacks } = routeConnections({
    layoutManager: manager,
    connectionsToRoute: [{ connection, endpointPins: { [side]: point } }],
    allowShift: false,
    repair: false,
  });
  return { fallbacks, output: manager.getConnectionById('drag') as LayoutConnection };
}

describe('endpoint-drag fallback anchors', () => {
  const faces = ['left', 'right', 'up', 'down'] as const;
  it.each(faces.flatMap((from) => faces.map((to) => ({ from, to }))))(
    'preserves $from → $to directions through reversed, aligned and coincident endpoints',
    ({ from, to }) => {
      const start: Point = [-6296, 4899];
      for (const dx of [-80, -4, 0, 0.25, 20, 40, 80]) {
        for (const dy of [-80, -11, 0, 0.25, 20, 40, 80]) {
          const end: Point = [start[0] + dx, start[1] + dy];
          const points = makeRoughFallbackPoints(start, end, from, to);
          expect(points[0]).toEqual(start);
          expect(points.at(-1)).toEqual(end);
          expect(determineDirectionsFromPoints(points)).toEqual({
            startDirection: from,
            endDirection: to,
          });
          for (let i = 1; i < points.length; i++) {
            expect(points[i]).not.toEqual(points[i - 1]);
          }
          expectOrthogonal(points);
        }
      }
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps an interior bound pin exact when its projected nearest face is blocked', () => {
    const { fallbacks, output } = route(
      bound,
      [260, 20],
      [...baseEntities, { id: 'blocker', x: 160, y: -20, width: 80, height: 80 }],
    );
    expect(fallbacks).toEqual(new Set(['drag']));
    expect(absoluteConnectionPoints(output).at(-1)).toEqual([260, 20]);
  });

  it('carries endpoints and a measured label from an impossible drag into a routable frame', () => {
    const manager = new LayoutManager({
      entities: baseEntities,
      connections: [
        {
          ...bound,
          to: '',
          toArrowhead: true,
          textPlacement: { x: Number.NaN, y: Number.NaN, width: 40, height: 14 },
        },
      ],
      primaryDirection: 'right',
    });
    for (const { point, fellBack } of [
      { point: [260, 20] as Point, fellBack: true },
      { point: [180, 80] as Point, fellBack: false },
    ]) {
      const { fallbacks } = routeConnections({
        layoutManager: manager,
        connectionsToRoute: [
          {
            connection: manager.getConnectionById('drag')!,
            endpointPins: { to: point },
          },
        ],
        repair: false,
      });
      expect(fallbacks).toEqual(new Set(fellBack ? ['drag'] : []));
      const output = manager.getConnectionById('drag')!;
      expect(absoluteConnectionPoints(output)[0]).toEqual([80, 20]);
      expect(absoluteConnectionPoints(output).at(-1)).toEqual(point);
      expect(output).toMatchObject({
        from: 'a',
        to: '',
        toArrowhead: true,
        relativeFromPort: [1, 0.5],
        textPlacement: { width: 40, height: 14 },
      });
      expect(output.relativeToPort).toBeUndefined();
      expect(Number.isFinite(output.textPlacement?.x)).toBe(true);
      expect(Number.isFinite(output.textPlacement?.y)).toBe(true);
      manager.applyStagedChanges();
    }
  });

  it.each<Point>([
    [235, -5],
    [325, 45],
  ])('keeps diagonal-corner pin %s exact and orthogonal', (x, y) => {
    const { fallbacks, output } = route(bound, [x, y]);
    const points = absoluteConnectionPoints(output);
    expect(fallbacks).toEqual(new Set(['drag']));
    expect(points[0]).toEqual([80, 20]);
    expect(points.at(-1)).toEqual([x, y]);
    expectOrthogonal(points);
  });

  it.each<{ side: EndpointSide; point: Point; stationary: Point }>([
    { side: 'to', point: [235, 20], stationary: [80, 20] },
    { side: 'to', point: [260, 20], stationary: [80, 20] },
    { side: 'from', point: [-5, 20], stationary: [240, 20] },
    { side: 'from', point: [20, 20], stationary: [240, 20] },
  ])('keeps $side pin $point exact if corridor execution throws', ({ side, point, stationary }) => {
    vi.spyOn(execution, 'executeCorridorRouting').mockImplementation(() => {
      throw new Error('forced corridor failure');
    });
    const { fallbacks, output } = route(bound, point, baseEntities, side);
    const points = absoluteConnectionPoints(output);
    if (side === 'from') {
      points.reverse();
    }
    expect(fallbacks).toEqual(new Set(['drag']));
    expect(points[0]).toEqual(stationary);
    expect(points.at(-1)).toEqual(point);
  });

  it('routes a free end to a fractional pin that bounds a continuation jog', () => {
    const grid: LayoutEntity[] = [
      { id: 'g', x: 250, y: -20, width: 230, height: 260, isContainer: true, containerId: null },
    ];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        grid.push({
          id: `n${row}${column}`,
          x: column * 130,
          y: row * 90,
          width: 80,
          height: 40,
          containerId: column >= 2 ? 'g' : null,
        });
      }
    }
    const pin: Point = [216.9, -3.3];
    const { fallbacks, output } = route(
      {
        id: 'drag',
        from: 'n00',
        to: '',
        x: 80,
        y: 20,
        points: [
          [0, 0],
          [40, 0],
        ],
        relativeFromPort: [1, 0.5],
      },
      pin,
      grid,
    );
    const points = absoluteConnectionPoints(output);
    expect(fallbacks).toEqual(new Set());
    expect(points[0]).toEqual([80, 20]);
    expect(points.at(-1)?.[0]).toBeCloseTo(pin[0]);
    expect(points.at(-1)?.[1]).toBeCloseTo(pin[1]);
  });

  it('falls back alone when a free-end pin collapses onto its own port', () => {
    const manager = new LayoutManager({
      entities: [...baseEntities, { id: 'c', x: 0, y: 160, width: 80, height: 40 }],
      connections: [{ ...bound, to: '' }],
      primaryDirection: 'right',
    });
    const { fallbacks } = routeConnections({
      layoutManager: manager,
      connectionsToRoute: [
        { connection: manager.getConnectionById('drag')!, endpointPins: { to: [80, 20] } },
        { connection: { id: 'cb', from: 'c', to: 'b' } },
      ],
      allowShift: false,
      repair: false,
    });
    expect(fallbacks).toEqual(new Set(['drag']));
  });

  it.each([80, 40])('falls back when pin x=%s consumes or reverses the terminal segment', (x) => {
    const { fallbacks, output } = route(bound, [x, 20]);
    const points = absoluteConnectionPoints(output);
    expect(fallbacks).toEqual(new Set(['drag']));
    expect(points[0]).toEqual([80, 20]);
    expect(points.at(-1)).toEqual([x, 20]);
    expect(points.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index]).not.toEqual(points[index - 1]);
    }
  });
});
