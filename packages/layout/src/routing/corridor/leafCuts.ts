import type { PositionProps } from '../../types.js';
import { AUTHORED_PORT_TOLERANCE_PX } from './contract.js';
import { segmentPiercesRect } from './geometry.js';
import type { Route } from './route.js';
import type { RouteIndexer } from './routeIndex.js';
import type { CorridorWorld } from './world.js';

const ENTITY_CUT_INSET_PX = 4;

export interface LeafRect {
  readonly entityIndex: number;
  readonly rect: PositionProps;
}

/** Inset interiors of every leaf (non-container) entity; piercing one is an entity cut. */
export function leafRects(world: CorridorWorld): LeafRect[] {
  const result: LeafRect[] = [];
  for (let entityIndex = 0; entityIndex < world.entities.length; entityIndex += 1) {
    const entity = world.entities[entityIndex];
    if (entity.isContainer) {
      continue;
    }
    const rect = {
      x: entity.x + ENTITY_CUT_INSET_PX,
      y: entity.y + ENTITY_CUT_INSET_PX,
      width: entity.width - 2 * ENTITY_CUT_INSET_PX,
      height: entity.height - 2 * ENTITY_CUT_INSET_PX,
    };
    if (rect.width > 0 && rect.height > 0) {
      result.push({ entityIndex, rect });
    }
  }
  return result;
}

/**
 * One key per (route, pierced leaf) pair, ignoring a route's own first/last
 * segments at its endpoint entities. Keys are `routeIndex * entityCount + entityIndex`.
 */
export function leafCutKeys(
  routes: readonly Route[],
  index: RouteIndexer,
  leaves: readonly LeafRect[],
  entityCount: number,
): Set<number> {
  const cuts = new Set<number>();
  for (const leaf of leaves) {
    for (const segment of index.unsortedSegmentsInRect(leaf.rect)) {
      const route = routes[segment.routeIndex];
      const own =
        route.from.entityIndex === leaf.entityIndex || route.to.entityIndex === leaf.entityIndex;
      const lastSegmentIndex = index.segmentsForRoute(segment.routeIndex).length - 1;
      if (own && (segment.segmentIndex === 0 || segment.segmentIndex === lastSegmentIndex)) {
        continue;
      }
      if (segmentPiercesRect(segment.from, segment.to, leaf.rect)) {
        cuts.add(segment.routeIndex * entityCount + leaf.entityIndex);
      }
    }
  }
  return cuts;
}

/** Every realized authored port still sits within tolerance of its authored track. */
export function authoredEndpointsIntact(routes: readonly Route[]): boolean {
  for (const route of routes) {
    if (route.visits.length === 0) {
      continue;
    }
    const ports = route.ports();
    for (const [endpoint, point] of [
      [route.from, ports.from],
      [route.to, ports.to],
    ] as const) {
      if (endpoint.authoredTrack === undefined) {
        continue;
      }
      const actual = endpoint.face === 'left' || endpoint.face === 'right' ? point.y : point.x;
      if (Math.abs(actual - endpoint.authoredTrack) > AUTHORED_PORT_TOLERANCE_PX) {
        return false;
      }
    }
  }
  return true;
}
