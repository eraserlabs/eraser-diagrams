import { LayoutTree } from '../../LayoutTree.js';
import {
  axisOrthMin,
  axisStart,
  clampToSpan,
  coordinateInSpan,
  midpoint,
  spanLength,
  spanOverlapLength,
} from '../../rangeUtils.js';
import type { Axis, AxisSpan, PositionProps, XYPoint } from '../../types.js';
import {
  axisPoint,
  centeredRect,
  compareNumber,
  corridorTravelSpan,
  expandRect,
  inside,
  orderedSpan,
  rectCrossesBoundary,
  rectsOverlap,
  ROUTING_EPSILON as EPSILON,
  segmentAxis,
  segmentPiercesRect,
} from './geometry.js';
import type { Route } from './route.js';
import { realizeRunDisplacement, type RunDisplacement } from './runDisplacement.js';
import {
  LABEL_JOG_MARGIN_PX,
  LABEL_LINE_CLEARANCE_PX,
  type LabelSize,
  type LabelSpec,
} from './text.js';
import { clearTravelSpans, TERMINAL_LABEL_GAP_PX } from './travelSpans.js';
import type { CorridorWorld } from './world.js';

const TARGET_ARROWHEAD_MARGIN_PX = 12;
const BEND_MARGIN_PX = LABEL_LINE_CLEARANCE_PX;
const ALIGNMENT_TOLERANCE_PX = 12;
const WIDE_U_END_MARGIN_PX = 24;

type CandidateOrigin =
  'alignment' | 'gap-center' | 'corridor-center' | 'segment-center' | 'clear-space';

const ORIGIN_COST: Readonly<Record<CandidateOrigin, number>> = {
  alignment: -14,
  'gap-center': -12,
  'corridor-center': -5,
  'segment-center': -5,
  'clear-space': 0,
};

/** The only intermediate label model: one concrete rectangle on one emitted segment. */
interface PlacementCandidate {
  readonly routeIndex: number;
  readonly sourceSegmentIndex: number;
  /** Changes after a displacement inserts points into the route. */
  readonly segmentIndex: number;
  readonly axis: Axis;
  readonly travel: number;
  readonly track: number;
  readonly legalTravel: AxisSpan;
  readonly rect: PositionProps;
  readonly origin: CandidateOrigin;
  readonly slack: number;
  readonly clearSpanLength: number;
  readonly midpointDistance: number;
  readonly alignmentSupport: number;
  readonly points?: readonly XYPoint[];
  readonly displacement?: RunDisplacement;
}

interface CandidateDefects {
  readonly occupiedOverlapCount: number;
  readonly entityCollisionCount: number;
  readonly lineCollisionCount: number;
}

interface IndexedTextSegment extends PositionProps {
  readonly routeIndex: number;
  readonly segmentIndex: number;
  readonly from: XYPoint;
  readonly to: XYPoint;
}

class TextRouteSegmentIndex {
  private readonly tree = new LayoutTree<IndexedTextSegment>();

  constructor(pointsByRoute: readonly (readonly XYPoint[])[]) {
    const segments: IndexedTextSegment[] = [];
    for (let routeIndex = 0; routeIndex < pointsByRoute.length; routeIndex += 1) {
      const points = pointsByRoute[routeIndex];
      for (let segmentIndex = 0; segmentIndex + 1 < points.length; segmentIndex += 1) {
        const from = points[segmentIndex];
        const to = points[segmentIndex + 1];
        segments.push({
          routeIndex,
          segmentIndex,
          from,
          to,
          x: Math.min(from.x, to.x),
          y: Math.min(from.y, to.y),
          width: Math.abs(to.x - from.x),
          height: Math.abs(to.y - from.y),
        });
      }
    }
    this.tree.load(segments);
  }

  segmentsInRect(rect: PositionProps, excludedRouteIndex?: number): readonly IndexedTextSegment[] {
    const segments: IndexedTextSegment[] = [];
    this.tree.forEachIntersectingBounds(
      rect.x,
      rect.y,
      rect.x + rect.width,
      rect.y + rect.height,
      (segment) => {
        if (segment.routeIndex !== excludedRouteIndex) {
          segments.push(segment);
        }
      },
    );
    return segments;
  }
}

interface OnLineLabelHost {
  readonly kind: 'segment';
  readonly segmentIndex: number;
  readonly displacement?: RunDisplacement;
}

interface OfflineLabelHost {
  readonly kind: 'offline';
  readonly anchor: XYPoint;
  /** Every exact-distance side overlaps something or leaves the routing world. */
  readonly forced?: true;
}

interface LabelPlacementBase {
  readonly routeIndex: number;
  readonly rect: PositionProps;
}

export type RealizedLabelPlacement = LabelPlacementBase &
  (
    | { readonly host: OnLineLabelHost; readonly tier: 'on-line' }
    | { readonly host: OfflineLabelHost; readonly tier: 'offline' }
  );

