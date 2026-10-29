import { LayoutManager } from '../LayoutManager.js';
import {
  PositionProps,
  LayoutConnection,
  TextPlacement,
  LayoutRange,
  LayoutEntity,
} from '../types.js';
import {
  makeRangeForEntityTextPlacement,
  makeRangeFromEntity,
  makePropsFromRange,
} from '../rangeUtils.js';
import {
  distanceToLineSegment,
  effectiveLabelPerpOffset,
  getLineMidPoint,
  simplifyCollinearPoints,
} from './polylineUtils.js';
import type { Point } from './types.js';

/** Represents a single segment of a line in diagram / global coordinates */
export type CoordinateSegment = [{ x: number; y: number }, { x: number; y: number }];

/** Gap between a label and the line when text is wider/taller than the segment. */
export const LABEL_LINE_GAP = 4;

/**
 * Off-line label offset the canvas applies (px, line to label CENTER): the
 * property-bar "Label offset" picker writes ±this to labelPlacement.lineOffset,
 * so auto-placed off-line labels sit at the same offset as GUI-dragged ones.
 */
export const LABEL_OFFSET_MAGNITUDE = 24;

/**
 * Extra slack before a label is treated as longer than a segment along its axis.
 * When `labelSpan + buffer > segmentLength`, the label sits above (horizontal) or beside (vertical).
 */
export const LABEL_OFF_SEGMENT_BUFFER = 25;
const LABEL_CENTER_ON_SEGMENT_EPSILON = 0.001;

/** A label can have measured dimensions before it has a position. */
export function hasMeasuredLabel(label: PositionProps | undefined): label is PositionProps {
  return (
    label !== undefined &&
    Number.isFinite(label.width) &&
    Number.isFinite(label.height) &&
    label.width > 0 &&
    label.height > 0
  );
}

function getSegmentAxisSpans(segment: CoordinateSegment): {
  dx: number;
  dy: number;
  varyingAxis: 'x' | 'y';
} {
  const [start, end] = segment;
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  return { dx, dy, varyingAxis: dy < dx ? 'x' : 'y' };
}

/** Label span exceeds segment length along the segment axis — place above (horizontal) or beside (vertical). */
function shouldPlaceLabelOffSegment(
  props: { width: number; height: number },
  segment: CoordinateSegment,
): boolean {
  const { dx, dy, varyingAxis } = getSegmentAxisSpans(segment);
  const segmentLength = varyingAxis === 'x' ? dx : dy;
  const labelSpan = varyingAxis === 'x' ? props.width : props.height;
  return labelSpan + LABEL_OFF_SEGMENT_BUFFER > segmentLength;
}

/**
 * Position a centered label perpendicular to its segment.
 *
 * Default (no `lineOffset`): unchanged — only lifts the label above (horizontal)
 * or beside (vertical) the segment when it does not fit, otherwise returns
 * `position` untouched. DSL auto-placement relies on this exact behavior.
 *
 * Manual (`lineOffset !== 0`): the signed offset (px) is authoritative on the
 * perpendicular axis — the label center is pinned to `lineOffset` from the line
 * (positive = above / right), independent of fit. The along-axis position is
 * preserved from `position` so a manual label keeps where the user slid it along
 * the segment (callers that want centering pre-center `position`).
 */
export function adjustLabelPositionOffSegment(
  position: PositionProps,
  segment: CoordinateSegment,
  gap = LABEL_LINE_GAP,
  lineOffset = 0,
): PositionProps {
  const [start, end] = segment;
  const { varyingAxis } = getSegmentAxisSpans(segment);

  if (lineOffset !== 0) {
    if (varyingAxis === 'x') {
      // Horizontal segment → perpendicular axis is y; clear by at least half the label height.
      const perpCenter = effectiveLabelPerpOffset(lineOffset, position.height / 2, gap);
      const lineY = (start.y + end.y) / 2;
      return {
        ...position,
        y: lineY - perpCenter - position.height / 2,
      };
    }

    // Vertical segment → perpendicular axis is x; clear by at least half the label width.
    const perpCenter = effectiveLabelPerpOffset(lineOffset, position.width / 2, gap);
    const lineX = (start.x + end.x) / 2;
    return {
      ...position,
      x: lineX + perpCenter - position.width / 2,
    };
  }

  if (!shouldPlaceLabelOffSegment(position, segment)) {
    return position;
  }

  if (varyingAxis === 'x') {
    const lineY = (start.y + end.y) / 2;
    const midX = (start.x + end.x) / 2;
    return {
      ...position,
      x: midX - position.width / 2,
      y: lineY - position.height - gap,
    };
  }

  const lineX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  return {
    ...position,
    x: lineX + gap,
    y: midY - position.height / 2,
  };
}

