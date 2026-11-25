import { vi } from 'vitest';
import { LayoutManager } from '../../LayoutManager.js';
import { makeEntity } from '../../testUtils.js';
import type { LayoutChange, LayoutConnection, LayoutEntity } from '../../types.js';
import { COMMIT_REPAIR, routeConnections } from '../routeConnections.js';
import * as execution from '../executeCorridorRouting.js';
import type { RepairPolicy } from '../executeCorridorRouting.js';
import * as productionRepair from '../corridor/productionRepair.js';
import { absoluteConnectionPoints } from '../points.js';
import { checkIfOverlapsEntity } from '../shiftRouting.js';
import type { Point } from '../types.js';

const skippedLane: LayoutEntity = {
  id: 'lane',
  x: 200,
  y: 0,
  width: 150,
  height: 180,
  isContainer: true,
  options: { skipRoutingObstacle: true },
  textPlacement: { relativeX: 100, relativeY: 140, width: 80, height: 30 },
};
/** What routing sees of the lane: its title box as a plain obstacle. */
const laneTitle: LayoutEntity = { id: 'lane', x: 300, y: 140, width: 80, height: 30 };

it('routes through skipped containers without changing the layout hierarchy', () => {
  const pool: LayoutEntity = {
    id: 'pool',
    x: -50,
    y: -50,
    width: 900,
    height: 400,
    isContainer: true,
  };
  const lane: LayoutEntity = {
    id: 'lane',
    x: -25,
    y: -25,
    width: 850,
    height: 150,
    isContainer: true,
    containerId: 'wrapper',
    options: { skipRoutingObstacle: true },
  };
  const source = { ...makeEntity('source', { x: 0, y: 0 }), containerId: 'lane' };
  const target = { ...makeEntity('target', { x: 700, y: 200 }), containerId: 'pool' };
  const wrapper: LayoutEntity = {
    ...lane,
    id: 'wrapper',
    x: -1000,
    width: 3000,
    containerId: 'pool',
  };
  const entities = [pool, wrapper, lane, source, target];
  const routed = new LayoutManager({ entities, connections: [], primaryDirection: 'right' });
  const flattened = new LayoutManager({
    entities: [pool, { ...source, containerId: 'pool' }, target],
    connections: [],
    primaryDirection: 'right',
  });
  const connectionsToRoute = [{ id: 'line', from: 'source', to: 'target' }];
  const result = routeConnections({
    repair: COMMIT_REPAIR,
    layoutManager: routed,
    connectionsToRoute,
  });
  routeConnections({ repair: COMMIT_REPAIR, layoutManager: flattened, connectionsToRoute });
  expect(result.fallbacks).toEqual(new Set());
  expect(routed.getConnectionById('line')).toEqual(flattened.getConnectionById('line'));
  expect(routed.getEntities()).toEqual(entities);
});

describe.each([
  ['divider', false],
  ['lane', true],
] as const)('routing through a skipped %s', (_, isContainer) => {
  const skipped = (textPlacement?: LayoutEntity['textPlacement']): LayoutEntity => ({
    id: 'skipped',
    x: 296,
    y: -200,
    width: isContainer ? 60 : 8,
    height: 1000,
    isContainer,
    options: { skipRoutingObstacle: true },
    ...(textPlacement ? { textPlacement } : {}),
  });
  const scene = (extraEntities: LayoutEntity[]) =>
    new LayoutManager({
      entities: [
        makeEntity('a', { x: 0, y: 200 }),
        makeEntity('b', { x: 500, y: 200 }),
        ...extraEntities,
      ],
      connections: [],
      primaryDirection: 'right',
    });
  const route = (layoutManager: LayoutManager) =>
    routeConnections({
      layoutManager,
      connectionsToRoute: [{ id: 'ab', from: 'a', to: 'b' }],
      repair: COMMIT_REPAIR,
    });
  const move = (layoutManager: LayoutManager, update: LayoutChange) => {
    layoutManager.applyStagedChanges();
    layoutManager.initiateChanges();
    layoutManager.updateEntity('a', update);
    return routeConnections({ layoutManager, updates: new Map([['a', update]]), repair: false });
  };

  it('routes through an unlabeled body exactly as if it were absent', () => {
    const withSkipped = scene([skipped()]);
    const without = scene([]);
    expect(route(withSkipped)).toEqual(route(without));
    for (const update of [{ deltaY: 15 }, { deltaX: 15 }, { deltaY: -40 }]) {
      expect(move(withSkipped, update)).toEqual(move(without, update));
      expect(withSkipped.getConnectionById('ab')).toEqual(without.getConnectionById('ab'));
    }
    expect(withSkipped.getEntityById('skipped')).toEqual(skipped());
  });

  it('keeps lines out of its label while crossing its body', () => {
    const label = { x: 266, y: 200, width: 68, height: 50 };
    const layoutManager = scene([
      skipped({
        relativeX: label.x - 296,
        relativeY: label.y + 200,
        width: label.width,
        height: label.height,
      }),
    ]);
    expect(route(layoutManager).fallbacks).toEqual(new Set());
    const points = absoluteConnectionPoints(layoutManager.getConnectionById('ab')!);
    const segments = points.slice(1).map((end, index) => [points[index], end] as const);
    const entersLabel = segments.some(
      ([[x1, y1], [x2, y2]]) =>
        Math.max(x1, x2) > label.x &&
        Math.min(x1, x2) < label.x + label.width &&
        Math.max(y1, y2) > label.y &&
        Math.min(y1, y2) < label.y + label.height,
    );
    expect(entersLabel).toBe(false);
    // The detour hugs the label instead of going around the whole body.
    expect(Math.max(...points.map(([, y]) => Math.abs(y - 225)))).toBeLessThan(150);
  });
});

