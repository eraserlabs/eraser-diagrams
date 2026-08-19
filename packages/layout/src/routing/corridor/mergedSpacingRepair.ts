import {
  compareRoutingQualityCosts,
  routingQualityTier,
  type LineMergeQualityEvent,
  type RoutingQualityCost,
  type RoutingQualityEventKind,
} from './qualityCost.js';
import {
  realizeRoutes,
  reuseOptions,
  type RealizeRouteOptions,
  type RealizationReuseOptions,
  type RealizedRouteBatch,
} from './realize.js';
import type { Route } from './route.js';
import type { IndependentContinuationBoundary } from './continuations.js';
import type { CorridorWorld } from './world.js';

interface MergedSpacingRepairResult extends RealizedRouteBatch {
  readonly acceptedContinuationBoundary?: IndependentContinuationBoundary;
}

interface ScoredContinuationBoundary extends IndependentContinuationBoundary {
  readonly attributedCost: RoutingQualityCost;
}

const MAX_CONTINUATION_CANDIDATES = 8;

/** Re-realize attributed spacing candidates using production costs only. */
export function repairMergedSpacing(
  world: CorridorWorld,
  initial: RealizedRouteBatch,
  options: RealizationReuseOptions = {},
): MergedSpacingRepairResult {
  const incumbent = initial;
  // The merged-spacing default is reuse ON; an explicit spacing+emission opt-out
  // disables line-merge reuse as well (a baseline seeded for merges alone would
  // rescan nothing).
  const reuse: RealizationReuseOptions =
    options.incrementalSpacing === false && options.incrementalEmission === false
      ? { incrementalSpacing: false, incrementalEmission: false, incrementalLineMerges: false }
      : {
          incrementalSpacing: options.incrementalSpacing !== false,
          incrementalEmission: options.incrementalEmission !== false,
          incrementalLineMerges: options.incrementalLineMerges !== false,
        };
  const acceptedTerminalCenterContinuations = incumbent.spacing.continuations.some(
    (continuation) =>
      continuation.policy === 'independent' && continuation.reason === 'terminal-center-conflict',
  );
  // One trial pipeline for every candidate family: realize with the shared
  // production options and let the authoritative quality comparator adjudicate.
  const tryCandidate = (
    realizeOverrides: Partial<RealizeRouteOptions>,
    accept: (candidate: RealizedRouteBatch) => void,
  ): void => {
    let candidate: RealizedRouteBatch;
    try {
      candidate = realizeRoutes(world, incumbent.routes, {
        continuationCutSelection: 'exhaustive',
        ...reuseOptions(reuse, incumbent),
        terminalCenterContinuations: acceptedTerminalCenterContinuations,
        ...realizeOverrides,
      });
    } catch {
      return;
    }
    if (compareRoutingQualityCosts(candidate.quality.cost, incumbent.quality.cost) >= 0) {
      return;
    }
    accept(candidate);
  };

  const candidates = mergedRepairCandidates(incumbent);
  let best = incumbent;
  let acceptedContinuationBoundary: IndependentContinuationBoundary | undefined;

  const isDeadStraight = (routeIndex: number): boolean => {
    const route = incumbent.routes[routeIndex];
    if (!route) {
      return false;
    }
    try {
      const points = route.points();
      for (let pointIndex = 1; pointIndex + 1 < points.length; pointIndex += 1) {
        const beforeHorizontal = points[pointIndex - 1].y === points[pointIndex].y;
        const afterHorizontal = points[pointIndex].y === points[pointIndex + 1].y;
        if (beforeHorizontal !== afterHorizontal) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  };
  for (const boundary of candidates.continuationBoundaries) {
    // A dead-straight route is never made to jog by this phase: trading a
    // straight line for centered ports is outside its spacing charter.
    if (isDeadStraight(boundary.routeIndex)) {
      continue;
    }
    tryCandidate({ independentContinuations: [boundary] }, (candidate) => {
      if (
        best === incumbent ||
        compareRoutingQualityCosts(candidate.quality.cost, best.quality.cost) < 0
      ) {
        best = candidate;
        acceptedContinuationBoundary = boundary;
      }
    });
  }

  const corridorCandidateSets = [
    ...candidates.corridorIndexes.map((corridorIndex) => [corridorIndex]),
    ...(candidates.corridorIndexes.length > 1 ? [candidates.corridorIndexes] : []),
  ];
  for (const corridorIndexes of corridorCandidateSets) {
    tryCandidate(
      {
        turnRetrackCorridors: new Set(corridorIndexes),
        continuationTrackClearance: corridorIndexes.length > 1,
      },
      (candidate) => {
        if (
          best === incumbent ||
          compareRoutingQualityCosts(candidate.quality.cost, best.quality.cost) < 0
        ) {
          best = candidate;
          acceptedContinuationBoundary = undefined;
        }
      },
    );
  }

  return {
    ...best,
    ...(acceptedContinuationBoundary === undefined ? {} : { acceptedContinuationBoundary }),
  };
}

function mergedRepairCandidates(batch: RealizedRouteBatch): {
  readonly corridorIndexes: readonly number[];
  readonly continuationBoundaries: readonly IndependentContinuationBoundary[];
} {
  const corridorIndexes = new Set<number>();
  const continuations = new Map<string, ScoredContinuationBoundary>();
  for (const event of batch.quality.events) {
    if (event.kind === 'line-merge') {
      const merge = event as LineMergeQualityEvent;
      for (const corridorIndex of merge.corridorIndexes) {
        corridorIndexes.add(corridorIndex);
      }
    }
    for (const visit of event.visits ?? []) {
      addAdjacentContinuations(
        continuations,
        visit.routeIndex,
        batch.routes[visit.routeIndex],
        visit.visitIndex,
        event.kind,
        event.cost,
      );
    }
  }
  const continuationBoundaries = [...continuations.values()]
    .sort(
      (left, right) =>
        compareRoutingQualityCosts(right.attributedCost, left.attributedCost) ||
        left.routeIndex - right.routeIndex ||
        left.afterVisitIndex - right.afterVisitIndex,
    )
    .slice(0, MAX_CONTINUATION_CANDIDATES)
    .map(({ routeIndex, afterVisitIndex }) => ({ routeIndex, afterVisitIndex }));
  return {
    corridorIndexes: [...corridorIndexes].sort((left, right) => left - right),
    continuationBoundaries,
  };
}

function addAdjacentContinuations(
  result: Map<string, ScoredContinuationBoundary>,
  routeIndex: number,
  route: Route,
  visitIndex: number,
  eventKind: RoutingQualityEventKind,
  cost: number,
): void {
  for (const afterVisitIndex of [visitIndex, visitIndex + 1]) {
    if (afterVisitIndex <= 0 || afterVisitIndex >= route.visits.length) {
      continue;
    }
    const entry = route.visits[afterVisitIndex].entry;
    if (entry.kind !== 'portal' || entry.mode !== 'continue-straight') {
      continue;
    }
    const key = `${routeIndex}:${afterVisitIndex}`;
    const previous = result.get(key);
    const previousCost = previous?.attributedCost ?? { invalid: 0, cap: 0, scalar: 0 };
    const tier = routingQualityTier(eventKind);
    const attributedCost: RoutingQualityCost = {
      ...previousCost,
      [tier]: previousCost[tier] + cost,
    };
    result.set(key, { routeIndex, afterVisitIndex, attributedCost });
  }
}
