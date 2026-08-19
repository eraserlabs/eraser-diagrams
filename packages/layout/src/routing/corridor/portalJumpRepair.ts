import type { RouteSearchRequest } from './contract.js';
import { compareNumber, faceCrossSpan } from './geometry.js';
import { midpoint } from '../../rangeUtils.js';
import {
  addEndpointQualityDemand,
  compareRouteDemands,
  makeRouteDemandDrafts,
} from './portalDemands.js';
import {
  compareRoutingQualityCosts,
  routingQualityTier,
  type RoutingQualityEvent,
} from './qualityCost.js';
import {
  realizeRoutes,
  reuseOptions,
  type RealizationReuseOptions,
  type RealizedRouteBatch,
} from './realize.js';
import type { Route } from './route.js';
import {
  repairEndpointRoutes,
  topologySignature,
  validateRepairInputs,
} from './selectedPortalRepair.js';
import type { IndependentContinuationBoundary } from './continuations.js';
import { searchRoute } from './topology.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;
const MAX_PORTALS_PER_ROUTE = 4;
const MAX_FLIPS = 6;
const ENDPOINT_DEMANDED_ROUTES = 6;

/** The realization policies the production composition threads into full realizations. */
export interface PortalJumpRealizationOptions extends RealizationReuseOptions {
  readonly independentContinuations?: readonly IndependentContinuationBoundary[];
}

export interface PortalJumpRepairOptions {
  /** Demanded-route budget; defaults to six endpoint offenders. */
  readonly maxDemandedRoutes?: number;
  readonly maxFlips?: number;
  /** Routes committed by a harder repair phase that endpoint polish must not reroute. */
  readonly protectedRouteIndexes?: ReadonlySet<number>;
  readonly realization?: PortalJumpRealizationOptions;
  /** Absolute cooperative deadline. Search/realization operations remain atomic. */
  readonly deadlineAtMs?: number;
}

type PortalJumpStop =
  | 'no-candidates'
  | 'jump-realization-failure'
  | 'no-offenders'
  | 'flip-budget'
  | 'no-improvement'
  | 'time-budget';

export interface PortalJumpRepairResult extends RealizedRouteBatch {
  readonly topologies: readonly Route[];
  readonly independentContinuations: readonly IndependentContinuationBoundary[];
}

export interface PortalJumpRepairDiagnostics {
  readonly accepted: boolean;
}

interface RouteDemand {
  readonly routeIndex: number;
  readonly portalIndexes: readonly number[];
}

interface RouteCandidate {
  readonly searchTotal: number;
  readonly route: Route;
}

type RouteAssignment = 'best' | 'second' | 'incumbent' | 'none';

interface StageOneRoute {
  readonly demand: RouteDemand;
  best?: RouteCandidate;
  second?: RouteCandidate;
  assignment: RouteAssignment;
}

/** Per-route attributed quality contribution; pairwise events attribute to both routes. */
interface RouteQualityAttribution {
  invalidCount: number;
  capCount: number;
  scalarCost: number;
}

interface EvaluatedState {
  readonly topologies: readonly Route[];
  readonly batch: RealizedRouteBatch;
}

/**
 * Find the best hidden-portal reroute for every demanded route without realizing
 * each candidate, realize the composed jump once, then repair interaction damage
 * with an attribution-guided descent whose candidates are fully realized.
 */