/** Complete label-owned output. Every input spec has one placement keyed by routeIndex. */
export interface LabelPlacementResult {
  readonly placements: readonly RealizedLabelPlacement[];
  /** Complete final geometry in route-index order; this supersedes the input Route geometry. */
  readonly routePoints: readonly (readonly XYPoint[])[];
}

/** Generate all hosts, add alignment variants, select winners, then realize required jogs. */
export function placeLabels(
  world: CorridorWorld,
  routes: readonly Route[],
  specs: readonly LabelSpec[],
): LabelPlacementResult {
  for (const route of routes) {
    route.assertEmitted();
  }
  const sizes = labelSizes(routes.length, specs);
  const routePoints = routes.map((route) => route.points());
  let segmentIndex = new TextRouteSegmentIndex(routePoints);
  const candidatesByRoute = new Map<number, PlacementCandidate[]>();
  const placements: RealizedLabelPlacement[] = [];
  const occupied: PositionProps[] = [];
  const offlineRouteIndexes = new Set<number>();

  // First pass - create the candidates for each route
  for (const [routeIndex, size] of sizes) {
    const candidates = placementCandidates(
      world,
      routes[routeIndex],
      routePoints[routeIndex],
      segmentIndex,
      routeIndex,
      size,
    );
    candidatesByRoute.set(routeIndex, candidates);
  }

  // A label with no fitting segment cannot participate in alignment or displacement.
  for (const [routeIndex] of sizes) {
    const candidates = candidatesByRoute.get(routeIndex) ?? [];
    if (candidates.some(({ slack }) => slack >= 0)) {
      continue;
    }
    const fallback = candidates[0];
    if (!fallback) {
      throw new Error(`label placement: route ${routes[routeIndex].requestIndex} has no segment`);
    }
    const placement = offlinePlacement(
      world,
      routePoints[routeIndex],
      segmentIndex,
      occupied,
      fallback,
    );
    placements.push(placement);
    occupied.push(placement.rect);
    offlineRouteIndexes.add(routeIndex);
  }

  addAlignmentCandidates(world, routePoints, segmentIndex, occupied, candidatesByRoute);

  const coordinated = resolveCandidateConflicts(world, candidatesByRoute, routePoints, occupied);
  for (const [routeIndex, points] of coordinated.points) {
    routePoints[routeIndex] = points;
  }
  placements.push(...coordinated.placements);
  occupied.push(...coordinated.placements.map(({ rect }) => rect));
  segmentIndex = new TextRouteSegmentIndex(routePoints);
  for (const [routeIndex] of sizes) {
    if (offlineRouteIndexes.has(routeIndex) || coordinated.routeIndexes.has(routeIndex)) {
      continue;
    }
    const route = routes[routeIndex];
    const baseCandidates = candidatesByRoute.get(routeIndex) ?? [];
    const evaluated = baseCandidates
      .filter((candidate) => candidate.slack >= 0)
      .map((candidate) => ({
        candidate,
        defects: candidateDefects(
          world,
          segmentIndex,
          routePoints[routeIndex],
          occupied,
          routeIndex,
          candidate.segmentIndex,
          candidate.rect,
        ),
      }))
      .sort(compareEvaluatedCandidates);
    const selected = evaluated[0]?.candidate;

    if (!selected) {
      const fallback = baseCandidates[0];
      if (!fallback) {
        throw new Error(`label placement: route ${route.requestIndex} has no non-zero segment`);
      }
      const placement = offlinePlacement(
        world,
        routePoints[routeIndex],
        segmentIndex,
        occupied,
        fallback,
      );
      placements.push(placement);
      occupied.push(placement.rect);
      continue;
    }

    if (selected.points) {
      routePoints[routeIndex] = selected.points;
      segmentIndex = new TextRouteSegmentIndex(routePoints);
    }
    const placement: RealizedLabelPlacement = {
      routeIndex,
      rect: selected.rect,
      host: {
        kind: 'segment',
        segmentIndex: selected.segmentIndex,
        ...(selected.displacement ? { displacement: selected.displacement } : {}),
      },
      tier: 'on-line',
    };
    placements.push(placement);
    occupied.push(placement.rect);
  }

  return {
    placements: placements.sort((left, right) => left.routeIndex - right.routeIndex),
    routePoints,
  };
}

function labelSizes(
  routeCount: number,
  specs: readonly LabelSpec[],
): ReadonlyMap<number, LabelSize> {
  const sizes = new Map<number, LabelSize>();
  for (const spec of specs) {
    if (
      !Number.isInteger(spec.routeIndex) ||
      spec.routeIndex < 0 ||
      spec.routeIndex >= routeCount ||
      ![spec.size.width, spec.size.height].every((value) => Number.isFinite(value) && value > 0)
    ) {
      throw new Error(`label placement: invalid spec for route ${spec.routeIndex}`);
    }
    if (sizes.has(spec.routeIndex)) {
      throw new Error(`label placement: duplicate label for route ${spec.routeIndex}`);
    }
    sizes.set(spec.routeIndex, spec.size);
  }
  return new Map([...sizes].sort(([left], [right]) => left - right));
}

