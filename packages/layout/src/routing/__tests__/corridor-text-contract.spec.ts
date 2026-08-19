import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutEntity, XYPoint } from '../../types.js';
import { CorridorIndexer } from '../corridor/corridorIndex.js';
import type { Corridor } from '../corridor/contract.js';
import { placeLabels } from '../corridor/labelPlacement.js';
import { Route } from '../corridor/route.js';
import type { LabelSpec } from '../corridor/text.js';
import type { CorridorWorld } from '../corridor/world.js';

const CORRIDOR: Corridor = {
  index: 0,
  axis: 'x',
  rect: { x: 0, y: 0, width: 300, height: 300 },
};

function emptyWorld(): CorridorWorld {
  const bounds = { x: 0, y: 0, width: 300, height: 300 };
  return {
    bounds,
    entities: [],
    indexer: new CorridorIndexer(
      [CORRIDOR],
      [],
      [],
      new LayoutManager({ entities: [], connections: [] }),
      bounds,
    ),
  };
}

function adjacentCorridorWorld(sharedContainerFace = false): CorridorWorld {
  const corridors: readonly Corridor[] = [
    { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 300, height: 46 } },
    { index: 1, axis: 'x', rect: { x: 0, y: 46, width: 300, height: 74 } },
  ];
  const container: LayoutEntity = {
    id: 'container',
    x: 0,
    y: 0,
    width: 300,
    height: 46,
    isContainer: true,
  };
  const entities = sharedContainerFace ? [container] : [];
  const bounds = { x: 0, y: 0, width: 300, height: 120 };
  return {
    bounds,
    entities,
    indexer: new CorridorIndexer(
      corridors,
      [],
      [],
      new LayoutManager({ entities: [...entities], connections: [] }),
      bounds,
    ),
  };
}

function route(
  requestIndex: number,
  track: number,
  points: readonly XYPoint[] = [
    { x: 0, y: track },
    { x: 300, y: track },
  ],
): Route {
  const subject = new Route(
    requestIndex,
    { entityIndex: requestIndex * 2, face: 'right' },
    { entityIndex: requestIndex * 2 + 1, face: 'left' },
    [
      {
        corridorIndex: 0,
        entry: { kind: 'terminal', attachmentIndex: requestIndex * 2 },
        exit: { kind: 'terminal', attachmentIndex: requestIndex * 2 + 1 },
        feasibleTrack: [0, 300],
      },
    ],
  );
  subject.beginRealization();
  subject.setOrder([0]);
  subject.setNominalTracks([track]);
  subject.setGeometry(
    { from: points[0], to: points[points.length - 1] },
    points,
    Array.from({ length: points.length - 1 }, () => 0),
  );
  return subject;
}

function specs(routes: readonly Route[], width = 60, height = 20): LabelSpec[] {
  return routes.map((_, routeIndex) => ({ routeIndex, size: { width, height } }));
}

