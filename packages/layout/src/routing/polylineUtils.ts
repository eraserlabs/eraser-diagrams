import type { Point } from './types.js';

type LineSegment2D = readonly [Readonly<Point>, Readonly<Point>];

export function distanceToLineSegment(point: Readonly<Point>, line: LineSegment2D): number {
  const [pointX, pointY] = point;
  const [[startX, startY], [endX, endY]] = line;
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  const projection =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(
            0,
            ((pointX - startX) * segmentX + (pointY - startY) * segmentY) / lengthSquared,
          ),
        );
  const deltaX = pointX - (startX + projection * segmentX);
  const deltaY = pointY - (startY + projection * segmentY);
  return Math.hypot(deltaX, deltaY);
}

/** Arc-length midpoint using the existing layout origin convention. */
export function getLineMidPoint(points: readonly Readonly<Point>[]): Readonly<Point> {
  if (points.length < 2) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`Unable to calculate line mid point. Points.length = ${points.length}`);
    }
    return points[0] ?? [0, 0];
  }

  let total = 0;
  const lengths = points.map((point, index) => {
    const previous = index === 0 ? ([0, 0] as const) : points[index - 1];
    const length = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    total += length;
    return length;
  });

  const halfwayDistance = total / 2;
  let halfwayIndex = 0;
  let distance = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    distance += lengths[index];
    if (distance > halfwayDistance) {
      halfwayIndex = index;
      break;
    }
  }

  let before = points[halfwayIndex - 1];
  let after = points[halfwayIndex];
  if (!before || !after) {
    before = points[0];
    after = points[1];
  }
  return [(before[0] + after[0]) / 2, (before[1] + after[1]) / 2];
}

export function polylineLength(points: readonly Readonly<Point>[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1],
    );
  }
  return total;
}

export function projectedHalfExtent(
  tangent: Readonly<Point>,
  width: number,
  height: number,
): number {
  return (Math.abs(tangent[0]) * width) / 2 + (Math.abs(tangent[1]) * height) / 2;
}

export function effectiveLabelPerpOffset(
  lineOffset: number,
  perpendicularHalfExtent: number,
  gap: number,
): number {
  if (lineOffset === 0) {
    return 0;
  }
  return Math.sign(lineOffset) * Math.max(Math.abs(lineOffset), perpendicularHalfExtent + gap);
}

interface PointOnPolyline {
  readonly point: Readonly<Point>;
  readonly tangent: Readonly<Point>;
}

export function pointAtArcLengthFraction(
  points: readonly Readonly<Point>[],
  fraction: number,
): PointOnPolyline {
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  if (points.length < 2) {
    return { point: points[0] ?? [0, 0], tangent: [0, 0] };
  }

  const segmentLengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1],
    );
    segmentLengths.push(length);
    total += length;
  }

  if (total === 0) {
    return { point: points[0], tangent: [0, 0] };
  }

  const target = clampedFraction * total;
  let distance = 0;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const length = segmentLengths[index];
    if (distance + length >= target || index === segmentLengths.length - 1) {
      const start = points[index];
      const end = points[index + 1];
      const ratio = length === 0 ? 0 : (target - distance) / length;
      return {
        point: [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio],
        tangent:
          length === 0 ? [0, 0] : [(end[0] - start[0]) / length, (end[1] - start[1]) / length],
      };
    }
    distance += length;
  }

  const lastIndex = points.length - 1;
  const start = points[lastIndex - 1];
  const end = points[lastIndex];
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  return {
    point: end,
    tangent: length === 0 ? [0, 0] : [(end[0] - start[0]) / length, (end[1] - start[1]) / length],
  };
}

export function projectPointOntoPolyline(
  point: Readonly<Point>,
  points: readonly Readonly<Point>[],
): {
  closest: Readonly<Point>;
  fraction: number;
  perp: number;
  tangent: Readonly<Point>;
} {
  const zero: Point = [0, 0];
  if (points.length < 2) {
    return { closest: points[0] ?? zero, fraction: 0, perp: 0, tangent: zero };
  }

  const segmentLengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1],
    );
    segmentLengths.push(length);
    total += length;
  }

  let bestDistanceSquared = Infinity;
  let bestClosest = points[0];
  let bestFraction = 0;
  let bestPerpendicular = 0;
  let bestTangent = zero;
  let cumulative = 0;

  for (let index = 0; index < segmentLengths.length; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const length = segmentLengths[index];
    const deltaX = end[0] - start[0];
    const deltaY = end[1] - start[1];
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const ratio =
      lengthSquared === 0
        ? 0
        : Math.min(
            1,
            Math.max(
              0,
              ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaY) / lengthSquared,
            ),
          );
    const closestX = start[0] + deltaX * ratio;
    const closestY = start[1] + deltaY * ratio;
    const distanceSquared = (point[0] - closestX) ** 2 + (point[1] - closestY) ** 2;

    if (distanceSquared < bestDistanceSquared) {
      const tangent: Point = length === 0 ? zero : [deltaX / length, deltaY / length];
      bestDistanceSquared = distanceSquared;
      bestClosest = [closestX, closestY];
      bestFraction = total === 0 ? 0 : (cumulative + length * ratio) / total;
      bestPerpendicular = (point[0] - closestX) * -tangent[1] + (point[1] - closestY) * tangent[0];
      bestTangent = tangent;
    }
    cumulative += length;
  }

  return {
    closest: bestClosest,
    fraction: bestFraction,
    perp: bestPerpendicular,
    tangent: bestTangent,
  };
}

/** Remove duplicate vertices and collapse axis-aligned collinear runs. */
export function simplifyCollinearPoints(points: Point[], epsilon?: number): Point[];
export function simplifyCollinearPoints(
  points: readonly Readonly<Point>[],
  epsilon?: number,
): readonly Readonly<Point>[];
export function simplifyCollinearPoints(
  points: readonly Readonly<Point>[],
  epsilon = 0,
): readonly Readonly<Point>[] {
  if (points.length < 3) {
    return points;
  }

  const result: Readonly<Point>[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = result[result.length - 1];
    const current = points[index];
    if (
      Math.abs(current[0] - previous[0]) <= epsilon &&
      Math.abs(current[1] - previous[1]) <= epsilon
    ) {
      continue;
    }

    if (result.length >= 2) {
      const beforePrevious = result[result.length - 2];
      const vertical =
        Math.abs(current[0] - previous[0]) <= epsilon &&
        Math.abs(previous[0] - beforePrevious[0]) <= epsilon;
      const horizontal =
        Math.abs(current[1] - previous[1]) <= epsilon &&
        Math.abs(previous[1] - beforePrevious[1]) <= epsilon;
      if (vertical || horizontal) {
        result[result.length - 1] = current;
        continue;
      }
    }

    result.push(current);
  }
  return result;
}