function fixture(extraEntities: LayoutEntity[] = [], patch: Partial<LayoutConnection> = {}) {
  const connection: LayoutConnection = {
    id: 'route',
    from: 'source',
    to: 'target',
    x: 100,
    y: 25,
    points: [
      [0, 0],
      [150, 0],
      [150, 100],
      [450, 100],
      [450, 200],
      [600, 200],
    ],
    relativeFromPort: [1, 0.5],
    relativeToPort: [0, 0.5],
    ...patch,
  };
  const layoutManager = new LayoutManager({
    entities: [
      makeEntity('source', { x: 0, y: 0 }),
      makeEntity('target', { x: 700, y: 200 }),
      ...extraEntities,
    ],
    connections: [connection],
    primaryDirection: 'right',
  });
  const points = () => absoluteConnectionPoints(layoutManager.getConnectionById('route')!);
  const move = (updates: [string, LayoutChange][]) => {
    for (const [id, update] of updates) {
      layoutManager.updateEntity(id, update);
    }
    return routeConnections({
      layoutManager,
      updates: new Map(updates),
      repair: false,
    });
  };
  return { connection, layoutManager, points, move };
}

afterEach(() => vi.restoreAllMocks());

describe('repair policy', () => {
  function routeWith(repair: RepairPolicy) {
    const repairRoutes = vi.spyOn(productionRepair, 'repairProductionRoutes');
    const layoutManager = new LayoutManager({
      entities: [makeEntity('a', { x: 0, y: 0 }), makeEntity('b', { x: 400, y: 200 })],
      connections: [],
      primaryDirection: 'right',
    });
    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [{ id: 'ab', from: 'a', to: 'b' }],
      repair,
    });
    expect(fallbacks).toEqual(new Set());
    return repairRoutes;
  }

  it('never runs production repair when the policy is off', () => {
    expect(routeWith(false)).not.toHaveBeenCalled();
  });

  it('hands the policy budget to production repair unchanged', () => {
    const repairRoutes = routeWith({ timeBudgetMs: 37 });
    expect(repairRoutes).toHaveBeenCalledTimes(1);
    expect(repairRoutes.mock.calls[0][4]).toMatchObject({ timeBudgetMs: 37 });
  });
});

