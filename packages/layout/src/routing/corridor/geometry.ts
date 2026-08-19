import type {
  Axis,
  AxisSpan,
  Direction,
  LayoutEntity,
  PositionProps,
  XYPoint,
} from '../../types.js';
import { clamp, makePropsFromRange, midpoint } from '../../rangeUtils.js';
import { makeExternalTextRange } from '../textPlacements.js';
import type { Corridor, RouteEndpoint } from './contract.js';
import type { Route, VisitBoundary } from './route.js';
import type { CorridorWorld } from './world.js';

/** Shared geometric tolerance for routing-corridor span/rect comparisons. */
export const ROUTING_EPSILON = 1e-6;

/**
 * Routing views the world on a whole-pixel grid. Snapping happens once, where entity
 * geometry enters world construction: edges quantize independently (x and x+w; y and
 * y+h round to the grid) and sizes derive from the snapped edges, so touching entities
 * stay touching and every downstream span/cut comparison is exact integer arithmetic.
 * Container title rects snap by their absolute edges for the same reason — they become
 * corridor wall spans. Returns the caller's array untouched when already on-grid.
 */
export function snapEntitiesToGrid<T extends LayoutEntity>(entities: readonly T[]): readonly T[] {
  let snapped: T[] | undefined;

  for (const [entityIndex, entity] of entities.entries()) {
    if (isEntityOnGrid(entity)) {
      continue;
    }
    snapped ??= [...entities];
    snapped[entityIndex] = snapEntityToGrid(entity);
  }

  return snapped ?? entities;
}

function isEntityOnGrid(entity: LayoutEntity): boolean {
  const title = entity.textPlacement;
  return (
    Number.isInteger(entity.x) &&
    Number.isInteger(entity.y) &&
    Number.isInteger(entity.width) &&
    Number.isInteger(entity.height) &&
    (title === undefined ||
      (Number.isInteger(title.relativeX) &&
        Number.isInteger(title.relativeY) &&
        Number.isInteger(title.width) &&
        Number.isInteger(title.height)))
  );
}

function snapEntityToGrid<T extends LayoutEntity>(entity: T): T {
  const x = Math.round(entity.x);
  const y = Math.round(entity.y);
  const snapped: T = {
    ...entity,
    x,
    y,
    width: Math.round(entity.x + entity.width) - x,
    height: Math.round(entity.y + entity.height) - y,
  };
  const title = entity.textPlacement;
  if (title !== undefined) {
    const titleX = Math.round(entity.x + title.relativeX);
    const titleY = Math.round(entity.y + title.relativeY);
    snapped.textPlacement = {
      relativeX: titleX - x,
      relativeY: titleY - y,
      width: Math.round(entity.x + title.relativeX + title.width) - titleX,
      height: Math.round(entity.y + title.relativeY + title.height) - titleY,
    };
  }
  return snapped;
}

export function facePlane(entity: PositionProps, face: Direction): number {
  if (face === 'left') {
    return entity.x;
  }
  if (face === 'right') {
    return entity.x + entity.width;
  }
  return face === 'up' ? entity.y : entity.y + entity.height;
}

export function faceCrossSpan(entity: PositionProps, face: Direction): AxisSpan {
  return face === 'left' || face === 'right'
    ? [entity.y, entity.y + entity.height]
    : [entity.x, entity.x + entity.width];
}

/**
 * External text overlapping a face's cross-span moves that terminal plane to the text's far edge.
 * The terminal cross-span remains the body face, so side ports still center on the icon.
 */
export function terminalFacePlane(entity: LayoutEntity, face: Direction): number {
  const bodyPlane = facePlane(entity, face);
  const textRange = makeExternalTextRange(entity);
  if (!textRange) {
    return bodyPlane;
  }
  const text = makePropsFromRange(textRange);
  const bodyCross = faceCrossSpan(entity, face);
  const textCross = faceCrossSpan(text, face);
  if (Math.min(bodyCross[1], textCross[1]) <= Math.max(bodyCross[0], textCross[0])) {
    return bodyPlane;
  }
  if (face === 'right') {
    return Math.max(bodyPlane, text.x + text.width);
  }
  if (face === 'left') {
    return Math.min(bodyPlane, text.x);
  }
  if (face === 'down') {
    return Math.max(bodyPlane, text.y + text.height);
  }
  return Math.min(bodyPlane, text.y);
}

export function faceNormalAxis(face: Direction): Axis {
  return face === 'left' || face === 'right' ? 'x' : 'y';
}

/** Canonical face index: up=0, right=1, down=2, left=3. */
export function faceOrder(face: Direction): number {
  return face === 'up' ? 0 : face === 'right' ? 1 : face === 'down' ? 2 : 3;
}

/** +1 toward increasing coordinates (right/down), -1 toward decreasing (left/up). */
export function outwardSign(face: Direction): -1 | 1 {
  return face === 'left' || face === 'up' ? -1 : 1;
}

