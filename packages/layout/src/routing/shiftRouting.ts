import type { LayoutManager } from '../LayoutManager.js';
import { getPortDirection } from '../directionUtils.js';
import { addToSet } from '../setUtils.js';
import type { Direction, LayoutConnection, LayoutEntity, NewConnection } from '../types.js';
import { buildExternalTextEntities } from './corridor/externalTextGeometry.js';
import type { EndpointPins } from './routeConnections.js';
import {
  absoluteConnectionPoints,
  determineDirectionsFromPoints,
  getAbsolutePortFromEntityAndConnection,
  getRelativePort,
  reversePoints,
  hasValidConnectionGeometry,
} from './points.js';
import { placeTextElement } from './textPlacements.js';
import type { Point, RelativePortPosition, RoutedConnectionChange } from './types.js';

/**
 * Preserve the gesture baseline when its attachments and current clearance allow it.
 * A free ('') side stays at its stored point unless pinned; at least one side must be bound.
 */
export function getShiftedConnection(
  layoutManager: LayoutManager,
  connection: NewConnection,
  pins?: EndpointPins,
): RoutedConnectionChange | undefined {
  const initial = layoutManager.getConnectionById(connection.id, false);
  if (
    !initial ||
    initial.from !== connection.from ||
    initial.to !== connection.to ||
    !hasValidConnectionGeometry(initial)
  ) {
    return undefined;
  }
  const from = initial.from ? layoutManager.getEntityById(initial.from) : undefined;
  const to = initial.to ? layoutManager.getEntityById(initial.to) : undefined;
  if ((initial.from && !from) || (initial.to && !to) || (!from && !to)) {
    return undefined;
  }

  const directions = determineDirectionsFromPoints(initial.points);
  const initialEnd = absoluteConnectionPoints(initial).at(-1)!;
  const fromPin = pins?.from;
  const toPin = pins?.to;
  if (
    (connection.authoredFromFace && connection.authoredFromFace !== directions.startDirection) ||
    (connection.authoredToFace && connection.authoredToFace !== directions.endDirection) ||
    (!fromPin &&
      (connection.relativeFromPort?.[0] !== initial.relativeFromPort?.[0] ||
        connection.relativeFromPort?.[1] !== initial.relativeFromPort?.[1])) ||
    (!toPin &&
      (connection.relativeToPort?.[0] !== initial.relativeToPort?.[0] ||
        connection.relativeToPort?.[1] !== initial.relativeToPort?.[1])) ||
    (fromPin && from && getPortDirection(fromPin, from) !== directions.startDirection) ||
    (toPin && to && getPortDirection(toPin, to) !== directions.endDirection)
  ) {
    // New attachment constraints must not silently restore the old port or face.
    return undefined;
  }
  const fromTranslation: Point | undefined = from
    ? unchangedEntityTranslation(from, layoutManager.getEntityById(initial.from, false, false))
    : [0, 0];
  const toTranslation: Point | undefined = to
    ? unchangedEntityTranslation(to, layoutManager.getEntityById(initial.to, false, false))
    : [0, 0];
  const start =
    fromPin ??
    (fromTranslation
      ? [initial.x + fromTranslation[0], initial.y + fromTranslation[1]]
      : getAbsolutePortFromEntityAndConnection(
          from,
          initial.relativeFromPort,
          true,
          directions.startDirection,
        ));
  const end =
    toPin ??
    (toTranslation
      ? [initialEnd[0] + toTranslation[0], initialEnd[1] + toTranslation[1]]
      : getAbsolutePortFromEntityAndConnection(
          to,
          initial.relativeToPort,
          true,
          directions.endDirection,
        ));
  if (!start || !end) {
    return undefined;
  }

  const startDelta: Point = [start[0] - initial.x, start[1] - initial.y];
  const endDelta: Point = [end[0] - initialEnd[0], end[1] - initialEnd[1]];
  const isTranslation = startDelta[0] === endDelta[0] && startDelta[1] === endDelta[1];
  const labelSizeUnchanged =
    initial.textPlacement?.width === connection.textPlacement?.width &&
    initial.textPlacement?.height === connection.textPlacement?.height;

  let shifted: Pick<RoutedConnectionChange, 'x' | 'y' | 'points' | 'textPlacement'> | undefined;
  if (isTranslation) {
    // A rigid translation preserves bends and the label's relative placement.
    shifted = {
      x: start[0],
      y: start[1],
      points: initial.points.map(([x, y]) => [x, y]),
      ...(initial.textPlacement &&
        labelSizeUnchanged && {
          textPlacement: {
            ...initial.textPlacement,
            x: initial.textPlacement.x + startDelta[0],
            y: initial.textPlacement.y + startDelta[1],
          },
        }),
    };
  } else {
    const points = tryShiftBasedDeformation(initial.points, startDelta, endDelta, directions);
    // The origin is the resolved start either way: an end-only deformation leaves it at the initial origin.
    if (points) {
      shifted = { x: start[0], y: start[1], points };
    }
  }
  if (
    !shifted ||
    checkIfOverlapsEntity(layoutManager, shifted, initial.id) ||
    checkIfOverlapsSelf(shifted.points)
  ) {
    return undefined;
  }
  return {
    ...shifted,
    relativeFromPort: shiftedPort(
      from,
      fromPin ? undefined : connection.relativeFromPort,
      fromPin ?? [shifted.x, shifted.y],
      directions.startDirection,
    ),
    relativeToPort: shiftedPort(
      to,
      toPin ? undefined : connection.relativeToPort,
      toPin ?? absoluteConnectionPoints(shifted).at(-1)!,
      directions.endDirection,
    ),
  };
}

