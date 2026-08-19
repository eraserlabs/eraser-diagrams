import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutEntity } from '../../types.js';
import { CorridorIndexer } from '../corridor/corridorIndex.js';
import type { Corridor, TerminalAttachment, PortalRef } from '../corridor/contract.js';
import { emitRoutes } from '../corridor/emit.js';
import { orderRoutes } from '../corridor/ordering.js';
import { Route, type CorridorVisit } from '../corridor/route.js';
import { spaceRoutes } from '../corridor/spacing.js';
import type { CorridorWorld } from '../corridor/world.js';

function leaf(id: string, x: number, y: number, width: number, height: number): LayoutEntity {
  return { id, x, y, width, height };
}

function cornerWorld(): CorridorWorld {
  const entities = [leaf('from', 0, 0, 40, 40), leaf('to', 80, 100, 40, 40)];
  const corridors: Corridor[] = [
    { index: 0, axis: 'x', rect: { x: 40, y: 0, width: 80, height: 40 } },
    { index: 1, axis: 'y', rect: { x: 80, y: 0, width: 40, height: 100 } },
  ];
  const portals: PortalRef[] = [
    {
      index: 0,
      kind: 'turn',
      xCorridorIndex: 0,
      yCorridorIndex: 1,
      rect: { x: 80, y: 0, width: 40, height: 40 },
    },
  ];
  const attachments: TerminalAttachment[] = [
    { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 40] },
    { index: 1, entityIndex: 1, face: 'up', corridorIndex: 1, faceSpan: [80, 120] },
  ];
  return manualWorld(entities, corridors, portals, attachments);
}

function cornerRoute(authored = false): Route {
  const visits: CorridorVisit[] = [
    {
      corridorIndex: 0,
      entry: { kind: 'terminal', attachmentIndex: 0 },
      exit: { kind: 'portal', portalIndex: 0, mode: 'turn' },
      feasibleTrack: authored ? [20.5, 20.5] : [0, 40],
    },
    {
      corridorIndex: 1,
      entry: { kind: 'portal', portalIndex: 0, mode: 'turn' },
      exit: { kind: 'terminal', attachmentIndex: 1 },
      feasibleTrack: authored ? [100.5, 100.5] : [80, 120],
    },
  ];
  return new Route(
    0,
    { entityIndex: 0, face: 'right', ...(authored ? { authoredTrack: 20.5 } : {}) },
    { entityIndex: 1, face: 'up', ...(authored ? { authoredTrack: 100.5 } : {}) },
    visits,
  );
}

function manualWorld(
  entities: readonly LayoutEntity[],
  corridors: readonly Corridor[],
  portals: readonly PortalRef[],
  attachments: readonly TerminalAttachment[],
): CorridorWorld {
  const bounds = { x: -20, y: -20, width: 360, height: 180 };
  return {
    bounds,
    entities,
    indexer: new CorridorIndexer(
      corridors,
      portals,
      attachments,
      new LayoutManager({ entities: [...entities], connections: [] }),
      bounds,
    ),
  };
}

function realize(world: CorridorWorld, routes: readonly Route[]) {
  const ordering = orderRoutes(world, routes);
  const spacing = spaceRoutes(world, routes, ordering);
  emitRoutes(world, routes);
  return spacing;
}

describe('routing corridor mechanical emission', () => {
  it('combines adjacent tracks into a corner inside the shared transfer', () => {
    const world = cornerWorld();
    const route = cornerRoute();

    realize(world, [route]);

    expect(route.points()).toEqual([
      { x: 40, y: 20 },
      { x: 100, y: 20 },
      { x: 100, y: 100 },
    ]);
    expect(route.ports()).toEqual({
      from: { x: 40, y: route.nominalTrackOf(0) },
      to: { x: route.nominalTrackOf(1), y: 100 },
    });
  });

  it('keeps authored fractional tracks exact through the transfer corner', () => {
    const world = cornerWorld();
    const route = cornerRoute(true);

    const spacing = realize(world, [route]);

    expect(route.points()).toEqual([
      { x: 40, y: 20.5 },
      { x: 100.5, y: 20.5 },
      { x: 100.5, y: 100 },
    ]);
    expect(route.ports().from.y).toBe(route.nominalTrackOf(0));
    expect(route.ports().to.x).toBe(route.nominalTrackOf(1));
    expect(spacing.shortfalls).toEqual([]);
  });

  it('keeps visit boundaries when a zero-length visit leaves collinear runs', () => {
    const entities = [leaf('from', 0, 0, 10, 20), leaf('to', 100, 0, 10, 20)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 10, y: 0, width: 40, height: 20 } },
      { index: 1, axis: 'y', rect: { x: 40, y: 0, width: 20, height: 20 } },
      { index: 2, axis: 'x', rect: { x: 40, y: 0, width: 60, height: 20 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 1,
        rect: { x: 40, y: 0, width: 10, height: 20 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 2,
        yCorridorIndex: 1,
        rect: { x: 40, y: 0, width: 20, height: 20 },
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 2, faceSpan: [0, 20] },
    ];
    const route = new Route(
      0,
      { entityIndex: 0, face: 'right' },
      { entityIndex: 1, face: 'left' },
      [
        {
          corridorIndex: 0,
          entry: { kind: 'terminal', attachmentIndex: 0 },
          exit: { kind: 'portal', portalIndex: 0, mode: 'turn' },
          feasibleTrack: [0, 20],
        },
        {
          corridorIndex: 1,
          entry: { kind: 'portal', portalIndex: 0, mode: 'turn' },
          exit: { kind: 'portal', portalIndex: 1, mode: 'turn' },
          feasibleTrack: [40, 50],
        },
        {
          corridorIndex: 2,
          entry: { kind: 'portal', portalIndex: 1, mode: 'turn' },
          exit: { kind: 'terminal', attachmentIndex: 1 },
          feasibleTrack: [0, 20],
        },
      ],
    );

    realize(manualWorld(entities, corridors, portals, attachments), [route]);

    expect(route.points()).toEqual([
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 100, y: 10 },
    ]);
    expect(route.segmentVisitOf(0)).toBe(0);
    expect(route.segmentVisitOf(1)).toBe(2);
  });

  it('emits deterministic cardinal geometry without duplicate points', () => {
    const signature = (): string => {
      const world = cornerWorld();
      const route = cornerRoute();
      realize(world, [route]);
      return JSON.stringify(route.points());
    };
    const expected = signature();

    for (let iteration = 0; iteration < 10; iteration += 1) {
      expect(signature()).toBe(expected);
    }
  });
});