/** Label box centered on a segment midpoint, with off-line adjustment when needed. */
export function labelPositionCenteredOnSegment(
  props: { width: number; height: number },
  segment: CoordinateSegment,
  gap = LABEL_LINE_GAP,
): PositionProps {
  const [start, end] = segment;
  return adjustLabelPositionOffSegment(
    {
      x: (start.x + end.x) / 2 - props.width / 2,
      y: (start.y + end.y) / 2 - props.height / 2,
      width: props.width,
      height: props.height,
    },
    segment,
    gap,
  );
}

function toCoordinateSegmentFromPolyline(
  start: Readonly<Point>,
  end: Readonly<Point>,
): CoordinateSegment {
  return [
    { x: start[0], y: start[1] },
    { x: end[0], y: end[1] },
  ];
}

/** Perpendicular slack for treating a label center as sitting on a segment. */
function labelCenterProximityTolerance(
  labelRect: { width: number; height: number },
  varyingAxis: 'x' | 'y',
): number {
  const perpendicular = varyingAxis === 'x' ? labelRect.height : labelRect.width;
  return perpendicular / 2 + LABEL_LINE_GAP + 2;
}

/**
 * True when the label center is near a segment and its span along that segment
 * overlaps the segment (element-relative coordinates).
 *
 * `extraPerpTolerance` widens the perpendicular proximity check; callers pass it
 * for manually-offset labels whose center sits a perpendicular distance off the
 * line (DSL/routing callers leave it 0, keeping the default check intact).
 */
export function isLabelRectOnSegment(
  labelRect: { x: number; y: number; width: number; height: number },
  points: readonly Readonly<Point>[],
  segmentIndex: number,
  extraPerpTolerance = 0,
): boolean {
  if (segmentIndex < 0 || segmentIndex >= points.length - 1) {
    return false;
  }

  const a = points[segmentIndex];
  const b = points[segmentIndex + 1];
  const centerX = labelRect.x + labelRect.width / 2;
  const centerY = labelRect.y + labelRect.height / 2;

  const { varyingAxis } = getSegmentAxisSpans(toCoordinateSegmentFromPolyline(a, b));
  const centerAlong = varyingAxis === 'x' ? centerX : centerY;
  const segStart = varyingAxis === 'x' ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
  const segEnd = varyingAxis === 'x' ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
  const alongPad = (varyingAxis === 'x' ? labelRect.width : labelRect.height) / 2;

  if (centerAlong < segStart - alongPad || centerAlong > segEnd + alongPad) {
    return false;
  }

  return (
    distanceToLineSegment([centerX, centerY], [a, b]) <=
    labelCenterProximityTolerance(labelRect, varyingAxis) + extraPerpTolerance
  );
}

function isLabelCenterDirectlyOnSegment(
  labelRect: { x: number; y: number; width: number; height: number },
  points: readonly Readonly<Point>[],
  segmentIndex: number,
): boolean {
  if (segmentIndex < 0 || segmentIndex >= points.length - 1) {
    return false;
  }

  const a = points[segmentIndex];
  const b = points[segmentIndex + 1];
  const centerX = labelRect.x + labelRect.width / 2;
  const centerY = labelRect.y + labelRect.height / 2;
  const { varyingAxis } = getSegmentAxisSpans(toCoordinateSegmentFromPolyline(a, b));
  const centerAlong = varyingAxis === 'x' ? centerX : centerY;
  const segStart = varyingAxis === 'x' ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
  const segEnd = varyingAxis === 'x' ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);

  if (
    centerAlong < segStart - LABEL_CENTER_ON_SEGMENT_EPSILON ||
    centerAlong > segEnd + LABEL_CENTER_ON_SEGMENT_EPSILON
  ) {
    return false;
  }

  return distanceToLineSegment([centerX, centerY], [a, b]) <= LABEL_CENTER_ON_SEGMENT_EPSILON;
}