function placementCandidates(
  world: CorridorWorld,
  route: Route,
  points: readonly XYPoint[],
  routeSegmentIndex: TextRouteSegmentIndex,
  routeIndex: number,
  size: LabelSize,
): PlacementCandidate[] {
  const candidates: PlacementCandidate[] = [];
  for (const [firstSegmentIndex, lastSegmentIndex, axis] of straightRuns(points)) {
    const from = points[firstSegmentIndex];
    const firstTo = points[firstSegmentIndex + 1];
    const direction = Math.sign(axisStart(firstTo, axis) - axisStart(from, axis));
    const to = points[lastSegmentIndex + 1];
    const start = axisStart(from, axis);
    const end = axisStart(to, axis);
    const length = Math.abs(end - start);
    const extent = axis === 'x' ? size.width : size.height;
    const fromMargin = firstSegmentIndex === 0 ? 0 : BEND_MARGIN_PX;
    const toMargin =
      lastSegmentIndex === points.length - 2 ? TARGET_ARROWHEAD_MARGIN_PX : BEND_MARGIN_PX;
    const runMidpoint = (start + end) / 2;
    const track = axisOrthMin(from, axis);
    const slack = length - extent - fromMargin - toMargin;
    if (extent + fromMargin + toMargin > length + EPSILON) {
      const segmentIndex = segmentIndexAtTravel(
        points,
        firstSegmentIndex,
        lastSegmentIndex,
        axis,
        runMidpoint,
      );
      const anchor = axisPoint(axis, runMidpoint, track);
      candidates.push({
        routeIndex,
        sourceSegmentIndex: segmentIndex,
        segmentIndex,
        axis,
        travel: runMidpoint,
        track,
        legalTravel: [runMidpoint, runMidpoint],
        rect: centeredRect(anchor, size),
        origin: 'segment-center',
        slack,
        clearSpanLength: length,
        midpointDistance: 0,
        alignmentSupport: 0,
      });
      continue;
    }
    const legalTravel = orderedSpan(
      start + direction * (extent / 2 + fromMargin),
      end - direction * (extent / 2 + toMargin),
    );
    const travelSpace = clearTravelSpans(
      world,
      routeSegmentIndex,
      points,
      [],
      routeIndex,
      { index: firstSegmentIndex, axis, from },
      size,
      legalTravel,
    );
    const options = new Map<
      string,
      { travel: number; origin: CandidateOrigin; clearSpanLength: number }
    >();
    const add = (travel: number, origin: CandidateOrigin, clearSpanLength: number): void => {
      if (!coordinateInSpan(travel, legalTravel, EPSILON)) {
        return;
      }
      const key = travel.toFixed(6);
      const current = options.get(key);
      if (!current || ORIGIN_COST[origin] < ORIGIN_COST[current.origin]) {
        options.set(key, { travel, origin, clearSpanLength });
      }
    };

    for (const span of travelSpace.structural) {
      if (span[0] > travelSpace.bounds[0] + EPSILON && span[1] < travelSpace.bounds[1] - EPSILON) {
        add(midpoint(span), 'gap-center', spanLength(span));
      }
    }
    for (const span of travelSpace.clear) {
      add(midpoint(span), 'clear-space', spanLength(span));
    }
    const seenCorridors = new Set<number>();
    for (
      let segmentIndex = firstSegmentIndex;
      segmentIndex <= lastSegmentIndex;
      segmentIndex += 1
    ) {
      const visitIndex = route.segmentVisitOf(segmentIndex);
      const corridorIndex = route.visits[visitIndex]?.corridorIndex;
      if (corridorIndex === undefined || seenCorridors.has(corridorIndex)) {
        continue;
      }
      seenCorridors.add(corridorIndex);
      const corridor = world.indexer.corridors[corridorIndex];
      const corridorTravel = corridorTravelSpan(corridor);
      const corridorCenter = midpoint(corridorTravel);
      if (coordinateInSpan(corridorCenter, legalTravel, EPSILON)) {
        add(corridorCenter, 'corridor-center', spanLength(corridorTravel));
      }
    }
    add(clampToSpan(runMidpoint, legalTravel), 'segment-center', length);

    for (const option of options.values()) {
      const segmentIndex = segmentIndexAtTravel(
        points,
        firstSegmentIndex,
        lastSegmentIndex,
        axis,
        option.travel,
      );
      const anchor = axisPoint(axis, option.travel, track);
      candidates.push({
        routeIndex,
        sourceSegmentIndex: segmentIndex,
        segmentIndex,
        axis,
        travel: option.travel,
        track,
        legalTravel,
        rect: centeredRect(anchor, size),
        origin: option.origin,
        slack,
        clearSpanLength: option.clearSpanLength,
        midpointDistance: Math.abs(option.travel - runMidpoint),
        alignmentSupport: 0,
      });
    }
  }

  if (candidates.length === 0) {
    return [];
  }
  const online = candidates.filter((candidate) => candidate.slack >= 0);
  const cleanBounds = online.filter((candidate) => {
    const defects = candidateDefects(
      world,
      routeSegmentIndex,
      points,
      [],
      routeIndex,
      candidate.segmentIndex,
      candidate.rect,
    );
    return defects.entityCollisionCount === 0;
  });
  return dedupeCandidates([
    ...(cleanBounds.length > 0 ? cleanBounds : online),
    ...candidates.filter((candidate) => candidate.slack < 0),
  ]).sort(compareBaseCandidates);
}