/** Unpinned sides keep their stored port; pinned or portless bound sides re-derive it. */
function shiftedPort(
  entity: LayoutEntity | undefined,
  storedPort: RelativePortPosition | undefined,
  terminal: Point,
  face: Direction,
): RelativePortPosition | undefined {
  if (!entity) {
    return undefined;
  }
  return storedPort ? [...storedPort] : getRelativePort(entity, terminal, face);
}

function unchangedEntityTranslation(
  entity: LayoutEntity,
  initial?: LayoutEntity,
): Point | undefined {
  if (
    !initial ||
    entity.width !== initial.width ||
    entity.height !== initial.height ||
    entity.textPlacement?.relativeX !== initial.textPlacement?.relativeX ||
    entity.textPlacement?.relativeY !== initial.textPlacement?.relativeY ||
    entity.textPlacement?.width !== initial.textPlacement?.width ||
    entity.textPlacement?.height !== initial.textPlacement?.height
  ) {
    return undefined;
  }
  return [entity.x - initial.x, entity.y - initial.y];
}

/** Stage validated shift geometry, then re-place a label the shift did not carry. */
export function finalizeShiftRoute(
  layoutManager: LayoutManager,
  connection: NewConnection,
  result: RoutedConnectionChange,
): void {
  const { textPlacement: _textPlacement, ...input } = connection;
  layoutManager.updateConnection(connection.id, { ...input, ...result });
  if (result.textPlacement) {
    return;
  }

  const updated = layoutManager.getConnectionById(connection.id)!;
  const label = connection.textPlacement ?? updated.textPlacement;
  if (!label) {
    return;
  }
  const textPlacement = placeTextElement(
    layoutManager,
    {
      ...updated,
      textPlacement: {
        x: Number.NaN,
        y: Number.NaN,
        width: label.width,
        height: label.height,
      },
    },
    layoutManager.getTextPlacements(),
  );
  if (textPlacement) {
    layoutManager.updateConnection(connection.id, { textPlacement });
  }
}

// Threshold for determining when to use shift-based routing vs full re-routing
export const SHIFT_THRESHOLD = 500;
// We never want segments to be less than this
const MIN_SEGMENT_LENGTH = 30;

/** Deform the one moved terminal's relative points without changing either endpoint's approach direction. */
function tryShiftBasedDeformation(
  points: Point[],
  [startDeltaX, startDeltaY]: Point,
  [endDeltaX, endDeltaY]: Point,
  initialDirections: ReturnType<typeof determineDirectionsFromPoints>,
): Point[] | undefined {
  // Different displacements at both ends require a new route.
  if ((startDeltaX || startDeltaY) && (endDeltaX || endDeltaY)) {
    return undefined;
  }

  if (
    Math.abs(startDeltaX) + Math.abs(startDeltaY) > SHIFT_THRESHOLD ||
    Math.abs(endDeltaX) + Math.abs(endDeltaY) > SHIFT_THRESHOLD
  ) {
    return undefined;
  }

  const shiftedPoints =
    startDeltaX !== 0 || startDeltaY !== 0
      ? shiftStart(points, startDeltaX, startDeltaY)
      : shiftEnd(points, endDeltaX, endDeltaY);
  if (!shiftedPoints) {
    return undefined;
  }

  const { startDirection, endDirection } = determineDirectionsFromPoints(shiftedPoints);
  if (
    startDirection !== initialDirections.startDirection ||
    endDirection !== initialDirections.endDirection
  ) {
    return undefined;
  }

  return shiftedPoints;
}

