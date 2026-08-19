import type { RouteSearchRequest } from './contract.js';
import { continuationKey } from './continuations.js';
import { unexpectedCrossings } from './crossingClassification.js';
import { compareNumber, corridorCrossSpan } from './geometry.js';
import { leafCutKeys, leafRects, type LeafRect } from './leafCuts.js';
import {
  addAttributedCorridorDemands,
  addCrossingDemand,
  addEndpointQualityDemand,
  addVisitPortals,
  addWallQualityDemand,
  compareRouteDemands,
  makeRouteDemandDrafts,
  type RouteDemandDraft,
} from './portalDemands.js';
import { compareRoutingQualityCosts, qualityEventCount } from './qualityCost.js';
import { violatesRepairIdentity } from './repairAcceptance.js';
import {
  realizeRoutes,
  reuseOptions,
  type RealizationReuseOptions,
  type RealizedRouteBatch,
} from './realize.js';
import { Route, type VisitBoundary } from './route.js';
import type { RouteCrossing } from './routeIndex.js';
import type { IndependentContinuationBoundary } from './continuations.js';
import {
  continuationBendPenalty,
  requestEndpointCorridorIndexes,
  searchRoute,
} from './topology.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;
const MAX_CROSSING_PASSES = 4;
const MAX_OTHER_PASSES = 4;
const MAX_CROSSING_CANDIDATE_EVALUATIONS = 48;
const MAX_OTHER_CANDIDATE_EVALUATIONS = 32;
const MAX_REROUTES_PER_ROUTE = 1;
const ENDPOINT_DEMANDED_ROUTES_PER_PASS = 6;
const MAX_PORTALS_PER_ROUTE = 4;
const MAX_CORRIDORS_PER_ROUTE = 2;

export interface SelectedPortalRepairOptions extends Required<RealizationReuseOptions> {
  /** Realization policies already committed by an earlier production repair phase. */
  readonly initialIndependentContinuations?: readonly IndependentContinuationBoundary[];
  /** Absolute cooperative deadline. The current candidate realization remains atomic. */
  readonly deadlineAtMs?: number;
}

const DEFAULT_SELECTED_PORTAL_REPAIR_OPTIONS: SelectedPortalRepairOptions = {
  incrementalSpacing: true,
  incrementalEmission: true,
  incrementalLineMerges: true,
};

interface AttributedTopologyQualityEvent {
  readonly kind: 'same-portal-spur';
  readonly routeIndex: number;
  readonly requestIndex: number;
  readonly visitIndex: number;
  readonly portalIndex: number;
}

interface SelectedPortalRouteDemand {
  readonly routeIndex: number;
  readonly portals: readonly { readonly portalIndex: number }[];
  readonly corridors: readonly { readonly corridorIndex: number; readonly cost: number }[];
  /** Incumbent corridors that a portal-hiding probe must preserve. */
  readonly preservedCorridorIndexes: readonly number[];
}

type SelectedPortalCandidateStatus =
  | 'fallback'
  | 'duplicate-topology'
  | 'realization-rejection'
  | 'identity-rejection'
  | 'quality-rejection'
  | 'eligible'
  | 'accepted';

interface SelectedPortalCandidateEvidence {
  readonly passIndex: number;
  readonly routeIndex: number;
  readonly hiddenPortalIndex?: number;
  readonly requiredCorridorIndex?: number;
  readonly status: SelectedPortalCandidateStatus;
  readonly fallbackReason?: string;
}

export interface SelectedPortalRepairMetrics {
  readonly acceptedPasses: number;
  readonly candidateSearches: number;
  readonly stoppedBy: 'fixed-point' | 'pass-budget' | 'candidate-budget' | 'time-budget';
  readonly candidates: readonly SelectedPortalCandidateEvidence[];
}

export interface SelectedPortalRepairResult extends RealizedRouteBatch {
  readonly topologies: readonly Route[];
  /** Realization policy that is required to reproduce the accepted geometry. */
  readonly independentContinuations: readonly IndependentContinuationBoundary[];
  readonly metrics: SelectedPortalRepairMetrics;
}

