import type { Direction } from '../types.js';
import { clamp } from '../rangeUtils.js';
import { getEntityDimensions } from '../sizeUtils.js';
import { RoutingError } from '../LayoutError.js';
import { OPPOSITE_DIRECTION } from '../directionUtils.js';
import { LayoutConnection, LayoutEntity, NewConnection } from '../types.js';
import { EndpointSide, Point, RelativePortPosition } from './types.js';
import { isExternalTextPlacement } from './textPlacements.js';

export function isFinitePoint(point: Point | undefined): point is Point {
  return point !== undefined && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

/** Rebase an absolute polyline on its first vertex. */
export function connectionGeometryFromPoints(
  points: readonly Point[],
): Pick<LayoutConnection, 'x' | 'y' | 'points'> {
  const [x, y] = points[0] ?? [0, 0];
  return { x, y, points: points.map(([px, py]): Point => [px - x, py - y]) };
}

/** Absolute polyline of stored geometry; the inverse of {@link connectionGeometryFromPoints}. */
export function absoluteConnectionPoints({
  x,
  y,
  points,
}: {
  readonly x: number;
  readonly y: number;
  readonly points: readonly Readonly<Point>[];
}): Point[] {
  return points.map(([px, py]): Point => [x + px, y + py]);
}

/** A side's absolute endpoint from stored geometry; undefined when that geometry is missing or non-finite. */
export function storedEndpoint(connection: NewConnection, side: EndpointSide): Point | undefined {
  const { x, y, points } = connection;
  if (x === undefined || y === undefined || !points) {
    return undefined;
  }
  const absolute = absoluteConnectionPoints({ x, y, points });
  const point = side === 'from' ? absolute[0] : absolute.at(-1);
  return isFinitePoint(point) ? point : undefined;
}

/** Whole-pixel routing grid: stored geometry and stored ports enter the solver rounded; explicit pins stay exact. */
export function roundPoint([x, y]: Point): Point {
  return [Math.round(x), Math.round(y)];
}

/** The face an endpoint is attached to by its authored face, else by its stored relative port. */
export function authoredEndpointFace(
  connection: NewConnection,
  side: EndpointSide,
): Direction | undefined {
  const authoredFace = side === 'from' ? connection.authoredFromFace : connection.authoredToFace;
  if (authoredFace) {
    return authoredFace;
  }
  const port = side === 'from' ? connection.relativeFromPort : connection.relativeToPort;
  if (!port) {
    return undefined;
  }
  const [x, y] = port;
  // Bottom label ports may extend beyond the body's [0, 1] horizontal span.
  const distances: readonly [Direction, number][] = [
    ['up', Math.abs(y)],
    ['down', Math.abs(1 - y)],
    ['left', Math.abs(x)],
    ['right', Math.abs(1 - x)],
  ];
  return distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0];
}

export function getProjectedFaceRange(
  entity: LayoutEntity,
  face: Direction | undefined,
): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const innerRange = getEntityDimensions(entity, { excludeTextDimensions: true });

  if (!face || !isExternalTextPlacement(entity) || !entity.textPlacement) {
    return innerRange;
  }

  const outerRange = getEntityDimensions(entity);
  const { textPlacement } = entity;
  const projectedRange = { ...innerRange };

  if (face === 'left' && textPlacement.relativeX + textPlacement.width <= 0) {
    projectedRange.minX = outerRange.minX;
  } else if (face === 'right' && textPlacement.relativeX >= entity.width) {
    projectedRange.maxX = outerRange.maxX;
  } else if (face === 'up' && textPlacement.relativeY + textPlacement.height <= 0) {
    projectedRange.minY = outerRange.minY;
  } else if (face === 'down' && textPlacement.relativeY >= entity.height) {
    projectedRange.minX = outerRange.minX;
    projectedRange.maxX = outerRange.maxX;
    projectedRange.maxY = outerRange.maxY;
  }

  return projectedRange;
}

function determineDirectionFromTwoPoints(points: Point[]): Direction {
  const deltaX = points[1][0] - points[0][0];
  const deltaY = points[1][1] - points[0][1];

  const direction = deltaY === 0 ? (deltaX > 0 ? 'right' : 'left') : deltaY > 0 ? 'down' : 'up';

  return direction;
}

