import type { XYPoint } from '../../types.js';
import type { EndpointSide } from '../types.js';
import type { CorridorWallFace } from './corridorIndex.js';
import { manhattan } from './geometry.js';
import {
  nearFaceTurnCost,
  ROUTING_QUALITY_COSTS,
  wallHugCost,
  type NearFaceTurnQualityEvent,
  type RoutingQualityEvent,
  type RoutingQualityVisitRef,
  type WallHugQualityEvent,
  type WallTouchQualityEvent,
} from './qualityCost.js';
import type { Route } from './route.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;
export const WALL_HUG_CLEARANCE_PX = 24;
export const WALL_HUG_OVERLAP_TOLERANCE_PX = 1;
/** Retained by spacing and by the corridor-profile wall-touch span check. */
const NEAR_FACE_SPAN_SLACK_PX = 2;
const TERMINAL_STUB_IDEAL_PX = 24;

interface AttributedCorridorFace extends CorridorWallFace {
  readonly corridorIndex: number;
}

/**
 * Cheap production wall score. Terminal-stub quality reads two route segments;
 * wall hugs and bend contacts read only the cached borders of visited corridors.
 * This is intentionally an approximation of the geometry-owned grader.
 */
export function collectWallQualityEvents(
  world: CorridorWorld,
  routes: readonly Route[],
): readonly RoutingQualityEvent[] {
  const wallHugs: WallHugQualityEvent[] = [];
  const nearFaceTurns: NearFaceTurnQualityEvent[] = [];
  const wallTouches: WallTouchQualityEvent[] = [];
  const seenHugs = new Set<string>();

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (route.visits.length === 0) {
      continue;
    }
    const points = route.points();
    collectRouteWallHugs(world, route, routeIndex, points, seenHugs, wallHugs);
    collectRouteTerminalStubs(world, route, routeIndex, points, nearFaceTurns);
    collectRouteWallTouches(world, route, routeIndex, points, wallTouches);
  }

  return [...wallTouches, ...nearFaceTurns, ...wallHugs];
}

function collectRouteTerminalStubs(
  world: CorridorWorld,
  route: Route,
  routeIndex: number,
  points: readonly XYPoint[],
  events: NearFaceTurnQualityEvent[],
): void {
  if (points.length < 3) {
    return;
  }
  collectTerminalStub(world, route, routeIndex, points, 'from', events);
  collectTerminalStub(world, route, routeIndex, points, 'to', events);
}

function collectTerminalStub(
  world: CorridorWorld,
  route: Route,
  routeIndex: number,
  points: readonly XYPoint[],
  endpointSide: EndpointSide,
  events: NearFaceTurnQualityEvent[],
): void {
  const stub = terminalStub(points, endpointSide);
  if (!stub) {
    return;
  }
  const { bendPointIndex, distance } = stub;
  const achievable = freeDepthAhead(world, route, points, endpointSide, bendPointIndex);
  const effectiveIdeal = Math.min(TERMINAL_STUB_IDEAL_PX, achievable);
  const penalty = anchorCurve(distance, effectiveIdeal);
  if (penalty <= 0) {
    return;
  }
  const visits = bendVisits(route, routeIndex, bendPointIndex);
  events.push({
    kind: 'near-face-turn',
    cost: nearFaceTurnCost(penalty),
    routeIndexes: [routeIndex],
    corridorIndexes: corridorIndexesForVisits(route, visits),
    visits,
  });
}

/** Cross window swept when probing for the obstacle that bounds a stub's depth. */
const STUB_DEPTH_WINDOW_PX = 12;

/**
 * The stub ideal no topology can beat: distance from the port plane to the
 * first entity edge directly ahead of the port (±12px cross window).
 *
 * The bound is port-owned, not topology-local. A corridor-local bound can hide
 * repairable stub depth whenever the incumbent happens to use a tighter corridor.
 * Probing free space ahead of the port instead means a stub loses its price only
 * when no topology could lengthen it. The port's own containing container is
 * skipped because a route may legally exit through a portal in its wall.
 */