function* straightRuns(
  points: readonly XYPoint[],
): Generator<readonly [firstSegmentIndex: number, lastSegmentIndex: number, axis: Axis]> {
  for (let first = 0; first + 1 < points.length;) {
    const from = points[first];
    const firstTo = points[first + 1];
    const axis = segmentAxis(from, firstTo);
    if (!axis) {
      first += 1;
      continue;
    }
    const track = axisOrthMin(from, axis);
    const direction = Math.sign(axisStart(firstTo, axis) - axisStart(from, axis));
    let last = first;
    while (last + 2 < points.length) {
      const nextSegmentIndex = last + 1;
      const nextFrom = points[nextSegmentIndex];
      const nextTo = points[nextSegmentIndex + 1];
      if (
        segmentAxis(nextFrom, nextTo) !== axis ||
        Math.abs(axisOrthMin(nextFrom, axis) - track) > EPSILON ||
        Math.sign(axisStart(nextTo, axis) - axisStart(nextFrom, axis)) !== direction
      ) {
        break;
      }
      last += 1;
    }
    yield [first, last, axis];
    first = last + 1;
  }
}

function segmentIndexAtTravel(
  points: readonly XYPoint[],
  firstSegmentIndex: number,
  lastSegmentIndex: number,
  axis: Axis,
  travel: number,
): number {
  for (let segmentIndex = firstSegmentIndex; segmentIndex <= lastSegmentIndex; segmentIndex += 1) {
    const span = orderedSpan(
      axisStart(points[segmentIndex], axis),
      axisStart(points[segmentIndex + 1], axis),
    );
    if (coordinateInSpan(travel, span, EPSILON)) {
      return segmentIndex;
    }
  }
  return firstSegmentIndex;
}

function addAlignmentCandidates(
  world: CorridorWorld,
  pointsByRoute: readonly (readonly XYPoint[])[],
  routeSegmentIndex: TextRouteSegmentIndex,
  occupied: readonly PositionProps[],
  candidatesByRoute: Map<number, PlacementCandidate[]>,
): void {
  const preferred = [...candidatesByRoute.values()]
    .flatMap((candidates) => (candidates[0] && candidates[0].slack >= 0 ? [candidates[0]] : []))
    .sort(
      (left, right) =>
        left.axis.localeCompare(right.axis) ||
        left.travel - right.travel ||
        left.routeIndex - right.routeIndex,
    );
  for (let start = 0; start < preferred.length;) {
    let end = start + 1;
    while (
      end < preferred.length &&
      preferred[end].axis === preferred[start].axis &&
      preferred[end].travel - preferred[start].travel <= ALIGNMENT_TOLERANCE_PX + EPSILON
    ) {
      end += 1;
    }
    const cluster = preferred.slice(start, end);
    const routeIndexes = new Set(cluster.map(({ routeIndex }) => routeIndex));
    if (routeIndexes.size > 1) {
      const travels = [...cluster].sort((left, right) => left.travel - right.travel);
      const middle = Math.floor(travels.length / 2);
      const target =
        travels.length % 2 === 0
          ? (travels[middle - 1].travel + travels[middle].travel) / 2
          : travels[middle].travel;
      for (const routeIndex of routeIndexes) {
        const candidates = candidatesByRoute.get(routeIndex) ?? [];
        const base = candidates.find(
          (candidate) =>
            candidate.slack >= 0 &&
            candidate.axis === preferred[start].axis &&
            target >= candidate.legalTravel[0] - EPSILON &&
            target <= candidate.legalTravel[1] + EPSILON &&
            Math.abs(target - candidate.travel) <= ALIGNMENT_TOLERANCE_PX + EPSILON,
        );
        if (!base) {
          continue;
        }
        const anchor = axisPoint(base.axis, target, base.track);
        const aligned: PlacementCandidate = {
          ...base,
          travel: target,
          rect: centeredRect(anchor, base.rect),
          origin: 'alignment',
          midpointDistance: base.midpointDistance + Math.abs(target - base.travel),
          alignmentSupport: routeIndexes.size,
        };
        const defects = candidateDefects(
          world,
          routeSegmentIndex,
          pointsByRoute[routeIndex],
          occupied,
          routeIndex,
          aligned.segmentIndex,
          aligned.rect,
        );
        if (defects.entityCollisionCount > 0) {
          continue;
        }
        candidates.push(aligned);
        candidates.sort(compareBaseCandidates);
      }
    }
    start = end;
  }
}

