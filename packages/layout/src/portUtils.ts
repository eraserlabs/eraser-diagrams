import { clamp } from './rangeUtils.js';
import type { Direction, LayoutEntity } from './types.js';
import type { Point, RelativePortPosition } from './routing/types.js';

/** Return the cardinal attachment point on an entity body or its outward caption. */
export function getPortAsPoint(
  entity: LayoutEntity,
  direction: Direction,
  includeTextPlacement = true,
): Point {
  if (entity.customPorts?.[direction]) {
    return entity.customPorts[direction];
  }

  const textPlacement = includeTextPlacement ? entity.textPlacement : undefined;

  switch (direction) {
    case 'up': {
      const textIsUp = textPlacement && textPlacement.relativeY + textPlacement.height <= 0;
      const minY = textIsUp ? entity.y + textPlacement.relativeY : entity.y;
      return [Math.round(entity.x + entity.width / 2), Math.floor(minY)];
    }
    case 'down': {
      const textIsDown = textPlacement && textPlacement.relativeY >= entity.height;
      const maxY = textIsDown
        ? entity.y + textPlacement.relativeY + textPlacement.height
        : entity.y + entity.height;
      return [Math.round(entity.x + entity.width / 2), Math.ceil(maxY)];
    }
    case 'left': {
      const textIsLeft = textPlacement && textPlacement.relativeX + textPlacement.width <= 0;
      const minX = textIsLeft ? entity.x + textPlacement.relativeX : entity.x;
      return [Math.floor(minX), Math.round(entity.y + entity.height / 2)];
    }
    case 'right': {
      const textIsRight = textPlacement && textPlacement.relativeX >= entity.width;
      const maxX = textIsRight
        ? entity.x + textPlacement.relativeX + textPlacement.width
        : entity.x + entity.width;
      return [Math.ceil(maxX), Math.round(entity.y + entity.height / 2)];
    }
  }
}

/** Convert an absolute entity-boundary point into a stable relative port. */
export function getRelativePort(
  entity: LayoutEntity,
  point: Point,
  targetDirection?: Direction,
): RelativePortPosition {
  const relativeX = clamp((point[0] - entity.x) / entity.width, 0, 1);
  const relativeY = clamp((point[1] - entity.y) / entity.height, 0, 1);

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

  const xBorder = relativeX < 0.5 ? 0 : 1;
  const yBorder = relativeY < 0.5 ? 0 : 1;
  if (Math.abs(relativeX - xBorder) <= Math.abs(relativeY - yBorder)) {
    return [xBorder, Number(relativeY.toFixed(2))];
  }
  return [Number(relativeX.toFixed(2)), yBorder];
}

export function getRelativePortCoord(
  entity: Pick<LayoutEntity, 'x' | 'y' | 'width' | 'height'>,
  relativePort: readonly [number, number] | undefined,
  direction: Direction,
): number | undefined {
  if (!relativePort) {
    return undefined;
  }
  return direction === 'up' || direction === 'down'
    ? entity.x + relativePort[0] * entity.width
    : entity.y + relativePort[1] * entity.height;
}

/** Return the integer scene point represented by a relative entity port. */
export function getAbsolutePortPoint(
  entity: LayoutEntity,
  relativePortPoint: RelativePortPosition,
): Point {
  return [
    Math.floor(entity.x + entity.width * relativePortPoint[0]),
    Math.floor(entity.y + entity.height * relativePortPoint[1]),
  ];
}
