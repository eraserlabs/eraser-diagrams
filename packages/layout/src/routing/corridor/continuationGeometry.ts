import type { AxisSpan } from '../../types.js';
import {
  coordinateInSpan,
  midpoint,
  spanContains,
  spanLength,
  spansOverlapPositive,
} from '../../rangeUtils.js';
import { continuationKey, type ContinuationBoundaryRef } from './continuations.js';
import type { Corridor } from './contract.js';
import {
  boundaryTravelCoordinate,
  corridorCrossSpan,
  corridorTravelSpan,
  possibleTravelInterval,
  ROUTING_EPSILON,
} from './geometry.js';
import type { BoundaryRealization, Route } from './route.js';
import { WALL_HUG_CLEARANCE_PX } from './wallQuality.js';
import type { CorridorWorld } from './world.js';

export interface ContinuationGeometryTuning {
  readonly minimumTrackSeparation: number;
  readonly corridorEdgePadding: number;
  readonly boundaryShiftDepth: number;
}

interface ContinuationBundlePlacement {
  readonly key: string;
  readonly hostVisitIndex: number;
  readonly hostCorridorIndex: number;
  readonly mouthVisitIndex: number;
}

interface BoundaryDraft {
  readonly routeIndex: number;
  readonly afterVisitIndex: number;
  readonly beforeCorridorIndex: number;
  readonly afterCorridorIndex: number;
  readonly hostVisitIndex: number;
  readonly hostCorridorIndex: number;
  readonly fromTrack: number;
  readonly toTrack: number;
  readonly hostTrack: number;
  readonly mouthTrack: number;
  readonly eventCoordinate: number;
  readonly hostSide: -1 | 1;
  readonly maximumDepth: number;
}

/** Choose the containing corridor that can host a straight-continuation shift. */
export function continuationBundlePlacement(
  world: CorridorWorld,
  route: Route,
  continuation: ContinuationBoundaryRef,
): ContinuationBundlePlacement {
  const afterVisitIndex = continuation.afterVisitIndex;
  const beforeCorridor = world.indexer.corridors[route.visits[afterVisitIndex - 1].corridorIndex];
  const afterCorridor = world.indexer.corridors[route.visits[afterVisitIndex].corridorIndex];
  const beforeCross = corridorCrossSpan(beforeCorridor);
  const afterCross = corridorCrossSpan(afterCorridor);
  const hostVisitIndex = selectBoundaryHost(
    beforeCorridor,
    afterCorridor,
    spanContains(beforeCross, afterCross, ROUTING_EPSILON),
    spanContains(afterCross, beforeCross, ROUTING_EPSILON),
    afterVisitIndex,
  );
  const hostCorridorIndex = route.visits[hostVisitIndex].corridorIndex;
  const boundary = route.visits[afterVisitIndex].entry;
  if (boundary.kind !== 'portal') {
    throw new Error(`route ${route.requestIndex}: continuation portal missing`);
  }
  const hostSide = hostVisitIndex === afterVisitIndex - 1 ? 'exit' : 'entry';
  return {
    key: `${boundary.portalIndex}:${hostCorridorIndex}:${hostSide}`,
    hostVisitIndex,
    hostCorridorIndex,
    mouthVisitIndex: hostVisitIndex === afterVisitIndex - 1 ? afterVisitIndex : afterVisitIndex - 1,
  };
}

