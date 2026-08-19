import { RTree } from '../../rtree/RTree.js';
import type { Axis, AxisSpan, PositionProps, XYPoint } from '../../types.js';
import { samePoint } from './geometry.js';
import type { Route } from './route.js';

const PROPER_CROSSING_EPSILON = 0.01;

/** One canonical route segment, with geometry and ownership stored in the spatial index. */
export interface IndexedRouteSegment extends PositionProps {
  readonly index: number;
  readonly routeIndex: number;
  readonly segmentIndex: number;
  readonly visitIndex: number;
  readonly corridorIndex: number;
  readonly axis: Axis;
  readonly from: XYPoint;
  readonly to: XYPoint;
  readonly travel: AxisSpan;
  readonly track: number;
}

export interface RouteCrossing {
  readonly a: IndexedRouteSegment;
  readonly b: IndexedRouteSegment;
}

/**
 * Query-only spatial index over one emitted route batch.
 *
 * Construction is explicit and bulk-loaded so the ordinary route pipeline pays no index cost.
 */
export class RouteIndexer {
  private readonly segments: readonly IndexedRouteSegment[];
  private readonly treesByAxis: Readonly<Record<Axis, RTree<IndexedRouteSegment>>>;
  private readonly segmentsByAxis: Readonly<Record<Axis, readonly IndexedRouteSegment[]>>;
  private readonly segmentsByRoute: readonly (readonly IndexedRouteSegment[])[];
  private readonly segmentsByCorridor: readonly (readonly IndexedRouteSegment[])[];

  constructor(routes: readonly Route[]) {
    const segments: IndexedRouteSegment[] = [];
    const segmentsByAxis: Record<Axis, IndexedRouteSegment[]> = { x: [], y: [] };
    const segmentsByRoute: IndexedRouteSegment[][] = routes.map(() => []);
    const segmentsByCorridor: IndexedRouteSegment[][] = [];

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
      const route = routes[routeIndex];
      if (route.visits.length === 0) {
        continue;
      }
      route.assertEmitted();
      const points = route.points();
      for (let segmentIndex = 0; segmentIndex + 1 < points.length; segmentIndex += 1) {
        const from = points[segmentIndex];
        const to = points[segmentIndex + 1];
        const axis = from.x === to.x ? 'y' : 'x';
        const visitIndex = route.segmentVisitOf(segmentIndex);
        const corridorIndex = route.visits[visitIndex].corridorIndex;
        const segment: IndexedRouteSegment = {
          index: segments.length,
          routeIndex,
          segmentIndex,
          visitIndex,
          corridorIndex,
          axis,
          from,
          to,
          travel:
            axis === 'x'
              ? [Math.min(from.x, to.x), Math.max(from.x, to.x)]
              : [Math.min(from.y, to.y), Math.max(from.y, to.y)],
          track: axis === 'x' ? from.y : from.x,
          x: Math.min(from.x, to.x),
          y: Math.min(from.y, to.y),
          width: Math.abs(to.x - from.x),
          height: Math.abs(to.y - from.y),
        };
        segments.push(segment);
        segmentsByAxis[axis].push(segment);
        segmentsByRoute[routeIndex].push(segment);
        const corridorSegments = segmentsByCorridor[corridorIndex];
        if (corridorSegments) {
          corridorSegments.push(segment);
        } else {
          segmentsByCorridor[corridorIndex] = [segment];
        }
      }
    }