/** Travel span of a rect for a corridor axis (x-travel ⇒ width, y-travel ⇒ height). */
export function travelSpanOf(axis: Axis, rect: PositionProps): AxisSpan {
  return axis === 'x' ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height];
}

/** Cross span of a rect for a corridor axis (orthogonal to travel). */
export function crossSpanOf(axis: Axis, rect: PositionProps): AxisSpan {
  return axis === 'x' ? [rect.y, rect.y + rect.height] : [rect.x, rect.x + rect.width];
}

export function corridorCrossSpan(corridor: Corridor): AxisSpan {
  return crossSpanOf(corridor.axis, corridor.rect);
}

export function corridorTravelSpan(corridor: Corridor): AxisSpan {
  return travelSpanOf(corridor.axis, corridor.rect);
}

export function corridorCenter(corridor: Corridor): number {
  const cross = corridorCrossSpan(corridor);
  return midpoint(cross);
}

export function axisPoint(axis: Axis, travel: number, track: number): XYPoint {
  return axis === 'x' ? { x: travel, y: track } : { x: track, y: travel };
}

export function segmentAxis(from: XYPoint, to: XYPoint): Axis | undefined {
  const dx = Math.abs(from.x - to.x);
  const dy = Math.abs(from.y - to.y);
  if (dx <= ROUTING_EPSILON === dy <= ROUTING_EPSILON) {
    return undefined;
  }
  return dx > ROUTING_EPSILON ? 'x' : 'y';
}

export function samePoint(left: XYPoint, right: XYPoint, epsilon = 0): boolean {
  return Math.abs(left.x - right.x) <= epsilon && Math.abs(left.y - right.y) <= epsilon;
}

export function manhattan(from: XYPoint, to: XYPoint): number {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
}

export function manhattanCoords(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.abs(toX - fromX) + Math.abs(toY - fromY);
}