/** Realize independently tracked straight continuations as packed shift bundles. */
export function buildContinuationBoundaryRealizations(
  world: CorridorWorld,
  routes: readonly Route[],
  tracksByRoute: readonly Float64Array[],
  continuations: readonly ContinuationBoundaryRef[],
  tuning: ContinuationGeometryTuning,
  withPerpendicularClearance: boolean,
): readonly (readonly BoundaryRealization[])[] {
  const drafts: BoundaryDraft[] = [];
  for (const continuation of continuations) {
    const route = routes[continuation.routeIndex];
    const afterVisitIndex = continuation.afterVisitIndex;
    const oldTrack = tracksByRoute[continuation.routeIndex][afterVisitIndex - 1];
    const newTrack = tracksByRoute[continuation.routeIndex][afterVisitIndex];
    if (Math.abs(oldTrack - newTrack) <= ROUTING_EPSILON) {
      continue;
    }
    const entry = route.visits[afterVisitIndex].entry;
    if (entry.kind !== 'portal' || entry.mode !== 'continue-straight') {
      throw new Error(`route ${route.requestIndex}: flexible continuation boundary missing`);
    }
    const portal = world.indexer.portals[entry.portalIndex];
    if (portal.kind !== 'continue') {
      throw new Error(`route ${route.requestIndex}: flexible continuation portal missing`);
    }
    const beforeCorridorIndex = route.visits[afterVisitIndex - 1].corridorIndex;
    const afterCorridorIndex = route.visits[afterVisitIndex].corridorIndex;
    const beforeCorridor = world.indexer.corridors[beforeCorridorIndex];
    const afterCorridor = world.indexer.corridors[afterCorridorIndex];
    const beforeHosts = coordinateInSpan(
      newTrack,
      corridorCrossSpan(beforeCorridor),
      ROUTING_EPSILON,
    );
    const afterHosts = coordinateInSpan(
      oldTrack,
      corridorCrossSpan(afterCorridor),
      ROUTING_EPSILON,
    );
    const eventCoordinate = portal.planeCoordinate;
    if (beforeHosts || afterHosts) {
      const hostVisitIndex = selectBoundaryHost(
        beforeCorridor,
        afterCorridor,
        beforeHosts,
        afterHosts,
        afterVisitIndex,
      );
      drafts.push(
        boundaryDraft(
          world,
          route,
          continuation.routeIndex,
          afterVisitIndex,
          hostVisitIndex,
          oldTrack,
          newTrack,
          eventCoordinate,
          tracksByRoute,
          tuning,
        ),
      );
      continue;
    }
    throw new Error(`route ${route.requestIndex}: selected continuation has no containing host`);
  }

  const result = routes.map(() => [] as BoundaryRealization[]);
  const assignedShifts = new Map<
    string,
    Array<{
      readonly hostVisitIndex: number;
      readonly shiftCoordinate: number;
      readonly trackAfter: number;
    }>
  >();
  const groups = new Map<string, BoundaryDraft[]>();
  for (const draft of drafts) {
    const corridorPair = [draft.beforeCorridorIndex, draft.afterCorridorIndex].sort(
      (left, right) => left - right,
    );
    const key = `${corridorPair[0]}:${corridorPair[1]}:${draft.hostCorridorIndex}`;
    const group = groups.get(key) ?? [];
    group.push(draft);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = orderBoundaryDrafts(group);
    const maximumDepth = Math.min(...ordered.map((draft) => draft.maximumDepth));
    const nearDepth = Math.min(tuning.corridorEdgePadding, maximumDepth);
    const gap =
      ordered.length <= 1
        ? 0
        : Math.floor(
            Math.min(
              tuning.minimumTrackSeparation,
              Math.max(0, maximumDepth - nearDepth) / (ordered.length - 1),
            ) + ROUTING_EPSILON,
          );
    const depths = ordered.map(
      (_, orderIndex) => nearDepth + (ordered.length - 1 - orderIndex) * gap,
    );
    const depthOffset = withPerpendicularClearance
      ? continuationBundleDepthOffset(
          world,
          routes,
          tracksByRoute,
          ordered,
          depths,
          maximumDepth,
          tuning,
        )
      : 0;
    const wallDepthOffset = withPerpendicularClearance
      ? 0
      : continuationBundleCenterDepthOffset(
          world,
          routes,
          tracksByRoute,
          ordered,
          depths,
          maximumDepth,
          tuning,
        );
    ordered.forEach((draft, orderIndex) => {
      const depth = depths[orderIndex] + depthOffset + wallDepthOffset;
      const planKey = continuationKey(draft.routeIndex, draft.afterVisitIndex);
      const shifts = assignedShifts.get(planKey) ?? [];
      shifts.push({
        hostVisitIndex: draft.hostVisitIndex,
        shiftCoordinate: draft.eventCoordinate + draft.hostSide * depth,
        trackAfter: draft.toTrack,
      });
      assignedShifts.set(planKey, shifts);
    });
  }
  for (const [planKey, shifts] of assignedShifts) {
    const draft = drafts.find(
      (candidate) => continuationKey(candidate.routeIndex, candidate.afterVisitIndex) === planKey,
    );
    if (!draft) {
      throw new Error(`boundary realization ${planKey} lost its draft`);
    }
    result[draft.routeIndex].push({
      kind: 'continue-retrack',
      afterVisitIndex: draft.afterVisitIndex,
      shifts: shifts.map(({ hostVisitIndex, shiftCoordinate, trackAfter }) => ({
        hostVisitIndex,
        shiftCoordinate,
        trackAfter,
      })),
    });
  }
  for (const realizations of result) {
    realizations.sort((left, right) => left.afterVisitIndex - right.afterVisitIndex);
  }
  return result;
}

