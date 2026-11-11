import { axisStart } from '../../rangeUtils.js';
import type { AxisSpan, XYPoint } from '../../types.js';
import {
  backtrackCost,
  ordinaryBendCost,
  ROUTING_QUALITY_COSTS,
  type BacktrackQualityEvent,
  type LineMergeQualityEvent,
  type RoutingQualityEvent,
  type RoutingQualityScalarCosts,
  type RoutingQualityVisitRef,
} from './qualityCost.js';
import { shareTerminalPortGroup, type Route } from './route.js';
import { RouteIndexer, type IndexedRouteSegment, type RouteCrossing } from './routeIndex.js';

export interface GeometryQualityResult {
  readonly events: readonly RoutingQualityEvent[];
  readonly scalarCosts: RoutingQualityScalarCosts;
  readonly scalarCostByRoute: ReadonlyMap<number, number>;
  /** Batch-owned spatial index reused by downstream repair adjudication. */
  readonly index: RouteIndexer;
  readonly crossings: readonly RouteCrossing[];
}

interface GeometryQualityOptions {
  /** Restrict emitted-merge discovery to pairs involving one of these routes. */
  readonly lineMergeRouteIndexes?: ReadonlySet<number>;
  /** Certified clean-clean emitted merges outside the current incremental scope. */
  readonly retainedLineMerges?: readonly LineMergeQualityEvent[];
}

/** Preserve only merge facts whose two routes remain structurally shared. */
export function retainedLineMergesForUnchangedRoutes(
  baseline: GeometryQualityResult,
  changedRouteIndexes: ReadonlySet<number>,
): LineMergeQualityEvent[] {
  return baseline.events.flatMap((event): LineMergeQualityEvent[] =>
    event.kind === 'line-merge' &&
    event.routeIndexes.every((routeIndex) => !changedRouteIndexes.has(routeIndex))
      ? [event as LineMergeQualityEvent]
      : [],
  );
}

/** Record emitted geometry costs at the first phase where they are exact. */
export function collectGeometryQualityEvents(
  routes: readonly Route[],
  existingEvents: readonly RoutingQualityEvent[] = [],
  batchIndex?: RouteIndexer,
  options: GeometryQualityOptions = {},
): GeometryQualityResult {
  const events: RoutingQualityEvent[] = [];
  const index = batchIndex ?? new RouteIndexer(routes);
  const crossings = index.properCrossings();
  const retainedLineMerges = options.retainedLineMerges ?? [];
  const discoveredLineMerges = emittedLineMerges(
    routes,
    index,
    [...existingEvents, ...retainedLineMerges],
    options.lineMergeRouteIndexes,
  );
  const lineMerges = [...retainedLineMerges, ...discoveredLineMerges].sort(compareLineMergeVisits);

  events.push(...lineMerges);

  for (const crossing of crossings) {
    const first = crossing.a.routeIndex < crossing.b.routeIndex ? crossing.a : crossing.b;
    const second = first === crossing.a ? crossing.b : crossing.a;
    const visits: RoutingQualityVisitRef[] = [visitRef(first), visitRef(second)];
    events.push({
      kind: 'crossing',
      cost: ROUTING_QUALITY_COSTS.crossing,
      routeIndexes: [first.routeIndex, second.routeIndex],
      corridorIndexes:
        first.corridorIndex === second.corridorIndex
          ? [first.corridorIndex]
          : [first.corridorIndex, second.corridorIndex],
      visits,
    });
  }

  let bendCost = 0;
  let pathLength = 0;
  const scalarCostByRoute = new Map<number, number>();
  routes.forEach((route, routeIndex) => {
    if (route.visits.length === 0) {
      return;
    }
    const points = route.points();
    const routeBends = countBends(points);
    const kinkSegmentIndex = findTinyKink(points);
    const routeLength = measurePath(points);
    bendCost += ordinaryBendCost(routeBends);
    pathLength += routeLength;
    scalarCostByRoute.set(
      routeIndex,
      ordinaryBendCost(routeBends) + routeLength * ROUTING_QUALITY_COSTS.pathPerPx,
    );
    if (kinkSegmentIndex !== undefined) {
      const visitIndex = route.segmentVisitOf(kinkSegmentIndex);
      events.push({
        kind: 'tiny-kink',
        cost: ROUTING_QUALITY_COSTS.tinyKink,
        routeIndexes: [routeIndex],
        corridorIndexes: [route.visits[visitIndex].corridorIndex],
        visits: [{ routeIndex, visitIndex }],
      });
    }
    events.push(...collectBacktrackEvents(route, routeIndex, index.segmentsForRoute(routeIndex)));
  });

  return {
    events,
    scalarCosts: {
      ordinaryBends: bendCost,
      pathLength: pathLength * ROUTING_QUALITY_COSTS.pathPerPx,
      spacingDesire: 0,
    },
    index,
    crossings,
    scalarCostByRoute,
  };
}

