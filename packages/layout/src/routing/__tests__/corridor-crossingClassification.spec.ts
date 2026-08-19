import { unexpectedCrossings } from '../corridor/crossingClassification.js';
import { Route } from '../corridor/route.js';
import type { RouteCrossing } from '../corridor/routeIndex.js';
import type { CorridorWorld } from '../corridor/world.js';

const world = {
  entities: [
    { id: 'top-left', x: 0, y: 0, width: 20, height: 20 },
    { id: 'bottom-right', x: 100, y: 100, width: 20, height: 20 },
    { id: 'bottom-left', x: 0, y: 100, width: 20, height: 20 },
    { id: 'top-right', x: 100, y: 0, width: 20, height: 20 },
  ],
} satisfies Pick<CorridorWorld, 'entities'>;

const routes = [
  new Route(0, { entityIndex: 0, face: 'right' }, { entityIndex: 1, face: 'left' }, []),
  new Route(1, { entityIndex: 2, face: 'right' }, { entityIndex: 3, face: 'left' }, []),
];

const crossing = (index: number): RouteCrossing =>
  ({
    a: { routeIndex: 0, index: index * 2 },
    b: { routeIndex: 1, index: index * 2 + 1 },
  }) as unknown as RouteCrossing;

describe('routing corridor crossing classification', () => {
  it('skips a single endpoint-face X crossing', () => {
    expect(unexpectedCrossings(world, routes, [crossing(0)])).toEqual([]);
  });

  it('keeps repeated crossings between an expected pair repairable', () => {
    const crossings = [crossing(0), crossing(1)];
    expect(unexpectedCrossings(world, routes, crossings)).toEqual(crossings);
  });
});