interface EvaluatedBatch extends RealizedRouteBatch {
  readonly crossings: readonly RouteCrossing[];
  readonly topologyQualityEvents: readonly AttributedTopologyQualityEvent[];
  readonly leafCuts: ReadonlySet<number>;
}

interface Candidate {
  readonly evidenceIndex: number;
  readonly routeIndex: number;
  readonly operationKey: string;
  readonly topologies: readonly Route[];
  readonly batch: EvaluatedBatch;
  readonly independentContinuations: readonly IndependentContinuationBoundary[];
  readonly signature: string;
}

interface MutableCandidateEvidence {
  passIndex: number;
  routeIndex: number;
  hiddenPortalIndex?: number;
  requiredCorridorIndex?: number;
  status: SelectedPortalCandidateStatus;
  fallbackReason?: string;
}

type AttributedSearchOperation =
  | {
      readonly kind: 'portal';
      readonly portalIndex: number;
      readonly requiredCorridorIndex?: number;
    }
  | {
      readonly kind: 'corridor';
      readonly corridorIndex: number;
      readonly cost: number;
    };

interface AttributedSearchWork {
  readonly demand: SelectedPortalRouteDemand;
  readonly operation: AttributedSearchOperation;
}

type PortalRepairMode = 'crossing' | 'wall' | 'endpoint';

/**
 * Reroute a bounded set of emitted offenders by hiding one portal per fixed-face A* search.
 * Every unique candidate is re-ordered, re-spaced, and re-emitted as a complete fresh batch.
 */
export function repairSelectedPortals(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  initialTopologies: readonly Route[],
  initial: RealizedRouteBatch,
  overrides: Partial<SelectedPortalRepairOptions> = {},
): SelectedPortalRepairResult {
  return repairAttributedPortals(
    world,
    requests,
    initialTopologies,
    initial,
    overrides,
    'crossing',
  );
}

/** Reroute attributed post-spacing wall offenders before text placement. */
export function repairWallRoutes(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  initialTopologies: readonly Route[],
  initial: RealizedRouteBatch,
  overrides: Partial<SelectedPortalRepairOptions> = {},
): SelectedPortalRepairResult {
  return repairAttributedPortals(world, requests, initialTopologies, initial, overrides, 'wall');
}

/** Reroute terminal-polish offenders only after cap/wall repair has reached its fixed point. */
export function repairEndpointRoutes(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  initialTopologies: readonly Route[],
  initial: RealizedRouteBatch,
  overrides: Partial<SelectedPortalRepairOptions> = {},
): SelectedPortalRepairResult {
  return repairAttributedPortals(
    world,
    requests,
    initialTopologies,
    initial,
    overrides,
    'endpoint',
  );
}

