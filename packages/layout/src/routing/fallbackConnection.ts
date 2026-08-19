import { isHorizontal, legacyDirectionToDirection, OPPOSITE_DIRECTION } from '../directionUtils.js';
import { LayoutManager } from '../LayoutManager.js';
import { clipFacePointToOutline } from '../outline.js';
import { getAbsolutePortPoint, getPortAsPoint, getRelativePort } from '../portUtils.js';
import type { Direction, LayoutConnection, LayoutEntity, NewConnection } from '../types.js';
import { detectEnterFace, detectExitFace } from './faces.js';
import type { Point, RelativePortPosition } from './types.js';

const FALLBACK_DETOUR_SIZE = 20;

export interface RoughFallbackConnectionOptions {
  readonly fromFace?: Direction;
  readonly toFace?: Direction;
  readonly startPoint?: Point;
  readonly endPoint?: Point;
}

export type RoughFallbackConnectionChange = Pick<
  LayoutConnection,
  'x' | 'y' | 'points' | 'relativeFromPort' | 'relativeToPort'
>;

/**
 * Builds deliberately rough but mathematically usable fallback geometry. The route honors
 * both terminal faces when possible, never depends on a corridor world, and always contains
 * at least two finite points. Product-validity classification belongs to the caller.
 */
export function makeRoughFallbackConnectionChange(
  layoutManager: LayoutManager,
  connection: NewConnection,
  options: RoughFallbackConnectionOptions = {},
): RoughFallbackConnectionChange {
  const entitiesById = layoutManager.getEntitiesMapping();
  const fromEntity = connection.from ? entitiesById[connection.from] : undefined;
  const toEntity = connection.to ? entitiesById[connection.to] : undefined;
  const stored = storedAbsolutePoints(connection);
  const fromFace = resolveFromFace(layoutManager, connection, fromEntity, toEntity, options);
  const toFace = resolveToFace(layoutManager, connection, fromEntity, toEntity, options);
  const faceStart = entityFacePoint(fromEntity, fromFace);
  const faceEnd = entityFacePoint(toEntity, toFace);
  const start =
    finitePointOrUndefined(options.startPoint) ??
    relativeEndpointPoint(fromEntity, connection.relativeFromPort) ??
    faceStart ??
    stored[0] ??
    ([0, 0] as Point);
  const end =
    finitePointOrUndefined(options.endPoint) ??
    relativeEndpointPoint(toEntity, connection.relativeToPort) ??
    faceEnd ??
    stored.at(-1) ??
    ([start[0] + 10, start[1]] as Point);
  const absolutePoints = makeRoughFallbackPoints(start, end, fromFace, toFace);
  // Only self-derived face points walk to the drawn boundary; authored geometry stays verbatim.
  if (fromEntity && start === faceStart) {
    const clipped = clipFacePointToOutline(fromEntity, fromFace, { x: start[0], y: start[1] });
    absolutePoints[0] = [clipped.x, clipped.y];
  }
  if (toEntity && end === faceEnd) {
    const clipped = clipFacePointToOutline(toEntity, toFace, { x: end[0], y: end[1] });
    absolutePoints[absolutePoints.length - 1] = [clipped.x, clipped.y];
  }
  return {
    ...absolutePointsChange(absolutePoints),
    relativeFromPort: fromEntity
      ? (connection.relativeFromPort ?? getRelativePort(fromEntity, start, fromFace))
      : undefined,
    relativeToPort: toEntity
      ? (connection.relativeToPort ?? getRelativePort(toEntity, end, toFace))
      : undefined,
  };
}

