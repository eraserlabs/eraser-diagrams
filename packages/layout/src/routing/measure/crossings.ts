import { LayoutTree } from '../../LayoutTree.js';
import type { Axis, Direction, LayoutEntity, XYPoint } from '../../types.js';
import { axisOf, EPS, type MeasuredLine, openBetween } from './geometry.js';

export interface CrossingHit {
  a: string;
  b: string;
  /** Segment index on a / b. */
  ax: number;
  bx: number;
  point: XYPoint;
}

export interface FaceChord {
  readonly from: XYPoint;
  readonly fromFace: Direction;
  readonly to: XYPoint;
  readonly toFace: Direction;
}

/** True when two endpoint-face chords form a proper, outward-facing X. */
export function faceChordsCross(left: FaceChord, right: FaceChord): boolean {
  const leftSideA = orientation(left.from, left.to, right.from);
  const leftSideB = orientation(left.from, left.to, right.to);
  const rightSideA = orientation(right.from, right.to, left.from);
  const rightSideB = orientation(right.from, right.to, left.to);
  if (leftSideA * leftSideB >= -EPS || rightSideA * rightSideB >= -EPS) {
    return false;
  }
  const intersection = segmentIntersection(left.from, left.to, right.from, right.to);
  return Boolean(
    intersection &&
    facePointsToward(left.from, left.fromFace, intersection) &&
    facePointsToward(left.to, left.toFace, intersection) &&
    facePointsToward(right.from, right.fromFace, intersection) &&
    facePointsToward(right.to, right.toFace, intersection),
  );
}

function orientation(from: XYPoint, to: XYPoint, point: XYPoint): number {
  return (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
}

function segmentIntersection(
  leftFrom: XYPoint,
  leftTo: XYPoint,
  rightFrom: XYPoint,
  rightTo: XYPoint,
): XYPoint | undefined {
  const leftX = leftTo.x - leftFrom.x;
  const leftY = leftTo.y - leftFrom.y;
  const rightX = rightTo.x - rightFrom.x;
  const rightY = rightTo.y - rightFrom.y;
  const denominator = leftX * rightY - leftY * rightX;
  if (Math.abs(denominator) <= EPS) {
    return undefined;
  }
  const offsetX = rightFrom.x - leftFrom.x;
  const offsetY = rightFrom.y - leftFrom.y;
  const leftTravel = (offsetX * rightY - offsetY * rightX) / denominator;
  return { x: leftFrom.x + leftTravel * leftX, y: leftFrom.y + leftTravel * leftY };
}

function facePointsToward(from: XYPoint, face: Direction, target: XYPoint): boolean {
  switch (face) {
    case 'left':
      return target.x < from.x - EPS;
    case 'right':
      return target.x > from.x + EPS;
    case 'up':
      return target.y < from.y - EPS;
    case 'down':
      return target.y > from.y + EPS;
  }
}

interface Segment {
  connId: string;
  idx: number;
  order: number;
  a: XYPoint;
  b: XYPoint;
}

interface IndexedSegment extends LayoutEntity, Segment {
  axis: Axis;
}

function segmentsForLines(lines: readonly MeasuredLine[]): Segment[] {
  const segments: Segment[] = [];
  for (const line of lines) {
    for (let idx = 0; idx < line.points.length - 1; idx++) {
      segments.push({
        connId: line.connId,
        idx,
        order: segments.length,
        a: line.points[idx],
        b: line.points[idx + 1],
      });
    }
  }
  return segments;
}

function crossingHit(
  s: Segment,
  axisS: Axis | undefined,
  t: Segment,
  axisT: Axis | undefined,
): CrossingHit | undefined {
  if (s.connId === t.connId || !axisS || !axisT || axisS === axisT) {
    return undefined;
  }
  const h = axisS === 'x' ? s : t;
  const v = axisS === 'y' ? s : t;
  if (!openBetween(v.a.x, h.a.x, h.b.x) || !openBetween(h.a.y, v.a.y, v.b.y)) {
    return undefined;
  }
  return {
    a: s.connId,
    b: t.connId,
    ax: s.idx,
    bx: t.idx,
    point: { x: v.a.x, y: h.a.y },
  };
}

function indexedSegments(lines: readonly MeasuredLine[]): IndexedSegment[] {
  return segmentsForLines(lines).flatMap((segment) => {
    const axis = axisOf(segment.a, segment.b);
    if (!axis) {
      return [];
    }
    return [
      {
        ...segment,
        id: `${segment.connId}:${segment.idx}`,
        axis,
        x: Math.min(segment.a.x, segment.b.x),
        y: Math.min(segment.a.y, segment.b.y),
        width: Math.abs(segment.b.x - segment.a.x),
        height: Math.abs(segment.b.y - segment.a.y),
      },
    ];
  });
}

/** R-tree detector. Candidate sorting keeps the hit order deterministic. */
export function crossingHits(lines: readonly MeasuredLine[]): CrossingHit[] {
  const segments = indexedSegments(lines);
  const tree = new LayoutTree<IndexedSegment>();
  tree.load(segments);

  const hits: CrossingHit[] = [];
  for (const s of segments) {
    const candidates: IndexedSegment[] = [];
    tree.forEachIntersectingBounds(s.x, s.y, s.x + s.width, s.y + s.height, (candidate) => {
      if (candidate.order > s.order) {
        candidates.push(candidate);
      }
    });
    candidates.sort((left, right) => left.order - right.order);
    for (const t of candidates) {
      const hit = crossingHit(s, s.axis, t, t.axis);
      if (hit) {
        hits.push(hit);
      }
    }
  }
  return hits;
}
