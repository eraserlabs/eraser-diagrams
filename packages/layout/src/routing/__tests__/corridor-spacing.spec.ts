import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutEntity } from '../../types.js';
import { CorridorIndexer } from '../corridor/corridorIndex.js';
import type {
  Corridor,
  PortalRef,
  RouteEndpoint,
  TerminalAttachment,
} from '../corridor/contract.js';
import { orderRoutes } from '../corridor/ordering.js';
import { Route, type CorridorVisit } from '../corridor/route.js';
import { MIN_TRACK_SEPARATION_PX, spaceRoutes, type SpacingOptions } from '../corridor/spacing.js';
import type { CorridorWorld } from '../corridor/world.js';

function leaf(id: string, x: number, y: number, width: number, height: number): LayoutEntity {
  return { id, x, y, width, height };
}

function directWorld(y = 0, height = 120): CorridorWorld {
  const entities = [leaf('from', 0, y, 40, height), leaf('to', 200, y, 40, height)];
  const corridors: Corridor[] = [{ index: 0, axis: 'x', rect: { x: 40, y, width: 160, height } }];
  const attachments: TerminalAttachment[] = [
    { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [y, y + height] },
    { index: 1, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [y, y + height] },
  ];
  return {
    bounds: { x: -20, y: y - 20, width: 280, height: height + 40 },
    entities,
    indexer: new CorridorIndexer(
      corridors,
      [],
      attachments,
      new LayoutManager({ entities: [...entities], connections: [] }),
      { x: -20, y: y - 20, width: 280, height: height + 40 },
    ),
  };
}

function directRoute(
  requestIndex: number,
  span: readonly [number, number],
  from: Partial<RouteEndpoint> = {},
  to: Partial<RouteEndpoint> = {},
): Route {
  const visits: CorridorVisit[] = [
    {
      corridorIndex: 0,
      entry: { kind: 'terminal', attachmentIndex: 0 },
      exit: { kind: 'terminal', attachmentIndex: 1 },
      feasibleTrack: span,
    },
  ];
  return new Route(
    requestIndex,
    { entityIndex: 0, face: 'right', ...from },
    { entityIndex: 1, face: 'left', ...to },
    visits,
  );
}

function splitFaceTurnWorld(
  sourceEndpoints: readonly [Partial<RouteEndpoint>, Partial<RouteEndpoint>] = [{}, {}],
): { world: CorridorWorld; routes: Route[] } {
  const entities = [
    leaf('hub', 0, 0, 40, 100),
    leaf('top-target', 100, 180, 20, 20),
    leaf('bottom-target', 80, 220, 20, 20),
  ];
  const corridors: Corridor[] = [
    { index: 0, axis: 'x', rect: { x: 40, y: 0, width: 80, height: 60 } },
    { index: 1, axis: 'x', rect: { x: 40, y: 40, width: 60, height: 60 } },
    { index: 2, axis: 'y', rect: { x: 100, y: 40, width: 20, height: 140 } },
    { index: 3, axis: 'y', rect: { x: 80, y: 80, width: 20, height: 140 } },
  ];
  const portals: PortalRef[] = [
    {
      index: 0,
      kind: 'turn',
      xCorridorIndex: 0,
      yCorridorIndex: 2,
      rect: { x: 100, y: 40, width: 20, height: 20 },
    },
    {
      index: 1,
      kind: 'turn',
      xCorridorIndex: 1,
      yCorridorIndex: 3,
      rect: { x: 80, y: 80, width: 20, height: 20 },
    },
  ];
  const attachments: TerminalAttachment[] = [
    { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 60] },
    { index: 1, entityIndex: 0, face: 'right', corridorIndex: 1, faceSpan: [40, 100] },
    { index: 2, entityIndex: 1, face: 'up', corridorIndex: 2, faceSpan: [100, 120] },
    { index: 3, entityIndex: 2, face: 'up', corridorIndex: 3, faceSpan: [80, 100] },
  ];
  const routes = [
    new Route(
      0,
      { entityIndex: 0, face: 'right', ...sourceEndpoints[0] },
      { entityIndex: 1, face: 'up' },
      [
        {
          corridorIndex: 0,
          entry: { kind: 'terminal', attachmentIndex: 0 },
          exit: { kind: 'portal', portalIndex: 0, mode: 'turn' },
          feasibleTrack: [0, 60],
        },
        {
          corridorIndex: 2,
          entry: { kind: 'portal', portalIndex: 0, mode: 'turn' },
          exit: { kind: 'terminal', attachmentIndex: 2 },
          feasibleTrack: [100, 120],
        },
      ],
    ),
    new Route(
      1,
      { entityIndex: 0, face: 'right', ...sourceEndpoints[1] },
      { entityIndex: 2, face: 'up' },
      [
        {
          corridorIndex: 1,
          entry: { kind: 'terminal', attachmentIndex: 1 },
          exit: { kind: 'portal', portalIndex: 1, mode: 'turn' },
          feasibleTrack: [40, 100],
        },
        {
          corridorIndex: 3,
          entry: { kind: 'portal', portalIndex: 1, mode: 'turn' },
          exit: { kind: 'terminal', attachmentIndex: 3 },
          feasibleTrack: [80, 100],
        },
      ],
    ),
  ];
  const bounds = { x: -20, y: -20, width: 180, height: 280 };
  return {
    world: {
      bounds,
      entities,
      indexer: new CorridorIndexer(
        corridors,
        portals,
        attachments,
        new LayoutManager({ entities: [...entities], connections: [] }),
        bounds,
      ),
    },
    routes,
  };
}

