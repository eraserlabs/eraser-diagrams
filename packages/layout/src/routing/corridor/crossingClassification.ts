import { faceChordsCross, type FaceChord } from '../measure/crossings.js';
import type { Direction, PositionProps, XYPoint } from '../../types.js';
import type { Route } from './route.js';
import type { RouteCrossing } from './routeIndex.js';
import type { CorridorWorld } from './world.js';

/**
 * Exclude the one crossing forced by an outward-facing X of endpoint faces.
 * Repeated crossings remain repairable because only one crossing can be structurally expected.
 */
export function unexpectedCrossings(
  world: Pick<CorridorWorld, 'entities'>,
  routes: readonly Route[],
  crossings: readonly RouteCrossing[],
): RouteCrossing[] {
  const pairCounts = new Map<number, number>();
  for (const crossing of crossings) {
    const key = pairKey(crossing, routes.length);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const expectedPairs = new Set<number>();
  for (const crossing of crossings) {
    const key = pairKey(crossing, routes.length);
    if (pairCounts.get(key) !== 1 || expectedPairs.has(key)) {
      continue;
    }
    const routeA = routes[crossing.a.routeIndex];
    const routeB = routes[crossing.b.routeIndex];
    if (routeA && routeB && faceChordsCross(routeChord(world, routeA), routeChord(world, routeB))) {
      expectedPairs.add(key);
    }
  }
  return expectedPairs.size === 0
    ? [...crossings]
    : crossings.filter((crossing) => !expectedPairs.has(pairKey(crossing, routes.length)));
}

function pairKey(crossing: RouteCrossing, routeCount: number): number {
  const lower = Math.min(crossing.a.routeIndex, crossing.b.routeIndex);
  const upper = Math.max(crossing.a.routeIndex, crossing.b.routeIndex);
  return lower * routeCount + upper;
}

function routeChord(world: Pick<CorridorWorld, 'entities'>, route: Route): FaceChord {
  return {
    from: faceCenter(world.entities[route.from.entityIndex], route.from.face),
    fromFace: route.from.face,
    to: faceCenter(world.entities[route.to.entityIndex], route.to.face),
    toFace: route.to.face,
  };
}

function faceCenter(entity: PositionProps, face: Direction): XYPoint {
  switch (face) {
    case 'left':
      return { x: entity.x, y: entity.y + entity.height / 2 };
    case 'right':
      return { x: entity.x + entity.width, y: entity.y + entity.height / 2 };
    case 'up':
      return { x: entity.x + entity.width / 2, y: entity.y };
    case 'down':
      return { x: entity.x + entity.width / 2, y: entity.y + entity.height };
  }
}