export function expandRect(rect: PositionProps, amount: number): PositionProps {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

export function centeredRect(
  center: XYPoint,
  size: { readonly width: number; readonly height: number },
): PositionProps {
  return {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

export function pointInRect(point: XYPoint, rect: PositionProps): boolean {
  return (
    point.x >= rect.x - ROUTING_EPSILON &&
    point.x <= rect.x + rect.width + ROUTING_EPSILON &&
    point.y >= rect.y - ROUTING_EPSILON &&
    point.y <= rect.y + rect.height + ROUTING_EPSILON
  );
}

export function containsRect(outer: PositionProps, inner: PositionProps): boolean {
  return (
    pointInRect(inner, outer) &&
    pointInRect({ x: inner.x + inner.width, y: inner.y + inner.height }, outer)
  );
}

/** An axis-aligned segment overlaps the rect's strict interior. */
export function segmentPiercesRect(from: XYPoint, to: XYPoint, rect: PositionProps): boolean {
  if (Math.abs(from.x - to.x) <= ROUTING_EPSILON) {
    return (
      inside(from.x, rect.x, rect.width) &&
      overlapLength(Math.min(from.y, to.y), Math.abs(to.y - from.y), rect.y, rect.height) >
        ROUTING_EPSILON
    );
  }
  return (
    inside(from.y, rect.y, rect.height) &&
    overlapLength(Math.min(from.x, to.x), Math.abs(to.x - from.x), rect.x, rect.width) >
      ROUTING_EPSILON
  );
}

/** The rect straddles one of the container's boundary lines (rather than sitting inside/outside). */
export function rectCrossesBoundary(rect: PositionProps, container: PositionProps): boolean {
  const vertical =
    overlapLength(rect.y, rect.height, container.y, container.height) > ROUTING_EPSILON;
  const horizontal =
    overlapLength(rect.x, rect.width, container.x, container.width) > ROUTING_EPSILON;
  return (
    (vertical &&
      [container.x, container.x + container.width].some((x) => inside(x, rect.x, rect.width))) ||
    (horizontal &&
      [container.y, container.y + container.height].some((y) => inside(y, rect.y, rect.height)))
  );
}

export function rectsOverlap(left: PositionProps, right: PositionProps): boolean {
  return (
    overlapLength(left.x, left.width, right.x, right.width) > ROUTING_EPSILON &&
    overlapLength(left.y, left.height, right.y, right.height) > ROUTING_EPSILON
  );
}

/** Signed 1D overlap of [a, a+aLength] and [b, b+bLength]; negative when disjoint. */
export function overlapLength(a: number, aLength: number, b: number, bLength: number): number {
  return Math.min(a + aLength, b + bLength) - Math.max(a, b);
}

/** Value lies strictly inside [start, start+length], beyond epsilon of both edges. */
export function inside(value: number, start: number, length: number): boolean {
  return value > start + ROUTING_EPSILON && value < start + length - ROUTING_EPSILON;
}

export function orderedSpan(first: number, second: number): AxisSpan {
  return first <= second ? [first, second] : [second, first];
}

/** Positive-area rectangle intersection, or undefined when the overlap has no area. */
export function overlapRect(
  left: PositionProps,
  right: PositionProps,
  epsilon: number,
): PositionProps | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  return maxX - x > epsilon && maxY - y > epsilon
    ? { x, y, width: maxX - x, height: maxY - y }
    : undefined;
}

export function compareNumber(left: number, right: number, epsilon = 0): number {
  return Math.abs(left - right) <= epsilon ? 0 : left - right;
}

export function boundaryTravelCoordinate(
  world: CorridorWorld,
  corridor: Corridor,
  boundary: VisitBoundary,
): number {
  if (boundary.kind === 'terminal') {
    const attachment = world.indexer.attachments[boundary.attachmentIndex];
    return terminalFacePlane(world.entities[attachment.entityIndex], attachment.face);
  }
  const portal = world.indexer.portals[boundary.portalIndex];
  if (portal.kind === 'continue') {
    return portal.planeCoordinate;
  }
  return corridor.axis === 'x'
    ? portal.rect.x + portal.rect.width / 2
    : portal.rect.y + portal.rect.height / 2;
}

/** Travel occupied by a visit when its turn mouths use the supplied provisional tracks. */
export function possibleTravelInterval(
  world: CorridorWorld,
  corridor: Corridor,
  route: Route,
  visitIndex: number,
  desiredTracks: Float64Array,
): AxisSpan {
  const visit = route.visits[visitIndex];
  const entrySpan = boundaryTravelInterval(
    world,
    corridor,
    visit.entry,
    route,
    visitIndex,
    desiredTracks,
    'entry',
  );
  const exitSpan = boundaryTravelInterval(
    world,
    corridor,
    visit.exit,
    route,
    visitIndex,
    desiredTracks,
    'exit',
  );
  return [Math.min(entrySpan[0], exitSpan[0]), Math.max(entrySpan[1], exitSpan[1])];
}

function boundaryTravelInterval(
  world: CorridorWorld,
  corridor: Corridor,
  boundary: VisitBoundary,
  route: Route,
  visitIndex: number,
  desiredTracks: Float64Array,
  side: 'entry' | 'exit',
): AxisSpan {
  if (boundary.kind === 'portal') {
    const portal = world.indexer.portals[boundary.portalIndex];
    if (portal.kind === 'continue') {
      const plane = boundaryTravelCoordinate(world, corridor, boundary);
      return [plane, plane];
    }
    const portalTravel: AxisSpan =
      corridor.axis === 'x'
        ? [portal.rect.x, portal.rect.x + portal.rect.width]
        : [portal.rect.y, portal.rect.y + portal.rect.height];
    const adjacentVisitIndex = side === 'entry' ? visitIndex - 1 : visitIndex + 1;
    if (adjacentVisitIndex < 0 || adjacentVisitIndex >= route.visits.length) {
      throw new Error(`route ${route.requestIndex}: turn has no adjacent visit`);
    }
    const travel = clamp(desiredTracks[adjacentVisitIndex], portalTravel[0], portalTravel[1]);
    return [travel, travel];
  }
  const travel = boundaryTravelCoordinate(world, corridor, boundary);
  return [travel, travel];
}

export function endpointPoint(
  entities: readonly PositionProps[],
  endpoint: RouteEndpoint,
  track = endpointTrackCoordinate(entities[endpoint.entityIndex], endpoint),
): XYPoint {
  const entity = entities[endpoint.entityIndex];
  const plane = facePlane(entity, endpoint.face);
  return endpoint.face === 'left' || endpoint.face === 'right'
    ? { x: plane, y: track }
    : { x: track, y: plane };
}

export function endpointCrossCoordinate(
  entities: readonly LayoutEntity[],
  endpoint: RouteEndpoint,
  referenceFace: Direction,
): number {
  const entity = entities[endpoint.entityIndex];
  const endpointPlane = terminalFacePlane(entity, endpoint.face);
  const endpointTrack = endpointTrackCoordinate(entity, endpoint);
  if (referenceFace === 'left' || referenceFace === 'right') {
    return endpoint.face === 'left' || endpoint.face === 'right' ? endpointTrack : endpointPlane;
  }
  return endpoint.face === 'left' || endpoint.face === 'right' ? endpointPlane : endpointTrack;
}

function endpointTrackCoordinate(entity: PositionProps, endpoint: RouteEndpoint): number {
  if (endpoint.authoredTrack !== undefined) {
    return endpoint.authoredTrack;
  }
  return endpoint.face === 'left' || endpoint.face === 'right'
    ? entity.y + entity.height / 2
    : entity.x + entity.width / 2;
}