function continuationWorld(decoyWallY?: number): { world: CorridorWorld; route: Route } {
  const entities = [
    leaf('from', 620, 0, 60, 20),
    leaf('to', 660, 180, 80, 20),
    leaf('overlapping-wall', 645, 100, 10, 80),
    ...(decoyWallY === undefined ? [] : [leaf('decoy-wall', 675, decoyWallY, 10, 40)]),
  ];
  const corridors: Corridor[] = [
    { index: 0, axis: 'y', rect: { x: 655, y: 20, width: 20, height: 80 } },
    { index: 1, axis: 'y', rect: { x: 655, y: 100, width: 20, height: 200 } },
  ];
  const portals: PortalRef[] = [
    {
      index: 0,
      kind: 'continue',
      axis: 'y',
      negativeCorridorIndex: 0,
      positiveCorridorIndex: 1,
      planeCoordinate: 100,
      crossSpan: [655, 675],
    },
  ];
  const attachments: TerminalAttachment[] = [
    { index: 0, entityIndex: 0, face: 'down', corridorIndex: 0, faceSpan: [655, 675] },
    { index: 1, entityIndex: 1, face: 'up', corridorIndex: 1, faceSpan: [655, 675] },
  ];
  const route = new Route(0, { entityIndex: 0, face: 'down' }, { entityIndex: 1, face: 'up' }, [
    {
      corridorIndex: 0,
      entry: { kind: 'terminal', attachmentIndex: 0 },
      exit: { kind: 'portal', portalIndex: 0, mode: 'continue-straight' },
      feasibleTrack: [655, 675],
    },
    {
      corridorIndex: 1,
      entry: { kind: 'portal', portalIndex: 0, mode: 'continue-straight' },
      exit: { kind: 'terminal', attachmentIndex: 1 },
      feasibleTrack: [655, 675],
    },
  ]);
  return {
    world: {
      bounds: { x: 600, y: -20, width: 160, height: 340 },
      entities,
      indexer: new CorridorIndexer(
        corridors,
        portals,
        attachments,
        new LayoutManager({ entities: [...entities], connections: [] }),
        { x: 600, y: -20, width: 160, height: 340 },
      ),
    },
    route,
  };
}