export function repairPortalJump(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  initialTopologies: readonly Route[],
  initial: RealizedRouteBatch,
  options: PortalJumpRepairOptions,
): PortalJumpRepairResult {
  validateRepairInputs('portal jump repair', requests, initialTopologies, initial.routes);
  const maxDemandedRoutes = options.maxDemandedRoutes ?? ENDPOINT_DEMANDED_ROUTES;
  const maxFlips = options.maxFlips ?? MAX_FLIPS;
  validateBudgets(maxDemandedRoutes, maxFlips);
  if (
    options.deadlineAtMs !== undefined &&
    (Number.isNaN(options.deadlineAtMs) || options.deadlineAtMs === Number.NEGATIVE_INFINITY)
  ) {
    throw new Error(`portal jump repair: invalid deadlineAtMs ${options.deadlineAtMs}`);
  }
  const deadlineReached = (): boolean =>
    options.deadlineAtMs !== undefined && performance.now() >= options.deadlineAtMs;
  const realization = options.realization ?? {};
  const inputContinuations = [...(realization.independentContinuations ?? [])];
  // Rerouted routes DROP their route-indexed realization policies (mirrors the engine's
  // retained-continuation filter); unchanged routes keep them. Reverts restore identity
  // with the initial topology, so the retained set follows the descent state.
  const retainedRealization = (topologies: readonly Route[]): PortalJumpRealizationOptions => {
    const changed = new Set<number>();
    for (let routeIndex = 0; routeIndex < topologies.length; routeIndex += 1) {
      if (topologies[routeIndex] !== initialTopologies[routeIndex]) {
        changed.add(routeIndex);
      }
    }
    return {
      independentContinuations: (realization.independentContinuations ?? []).filter(
        (policy) => !changed.has(policy.routeIndex),
      ),
    };
  };

  const maybeInvalidFallback = () => {
    if (!initial.quality.events.some((event) => routingQualityTier(event.kind) === 'invalid')) {
      return undefined;
    }
    const engine = repairEndpointRoutes(world, requests, initialTopologies, initial, {
      ...(realization.incrementalSpacing === undefined
        ? {}
        : { incrementalSpacing: realization.incrementalSpacing }),
      ...(realization.incrementalEmission === undefined
        ? {}
        : { incrementalEmission: realization.incrementalEmission }),
      ...(realization.incrementalLineMerges === undefined
        ? {}
        : { incrementalLineMerges: realization.incrementalLineMerges }),
    });
    return {
      batch: engine,
      topologies: engine.topologies,
      continuations: engine.independentContinuations,
    };
  };

  // --- stage 1: global candidate identification (search only, no realizations) ----
  const demands = collectPortalDemands(initial, maxDemandedRoutes, options.protectedRouteIndexes);
  const stageOne: StageOneRoute[] = demands.map((demand) => ({
    demand,
    assignment: 'none',
  }));
  let timeBudgetReached = false;
  stageOneSearch: for (const routeState of stageOne) {
    const { demand } = routeState;
    const incumbentSignature = topologySignature([initialTopologies[demand.routeIndex]]);
    const seenSignatures = new Set<string>([incumbentSignature]);
    for (const portalIndex of demand.portalIndexes) {
      if (deadlineReached()) {
        timeBudgetReached = true;
        break stageOneSearch;
      }
      const search = searchRoute(world, requests[demand.routeIndex], {
        hiddenPortalIndexes: new Set([portalIndex]),
        preferCenteredTerminalAttachments: false,
      });
      if (search.fallback || !search.cost) {
        continue;
      }
      const signature = topologySignature([search.route]);
      if (signature === incumbentSignature) {
        continue;
      }
      if (seenSignatures.has(signature)) {
        continue;
      }
      seenSignatures.add(signature);
      const candidate: RouteCandidate = {
        searchTotal: search.cost.total,
        route: search.route,
      };
      // Strictly-better replacement keeps search order (demand-ranked) as the
      // deterministic tie-break for equal search totals.
      if (!routeState.best || candidate.searchTotal < routeState.best.searchTotal - EPSILON) {
        routeState.second = routeState.best;
        routeState.best = candidate;
      } else if (
        !routeState.second ||
        candidate.searchTotal < routeState.second.searchTotal - EPSILON
      ) {
        routeState.second = candidate;
      }
    }
    const hiddenAttachmentIndexes = offCenterAttachmentIndexes(
      world,
      initialTopologies[demand.routeIndex],
    );
    if (hiddenAttachmentIndexes.length > 0) {
      if (deadlineReached()) {
        timeBudgetReached = true;
        break;
      }
      const search = searchRoute(world, requests[demand.routeIndex], {
        hiddenAttachmentIndexes: new Set(hiddenAttachmentIndexes),
        preferCenteredTerminalAttachments: false,
      });
      if (!search.fallback && search.cost) {
        const signature = topologySignature([search.route]);
        if (signature !== incumbentSignature && !seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          const centeredCandidate: RouteCandidate = {
            searchTotal: search.cost.total,
            route: search.route,
          };
          // Try the center-containing terminal topology first while retaining the
          // lowest-cost portal candidate as the descent alternative.
          routeState.second = routeState.best;
          routeState.best = centeredCandidate;
        }
      }
    }
    if (routeState.best) {
      routeState.assignment = 'best';
    }
  }
  const chosen = stageOne.filter((routeState) => routeState.best);

  const unchangedResult = (stoppedBy: PortalJumpStop): PortalJumpRepairResult => {
    const fallback = stoppedBy === 'time-budget' ? undefined : maybeInvalidFallback();
    return buildResult(
      fallback?.batch ?? initial,
      fallback?.topologies ?? initialTopologies,
      fallback?.continuations ?? inputContinuations,
    );
  };

  if (timeBudgetReached || deadlineReached()) {
    return unchangedResult('time-budget');
  }
  if (chosen.length === 0) {
    return unchangedResult('no-candidates');
  }

  // --- stage 2: the jump — one full realization of the composed candidate array ----
  const assignedTopology = (routeState: StageOneRoute): Route => {
    if (routeState.assignment === 'best' && routeState.best) {
      return routeState.best.route;
    }
    if (routeState.assignment === 'second' && routeState.second) {
      return routeState.second.route;
    }
    return initialTopologies[routeState.demand.routeIndex];
  };
  const composeTopologies = (): Route[] => {
    const byRoute = new Map(chosen.map((routeState) => [routeState.demand.routeIndex, routeState]));
    return initialTopologies.map((route, routeIndex) => {
      const routeState = byRoute.get(routeIndex);
      return routeState ? assignedTopology(routeState) : route;
    });
  };
  if (deadlineReached()) {
    return unchangedResult('time-budget');
  }
  let currentTopologies = composeTopologies();
  let currentBatch: RealizedRouteBatch;
  try {
    currentBatch = realizeRoutes(world, currentTopologies, {
      continuationCutSelection: 'exhaustive',
      ...retainedRealization(currentTopologies),
      ...reuseOptions(realization, initial),
    });
  } catch {
    // A degenerate composed batch (emit invariant) rejects the whole jump; there is no
    // realized state to attribute a descent from. Mirrors the engine's per-candidate
    // realization-rejection guard.
    return unchangedResult('jump-realization-failure');
  }
  const passesGates = (candidate: RealizedRouteBatch): boolean =>
    compareRoutingQualityCosts(candidate.quality.cost, initial.quality.cost) < 0;
  const jumpAccepted = passesGates(currentBatch);
  let bestSeen: EvaluatedState | undefined = jumpAccepted
    ? { topologies: currentTopologies, batch: currentBatch }
    : undefined;
  const considerBest = (state: EvaluatedState): void => {
    if (!passesGates(state.batch)) {
      return;
    }
    if (
      !bestSeen ||
      compareRoutingQualityCosts(state.batch.quality.cost, bestSeen.batch.quality.cost) < 0
    ) {
      bestSeen = state;
    }
  };

  // --- stage 3: attribution-guided flip descent -------------------------------------
  const incumbentAttribution = attributeByRoute(
    initial.quality.events,
    initial.routes.length,
    initial.geometryQuality.scalarCostByRoute,
  );
  let flipsTried = 0;
  let stoppedBy: PortalJumpStop = 'no-offenders';
  descent: while (flipsTried < maxFlips) {
    if (deadlineReached()) {
      stoppedBy = 'time-budget';
      break;
    }
    const offenders = rankOffenders(
      chosen,
      attributeByRoute(
        currentBatch.quality.events,
        currentBatch.routes.length,
        currentBatch.geometryQuality.scalarCostByRoute,
      ),
      incumbentAttribution,
    );
    if (offenders.length === 0) {
      stoppedBy = 'no-offenders';
      break;
    }
    let improved = false;
    for (const routeState of offenders) {
      if (deadlineReached()) {
        stoppedBy = 'time-budget';
        break descent;
      }
      if (flipsTried >= maxFlips) {
        stoppedBy = 'flip-budget';
        break descent;
      }
      flipsTried += 1;
      const routeIndex = routeState.demand.routeIndex;
      const actions: { readonly action: 'revert' | 'swap'; readonly route: Route }[] = [
        { action: 'revert', route: initialTopologies[routeIndex] },
      ];
      if (routeState.assignment === 'best' && routeState.second) {
        actions.push({ action: 'swap', route: routeState.second.route });
      }
      for (const { action, route } of actions) {
        if (deadlineReached()) {
          stoppedBy = 'time-budget';
          break descent;
        }
        const flippedTopologies = currentTopologies.map((current, index) =>
          index === routeIndex ? route : current,
        );
        let candidateBatch: RealizedRouteBatch;
        try {
          candidateBatch = realizeRoutes(world, flippedTopologies, {
            continuationCutSelection: 'exhaustive',
            ...retainedRealization(flippedTopologies),
            ...reuseOptions(realization, currentBatch),
          });
        } catch {
          continue;
        }
        considerBest({
          topologies: flippedTopologies,
          batch: candidateBatch,
        });
        if (
          compareRoutingQualityCosts(candidateBatch.quality.cost, currentBatch.quality.cost) < 0
        ) {
          currentTopologies = flippedTopologies;
          currentBatch = candidateBatch;
          routeState.assignment = action === 'revert' ? 'incumbent' : 'second';
          improved = true;
          break;
        }
      }
      if (improved) {
        break;
      }
    }
    if (!improved) {
      stoppedBy = 'no-improvement';
      break;
    }
  }
  if (flipsTried >= maxFlips && stoppedBy === 'no-offenders') {
    stoppedBy = 'flip-budget';
  }

  // --- final adjudication: best fully realized batch or the untouched incumbent -----
  const finalState = bestSeen;

  const fallback = finalState || stoppedBy === 'time-budget' ? undefined : maybeInvalidFallback();
  const finalTopologies = finalState
    ? finalState.topologies
    : (fallback?.topologies ?? initialTopologies);
  const finalBatch = finalState ? finalState.batch : (fallback?.batch ?? initial);
  const finalContinuations = finalState
    ? (retainedRealization(finalState.topologies).independentContinuations ?? [])
    : (fallback?.continuations ?? inputContinuations);
  return buildResult(finalBatch, finalTopologies, finalContinuations);
}

