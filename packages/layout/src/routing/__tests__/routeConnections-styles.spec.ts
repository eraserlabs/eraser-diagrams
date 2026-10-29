import { vi } from 'vitest';
import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutConnection, LayoutEntity, NewConnection } from '../../types.js';
import { COMMIT_REPAIR, routeConnections } from '../routeConnections.js';
import * as execution from '../executeCorridorRouting.js';

/**
 * routeConnections reads each connection's style: elbow connections go to the corridor router,
 * straight and arc connections are one direct segment.
 */
const box = (id: string, x: number, y: number, width = 100, height = 60): LayoutEntity => ({
  id,
  x,
  y,
  width,
  height,
});

const absolute = (connection: Pick<LayoutConnection, 'x' | 'y' | 'points'>) =>
  connection.points.map(([px, py]) => [connection.x + px, connection.y + py]);

function layoutWith(entities: LayoutEntity[], connections: LayoutConnection[] = []) {
  return new LayoutManager({ entities, connections, primaryDirection: 'right' });
}

afterEach(() => vi.restoreAllMocks());

describe('routeConnections style dispatch', () => {
  it('routes a connection with no style as an elbow line', () => {
    const layout = layoutWith([box('a', 0, 0), box('b', 300, 200)]);
    const input: NewConnection = { id: 'l', from: 'a', to: 'b' };
    const { updates } = routeConnections({
      layoutManager: layout,
      repair: COMMIT_REPAIR,
      connectionsToRoute: [input],
    });
    const points = absolute(updates.get('l') as LayoutConnection);
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1]!;
      const [x1, y1] = points[i]!;
      expect(x0 === x1 || y0 === y1).toBe(true);
    }
  });

  it('a straight connection with no path runs centre to centre and never enters the corridor search', () => {
    const corridor = vi.spyOn(execution, 'executeCorridorRouting');
    const layout = layoutWith([box('a', 0, 0), box('b', 300, 0)]);
    const { updates, fallbacks } = routeConnections({
      layoutManager: layout,
      repair: COMMIT_REPAIR,
      connectionsToRoute: [{ id: 's', from: 'a', to: 'b', connectorStyle: 'straight' }],
    });
    expect(absolute(updates.get('s') as LayoutConnection)).toEqual([
      [100, 30],
      [300, 30],
    ]);
    expect(fallbacks.size).toBe(0);
    expect(corridor).not.toHaveBeenCalled();
  });

  it("an arc's bound ends keep their fixed anchors when an entity moves, and its bend is kept", () => {
    const arc: LayoutConnection = {
      id: 'arc',
      from: 'a',
      to: 'b',
      x: 100,
      y: 15,
      points: [
        [0, 0],
        [200, 30],
      ],
      connectorStyle: 'arc',
      bend: 40,
    };
    const layout = layoutWith([box('a', 0, 0), box('b', 300, 0)], [arc]);
    layout.initiateChanges();
    layout.updateEntity('b', { deltaX: 50, deltaY: 120 });
    const { updates } = routeConnections({
      layoutManager: layout,
      repair: COMMIT_REPAIR,
      updates: new Map([['b', { deltaX: 50, deltaY: 120 }]]),
    });
    expect(absolute(updates.get('arc') as LayoutConnection)).toEqual([
      [100, 15],
      [350, 165],
    ]);
    expect(layout.getConnectionById('arc')?.bend).toBe(40);
  });

  it("a straight connection's label centres on its middle", () => {
    const layout = layoutWith([box('a', 0, 0), box('b', 300, 0)]);
    const { updates } = routeConnections({
      layoutManager: layout,
      repair: COMMIT_REPAIR,
      connectionsToRoute: [
        {
          id: 's',
          from: 'a',
          to: 'b',
          connectorStyle: 'straight',
          textPlacement: { x: 0, y: 0, width: 40, height: 16 },
        },
      ],
    });
    const label = updates.get('s')!.textPlacement!;
    expect(label.x).toBeCloseTo(180, 4);
    expect(label.width).toBe(40);
  });

  it('a manual label on a straight line keeps its place along the line when the line moves', () => {
    const line: LayoutConnection = {
      id: 's',
      from: 'a',
      to: 'b',
      x: 100,
      y: 30,
      points: [
        [0, 0],
        [200, 0],
      ],
      connectorStyle: 'straight',
      textPlacement: { x: 110, y: 0, width: 40, height: 16 },
      textLineOffset: 24,
    };
    const layout = layoutWith([box('a', 0, 0), box('b', 300, 0)], [line]);
    layout.initiateChanges();
    layout.updateEntity('a', { deltaY: 100 });
    layout.updateEntity('b', { deltaY: 100 });
    const { updates } = routeConnections({
      layoutManager: layout,
      repair: COMMIT_REPAIR,
      updates: new Map([
        ['a', { deltaY: 100 }],
        ['b', { deltaY: 100 }],
      ]),
    });
    const label = updates.get('s')!.textPlacement!;
    expect(label.x).toBeCloseTo(110, 0);
    expect(label.y).toBeLessThan(130 - 16);
  });
});
