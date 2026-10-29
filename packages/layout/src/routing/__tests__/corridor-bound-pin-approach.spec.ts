import { LayoutManager } from '../../LayoutManager.js';
import type { Direction, LayoutConnection, LayoutEntity } from '../../types.js';
import { routeConnections } from '../routeConnections.js';
import { absoluteConnectionPoints } from '../points.js';
import type { EndpointSide, Point, RelativePortPosition } from '../types.js';

const entities: LayoutEntity[] = [
  { id: 'source', x: 0, y: 0, width: 80, height: 40 },
  { id: 'target', x: 240, y: 80, width: 80, height: 40 },
];

const connection: LayoutConnection = {
  id: 'drag',
  from: 'source',
  to: 'target',
  x: 80,
  y: 20,
  points: [
    [0, 0],
    [80, 0],
    [80, 80],
    [160, 80],
  ],
  relativeFromPort: [1, 0.5],
  relativeToPort: [0, 0.5],
};

function manager() {
  return new LayoutManager({ entities, connections: [connection], primaryDirection: 'right' });
}

function routeWithPin(x: number) {
  const layoutManager = manager();
  const { fallbacks } = routeConnections({
    layoutManager,
    connectionsToRoute: [{ connection, endpointPins: { to: [x, 100] } }],
    allowShift: false,
    repair: false,
  });
  return { fallbacks, points: absoluteConnectionPoints(layoutManager.getConnectionById('drag')!) };
}

describe('bound endpoint drag approach', () => {
  it.each([240, 245])('keeps the face-normal approach for an on/inside pin at x=%s', (x) => {
    const { fallbacks, points } = routeWithPin(x);
    expect(fallbacks).toEqual(new Set());
    expect(points[0]).toEqual([80, 20]);
    expect(points.at(-1)).toEqual([x, 100]);
    expect(points.at(-2)?.[1]).toBe(100);
  });
});

interface FaceCase {
  face: Direction;
  source: LayoutEntity;
  stationary: Point;
  sourcePort: RelativePortPosition;
  pin: Point;
  targetPort: RelativePortPosition;
}

const faceCases: FaceCase[] = [
  {
    face: 'left',
    source: entities[0],
    stationary: [80, 20],
    sourcePort: [1, 0.5],
    pin: [235, 100],
    targetPort: [0, 0.5],
  },
  {
    face: 'right',
    source: { id: 'source', x: 480, y: 0, width: 80, height: 40 },
    stationary: [480, 20],
    sourcePort: [0, 0.5],
    pin: [325, 100],
    targetPort: [1, 0.5],
  },
  {
    face: 'up',
    source: { id: 'source', x: 0, y: -160, width: 80, height: 40 },
    stationary: [40, -120],
    sourcePort: [0.5, 1],
    pin: [280, 75],
    targetPort: [0.5, 0],
  },
  {
    face: 'down',
    source: { id: 'source', x: 0, y: 240, width: 80, height: 40 },
    stationary: [40, 240],
    sourcePort: [0.5, 0],
    pin: [280, 125],
    targetPort: [0.5, 1],
  },
];

describe.each(faceCases)('$face face with an outside bound pin', (testCase) => {
  it.each<EndpointSide>(['from', 'to'])(
    'preserves a normal %s approach and other geometry',
    (side) => {
      const { source, stationary, sourcePort, pin, targetPort, face } = testCase;
      const dragged: LayoutConnection = {
        ...connection,
        from: side === 'from' ? 'target' : 'source',
        to: side === 'from' ? 'source' : 'target',
        relativeFromPort: side === 'from' ? targetPort : sourcePort,
        relativeToPort: side === 'from' ? sourcePort : targetPort,
      };
      const incumbent: LayoutConnection = {
        id: 'incumbent',
        from: '',
        to: '',
        x: 700,
        y: 700,
        points: [
          [0, 0],
          [50, 0],
        ],
      };
      const layoutManager = new LayoutManager({
        entities: [source, entities[1]],
        connections: [dragged, incumbent],
        primaryDirection: 'right',
      });
      const { fallbacks } = routeConnections({
        layoutManager,
        connectionsToRoute: [{ connection: dragged, endpointPins: { [side]: pin } }],
        allowShift: false,
        repair: false,
      });
      const routed = layoutManager.getConnectionById('drag')!;
      const points = absoluteConnectionPoints(routed);
      const ordered = side === 'from' ? [...points].reverse() : points;
      expect(fallbacks).toEqual(new Set());
      expect(ordered[0]).toEqual(stationary);
      expect(ordered.at(-1)).toEqual(pin);
      expect(side === 'from' ? routed.relativeFromPort : routed.relativeToPort).toEqual(targetPort);
      expect(side === 'from' ? routed.relativeToPort : routed.relativeFromPort).toEqual(sourcePort);
      const adjacent = ordered.at(-2)!;
      if (face === 'left' || face === 'right') {
        expect(adjacent[1]).toBe(pin[1]);
        expect((pin[0] - adjacent[0]) * (face === 'left' ? 1 : -1)).toBeGreaterThan(0);
      } else {
        expect(adjacent[0]).toBe(pin[0]);
        expect((pin[1] - adjacent[1]) * (face === 'up' ? 1 : -1)).toBeGreaterThan(0);
      }
      expect(layoutManager.getConnectionById('incumbent')).toEqual(incumbent);
    },
  );
});

describe.each([
  { overhang: 'left', x: -10, fraction: -0.25 },
  { overhang: 'right', x: 50, fraction: 1.25 },
])('$overhang bottom-label overhang', ({ x, fraction }) => {
  it.each<EndpointSide>(['from', 'to'])(
    'preserves the stationary %s port while the free end moves',
    (side) => {
      const stationary: Point = [x, 65];
      const free: Point = [200, 100];
      const pin: Point = [200, 120];
      const start = side === 'from' ? stationary : free;
      const end = side === 'from' ? free : stationary;
      const port: RelativePortPosition = [fraction, 1];
      const dragged: LayoutConnection = {
        id: 'overhang',
        from: side === 'from' ? 'icon' : '',
        to: side === 'to' ? 'icon' : '',
        x: start[0],
        y: start[1],
        points: [
          [0, 0],
          [end[0] - start[0], end[1] - start[1]],
        ],
        ...(side === 'from' ? { relativeFromPort: port } : { relativeToPort: port }),
      };
      const layoutManager = new LayoutManager({
        entities: [
          {
            id: 'icon',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            textPlacement: { relativeX: -20, relativeY: 45, width: 80, height: 20 },
          },
        ],
        connections: [dragged],
        primaryDirection: 'right',
      });
      routeConnections({
        layoutManager,
        connectionsToRoute: [
          {
            connection: dragged,
            endpointPins: { [side === 'from' ? 'to' : 'from']: pin },
          },
        ],
        allowShift: false,
        repair: false,
      });
      const routed = layoutManager.getConnectionById('overhang')!;
      const points = absoluteConnectionPoints(routed);
      expect(side === 'from' ? points[0] : points.at(-1)).toEqual(stationary);
      expect(side === 'from' ? points.at(-1) : points[0]).toEqual(pin);
      expect(side === 'from' ? routed.relativeFromPort : routed.relativeToPort).toEqual(port);
    },
  );
});