/** Resolve overlapping preferred labels as one geometry decision before committing any member. */
function resolveCandidateConflicts(
  world: CorridorWorld,
  candidatesByRoute: ReadonlyMap<number, readonly PlacementCandidate[]>,
  currentPoints: readonly (readonly XYPoint[])[],
  occupied: readonly PositionProps[],
): {
  placements: RealizedLabelPlacement[];
  points: Map<number, readonly XYPoint[]>;
  routeIndexes: Set<number>;
} {
  const pending = new Map<number, PlacementCandidate>();
  for (const [routeIndex, candidates] of candidatesByRoute) {
    const preferred = candidates[0];
    if (preferred && preferred.slack >= 0) {
      pending.set(routeIndex, preferred);
    }
  }
  const components: PlacementCandidate[][] = [];
  while (pending.size > 0) {
    const seed = pending.values().next().value as PlacementCandidate;
    pending.delete(seed.routeIndex);
    const component = [seed];
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      for (const candidate of [...pending.values()]) {
        if (
          candidate.axis === component[cursor].axis &&
          Math.abs(candidate.travel - component[cursor].travel) <= EPSILON &&
          candidateConflict(component[cursor], candidate)
        ) {
          pending.delete(candidate.routeIndex);
          component.push(candidate);
        }
      }
    }
    if (component.length > 1) {
      components.push(component);
    }
  }

  const placements: RealizedLabelPlacement[] = [];
  const realizedPoints = new Map<number, readonly XYPoint[]>();
  const routeIndexes = new Set<number>();
  components.sort(
    (left, right) =>
      Math.min(...left.map(({ routeIndex }) => routeIndex)) -
      Math.min(...right.map(({ routeIndex }) => routeIndex)),
  );
  for (const unsorted of components) {
    const axis = unsorted[0].axis;
    const travel = unsorted[0].travel;
    if (
      unsorted.some(
        (candidate) => candidate.axis !== axis || Math.abs(candidate.travel - travel) > EPSILON,
      )
    ) {
      continue;
    }
    const members = [...unsorted].sort(
      (left, right) => left.track - right.track || left.routeIndex - right.routeIndex,
    );
    const tracks = balancedTracks(members);
    if (!tracks) {
      continue;
    }
    const jogMargins = displacementJogMargins(members, tracks, travel, currentPoints);
    const candidatePoints = [...currentPoints];
    const candidates: PlacementCandidate[] = [];
    let failed = false;
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      const points = currentPoints[member.routeIndex];
      const track = tracks[index];
      const along = member.axis === 'x' ? member.rect.width : member.rect.height;
      const window: AxisSpan = [travel - along / 2, travel + along / 2];
      let realizedRoutePoints = points;
      let displacement: RunDisplacement | undefined;
      if (Math.abs(track - member.track) > EPSILON) {
        const realized = realizeRunDisplacement({
          points,
          segmentIndex: member.sourceSegmentIndex,
          labelWindow: window,
          displacedTrack: track,
          jogMargin: jogMargins[index],
          allowFullShift: true,
        });
        if (!realized || addsObstacleCollision(world, points, realized.points)) {
          failed = true;
          break;
        }
        realizedRoutePoints = realized.points;
        displacement = realized.displacement;
      }
      candidatePoints[member.routeIndex] = realizedRoutePoints;
      const anchor = axisPoint(member.axis, travel, track);
      candidates.push({
        ...member,
        travel,
        track,
        rect: centeredRect(anchor, member.rect),
        origin: 'alignment',
        alignmentSupport: members.length,
        segmentIndex: hostSegmentAt(realizedRoutePoints, member.axis, travel, track),
        ...(displacement ? { points: realizedRoutePoints, displacement } : {}),
      });
    }
    if (failed || candidates.length !== members.length || labelsOverlap(candidates)) {
      continue;
    }
    const affected = new Set(members.map(({ routeIndex }) => routeIndex));
    const before = affectedCollisionProfile(currentPoints, affected);
    const after = affectedCollisionProfile(candidatePoints, affected);
    if (
      after.crossings > before.crossings ||
      after.overlapLength > before.overlapLength + EPSILON
    ) {
      continue;
    }
    const candidateIndex = new TextRouteSegmentIndex(candidatePoints);
    if (
      candidates.some((candidate) => {
        const defects = candidateDefects(
          world,
          candidateIndex,
          candidatePoints[candidate.routeIndex],
          [
            ...occupied,
            ...candidates
              .filter((other) => other.routeIndex !== candidate.routeIndex)
              .map(({ rect }) => rect),
          ],
          candidate.routeIndex,
          candidate.segmentIndex,
          candidate.rect,
        );
        return !isClean(defects);
      })
    ) {
      continue;
    }
    for (const candidate of candidates) {
      placements.push({
        routeIndex: candidate.routeIndex,
        rect: candidate.rect,
        host: {
          kind: 'segment',
          segmentIndex: candidate.segmentIndex,
          ...(candidate.displacement ? { displacement: candidate.displacement } : {}),
        },
        tier: 'on-line',
      });
      routeIndexes.add(candidate.routeIndex);
      if (candidate.points) {
        realizedPoints.set(candidate.routeIndex, candidate.points);
      }
    }
  }
  return { placements, points: realizedPoints, routeIndexes };
}