describe('preserved route geometry', () => {
  it.each([false, true])(
    'matches a layout holding only the lane title for shifts, labels and retained obstacles (child=%s)',
    (hasChild) => {
      const child = makeEntity('child', { x: 240, y: 50 }, { width: 30, height: 30 });
      const label = { textPlacement: { x: 350, y: 110, width: 40, height: 14 } };
      const routed = fixture(
        [skippedLane, ...(hasChild ? [{ ...child, containerId: 'lane' }] : [])],
        label,
      );
      const flattened = fixture([laneTitle, ...(hasChild ? [child] : [])], label);
      for (const updates of [
        [['source', { deltaX: -20, deltaY: 10 }]],
        [['source', { deltaX: 20, deltaY: -10 }]],
        [
          ['source', { deltaX: 1 }],
          ['target', { deltaX: 1 }],
        ],
      ] as [string, LayoutChange][][]) {
        expect(routed.move(updates)).toEqual(flattened.move(updates));
        expect(routed.layoutManager.getConnections()).toEqual(
          flattened.layoutManager.getConnections(),
        );
        expect(routed.layoutManager.getConnectionById('route', false)).toEqual(routed.connection);
        expect(routed.layoutManager.getEntityById('lane')).toEqual(skippedLane);
        expect(routed.layoutManager.stagedChanges?.deletes.size).toBe(0);
        expect(routed.layoutManager.stagedChanges?.updates.has('lane')).toBe(false);
      }
      if (hasChild) {
        expect(routed.layoutManager.getEntityById('child')?.containerId).toBe('lane');
      } else {
        expect(routed.layoutManager.getConnectionById('route')).toMatchObject({
          x: routed.connection.x + 1,
          y: routed.connection.y,
          points: routed.connection.points,
        });
      }
    },
  );

  it('keeps a fractional source pin as the direct shifted origin', () => {
    const { connection, layoutManager } = fixture();
    layoutManager.updateEntity('source', { deltaX: -99.7 });

    routeConnections({
      layoutManager,
      connectionsToRoute: [{ connection, endpointPins: { from: [0.3, 20] } }],
      repair: false,
    });

    expect(absoluteConnectionPoints(layoutManager.getConnectionById(connection.id)!)[0]).toEqual([
      0.3, 20,
    ]);
  });

  it('refreshes label placement after a partial source shift', () => {
    const { layoutManager, move } = fixture([], {
      textPlacement: { x: 350, y: 110, width: 40, height: 14 },
    });
    move([['source', { deltaX: -20, deltaY: 10 }]]);
    expect(layoutManager.getConnectionById('route')?.textPlacement).toEqual({
      x: 380,
      y: 118,
      width: 40,
      height: 14,
    });
  });

  it.each([
    ['checkpointed', 0.5],
    ['cumulative', 0.5],
    ['checkpointed', 0.33],
    ['cumulative', 0.33],
  ] as const)('restores authored bends after a %s routing excursion (port %s)', (mode, port) => {
    // Target track relative to the route origin; 0.33 lands off the whole-pixel grid.
    const track = 175 + port * 50;
    const { connection, layoutManager, points, move } = fixture([skippedLane], {
      x: 102,
      points: [
        [0, 0],
        [148, 0],
        [148, 100],
        [448, 100],
        [448, track],
        [596, track],
      ],
      relativeToPort: [0, port],
    });
    const initial = absoluteConnectionPoints(connection);
    const checkpoint = layoutManager.checkpoint('drag');
    let previous: Point = [0, 0];
    for (const [x, y] of [
      [600, 10],
      [20, 10],
      [0, 0],
    ] as Point[]) {
      if (mode === 'checkpointed') {
        layoutManager.restore(checkpoint);
        previous = [0, 0];
      }
      move([['target', { deltaX: x - previous[0], deltaY: y - previous[1] }]]);
      if (x < 500) {
        expect(points()).toEqual([
          ...initial.slice(0, -2),
          [550, 25 + track + y],
          [698 + x, 25 + track + y],
        ]);
      }
      expect(layoutManager.getConnectionById(connection.id, false)).toEqual(connection);
      previous = [x, y];
    }
  });

  it.each(['return', 'stationary'] as const)(
    'rejects an obstructed baseline on a %s frame',
    (frame) => {
      const { connection, layoutManager, points, move } = fixture([
        makeEntity('obstacle', { x: 450, y: 400 }, { width: 20, height: 20 }),
      ]);
      if (frame === 'return') {
        move([['target', { deltaY: 10 }]]);
      }
      move([
        ['target', { deltaY: frame === 'return' ? -10 : 0 }],
        ['obstacle', { deltaY: -285 }],
      ]);
      expect(points()).not.toEqual(absoluteConnectionPoints(connection));
      expect(
        checkIfOverlapsEntity(layoutManager, layoutManager.getConnectionById('route')!, 'route'),
      ).toBe(false);
    },
  );

  it.each([0, 10])(
    'reroutes resize growth that swallows a middle segment (endpoint delta %s)',
    (deltaY) => {
      const { connection, layoutManager, move, points } = fixture([], {
        points: [
          [0, 0],
          [100, 0],
          [100, 100],
          [500, 100],
          [500, 200],
          [700, 200],
        ],
        relativeToPort: [1, 0.5],
      });
      layoutManager.updateEntity('target', { deltaX: -300 });
      connection.points[5] = [400, 200];
      layoutManager.applyStagedChanges();
      move([['target', { deltaY: -150 + deltaY, deltaHeight: 300 }]]);
      expect(points().at(-1)).toEqual([500, 225 + deltaY]);
      expect(
        checkIfOverlapsEntity(layoutManager, layoutManager.getConnectionById('route')!, 'route'),
      ).toBe(false);
    },
  );

  it('preserves a rounded caption anchor on a partner nudge and reprojects changed caption bounds', () => {
    const caption = { relativeX: 0, relativeY: 55, width: 100, height: 22.5 };
    const { layoutManager, move, points } = fixture([], {
      x: 50,
      y: 78,
      points: [
        [0, 0],
        [0, 322],
      ],
      relativeFromPort: [0.5, 1],
      relativeToPort: [0.5, 0],
    });
    layoutManager.updateEntity('source', { textPlacement: caption });
    layoutManager.updateEntity('target', { deltaX: -700, deltaY: 200 });
    layoutManager.applyStagedChanges();
    move([['target', { deltaY: 1 }]]);
    expect(points()).toEqual([
      [50, 78],
      [50, 401],
    ]);
    move([
      ['target', { deltaY: -1 }],
      ['source', { textPlacement: { ...caption, height: 24.5 } }],
    ]);
    expect(points()).toEqual([
      [50, 79.5],
      [50, 400],
    ]);
  });

  it.each([false, true])(
    'preserves an accepted shift beside another route (fallback=%s)',
    (fallback) => {
      const { connection, layoutManager, points } = fixture([
        skippedLane,
        makeEntity('other-source', { x: 0, y: 500 }),
        makeEntity('other-target', { x: 700, y: 500 }),
      ]);
      layoutManager.addConnection({
        id: 'searched',
        from: 'other-source',
        to: 'other-target',
        x: 100,
        y: 525,
        relativeFromPort: [1, 0.5],
        relativeToPort: [0, 0.5],
        points: [
          [0, 0],
          [600, 0],
        ],
      });
      layoutManager.applyStagedChanges();
      if (fallback) {
        vi.spyOn(execution, 'executeCorridorRouting').mockImplementation(() => {
          throw new Error('routing failure');
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
      }
      layoutManager.updateEntity('source', { deltaY: 10 });
      layoutManager.updateEntity('other-source', { deltaY: 10 });
      const result = routeConnections({
        layoutManager,
        updates: new Map([
          ['source', { deltaY: 10 }],
          ['other-source', { deltaY: 10 }],
        ]),
        repair: false,
      });
      expect(points()).toEqual([
        [100, 35],
        [250, 35],
        ...absoluteConnectionPoints(connection).slice(2),
      ]);
      expect(result.fallbacks).toEqual(new Set(fallback ? ['searched'] : []));
      expect(absoluteConnectionPoints(layoutManager.getConnectionById('searched')!)[0]).toEqual([
        100, 535,
      ]);
      expect(new Set(result.updates.keys())).toEqual(new Set(['route', 'searched']));
    },
  );
});

describe('free-ended routes', () => {
  function danglingFixture() {
    const dangling: LayoutConnection = {
      id: 'dangling',
      from: 'a',
      to: '',
      x: 80,
      y: 20,
      points: [
        [0, 0],
        [40, 0],
        [40, 80],
        [160, 80],
        [160, 100],
        [320, 100],
      ],
      relativeFromPort: [1, 0.5],
    };
    const layoutManager = new LayoutManager({
      entities: [makeEntity('a', { x: 0, y: 0 }, { width: 80, height: 40 })],
      connections: [dangling],
      primaryDirection: 'right',
    });
    return { dangling, layoutManager };
  }

  it('shifts the bound end of a dangling route and keeps its free end fixed', () => {
    const { dangling, layoutManager } = danglingFixture();
    layoutManager.updateEntity('a', { deltaY: 4 });
    const { fallbacks } = routeConnections({
      layoutManager,
      updates: new Map([['a', { deltaY: 4 }]]),
      repair: false,
    });
    const shifted = layoutManager.getConnectionById('dangling')!;
    expect(fallbacks).toEqual(new Set());
    expect(absoluteConnectionPoints(shifted)).toEqual([
      [80, 24],
      [120, 24],
      ...absoluteConnectionPoints(dangling).slice(2),
    ]);
    expect(shifted.relativeToPort).toBeUndefined();
  });

  it('shifts a pinned free end along its stored tail', () => {
    const { dangling, layoutManager } = danglingFixture();
    routeConnections({
      layoutManager,
      connectionsToRoute: [{ connection: dangling, endpointPins: { to: [400, 130] } }],
      repair: false,
    });
    expect(absoluteConnectionPoints(layoutManager.getConnectionById('dangling')!)).toEqual([
      ...absoluteConnectionPoints(dangling).slice(0, -2),
      [240, 130],
      [400, 130],
    ]);
  });

  it('spaces a new route off an adopted free-ended incumbent', () => {
    const dangling: LayoutConnection = {
      id: 'dangling',
      from: 'a',
      to: '',
      x: 80,
      y: 20,
      points: [
        [0, 0],
        [120, 0],
      ],
      relativeFromPort: [1, 0.5],
    };
    const layoutManager = new LayoutManager({
      entities: [
        makeEntity('a', { x: 0, y: 0 }, { width: 80, height: 40 }),
        makeEntity('b', { x: 240, y: 0 }, { width: 80, height: 40 }),
      ],
      connections: [dangling],
      primaryDirection: 'right',
    });
    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [{ id: 'ab', from: 'a', to: 'b' }],
      allowShift: false,
      repair: false,
    });
    expect(fallbacks).toEqual(new Set());
    expect(layoutManager.getConnectionById('dangling')).toEqual(dangling);
    const routed = absoluteConnectionPoints(layoutManager.getConnectionById('ab')!);
    const [[danglingStartX, danglingY], [danglingEndX]] = absoluteConnectionPoints(dangling);
    const sharesTrack = routed.slice(1).some(([x1, y1], index) => {
      const [x0, y0] = routed[index];
      return (
        y0 === danglingY &&
        y1 === danglingY &&
        Math.max(Math.min(x0, x1), danglingStartX) < Math.min(Math.max(x0, x1), danglingEndX)
      );
    });
    expect(sharesTrack).toBe(false);
  });
});

