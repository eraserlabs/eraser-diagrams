import { isHorizontal, OPPOSITE_DIRECTION } from '../directionUtils.js';
import { LayoutManager } from '../LayoutManager.js';
import { getFaceCenterPoint } from '../portUtils.js';
import type { Direction, LayoutEntity, NewConnection } from '../types.js';
import {
  authoredEndpointFace,
  connectionGeometryFromPoints,
  determineDirectionsFromPoints,
  getAbsolutePortPoint,
  getRelativePort,
  isFinitePoint,
  storedEndpoint,
} from './points.js';
import { hasMeasuredLabel, resolveConnectionLabelRelativePlacement } from './textPlacements.js';
import { outwardSign } from './corridor/geometry.js';
import type { Point, RelativePortPosition, RoutedConnectionChange } from './types.js';

const FALLBACK_DETOUR_SIZE = 20;

interface RoughFallbackConnectionOptions {
  readonly fromFace?: Direction;
  readonly toFace?: Direction;
  readonly startPoint?: Point;
  readonly endPoint?: Point;
}

/**
 * Builds deliberately rough but mathematically usable fallback geometry. The route honors
 * both terminal faces, never depends on a corridor world, and always contains
 * at least two finite points. Product-validity classification belongs to the caller.
 */
export function makeRoughFallbackConnectionChange(
  layoutManager: LayoutManager,
  connection: NewConnection,
  options: RoughFallbackConnectionOptions,
): RoutedConnectionChange {
  const entitiesById = layoutManager.getEntitiesMapping();
  const fromEntity = connection.from ? entitiesById[connection.from] : undefined;
  const toEntity = connection.to ? entitiesById[connection.to] : undefined;
  const fromFace =
    options.fromFace ?? authoredEndpointFace(connection, 'from') ?? layoutManager.primaryDirection;
  const toFace =
    options.toFace ??
    authoredEndpointFace(connection, 'to') ??
    OPPOSITE_DIRECTION[layoutManager.primaryDirection];
  const start =
    finitePointOrUndefined(options.startPoint) ??
    relativeEndpointPoint(fromEntity, connection.relativeFromPort) ??
    entityFacePoint(fromEntity, fromFace) ??
    storedEndpoint(connection, 'from') ??
    ([0, 0] as Point);
  const end =
    finitePointOrUndefined(options.endPoint) ??
    relativeEndpointPoint(toEntity, connection.relativeToPort) ??
    entityFacePoint(toEntity, toFace) ??
    storedEndpoint(connection, 'to') ??
    ([start[0] + 10, start[1]] as Point);
  const absolutePoints = makeRoughFallbackPoints(start, end, fromFace, toFace);
  const geometry = connectionGeometryFromPoints(absolutePoints);
  const label = connection.textPlacement;
  const relativeLabel = hasMeasuredLabel(label)
    ? resolveConnectionLabelRelativePlacement(geometry.points, label)
    : undefined;
  return {
    ...geometry,
    relativeFromPort: fromEntity ? getRelativePort(fromEntity, start, fromFace) : undefined,
    relativeToPort: toEntity ? getRelativePort(toEntity, end, toFace) : undefined,
    textPlacement: relativeLabel
      ? { ...relativeLabel, x: geometry.x + relativeLabel.x, y: geometry.y + relativeLabel.y }
      : undefined,
  };
}

/** May cross obstacles, but endpoint directions must survive the editor round trip. */
export function makeRoughFallbackPoints(
  start: Point,
  end: Point,
  fromFace: Direction,
  toFace: Direction,
): Point[] {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  let absolutePoints: Point[];

  if (deltaX !== 0 && deltaY !== 0) {
    const fromHorizontal = isHorizontal(fromFace);
    if (fromHorizontal === isHorizontal(toFace)) {
      const midX = Math.round((start[0] + end[0]) / 2);
      const midY = Math.round((start[1] + end[1]) / 2);
      absolutePoints = fromHorizontal
        ? [start, [midX, start[1]], [midX, end[1]], end]
        : [start, [start[0], midY], [end[0], midY], end];
    } else {
      const bend: Point = fromHorizontal ? [end[0], start[1]] : [start[0], end[1]];
      absolutePoints = [start, bend, end];
    }
  } else {
    absolutePoints = [start, end];
  }

  absolutePoints = absolutePoints.filter(
    (point, index) =>
      index === 0 ||
      point[0] !== absolutePoints[index - 1][0] ||
      point[1] !== absolutePoints[index - 1][1],
  );
  if (absolutePoints.length > 1) {
    const { startDirection, endDirection } = determineDirectionsFromPoints(absolutePoints);
    if (startDirection === fromFace && endDirection === toFace) {
      return absolutePoints;
    }
  }

  // Give each terminal an outward stub before connecting them. A backwards
  // segment would otherwise be reinterpreted as a port on the opposite face.
  const fromAxis = isHorizontal(fromFace) ? 0 : 1;
  const toAxis = isHorizontal(toFace) ? 0 : 1;
  const fromOffset = directionOffset(fromFace);
  const toOffset = directionOffset(toFace);
  const first: Point = [start[0] + fromOffset[0], start[1] + fromOffset[1]];
  const last: Point = [end[0] + toOffset[0], end[1] + toOffset[1]];
  // Keep intervening bends nonzero, even for coincident endpoints/stub tips.
  if (first[fromAxis] === last[fromAxis]) {
    first[fromAxis] += fromOffset[fromAxis];
  }
  if (first[toAxis] === last[toAxis]) {
    last[toAxis] += toOffset[toAxis];
  }
  if (fromAxis !== toAxis) {
    const bend: Point = fromAxis === 0 ? [first[0], last[1]] : [last[0], first[1]];
    return [start, first, bend, last, end];
  }
  const crossAxis = fromAxis === 0 ? 1 : 0;
  const cross = Math.max(start[crossAxis], end[crossAxis]) + FALLBACK_DETOUR_SIZE;
  const afterFirst: Point = [...first];
  const beforeLast: Point = [...last];
  afterFirst[crossAxis] = beforeLast[crossAxis] = cross;
  return [start, first, afterFirst, beforeLast, last, end];
}

function directionOffset(direction: Direction): Point {
  const offset = outwardSign(direction) * FALLBACK_DETOUR_SIZE;
  return isHorizontal(direction) ? [offset, 0] : [0, offset];
}

function entityFacePoint(entity: LayoutEntity | undefined, face: Direction): Point | undefined {
  return entity ? getFaceCenterPoint(entity, face) : undefined;
}

function relativeEndpointPoint(
  entity: LayoutEntity | undefined,
  port: RelativePortPosition | undefined,
): Point | undefined {
  if (!entity || !port) {
    return undefined;
  }
  return getAbsolutePortPoint(entity, port);
}

function finitePointOrUndefined(point: Point | undefined): Point | undefined {
  return isFinitePoint(point) ? point : undefined;
}