function freeDepthAhead(
  world: CorridorWorld,
  route: Route,
  points: readonly XYPoint[],
  endpointSide: EndpointSide,
  bendPointIndex: number,
): number {
  const endpoint = route[endpointSide];
  const port = endpointSide === 'from' ? points[0] : points[points.length - 1];
  const bend = points[bendPointIndex];
  const stubAxis = segmentAxis(port, bend);
  const planeCoordinate = stubAxis === 'x' ? port.x : port.y;
  const bendCoordinate = stubAxis === 'x' ? bend.x : bend.y;
  const outward = Math.sign(bendCoordinate - planeCoordinate) || 1;
  const crossCoordinate = stubAxis === 'x' ? port.y : port.x;
  let depth = Number.POSITIVE_INFINITY;
  for (let entityIndex = 0; entityIndex < world.entities.length; entityIndex += 1) {
    if (entityIndex === endpoint.entityIndex) {
      continue;
    }
    const entity = world.entities[entityIndex];
    const [travelStart, travelEnd] =
      stubAxis === 'x' ? [entity.x, entity.x + entity.width] : [entity.y, entity.y + entity.height];
    const [crossStart, crossEnd] =
      stubAxis === 'x' ? [entity.y, entity.y + entity.height] : [entity.x, entity.x + entity.width];
    if (
      crossEnd < crossCoordinate - STUB_DEPTH_WINDOW_PX ||
      crossStart > crossCoordinate + STUB_DEPTH_WINDOW_PX
    ) {
      continue;
    }
    if (
      entity.isContainer === true &&
      crossStart <= crossCoordinate &&
      crossCoordinate <= crossEnd &&
      travelStart <= planeCoordinate &&
      planeCoordinate <= travelEnd
    ) {
      continue;
    }
    const ahead = outward > 0 ? travelStart - planeCoordinate : planeCoordinate - travelEnd;
    if (ahead >= -EPSILON && ahead < depth) {
      depth = ahead;
    }
  }
  return Math.max(0, depth);
}

function terminalStub(
  points: readonly XYPoint[],
  endpointSide: EndpointSide,
): { readonly bendPointIndex: number; readonly distance: number } | undefined {
  if (endpointSide === 'from') {
    const axis = segmentAxis(points[0], points[1]);
    let bendPointIndex = 1;
    while (
      bendPointIndex + 1 < points.length &&
      segmentAxis(points[bendPointIndex], points[bendPointIndex + 1]) === axis
    ) {
      bendPointIndex += 1;
    }
    return bendPointIndex + 1 < points.length
      ? { bendPointIndex, distance: manhattan(points[0], points[bendPointIndex]) }
      : undefined;
  }
  const lastPointIndex = points.length - 1;
  const axis = segmentAxis(points[lastPointIndex - 1], points[lastPointIndex]);
  let bendPointIndex = lastPointIndex - 1;
  while (
    bendPointIndex - 1 >= 0 &&
    segmentAxis(points[bendPointIndex - 1], points[bendPointIndex]) === axis
  ) {
    bendPointIndex -= 1;
  }
  return bendPointIndex - 1 >= 0
    ? { bendPointIndex, distance: manhattan(points[bendPointIndex], points[lastPointIndex]) }
    : undefined;
}