/**
 * Shifts the end of a connection.
 * This is the simpler case because we don't need to account for downstream points.
 * To make things easier, we also abort if the "shift" is longer than the last / second to last segment.
 * @see https://app.eraser.io/workspace/jtgHgbDfzAL9lr3AcIh4#iQz-k7-rVtf8ow0laBIg2
 */
function shiftEnd(points: Point[], deltaX: number, deltaY: number): Point[] | undefined {
  const newPoints: Point[] = points.map(([x, y]) => [x, y]);
  const last = newPoints.at(-1)!;
  const first = newPoints[0];
  const isHorizontal = last[1] === newPoints.at(-2)![1];
  const signX = Math.sign(deltaX);
  const signY = Math.sign(deltaY);

  // We use this to figure out if the line is still long enough to be shift-able
  const parallelSegmentCount = Math.floor(points.length / 2);
  const minLength = parallelSegmentCount * MIN_SEGMENT_LENGTH;

  // Deal with the edge case where there isn't enough space to do the shifting because we are shortining (or inverting)
  if (isHorizontal) {
    if (signX !== Math.sign(last[0]) && Math.abs(deltaX) > Math.abs(last[0]) - minLength) {
      return undefined;
    }
  } else {
    if (signY !== Math.sign(last[1]) && Math.abs(deltaY) > Math.abs(last[1]) - minLength) {
      return undefined;
    }
  }

  let i = points.length - 1;
  let remainingDX = Math.abs(deltaX);
  let remainingDY = Math.abs(deltaY);

  while (i > 0 && (remainingDX || remainingDY)) {
    const segmentEndpoint = newPoints[i];
    const segmentStartPoint = newPoints[i - 1];

    if (isHorizontal) {
      if (remainingDY > 0 && segmentStartPoint !== first) {
        // When the segment is horizontal, we shift the two points up or down, but no other points
        segmentStartPoint[1] += deltaY;
        segmentEndpoint[1] += deltaY;
        remainingDY = 0;
      }

      // Capture the length of the existing segment to see if we need to shrink other ones
      const segmentLength = segmentEndpoint[0] - segmentStartPoint[0];

      // Move the segment left or right
      segmentEndpoint[0] += remainingDX * signX;

      // The amount we move is capped if we are shrinking (we need the segment to keep MIN_SEGMENT_LENGTH)
      const dxToSubtract =
        Math.sign(segmentLength) === signX
          ? remainingDX
          : Math.max(
              Math.min(Math.abs(segmentLength) - MIN_SEGMENT_LENGTH, Math.abs(remainingDX)),
              0,
            );

      remainingDX -= dxToSubtract;

      // If the segment was too short, we also need to adjust the start point, since we will be adjusting the prior endpoint
      if (remainingDX > 0 && segmentStartPoint !== first) {
        segmentStartPoint[0] += remainingDX * signX;
      }
    } else {
      // When the segment is vertical, we shift the two points left or right, but no other points
      if (remainingDX > 0 && segmentStartPoint !== first) {
        segmentStartPoint[0] += deltaX;
        segmentEndpoint[0] += deltaX;
        remainingDX = 0;
      }

      // Capture the length of the existing segment to see if we need to shrink other ones
      const segmentLength = segmentEndpoint[1] - segmentStartPoint[1];

      // Move the segment up or down
      segmentEndpoint[1] += remainingDY * signY;

      // Now account for if the existing segment was too short and we still need to shrink other segments
      const dyToSubtract =
        Math.sign(segmentLength) === signY
          ? remainingDY
          : Math.max(
              Math.min(Math.abs(segmentLength) - MIN_SEGMENT_LENGTH, Math.abs(remainingDY)),
              0,
            );
      remainingDY -= dyToSubtract;

      // If the segment was too short, we also need to adjust the start point, since we will be adjusting the prior endpoint
      if (remainingDY > 0 && segmentStartPoint !== first) {
        segmentStartPoint[1] += remainingDY * signY;
      }
    }

    // Skip to parallel segments only
    i -= 2;
  }

  if (remainingDX || remainingDY) {
    return undefined;
  }

  return newPoints;
}

