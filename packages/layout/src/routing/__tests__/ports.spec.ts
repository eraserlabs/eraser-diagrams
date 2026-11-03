/**
 * Entity-declared ports (ports.ts): the wall and row an end on such an entity pins to, and how
 * routeConnections routes those ends.
 */
import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutEntity, LayoutPort, NewConnection } from '../../types.js';
import { absoluteConnectionPoints } from '../points.js';
import { HEADER_PORT_ID, resolvePortPins } from '../ports.js';
import { routeConnections } from '../routeConnections.js';
import { expectOrthogonal } from '../routingTestUtils.js';

/** A 30 px header port above the given rows, each `[y, height]` within the entity. */
function rows(fields: Record<string, [y: number, height: number]>): LayoutPort[] {
  return [
    { id: HEADER_PORT_ID, y: 0, height: 30, allowCrossover: true },
    ...Object.entries(fields).map(([id, [y, height]]) => ({ id, y, height, allowCrossover: true })),
  ];
}

/** `users` (rows id, team_id) to the left of `teams` (row id), 270 px apart. */
function tables({
  users,
  teams,
}: { users?: Partial<LayoutEntity>; teams?: Partial<LayoutEntity> } = {}): LayoutEntity[] {
  return [
    {
      id: 'users',
      x: 10,
      y: 20,
      width: 120,
      height: 100,
      ports: rows({ id: [30, 20], team_id: [50, 30] }),
      ...users,
    },
    {
      id: 'teams',
      x: 400,
      y: 70,
      width: 160,
      height: 100,
      ports: rows({ id: [30, 20] }),
      ...teams,
    },
  ];
}

function layout(entities: LayoutEntity[]): LayoutManager {
  return new LayoutManager({
    entities,
    connections: [],
    primaryDirection: 'right',
    options: { marginBetweenEntities: 40 },
  });
}

/** users.team_id to teams.id, last attached at users' right wall and teams' left wall. */
function membership(overrides: Partial<NewConnection> = {}): NewConnection {
  return {
    id: 'membership',
    from: 'users',
    to: 'teams',
    fromPortId: 'team_id',
    toPortId: 'id',
    relativeFromPort: [1, 0.65],
    relativeToPort: [0, 0.4],
    ...overrides,
  };
}

function pins(entities: LayoutEntity[], connection: NewConnection) {
  return resolvePortPins(layout(entities), connection);
}