/**
 * Translate a shift bundle so its envelope sits at the center of the available wall gap instead of
 * hugging the continuation plane. With no far wall, seek the first offset with wall clearance.
 */
function continuationBundleCenterDepthOffset(
  world: CorridorWorld,
  routes: readonly Route[],
  tracksByRoute: readonly Float64Array[],
  drafts: readonly BoundaryDraft[],
  depths: readonly number[],
  maximumDepth: number,
  tuning: ContinuationGeometryTuning,
): number {
  const deepest = Math.max(...depths);
  const shallowest = Math.min(...depths);
  const maximumOffset = Math.floor(maximumDepth - deepest + ROUTING_EPSILON);
  if (maximumOffset <= 0) {
    return 0;
  }
  const facesByDraft = drafts.map((draft) => {
    const hostAxis = world.indexer.corridors[draft.hostCorridorIndex].axis;
    const trackSpan: AxisSpan = [
      Math.min(draft.fromTrack, draft.toTrack),
      Math.max(draft.fromTrack, draft.toTrack),
    ];
    return world.indexer
      .wallFacesForCorridor(draft.hostCorridorIndex)
      .filter(
        (face) =>
          face.normalAxis === hostAxis &&
          face.span[0] < trackSpan[1] + ROUTING_EPSILON &&
          face.span[1] > trackSpan[0] - ROUTING_EPSILON,
      );
  });
  let farWallDepth = Number.POSITIVE_INFINITY;
  drafts.forEach((draft, index) => {
    for (const face of facesByDraft[index]) {
      const faceDepth = draft.hostSide * (face.coordinate - draft.eventCoordinate);
      if (faceDepth > depths[index] + ROUTING_EPSILON) {
        farWallDepth = Math.min(farWallDepth, faceDepth);
      }
    }
  });
  const laneClearanceAt = (offset: number): number =>
    Math.min(
      ...drafts.map((draft, index) =>
        continuationShiftClearance(
          world,
          routes,
          tracksByRoute,
          draft,
          draft.eventCoordinate + draft.hostSide * (depths[index] + offset),
        ),
      ),
    );
  const withLaneClearance = (preferred: number): number => {
    if (laneClearanceAt(preferred) >= tuning.minimumTrackSeparation - ROUTING_EPSILON) {
      return preferred;
    }
    const candidates = new Set<number>([0, maximumOffset]);
    drafts.forEach((draft, index) => {
      routes.forEach((route, routeIndex) => {
        route.visits.forEach((_visit, visitIndex) => {
          const track = tracksByRoute[routeIndex][visitIndex];
          for (const target of [
            track + tuning.minimumTrackSeparation,
            track - tuning.minimumTrackSeparation,
          ]) {
            const offset = Math.round(
              draft.hostSide * (target - draft.eventCoordinate) - depths[index],
            );
            if (offset >= 0 && offset <= maximumOffset) {
              candidates.add(offset);
            }
          }
        });
      });
    });
    let best: number | undefined;
    for (const offset of candidates) {
      if (laneClearanceAt(offset) < tuning.minimumTrackSeparation - ROUTING_EPSILON) {
        continue;
      }
      if (best === undefined || Math.abs(offset - preferred) < Math.abs(best - preferred)) {
        best = offset;
      }
    }
    return best ?? preferred;
  };
  if (Number.isFinite(farWallDepth)) {
    const envelopeCenter = (shallowest + deepest) / 2;
    const centeringOffset = Math.round(farWallDepth / 2 - envelopeCenter);
    return withLaneClearance(Math.max(0, Math.min(maximumOffset, centeringOffset)));
  }
  let clearanceOffset = 0;
  drafts.forEach((draft, index) => {
    for (const face of facesByDraft[index]) {
      const faceDepth = draft.hostSide * (face.coordinate - draft.eventCoordinate);
      if (faceDepth <= depths[index] + ROUTING_EPSILON) {
        const needed = Math.ceil(faceDepth + WALL_HUG_CLEARANCE_PX - depths[index]);
        clearanceOffset = Math.max(clearanceOffset, needed);
      }
    }
  });
  return withLaneClearance(Math.max(0, Math.min(maximumOffset, clearanceOffset)));
}