function collectRouteWallHugs(
  world: CorridorWorld,
  route: Route,
  routeIndex: number,
  points: readonly XYPoint[],
  seen: Set<string>,
  events: WallHugQualityEvent[],
): void {
  const ownFrom = route.from.entityIndex;
  const ownTo = route.to.entityIndex;
  for (let segmentIndex = 0; segmentIndex + 1 < points.length; segmentIndex += 1) {
    const from = points[segmentIndex];
    const to = points[segmentIndex + 1];
    const axis = segmentAxis(from, to);
    const visitIndex = route.segmentVisitOf(segmentIndex);
    const corridorIndex = route.visits[visitIndex].corridorIndex;
    const lane = axis === 'x' ? from.y : from.x;
    const travelStart = axis === 'x' ? Math.min(from.x, to.x) : Math.min(from.y, to.y);
    const travelEnd = axis === 'x' ? Math.max(from.x, to.x) : Math.max(from.y, to.y);
    const wallNormal = axis === 'x' ? 'y' : 'x';
    for (const face of world.indexer.wallFacesForCorridor(corridorIndex)) {
      if (face.normalAxis !== wallNormal) {
        continue;
      }
      const distance = Math.abs(lane - face.coordinate);
      if (distance >= WALL_HUG_CLEARANCE_PX - EPSILON) {
        continue;
      }
      const entityIndex = face.entityIndex;
      if (entityIndex === ownFrom || entityIndex === ownTo) {
        continue;
      }
      const overlapStart = Math.max(travelStart, face.span[0]);
      const overlapEnd = Math.min(travelEnd, face.span[1]);
      const overlap = overlapEnd - overlapStart;
      if (overlap <= WALL_HUG_OVERLAP_TOLERANCE_PX) {
        continue;
      }
      const key = `${routeIndex}|${entityIndex}|${face.face}|${lane.toFixed(1)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const visit: RoutingQualityVisitRef = {
        routeIndex,
        visitIndex,
      };
      events.push({
        kind: 'wall-hug',
        cost: wallHugCost(distance, overlap, WALL_HUG_CLEARANCE_PX),
        routeIndexes: [routeIndex],
        corridorIndexes: [corridorIndex],
        visits: [visit],
      });
    }
  }
}

function collectRouteWallTouches(
  world: CorridorWorld,
  route: Route,
  routeIndex: number,
  points: readonly XYPoint[],
  events: WallTouchQualityEvent[],
): void {
  for (let pointIndex = 1; pointIndex + 1 < points.length; pointIndex += 1) {
    if (!isCorner(points, pointIndex)) {
      continue;
    }
    const bend = points[pointIndex];
    let selected: AttributedCorridorFace | undefined;
    for (const segmentIndex of [pointIndex - 1, pointIndex]) {
      const visitIndex = route.segmentVisitOf(segmentIndex);
      const corridorIndex = route.visits[visitIndex].corridorIndex;
      for (const face of world.indexer.wallFacesForCorridor(corridorIndex)) {
        const coordinate = face.normalAxis === 'x' ? bend.x : bend.y;
        const travel = face.normalAxis === 'x' ? bend.y : bend.x;
        if (
          Math.abs(coordinate - face.coordinate) > EPSILON ||
          travel < face.span[0] - NEAR_FACE_SPAN_SLACK_PX - EPSILON ||
          travel > face.span[1] + NEAR_FACE_SPAN_SLACK_PX + EPSILON
        ) {
          continue;
        }
        const candidate: AttributedCorridorFace = { ...face, corridorIndex };
        if (!selected || compareCorridorFaces(candidate, selected) < 0) {
          selected = candidate;
        }
      }
    }
    if (!selected) {
      continue;
    }
    const visits = bendVisits(route, routeIndex, pointIndex);
    events.push({
      kind: 'wall-touch',
      cost: ROUTING_QUALITY_COSTS.wallTouch,
      routeIndexes: [routeIndex],
      corridorIndexes: corridorIndexesForVisits(route, visits),
      visits,
      routeIndex,
      bendPointIndex: pointIndex,
      entityIndex: selected.entityIndex,
      face: selected.face,
    });
  }
}

function compareCorridorFaces(left: AttributedCorridorFace, right: AttributedCorridorFace): number {
  return (
    left.entityId.localeCompare(right.entityId) ||
    left.normalAxis.localeCompare(right.normalAxis) ||
    left.coordinate - right.coordinate ||
    left.corridorIndex - right.corridorIndex
  );
}

function bendVisits(
  route: Route,
  routeIndex: number,
  pointIndex: number,
): RoutingQualityVisitRef[] {
  const first = route.segmentVisitOf(pointIndex - 1);
  const second = route.segmentVisitOf(pointIndex);
  const lower = Math.min(first, second);
  const upper = Math.max(first, second);
  const firstRef = { routeIndex, visitIndex: lower };
  return lower === upper ? [firstRef] : [firstRef, { routeIndex, visitIndex: upper }];
}

function corridorIndexesForVisits(
  route: Route,
  visits: readonly RoutingQualityVisitRef[],
): number[] {
  const first = route.visits[visits[0].visitIndex].corridorIndex;
  const second = visits[1] ? route.visits[visits[1].visitIndex].corridorIndex : first;
  return first === second ? [first] : [Math.min(first, second), Math.max(first, second)];
}

function isCorner(points: readonly XYPoint[], pointIndex: number): boolean {
  return (
    segmentAxis(points[pointIndex - 1], points[pointIndex]) !==
    segmentAxis(points[pointIndex], points[pointIndex + 1])
  );
}

function segmentAxis(from: XYPoint, to: XYPoint): 'x' | 'y' {
  if (from.y === to.y) {
    return 'x';
  }
  if (from.x === to.x) {
    return 'y';
  }
  throw new Error('wall quality: emitted segment is not cardinal');
}

function anchorCurve(distance: number, anchor: number): number {
  if (anchor <= EPSILON || distance >= anchor) {
    return 0;
  }
  const shortfall = (anchor - Math.max(0, distance)) / anchor;
  return shortfall * shortfall;
}