describe('resolvePortPins', () => {
  it('pins a named port at its mid-row on the facing wall, without rounding', () => {
    const entities = tables({
      users: {
        x: 35.25,
        y: 35.125,
        width: 120.5,
        ports: rows({ id: [30, 20], team_id: [50.25, 30.5] }),
      },
    });
    expect(pins(entities, membership())).toEqual({ from: [155.75, 100.625], to: [400, 110] });
  });

  it("reads the named row from the entity's current ports, not the stored height", () => {
    const entities = tables({
      users: { width: 200, height: 220, ports: rows({ team_id: [45, 40], id: [85, 30] }) },
    });
    expect(pins(entities, membership())?.from).toEqual([210, 85]);
  });

  it('keeps stored walls within the crossover margin and faces the other entity once clear', () => {
    expect(pins(tables({ users: { x: 600 } }), membership())).toEqual({
      from: [720, 85],
      to: [400, 110],
    });
    expect(pins(tables({ users: { x: 601 } }), membership())).toEqual({
      from: [601, 85],
      to: [560, 110],
    });
    expect(
      pins(tables(), membership({ relativeFromPort: [0, 0.65], relativeToPort: [1, 0.4] })),
    ).toEqual({ from: [130, 85], to: [400, 110] });
  });

  it.each([
    [0, 0],
    [1, 1],
    [0, 1],
  ])('corrects each wall independently when the stored walls are %s and %s', (fromX, toX) => {
    const connection = membership({ relativeFromPort: [fromX, 0.65], relativeToPort: [toX, 0.4] });
    expect(pins(tables(), connection)).toEqual({ from: [130, 85], to: [400, 110] });
  });

  it('keeps stored walls on ports that disallow crossover, even once clear', () => {
    const locked = tables().map((entity) => {
      return {
        ...entity,
        ports: entity.ports!.map((port) => ({ ...port, allowCrossover: false })),
      };
    });
    expect(
      pins(locked, membership({ relativeFromPort: [0, 0.65], relativeToPort: [1, 0.4] })),
    ).toEqual({ from: [10, 85], to: [560, 110] });
  });

  it('keeps stored walls while the entities overlap horizontally', () => {
    expect(pins(tables({ teams: { x: -50, y: 420 } }), membership())).toEqual({
      from: [130, 85],
      to: [-50, 460],
    });
  });

  it('keeps stored top and bottom attachments exact, across a crossover too', () => {
    const connection = membership({
      fromPortId: undefined,
      toPortId: undefined,
      relativeFromPort: [0.25, 1],
      relativeToPort: [0.75, 0],
    });
    expect(pins(tables(), connection)).toEqual({ from: [40, 120], to: [520, 70] });
    expect(pins(tables({ users: { x: 710 } }), connection)).toEqual({
      from: [740, 120],
      to: [520, 70],
    });
  });

  it('attaches an unnamed end at the header mid-row when new, else at its stored height', () => {
    const tableLevel = membership({ fromPortId: undefined, toPortId: undefined });
    expect(
      pins(tables(), { ...tableLevel, relativeFromPort: undefined, relativeToPort: undefined }),
    ).toEqual({ from: [130, 35], to: [400, 85] });
    expect(pins(tables(), { ...tableLevel, relativeToPort: [0, 0.75] })).toEqual({
      from: [130, 85],
      to: [400, 145],
    });
  });

  it('treats a port id the entity does not declare as an unnamed end', () => {
    const headerOnly = { ports: rows({}) };
    expect(pins(tables({ users: headerOnly, teams: headerOnly }), membership())).toEqual({
      from: [130, 85],
      to: [400, 110],
    });
    expect(
      pins(tables({ users: { ...headerOnly, x: 601 }, teams: headerOnly }), membership()),
    ).toEqual({ from: [601, 85], to: [560, 110] });
  });

  it('keeps a new unnamed end on the face it was authored on', () => {
    const tableLevel = membership({
      fromPortId: undefined,
      toPortId: undefined,
      relativeFromPort: undefined,
      relativeToPort: undefined,
    });
    expect(
      pins(tables(), { ...tableLevel, authoredFromFace: 'down', authoredToFace: 'up' }),
    ).toBeUndefined();
    expect(pins(tables(), { ...tableLevel, authoredToFace: 'up' })).toEqual({ from: [130, 35] });
    expect(
      pins(tables(), { ...tableLevel, authoredFromFace: 'left', authoredToFace: 'right' }),
    ).toEqual({ from: [10, 35], to: [560, 85] });
    expect(pins(tables(), membership({ authoredFromFace: 'up', authoredToFace: 'right' }))).toEqual(
      { from: [130, 85], to: [400, 110] },
    );
  });

  it.each([
    [-200, [10, 85]],
    [300, [130, 85]],
  ])('faces a new end toward a free end stored at x %s', (freeX, from) => {
    const loose = membership({
      to: '',
      relativeFromPort: undefined,
      x: 70,
      y: 85,
      points: [
        [0, 0],
        [freeX - 70, 0],
      ],
    });
    expect(pins(tables(), loose)).toEqual({ from });
  });

  it('pins only bound ends on entities that declare ports', () => {
    expect(pins(tables(), membership({ to: '' }))).toEqual({ from: [130, 85] });
    expect(pins(tables({ teams: { ports: undefined } }), membership())).toEqual({
      from: [130, 85],
    });
    expect(
      pins(tables({ users: { ports: undefined }, teams: { ports: undefined } }), membership()),
    ).toBeUndefined();
  });

  it('keeps the distinct rows of a self-relationship on one wall', () => {
    const self = membership({ to: 'users', relativeToPort: [1, 0.4] });
    expect(pins(tables(), self)).toEqual({ from: [130, 85], to: [130, 60] });
    expect(
      pins(tables(), { ...self, relativeFromPort: undefined, relativeToPort: undefined }),
    ).toEqual({ from: [130, 85], to: [130, 60] });
  });

  it.each([
    ['table-level', {}],
    ['same-row', { fromPortId: 'team_id', toPortId: 'team_id' }],
  ])('leaves a %s self-relationship whose ends coincide unpinned', (_, ports) => {
    const self: NewConnection = { id: 'self', from: 'users', to: 'users', ...ports };
    expect(pins(tables(), self)).toBeUndefined();
  });

  it('leaves the connection and the layout untouched', () => {
    const layoutManager = layout(tables({ users: { x: 601 } }));
    const connection = membership();
    resolvePortPins(layoutManager, connection);
    expect(connection).toEqual(membership());
    expect(layoutManager.stagedChanges).toBeUndefined();
  });
});

