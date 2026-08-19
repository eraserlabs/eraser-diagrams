import { vi } from 'vitest';
import { LayoutManager } from '../../LayoutManager.js';
import {
  LayoutConnectionTextPlacementSource,
  type LayoutConnection,
  type LayoutEntity,
  type NewConnection,
} from '../../types.js';
import * as corridorRouting from '../executeCorridorRouting.js';
import { routeCorridorConnectionBatch } from '../corridorRoutingAdapter.js';
import { CorridorSpacingError } from '../corridor/spacing.js';

function entities(): LayoutEntity[] {
  return [
    {
      id: 'a',
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      isContainer: false,
      containerId: null,
    },
    {
      id: 'b',
      x: 240,
      y: 0,
      width: 80,
      height: 40,
      isContainer: false,
      containerId: null,
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

describe('routeCorridorConnectionBatch shared-layout adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('commits a complete repaired and labeled batch as ordinary relative connections', () => {
    const layoutManager = manager();
    const executeSpy = vi.spyOn(corridorRouting, 'executeCorridorRouting');

    const output = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [labeledConnection()],
    });

    expect(output).toEqual([{ connectionId: 'ab', status: 'valid' }]);
    expect(executeSpy.mock.calls[0][1][0]).toMatchObject({
      from: { hasArrowhead: false },
      to: { hasArrowhead: true },
    });

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
    const executeSpy = vi.spyOn(corridorRouting, 'executeCorridorRouting');

    const output = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [labeledConnection('second')],
    });

    expect(output).toBeDefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(layoutManager.getConnectionById('existing')).toEqual(existing);
    const second = layoutManager.getConnectionById('second');
    expect(second?.points.length).toBeGreaterThanOrEqual(2);
    expect({ x: second?.x, y: second?.y, points: second?.points }).not.toEqual({
      x: existing.x,
      y: existing.y,
      points: existing.points,
    });
    expect(output).toEqual([{ connectionId: 'second', status: 'valid' }]);
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

    const output = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [labeledConnection('second')],
    });

    expect(output).toEqual([{ connectionId: 'second', status: 'valid' }]);
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
    const executeSpy = vi.spyOn(corridorRouting, 'executeCorridorRouting');

    const output = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [labeledConnection('selected')],
    });

    expect(output).toEqual([{ connectionId: 'selected', status: 'valid' }]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(layoutManager.getConnectionById('dangling')).toEqual(dangling);
    expect(layoutManager.getConnectionById('diagonal')).toEqual(unadoptable);
  });

  it('owns and reports fallback geometry when corridor input is unsupported', () => {
    const layoutManager = manager();
    const result = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [
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
      ],
      options: { repair: false, labels: false },
    });

    expect(result).toEqual([{ connectionId: 'free', status: 'fallback' }]);
    expect(layoutManager.getConnectionById('free')?.points.length).toBeGreaterThanOrEqual(2);
  });

  it('routes bound selections fresh while independently rebuilding a dangling selection', () => {
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
    const executeSpy = vi.spyOn(corridorRouting, 'executeCorridorRouting');
    const result = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [dangling, mangled],
      options: { repair: false, labels: false },
    });

    expect(result).toEqual([
      { connectionId: 'dangling', status: 'fallback' },
      { connectionId: 'bound', status: 'valid' },
    ]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(layoutManager.getConnectionById('bound')?.points.length).toBeGreaterThanOrEqual(2);
    expect(layoutManager.getConnectionById('dangling')).toMatchObject({
      x: 80,
      y: 20,
      points: [
        [0, 0],
        [60, 0],
        [60, 80],
        [120, 80],
      ],
    });
  });

  it('uses a non-throwing direct line when corridor routing cannot bind endpoints', () => {
    const layoutManager = manager();
    const result = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [{ id: 'unbound', from: 'missing-a', to: 'missing-b' }],
    });

    expect(result).toEqual([{ connectionId: 'unbound', status: 'fallback' }]);
    expect(layoutManager.getConnectionById('unbound')?.points).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('drops an attributed spacing corridor and reruns the surviving routes', () => {
    const strictExecution = corridorRouting.executeCorridorRouting;
    const executeSpy = vi
      .spyOn(corridorRouting, 'executeCorridorRouting')
      .mockImplementationOnce(() => {
        throw new CorridorSpacingError(7, [0], 'test infeasible component');
      })
      .mockImplementation(strictExecution);
    const layoutManager = manager();

    const result = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [labeledConnection('failed'), labeledConnection('survivor')],
      options: { repair: false, labels: false },
    });

    expect(result).toEqual([
      { connectionId: 'failed', status: 'fallback' },
      { connectionId: 'survivor', status: 'valid' },
    ]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy.mock.calls[1][1]).toMatchObject([{ requestIndex: 0 }]);
    expect(layoutManager.getConnectionById('failed')?.points.length).toBeGreaterThanOrEqual(2);
    expect(layoutManager.getConnectionById('survivor')?.points.length).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when spacing attribution mixes valid and invalid route indexes', () => {
    vi.spyOn(corridorRouting, 'executeCorridorRouting').mockImplementationOnce(() => {
      throw new CorridorSpacingError(7, [0, 999], 'invalid attribution');
    });

    const result = routeCorridorConnectionBatch({
      layoutManager: manager(),
      connectionsToRoute: [labeledConnection('first'), labeledConnection('second')],
      options: { repair: false, labels: false },
    });

    expect(result).toEqual([
      { connectionId: 'first', status: 'fallback' },
      { connectionId: 'second', status: 'fallback' },
    ]);
  });

  it('isolates an unbound fallback from a routable connection with fixed ports', () => {
    const layoutManager = manager();
    const result = routeCorridorConnectionBatch({
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

    expect(result).toEqual([
      { connectionId: 'fixed', status: 'valid' },
      { connectionId: 'unbound', status: 'fallback' },
    ]);
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

    const output = routeCorridorConnectionBatch({
      layoutManager,
      connectionsToRoute: [{ id: 'route', from: 'icon', to: 'target' }],
      options: { preservePorts: false, repair: false, labels: false },
    });

    expect(output).toEqual([{ connectionId: 'route', status: 'valid' }]);
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

    const output = routeCorridorConnectionBatch({
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
      options: { preservePorts: false, repair: false, labels: false },
    });

    expect(output).toEqual([{ connectionId: 'route', status: 'valid' }]);
    const routed = layoutManager.getConnectionById('route');
    expect([routed?.x, routed?.y]).toEqual([25, 79]);
    expect(routed?.relativeFromPort).toEqual([0.5, 1]);
  });
});
