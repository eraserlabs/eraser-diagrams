import { vi } from 'vitest';
import { LayoutManager } from '../../LayoutManager.js';
import {
  LayoutConnectionTextPlacementSource,
  type LayoutConnection,
  type LayoutEntity,
  type NewConnection,
} from '../../types.js';
import * as corridorRouting from '../executeCorridorRouting.js';
import * as realization from '../corridor/realize.js';
import { COMMIT_REPAIR, routeConnections } from '../routeConnections.js';
import { CorridorRouteError, Route } from '../corridor/route.js';
import type { Point } from '../types.js';
import { absoluteConnectionPoints } from '../points.js';
import { expectOrthogonal } from '../routingTestUtils.js';

function entities(): LayoutEntity[] {
  return [
    {
      id: 'a',
      x: 0,
      y: 0,
      width: 80,
      height: 40,
    },
    {
      id: 'b',
      x: 240,
      y: 0,
      width: 80,
      height: 40,
    },
  ];
}

function manager(connections: LayoutConnection[] = []): LayoutManager {
  return new LayoutManager({
    entities: entities(),
    connections,
    primaryDirection: 'right',
  });
}

function labeledConnection(id = 'ab'): NewConnection {
  return {
    id,
    from: 'a',
    to: 'b',
    fromArrowhead: false,
    toArrowhead: true,
    textPlacement: {
      x: Number.NaN,
      y: Number.NaN,
      width: 40,
      height: 14,
    },
    textPlacementSource: LayoutConnectionTextPlacementSource.MEASURE,
  };
}