describe('routeConnections with ports', () => {
  it('routes an elbow line from row to row and stores where it attached', () => {
    const layoutManager = layout(tables());
    const { fallbacks } = routeConnections({
      layoutManager,
      repair: false,
      connectionsToRoute: [membership({ relativeFromPort: undefined, relativeToPort: undefined })],
    });
    expect(fallbacks).toEqual(new Set());
    const routed = layoutManager.getConnectionById('membership')!;
    const points = absoluteConnectionPoints(routed);
    expectOrthogonal(points);
    expect([points[0], points.at(-1)]).toEqual([
      [130, 85],
      [400, 110],
    ]);
    expect([routed.relativeFromPort, routed.relativeToPort]).toEqual([
      [1, 0.65],
      [0, 0.4],
    ]);
  });

  it.each([{}, { fromPortId: 'team_id', toPortId: 'team_id' }])(
    'routes a self-relationship whose ends coincide as on an entity without ports: %j',
    (ports) => {
      const route = (entities: LayoutEntity[]) => {
        const layoutManager = layout(entities);
        routeConnections({
          layoutManager,
          repair: false,
          connectionsToRoute: [{ id: 'self', from: 'users', to: 'users', ...ports }],
        });
        return absoluteConnectionPoints(layoutManager.getConnectionById('self')!);
      };
      expect(route(tables())).toEqual(route(tables({ users: { ports: undefined } })));
    },
  );

  it('routes new ends authored on the top and bottom faces as on entities without ports', () => {
    const route = (entities: LayoutEntity[]) => {
      const layoutManager = layout(entities);
      routeConnections({
        layoutManager,
        repair: false,
        connectionsToRoute: [
          {
            id: 'stacked',
            from: 'users',
            to: 'teams',
            authoredFromFace: 'down',
            authoredToFace: 'up',
          },
        ],
      });
      return absoluteConnectionPoints(layoutManager.getConnectionById('stacked')!);
    };
    const stacked = { x: 0, y: 300 };
    const points = route(tables({ teams: stacked }));
    expect([points[0][1], points.at(-1)![1]]).toEqual([120, 300]);
    expect(points).toEqual(
      route(tables({ users: { ports: undefined }, teams: { ...stacked, ports: undefined } })),
    );
  });

  it.each(['straight', 'arc'] as const)(
    'leaves %s lines on their own binding, as on entities without ports',
    (connectorStyle) => {
      const route = (entities: LayoutEntity[]) => {
        const layoutManager = layout(entities);
        routeConnections({
          layoutManager,
          repair: false,
          connectionsToRoute: [membership({ connectorStyle })],
        });
        const drawn = absoluteConnectionPoints(layoutManager.getConnectionById('membership')!);
        layoutManager.applyStagedChanges();
        layoutManager.updateEntity('teams', { deltaY: 150 });
        routeConnections({
          layoutManager,
          repair: false,
          updates: new Map([['teams', { deltaY: 150 }]]),
        });
        return [drawn, absoluteConnectionPoints(layoutManager.getConnectionById('membership')!)];
      };
      const [drawn, moved] = route(tables());
      expect(moved).not.toEqual(drawn);
      expect([drawn, moved]).toEqual(
        route(tables({ users: { ports: undefined }, teams: { ports: undefined } })),
      );
    },
  );
});
