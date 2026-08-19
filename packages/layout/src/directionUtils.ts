import type { LayoutManager } from './LayoutManager.js';
import type { OrientedPosition, Axis, LayoutRange, LayoutEntity, Direction } from './types.js';
import { isAxis } from './typeChecks.js';
import { Point } from './routing/types.js';

type AxisOrDirectionArg = LayoutManager | Direction | Axis;

/**
 * @perf These arrays let us use a single number to represent a direction and use an array or Uint8Array to indicate if a direction is valid
 * */
export const DIRECTION_FOR_INDEX = ['up', 'down', 'left', 'right'] as const;
export const OPPOSITE_DIRECTION_FOR_INDEX = ['down', 'up', 'right', 'left'] as const;
export type DirectionIndex = 0 | 1 | 2 | 3;
export type DirectionActivation = Uint8Array;

export function legacyDirectionToDirection(direction?: string | Direction): Direction | undefined {
  switch (direction) {
    case 'right':
      return 'right';
    case 'left':
      return 'left';
    case 'up':
    case 'top':
      return 'up';
    case 'down':
    case 'bottom':
      return 'down';
    default:
      return undefined;
  }
}

export function getAxisForDirection(arg: AxisOrDirectionArg): Axis {
  if (isAxis(arg)) {
    return arg;
  }

  const direction = typeof arg === 'string' ? arg : arg.primaryDirection;

  return direction === 'right' || direction === 'left' ? 'x' : 'y';
}

export function isSameAxis(arg1: AxisOrDirectionArg, arg2: AxisOrDirectionArg): boolean {
  return getAxisForDirection(arg1) === getAxisForDirection(arg2);
}

export function isVertical(arg?: AxisOrDirectionArg): boolean {
  if (!arg) {
    return false;
  }

  return getAxisForDirection(arg) === 'y';
}

export function isHorizontal(arg?: AxisOrDirectionArg): boolean {
  if (!arg) {
    return false;
  }

  return getAxisForDirection(arg) === 'x';
}

export function getOrthogonalDirection(direction: Direction): Direction {
  switch (direction) {
    case 'up':
    case 'down':
      return 'right';
    case 'left':
    case 'right':
    default:
      return 'down';
  }
}

export const OPPOSITE_DIRECTION: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

export function getAllowedFaces(primaryDirection: Direction): [Direction, Direction] {
  const horizontal = primaryDirection === 'right' || primaryDirection === 'left';
  return horizontal ? ['left', 'right'] : ['up', 'down'];
}

export function getStartForDirection(
  direction: Direction,
  arg: { x: number; y: number; width: number; height: number },
): number {
  switch (direction) {
    case 'down':
      return arg.y;
    case 'up':
      return arg.y + arg.height;
    case 'left':
      return arg.x + arg.width;
    case 'right':
    default:
      return arg.x;
  }
}

export function getEndForDirection(
  direction: Direction,
  arg: { x: number; y: number; width: number; height: number },
): number {
  return getStartForDirection(OPPOSITE_DIRECTION[direction], arg);
}

/**
 * Util for whether an entity is "beyond" a range in a given direction
 * Takes care of knowing that the "end" should be before in left / up
 * and after in right / down
 * @param direction
 * @param arg
 * @param range
 */
export function diffToRangeInDirection(
  direction: Direction,
  arg: { x: number; y: number; width: number; height: number },
  range: LayoutRange,
): number {
  const entEnd = getEndForDirection(direction, arg);
  const rangeEnd = getEndOfRangeForDirection(direction, range);

  return direction === 'right' || direction === 'down' ? entEnd - rangeEnd : rangeEnd - entEnd;
}

/**
 * Determine if the first entity starts beyond the end of the second
 */
export function checkIfStartsBeyond(
  direction: Direction,
  arg1: { x: number; y: number; width: number; height: number },
  arg2: { x: number; y: number; width: number; height: number },
): boolean {
  const start1 = getStartForDirection(direction, arg1);
  const end2 = getEndForDirection(direction, arg2);

  return direction === 'right' || direction === 'down' ? start1 > end2 : start1 < end2;
}

export function getStartOfRangeForDirection(direction: Direction, range: LayoutRange): number {
  switch (direction) {
    case 'down':
      return range.minY;
    case 'up':
      return range.maxY;
    case 'left':
      return range.maxX;
    case 'right':
    default:
      return range.minX;
  }
}

export function getEndOfRangeForDirection(direction: Direction, range: LayoutRange): number {
  return getStartOfRangeForDirection(OPPOSITE_DIRECTION[direction], range);
}

export function getStartAndSizeForDirection(
  direction: Direction,
  arg: { x: number; y: number; width: number; height: number },
): OrientedPosition & { sizeKey: 'width' | 'height'; orthogonalSizeKey: 'width' | 'height' } {
  const primaryAxis = getAxisForDirection(direction);
  const orthogonalAxis = primaryAxis === 'x' ? 'y' : 'x';
  const sizeKey = primaryAxis === 'x' ? 'width' : 'height';
  const orthogonalSizeKey = orthogonalAxis === 'x' ? 'width' : 'height';

  const primaryDirectionSize = arg[sizeKey];
  const primaryDirectionStart = getStartForDirection(direction, arg);
  const orthogonalDirectionStart = arg[orthogonalAxis];
  const orthogonalDirectionSize = arg[orthogonalSizeKey];

  return {
    primaryAxis,
    orthogonalAxis,
    primaryDirectionStart,
    primaryDirectionSize,
    orthogonalDirectionSize,
    orthogonalDirectionStart,
    sizeKey,
    orthogonalSizeKey,
  };
}

/**
 * Given a direction or axis, returns what is considered the "start" and "end"
 * of a particular object
 */
export function getStartAndEndFromObject<T>(
  arg: { top: T; bottom: T; left: T; right: T },
  direction: Direction | Axis,
): [T, T] {
  switch (direction) {
    case 'up':
      return [arg.bottom, arg.top];
    case 'down':
    case 'y':
      return [arg.top, arg.bottom];
    case 'left':
      return [arg.right, arg.left];
    case 'right':
    case 'x':
      return [arg.left, arg.right];
    default:
      return [arg.left, arg.right];
  }
}

export function getPortDirection(port: Point, entity: LayoutEntity): Direction {
  // Calculate distances to each edge of the entity
  const distToRight = Math.abs(port[0] - (entity.x + entity.width));
  const distToLeft = Math.abs(port[0] - entity.x);
  const distToTop = Math.abs(port[1] - entity.y);
  const distToBottom = Math.abs(port[1] - (entity.y + entity.height));

  const isWithinXBounds = port[0] > entity.x && port[0] < entity.x + entity.width;
  const isWithinYBounds = port[1] > entity.y && port[1] < entity.y + entity.height;

  // Find the minimum distance
  const minDist = Math.min(distToRight, distToLeft, distToTop, distToBottom);

  // Do the typical case first where we are approaching one face from the outside
  // In that case, we are within x or y bounds but not both
  if (isWithinXBounds && !isWithinYBounds) {
    return distToTop < distToBottom ? 'up' : 'down';
  } else if (isWithinYBounds && !isWithinXBounds) {
    return distToLeft < distToRight ? 'left' : 'right';
  }

  // If we get here, we are either totally inside the shape or off on a corner
  // Return the direction based on which edge is closest
  if (minDist === distToRight) {
    return 'right';
  }
  if (minDist === distToLeft) {
    return 'left';
  }
  if (minDist === distToTop) {
    return 'up';
  }
  return 'down';
}