function wideningContinuationWorld(
  targetX = 660,
  wideCorridorEndX = targetX + 20,
): { world: CorridorWorld; route: Route } {
  const entities = [leaf('from', 640, 0, 20, 20), leaf('to', targetX, 180, 20, 20)];
  const corridors: Corridor[] = [
    { index: 0, axis: 'y', rect: { x: 640, y: 20, width: 20, height: 80 } },
    {
      index: 1,
      axis: 'y',
      rect: { x: 640, y: 100, width: wideCorridorEndX - 640, height: 80 },
    },
  ];
  const portals: PortalRef[] = [
    {
      index: 0,
      kind: 'continue',
      axis: 'y',
      negativeCorridorIndex: 0,
      positiveCorridorIndex: 1,
      planeCoordinate: 100,
      crossSpan: [640, 660],
    },
  ];
  const attachments: TerminalAttachment[] = [
    { index: 0, entityIndex: 0, face: 'down', corridorIndex: 0, faceSpan: [640, 660] },
    {
      index: 1,
      entityIndex: 1,
      face: 'up',
      corridorIndex: 1,
      faceSpan: [targetX, targetX + 20],
    },
  ];
  const route = new Route(0, { entityIndex: 0, face: 'down' }, { entityIndex: 1, face: 'up' }, [
    {
      corridorIndex: 0,
      entry: { kind: 'terminal', attachmentIndex: 0 },
      exit: { kind: 'portal', portalIndex: 0, mode: 'continue-straight' },
      feasibleTrack: [640, 660],
    },
    {
      corridorIndex: 1,
      entry: { kind: 'portal', portalIndex: 0, mode: 'continue-straight' },
      exit: { kind: 'terminal', attachmentIndex: 1 },
      feasibleTrack: [targetX, targetX + 20],
    },
  ]);
  return {
    world: {
      bounds: { x: 620, y: -20, width: 80, height: 240 },
      entities,
      indexer: new CorridorIndexer(
        corridors,
        portals,
        attachments,
        new LayoutManager({ entities: [...entities], connections: [] }),
        { x: 620, y: -20, width: 80, height: 240 },
      ),
    },
    route,
  };
}

function orderAndSpace(
  world: CorridorWorld,
  routes: readonly Route[],
  options: SpacingOptions = {},
) {
  const ordering = orderRoutes(world, routes);
  return {
    ordering,
    spacing: spaceRoutes(world, routes, ordering, options),
  };
}

