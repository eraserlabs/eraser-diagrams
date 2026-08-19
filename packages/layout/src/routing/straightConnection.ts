import { clipFacePointToOutline, createEntityOutline } from '../outline.js';
import { getPortAsPoint } from '../portUtils.js';
import type { Direction, LayoutEntity } from '../types.js';
import type { Point } from './types.js';

/**
 * Terminal points for a straight connection: one direct segment between the two entities' drawn
 * boundaries, never a corridor route. An authored face pins its endpoint to that face's port
 * point; a free endpoint attaches where the center-to-center sight line leaves the entity's
 * outline (or bounding box when it has none). The far endpoint aims at the near one already
 * resolved, so a single authored port bends the whole segment toward it.
 */
export interface StraightConnectionOptions {
  readonly fromFace?: Direction;
  readonly toFace?: Direction;
}

const EPSILON = 1e-9;

export function straightConnectionEndpoints(
  fromEntity: LayoutEntity,
  toEntity: LayoutEntity,
  options: StraightConnectionOptions = {},
): [Point, Point] {
  const startTarget = options.toFace ? facePoint(toEntity, options.toFace) : center(toEntity);
  const start = options.fromFace
    ? facePoint(fromEntity, options.fromFace)
    : boundaryToward(fromEntity, startTarget);
  const end = options.toFace ? startTarget : boundaryToward(toEntity, start);

  return [start, end];
}

/** The face's port point walked inward to the drawn boundary — identity for plain boxes. */
function facePoint(entity: LayoutEntity, face: Direction): Point {
  const [x, y] = getPortAsPoint(entity, face, false);
  const clipped = clipFacePointToOutline(entity, face, { x, y });

  return [clipped.x, clipped.y];
}

function center(entity: LayoutEntity): Point {
  return [entity.x + entity.width / 2, entity.y + entity.height / 2];
}

/**
 * Where the ray from the entity's center toward `target` crosses its boundary. Overlapping
 * entities can put `target` inside — the exit point is still well-defined. Coincident centers
 * have no direction to walk, so the center itself stands in.
 */
function boundaryToward(entity: LayoutEntity, target: Point): Point {
  const origin = center(entity);
  const direction = { x: target[0] - origin[0], y: target[1] - origin[1] };

  if (Math.abs(direction.x) < EPSILON && Math.abs(direction.y) < EPSILON) {
    return origin;
  }

  const outline = entity.outline ? createEntityOutline(entity.outline, entity) : null;
  const hit = outline?.intersectRay({ x: origin[0], y: origin[1] }, direction);

  return hit ? [hit.x, hit.y] : boxExit(entity, origin, direction);
}

/** Center-origin ray against the bounding box: exit at whichever half-extent is reached first. */
function boxExit(entity: LayoutEntity, origin: Point, direction: { x: number; y: number }): Point {
  const tx = direction.x === 0 ? Infinity : entity.width / 2 / Math.abs(direction.x);
  const ty = direction.y === 0 ? Infinity : entity.height / 2 / Math.abs(direction.y);
  const t = Math.min(tx, ty);

  return [origin[0] + direction.x * t, origin[1] + direction.y * t];
}