/** True when the label center sits on (or just above) any connection segment. */
function isLabelRectOnConnection(
  points: readonly Readonly<Point>[],
  labelRect: { x: number; y: number; width: number; height: number },
): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (isLabelRectOnSegment(labelRect, points, i)) {
      return true;
    }
  }
  return false;
}

function findSegmentForLabel(
  points: readonly Readonly<Point>[],
  labelRect: { x: number; y: number; width: number; height: number },
): CoordinateSegment | undefined {
  // Prefer exact ownership before fuzzy "hovering near" ownership. The fuzzy
  // pass intentionally supports off-segment labels, but can let an earlier elbow
  // stub claim a label whose center is directly on a later run.
  for (let i = 0; i < points.length - 1; i++) {
    if (isLabelCenterDirectlyOnSegment(labelRect, points, i)) {
      return toCoordinateSegmentFromPolyline(points[i], points[i + 1]);
    }
  }

  for (let i = 0; i < points.length - 1; i++) {
    if (isLabelRectOnSegment(labelRect, points, i)) {
      return toCoordinateSegmentFromPolyline(points[i], points[i + 1]);
    }
  }

  return undefined;
}

function findLongestHorizontalSegment(
  points: readonly Readonly<Point>[],
): CoordinateSegment | undefined {
  let best: { segment: CoordinateSegment; length: number } | undefined;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dy >= dx) {
      continue;
    }
    if (!best || dx > best.length) {
      best = { segment: toCoordinateSegmentFromPolyline(a, b), length: dx };
    }
  }

  return best?.segment;
}

function findLongestVerticalSegment(
  points: readonly Readonly<Point>[],
): CoordinateSegment | undefined {
  let best: { segment: CoordinateSegment; length: number } | undefined;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dx >= dy) {
      continue;
    }
    if (!best || dy > best.length) {
      best = { segment: toCoordinateSegmentFromPolyline(a, b), length: dy };
    }
  }

  return best?.segment;
}

function findHorizontalSegmentNearMidpoint(
  points: readonly Readonly<Point>[],
): CoordinateSegment | undefined {
  if (points.length < 2) {
    return undefined;
  }

  const [midX, midY] = getLineMidPoint(points);
  let best: { segment: CoordinateSegment; distance: number } | undefined;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dy >= dx) {
      continue;
    }

    const distance = Math.hypot(
      (points[i][0] + points[i + 1][0]) / 2 - midX,
      (points[i][1] + points[i + 1][1]) / 2 - midY,
    );
    if (!best || distance < best.distance) {
      best = { segment: toCoordinateSegmentFromPolyline(a, b), distance };
    }
  }

  return best?.segment;
}

function findVerticalSegmentNearMidpoint(
  points: readonly Readonly<Point>[],
): CoordinateSegment | undefined {
  if (points.length < 2) {
    return undefined;
  }

  const [midX, midY] = getLineMidPoint(points);
  let best: { segment: CoordinateSegment; distance: number } | undefined;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dx >= dy) {
      continue;
    }

    const distance = Math.hypot(
      (points[i][0] + points[i + 1][0]) / 2 - midX,
      (points[i][1] + points[i + 1][1]) / 2 - midY,
    );
    if (!best || distance < best.distance) {
      best = { segment: toCoordinateSegmentFromPolyline(a, b), distance };
    }
  }

  return best?.segment;
}

function defaultLabelRectOnPolyline(
  rawPoints: readonly Readonly<Point>[],
  props: { width: number; height: number },
): PositionProps {
  const points = simplifyCollinearPoints(rawPoints, LABEL_CENTER_ON_SEGMENT_EPSILON);
  const segment =
    findLongestHorizontalSegment(points) ??
    findLongestVerticalSegment(points) ??
    findHorizontalSegmentNearMidpoint(points) ??
    findVerticalSegmentNearMidpoint(points);
  if (segment) {
    return labelPositionCenteredOnSegment(props, segment);
  }

  const [centerX, centerY] = getLineMidPoint(points);
  return {
    x: centerX - props.width / 2,
    y: centerY - props.height / 2,
    width: props.width,
    height: props.height,
  };
}