    this.segments = segments;
    this.treesByAxis = {
      x: new RTree<IndexedRouteSegment>().load(segmentsByAxis.x),
      y: new RTree<IndexedRouteSegment>().load(segmentsByAxis.y),
    };
    this.segmentsByAxis = segmentsByAxis;
    this.segmentsByRoute = segmentsByRoute;
    this.segmentsByCorridor = segmentsByCorridor;
  }

  segmentsForRoute(routeIndex: number): readonly IndexedRouteSegment[] {
    return this.segmentsByRoute[routeIndex] ?? [];
  }

  segmentsForCorridor(corridorIndex: number): readonly IndexedRouteSegment[] {
    return this.segmentsByCorridor[corridorIndex] ?? [];
  }

  segmentsInRect(rect: PositionProps): readonly IndexedRouteSegment[] {
    return this.unsortedSegmentsInRect(rect).sort(compareSegmentIndex);
  }

  /** Spatial-query order for callers whose result is reduced into an order-independent set/count. */
  unsortedSegmentsInRect(rect: PositionProps): IndexedRouteSegment[] {
    const segments: IndexedRouteSegment[] = [];
    const maxX = rect.x + rect.width;
    const maxY = rect.y + rect.height;
    this.treesByAxis.x.forEachIntersectingBounds(rect.x, rect.y, maxX, maxY, (segment) => {
      segments.push(segment);
    });
    this.treesByAxis.y.forEachIntersectingBounds(rect.x, rect.y, maxX, maxY, (segment) => {
      segments.push(segment);
    });
    return segments;
  }

  properCrossings(): readonly RouteCrossing[] {
    const crossings: RouteCrossing[] = [];
    for (const horizontal of this.segmentsByAxis.x) {
      this.treesByAxis.y.forEachAtY(
        horizontal.track,
        horizontal.travel[0],
        horizontal.travel[1],
        (vertical) => {
          const first = horizontal.index < vertical.index ? horizontal : vertical;
          const second = first === horizontal ? vertical : horizontal;
          const crossing = properCrossing(first, second, this.segmentsByRoute);
          if (crossing) {
            crossings.push(crossing);
          }
        },
      );
    }
    return crossings.sort(
      (left, right) => left.a.index - right.a.index || left.b.index - right.b.index,
    );
  }

  forEachParallelOverlap(
    maximumTrackGap: number,
    visitor: (segment: IndexedRouteSegment, candidate: IndexedRouteSegment) => void,
  ): void {
    this.forEachParallelOverlapAmong(this.segments, maximumTrackGap, undefined, visitor);
  }

  /** Visit each overlap involving at least one of the supplied routes. */
  forEachParallelOverlapForRoutes(
    maximumTrackGap: number,
    routeIndexes: ReadonlySet<number>,
    visitor: (segment: IndexedRouteSegment, candidate: IndexedRouteSegment) => void,
  ): void {
    for (const routeIndex of routeIndexes) {
      this.forEachParallelOverlapAmong(
        this.segmentsByRoute[routeIndex] ?? [],
        maximumTrackGap,
        routeIndexes,
        visitor,
      );
    }
  }

  private forEachParallelOverlapAmong(
    segments: readonly IndexedRouteSegment[],
    maximumTrackGap: number,
    selectedRouteIndexes: ReadonlySet<number> | undefined,
    visitor: (segment: IndexedRouteSegment, candidate: IndexedRouteSegment) => void,
  ): void {
    for (const segment of segments) {
      const minX = segment.axis === 'x' ? segment.travel[0] : segment.track - maximumTrackGap;
      const minY = segment.axis === 'x' ? segment.track - maximumTrackGap : segment.travel[0];
      const maxX = segment.axis === 'x' ? segment.travel[1] : segment.track + maximumTrackGap;
      const maxY = segment.axis === 'x' ? segment.track + maximumTrackGap : segment.travel[1];
      this.treesByAxis[segment.axis].forEachIntersectingBounds(
        minX,
        minY,
        maxX,
        maxY,
        (candidate) => {
          if (
            candidate.routeIndex === segment.routeIndex ||
            (selectedRouteIndexes?.has(candidate.routeIndex) !== false &&
              candidate.index <= segment.index)
          ) {
            return;
          }
          const travelStart = Math.max(segment.travel[0], candidate.travel[0]);
          const travelEnd = Math.min(segment.travel[1], candidate.travel[1]);
          if (travelEnd - travelStart > PROPER_CROSSING_EPSILON) {
            visitor(segment, candidate);
          }
        },
      );
    }
  }
}

function compareSegmentIndex(left: IndexedRouteSegment, right: IndexedRouteSegment): number {
  return left.index - right.index;
}

function properCrossing(
  left: IndexedRouteSegment,
  right: IndexedRouteSegment,
  segmentsByRoute: readonly (readonly IndexedRouteSegment[])[],
): RouteCrossing | undefined {
  if (left.routeIndex === right.routeIndex || left.axis === right.axis) {
    return undefined;
  }
  const horizontal = left.axis === 'x' ? left : right;
  const vertical = left.axis === 'y' ? left : right;
  if (
    !insideVisualRun(vertical.track, horizontal, segmentsByRoute) ||
    !insideVisualRun(horizontal.track, vertical, segmentsByRoute)
  ) {
    return undefined;
  }
  return { a: left, b: right };
}

function insideVisualRun(
  value: number,
  segment: IndexedRouteSegment,
  segmentsByRoute: readonly (readonly IndexedRouteSegment[])[],
): boolean {
  if (openBetween(value, segment.travel)) {
    return true;
  }
  const endpoint = segment.axis === 'x' ? segment.to.x : segment.to.y;
  if (Math.abs(value - endpoint) > PROPER_CROSSING_EPSILON) {
    return false;
  }
  const next = segmentsByRoute[segment.routeIndex]?.[segment.segmentIndex + 1];
  return Boolean(
    next &&
    next.axis === segment.axis &&
    Math.abs(next.track - segment.track) <= PROPER_CROSSING_EPSILON &&
    samePoint(next.from, segment.to) &&
    direction(next) === direction(segment),
  );
}

function direction(segment: IndexedRouteSegment): -1 | 1 {
  const delta =
    segment.axis === 'x' ? segment.to.x - segment.from.x : segment.to.y - segment.from.y;
  return delta < 0 ? -1 : 1;
}

function openBetween(value: number, span: AxisSpan): boolean {
  return value > span[0] + PROPER_CROSSING_EPSILON && value < span[1] - PROPER_CROSSING_EPSILON;
}