function offCenterAttachmentIndexes(world: CorridorWorld, route: Route): number[] {
  const hidden: number[] = [];
  for (const endpoint of [route.from, route.to]) {
    if (endpoint.authoredTrack !== undefined) {
      continue;
    }
    const faceSpan = faceCrossSpan(world.entities[endpoint.entityIndex], endpoint.face);
    const center = endpoint.preferredTrack ?? midpoint(faceSpan);
    const attachments = world.indexer
      .attachmentsForEndpoint(endpoint)
      .map((attachmentIndex) => world.indexer.attachments[attachmentIndex]);
    if (
      !attachments.some(
        (attachment) =>
          center >= attachment.faceSpan[0] - EPSILON && center <= attachment.faceSpan[1] + EPSILON,
      )
    ) {
      continue;
    }
    for (const attachment of attachments) {
      if (center < attachment.faceSpan[0] - EPSILON || center > attachment.faceSpan[1] + EPSILON) {
        hidden.push(attachment.index);
      }
    }
  }
  return hidden;
}

// --- demand collection (reimplemented against the same quality events) -------------
// The event -> portal-demand funnels are the SHARED producer (portalDemands.ts),
// consumed by both this module and the attributed-portal engine. This wrapper owns
// only the jump-specific demanded-route/portal budgets.
// Corridor-price demands are collected by the shared funnels but unused here: the
// jump only hides portals.