describe('routing corridor text placement', () => {
  it('owns one placement per labeled route and complete final route geometry', () => {
    const routes = [route(0, 100), route(1, 140)];
    const result = placeLabels(emptyWorld(), routes, specs(routes));

    expect(result.placements.map(({ routeIndex }) => routeIndex)).toEqual([0, 1]);
    expect(result.routePoints).toHaveLength(routes.length);
    expect(result.placements.map((placement) => placement.tier)).toEqual(['on-line', 'on-line']);
  });

  it('treats collinear emitted fragments as one label host run', () => {
    const routes = [
      route(0, 100, [
        { x: 0, y: 100 },
        { x: 40, y: 100 },
        { x: 70, y: 100 },
        { x: 109, y: 100 },
      ]),
    ];
    const result = placeLabels(emptyWorld(), routes, specs(routes, 54, 16));

    expect(result.placements[0]).toEqual(
      expect.objectContaining({
        tier: 'on-line',
        rect: { x: 27.5, y: 92, width: 54, height: 16 },
      }),
    );
  });

  it('rejects more than one label for a route', () => {
    const routes = [route(0, 100)];
    expect(() =>
      placeLabels(emptyWorld(), routes, [
        { routeIndex: 0, size: { width: 20, height: 20 } },
        { routeIndex: 0, size: { width: 30, height: 20 } },
      ]),
    ).toThrow('duplicate label for route 0');
  });

  it('places a dense parallel label fan on line without overlapping its labels', () => {
    const routes = [route(0, 100), route(1, 116), route(2, 132), route(3, 148)];
    const result = placeLabels(emptyWorld(), routes, specs(routes, 60, 32));

    expect(result.placements.every((placement) => placement.tier === 'on-line')).toBe(true);
    expect(
      result.placements.every((placement, index) =>
        result.placements.every(
          (other, otherIndex) => index === otherIndex || !rectsOverlap(placement.rect, other.rect),
        ),
      ),
    ).toBe(true);
    expect(
      result.placements.map((placement) =>
        placement.tier === 'on-line' ? placement.host.displacement?.displacedTrack : undefined,
      ),
    ).toEqual([64, 104, 144, 184]);
  });

  it('does not displace labels through an exterior container wall', () => {
    const world = adjacentCorridorWorld(true);
    const routes = [route(0, 10), route(1, 16), route(2, 22), route(3, 28)];
    const result = placeLabels(world, routes, specs(routes, 60, 8));

    expect(result.placements.every(({ rect }) => rect.y >= 0)).toBe(true);
    expect(result.routePoints.every((points) => points.every(({ y }) => y >= 0))).toBe(true);
  });

  it('prefers a longer clean segment over a shorter terminal stub', () => {
    const points = [
      { x: 10, y: 20 },
      { x: 90, y: 20 },
      { x: 90, y: 120 },
      { x: 210, y: 120 },
      { x: 210, y: 220 },
      { x: 10, y: 220 },
      { x: 10, y: 110 },
      { x: 230, y: 110 },
      { x: 230, y: 230 },
      { x: 20, y: 230 },
      { x: 20, y: 140 },
    ];
    const world: CorridorWorld = {
      ...emptyWorld(),
      entities: points.slice(1, -1).map((point, index) => {
        const next = points[index + 2];
        return {
          id: `block-${index}`,
          x: (point.x + next.x) / 2 - 5,
          y: (point.y + next.y) / 2 - 5,
          width: 10,
          height: 10,
        };
      }),
    };
    const routes = [route(0, 20, points)];
    const result = placeLabels(world, routes, specs(routes, 20, 20));

    expect(result.placements[0]).toEqual(
      expect.objectContaining({
        rect: { x: 40, y: 100, width: 20, height: 20 },
        host: { kind: 'segment', segmentIndex: 6 },
        tier: 'on-line',
      }),
    );
  });

  it('centers in the longest clear interval before considering a jog', () => {
    const world: CorridorWorld = {
      ...emptyWorld(),
      entities: [{ id: 'middle-block', x: 130, y: 90, width: 40, height: 20 }],
    };
    const routes = [route(0, 100)];
    const result = placeLabels(world, routes, specs(routes, 40, 20));

    expect(result.placements[0]).toEqual(
      expect.objectContaining({
        rect: { x: 45, y: 90, width: 40, height: 20 },
        host: { kind: 'segment', segmentIndex: 0 },
        tier: 'on-line',
      }),
    );
    expect(result.routePoints[0]).toEqual(routes[0].points());
  });

  it('prefers a wall-bounded clear-space center over an asymmetric segment midpoint', () => {
    const world: CorridorWorld = {
      ...emptyWorld(),
      entities: [
        { id: 'left-group', x: 0, y: 0, width: 100, height: 200, isContainer: true },
        { id: 'right-group', x: 250, y: 0, width: 50, height: 200, isContainer: true },
      ],
    };
    const routes = [
      route(0, 100, [
        { x: 80, y: 100 },
        { x: 300, y: 100 },
      ]),
    ];
    const result = placeLabels(world, routes, specs(routes, 40, 20));

    expect(result.placements[0]).toEqual(
      expect.objectContaining({
        rect: { x: 155, y: 90, width: 40, height: 20 },
        host: { kind: 'segment', segmentIndex: 0 },
        tier: 'on-line',
      }),
    );
  });

  it('does not mutate a route solely to move text away from a container wall', () => {
    const world = adjacentCorridorWorld(true);
    const routes = [route(0, 46)];
    const result = placeLabels(world, routes, specs(routes));

    expect(result.placements[0]).toEqual(
      expect.objectContaining({
        rect: { x: 120, y: 36, width: 60, height: 20 },
        host: { kind: 'segment', segmentIndex: 0 },
        tier: 'on-line',
      }),
    );
    expect(result.routePoints[0]).toEqual(routes[0].points());
  });

  it('reserves arrowhead space only at the target end in either direction', () => {
    const place = (points: readonly XYPoint[]) => {
      const routes = [route(0, 100, points)];
      return placeLabels(emptyWorld(), routes, specs(routes, 20, 20)).placements[0];
    };

    expect(
      place([
        { x: 100, y: 100 },
        { x: 132, y: 100 },
      ]),
    ).toEqual(
      expect.objectContaining({
        rect: { x: 100, y: 90, width: 20, height: 20 },
        tier: 'on-line',
      }),
    );
    expect(
      place([
        { x: 132, y: 100 },
        { x: 100, y: 100 },
      ]),
    ).toEqual(
      expect.objectContaining({
        rect: { x: 112, y: 90, width: 20, height: 20 },
        tier: 'on-line',
      }),
    );
  });

  it('retains an interior segment that exactly fits bend clearance', () => {
    const routes = [
      route(0, 20, [
        { x: 20, y: 20 },
        { x: 30, y: 20 },
        { x: 30, y: 48 },
        { x: 40, y: 48 },
      ]),
    ];
    const result = placeLabels(emptyWorld(), routes, specs(routes, 20, 20));

    expect(result.placements[0]).toEqual(
      expect.objectContaining({
        rect: { x: 20, y: 24, width: 20, height: 20 },
        host: { kind: 'segment', segmentIndex: 1 },
        tier: 'on-line',
      }),
    );
  });

  it('uses the exact-distance offline fallback only when no segment fits', () => {
    const routes = [
      route(0, 100, [
        { x: 100, y: 100 },
        { x: 131, y: 100 },
      ]),
    ];
    const result = placeLabels(emptyWorld(), routes, specs(routes, 20, 20));

    expect(result.placements[0]).toEqual(
      expect.objectContaining({
        host: { kind: 'offline', anchor: { x: 115.5, y: 100 } },
        tier: 'offline',
      }),
    );
    expect(result.routePoints[0]).toEqual(routes[0].points());
  });

  it('centers offline fallback over a straight run split across corridor visits', () => {
    const routes = [
      route(0, 100, [
        { x: 100, y: 100 },
        { x: 140, y: 100 },
        { x: 170, y: 100 },
        { x: 210, y: 100 },
      ]),
    ];
    const result = placeLabels(emptyWorld(), routes, specs(routes, 109, 16));

    expect(result.placements[0]).toEqual(
      expect.objectContaining({
        host: { kind: 'offline', anchor: { x: 155, y: 100 } },
        tier: 'offline',
      }),
    );
  });

  it('does not displace a label solely to avoid another route', () => {
    const routes = [route(0, 100), route(1, 100)];
    const result = placeLabels(emptyWorld(), routes, [
      { routeIndex: 0, size: { width: 60, height: 20 } },
    ]);

    expect(result.placements[0]).toEqual(
      expect.objectContaining({ host: { kind: 'segment', segmentIndex: 0 }, tier: 'on-line' }),
    );
    expect(result.routePoints[0]).toEqual(routes[0].points());
  });

  it('uses a certified displacement to separate overlapping labels', () => {
    const routes = [route(0, 100), route(1, 101)];
    const result = placeLabels(emptyWorld(), routes, specs(routes, 60, 30));

    expect(rectsOverlap(result.placements[0].rect, result.placements[1].rect)).toBe(false);
    expect(
      result.placements.some(
        (placement) => placement.tier === 'on-line' && placement.host.displacement !== undefined,
      ),
    ).toBe(true);
  });

  it('does not use a touching corridor across a container wall', () => {
    const world = adjacentCorridorWorld(true);
    const routes = [route(0, 23), route(1, 24)];
    const result = placeLabels(world, routes, specs(routes, 60, 32));

    expect(result.routePoints.every((points) => points.every(({ y }) => y <= 46 + 1e-6))).toBe(
      true,
    );
  });

  it('aligns compatible labels after every segment candidate is known', () => {
    const routes = [
      route(0, 50, [
        { x: 0, y: 50 },
        { x: 200, y: 50 },
      ]),
      route(1, 100, [
        { x: 8, y: 100 },
        { x: 208, y: 100 },
      ]),
    ];
    const result = placeLabels(emptyWorld(), routes, specs(routes, 40, 20));

    expect(result.placements.map((placement) => placement.tier)).toEqual(['on-line', 'on-line']);
    expect(result.placements[0].rect.x).toBe(result.placements[1].rect.x);
  });

  it('keeps a geometrically fitting label online even when its only spot is imperfect', () => {
    const world: CorridorWorld = {
      ...emptyWorld(),
      entities: [{ id: 'block', x: 120, y: 90, width: 60, height: 20 }],
    };
    const routes = [
      route(0, 100, [
        { x: 120, y: 100 },
        { x: 180, y: 100 },
      ]),
    ];
    const result = placeLabels(world, routes, specs(routes, 40, 20));

    expect(result.placements[0].tier).toBe('on-line');
  });
});

function rectsOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x) > 1e-6 &&
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y) > 1e-6
  );
}