describe('routing corridor corridor-local spacing', () => {
  it('centers terminal visits in their ordinary corridor order', () => {
    const singleWorld = directWorld();
    const single = directRoute(0, [0, 120]);
    orderAndSpace(singleWorld, [single]);
    expect(single.nominalTrackOf(0)).toBe(60);

    const sharedWorld = directWorld();
    const shared = [0, 1, 2].map((requestIndex) => directRoute(requestIndex, [0, 120]));
    const { spacing } = orderAndSpace(sharedWorld, shared);

    expect(shared.map((route) => route.nominalTrackOf(0))).toEqual([44, 60, 76]);
    expect(spacing.shortfalls).toEqual([]);
  });

  it('uses one face-wide fan across selected corridor slices', () => {
    const entities = [
      leaf('hub', 0, 0, 40, 100),
      leaf('top', 200, 0, 40, 40),
      leaf('bottom', 200, 60, 40, 40),
    ];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 40, y: 0, width: 160, height: 40 } },
      { index: 1, axis: 'x', rect: { x: 40, y: 60, width: 160, height: 40 } },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 40] },
      { index: 1, entityIndex: 0, face: 'right', corridorIndex: 1, faceSpan: [60, 100] },
      { index: 2, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [0, 40] },
      { index: 3, entityIndex: 2, face: 'left', corridorIndex: 1, faceSpan: [60, 100] },
    ];
    const world: CorridorWorld = {
      bounds: { x: -20, y: -20, width: 280, height: 140 },
      entities,
      indexer: new CorridorIndexer(
        corridors,
        [],
        attachments,
        new LayoutManager({ entities: [...entities], connections: [] }),
        { x: -20, y: -20, width: 280, height: 140 },
      ),
    };
    const routes = [
      new Route(0, { entityIndex: 0, face: 'right' }, { entityIndex: 1, face: 'left' }, [
        {
          corridorIndex: 0,
          entry: { kind: 'terminal', attachmentIndex: 0 },
          exit: { kind: 'terminal', attachmentIndex: 2 },
          feasibleTrack: [0, 40],
        },
      ]),
      new Route(1, { entityIndex: 0, face: 'right' }, { entityIndex: 2, face: 'left' }, [
        {
          corridorIndex: 1,
          entry: { kind: 'terminal', attachmentIndex: 1 },
          exit: { kind: 'terminal', attachmentIndex: 3 },
          feasibleTrack: [60, 100],
        },
      ]),
    ];

    orderAndSpace(world, routes);

    expect(routes.map((route) => route.nominalTrackOf(0))).toEqual([26, 74]);
  });

  it('orders centered face targets across distinct terminal corridors', () => {
    const { world, routes } = splitFaceTurnWorld();

    const { spacing } = orderAndSpace(world, routes);

    expect(routes.map((route) => route.nominalTrackOf(0))).toEqual([42, 58]);
    expect(spacing.shortfalls).toEqual([]);
  });

  it('gives one face target to a port group split across terminal corridors', () => {
    const { world, routes } = splitFaceTurnWorld([{ portGroup: 7 }, { portGroup: 7 }]);

    const { spacing } = orderAndSpace(world, routes);

    expect(routes.map((route) => route.nominalTrackOf(0))).toEqual([50, 50]);
    expect(spacing.shortfalls).toEqual([]);
  });

  it('keeps an authored face track exact inside the face-wide policy', () => {
    const { world, routes } = splitFaceTurnWorld([{ authoredTrack: 5 }, {}]);

    const { spacing } = orderAndSpace(world, routes);

    expect(routes[0].nominalTrackOf(0)).toBe(5);
    expect(routes[0].visits[0].feasibleTrack).toEqual([0, 60]);
    expect(spacing.shortfalls).toEqual([]);
  });

  it('projects explicitly combined ports as one equality unit', () => {
    const world = directWorld();
    const routes = [
      directRoute(0, [0, 120], { portGroup: 7 }),
      directRoute(1, [0, 120], { portGroup: 7 }),
      directRoute(2, [0, 120]),
    ];

    const { spacing } = orderAndSpace(world, routes);

    expect(routes[0].nominalTrackOf(0)).toBe(routes[1].nominalTrackOf(0));
    expect(routes[2].nominalTrackOf(0) - routes[1].nominalTrackOf(0)).toBeGreaterThanOrEqual(
      MIN_TRACK_SEPARATION_PX,
    );
    expect(spacing.shortfalls).toEqual([]);
    expect(spacing.quality.events.filter((event) => event.kind === 'line-merge')).toEqual([]);
  });

  it('reports one shortfall when a combined group cannot be made contiguous', () => {
    const world = directWorld();
    const routes = [
      directRoute(0, [0, 120], { portGroup: 7 }),
      directRoute(1, [0, 120]),
      directRoute(2, [0, 120], { portGroup: 7 }),
    ];

    const { spacing } = orderAndSpace(world, routes);
    const combinedShortfalls = spacing.shortfalls.filter(
      (shortfall) => shortfall.kind === 'combined-port',
    );

    expect(combinedShortfalls).toHaveLength(1);
    expect(combinedShortfalls[0].routeIndexes).toEqual([0, 2]);
  });

  it('attributes a narrow-corridor separation shortfall without leaving bounds', () => {
    const world = directWorld(0, 10);
    const routes = [0, 1, 2].map((requestIndex) => directRoute(requestIndex, [0, 10]));

    const { spacing } = orderAndSpace(world, routes);
    const tracks = routes.map((route) => route.nominalTrackOf(0));

    expect(tracks).toEqual([...tracks].sort((left, right) => left - right));
    expect(tracks.every((track) => track >= 0 && track <= 10)).toBe(true);
    expect(spacing.shortfalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'minimum-separation',
          required: MIN_TRACK_SEPARATION_PX,
        }),
      ]),
    );
    expect(spacing.quality.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'spacing-deficit',
          corridorIndexes: [0],
        }),
      ]),
    );
  });

  it('preserves an authored fractional track as the endpoint-track alias', () => {
    const world = directWorld(340, 20);
    const route = directRoute(
      0,
      [346.5, 346.5],
      { authoredTrack: 346.5 },
      { authoredTrack: 346.5 },
    );

    const { spacing } = orderAndSpace(world, [route]);

    expect(route.nominalTrackOf(0)).toBe(346.5);
    expect(spacing.shortfalls).toEqual([]);
  });

  it('is deterministic across fresh route instances', () => {
    const signature = (): string => {
      const world = directWorld();
      const routes = [0, 1, 2, 3].map((requestIndex) => directRoute(requestIndex, [0, 120]));
      const { spacing } = orderAndSpace(world, routes);
      return JSON.stringify({
        tracks: routes.map((route) => route.nominalTrackOf(0)),
        shortfalls: spacing.shortfalls,
        quality: spacing.quality,
      });
    };
    const expected = signature();

    for (let iteration = 0; iteration < 10; iteration += 1) {
      expect(signature()).toBe(expected);
    }
  });

  it('reuses a centered track for disjoint travel without changing stable order', () => {
    const entities = [
      leaf('a-from', 0, 0, 10, 100),
      leaf('a-to', 90, 0, 10, 100),
      leaf('b-from', 200, 0, 10, 100),
      leaf('b-to', 290, 0, 10, 100),
    ];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 10, y: 0, width: 280, height: 100 } },
    ];
    const attachments: TerminalAttachment[] = entities.map((_, index) => ({
      index,
      entityIndex: index,
      face: index % 2 === 0 ? 'right' : 'left',
      corridorIndex: 0,
      faceSpan: [0, 100],
    }));
    const visits = (entry: number, exit: number): CorridorVisit[] => [
      {
        corridorIndex: 0,
        entry: { kind: 'terminal', attachmentIndex: entry },
        exit: { kind: 'terminal', attachmentIndex: exit },
        feasibleTrack: [0, 100],
      },
    ];
    const routes = [
      new Route(
        0,
        { entityIndex: 0, face: 'right' },
        { entityIndex: 1, face: 'left' },
        visits(0, 1),
      ),
      new Route(
        1,
        { entityIndex: 2, face: 'right' },
        { entityIndex: 3, face: 'left' },
        visits(2, 3),
      ),
    ];
    const world: CorridorWorld = {
      bounds: { x: -20, y: -20, width: 340, height: 140 },
      entities,
      indexer: new CorridorIndexer(
        corridors,
        [],
        attachments,
        new LayoutManager({ entities: [...entities], connections: [] }),
        { x: -20, y: -20, width: 340, height: 140 },
      ),
    };

    const { ordering, spacing } = orderAndSpace(world, routes);

    expect(ordering.groups[0].members.map((member) => member.order)).toEqual([0, 1]);
    expect(routes.map((route) => route.nominalTrackOf(0))).toEqual([50, 50]);
    expect(spacing.shortfalls).toEqual([]);
    expect(spacing.quality.events).toEqual([]);
  });

  it('caps coincident travel that is not one explicit equality unit', () => {
    const world = directWorld();
    const routes = [0, 1].map((requestIndex) =>
      directRoute(requestIndex, [60, 60], { authoredTrack: 60 }, { authoredTrack: 60 }),
    );

    const { spacing } = orderAndSpace(world, routes);
    const merge = spacing.quality.events.find((event) => event.kind === 'line-merge');

    expect(routes.map((route) => route.nominalTrackOf(0))).toEqual([60, 60]);
    expect(merge).toMatchObject({
      corridorIndexes: [0],
      routeIndexes: [0, 1],
    });
    expect(spacing.quality.cost.cap).toBe(1);
    expect(spacing.quality.cost.scalar).toBeGreaterThan(0);
  });

  it('keeps terminal centering dominant over leaf clearance', () => {
    const baseWorld = directWorld(0, 32);
    const world = {
      ...baseWorld,
      entities: [...baseWorld.entities, leaf('foreign-wall', 60, -10, 100, 10)],
    };
    const route = directRoute(0, [0, 32]);

    const { spacing } = orderAndSpace(world, [route]);

    expect(route.nominalTrackOf(0)).toBe(16);
    expect(spacing.shortfalls).toEqual([]);
  });

  it('keeps narrow terminal centering dominant over leaf clearance', () => {
    const baseWorld = directWorld(0, 20);
    const world = {
      ...baseWorld,
      entities: [...baseWorld.entities, leaf('foreign-wall', 60, -10, 100, 10)],
    };
    const route = directRoute(0, [0, 20]);

    const { spacing } = orderAndSpace(world, [route]);

    expect(route.nominalTrackOf(0)).toBe(10);
    expect(spacing.shortfalls).toEqual([]);
  });

  it('computes leaf clearance after corridor-local terminal desires join a continuation unit', () => {
    const { world, route } = continuationWorld();

    const { spacing } = orderAndSpace(world, [route]);

    expect([route.nominalTrackOf(0), route.nominalTrackOf(1)]).toEqual([669, 669]);
    expect(spacing.shortfalls).toEqual([]);
  });

  it('removes equality when padded continuation bounds do not intersect', () => {
    const { world, route } = wideningContinuationWorld();

    const { spacing } = orderAndSpace(world, [route]);

    expect([route.nominalTrackOf(0), route.nominalTrackOf(1)]).toEqual([650, 670]);
    expect(route.boundaryRealizationAfter(1)?.kind).toBe('continue-retrack');
    expect(spacing.continuations).toMatchObject([
      { policy: 'independent', reason: 'empty-padded-intersection', afterVisitIndex: 1 },
    ]);
  });

  it('solves a requested continuation independently', () => {
    const { world, route } = wideningContinuationWorld();

    const { spacing } = orderAndSpace(world, [route], {
      independentContinuations: [{ routeIndex: 0, afterVisitIndex: 1 }],
    });

    expect([route.nominalTrackOf(0), route.nominalTrackOf(1)]).toEqual([650, 670]);
    expect(route.boundaryRealizationAfter(1)?.kind).toBe('continue-retrack');
    expect(spacing.continuations).toMatchObject([
      { policy: 'independent', reason: 'forced-independent', afterVisitIndex: 1 },
    ]);
  });

  it('keeps equal-span continuation tracks equal under automatic policy', () => {
    const { world, route } = continuationWorld();

    const { spacing } = orderAndSpace(world, [route]);

    expect(route.nominalTrackOf(0)).toBe(route.nominalTrackOf(1));
    expect(route.boundaryRealizationAfter(1)).toBeUndefined();
    expect(spacing.continuations).toMatchObject([
      { policy: 'equal', reason: 'equal-span', afterVisitIndex: 1 },
    ]);
  });

  it('removes equality when narrow-to-wide continuation bounds do not intersect', () => {
    const { world, route } = wideningContinuationWorld(670);

    const { spacing } = orderAndSpace(world, [route]);

    expect([route.nominalTrackOf(0), route.nominalTrackOf(1)]).toEqual([650, 680]);
    expect(route.boundaryRealizationAfter(1)?.kind).toBe('continue-retrack');
    expect(spacing.continuations).toMatchObject([
      { policy: 'independent', reason: 'empty-padded-intersection' },
    ]);
  });

  it('keeps a satisfiable narrow-to-wide continuation equal despite the span difference', () => {
    const { world, route } = wideningContinuationWorld(640, 690);

    const { spacing } = orderAndSpace(world, [route]);

    expect(spacing.continuations).toMatchObject([
      { policy: 'equal', reason: 'default-equal', afterVisitIndex: 1 },
    ]);
    expect(route.nominalTrackOf(0)).toBe(route.nominalTrackOf(1));
    expect(route.boundaryRealizationAfter(1)).toBeUndefined();
  });

  it('ignores a member-corridor leaf wall outside the member travel interval', () => {
    const outside = continuationWorld(220);
    const overlapping = continuationWorld(120);

    orderAndSpace(outside.world, [outside.route]);
    orderAndSpace(overlapping.world, [overlapping.route]);

    expect(outside.route.nominalTrackOf(0)).toBe(669);
    expect(overlapping.route.nominalTrackOf(0)).toBe(669);
  });
});
