/**
 * Routing geometry measurement — internal geometric representation + pure helpers.
 *
 * `MeasuredLine` is the measurement module's geometric truth: an absolute, deduped,
 * orthogonal polyline with resolved port faces and an optional label rect. Every
 * axis is a pure function of `MeasuredLine[]` and optional reference geometry.
 */

import type { Direction, PositionProps, XYPoint } from '../../types.js';

export interface MeasuredLine {
  connId: string;
  from: string;
  to: string;
  points: XYPoint[];
  fromFace?: Direction;
  toFace?: Direction;
  labelRect?: PositionProps;
}

export const EPS = 0.01;

/** Normalized [lo, hi] copy of a possibly-reversed span. */
export function normalizeSpan(span: readonly [number, number]): [number, number] {
  return [Math.min(span[0], span[1]), Math.max(span[0], span[1])];
}

export function overlapLength(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

/** Requires overlap strictly greater than epsilon; endpoint contact is not overlap. */
export function spansOverlap(
  a: readonly [number, number],
  b: readonly [number, number],
  epsilon = EPS,
): boolean {
  return overlapLength(a, b) > epsilon;
}

export function axisOf(a: XYPoint, b: XYPoint): 'x' | 'y' | undefined {
  if (Math.abs(a.y - b.y) <= EPS) {
    return 'x';
  }
  if (Math.abs(a.x - b.x) <= EPS) {
    return 'y';
  }
  return undefined;
}

export function dedupe(points: XYPoint[]): XYPoint[] {
  const out: XYPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.x - p.x) > EPS || Math.abs(prev.y - p.y) > EPS) {
      out.push(p);
    }
  }
  return out;
}

export function bendPoints(points: XYPoint[]): XYPoint[] {
  const result: XYPoint[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const before = axisOf(points[i - 1], points[i]);
    const after = axisOf(points[i], points[i + 1]);
    if (before && after && before !== after) {
      result.push(points[i]);
    }
  }
  return result;
}

export function manhattan(a: XYPoint, b: XYPoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function pathLength(points: XYPoint[]): number {
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    len += manhattan(points[i], points[i + 1]);
  }
  return len;
}

export function detourRatio(points: XYPoint[]): number {
  const direct = manhattan(points[0], points[points.length - 1]);
  if (direct <= EPS) {
    return 1;
  }
  return pathLength(points) / direct;
}

export function openBetween(v: number, a: number, b: number): boolean {
  return v > Math.min(a, b) + EPS && v < Math.max(a, b) - EPS;
}

export function segmentPiercesRect(a: XYPoint, b: XYPoint, rect: PositionProps): boolean {
  const axis = axisOf(a, b);
  if (axis === 'x') {
    const y = a.y;
    if (y <= rect.y + EPS || y >= rect.y + rect.height - EPS) {
      return false;
    }
    return Math.min(a.x, b.x) < rect.x + rect.width - EPS && Math.max(a.x, b.x) > rect.x + EPS;
  }
  if (axis === 'y') {
    const x = a.x;
    if (x <= rect.x + EPS || x >= rect.x + rect.width - EPS) {
      return false;
    }
    return Math.min(a.y, b.y) < rect.y + rect.height - EPS && Math.max(a.y, b.y) > rect.y + EPS;
  }
  return false;
}

export function linePiercesRect(line: MeasuredLine, rect: PositionProps): boolean {
  for (let i = 0; i < line.points.length - 1; i++) {
    if (segmentPiercesRect(line.points[i], line.points[i + 1], rect)) {
      return true;
    }
  }
  return false;
}

/**
 * Which face of the rect an attach point sits on. Only trustworthy when the
 * point actually touches an edge (within tolerance): production snapshots can
 * attach inside icon insets off every edge, where inferring a face gives false
 * parallel-face positives, so those endpoints return undefined and are skipped
 * by face-based axes. Generated lines carry real port faces.
 */
export const ATTACH_FACE_TOLERANCE_PX = 3;
export function attachFace(point: XYPoint, rect: PositionProps): Direction | undefined {
  const candidates: Array<[Direction, number]> = [
    ['left', Math.abs(point.x - rect.x)],
    ['right', Math.abs(point.x - (rect.x + rect.width))],
    ['up', Math.abs(point.y - rect.y)],
    ['down', Math.abs(point.y - (rect.y + rect.height))],
  ];
  candidates.sort((a, b) => a[1] - b[1]);
  return candidates[0][1] <= ATTACH_FACE_TOLERANCE_PX ? candidates[0][0] : undefined;
}

/** The t-position (fraction along the dominant travel axis) of each bend. */
export function bendTs(line: MeasuredLine): number[] | undefined {
  const start = line.points[0];
  const end = line.points[line.points.length - 1];
  const travel: 'x' | 'y' = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y) ? 'x' : 'y';
  const extent = end[travel] - start[travel];
  if (Math.abs(extent) <= EPS) {
    return undefined;
  }
  return bendPoints(line.points).map((b) => (b[travel] - start[travel]) / extent);
}