function repairAttributedPortals(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  initialTopologies: readonly Route[],
  initial: RealizedRouteBatch,
  overrides: Partial<SelectedPortalRepairOptions>,
  mode: PortalRepairMode,
): SelectedPortalRepairResult {
  const options = { ...DEFAULT_SELECTED_PORTAL_REPAIR_OPTIONS, ...overrides };
  validateOptions(options);
  validateRepairInputs('selected portal repair', requests, initialTopologies, initial.routes);
  const leaves = leafRects(world);
  let topologies = [...initialTopologies];
  let incumbent = evaluateBatch(initial, leaves, world.entities.length);
  let independentContinuations: IndependentContinuationBoundary[] = [
    ...(options.initialIndependentContinuations ?? []),
  ];
  const routeReroutes = new Array<number>(topologies.length).fill(0);
  const seenTopologies = new Set<string>([topologySignature(topologies)]);
  const candidates: MutableCandidateEvidence[] = [];
  let acceptedPasses = 0;
  let candidateSearches = 0;
  let candidateEvaluations = 0;
  let stoppedBy: SelectedPortalRepairMetrics['stoppedBy'] = 'pass-budget';
  const maxPasses = mode === 'crossing' ? MAX_CROSSING_PASSES : MAX_OTHER_PASSES;
  const maxCandidateEvaluations =
    mode === 'crossing' ? MAX_CROSSING_CANDIDATE_EVALUATIONS : MAX_OTHER_CANDIDATE_EVALUATIONS;
  const deadlineReached = (): boolean =>
    options.deadlineAtMs !== undefined && performance.now() >= options.deadlineAtMs;
  for (let passIndex = 0; passIndex < maxPasses; passIndex += 1) {
    if (deadlineReached()) {
      stoppedBy = 'time-budget';
      break;
    }
    const demandedRoutes = collectRouteDemands(world, incumbent, routeReroutes, mode);
    let best: Candidate | undefined;
    let candidateBudgetReached = false;
    let timeBudgetReached = false;

    const portalOperations = demandedRoutes.flatMap((demand): AttributedSearchWork[] =>
      demand.portals.flatMap((portal): AttributedSearchWork[] => {
        const preserving = demand.preservedCorridorIndexes.map((requiredCorridorIndex) => ({
          demand,
          operation: {
            kind: 'portal' as const,
            portalIndex: portal.portalIndex,
            requiredCorridorIndex,
          },
        }));
        return preserving.length > 0
          ? preserving
          : [
              {
                demand,
                operation: {
                  kind: 'portal',
                  portalIndex: portal.portalIndex,
                },
              },
            ];
      }),
    );
    const corridorOperations = demandedRoutes.flatMap((demand): AttributedSearchWork[] =>
      demand.corridors.map((corridor) => ({
        demand,
        operation: {
          kind: 'corridor',
          corridorIndex: corridor.corridorIndex,
          cost: corridor.cost,
        },
      })),
    );
    operationLoop: for (const operations of [portalOperations, corridorOperations]) {
      // Preserve the proven portal repair whenever it already has a whole-batch improvement.
      // Corridor prices are the topology-level fallback when no local portal exclusion helps.
      if (operations === corridorOperations && best) {
        break;
      }
      for (const { demand, operation } of operations) {
        if (deadlineReached()) {
          timeBudgetReached = true;
          break operationLoop;
        }
        if (candidateEvaluations >= maxCandidateEvaluations) {
          candidateBudgetReached = true;
          break operationLoop;
        }
        candidateSearches += 1;
        const request = requests[demand.routeIndex];
        let search = searchRoute(
          world,
          request,
          operation.kind === 'portal'
            ? {
                hiddenPortalIndexes: new Set([operation.portalIndex]),
                requiredCorridorIndex: operation.requiredCorridorIndex,
                preferCenteredTerminalAttachments: false,
              }
            : {
                corridorEntryPenalties: new Map([[operation.corridorIndex, operation.cost]]),
                preferCenteredTerminalAttachments: false,
              },
        );
        if (
          operation.kind === 'portal' &&
          !search.fallback &&
          mode === 'crossing' &&
          (search.cost?.portalPenalty ?? 0) > EPSILON
        ) {
          candidateSearches += 1;
          search = searchRoute(world, request, {
            hiddenPortalIndexes: new Set([
              ...pricedContinuationPortalIndexes(world, request),
              operation.portalIndex,
            ]),
            preferCenteredTerminalAttachments: false,
          });
        }
        const evidence: MutableCandidateEvidence = {
          passIndex,
          routeIndex: demand.routeIndex,
          ...(operation.kind === 'portal'
            ? {
                hiddenPortalIndex: operation.portalIndex,
                ...(operation.requiredCorridorIndex === undefined
                  ? {}
                  : { requiredCorridorIndex: operation.requiredCorridorIndex }),
              }
            : {}),
          status: 'fallback',
        };
        const evidenceIndex = candidates.length;
        candidates.push(evidence);
        if (search.fallback) {
          evidence.fallbackReason = search.fallbackReason;
          continue;
        }

        const candidateTopologies = topologies.map((route, routeIndex) =>
          routeIndex === demand.routeIndex ? search.route : route,
        );
        const signature = topologySignature(candidateTopologies);
        if (seenTopologies.has(signature)) {
          evidence.status = 'duplicate-topology';
          continue;
        }
        seenTopologies.add(signature);
        candidateEvaluations += 1;

        // A topology replacement invalidates route-local realization policies. Policies
        // owned by every untouched route remain part of the candidate batch contract.
        const retainedIndependentContinuations = independentContinuations.filter(
          (continuation) => continuation.routeIndex !== demand.routeIndex,
        );
        let candidate: EvaluatedBatch;
        try {
          candidate = evaluateBatch(
            realizeRoutes(world, candidateTopologies, {
              continuationCutSelection: 'exhaustive',
              ...reuseOptions(options, incumbent),
              independentContinuations: retainedIndependentContinuations,
            }),
            leaves,
            world.entities.length,
          );
        } catch {
          evidence.status = 'realization-rejection';
          continue;
        }
        let candidateIndependentContinuations = retainedIndependentContinuations;
        if (
          mode === 'endpoint' &&
          qualityEventCount(candidate.quality.events, 'wall-touch') >
            qualityEventCount(incumbent.quality.events, 'wall-touch') &&
          qualityEventCount(candidate.quality.events, 'line-merge') <=
            qualityEventCount(incumbent.quality.events, 'line-merge')
        ) {
          for (const continuation of pointOverlapWallTouchContinuations(
            candidate,
            demand.routeIndex,
            retainedIndependentContinuations,
          )) {
            if (deadlineReached()) {
              timeBudgetReached = true;
              break;
            }
            if (candidateEvaluations >= maxCandidateEvaluations) {
              candidateBudgetReached = true;
              break;
            }
            candidateEvaluations += 1;
            const trialContinuations = [...retainedIndependentContinuations, continuation];
            try {
              const polished = evaluateBatch(
                realizeRoutes(world, candidateTopologies, {
                  continuationCutSelection: 'exhaustive',
                  ...reuseOptions(options, candidate),
                  independentContinuations: trialContinuations,
                }),
                leaves,
                world.entities.length,
              );
              if (
                compareRoutingQualityCosts(polished.quality.cost, incumbent.quality.cost) >= 0 ||
                violatesRepairIdentity(polished.routes, polished.leafCuts, incumbent.leafCuts)
              ) {
                continue;
              }
              candidate = polished;
              candidateIndependentContinuations = trialContinuations;
              break;
            } catch {
              continue;
            }
          }
        }
        if (compareRoutingQualityCosts(candidate.quality.cost, incumbent.quality.cost) >= 0) {
          evidence.status = 'quality-rejection';
          continue;
        }
        if (violatesRepairIdentity(candidate.routes, candidate.leafCuts, incumbent.leafCuts)) {
          evidence.status = 'identity-rejection';
          continue;
        }
        evidence.status = 'eligible';
        const current: Candidate = {
          evidenceIndex,
          routeIndex: demand.routeIndex,
          operationKey:
            operation.kind === 'portal'
              ? `portal:${operation.portalIndex}:required:${operation.requiredCorridorIndex ?? 'none'}`
              : `corridor:${operation.corridorIndex}:${operation.cost}`,
          topologies: candidateTopologies,
          batch: candidate,
          independentContinuations: candidateIndependentContinuations,
          signature,
        };
        if (!best || compareCandidate(current, best) < 0) {
          best = current;
        }
      }
    }
    timeBudgetReached = timeBudgetReached || deadlineReached();

    if (!best) {
      stoppedBy = timeBudgetReached
        ? 'time-budget'
        : candidateBudgetReached
          ? 'candidate-budget'
          : 'fixed-point';
      break;
    }

    candidates[best.evidenceIndex].status = 'accepted';
    topologies = [...best.topologies];
    incumbent = best.batch;
    independentContinuations = [...best.independentContinuations];
    routeReroutes[best.routeIndex] += 1;
    acceptedPasses += 1;
    if (timeBudgetReached || candidateBudgetReached) {
      stoppedBy = timeBudgetReached ? 'time-budget' : 'candidate-budget';
      break;
    }
  }

  // Repair runs pre-label-placement; spreading the whole batch (rather than a
  // field list that silently dropped `labels`) forwards every batch field.
  const { crossings, topologyQualityEvents, leafCuts, ...batch } = incumbent;
  return {
    ...batch,
    topologies,
    independentContinuations,
    metrics: {
      acceptedPasses,
      candidateSearches,
      stoppedBy,
      candidates,
    },
  };
}