function candidateConflict(left: PlacementCandidate, right: PlacementCandidate): boolean {
  return rectsOverlap(
    expandRect(left.rect, TERMINAL_LABEL_GAP_PX / 2),
    expandRect(right.rect, TERMINAL_LABEL_GAP_PX / 2),
  );
}

function labelsOverlap(candidates: readonly PlacementCandidate[]): boolean {
  return candidates.some((candidate, index) =>
    candidates.some(
      (other, otherIndex) => index !== otherIndex && candidateConflict(candidate, other),
    ),
  );
}

function balancedTracks(members: readonly PlacementCandidate[]): number[] {
  const tracks = [0];
  for (let index = 1; index < members.length; index += 1) {
    tracks.push(tracks[index - 1] + memberGap(members[index - 1], members[index]));
  }
  const desiredShift =
    members.reduce((sum, member, index) => sum + member.track - tracks[index], 0) / members.length;
  return tracks.map((track) => track + desiredShift);
}

function memberGap(left: PlacementCandidate, right: PlacementCandidate): number {
  const leftExtent = left.axis === 'x' ? left.rect.height : left.rect.width;
  const rightExtent = right.axis === 'x' ? right.rect.height : right.rect.width;
  return (leftExtent + rightExtent) / 2 + TERMINAL_LABEL_GAP_PX;
}

function displacementJogMargins(
  members: readonly PlacementCandidate[],
  tracks: readonly number[],
  travel: number,
  pointsByRoute: readonly (readonly XYPoint[])[],
): number[] {
  const amounts = members.map((member, index) => Math.abs(tracks[index] - member.track));
  const levels = [...new Set(amounts.filter((amount) => amount > EPSILON))].sort(
    (left, right) => left - right,
  );
  return members.map((member, index) => {
    const points = pointsByRoute[member.routeIndex];
    const from = points[member.sourceSegmentIndex];
    const to = points[member.sourceSegmentIndex + 1];
    const along = member.axis === 'x' ? member.rect.width : member.rect.height;
    const window: AxisSpan = [travel - along / 2, travel + along / 2];
    const rank = levels.findIndex((amount) => Math.abs(amount - amounts[index]) <= EPSILON);
    return Math.max(
      LABEL_JOG_MARGIN_PX,
      preferredJogMargin(
        orderedSpan(axisStart(from, member.axis), axisStart(to, member.axis)),
        window,
      ) -
        Math.max(0, levels.length - 1 - rank) * LABEL_LINE_CLEARANCE_PX,
    );
  });
}

function addsObstacleCollision(
  world: CorridorWorld,
  before: readonly XYPoint[],
  after: readonly XYPoint[],
): boolean {
  const incumbent = obstacleProfile(world, before);
  const candidate = obstacleProfile(world, after);
  return (
    candidate.entityPiercings > incumbent.entityPiercings ||
    candidate.containerCrossings > incumbent.containerCrossings
  );
}

function obstacleProfile(
  world: CorridorWorld,
  points: readonly XYPoint[],
): { entityPiercings: number; containerCrossings: number } {
  let entityPiercings = 0;
  let containerCrossings = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    for (const entity of world.entities) {
      if (entity.isContainer === true) {
        containerCrossings += segmentContainerCrossings(from, to, entity);
      } else {
        entityPiercings += Number(segmentPiercesRect(from, to, entity));
      }
    }
  }
  return { entityPiercings, containerCrossings };
}

function segmentContainerCrossings(from: XYPoint, to: XYPoint, container: PositionProps): number {
  const axis = segmentAxis(from, to);
  if (!axis) {
    return 0;
  }
  const travel = orderedSpan(axisStart(from, axis), axisStart(to, axis));
  const track = axisOrthMin(from, axis);
  const cross =
    axis === 'x'
      ? [container.y, container.y + container.height]
      : [container.x, container.x + container.width];
  if (!inside(track, cross[0], cross[1] - cross[0])) {
    return 0;
  }
  const boundaries =
    axis === 'x'
      ? [container.x, container.x + container.width]
      : [container.y, container.y + container.height];
  return boundaries.filter((boundary) => inside(boundary, travel[0], travel[1] - travel[0])).length;
}

