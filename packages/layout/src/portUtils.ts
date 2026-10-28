import type { Direction, LayoutEntity, Port } from './types.js';
import { Point } from './routing/types.js';

/** Midpoint of the entity box's `face`, snapped outward to whole pixels. */
export function getFaceCenterPoint(entity: LayoutEntity, face: Direction): Point {
  switch (face) {
    case 'up': {
      return [Math.round(entity.x + entity.width / 2), Math.floor(entity.y)];
    }
    case 'down': {
      return [Math.round(entity.x + entity.width / 2), Math.ceil(entity.y + entity.height)];
    }
    case 'left': {
      return [Math.floor(entity.x), Math.round(entity.y + entity.height / 2)];
    }
    case 'right': {
      return [Math.ceil(entity.x + entity.width), Math.round(entity.y + entity.height / 2)];
    }
  }
}

export function directionToPort(direction: Direction): Port {
  switch (direction) {
    case 'up':
      return 'top';
    case 'down':
      return 'bottom';
    default:
      return direction;
  }
}