/** Continuation portals the route-relative bend rule prices for this request. */
function pricedContinuationPortalIndexes(
  world: CorridorWorld,
  request: RouteSearchRequest,
): Set<number> {
  const endpointCorridorIndexes = requestEndpointCorridorIndexes(world, request);
  const result = new Set<number>();
  for (const portal of world.indexer.portals) {
    if (
      portal.kind === 'continue' &&
      continuationBendPenalty(world, endpointCorridorIndexes, portal) > 0
    ) {
      result.add(portal.index);
    }
  }
  return result;
}

export function topologySignature(routes: readonly Route[]): string {
  return JSON.stringify(
    routes.map((route) => [
      route.requestIndex,
      route.visits.map((visit) => [
        visit.corridorIndex,
        boundaryKey(visit.entry),
        boundaryKey(visit.exit),
        visit.feasibleTrack[0],
        visit.feasibleTrack[1],
      ]),
    ]),
  );
}

export function boundaryKey(boundary: VisitBoundary | undefined): string {
  if (!boundary) {
    return 'missing';
  }
  return boundary.kind === 'terminal'
    ? `terminal:${boundary.attachmentIndex}`
    : `portal:${boundary.portalIndex}:${boundary.mode}`;
}

function collectRouteDemands(
  world: CorridorWorld,
  batch: EvaluatedBatch,
  routeReroutes: readonly number[],
  mode: PortalRepairMode,
): SelectedPortalRouteDemand[] {
  const drafts: RouteDemandDraft[] = makeRouteDemandDrafts(batch.routes);
  const preservedCorridorsByRoute = new Map<number, Set<number>>();
  if (mode === 'crossing') {
    for (const crossing of unexpectedCrossings(world, batch.routes, batch.crossings)) {
      addCrossingDemand(
        drafts,
        batch.routes,
        crossing.a.routeIndex,
        crossing.a.visitIndex,
        crossing.b.routeIndex,
      );
      addCrossingDemand(
        drafts,
        batch.routes,
        crossing.b.routeIndex,
        crossing.b.visitIndex,
        crossing.a.routeIndex,
      );
    }
    for (const event of batch.topologyQualityEvents) {
      const draft = drafts[event.routeIndex];
      draft.topologyQualityEventCount += 1;
      addVisitPortals(draft.portalEventCounts, batch.routes[event.routeIndex], event.visitIndex);
    }
    for (const event of batch.quality.events) {
      if (event.kind === 'spacing-deficit') {
        addAttributedCorridorDemands(drafts, batch.routes, event);
      }
    }
  } else if (mode === 'wall') {
    for (const event of batch.quality.events) {
      addWallQualityDemand(drafts, batch.routes, event);
      // A priced doubling is wall-family demand: the route wants a different
      // corridor for its return leg.
      if (event.kind === 'backtrack') {
        addAttributedCorridorDemands(drafts, batch.routes, event);
      }
      if (event.kind === 'near-face-turn') {
        for (const visitRef of event.visits ?? []) {
          const route = batch.routes[visitRef.routeIndex];
          const visit = route?.visits[visitRef.visitIndex];
          if (!route || !visit) {
            continue;
          }
          const crossSpan = corridorCrossSpan(world.indexer.corridors[visit.corridorIndex]);
          const mouthConstrained =
            visit.feasibleTrack[0] > crossSpan[0] + EPSILON ||
            visit.feasibleTrack[1] < crossSpan[1] - EPSILON;
          if (!mouthConstrained) {
            continue;
          }
          const corridorIndexes =
            preservedCorridorsByRoute.get(visitRef.routeIndex) ?? new Set<number>();
          corridorIndexes.add(visit.corridorIndex);
          preservedCorridorsByRoute.set(visitRef.routeIndex, corridorIndexes);
        }
      }
      if (event.kind !== 'wall-hug') {
        continue;
      }
      for (const visitRef of event.visits ?? []) {
        const route = batch.routes[visitRef.routeIndex];
        const visit = route?.visits[visitRef.visitIndex];
        if (!route || !visit || visit.feasibleTrack[1] - visit.feasibleTrack[0] > EPSILON) {
          continue;
        }
        const crossSpan = corridorCrossSpan(world.indexer.corridors[visit.corridorIndex]);
        const corridorCenter = (crossSpan[0] + crossSpan[1]) / 2;
        if (Math.abs(route.nominalTrackOf(visitRef.visitIndex) - corridorCenter) <= EPSILON) {
          continue;
        }
        const corridorIndexes = preservedCorridorsByRoute.get(visitRef.routeIndex) ?? new Set();
        corridorIndexes.add(visit.corridorIndex);
        preservedCorridorsByRoute.set(visitRef.routeIndex, corridorIndexes);
      }
    }
  } else {
    for (const event of batch.quality.events) {
      addEndpointQualityDemand(drafts, batch.routes, event);
    }
  }
  return drafts
    .filter(
      (draft) =>
        routeReroutes[draft.routeIndex] < MAX_REROUTES_PER_ROUTE &&
        (draft.portalEventCounts.size > 0 || draft.corridorDemands.size > 0),
    )
    .sort(compareRouteDemands)
    .filter(
      (_, demandIndex) => mode !== 'endpoint' || demandIndex < ENDPOINT_DEMANDED_ROUTES_PER_PASS,
    )
    .map((draft) => ({
      routeIndex: draft.routeIndex,
      preservedCorridorIndexes: [...(preservedCorridorsByRoute.get(draft.routeIndex) ?? [])].sort(
        (left, right) => left - right,
      ),
      portals: [...draft.portalEventCounts]
        .map(([portalIndex, eventCount]) => ({ portalIndex, eventCount }))
        .sort(
          (left, right) =>
            right.eventCount - left.eventCount || left.portalIndex - right.portalIndex,
        )
        .slice(0, MAX_PORTALS_PER_ROUTE)
        .map(({ portalIndex }) => ({ portalIndex })),
      corridors: [...draft.corridorDemands.values()]
        .filter((corridor) => corridor.cost > EPSILON)
        .sort(
          (left, right) =>
            compareNumber(right.cost, left.cost, EPSILON) ||
            right.eventCount - left.eventCount ||
            left.corridorIndex - right.corridorIndex,
        )
        .slice(0, MAX_CORRIDORS_PER_ROUTE)
        .map(({ corridorIndex, cost }) => ({ corridorIndex, cost })),
    }));
}