describe('routeConnections batch routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps grouped field pins without repairing their shared terminal runs into detours', () => {
    const layoutManager = new LayoutManager({
      entities: [
        { id: 'a', x: 0, y: 0, width: 236, height: 154 },
        { id: 'b', x: 1143, y: 137, width: 236, height: 192 },
        { id: 'c', x: 416, y: 415, width: 152, height: 154 },
        { id: 'd', x: 748.5, y: 198, width: 215, height: 268 },
        { id: 'e', x: 1171, y: 750, width: 181, height: 192 },
        { id: 'f', x: 762.5, y: 556, width: 187, height: 230 },
      ],
      connections: [],
      primaryDirection: 'right',
    });
    const ports: [string, string, Point, Point][] = [
      ['b', 'a', [1143, 233], [236, 134]],
      ['c', 'd', [568, 473], [748.5, 256]],
      ['f', 'e', [949.5, 766], [1171, 808]],
      ['c', 'f', [568, 511], [762.5, 728]],
      ['d', 'b', [963.5, 294], [1143, 195]],
      ['f', 'b', [949.5, 652], [1143, 195]],
      ['c', 'e', [568, 549], [1171, 808]],
      ['a', 'c', [236, 134], [416, 549]],
      ['a', 'b', [236, 96], [1143, 195]],
    ];
    const { fallbacks } = routeConnections({
      layoutManager,
      groupedPinnedPorts: true,
      repair: { timeBudgetMs: Infinity },
      connectionsToRoute: ports.map(([from, to, start, end], index) => ({
        connection: { id: String(index), from, to },
        endpointPins: { from: start, to: end },
      })),
    });
    expect(fallbacks).toEqual(new Set());
    for (const index of [5, 7]) {
      const connection = layoutManager.getConnectionById(String(index))!;
      expect(connection.points).toHaveLength(4);
      expect([connection.x, connection.y]).toEqual(ports[index][2]);
      const last = connection.points.at(-1)!;
      expect([connection.x + last[0], connection.y + last[1]]).toEqual(ports[index][3]);
    }
  });

  function incumbent(): LayoutConnection {
    return {
      id: 'ab',
      from: 'a',
      to: 'b',
      x: 80,
      y: 20,
      points: [
        [0, 0],
        [40, 0],
        [40, 80],
        [120, 80],
        [120, 0],
        [160, 0],
      ],
      relativeFromPort: [1, 0.5],
      relativeToPort: [0, 0.5],
      textPlacement: { x: 140, y: 93, width: 40, height: 14 },
      textPlacementSource: LayoutConnectionTextPlacementSource.STORED,
    };
  }

  it.each([{}, { connectionsToRoute: [], updates: new Map() }])(
    'leaves routes untouched with empty selectors: %j',
    (selectors) => {
      const existing = incumbent();
      const layoutManager = manager([existing]);
      expect(routeConnections({ repair: COMMIT_REPAIR, layoutManager, ...selectors })).toEqual({
        updates: new Map(),
        fallbacks: new Set(),
      });
      expect(layoutManager.getConnectionById(existing.id)).toEqual(existing);
    },
  );

  it.each(['plain', 'wrapped', 'pinned', 'empty', 'updates'] as const)(
    'deduplicates selectors and applies pin precedence for a %s request',
    (mode) => {
      const existing = incumbent();
      const layoutManager = manager([existing]);
      const resolved: NewConnection[] = [];
      const pins = { from: [80, 12.5] as Point };
      const explicit: NewConnection = {
        id: 'ab',
        from: 'a',
        to: 'b',
        relativeFromPort: [1, 0.25],
        textPlacementSource: LayoutConnectionTextPlacementSource.MEASURE,
      };
      if (mode === 'updates') {
        layoutManager.updateConnection(existing.id, explicit);
      }
      const result = routeConnections({
        layoutManager,
        connectionsToRoute:
          mode === 'updates'
            ? []
            : [
                existing,
                mode === 'plain'
                  ? explicit
                  : {
                      connection: explicit,
                      endpointPins: mode === 'pinned' ? pins : mode === 'empty' ? {} : undefined,
                    },
              ],
        updates: new Map([
          ['a', {}],
          ['b', {}],
        ]),
        repair: false,
        resolveEndpointPins: (connection) => {
          resolved.push(connection);
          return pins;
        },
      });
      expect(result.fallbacks).toEqual(new Set());
      expect([...result.updates.keys()]).toEqual(['ab']);
      expect(resolved).toEqual(
        mode === 'pinned' || mode === 'empty' ? [] : [expect.objectContaining(explicit)],
      );
      expect(layoutManager.getConnectionById('ab')).toMatchObject({
        x: 80,
        y: mode === 'empty' ? 10 : 12.5,
        textPlacementSource: LayoutConnectionTextPlacementSource.MEASURE,
      });
    },
  );

  it.each([undefined, true])(
    'preserves authored bends with allowShift=%s but reroutes with false',
    (allowShift) => {
      const existing = incumbent();
      const layoutManager = manager([existing]);
      routeConnections({
        repair: COMMIT_REPAIR,
        layoutManager,
        connectionsToRoute: [existing],
        allowShift,
      });
      expect(layoutManager.getConnectionById('ab')!.points).toEqual(existing.points);
      routeConnections({
        layoutManager,
        connectionsToRoute: [existing],
        allowShift: false,
        repair: false,
      });
      expect(layoutManager.getConnectionById('ab')!.points).not.toEqual(existing.points);
    },
  );

  it('returns current added geometry after checkpoint restore and rerouting', () => {
    const layoutManager = manager();
    const connectionsToRoute = [{ id: 'ab', from: 'a', to: 'b' }];
    routeConnections({ repair: COMMIT_REPAIR, layoutManager, connectionsToRoute });
    const before = layoutManager.getConnectionById('ab');
    layoutManager.restore(layoutManager.checkpoint('added'));
    layoutManager.updateEntity('b', { deltaY: 80 });
    const result = routeConnections({
      layoutManager,
      connectionsToRoute,
      allowShift: false,
      repair: false,
    });
    expect(result.updates.get('ab')).toEqual(layoutManager.getConnectionById('ab'));
    expect(result.updates.get('ab')).not.toEqual(before);
  });

  it.each(['label', 'port', 'face', 'fallback'] as const)(
    'applies an explicit %s change to an otherwise stationary route',
    (change) => {
      const existing = incumbent();
      const layoutManager = manager([existing]);
      const metadata = {
        fromArrowhead: true,
        toArrowhead: false,
        textPlacementSource: LayoutConnectionTextPlacementSource.MEASURE,
      };
      const request: NewConnection = {
        ...existing,
        ...metadata,
        ...(change === 'label'
          ? { textPlacement: { ...existing.textPlacement!, width: 90, height: 25 } }
          : change === 'port'
            ? { relativeFromPort: [1, 0.25] as Point }
            : { from: 'b', to: 'a', authoredFromFace: 'up' as const }),
      };
      if (change === 'fallback') {
        vi.spyOn(corridorRouting, 'executeCorridorRouting').mockImplementation(() => {
          throw new Error('routing failure');
        });
      }
      const result = routeConnections({
        layoutManager,
        connectionsToRoute: [request],
        repair: false,
      });
      const routed = layoutManager.getConnectionById('ab')!;
      expect(routed).toMatchObject({ ...metadata, from: request.from, to: request.to });
      expect(result.fallbacks).toEqual(new Set(change === 'fallback' ? ['ab'] : []));
      if (change === 'label') {
        expect(routed.textPlacement).toMatchObject({ width: 90, height: 25 });
      } else if (change === 'port') {
        expect(routed.relativeFromPort).toEqual([1, 0.25]);
        expect(routed.points).not.toEqual(existing.points);
      } else if (change === 'face') {
        expect(routed.relativeFromPort?.[1]).toBe(0);
        expect(routed.points[1][0]).toBe(0);
        expect(routed.points[1][1]).toBeLessThan(0);
      } else {
        expect(routed.points.flat().every(Number.isFinite)).toBe(true);
      }
    },
  );

  it('commits a complete repaired and labeled batch as ordinary relative connections', () => {
    const layoutManager = manager();

    const { fallbacks } = routeConnections({
      repair: COMMIT_REPAIR,
      layoutManager,
      connectionsToRoute: [labeledConnection()],
    });

    expect(fallbacks).toEqual(new Set());
    const routed = layoutManager.getConnectionById('ab');
    expect(routed?.points[0]).toEqual([0, 0]);
    expect(routed?.x).toBe(80);
    expect(routed?.points.at(-1)?.[0]).toBe(160);
    expect(routed?.relativeFromPort).toEqual([1, 0.5]);
    expect(routed?.relativeToPort).toEqual([0, 0.5]);
    expect(Number.isFinite(routed?.textPlacement?.x)).toBe(true);
    expect(Number.isFinite(routed?.textPlacement?.y)).toBe(true);
    expect(routed?.textPlacementSource).toBe(LayoutConnectionTextPlacementSource.MEASURE);
  });

  it('pins incumbent geometry while routing a new connection in the same batch', () => {
    const existing: LayoutConnection = {
      id: 'existing',
      from: 'a',
      to: 'b',
      x: 80.2,
      y: 20.2,
      points: [
        [0, 0],
        [159.6, 0],
      ],
    };
    const layoutManager = manager([existing]);

    const { fallbacks } = routeConnections({
      repair: COMMIT_REPAIR,
      layoutManager,
      connectionsToRoute: [labeledConnection('second')],
    });

    expect(layoutManager.getConnectionById('existing')).toEqual(existing);
    const second = layoutManager.getConnectionById('second');
    expect(second?.points.length).toBeGreaterThanOrEqual(2);
    expect({ x: second?.x, y: second?.y, points: second?.points }).not.toEqual({
      x: existing.x,
      y: existing.y,
      points: existing.points,
    });
    expect(fallbacks).toEqual(new Set());
  });

  it('ignores incumbent terminal geometry inside its endpoint entities', () => {
    const existing: LayoutConnection = {
      id: 'existing',
      from: 'a',
      to: 'b',
      x: 60,
      y: 20,
      points: [
        [0, 0],
        [201, 0],
      ],
      relativeFromPort: [1, 0.5],
      relativeToPort: [0, 0.5],
    };
    const layoutManager = manager([existing]);

    const { fallbacks } = routeConnections({
      repair: COMMIT_REPAIR,
      layoutManager,
      connectionsToRoute: [labeledConnection('second')],
    });

    expect(fallbacks).toEqual(new Set());
    expect(layoutManager.getConnectionById('existing')).toEqual(existing);
  });

  it('leaves unrouteable incumbents untouched while routing a selected connection', () => {
    const dangling: LayoutConnection = {
      id: 'dangling',
      from: 'a',
      to: '',
      x: 80,
      y: 10,
      points: [
        [0, 0],
        [40, 0],
      ],
    };
    const unadoptable: LayoutConnection = {
      id: 'diagonal',
      from: 'a',
      to: 'b',
      x: 80,
      y: 20,
      points: [
        [0, 0],
        [160, 1],
      ],
    };
    const layoutManager = manager([dangling, unadoptable]);

    const { fallbacks } = routeConnections({
      repair: COMMIT_REPAIR,
      layoutManager,
      connectionsToRoute: [labeledConnection('selected')],
    });

    expect(fallbacks).toEqual(new Set());
    expect(layoutManager.getConnectionById('dangling')).toEqual(dangling);
    expect(layoutManager.getConnectionById('diagonal')).toEqual(unadoptable);
  });

  it.each([
    ['from', 'down', [0.5, 1]],
    ['from', 'left', [0, 0.5]],
    ['to', 'up', [0.5, 0]],
    ['to', 'right', [1, 0.5]],
  ] as const)('honors an authored %s %s face against the direct bearing', (side, face, port) => {
    const layoutManager = manager();
    const connection: NewConnection = {
      id: 'authored',
      from: 'a',
      to: 'b',
      ...(side === 'from' ? { authoredFromFace: face } : { authoredToFace: face }),
    };

    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [connection],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set());
    const routed = layoutManager.getConnectionById(connection.id)!;
    expect(side === 'from' ? routed.relativeFromPort : routed.relativeToPort).toEqual(port);
    const endpoint = side === 'from' ? routed.points[0] : routed.points.at(-1)!;
    const adjacent = side === 'from' ? routed.points[1] : routed.points.at(-2)!;
    if (face === 'left' || face === 'right') {
      expect(adjacent[1]).toBe(endpoint[1]);
      expect(Math.sign(adjacent[0] - endpoint[0])).toBe(face === 'left' ? -1 : 1);
    } else {
      expect(adjacent[0]).toBe(endpoint[0]);
      expect(Math.sign(adjacent[1] - endpoint[1])).toBe(face === 'up' ? -1 : 1);
    }
  });

  it.each(['from', 'to'] as const)(
    'keeps sibling %s ports distinct and ordered toward their opposite endpoints',
    (side) => {
      const hub: LayoutEntity = { id: 'hub', x: 0, y: 0, width: 100, height: 200 };
      const targets: LayoutEntity[] = [30, 80, 130].map((y, index) => ({
        id: `target-${index}`,
        x: 600,
        y,
        width: 100,
        height: 40,
      }));
      const connections: NewConnection[] = targets.map((target, index) => ({
        id: `sibling-${index}`,
        from: side === 'from' ? hub.id : target.id,
        to: side === 'to' ? hub.id : target.id,
        authoredFromFace: side === 'from' ? 'right' : 'left',
        authoredToFace: side === 'to' ? 'right' : 'left',
      }));
      const layoutManager = new LayoutManager({
        entities: [hub, ...targets],
        connections: [],
        primaryDirection: 'right',
      });

      const { fallbacks } = routeConnections({
        layoutManager,
        connectionsToRoute: connections,
        allowShift: false,
        repair: false,
      });

      expect(fallbacks).toEqual(new Set());
      const ports = connections.map(({ id }) => {
        const routed = layoutManager.getConnectionById(id)!;
        const port = side === 'from' ? routed.relativeFromPort : routed.relativeToPort;
        expect(port?.[0]).toBe(1);
        return port![1];
      });
      expect(ports[0]).toBeLessThan(ports[1]);
      expect(ports[1]).toBeLessThan(ports[2]);
      expect(ports[0]).toBeGreaterThan(0);
      expect(ports[2]).toBeLessThan(1);
    },
  );

  it.each<NewConnection>([
    {
      id: 'free',
      from: '',
      to: '',
      x: 20,
      y: 30,
      points: [
        [0, 0],
        [120, 0],
      ],
    },
    { id: 'unbound', from: 'missing-a', to: 'missing-b' },
  ])('commits finite fallback geometry for unsupported $id endpoints', (connection) => {
    const layoutManager = manager();
    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [connection],
      allowShift: false,
      repair: false,
    });
    expect(fallbacks).toEqual(new Set([connection.id]));
    const routed = layoutManager.getConnectionById(connection.id)!;
    expect(routed.points.length).toBeGreaterThanOrEqual(2);
    expect(routed.points.flat().every(Number.isFinite)).toBe(true);
  });

  it('falls back to default geometry when free stored endpoints are malformed', () => {
    const layoutManager = manager();
    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [
        {
          id: 'damaged',
          from: '',
          to: '',
          x: 20,
          y: 30,
          points: [
            [NaN, 0],
            [10, 5],
            [40, 5],
            [Infinity, 0],
          ],
        },
      ],
      allowShift: false,
      repair: false,
    });
    expect(fallbacks).toEqual(new Set(['damaged']));
    const routed = layoutManager.getConnectionById('damaged')!;
    expect(absoluteConnectionPoints(routed)).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('routes a dangling selection through the corridor anchored at its stored endpoint', () => {
    const dangling: LayoutConnection = {
      id: 'dangling',
      from: 'a',
      to: '',
      x: 80,
      y: 20,
      points: [
        [0, 0],
        [20, 80],
        [120, 80],
      ],
    };
    const mangled: LayoutConnection = {
      ...labeledConnection('bound'),
      x: Number.NaN,
      y: Number.NaN,
      points: [[Number.NaN, Number.NaN]],
    };
    const layoutManager = manager([dangling, mangled]);
    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [dangling, mangled],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set());
    expect(layoutManager.getConnectionById('bound')?.points.length).toBeGreaterThanOrEqual(2);
    const rerouted = layoutManager.getConnectionById('dangling');
    expect(rerouted).toBeDefined();
    const absolute = absoluteConnectionPoints(rerouted as LayoutConnection);
    // The free end lands exactly on its stored anchor; the bound end sits on
    // entity a's face, and the free side records no relative port.
    expect(absolute.at(-1)).toEqual([200, 100]);
    expect(absolute[0][0]).toBe(80);
    expect((rerouted as LayoutConnection).relativeFromPort).toBeDefined();
    expect((rerouted as LayoutConnection).relativeToPort).toBeUndefined();
  });

  it('repositions an existing label with its fallback route', () => {
    vi.spyOn(corridorRouting, 'executeCorridorRouting').mockImplementation(() => {
      throw new Error('corridor failure');
    });
    const connection: LayoutConnection = {
      id: 'ab',
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
      textPlacement: { x: 140, y: 13, width: 40, height: 14 },
    };
    const layoutManager = manager([connection]);
    layoutManager.updateEntity('b', { deltaX: -640, deltaY: 200 });

    const { fallbacks } = routeConnections({
      repair: COMMIT_REPAIR,
      layoutManager,
      connectionsToRoute: [connection],
      allowShift: false,
    });

    expect(fallbacks).toEqual(new Set(['ab']));
    expect(layoutManager.getConnectionById('ab')?.textPlacement).toEqual({
      x: -180,
      y: 233,
      width: 40,
      height: 14,
    });
  });

  it.each(['batch', 'partial', 'unsupported'] as const)(
    'positions a new measured label after %s fallback',
    (failureMode) => {
      const layoutManager = manager();
      const connection = labeledConnection('failed');
      const connectionsToRoute = [connection];
      if (failureMode === 'partial') {
        vi.spyOn(realization, 'realizeRoutes').mockImplementationOnce(() => {
          throw new CorridorRouteError([0], 'test infeasible component');
        });
        connectionsToRoute.push(labeledConnection('survivor'));
      } else if (failureMode === 'unsupported') {
        connection.from = 'missing-a';
        connection.to = 'missing-b';
      } else {
        vi.spyOn(corridorRouting, 'executeCorridorRouting').mockImplementation(() => {
          throw new Error('corridor failure');
        });
      }

      const { fallbacks } = routeConnections({
        layoutManager,
        connectionsToRoute,
        allowShift: false,
        repair: false,
      });

      expect(fallbacks).toEqual(new Set(['failed']));
      const placement = layoutManager.getConnectionById('failed')?.textPlacement;
      expect(placement).toMatchObject({ width: 40, height: 14 });
      expect(Number.isFinite(placement?.x)).toBe(true);
      expect(Number.isFinite(placement?.y)).toBe(true);
    },
  );

  it('recovers peers after an adoption failure and an attributed spacing failure', () => {
    const strictExecution = realization.realizeRoutes;
    vi.spyOn(realization, 'realizeRoutes')
      .mockImplementationOnce(() => {
        throw new CorridorRouteError([1], 'test infeasible component');
      })
      .mockImplementation(strictExecution);
    const untouched = {
      ...incumbent(),
      id: 'untouched',
      points: [
        [0, 0],
        [160, 0],
      ] as Point[],
    };
    const unadoptable = {
      ...incumbent(),
      id: 'diagonal',
      points: [
        [0, 0],
        [80, 100],
        [160, 0],
      ] as Point[],
    };
    const layoutManager = manager([unadoptable, untouched]);

    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [
        labeledConnection('failed'),
        {
          ...labeledConnection('survivor'),
          textPlacement: { x: Number.NaN, y: Number.NaN, width: 58, height: 20 },
        },
      ],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set(['failed']));
    expect(layoutManager.getConnectionById('failed')?.points.length).toBeGreaterThanOrEqual(2);
    expect(layoutManager.getConnectionById('survivor')?.points.length).toBeGreaterThanOrEqual(2);
    expect(layoutManager.getConnectionById('survivor')?.textPlacement).toMatchObject({
      width: 58,
      height: 20,
    });
    expect(layoutManager.getConnectionById('untouched')).toEqual(untouched);
    expect(layoutManager.getConnectionById('diagonal')).toEqual(unadoptable);
  });

  it('fails closed when spacing attribution mixes valid and invalid route indexes', () => {
    vi.spyOn(realization, 'realizeRoutes').mockImplementationOnce(() => {
      throw new CorridorRouteError([0, 999], 'invalid attribution');
    });

    const { fallbacks } = routeConnections({
      layoutManager: manager(),
      connectionsToRoute: [labeledConnection('first'), labeledConnection('second')],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set(['first', 'second']));
  });

  it('attributes a route-local track invariant failure to its route and keeps peers', () => {
    const setNominalTracks = Route.prototype.setNominalTracks;
    vi.spyOn(Route.prototype, 'setNominalTracks').mockImplementation(function (
      this: Route,
      ...args: Parameters<Route['setNominalTracks']>
    ) {
      if (this.requestIndex === 1) {
        throw new Error(`route ${this.requestIndex}: forced track invariant`);
      }
      setNominalTracks.apply(this, args);
    });

    const { fallbacks } = routeConnections({
      layoutManager: manager(),
      connectionsToRoute: [labeledConnection('survivor'), labeledConnection('failed')],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set(['failed']));
  });

  it('keeps an adopted incumbent pinned when its track anchors a congested turn', () => {
    const layoutManager = new LayoutManager({
      entities: [
        { id: 'a', x: 880, y: 180, width: 270, height: 150 },
        { id: 'b', x: 880, y: 350, width: 270, height: 130 },
        { id: 'c', x: 580, y: 505, width: 570, height: 300 },
      ],
      connections: [
        {
          id: 'ac',
          from: 'a',
          to: 'c',
          x: 1009,
          y: 330,
          points: [
            [0, 0],
            [0, 10],
            [-144, 10],
            [-144, 175],
          ],
          relativeFromPort: [0.4777777777777778, 1],
          relativeToPort: [0.5, 0],
        },
        {
          id: 'ab',
          from: 'a',
          to: 'b',
          x: 1021,
          y: 330,
          points: [
            [0, 0],
            [0, 20],
          ],
          relativeFromPort: [0.5222222222222223, 1],
          relativeToPort: [0.5222222222222223, 0],
        },
      ],
      primaryDirection: 'right',
    });
    layoutManager.updateEntity('a', { deltaX: 13, deltaY: 7 });
    const execute = vi.spyOn(corridorRouting, 'executeCorridorRouting');

    // The shifted 'ac' is adopted with pinned tracks; the moved 'ab' must space around it.
    const { fallbacks } = routeConnections({
      layoutManager,
      updates: new Map([['a', { deltaX: 13, deltaY: 7 }]]),
      repair: false,
    });

    expect(fallbacks).toEqual(new Set());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.results[0].value).toMatchObject({
      status: 'completed',
      activeRequestIndexes: [0, 1],
      failedRequestIndexes: [],
    });
  });

  it('stops solving once only adopted incumbents remain', () => {
    const layoutManager = new LayoutManager({
      entities: [
        ...entities(),
        { id: 'blocker', x: 160, y: -20, width: 80, height: 80 },
        { id: 'c', x: 0, y: 160, width: 80, height: 40 },
      ],
      connections: [
        {
          id: 'cb',
          from: 'c',
          to: 'b',
          x: 80,
          y: 180,
          points: [
            [0, 0],
            [200, 0],
            [200, -140],
          ],
          relativeFromPort: [1, 0.5],
          relativeToPort: [0.5, 1],
        },
      ],
      primaryDirection: 'right',
    });
    const execute = vi.spyOn(corridorRouting, 'executeCorridorRouting');
    const realize = vi.spyOn(realization, 'realizeRoutes');

    // The pin sits inside b behind the blocker, so the only selected route fails search.
    const { fallbacks } = routeConnections({
      repair: COMMIT_REPAIR,
      layoutManager,
      connectionsToRoute: [
        {
          connection: { id: 'blocked', from: 'a', to: 'b', relativeFromPort: [1, 0.5] },
          endpointPins: { to: [260, 20] },
        },
      ],
      allowShift: false,
    });

    expect(fallbacks).toEqual(new Set(['blocked']));
    expect(execute.mock.results[0].value).toMatchObject({
      status: 'fallback',
      failedRequestIndexes: [1],
    });
    expect(realize).not.toHaveBeenCalled();
  });

  it('isolates an unbound fallback from a routable connection with fixed ports', () => {
    const layoutManager = manager();
    const { fallbacks } = routeConnections({
      repair: COMMIT_REPAIR,
      layoutManager,
      connectionsToRoute: [
        {
          id: 'fixed',
          from: 'a',
          to: 'b',
          authoredFromFace: 'right',
          authoredToFace: 'left',
          relativeFromPort: [1, 0.25],
          relativeToPort: [0, 0.75],
        },
        { id: 'unbound', from: 'missing-a', to: 'missing-b' },
      ],
    });

    expect(fallbacks).toEqual(new Set(['unbound']));
    expect(layoutManager.getConnectionById('fixed')).toMatchObject({
      x: 80,
      y: 10,
      points: [
        [0, 0],
        [80, 0],
        [80, 20],
        [160, 20],
      ],
    });
  });

  it('routes around external entity text while keeping ports centered on the body', () => {
    const layoutManager = new LayoutManager({
      entities: [
        {
          id: 'icon',
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          textPlacement: {
            relativeX: -10,
            relativeY: 55,
            width: 70,
            height: 24,
          },
        },
        { id: 'target', x: 250, y: 0, width: 50, height: 50 },
      ],
      connections: [],
      primaryDirection: 'right',
    });

    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [{ id: 'route', from: 'icon', to: 'target' }],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set());
    const routed = layoutManager.getConnectionById('route');
    expect([routed?.x, routed?.y]).toEqual([50, 25]);
    expect(routed?.relativeFromPort).toEqual([1, 0.5]);
  });

  it.each([
    ['full-face', { relativeX: -10, relativeY: 55, width: 70, height: 24 }],
    ['narrow', { relativeX: 0, relativeY: 55, width: 10, height: 24 }],
  ])('uses the caption outer face for a %s external caption', (_, textPlacement) => {
    const layoutManager = new LayoutManager({
      entities: [
        {
          id: 'icon',
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          textPlacement,
        },
        { id: 'target', x: 0, y: 250, width: 50, height: 50 },
      ],
      connections: [],
      primaryDirection: 'down',
    });

    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [
        {
          id: 'route',
          from: 'icon',
          to: 'target',
          authoredFromFace: 'down',
          authoredToFace: 'up',
        },
      ],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set());
    const routed = layoutManager.getConnectionById('route');
    expect([routed?.x, routed?.y]).toEqual([25, 79]);
    expect(routed?.relativeFromPort).toEqual([0.5, 1]);
  });

  it('reroutes only an affected connection and pins an unrelated incumbent', () => {
    const incumbent: LayoutConnection = {
      id: 'ab',
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
    const affected: LayoutConnection = {
      id: 'cb',
      from: 'c',
      to: 'b',
      x: 80,
      y: 120,
      points: [
        [0, 0],
        [80, 0],
        [80, -100],
        [160, -100],
      ],
      relativeFromPort: [1, 0.5],
      relativeToPort: [0, 0.5],
    };
    const layoutManager = new LayoutManager({
      entities: [
        ...entities(),
        {
          id: 'c',
          x: 0,
          y: 100,
          width: 80,
          height: 40,
        },
      ],
      connections: [incumbent, affected],
      primaryDirection: 'right',
    });
    layoutManager.initiateChanges();
    layoutManager.updateEntity('c', { deltaY: 40 });

    const { updates: changes } = routeConnections({
      repair: COMMIT_REPAIR,
      layoutManager,
      updates: new Map([['c', { deltaY: 40 }]]),
    });

    expect(layoutManager.getConnectionById('ab')).toEqual(incumbent);
    expect(changes.has('ab')).toBe(false);
    expect(changes.has('cb')).toBe(true);
    expect(layoutManager.getConnectionById('cb')?.points).not.toEqual(affected.points);
  });
});