export function determineDirectionsFromPoints(points: Point[]): {
  startDirection: Direction;
  endDirection: Direction;
} {
  if (points.length <= 1) {
    throw new RoutingError('Not enough points to determine direction');
  }

  const startDirection = determineDirectionFromTwoPoints(points);
  const endDirection = OPPOSITE_DIRECTION[determineDirectionFromTwoPoints(points.slice(-2))];

  return { startDirection, endDirection };
}

/**
 * Returns the relative port position of a point on an entity.
 * The goal is to make sure that our return value is actually on the entity boundaries.
 * In order to do that, we:
 * - Find which x or y is closer to a boundary OR if given a direction, choose the appropriate face
 * - Set that to either 0 or 1 exactly
 * - Clamp the other coordinate to the face span. A bottom label wider than its
 *   body permits x fractions outside [0, 1], still measured relative to the body.
 * @note This works ok for rectangles, excalidraw-land is responsible for connecting lines to actual boundaries.
 * @note Round trip with {@link getAbsolutePortPoint}: for integer entity bounds and a target face,
 *   `getRelativePort(e, getAbsolutePortPoint(e, p), face)` is a fixed point after one application,
 *   so re-deriving a port from an endpoint pinned at its stored port never creeps along the face.
 * @param entity
 * @param point
 * @param targetDirection - If provided, we will try to make sure the port is on the appropriate face
 * @returns [0, 0] is the top left corner, [1, 1] is the bottom right corner
 */
export function getRelativePort(
  entity: LayoutEntity,
  point: Point,
  targetDirection?: Direction,
): RelativePortPosition {
  if (targetDirection === 'down' && entity.width > 0) {
    const range = getProjectedFaceRange(entity, targetDirection);
    // Fractions remain relative to the body, but may extend beyond [0, 1]
    // when the bottom attachment is on a label wider than that body.
    return [(clamp(point[0], range.minX, range.maxX) - entity.x) / entity.width, 1];
  }
  const relativeX = clamp((point[0] - entity.x) / entity.width, 0, 1);
  const relativeY = clamp((point[1] - entity.y) / entity.height, 0, 1);

  const xBorder = relativeX < 0.5 ? 0 : 1;
  const yBorder = relativeY < 0.5 ? 0 : 1;
  const xDistanceToBorder = Math.abs(relativeX - xBorder);
  const yDistanceToBorder = Math.abs(relativeY - yBorder);

  // If targetDirection is provided, we can use the appropriate face
  switch (targetDirection) {
    case 'up':
      return [relativeX, 0];
    case 'down':
      return [relativeX, 1];
    case 'left':
      return [0, relativeY];
    case 'right':
      return [1, relativeY];
  }

  if (xDistanceToBorder <= yDistanceToBorder) {
    const finalizedY = Number(relativeY.toFixed(2));
    return [xBorder, finalizedY];
  }

  const finalizedX = Number(relativeX.toFixed(2));
  return [finalizedX, yBorder];
}

/**
 * Whole-pixel absolute point of a relative port: the one rule for snapping stored ports onto the
 * routing grid. See the round-trip note on {@link getRelativePort}.
 */
export function getAbsolutePortPoint(
  entity: LayoutEntity,
  relativePortPoint: RelativePortPosition,
): Point {
  return roundPoint([
    entity.x + entity.width * relativePortPoint[0],
    entity.y + entity.height * relativePortPoint[1],
  ]);
}

export function determineDirectionFromConnectionEnd(
  connection: LayoutConnection | NewConnection,
  side: EndpointSide,
): Direction | undefined {
  if (!connection.points || connection.points.length < 2) {
    return;
  }

  if (side === 'from') {
    return determineDirectionFromTwoPoints(connection.points);
  } else {
    return OPPOSITE_DIRECTION[determineDirectionFromTwoPoints(connection.points.slice(-2))];
  }
}

/**
 * Returns the point in absolute coordinates for the start or end of a connection
 * Can also project the point onto the entity boundaries, which will also account for text placements
 */