function continuationBundleDepthOffset(
  world: CorridorWorld,
  routes: readonly Route[],
  tracksByRoute: readonly Float64Array[],
  drafts: readonly BoundaryDraft[],
  depths: readonly number[],
  maximumDepth: number,
  tuning: ContinuationGeometryTuning,
): number {
  const deepest = Math.max(...depths);
  const maximumOffset = Math.floor(maximumDepth - deepest + ROUTING_EPSILON);
  let bestOffset = 0;
  let bestClearance = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset <= maximumOffset; offset += 1) {
    const clearance = Math.min(
      ...drafts.map((draft, index) =>
        continuationShiftClearance(
          world,
          routes,
          tracksByRoute,
          draft,
          draft.eventCoordinate + draft.hostSide * (depths[index] + offset),
        ),
      ),
    );
    if (clearance >= tuning.minimumTrackSeparation - ROUTING_EPSILON) {
      return offset;
    }
    if (clearance > bestClearance + ROUTING_EPSILON) {
      bestClearance = clearance;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

function continuationShiftClearance(
  world: CorridorWorld,
  routes: readonly Route[],
  tracksByRoute: readonly Float64Array[],
  draft: BoundaryDraft,
  shiftCoordinate: number,
): number {
  const hostAxis = world.indexer.corridors[draft.hostCorridorIndex].axis;
  const shiftSpan: AxisSpan = [
    Math.min(draft.fromTrack, draft.toTrack),
    Math.max(draft.fromTrack, draft.toTrack),
  ];
  let clearance = Number.POSITIVE_INFINITY;
  routes.forEach((route, routeIndex) => {
    if (routeIndex === draft.routeIndex) {
      return;
    }
    route.visits.forEach((visit, visitIndex) => {
      const corridor = world.indexer.corridors[visit.corridorIndex];
      if (corridor.axis === hostAxis) {
        return;
      }
      const travelInterval = possibleTravelInterval(
        world,
        corridor,
        route,
        visitIndex,
        tracksByRoute[routeIndex],
      );
      if (!spansOverlapPositive(shiftSpan, travelInterval, ROUTING_EPSILON)) {
        return;
      }
      clearance = Math.min(
        clearance,
        Math.abs(shiftCoordinate - tracksByRoute[routeIndex][visitIndex]),
      );
    });
  });
  return clearance;
}

function boundaryDraft(
  world: CorridorWorld,
  route: Route,
  routeIndex: number,
  afterVisitIndex: number,
  hostVisitIndex: number,
  fromTrack: number,
  toTrack: number,
  eventCoordinate: number,
  tracksByRoute: readonly Float64Array[],
  tuning: ContinuationGeometryTuning,
): BoundaryDraft {
  const hostCorridorIndex = route.visits[hostVisitIndex].corridorIndex;
  const beforeCorridorIndex = route.visits[afterVisitIndex - 1].corridorIndex;
  const afterCorridorIndex = route.visits[afterVisitIndex].corridorIndex;
  const hostBefore = hostVisitIndex === afterVisitIndex - 1;
  const hostCorridor = world.indexer.corridors[hostCorridorIndex];
  const hostTravel = corridorTravelSpan(hostCorridor);
  const hostSide: -1 | 1 = midpoint(hostTravel) < eventCoordinate ? -1 : 1;
  const farBoundary = hostBefore
    ? route.visits[hostVisitIndex].entry
    : route.visits[hostVisitIndex].exit;
  const adjacentVisitIndex = hostBefore ? hostVisitIndex - 1 : hostVisitIndex + 1;
  const farTravel =
    farBoundary.kind === 'portal' &&
    farBoundary.mode === 'turn' &&
    adjacentVisitIndex >= 0 &&
    adjacentVisitIndex < route.visits.length
      ? tracksByRoute[routeIndex][adjacentVisitIndex]
      : boundaryTravelCoordinate(world, hostCorridor, farBoundary);
  const traversedDepth = Math.max(
    0,
    Math.abs(farTravel - eventCoordinate) - tuning.corridorEdgePadding,
  );
  const maximumDepth = Math.min(
    tuning.boundaryShiftDepth,
    traversedDepth,
    hostSide < 0 ? eventCoordinate - hostTravel[0] : hostTravel[1] - eventCoordinate,
  );
  return {
    routeIndex,
    afterVisitIndex,
    beforeCorridorIndex,
    afterCorridorIndex,
    hostVisitIndex,
    hostCorridorIndex,
    fromTrack,
    toTrack,
    hostTrack: hostBefore ? fromTrack : toTrack,
    mouthTrack: hostBefore ? toTrack : fromTrack,
    eventCoordinate,
    hostSide,
    maximumDepth: Math.max(0, maximumDepth),
  };
}

function selectBoundaryHost(
  before: Corridor,
  after: Corridor,
  beforeHosts: boolean,
  afterHosts: boolean,
  afterVisitIndex: number,
): number {
  if (beforeHosts && !afterHosts) {
    return afterVisitIndex - 1;
  }
  if (afterHosts && !beforeHosts) {
    return afterVisitIndex;
  }
  return spanLength(corridorCrossSpan(before)) >= spanLength(corridorCrossSpan(after))
    ? afterVisitIndex - 1
    : afterVisitIndex;
}

function orderBoundaryDrafts(drafts: readonly BoundaryDraft[]): BoundaryDraft[] {
  const outgoing = drafts.map(() => new Set<number>());
  const incoming = new Int32Array(drafts.length);
  for (let left = 0; left < drafts.length; left += 1) {
    for (let right = left + 1; right < drafts.length; right += 1) {
      const leftFirst = boundaryOrderSafe(drafts[left], drafts[right]);
      const rightFirst = boundaryOrderSafe(drafts[right], drafts[left]);
      if (leftFirst === rightFirst) {
        continue;
      }
      const before = leftFirst ? left : right;
      const after = leftFirst ? right : left;
      outgoing[before].add(after);
      incoming[after] += 1;
    }
  }
  const remaining = new Set(drafts.map((_, index) => index));
  const result: BoundaryDraft[] = [];
  while (remaining.size > 0) {
    const next = [...remaining]
      .filter((index) => incoming[index] === 0)
      .sort((left, right) => drafts[left].routeIndex - drafts[right].routeIndex)[0];
    const selected = next ?? Math.min(...remaining);
    remaining.delete(selected);
    result.push(drafts[selected]);
    for (const after of outgoing[selected]) {
      incoming[after] -= 1;
    }
  }
  return result;
}

function boundaryOrderSafe(first: BoundaryDraft, second: BoundaryDraft): boolean {
  return (
    !insideClosedSweep(second.hostTrack, first.hostTrack, first.mouthTrack) &&
    !insideClosedSweep(first.mouthTrack, second.hostTrack, second.mouthTrack)
  );
}

function insideClosedSweep(value: number, first: number, second: number): boolean {
  return (
    value >= Math.min(first, second) - ROUTING_EPSILON &&
    value <= Math.max(first, second) + ROUTING_EPSILON
  );
}
