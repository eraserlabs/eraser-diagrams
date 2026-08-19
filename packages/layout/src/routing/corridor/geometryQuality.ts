import type { XYPoint } from '../../types.js';
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
import type { Route } from './route.js';
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
    events.push(...collectBacktrackEvents(route, routeIndex, points));
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

interface BacktrackSegment {
  readonly axis: 'x' | 'y';
  readonly lane: number;
  readonly travel: readonly [number, number];
  readonly direction: number;
  readonly segmentIndex: number;
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
  points: readonly XYPoint[],
): BacktrackQualityEvent[] {
  const segments: BacktrackSegment[] = [];
  for (let segmentIndex = 0; segmentIndex + 1 < points.length; segmentIndex += 1) {
    const from = points[segmentIndex];
    const to = points[segmentIndex + 1];
    if (from.y === to.y && from.x !== to.x) {
      segments.push({
        axis: 'x',
        lane: from.y,
        travel: [Math.min(from.x, to.x), Math.max(from.x, to.x)],
        direction: Math.sign(to.x - from.x),
        segmentIndex,
      });
    } else if (from.x === to.x && from.y !== to.y) {
      segments.push({
        axis: 'y',
        lane: from.x,
        travel: [Math.min(from.y, to.y), Math.max(from.y, to.y)],
        direction: Math.sign(to.y - from.y),
        segmentIndex,
      });
    }
  }
  const events: BacktrackQualityEvent[] = [];
  for (let first = 0; first < segments.length; first += 1) {
    for (let second = first + 1; second < segments.length; second += 1) {
      const a = segments[first];
      const b = segments[second];
      if (a.axis !== b.axis || a.direction === b.direction) {
        continue;
      }
      const overlap = Math.min(a.travel[1], b.travel[1]) - Math.max(a.travel[0], b.travel[0]);
      const separation = Math.abs(a.lane - b.lane);
      const cost = overlap > 0 ? backtrackCost(overlap, separation) : 0;
      if (cost <= 0) {
        continue;
      }
      const firstVisit = route.segmentVisitOf(a.segmentIndex);
      const secondVisit = route.segmentVisitOf(b.segmentIndex);
      const visits: RoutingQualityVisitRef[] = [{ routeIndex, visitIndex: firstVisit }];
      if (secondVisit !== firstVisit) {
        visits.push({ routeIndex, visitIndex: secondVisit });
      }
      const firstCorridor = route.visits[firstVisit].corridorIndex;
      const secondCorridor = route.visits[secondVisit].corridorIndex;
      events.push({
        kind: 'backtrack',
        cost,
        routeIndexes: [routeIndex],
        corridorIndexes:
          firstCorridor === secondCorridor
            ? [firstCorridor]
            : [Math.min(firstCorridor, secondCorridor), Math.max(firstCorridor, secondCorridor)],
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
