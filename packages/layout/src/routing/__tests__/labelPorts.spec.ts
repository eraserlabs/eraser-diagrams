import { LayoutManager } from '../../LayoutManager.js';
import { getPortDirection } from '../../directionUtils.js';
import { LayoutConnection } from '../../types.js';
import {
  getAbsolutePortFromEntityAndConnection,
  getProjectedFaceRange,
  getRelativePort,
} from '../points.js';
import { routeConnections } from '../routeConnections.js';
import { entWithTextBelow, simpleEntity } from '../routingTestUtils.js';

const icon = entWithTextBelow(
  'icon',
  { x: 100, y: 40 },
  {
    relativeX: -40,
    relativeY: 60,
    width: 130,
    height: 40,
  },
);

describe('ports across a label wider than its icon', () => {
  it.each([65, 100, 125, 150, 185])('keeps the bottom port at x=%s through projection', (x) => {
    const point: [number, number] = [x, 140];
    expect(getPortDirection(point, icon)).toBe('down');
    const relativePort = getRelativePort(icon, point, 'down');
    expect(getAbsolutePortFromEntityAndConnection(icon, relativePort, true, 'down')).toEqual(point);
    expect(getProjectedFaceRange(icon, 'down')).toEqual({
      minX: 60,
      maxX: 190,
      minY: 40,
      maxY: 140,
    });
  });

  it.each(['from', 'to'] as const)(
    'preserves an off-center %s attachment when rerouted',
    (side) => {
      const connection: LayoutConnection = {
        id: 'connection',
        from: side === 'from' ? icon.id : '',
        to: side === 'to' ? icon.id : '',
        x: 350,
        y: 300,
        points: [
          [0, 0],
          [100, 100],
        ],
      };
      const lm = new LayoutManager({ entities: [icon], connections: [connection] });
      for (const x of [65, 110, 185]) {
        routeConnections({
          layoutManager: lm,
          connectionsToRoute: [
            {
              connection: lm.getConnectionById(connection.id)!,
              endpointPins: { [side]: [x, 140] },
            },
          ],
          allowShift: false,
          repair: false,
        });
        const routed = lm.getConnectionById(connection.id)!;
        const point = side === 'from' ? routed.points[0] : routed.points.at(-1)!;
        const next = side === 'from' ? routed.points[1] : routed.points.at(-2)!;
        expect([routed.x + point[0], routed.y + point[1]]).toEqual([x, 140]);
        expect(next[0]).toBe(point[0]);
        expect(next[1]).toBeGreaterThan(point[1]);
      }
      lm.applyStagedChanges();
      lm.updateEntity(icon.id, { deltaX: 25, deltaY: 35 });
      routeConnections({
        layoutManager: lm,
        connectionsToRoute: [lm.getConnectionById(connection.id)!],
        allowShift: false,
        repair: false,
      });
      const moved = lm.getConnectionById(connection.id)!;
      const endpoint = side === 'from' ? moved.points[0] : moved.points.at(-1)!;
      expect([moved.x + endpoint[0], moved.y + endpoint[1]]).toEqual([210, 175]);
    },
  );

  it('keeps top and side ports on the icon body', () => {
    for (const [point, direction] of [
      [[125, 40], 'up'],
      [[100, 65], 'left'],
      [[150, 65], 'right'],
    ] as const) {
      expect(getPortDirection([...point], icon)).toBe(direction);
      const port = getRelativePort(icon, [...point], direction);
      expect(getAbsolutePortFromEntityAndConnection(icon, port, true, direction)).toEqual(point);
    }
  });

  it('re-derives a stored port from its whole-pixel point without drift', () => {
    const entity = simpleEntity('e', {});
    const port = getRelativePort(entity, [29, 0], 'up'); // 50 * (29/50) = 28.999999999999996
    expect(getAbsolutePortFromEntityAndConnection(entity, port, true, 'up')).toEqual([29, 0]);
  });
});