function adjustLabelOffOverlappingSegment(
  points: readonly Readonly<Point>[],
  labelRect: PositionProps,
  lineOffset = 0,
): PositionProps {
  const segment = findSegmentForLabel(points, labelRect);
  if (!segment) {
    return labelRect;
  }

  return adjustLabelPositionOffSegment(labelRect, segment, LABEL_LINE_GAP, lineOffset);
}

/**
 * Element-relative label offset from a layout connection's absolute `textPlacement`.
 * Returns undefined when only label dimensions are seeded (x/y not finite).
 */
function getStoredLabelRelativeFromConnection(
  connection: LayoutConnection,
  placementProps: PositionProps,
): { x: number; y: number } | undefined {
  if (connection.x === undefined || connection.y === undefined) {
    return undefined;
  }
  if (!Number.isFinite(placementProps.x) || !Number.isFinite(placementProps.y)) {
    return undefined;
  }

  return {
    x: placementProps.x - connection.x,
    y: placementProps.y - connection.y,
  };
}

/**
 * Resolve connection label x/y in element-relative coordinates.
 * Used by routing (`placeTextElement`) and written to `freeform.labelPlacement` by the adapter.
 */
export function resolveConnectionLabelRelativePlacement(
  points: readonly Readonly<Point>[],
  props: { width: number; height: number },
  storedRelative?: { x: number; y: number },
  lineOffset = 0,
): PositionProps {
  let position = defaultLabelRectOnPolyline(points, props);

  if (storedRelative) {
    const storedRect = {
      x: storedRelative.x,
      y: storedRelative.y,
      width: props.width,
      height: props.height,
    };
    // A manual offset is authoritative: keep the stored along-line base even when
    // the (perpendicularly offset) rect no longer registers as "on" the line.
    if (lineOffset !== 0 || isLabelRectOnConnection(points, storedRect)) {
      position = { ...storedRect };
    }
  }

  return adjustLabelOffOverlappingSegment(points, position, lineOffset);
}

/**
 * Place a connection label: prefer collision-free segments near the midpoint;
 * fall back to stored relative placement if nothing fits.
 */
export function placeTextElement(
  layoutManager: LayoutManager,
  connection: LayoutConnection,
  textPlacements: TextPlacement[],
  corridorAxis?: 'x' | 'y',
): PositionProps | undefined {
  const placementProps = connection.textPlacement;

  if (!placementProps) {
    return undefined;
  }

  const rawRelativePoints = connection.points as readonly Readonly<Point>[] | undefined;
  const relativePoints = rawRelativePoints
    ? simplifyCollinearPoints(rawRelativePoints, LABEL_CENTER_ON_SEGMENT_EPSILON)
    : undefined;
  const storedRelative = getStoredLabelRelativeFromConnection(connection, placementProps);

  const segments = makeSegmentCoordinates(connection);

  const allConnections = layoutManager.getConnections();
  const containerBorders = collectContainerBorderStrips(layoutManager);
  let splitLevel = 0;
  let bestPosition: PositionProps | undefined;
  let firstPosition: PositionProps | undefined;
  let borderFallback: PositionProps | undefined;

  while (splitLevel < 3 && !bestPosition) {
    const sortedValidSegments = getSortedValidSegments(
      segments,
      placementProps,
      splitLevel,
      corridorAxis,
    );

    // Among candidates that pass the hard constraints (no node/label
    // collision, no line intersection), prefer the first clear of container
    // border strips; the sort order (axis preference, midpoint proximity)
    // breaks ties. Space-first: a label on a group boundary while open space
    // sits nearby must lose to the open-space candidate. Border-intersecting
    // candidates are kept as a fallback when no level yields a clear one.
    for (const segment of sortedValidSegments) {
      const potentialPosition = labelPositionCenteredOnSegment(placementProps, segment);

      if (!firstPosition) {
        firstPosition = potentialPosition;
      }

      const range = makeRangeFromEntity(potentialPosition);

      const hasNodeCollisions = detectCollisions(
        layoutManager,
        textPlacements,
        range,
        connection.id,
      );

      const hasConnectionIntersects =
        !hasNodeCollisions && detectConnectionIntersections(range, allConnections, connection.id);

      if (hasNodeCollisions || hasConnectionIntersects) {
        continue;
      }
      if (!intersectsAnyBorderStrip(potentialPosition, containerBorders)) {
        bestPosition = potentialPosition;
        break;
      }
      borderFallback = borderFallback ?? potentialPosition;
    }

    splitLevel++;
  }

  let finalPosition = bestPosition || borderFallback || firstPosition;

  if (!finalPosition && segments.length > 0 && relativePoints && relativePoints.length >= 2) {
    const relative = resolveConnectionLabelRelativePlacement(
      relativePoints,
      placementProps,
      storedRelative,
    );
    if (connection.x !== undefined && connection.y !== undefined) {
      finalPosition = {
        ...relative,
        x: connection.x + relative.x,
        y: connection.y + relative.y,
      };
    }
  }

  return finalPosition;
}