function pointOverlapWallTouchContinuations(
  batch: EvaluatedBatch,
  routeIndex: number,
  retained: readonly IndependentContinuationBoundary[],
): IndependentContinuationBoundary[] {
  const route = batch.routes[routeIndex];
  const touchedVisitIndexes = new Set<number>();
  for (const event of batch.wallQuality) {
    if (event.kind !== 'wall-touch' || !event.routeIndexes.includes(routeIndex)) {
      continue;
    }
    for (const visit of event.visits ?? []) {
      if (visit.routeIndex === routeIndex) {
        touchedVisitIndexes.add(visit.visitIndex);
      }
    }
  }
  const retainedKeys = new Set(
    retained.map(({ routeIndex: retainedRouteIndex, afterVisitIndex }) =>
      continuationKey(retainedRouteIndex, afterVisitIndex),
    ),
  );
  return batch.spacing.continuations.flatMap((policy) => {
    const { afterVisitIndex } = policy;
    const key = continuationKey(routeIndex, afterVisitIndex);
    if (
      policy.routeIndex !== routeIndex ||
      policy.policy !== 'equal' ||
      policy.reason !== 'partial-overlap' ||
      retainedKeys.has(key) ||
      (!touchedVisitIndexes.has(afterVisitIndex) && !touchedVisitIndexes.has(afterVisitIndex - 1))
    ) {
      return [];
    }
    const before = route.visits[afterVisitIndex - 1];
    const after = route.visits[afterVisitIndex];
    const overlapStart = Math.max(before.feasibleTrack[0], after.feasibleTrack[0]);
    const overlapEnd = Math.min(before.feasibleTrack[1], after.feasibleTrack[1]);
    if (Math.abs(overlapEnd - overlapStart) > EPSILON) {
      return [];
    }
    return [{ routeIndex, afterVisitIndex }];
  });
}