function emittedLineMerges(
  routes: readonly Route[],
  index: RouteIndexer,
  existingEvents: readonly RoutingQualityEvent[],
  routeIndexes?: ReadonlySet<number>,
): LineMergeQualityEvent[] {
  const events = new Map<
    string,
    { readonly event: LineMergeQualityEvent; readonly sharedTravelLength: number }
  >();
  const existingKeys = new Set<string>();
  for (const event of existingEvents) {
    if (event.kind === 'line-merge' && event.visits) {
      existingKeys.add(mergeVisitKey(event.visits));
    }
  }
  const visit = (segment: IndexedRouteSegment, candidate: IndexedRouteSegment): void => {
    if (
      shareTerminalPortGroup(
        routes[segment.routeIndex],
        segment.segmentIndex,
        routes[candidate.routeIndex],
        candidate.segmentIndex,
      )
    ) {
      return;
    }
    const first =
      segment.routeIndex < candidate.routeIndex ||
      (segment.routeIndex === candidate.routeIndex && segment.visitIndex <= candidate.visitIndex)
        ? segment
        : candidate;
    const second = first === segment ? candidate : segment;
    const key = mergeVisitPairKey(first, second);
    if (existingKeys.has(key)) {
      return;
    }
    const travelStart = Math.max(first.travel[0], second.travel[0]);
    const travelEnd = Math.min(first.travel[1], second.travel[1]);
    const sharedTravelLength = travelEnd - travelStart;
    const previous = events.get(key);
    if (previous && previous.sharedTravelLength >= sharedTravelLength) {
      return;
    }
    const visits: RoutingQualityVisitRef[] = [visitRef(first), visitRef(second)];
    const corridorIndexes =
      first.corridorIndex === second.corridorIndex
        ? [first.corridorIndex]
        : [first.corridorIndex, second.corridorIndex];
    events.set(key, {
      sharedTravelLength,
      event: {
        kind: 'line-merge',
        cost: ROUTING_QUALITY_COSTS.lineMerge,
        routeIndexes: [first.routeIndex, second.routeIndex],
        corridorIndexes,
        visits,
      },
    });
  };
  if (routeIndexes) {
    index.forEachParallelOverlapForRoutes(1, routeIndexes, visit);
  } else {
    index.forEachParallelOverlap(1, visit);
  }
  return [...events.values()].map(({ event }) => event).sort(compareLineMergeVisits);
}

function compareLineMergeVisits(left: LineMergeQualityEvent, right: LineMergeQualityEvent): number {
  return (
    left.visits[0].routeIndex - right.visits[0].routeIndex ||
    left.visits[0].visitIndex - right.visits[0].visitIndex ||
    left.visits[1].routeIndex - right.visits[1].routeIndex ||
    left.visits[1].visitIndex - right.visits[1].visitIndex
  );
}

function visitRef(segment: IndexedRouteSegment): RoutingQualityVisitRef {
  return {
    routeIndex: segment.routeIndex,
    visitIndex: segment.visitIndex,
  };
}

function mergeVisitPairKey(first: IndexedRouteSegment, second: IndexedRouteSegment): string {
  const firstKey = `${first.routeIndex}:${first.visitIndex}`;
  const secondKey = `${second.routeIndex}:${second.visitIndex}`;
  return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
}

function mergeVisitKey(visits: readonly RoutingQualityVisitRef[]): string {
  return visits
    .map((visit) => `${visit.routeIndex}:${visit.visitIndex}`)
    .sort()
    .join('|');
}

interface BacktrackRun {
  readonly axis: 'x' | 'y';
  readonly lane: number;
  travel: AxisSpan;
  readonly direction: number;
  readonly segments: IndexedRouteSegment[];
}