/** Container borders act as thin strips of this half-width for label scoring. */
const CONTAINER_BORDER_STRIP_HALF_WIDTH = 4;

function collectContainerBorderStrips(layoutManager: LayoutManager): PositionProps[] {
  const strips: PositionProps[] = [];
  const w = CONTAINER_BORDER_STRIP_HALF_WIDTH;
  for (const entity of layoutManager.getEntities?.() ?? []) {
    if (!entity.isContainer) {
      continue;
    }
    strips.push(
      { x: entity.x - w, y: entity.y - w, width: entity.width + 2 * w, height: 2 * w },
      {
        x: entity.x - w,
        y: entity.y + entity.height - w,
        width: entity.width + 2 * w,
        height: 2 * w,
      },
      { x: entity.x - w, y: entity.y - w, width: 2 * w, height: entity.height + 2 * w },
      {
        x: entity.x + entity.width - w,
        y: entity.y - w,
        width: 2 * w,
        height: entity.height + 2 * w,
      },
    );
  }
  return strips;
}

function intersectsAnyBorderStrip(rect: PositionProps, strips: PositionProps[]): boolean {
  for (const strip of strips) {
    if (
      rect.x < strip.x + strip.width &&
      rect.x + rect.width > strip.x &&
      rect.y < strip.y + strip.height &&
      rect.y + rect.height > strip.y
    ) {
      return true;
    }
  }
  return false;
}

function detectCollisions(
  layoutManager: LayoutManager,
  textPlacements: TextPlacement[],
  range: LayoutRange,
  connectionId?: string,
): boolean {
  const overlappingEntities = layoutManager.findLeafEntitiesInRange(range);

  if (overlappingEntities.length > 0) {
    return true;
  }

  for (const placement of textPlacements) {
    if (connectionId && placement.entityId === connectionId) {
      continue;
    }

    const placementRange = makeRangeFromEntity(placement);

    if (
      range.minX <= placementRange.maxX &&
      range.maxX >= placementRange.minX &&
      range.minY <= placementRange.maxY &&
      range.maxY >= placementRange.minY
    ) {
      return true;
    }
  }

  return false;
}

function detectConnectionIntersections(
  textRange: LayoutRange,
  allConnections: LayoutConnection[],
  connectionId?: string,
): boolean {
  for (const connection of allConnections) {
    if (connectionId && connection.id === connectionId) {
      continue;
    }

    const segments = makeSegmentCoordinates(connection);

    for (const [start, end] of segments) {
      const segmentRange = {
        minX: Math.min(start.x, end.x),
        maxX: Math.max(start.x, end.x),
        minY: Math.min(start.y, end.y),
        maxY: Math.max(start.y, end.y),
      };

      if (
        textRange.minX <= segmentRange.maxX &&
        textRange.maxX >= segmentRange.minX &&
        textRange.minY <= segmentRange.maxY &&
        textRange.maxY >= segmentRange.minY
      ) {
        return true;
      }
    }
  }

  return false;
}