describe('corridor commits', () => {
  it('keeps the corridor inside approach to a pinned container face', () => {
    const group: LayoutEntity = {
      id: 'group',
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      isContainer: true,
    };
    const child = makeEntity(
      'child',
      { x: 40, y: 60 },
      { width: 100, height: 60, containerId: 'group' },
    );
    const layoutManager = new LayoutManager({
      entities: [group, child],
      connections: [],
      primaryDirection: 'right',
    });
    const reroute = (endpointPins: { from: Point; to: Point }) =>
      routeConnections({
        layoutManager,
        connectionsToRoute: [
          { connection: layoutManager.getConnectionById('edge')!, endpointPins },
        ],
        allowShift: false,
        repair: false,
      }).fallbacks;
    routeConnections({
      layoutManager,
      connectionsToRoute: [{ id: 'edge', from: 'child', to: 'group', toArrowhead: true }],
      repair: false,
    });
    const seeded = absoluteConnectionPoints(layoutManager.getConnectionById('edge')!);
    const [wallX, wallY] = seeded.at(-1)!;
    // The seed reaches the group's left wall from inside the group.
    expect(wallX).toBe(group.x);
    expect(seeded.at(-2)![0]).toBeGreaterThan(wallX);

    expect(reroute({ from: seeded[0], to: [wallX, wallY] })).toEqual(new Set());
    expect(absoluteConnectionPoints(layoutManager.getConnectionById('edge')!)).toEqual(seeded);

    const dragged: Point = [wallX, wallY + 30];
    expect(reroute({ from: seeded[0], to: dragged })).toEqual(new Set());
    expect(absoluteConnectionPoints(layoutManager.getConnectionById('edge')!).at(-1)).toEqual(
      dragged,
    );
  });

  it.each<[string, Partial<LayoutConnection>]>([
    ['authored faces', { authoredFromFace: 'right', authoredToFace: 'right' }],
    ['equal ports', { relativeFromPort: [1, 0.5], relativeToPort: [1, 0.5] }],
  ])('routes a trackless same-face self-loop beside a peer (%s)', (_, loop) => {
    const layoutManager = new LayoutManager({
      entities: [
        makeEntity('a', { x: 0, y: 0 }, { width: 100, height: 60 }),
        makeEntity('b', { x: 300, y: 0 }, { width: 100, height: 60 }),
      ],
      connections: [],
      primaryDirection: 'right',
    });
    const { fallbacks } = routeConnections({
      layoutManager,
      connectionsToRoute: [
        { id: 'loop', from: 'a', to: 'a', ...loop },
        { id: 'peer', from: 'a', to: 'b' },
      ],
      repair: false,
    });
    expect(fallbacks).toEqual(new Set());
    const routed = absoluteConnectionPoints(layoutManager.getConnectionById('loop')!);
    const [start, end] = [routed[0], routed.at(-1)!];
    expect([start[0], end[0]]).toEqual([100, 100]);
    expect(start[1]).not.toBe(end[1]);
  });
});