/**
 * Pairs of anti-parallel same-axis legs of one route that double back over
 * shared travel. Priced by backtrackCost: thin, long doublings are charged so
 * repair cannot buy stub cosmetics with a U-return; wide or short loops are
 * free because they do not create the same cramped doubling.
 */
function collectBacktrackEvents(
  route: Route,
  routeIndex: number,
  segments: readonly IndexedRouteSegment[],
): BacktrackQualityEvent[] {
  const runs: BacktrackRun[] = [];
  for (const segment of segments) {
    const direction = Math.sign(
      axisStart(segment.to, segment.axis) - axisStart(segment.from, segment.axis),
    );
    const previous = runs[runs.length - 1];
    // Emission retains corridor visit boundaries; they must not each earn a fresh overlap floor.
    if (
      previous &&
      previous.axis === segment.axis &&
      previous.lane === segment.track &&
      previous.direction === direction &&
      previous.segments[previous.segments.length - 1].segmentIndex + 1 === segment.segmentIndex
    ) {
      previous.travel = [
        Math.min(previous.travel[0], segment.travel[0]),
        Math.max(previous.travel[1], segment.travel[1]),
      ];
      previous.segments.push(segment);
    } else {
      runs.push({
        axis: segment.axis,
        lane: segment.track,
        travel: segment.travel,
        direction,
        segments: [segment],
      });
    }
  }
  const events: BacktrackQualityEvent[] = [];
  for (let first = 0; first < runs.length; first += 1) {
    for (let second = first + 1; second < runs.length; second += 1) {
      const a = runs[first];
      const b = runs[second];
      if (a.axis !== b.axis || a.direction === b.direction) {
        continue;
      }
      const overlapStart = Math.max(a.travel[0], b.travel[0]);
      const overlapEnd = Math.min(a.travel[1], b.travel[1]);
      const overlap = overlapEnd - overlapStart;
      const separation = Math.abs(a.lane - b.lane);
      const cost = overlap > 0 ? backtrackCost(overlap, separation) : 0;
      if (cost <= 0) {
        continue;
      }
      const visitIndexes = new Set(
        [...a.segments, ...b.segments]
          .filter((segment) => segment.travel[0] < overlapEnd && segment.travel[1] > overlapStart)
          .map((segment) => segment.visitIndex),
      );
      const visits = [...visitIndexes].map((visitIndex) => ({ routeIndex, visitIndex }));
      events.push({
        kind: 'backtrack',
        cost,
        routeIndexes: [routeIndex],
        corridorIndexes: [
          ...new Set(visits.map(({ visitIndex }) => route.visits[visitIndex].corridorIndex)),
        ].sort((left, right) => left - right),
        visits,
      });
    }
  }
  return events;
}

function findTinyKink(points: readonly XYPoint[]): number | undefined {
  for (let pointIndex = 1; pointIndex < points.length - 2; pointIndex += 1) {
    const length =
      Math.abs(points[pointIndex + 1].x - points[pointIndex].x) +
      Math.abs(points[pointIndex + 1].y - points[pointIndex].y);
    const beforeHorizontal = points[pointIndex - 1].y === points[pointIndex].y;
    const segmentHorizontal = points[pointIndex].y === points[pointIndex + 1].y;
    const afterHorizontal = points[pointIndex + 1].y === points[pointIndex + 2].y;
    if (
      length < 16 &&
      beforeHorizontal !== segmentHorizontal &&
      segmentHorizontal !== afterHorizontal
    ) {
      return pointIndex;
    }
  }
  return undefined;
}

function countBends(points: readonly XYPoint[]): number {
  let count = 0;
  for (let pointIndex = 1; pointIndex + 1 < points.length; pointIndex += 1) {
    const beforeHorizontal = points[pointIndex - 1].y === points[pointIndex].y;
    const afterHorizontal = points[pointIndex].y === points[pointIndex + 1].y;
    if (beforeHorizontal !== afterHorizontal) {
      count += 1;
    }
  }
  return count;
}

function measurePath(points: readonly XYPoint[]): number {
  let length = 0;
  for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
    length +=
      Math.abs(points[pointIndex].x - points[pointIndex - 1].x) +
      Math.abs(points[pointIndex].y - points[pointIndex - 1].y);
  }
  return length;
}