describe('endpoint pins', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes a dragged free endpoint to the exact pin in open space', () => {
    const dragged: LayoutConnection = {
      id: 'drag',
      from: 'a',
      to: '',
      x: 80,
      y: 20,
      points: [
        [0, 0],
        [40, 0],
      ],
    };
    const layoutManager = manager([dragged]);
    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [{ connection: dragged, endpointPins: { to: [160, 90] } }],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set());
    const routed = layoutManager.getConnectionById('drag') as LayoutConnection;
    const absolute = absoluteConnectionPoints(routed);
    expect(absolute.at(-1)).toEqual([160, 90]);
    // The bound side leaves from entity a's perimeter, whichever face it picked.
    const [startX, startY] = absolute[0];
    const onVerticalFace = (startX === 0 || startX === 80) && startY >= 0 && startY <= 40;
    const onHorizontalFace = (startY === 0 || startY === 40) && startX >= 0 && startX <= 80;
    expect(onVerticalFace || onHorizontalFace).toBe(true);
    expect(routed.relativeToPort).toBeUndefined();
  });

  it('routes a fully free connection between its stored anchors', () => {
    const free: LayoutConnection = {
      id: 'free',
      from: '',
      to: '',
      x: 100,
      y: 120,
      points: [
        [0, 0],
        [160, 0],
      ],
    };
    const layoutManager = manager([free]);
    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [free],
      allowShift: false,
      repair: false,
    });

    expect(fallbacks).toEqual(new Set());
    const routed = layoutManager.getConnectionById('free') as LayoutConnection;
    const absolute = absoluteConnectionPoints(routed);
    expect(absolute[0]).toEqual([100, 120]);
    expect(absolute.at(-1)).toEqual([260, 120]);
    expect(routed.relativeFromPort).toBeUndefined();
    expect(routed.relativeToPort).toBeUndefined();
  });

  it.each(['horizontal', 'vertical'] as const)(
    'keeps both fractional pins exact on a %s route at negative coordinates',
    (axis) => {
      const vertical = axis === 'vertical';
      const layoutManager = new LayoutManager({
        entities: [
          { ...entities()[0], x: -400, y: -200 },
          { ...entities()[1], x: vertical ? -400 : -160, y: vertical ? 40 : -200 },
        ],
        connections: [],
        primaryDirection: vertical ? 'down' : 'right',
      });
      const from: Point = vertical ? [-379.625, -160] : [-320, -179.625];
      const to: Point = vertical ? [-376.125, 40] : [-160, -176.125];

      const { fallbacks } = routeConnections({
        layoutManager,
        connectionsToRoute: [
          {
            connection: { id: 'ab', from: 'a', to: 'b' },
            endpointPins: { from: from, to: to },
          },
        ],
        allowShift: false,
        repair: false,
      });

      expect(fallbacks).toEqual(new Set());
      const points = absoluteConnectionPoints(layoutManager.getConnectionById('ab')!);
      expect(points[0]).toEqual(from);
      expect(points.at(-1)).toEqual(to);
      expectOrthogonal(points);
    },
  );

  it.each(['same', 'opposite'] as const)(
    'routes a self-reference with distinct exact pins on %s faces',
    (faces) => {
      const layoutManager = manager();
      const from: Point = [80, 10.25];
      const to: Point = [faces === 'same' ? 80 : 0, 30.75];

      const { fallbacks } = routeConnections({
        layoutManager,
        connectionsToRoute: [
          {
            connection: { id: 'self', from: 'a', to: 'a' },
            endpointPins: { from: from, to: to },
          },
        ],
        allowShift: false,
        repair: false,
      });

      expect(fallbacks).toEqual(new Set());
      const points = absoluteConnectionPoints(layoutManager.getConnectionById('self')!);
      expect(points[0]).toEqual(from);
      expect(points[1][0]).toBeGreaterThan(from[0]);
      expect(points.at(-1)).toEqual(to);
      expect(points.at(-2)![1]).toBe(to[1]);
      expect(Math.sign(points.at(-2)![0] - to[0])).toBe(faces === 'same' ? 1 : -1);
    },
  );
});