function affectedCollisionProfile(
  pointsByRoute: readonly (readonly XYPoint[])[],
  affectedRouteIndexes: ReadonlySet<number>,
): { crossings: number; overlapLength: number } {
  let crossings = 0;
  let overlapLength = 0;
  for (let leftIndex = 0; leftIndex < pointsByRoute.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < pointsByRoute.length; rightIndex += 1) {
      if (!affectedRouteIndexes.has(leftIndex) && !affectedRouteIndexes.has(rightIndex)) {
        continue;
      }
      const collision = geometryPairCollisionProfile(
        pointsByRoute[leftIndex],
        pointsByRoute[rightIndex],
      );
      crossings += collision.crossings;
      overlapLength += collision.overlapLength;
    }
  }
  return { crossings, overlapLength };
}

function geometryPairCollisionProfile(
  left: readonly XYPoint[],
  right: readonly XYPoint[],
): { crossings: number; overlapLength: number } {
  let crossings = 0;
  let overlapLength = 0;
  for (let leftIndex = 0; leftIndex + 1 < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex + 1 < right.length; rightIndex += 1) {
      const collision = segmentCollisionProfile(
        left[leftIndex],
        left[leftIndex + 1],
        right[rightIndex],
        right[rightIndex + 1],
      );
      crossings += collision.crossings;
      overlapLength += collision.overlapLength;
    }
  }
  return { crossings, overlapLength };
}

function offlinePlacement(
  world: CorridorWorld,
  points: readonly XYPoint[],
  routeSegmentIndex: TextRouteSegmentIndex,
  occupied: readonly PositionProps[],
  candidate: PlacementCandidate,
): RealizedLabelPlacement {
  const { axis, routeIndex, segmentIndex, rect } = candidate;
  const anchor = axisPoint(axis, candidate.travel, candidate.track);
  const crossExtent = axis === 'x' ? rect.height : rect.width;
  const crossOffset = crossExtent / 2 + LABEL_LINE_CLEARANCE_PX;
  const sides: readonly (-1 | 1)[] = routeIndex % 2 === 0 ? [1, -1] : [-1, 1];
  const choices = sides
    .map((side) => {
      const center =
        axis === 'x'
          ? { x: anchor.x, y: anchor.y + side * crossOffset }
          : { x: anchor.x + side * crossOffset, y: anchor.y };
      const rect = centeredRect(center, candidate.rect);
      return {
        rect,
        defects: candidateDefects(
          world,
          routeSegmentIndex,
          points,
          occupied,
          routeIndex,
          segmentIndex,
          rect,
        ),
      };
    })
    .sort((left, right) => compareDefects(left.defects, right.defects));
  const choice = choices[0];
  const forced = !isClean(choice.defects);
  return {
    routeIndex,
    rect: choice.rect,
    host: { kind: 'offline', anchor, ...(forced ? { forced: true as const } : {}) },
    tier: 'offline',
  };
}

function compareEvaluatedCandidates(
  left: { candidate: PlacementCandidate; defects: CandidateDefects },
  right: { candidate: PlacementCandidate; defects: CandidateDefects },
): number {
  return (
    compareDefects(left.defects, right.defects) ||
    compareBaseCandidates(left.candidate, right.candidate)
  );
}

function compareBaseCandidates(left: PlacementCandidate, right: PlacementCandidate): number {
  return (
    Number(left.slack < 0) - Number(right.slack < 0) ||
    compareNumber(candidateCost(left), candidateCost(right), EPSILON) ||
    left.sourceSegmentIndex - right.sourceSegmentIndex ||
    left.travel - right.travel ||
    left.track - right.track
  );
}

function candidateCost(candidate: PlacementCandidate): number {
  return (
    ORIGIN_COST[candidate.origin] -
    Math.min(160, candidate.slack) * 0.08 -
    Math.min(160, candidate.clearSpanLength) * 0.02 -
    candidate.alignmentSupport * 4 +
    Number(candidate.axis !== 'x') * 6 +
    candidate.midpointDistance * 0.02 +
    (candidate.displacement
      ? 18 +
        Math.abs(candidate.displacement.displacedTrack - candidate.displacement.baseTrack) * 0.05
      : 0)
  );
}

function candidateDefects(
  world: CorridorWorld,
  routeSegmentIndex: TextRouteSegmentIndex,
  ownerPoints: readonly XYPoint[],
  occupied: readonly PositionProps[],
  ownerRouteIndex: number,
  ownerSegmentIndex: number | undefined,
  rect: PositionProps,
): CandidateDefects {
  const clearanceRect = expandRect(rect, LABEL_LINE_CLEARANCE_PX);
  return {
    occupiedOverlapCount: occupied.filter((other) =>
      rectsOverlap(expandRect(rect, TERMINAL_LABEL_GAP_PX), other),
    ).length,
    entityCollisionCount: world.entities.filter((entity) =>
      entity.isContainer === true ? rectCrossesBoundary(rect, entity) : rectsOverlap(rect, entity),
    ).length,
    lineCollisionCount:
      routeLineCollisionCount(ownerPoints, clearanceRect, ownerSegmentIndex) +
      routeSegmentIndex
        .segmentsInRect(clearanceRect, ownerRouteIndex)
        .filter((segment) => segmentPiercesRect(segment.from, segment.to, clearanceRect)).length,
  };
}

