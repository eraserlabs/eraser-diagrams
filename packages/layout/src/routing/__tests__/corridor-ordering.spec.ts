import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutEntity } from '../../types.js';
import { CorridorIndexer } from '../corridor/corridorIndex.js';
import type { Corridor, PortalRef, TerminalAttachment } from '../corridor/contract.js';
import { orderRoutes } from '../corridor/ordering.js';
import { Route, type CorridorVisit } from '../corridor/route.js';
import type { CorridorWorld } from '../corridor/world.js';

function leaf(id: string, x: number, y: number, width: number, height: number): LayoutEntity {
  return { id, x, y, width, height };
}

function world(
  entities: readonly LayoutEntity[],
  corridors: readonly Corridor[],
  portals: readonly PortalRef[],
  attachments: readonly TerminalAttachment[],
): CorridorWorld {
  const bounds = { x: -100, y: -100, width: 400, height: 400 };
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

function route(
  requestIndex: number,
  from: Route['from'],
  to: Route['to'],
  visits: readonly CorridorVisit[],
): Route {
  return new Route(requestIndex, from, to, visits);
}

describe('routing corridor ordering', () => {
  it('fans a shared face toward opposite endpoints in geometric order', () => {
    const entities = [
      leaf('hub', 0, 0, 40, 120),
      leaf('top', 200, 0, 20, 20),
      leaf('middle', 200, 50, 20, 20),
      leaf('bottom', 200, 100, 20, 20),
    ];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 40, y: 0, width: 160, height: 120 } },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 120] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 2, entityIndex: 2, face: 'left', corridorIndex: 0, faceSpan: [50, 70] },
      { index: 3, entityIndex: 3, face: 'left', corridorIndex: 0, faceSpan: [100, 120] },
    ];
    const routes = [0, 1, 2].map((requestIndex) =>
      route(
        requestIndex,
        { entityIndex: 0, face: 'right' },
        { entityIndex: requestIndex + 1, face: 'left' },
        [
          {
            corridorIndex: 0,
            entry: { kind: 'terminal', attachmentIndex: 0 },
            exit: { kind: 'terminal', attachmentIndex: requestIndex + 1 },
            feasibleTrack: [0, 120],
          },
        ],
      ),
    );

    const result = orderRoutes(world(entities, corridors, [], attachments), routes);

    expect(result.groups[0].members.map((member) => member.routeIndex)).toEqual([0, 1, 2]);
    expect(routes.map((candidate) => candidate.orderOf(0))).toEqual([0, 1, 2]);
  });

  it('uses corridor divergence before a shared-face projection', () => {
    const entities = [
      leaf('hub', 0, 0, 40, 220),
      leaf('down-target', 200, 100, 20, 20),
      leaf('left-target', 200, 160, 20, 20),
    ];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 40, y: 0, width: 180, height: 220 } },
      { index: 1, axis: 'y', rect: { x: 200, y: 0, width: 20, height: 100 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 1,
        rect: { x: 200, y: 0, width: 20, height: 100 },
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 220] },
      { index: 1, entityIndex: 1, face: 'up', corridorIndex: 1, faceSpan: [200, 220] },
      { index: 2, entityIndex: 2, face: 'left', corridorIndex: 0, faceSpan: [160, 180] },
    ];
    const towardDownFace = route(
      0,
      { entityIndex: 0, face: 'right' },
      { entityIndex: 1, face: 'up' },
      [
        {
          corridorIndex: 0,
          entry: { kind: 'terminal', attachmentIndex: 0 },
          exit: { kind: 'portal', portalIndex: 0, mode: 'turn' },
          feasibleTrack: [0, 220],
        },
        {
          corridorIndex: 1,
          entry: { kind: 'portal', portalIndex: 0, mode: 'turn' },
          exit: { kind: 'terminal', attachmentIndex: 1 },
          feasibleTrack: [200, 220],
        },
      ],
    );
    const towardLeftFace = route(
      1,
      { entityIndex: 0, face: 'right' },
      { entityIndex: 2, face: 'left' },
      [
        {
          corridorIndex: 0,
          entry: { kind: 'terminal', attachmentIndex: 0 },
          exit: { kind: 'terminal', attachmentIndex: 2 },
          feasibleTrack: [0, 220],
        },
      ],
    );

    const result = orderRoutes(world(entities, corridors, portals, attachments), [
      towardDownFace,
      towardLeftFace,
    ]);

    expect(result.groups[0].members.map((member) => member.routeIndex)).toEqual([0, 1]);
  });

  it('uses the first geometric divergence before request order', () => {
    const entities = [
      leaf('down-source', -20, 40, 20, 10),
      leaf('up-source', -20, 50, 20, 10),
      leaf('down-target', 70, 140, 20, 20),
      leaf('up-target', 50, -80, 20, 20),
    ];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 40, width: 100, height: 20 } },
      { index: 1, axis: 'y', rect: { x: 70, y: 40, width: 20, height: 100 } },
      { index: 2, axis: 'y', rect: { x: 50, y: -60, width: 20, height: 120 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 1,
        rect: { x: 70, y: 40, width: 20, height: 20 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 2,
        rect: { x: 50, y: 40, width: 20, height: 20 },
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [40, 50] },
      { index: 1, entityIndex: 1, face: 'right', corridorIndex: 0, faceSpan: [50, 60] },
      { index: 2, entityIndex: 2, face: 'up', corridorIndex: 1, faceSpan: [70, 90] },
      { index: 3, entityIndex: 3, face: 'down', corridorIndex: 2, faceSpan: [50, 70] },
    ];
    const down = route(0, { entityIndex: 0, face: 'right' }, { entityIndex: 2, face: 'up' }, [
      {
        corridorIndex: 0,
        entry: { kind: 'terminal', attachmentIndex: 0 },
        exit: { kind: 'portal', portalIndex: 0, mode: 'turn' },
        feasibleTrack: [40, 60],
      },
      {
        corridorIndex: 1,
        entry: { kind: 'portal', portalIndex: 0, mode: 'turn' },
        exit: { kind: 'terminal', attachmentIndex: 2 },
        feasibleTrack: [70, 90],
      },
    ]);
    const up = route(1, { entityIndex: 1, face: 'right' }, { entityIndex: 3, face: 'down' }, [
      {
        corridorIndex: 0,
        entry: { kind: 'terminal', attachmentIndex: 1 },
        exit: { kind: 'portal', portalIndex: 1, mode: 'turn' },
        feasibleTrack: [40, 60],
      },
      {
        corridorIndex: 2,
        entry: { kind: 'portal', portalIndex: 1, mode: 'turn' },
        exit: { kind: 'terminal', attachmentIndex: 3 },
        feasibleTrack: [50, 70],
      },
    ]);

    const result = orderRoutes(world(entities, corridors, portals, attachments), [down, up]);
    const shared = result.groups.find((group) => group.corridorIndex === 0);

    expect(shared?.members.map((member) => member.routeIndex)).toEqual([1, 0]);
  });

  it('compares converging routes in one shared traversal frame', () => {
    const entities = [
      leaf('left-source', 0, 0, 20, 20),
      leaf('right-source', 100, 0, 20, 20),
      leaf('target', 40, 100, 40, 20),
    ];
    const corridors: Corridor[] = [
      { index: 0, axis: 'y', rect: { x: 0, y: 20, width: 40, height: 60 } },
      { index: 1, axis: 'y', rect: { x: 80, y: 20, width: 40, height: 60 } },
      { index: 2, axis: 'y', rect: { x: 0, y: 80, width: 120, height: 20 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'continue',
        axis: 'y',
        negativeCorridorIndex: 0,
        positiveCorridorIndex: 2,
        planeCoordinate: 80,
        crossSpan: [0, 40],
      },
      {
        index: 1,
        kind: 'continue',
        axis: 'y',
        negativeCorridorIndex: 1,
        positiveCorridorIndex: 2,
        planeCoordinate: 80,
        crossSpan: [80, 120],
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'down', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 1, entityIndex: 1, face: 'down', corridorIndex: 1, faceSpan: [100, 120] },
      { index: 2, entityIndex: 2, face: 'up', corridorIndex: 2, faceSpan: [40, 80] },
    ];
    const corridorWorld = world(entities, corridors, portals, attachments);
    const left = route(0, { entityIndex: 0, face: 'down' }, { entityIndex: 2, face: 'up' }, [
      {
        corridorIndex: 0,
        entry: { kind: 'terminal', attachmentIndex: 0 },
        exit: { kind: 'portal', portalIndex: 0, mode: 'continue-straight' },
        feasibleTrack: [0, 20],
      },
      {
        corridorIndex: 2,
        entry: { kind: 'portal', portalIndex: 0, mode: 'continue-straight' },
        exit: { kind: 'terminal', attachmentIndex: 2 },
        feasibleTrack: [40, 80],
      },
    ]);
    const right = route(1, { entityIndex: 1, face: 'down' }, { entityIndex: 2, face: 'up' }, [
      {
        corridorIndex: 1,
        entry: { kind: 'terminal', attachmentIndex: 1 },
        exit: { kind: 'portal', portalIndex: 1, mode: 'continue-straight' },
        feasibleTrack: [100, 120],
      },
      {
        corridorIndex: 2,
        entry: { kind: 'portal', portalIndex: 1, mode: 'continue-straight' },
        exit: { kind: 'terminal', attachmentIndex: 2 },
        feasibleTrack: [40, 80],
      },
    ]);

    const result = orderRoutes(corridorWorld, [left, right]);
    const shared = result.groups.find((group) => group.corridorIndex === 2);

    expect(shared?.members.map((member) => member.routeIndex)).toEqual([0, 1]);
  });

  it('treats disjoint feasible spans as a hard physical order', () => {
    const entities = [leaf('source', 0, 0, 40, 100), leaf('target', 200, 0, 40, 100)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 40, y: 0, width: 160, height: 100 } },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 100] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [0, 100] },
    ];
    const upper = route(
      1,
      { entityIndex: 0, face: 'right', authoredTrack: 90 },
      { entityIndex: 1, face: 'left', authoredTrack: 90 },
      [
        {
          corridorIndex: 0,
          entry: { kind: 'terminal', attachmentIndex: 0 },
          exit: { kind: 'terminal', attachmentIndex: 1 },
          feasibleTrack: [0, 40],
        },
      ],
    );
    const lower = route(
      0,
      { entityIndex: 0, face: 'right', authoredTrack: 10 },
      { entityIndex: 1, face: 'left', authoredTrack: 10 },
      [
        {
          corridorIndex: 0,
          entry: { kind: 'terminal', attachmentIndex: 0 },
          exit: { kind: 'terminal', attachmentIndex: 1 },
          feasibleTrack: [60, 100],
        },
      ],
    );

    const result = orderRoutes(world(entities, corridors, [], attachments), [upper, lower]);

    expect(result.groups[0].members.map((member) => member.routeIndex)).toEqual([0, 1]);
  });

  it('keeps one bundle side through alternating corridor axes', () => {
    const entities = [leaf('source', -20, 0, 20, 20), leaf('target', 180, 80, 20, 20)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 0, width: 100, height: 20 } },
      { index: 1, axis: 'y', rect: { x: 80, y: 0, width: 20, height: 100 } },
      { index: 2, axis: 'x', rect: { x: 80, y: 80, width: 100, height: 20 } },
    ];
    const portals: PortalRef[] = [
      {
        index: 0,
        kind: 'turn',
        xCorridorIndex: 0,
        yCorridorIndex: 1,
        rect: { x: 80, y: 0, width: 20, height: 20 },
      },
      {
        index: 1,
        kind: 'turn',
        xCorridorIndex: 2,
        yCorridorIndex: 1,
        rect: { x: 80, y: 80, width: 20, height: 20 },
      },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 20] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 2, faceSpan: [80, 100] },
    ];
    const visits: CorridorVisit[] = [
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
        feasibleTrack: [80, 100],
      },
      {
        corridorIndex: 2,
        entry: { kind: 'portal', portalIndex: 1, mode: 'turn' },
        exit: { kind: 'terminal', attachmentIndex: 1 },
        feasibleTrack: [80, 100],
      },
    ];
    const routes = [0, 1].map((requestIndex) =>
      route(
        requestIndex,
        { entityIndex: 0, face: 'right' },
        { entityIndex: 1, face: 'left' },
        visits,
      ),
    );

    orderRoutes(world(entities, corridors, portals, attachments), routes);

    expect(
      routes.map((candidate) => candidate.visits.map((_, index) => candidate.orderOf(index))),
    ).toEqual([
      [0, 1, 0],
      [1, 0, 1],
    ]);
  });

  it('reports contradictory endpoint fans instead of making them hard constraints', () => {
    const entities = [leaf('source', 0, 0, 40, 100), leaf('target', 200, 0, 40, 100)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 40, y: 0, width: 160, height: 100 } },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 100] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [0, 100] },
    ];
    const visits: CorridorVisit[] = [
      {
        corridorIndex: 0,
        entry: { kind: 'terminal', attachmentIndex: 0 },
        exit: { kind: 'terminal', attachmentIndex: 1 },
        feasibleTrack: [0, 100],
      },
    ];
    const routes = [
      route(
        0,
        { entityIndex: 0, face: 'right', authoredTrack: 90 },
        { entityIndex: 1, face: 'left', authoredTrack: 10 },
        visits,
      ),
      route(
        1,
        { entityIndex: 0, face: 'right', authoredTrack: 10 },
        { entityIndex: 1, face: 'left', authoredTrack: 90 },
        visits,
      ),
    ];

    const result = orderRoutes(world(entities, corridors, [], attachments), routes);

    expect(result.groups[0].members.map((member) => member.routeIndex)).toEqual([0, 1]);
  });

  it('uses request index only after geometry is tied', () => {
    const entities = [leaf('source', 0, 0, 40, 40), leaf('target', 200, 0, 40, 40)];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 40, y: 0, width: 160, height: 40 } },
    ];
    const attachments: TerminalAttachment[] = [
      { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 40] },
      { index: 1, entityIndex: 1, face: 'left', corridorIndex: 0, faceSpan: [0, 40] },
    ];
    const visits: CorridorVisit[] = [
      {
        corridorIndex: 0,
        entry: { kind: 'terminal', attachmentIndex: 0 },
        exit: { kind: 'terminal', attachmentIndex: 1 },
        feasibleTrack: [0, 40],
      },
    ];
    const late = route(
      9,
      { entityIndex: 0, face: 'right' },
      { entityIndex: 1, face: 'left' },
      visits,
    );
    const early = route(
      2,
      { entityIndex: 0, face: 'right' },
      { entityIndex: 1, face: 'left' },
      visits,
    );

    const result = orderRoutes(world(entities, corridors, [], attachments), [late, early]);

    expect(result.groups[0].members.map((member) => member.routeIndex)).toEqual([1, 0]);
  });
});