/** Absolute fallback polyline used by the manager-independent emergency path as well. */
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
  } else if (deltaX !== 0 || deltaY !== 0) {
    absolutePoints = [start, end];
  } else {
    const fromOffset = directionOffset(fromFace);
    const toOffset = directionOffset(toFace);
    const first: Point = [start[0] + fromOffset[0], start[1] + fromOffset[1]];
    const last: Point = [end[0] + toOffset[0], end[1] + toOffset[1]];

    if (first[0] === last[0] || first[1] === last[1]) {
      const detour: Point =
        first[1] === last[1]
          ? [first[0], first[1] + FALLBACK_DETOUR_SIZE]
          : [first[0] + FALLBACK_DETOUR_SIZE, first[1]];
      const beforeLast: Point = first[1] === last[1] ? [last[0], detour[1]] : [detour[0], last[1]];
      absolutePoints = [start, first, detour, beforeLast, last, end];
    } else {
      absolutePoints = [start, first, [first[0], last[1]], last, end];
    }
  }

  return absolutePoints.filter(
    (point, index) =>
      index === 0 ||
      point[0] !== absolutePoints[index - 1][0] ||
      point[1] !== absolutePoints[index - 1][1],
  );
}

function resolveFromFace(
  layoutManager: LayoutManager,
  connection: NewConnection,
  fromEntity: LayoutEntity | undefined,
  toEntity: LayoutEntity | undefined,
  options: RoughFallbackConnectionOptions,
): Direction {
  return (
    options.fromFace ??
    legacyDirectionToDirection(connection.authoredFromFace) ??
    faceFromRelativePort(connection.relativeFromPort) ??
    (fromEntity && toEntity
      ? detectExitFace(fromEntity, toEntity, isHorizontal(layoutManager))
      : layoutManager.primaryDirection)
  );
}

function resolveToFace(
  layoutManager: LayoutManager,
  connection: NewConnection,
  fromEntity: LayoutEntity | undefined,
  toEntity: LayoutEntity | undefined,
  options: RoughFallbackConnectionOptions,
): Direction {
  return (
    options.toFace ??
    legacyDirectionToDirection(connection.authoredToFace) ??
    faceFromRelativePort(connection.relativeToPort) ??
    (fromEntity && toEntity
      ? detectEnterFace(toEntity, fromEntity, isHorizontal(layoutManager))
      : OPPOSITE_DIRECTION[layoutManager.primaryDirection])
  );
}

function directionOffset(direction: Direction): Point {
  switch (direction) {
    case 'up':
      return [0, -FALLBACK_DETOUR_SIZE];
    case 'down':
      return [0, FALLBACK_DETOUR_SIZE];
    case 'left':
      return [-FALLBACK_DETOUR_SIZE, 0];
    case 'right':
      return [FALLBACK_DETOUR_SIZE, 0];
  }
}

function faceFromRelativePort(port: RelativePortPosition | undefined): Direction | undefined {
  if (!port) {
    return undefined;
  }
  const [x, y] = port;
  const distances: readonly [Direction, number][] = [
    ['up', y],
    ['down', 1 - y],
    ['left', x],
    ['right', 1 - x],
  ];
  return distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0];
}

function entityFacePoint(entity: LayoutEntity | undefined, face: Direction): Point | undefined {
  return entity ? getPortAsPoint(entity, face, false) : undefined;
}

function relativeEndpointPoint(
  entity: LayoutEntity | undefined,
  port: RelativePortPosition | undefined,
): Point | undefined {
  if (!entity || !port) {
    return undefined;
  }
  return finitePointOrUndefined(getAbsolutePortPoint(entity, port));
}

function storedAbsolutePoints(connection: NewConnection): Point[] {
  if (!connection.points || !Number.isFinite(connection.x) || !Number.isFinite(connection.y)) {
    return [];
  }
  return connection.points
    .map(([x, y]): Point => [connection.x! + x, connection.y! + y])
    .filter((point) => finitePointOrUndefined(point) !== undefined);
}

function absolutePointsChange(
  absolutePoints: readonly Point[],
): Pick<LayoutConnection, 'x' | 'y' | 'points'> {
  const start = absolutePoints[0] ?? ([0, 0] as Point);
  return {
    x: start[0],
    y: start[1],
    points: absolutePoints.map(([x, y]): Point => [x - start[0], y - start[1]]),
  };
}

function finitePointOrUndefined(point: Point | undefined): Point | undefined {
  return point && Number.isFinite(point[0]) && Number.isFinite(point[1]) ? point : undefined;
}