/**
 * Shifting at start is trickier because we need to account for all downstream segments.
 * To make it easier for now, we just reverse the points, call shiftEnd, and then reverse again.
 */
function shiftStart(points: Point[], deltaX: number, deltaY: number): Point[] | undefined {
  const shifted = shiftEnd(reversePoints(points), deltaX, deltaY);
  return shifted ? reversePoints(shifted) : undefined;
}

/**
 * Checks if a shifted connection would cause overlaps with entities
 */
export function checkIfOverlapsEntity(
  layoutManager: LayoutManager,
  geometry: Pick<LayoutConnection, 'x' | 'y' | 'points'>,
  connectionId?: string,
): boolean {
  const absolutePoints = absoluteConnectionPoints(geometry);

  const currentConnection = connectionId
    ? layoutManager.getConnectionById(connectionId)
    : undefined;

  const ignoreIds = new Set<string>();
  /**
   * @note We don't add the entities themselves, and instead use the padding checks below.
   * Reasoning: we want to prevent lines that go through the entity, but not lines that are just connecting!
   **/
  if (currentConnection) {
    addToSet(ignoreIds, layoutManager.getAllContainerIds(currentConnection.from));
    addToSet(ignoreIds, layoutManager.getAllContainerIds(currentConnection.to));
  }

  // Captions block exactly as the corridor world blocks them, so accepted shifts stay adoptable.
  const captions = buildExternalTextEntities(layoutManager.getEntities()).filter(
    (caption) => !ignoreIds.has(caption.id),
  );

  const PADDING = 2;

  // Check each segment for overlaps with entities
  for (let i = 0; i < absolutePoints.length - 1; i++) {
    const [x1, y1] = absolutePoints[i];
    const [x2, y2] = absolutePoints[i + 1];

    const isHorizontal = y1 === y2;
    /**
     * @note For a mental model here, if a line is horizontal, we want to catch the area above or below it,
     * but not worry about the exact endpoint of the line. This will catch any obvious overlaps but prevent
     * us from actually catching the to and from entities themselves.
     */
    const horizontalPadding = isHorizontal ? -PADDING : PADDING;
    const verticalPadding = isHorizontal ? PADDING : -PADDING;

    // Create a bounding box for the segment with some padding
    const segmentMinX = Math.min(x1, x2) - horizontalPadding;
    const segmentMaxX = Math.max(x1, x2) + horizontalPadding;
    const segmentMinY = Math.min(y1, y2) - verticalPadding;
    const segmentMaxY = Math.max(y1, y2) + verticalPadding;

    const overlaps = layoutManager.findEntitiesInRange({
      minX: segmentMinX,
      minY: segmentMinY,
      maxX: segmentMaxX,
      maxY: segmentMaxY,
    });

    if (overlaps.some((entity) => !ignoreIds.has(entity.id))) {
      return true;
    }
    if (
      captions.some(
        (caption) =>
          segmentMinX < caption.x + caption.width &&
          segmentMaxX > caption.x &&
          segmentMinY < caption.y + caption.height &&
          segmentMaxY > caption.y,
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a line intersects itself.
 * Note - not complete, just a quick check.
 */
function checkIfOverlapsSelf(points: Point[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const segment: [Point, Point] = [points[i], points[i + 1]];

    // Compare against all further-down perpendicular segments
    for (let j = i + 1; j < points.length - 1; j += 2) {
      const otherSegment: [Point, Point] = [points[j], points[j + 1]];

      if (checkIfSegmentsIntersect(segment, otherSegment)) {
        return true;
      }
    }
  }

  return false;
}

function checkIfSegmentsIntersect(segmentA: [Point, Point], segmentB: [Point, Point]): boolean {
  const [startA, endA] = segmentA;
  const [startB, endB] = segmentB;

  if (!startA || !startB || !endA || !endB) {
    return false;
  }

  const minAX = Math.min(startA[0], endA[0]);
  const maxAX = Math.max(startA[0], endA[0]);
  const minBX = Math.min(startB[0], endB[0]);
  const maxBX = Math.max(startB[0], endB[0]);

  if (maxBX <= minAX || maxAX <= minBX) {
    return false;
  }

  const minAY = Math.min(startA[1], endA[1]);
  const maxAY = Math.max(startA[1], endA[1]);
  const minBY = Math.min(startB[1], endB[1]);
  const maxBY = Math.max(startB[1], endB[1]);

  if (maxBY <= minAY || maxAY <= minBY) {
    return false;
  }

  return true;
}