function collectPortalDemands(
  batch: RealizedRouteBatch,
  maxDemandedRoutes: number,
  protectedRouteIndexes?: ReadonlySet<number>,
): RouteDemand[] {
  const drafts = makeRouteDemandDrafts(batch.routes);
  for (const event of batch.quality.events) {
    addEndpointQualityDemand(drafts, batch.routes, event);
  }
  return drafts
    .filter(
      (draft) =>
        !protectedRouteIndexes?.has(draft.routeIndex) &&
        (draft.portalEventCounts.size > 0 || draft.portCenteringEventCount > 0),
    )
    .sort(compareRouteDemands)
    .slice(0, maxDemandedRoutes)
    .map((draft) => ({
      routeIndex: draft.routeIndex,
      portalIndexes: [...draft.portalEventCounts]
        .sort(
          ([leftPortalIndex, leftEventCount], [rightPortalIndex, rightEventCount]) =>
            rightEventCount - leftEventCount || leftPortalIndex - rightPortalIndex,
        )
        .slice(0, MAX_PORTALS_PER_ROUTE)
        .map(([portalIndex]) => portalIndex),
    }));
}

// --- attribution ---------------------------------------------------------------------

function attributeByRoute(
  events: readonly RoutingQualityEvent[],
  routeCount: number,
  scalarCostByRoute: ReadonlyMap<number, number>,
): RouteQualityAttribution[] {
  const attribution = Array.from({ length: routeCount }, (): RouteQualityAttribution => ({
    invalidCount: 0,
    capCount: 0,
    scalarCost: 0,
  }));
  for (const event of events) {
    for (const routeIndex of new Set(event.routeIndexes)) {
      const entry = attribution[routeIndex];
      if (!entry) {
        continue;
      }
      const tier = routingQualityTier(event.kind);
      if (tier === 'invalid') {
        entry.invalidCount += 1;
      } else if (tier === 'cap') {
        entry.capCount += 1;
      } else {
        entry.scalarCost += event.cost;
      }
    }
  }
  for (const [routeIndex, scalarCost] of scalarCostByRoute) {
    const entry = attribution[routeIndex];
    if (entry) {
      entry.scalarCost += scalarCost;
    }
  }
  return attribution;
}