function makeSegmentCoordinates({ x, y, points }: LayoutConnection): CoordinateSegment[] {
  if (!points || points.length < 2 || x === undefined || y === undefined) {
    return [];
  }

  const simplifiedPoints = simplifyCollinearPoints(points, LABEL_CENTER_ON_SEGMENT_EPSILON);
  const segments: CoordinateSegment[] = [];

  for (let i = 0; i < simplifiedPoints.length - 1; i++) {
    const start = simplifiedPoints[i];
    const end = simplifiedPoints[i + 1];

    segments.push([
      { x: start[0] + x, y: start[1] + y },
      { x: end[0] + x, y: end[1] + y },
    ]);
  }

  return segments;
}

/**
 * A segment is on the primary axis if it runs perpendicular to the corridor axis.
 * - corridorAxis='y' (LTR): primary segments are horizontal (dy ≈ 0).
 * - corridorAxis='x' (TTB): primary segments are vertical (dx ≈ 0).
 */
function isPrimaryAxisSegment(segment: CoordinateSegment, corridorAxis: 'x' | 'y'): boolean {
  const [start, end] = segment;
  if (corridorAxis === 'y') {
    return Math.abs(end.y - start.y) < 0.5;
  }
  return Math.abs(end.x - start.x) < 0.5;
}

/**
 * Filters segments for those that are at least long enough for the text placement,
 * then sorts them with a three-tier priority:
 *   1. Primary-axis segments before corridor-axis segments (when corridorAxis provided)
 *   2. Closer to the middle index (among segments of the same tier)
 *   3. Longer segments (tiebreaker)
 */
function getSortedValidSegments(
  segments: CoordinateSegment[],
  props: { x: number; y: number; width: number; height: number },
  splitLevel: number,
  corridorAxis?: 'x' | 'y',
): CoordinateSegment[] {
  if (!segments.length) {
    return [];
  }

  /** @todo combine splitSegment and validSegments - we can filter more efficiently */
  const splitSegments =
    splitLevel === 0 ? segments : segments.flatMap((s) => splitSegment(s, splitLevel));

  // Filter segments that are long enough to fit the text along the segment axis.
  const validSegments = splitSegments.filter((segment) => {
    const { dx, dy, varyingAxis } = getSegmentAxisSpans(segment);
    return (varyingAxis === 'x' ? dx : dy) >= (varyingAxis === 'x' ? props.width : props.height);
  });

  if (!validSegments.length) {
    return [];
  }

  // Find the middle segment index.
  const middleSegmentIndex = (splitSegments.length - 1) / 2;

  // Sort segments: primary-axis first, then by middle proximity, then by length.
  return validSegments.sort((a, b) => {
    // Tier 1: primary-axis segments before corridor-axis segments.
    if (corridorAxis) {
      const aIsPrimary = isPrimaryAxisSegment(a, corridorAxis);
      const bIsPrimary = isPrimaryAxisSegment(b, corridorAxis);
      if (aIsPrimary && !bIsPrimary) {
        return -1;
      }
      if (!aIsPrimary && bIsPrimary) {
        return 1;
      }
    }

    // Tier 2: closer to the middle index.
    const indexA = splitSegments.indexOf(a);
    const indexB = splitSegments.indexOf(b);
    const distanceA = Math.abs(indexA - middleSegmentIndex);
    const distanceB = Math.abs(indexB - middleSegmentIndex);

    if (distanceA !== distanceB) {
      return distanceA - distanceB;
    }

    // Longer segments preferred.
    const lengthA = Math.abs(a[0].x - a[1].x) + Math.abs(a[0].y - a[1].y);
    const lengthB = Math.abs(b[0].x - b[1].x) + Math.abs(b[0].y - b[1].y);
    return lengthB - lengthA;
  });
}