export function getAbsolutePortFromEntityAndConnection(
  entity?: LayoutEntity,
  relativePort?: RelativePortPosition,
  projectOntoEntity?: boolean,
  targetDirection?: Direction,
): Point | undefined {
  if (!entity || !relativePort) {
    return;
  }

  const point = getAbsolutePortPoint(entity, relativePort);

  if (!projectOntoEntity) {
    return point;
  }

  // If we have a target direction, we only allow horizontal or vertical
  const allowHorizontal = !targetDirection || ['left', 'right'].includes(targetDirection);
  const allowVertical = !targetDirection || ['up', 'down'].includes(targetDirection);

  const isExternal = isExternalTextPlacement(entity);
  const outerRange = getEntityDimensions(entity);
  let finalRange = outerRange;

  if (isExternal) {
    const innerRange = getEntityDimensions(entity, { excludeTextDimensions: true });
    const textPlacement = entity.textPlacement!;
    finalRange = { ...innerRange };

    if (textPlacement.relativeX + textPlacement.width <= 0) {
      // If it is on the left, expand minX
      finalRange.minX = outerRange.minX;
    } else if (textPlacement.relativeX >= entity.width) {
      // If it is on the right, expand maxX
      finalRange.maxX = outerRange.maxX;
    } else if (textPlacement.relativeY + textPlacement.height <= 0) {
      // If it is on the top, expand minY
      finalRange.minY = outerRange.minY;
    } else if (textPlacement.relativeY >= entity.height) {
      // If it is on the bottom, expand maxY
      finalRange.maxY = outerRange.maxY;
      if (targetDirection === 'down') {
        finalRange.minX = outerRange.minX;
        finalRange.maxX = outerRange.maxX;
      }
    }
  }

  const { minX, maxX, minY, maxY } = finalRange;

  const xIsBetween = point[0] >= minX && point[0] <= maxX;
  const yIsBetween = point[1] >= minY && point[1] <= maxY;
  const onX = point[0] === minX || point[0] === maxX;
  const onY = point[1] === minY || point[1] === maxY;

  // If we're already on one of the faces, do nothing
  if ((onX && yIsBetween && allowHorizontal) || (onY && xIsBetween && allowVertical)) {
    return point;
  }

  // If we're not on a face, project based on the direction of the connection
  if (targetDirection) {
    // Project onto the face based on direction
    switch (targetDirection) {
      case 'left':
        point[0] = minX;
        break;
      case 'right':
        point[0] = maxX;
        break;
      case 'up':
        point[1] = minY;
        break;
      case 'down':
        point[1] = maxY;
        break;
    }
  } else {
    // Fallback for when we don't have connection points
    if (!onX) {
      point[0] = Math.abs(minX - point[0]) < Math.abs(maxX - point[0]) ? minX : maxX;
    }
    if (!onY) {
      point[1] = Math.abs(minY - point[1]) < Math.abs(maxY - point[1]) ? minY : maxY;
    }
  }

  // Final check: ensure point is clamped to entity boundaries
  if (!yIsBetween) {
    point[1] = clamp(point[1], minY, maxY);
  }
  if (!xIsBetween) {
    point[0] = clamp(point[0], minX, maxX);
  }

  return point;
}

/** Check imported geometry before adopting it or preserving it through a shift. */
export function hasValidConnectionGeometry(
  connection: NewConnection,
): connection is LayoutConnection {
  const { x, y, points } = connection;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !points || points.length < 2) {
    return false;
  }

  let lastWasHorizontal: boolean | undefined = undefined;
  let lastPoint: Point | undefined;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!isFinitePoint(point)) {
      return false;
    }

    if (i === 0) {
      // First point must be 0,0
      if (point[0] !== 0 || point[1] !== 0) {
        return false;
      }

      lastPoint = point;
      continue;
    }

    const isHorizontalShift = point[0] !== lastPoint![0];
    const isVerticalShift = point[1] !== lastPoint![1];

    // This point creates a diagonal segment
    if (isHorizontalShift && isVerticalShift) {
      return false;
    }

    // This is a collinear segment
    if (isHorizontalShift === lastWasHorizontal) {
      return false;
    }

    lastWasHorizontal = isHorizontalShift;
    lastPoint = point;
  }

  return true;
}

/**
 * Returns the points that would take you from the endPoint to the startPoint
 * Such that the first is still [0, 0].
 * E.g. [0, 0], [1, 0], [1, 1] --> [0, 0], [-1, 0], [-1, -1]
 */
export function reversePoints(points: Point[]): Point[] {
  const lastX = points.at(-1)?.[0];
  const lastY = points.at(-1)?.[1];

  return points.map(([x, y]) => [x - lastX!, y - lastY!]).reverse() as Point[];
}