interface RouteDamage {
  readonly invalidDelta: number;
  readonly capDelta: number;
  readonly scalarDelta: number;
}

function damageOf(
  candidate: RouteQualityAttribution | undefined,
  incumbent: RouteQualityAttribution | undefined,
): RouteDamage {
  return {
    invalidDelta: (candidate?.invalidCount ?? 0) - (incumbent?.invalidCount ?? 0),
    capDelta: (candidate?.capCount ?? 0) - (incumbent?.capCount ?? 0),
    scalarDelta: (candidate?.scalarCost ?? 0) - (incumbent?.scalarCost ?? 0),
  };
}

function isOffense(damage: RouteDamage): boolean {
  return damage.invalidDelta > 0 || damage.capDelta > 0 || damage.scalarDelta > EPSILON;
}

function compareDamage(left: RouteDamage, right: RouteDamage): number {
  return (
    right.invalidDelta - left.invalidDelta ||
    right.capDelta - left.capDelta ||
    compareNumber(right.scalarDelta, left.scalarDelta, EPSILON)
  );
}

/** Changed routes with positive attributed damage, worst first, route-index tie-break. */
function rankOffenders(
  chosen: readonly StageOneRoute[],
  candidateAttribution: readonly RouteQualityAttribution[],
  incumbentAttribution: readonly RouteQualityAttribution[],
): StageOneRoute[] {
  const damages = new Map<number, RouteDamage>();
  const offenders = chosen.filter((routeState) => {
    if (routeState.assignment === 'incumbent') {
      return false;
    }
    const routeIndex = routeState.demand.routeIndex;
    const damage = damageOf(candidateAttribution[routeIndex], incumbentAttribution[routeIndex]);
    damages.set(routeIndex, damage);
    return isOffense(damage);
  });
  return offenders.sort((left, right) => {
    const leftDamage = damages.get(left.demand.routeIndex);
    const rightDamage = damages.get(right.demand.routeIndex);
    if (!leftDamage || !rightDamage) {
      return left.demand.routeIndex - right.demand.routeIndex;
    }
    return (
      compareDamage(leftDamage, rightDamage) || left.demand.routeIndex - right.demand.routeIndex
    );
  });
}

function buildResult(
  batch: RealizedRouteBatch,
  topologies: readonly Route[],
  independentContinuations: readonly IndependentContinuationBoundary[],
): PortalJumpRepairResult {
  return {
    ...batch,
    topologies,
    independentContinuations,
  };
}

function validateBudgets(maxDemandedRoutes: number, maxFlips: number): void {
  const budgets = [
    ['maxDemandedRoutes', maxDemandedRoutes],
    ['maxFlips', maxFlips],
  ] as const;
  for (const [name, value] of budgets) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`portal jump repair: invalid ${name} ${value}`);
    }
  }
  if (maxDemandedRoutes === 0) {
    throw new Error('portal jump repair: route/portal budgets out of bounds');
  }
}