function evaluateBatch(
  batch: RealizedRouteBatch,
  leaves: readonly LeafRect[],
  entityCount: number,
): EvaluatedBatch {
  const { index, crossings } = batch.geometryQuality;
  return {
    ...batch,
    crossings,
    topologyQualityEvents: collectTopologyQualityEvents(batch.routes),
    leafCuts: leafCutKeys(batch.routes, index, leaves, entityCount),
  };
}

function collectTopologyQualityEvents(routes: readonly Route[]): AttributedTopologyQualityEvent[] {
  const events: AttributedTopologyQualityEvent[] = [];
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    for (let visitIndex = 0; visitIndex < route.visits.length; visitIndex += 1) {
      const visit = route.visits[visitIndex];
      if (
        visit.entry.kind === 'portal' &&
        visit.entry.mode === 'turn' &&
        visit.exit.kind === 'portal' &&
        visit.exit.mode === 'turn' &&
        visit.entry.portalIndex === visit.exit.portalIndex
      ) {
        events.push({
          kind: 'same-portal-spur',
          routeIndex,
          requestIndex: route.requestIndex,
          visitIndex,
          portalIndex: visit.entry.portalIndex,
        });
      }
    }
  }
  return events;
}

function compareCandidate(left: Candidate, right: Candidate): number {
  return (
    compareRoutingQualityCosts(left.batch.quality.cost, right.batch.quality.cost) ||
    left.routeIndex - right.routeIndex ||
    left.operationKey.localeCompare(right.operationKey) ||
    left.signature.localeCompare(right.signature)
  );
}