function splitSegment(segment: CoordinateSegment, splitLevel: number): CoordinateSegment[] {
  const splitSegments: CoordinateSegment[] = [];
  const { x: startX, y: startY } = segment[0];
  const { x: endX, y: endY } = segment[1];
  const segmentXLength = (endX - startX) / (splitLevel * splitLevel);
  const segmentYLength = (endY - startY) / (splitLevel * splitLevel);

  let start = segment[0];
  let end = segment[1];

  for (let i = 1; i <= splitLevel * splitLevel; i++) {
    // For splitLevel = 1, we want to split the segments into 2, for 2 we want to split into 4, etc.
    end = {
      x: startX + i * segmentXLength,
      y: startY + i * segmentYLength,
    };

    splitSegments.push([start, end]);
    start = end;
  }

  return splitSegments;
}

export function isExternalTextPlacement(entity: LayoutEntity | undefined): boolean {
  if (!entity?.textPlacement) {
    return false;
  }

  return (
    entity.textPlacement.relativeX < 0 ||
    entity.textPlacement.relativeX >= entity.width ||
    entity.textPlacement.relativeY < 0 ||
    entity.textPlacement.relativeY >= entity.height
  );
}

export function makeExternalTextRange(entity: LayoutEntity | undefined): LayoutRange | undefined {
  return isExternalTextPlacement(entity) ? makeRangeForEntityTextPlacement(entity)! : undefined;
}

/**
 * External entity text and its visual gap to the owning body form one blocker. Keeping
 * the body itself separate preserves body-relative ports while removing useless sliver
 * corridors between a caption and its node.
 */
export function touchExternalTextRangeToEntity(entity: LayoutEntity): PositionProps | undefined {
  const textRange = makeExternalTextRange(entity);
  if (!textRange) {
    return undefined;
  }

  const entityRange = makeRangeFromEntity(entity);

  const touchedRange = {
    minX: textRange.minX > entityRange.maxX ? entityRange.maxX : textRange.minX,
    minY: textRange.minY > entityRange.maxY ? entityRange.maxY : textRange.minY,
    maxX: textRange.maxX < entityRange.minX ? entityRange.minX : textRange.maxX,
    maxY: textRange.maxY < entityRange.minY ? entityRange.minY : textRange.maxY,
  };

  return makePropsFromRange(touchedRange);
}

/**
 * corridor obstacle view for a caption separated from one body face. Its outward depth,
 * including the visual gap, remains blocked while its cross-span is clipped to the
 * caption/body face overlap. Overlapping and diagonal external placements have no
 * unambiguous owning face, so they retain the conservative full blocker.
 */
export function touchExternalTextRangeToEntityClippedToBodyFace(
  entity: LayoutEntity,
): PositionProps | undefined {
  const textRange = makeExternalTextRange(entity);
  if (!textRange) {
    return undefined;
  }

  const entityRange = makeRangeFromEntity(entity);
  const overlapsHorizontalFace =
    Math.min(textRange.maxX, entityRange.maxX) > Math.max(textRange.minX, entityRange.minX);
  if (
    overlapsHorizontalFace &&
    (textRange.maxY <= entityRange.minY || textRange.minY >= entityRange.maxY)
  ) {
    return makePropsFromRange({
      minX: Math.max(textRange.minX, entityRange.minX),
      minY: textRange.maxY <= entityRange.minY ? textRange.minY : entityRange.maxY,
      maxX: Math.min(textRange.maxX, entityRange.maxX),
      maxY: textRange.maxY <= entityRange.minY ? entityRange.minY : textRange.maxY,
    });
  }

  const overlapsVerticalFace =
    Math.min(textRange.maxY, entityRange.maxY) > Math.max(textRange.minY, entityRange.minY);
  if (
    overlapsVerticalFace &&
    (textRange.maxX <= entityRange.minX || textRange.minX >= entityRange.maxX)
  ) {
    return makePropsFromRange({
      minX: textRange.maxX <= entityRange.minX ? textRange.minX : entityRange.maxX,
      minY: Math.max(textRange.minY, entityRange.minY),
      maxX: textRange.maxX <= entityRange.minX ? entityRange.minX : textRange.maxX,
      maxY: Math.min(textRange.maxY, entityRange.maxY),
    });
  }

  return touchExternalTextRangeToEntity(entity);
}