function routeLineCollisionCount(
  points: readonly XYPoint[],
  rect: PositionProps,
  ignoredSegmentIndex: number | undefined,
): number {
  let ignoredStart = ignoredSegmentIndex ?? -1;
  let ignoredEnd = ignoredStart;
  if (ignoredSegmentIndex !== undefined) {
    const hostFrom = points[ignoredSegmentIndex];
    const hostTo = points[ignoredSegmentIndex + 1];
    const hostAxis = segmentAxis(hostFrom, hostTo);
    if (hostAxis) {
      const hostTrack = axisOrthMin(hostFrom, hostAxis);
      while (
        ignoredStart > 0 &&
        segmentFollowsLine(points, ignoredStart - 1, hostAxis, hostTrack)
      ) {
        ignoredStart -= 1;
      }
      while (
        ignoredEnd + 2 < points.length &&
        segmentFollowsLine(points, ignoredEnd + 1, hostAxis, hostTrack)
      ) {
        ignoredEnd += 1;
      }
    }
  }
  let count = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    if (
      (index < ignoredStart || index > ignoredEnd) &&
      segmentPiercesRect(points[index], points[index + 1], rect)
    ) {
      count += 1;
    }
  }
  return count;
}

function segmentFollowsLine(
  points: readonly XYPoint[],
  segmentIndex: number,
  axis: Axis,
  track: number,
): boolean {
  const from = points[segmentIndex];
  const to = points[segmentIndex + 1];
  return segmentAxis(from, to) === axis && Math.abs(axisOrthMin(from, axis) - track) <= EPSILON;
}

function isClean(defects: CandidateDefects): boolean {
  return (
    defects.occupiedOverlapCount === 0 &&
    defects.entityCollisionCount === 0 &&
    defects.lineCollisionCount === 0
  );
}

function compareDefects(left: CandidateDefects, right: CandidateDefects): number {
  return (
    left.occupiedOverlapCount - right.occupiedOverlapCount ||
    left.entityCollisionCount - right.entityCollisionCount ||
    left.lineCollisionCount - right.lineCollisionCount
  );
}

function preferredJogMargin(runSpan: AxisSpan, labelWindow: AxisSpan): number {
  return Math.max(
    LABEL_JOG_MARGIN_PX,
    Math.min(
      labelWindow[0] - runSpan[0] - WIDE_U_END_MARGIN_PX,
      runSpan[1] - WIDE_U_END_MARGIN_PX - labelWindow[1],
    ),
  );
}

function hostSegmentAt(
  points: readonly XYPoint[],
  axis: Axis,
  travel: number,
  track: number,
): number {
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const followsAxis =
      segmentAxis(from, to) === axis && Math.abs(axisOrthMin(from, axis) - track) <= EPSILON;
    const span = orderedSpan(axisStart(from, axis), axisStart(to, axis));
    if (followsAxis && coordinateInSpan(travel, span, EPSILON)) {
      return index;
    }
  }
  throw new Error(`label placement: displaced host segment missing at ${travel}:${track}`);
}

function segmentCollisionProfile(
  a: XYPoint,
  b: XYPoint,
  c: XYPoint,
  d: XYPoint,
): { crossings: number; overlapLength: number } {
  const aAxis = segmentAxis(a, b);
  const cAxis = segmentAxis(c, d);
  if (!aAxis || !cAxis) {
    return { crossings: 0, overlapLength: 0 };
  }
  if (aAxis === cAxis) {
    const sameTrack = Math.abs(axisOrthMin(a, aAxis) - axisOrthMin(c, cAxis)) <= EPSILON;
    return {
      crossings: 0,
      overlapLength: sameTrack
        ? spanOverlapLength(
            orderedSpan(axisStart(a, aAxis), axisStart(b, aAxis)),
            orderedSpan(axisStart(c, cAxis), axisStart(d, cAxis)),
          )
        : 0,
    };
  }
  const [horizontalFrom, horizontalTo, verticalFrom, verticalTo] =
    aAxis === 'x' ? [a, b, c, d] : [c, d, a, b];
  return {
    crossings: Number(
      inside(
        verticalFrom.x,
        Math.min(horizontalFrom.x, horizontalTo.x),
        Math.abs(horizontalTo.x - horizontalFrom.x),
      ) &&
        inside(
          horizontalFrom.y,
          Math.min(verticalFrom.y, verticalTo.y),
          Math.abs(verticalTo.y - verticalFrom.y),
        ),
    ),
    overlapLength: 0,
  };
}

function dedupeCandidates(candidates: readonly PlacementCandidate[]): PlacementCandidate[] {
  const byKey = new Map<string, PlacementCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceSegmentIndex}:${candidate.rect.x}:${candidate.rect.y}:${candidate.rect.width}:${candidate.rect.height}`;
    const current = byKey.get(key);
    if (!current || compareBaseCandidates(candidate, current) < 0) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}