/** One request, one topology, and one realized route per index, all agreeing on requestIndex. */
export function validateRepairInputs(
  phase: string,
  requests: readonly RouteSearchRequest[],
  topologies: readonly Route[],
  realizedRoutes: readonly Route[],
): void {
  if (requests.length !== topologies.length || topologies.length !== realizedRoutes.length) {
    throw new Error(`${phase} requires one request, topology, and route per index`);
  }
  for (let routeIndex = 0; routeIndex < requests.length; routeIndex += 1) {
    if (
      requests[routeIndex].requestIndex !== topologies[routeIndex].requestIndex ||
      requests[routeIndex].requestIndex !== realizedRoutes[routeIndex].requestIndex
    ) {
      throw new Error(`${phase} route ${routeIndex} request index mismatch`);
    }
  }
}

function validateOptions(options: SelectedPortalRepairOptions): void {
  if (
    options.deadlineAtMs !== undefined &&
    (Number.isNaN(options.deadlineAtMs) || options.deadlineAtMs === Number.NEGATIVE_INFINITY)
  ) {
    throw new Error(`selected portal repair: invalid deadlineAtMs ${options.deadlineAtMs}`);
  }
  for (const continuation of options.initialIndependentContinuations ?? []) {
    if (
      !Number.isInteger(continuation.routeIndex) ||
      !Number.isInteger(continuation.afterVisitIndex)
    ) {
      throw new Error('selected portal repair: invalid initial independent continuation');
    }
  }
}
