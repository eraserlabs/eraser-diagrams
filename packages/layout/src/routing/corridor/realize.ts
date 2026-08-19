import { midpoint } from '../../rangeUtils.js';
import { emitRoutes, haveSameEmissionInputs } from './emit.js';
import { collectEndpointQualityEvents } from './endpointQuality.js';
import {
  collectGeometryQualityEvents,
  retainedLineMergesForUnchangedRoutes,
  type GeometryQualityResult,
} from './geometryQuality.js';
import { faceCrossSpan } from './geometry.js';
import { placeLabels, type LabelPlacementResult } from './labelPlacement.js';
import { orderRoutes, type OrderingResult } from './ordering.js';
import {
  compareRoutingQualityCosts,
  type LineMergeQualityEvent,
  type MissingSpacingContentionQualityEvent,
  RoutingQualityLedger,
  type RoutingQualityEvent,
  type RoutingQualitySnapshot,
  type RoutingQualityTier,
  routingQualityTier,
  type WallTouchQualityEvent,
} from './qualityCost.js';
import { Route, cloneRoute } from './route.js';
import {
  collectMissingRealizedSpacingQualityEvents,
  createSpacingRunWorkspace,
  haveSameSpacingInputs,
  PORT_EDGE_PADDING_PX,
  spaceRoutes,
  type SpacingOptions,
  type SpacingResult,
  type SpacingRunWorkspace,
} from './spacing.js';
import type { IndependentContinuationBoundary } from './continuations.js';
import type { LabelSpec } from './text.js';
import { collectWallQualityEvents } from './wallQuality.js';
import type { CorridorWorld } from './world.js';

const MAX_CONTINUATION_CUT_VALIDATIONS_PER_ROUND = 4;

export interface RealizedRouteBatch {
  readonly routes: readonly Route[];
  readonly ordering: OrderingResult;
  readonly spacing: SpacingResult;
  readonly endpointQuality: readonly RoutingQualityEvent[];
  readonly geometryQuality: GeometryQualityResult;
  readonly wallQuality: readonly RoutingQualityEvent[];
  readonly quality: RoutingQualitySnapshot;
  /** Present iff label specs were supplied; owns every placement and final route geometry. */
  readonly labels?: LabelPlacementResult;
}

/** Independent reuse layers for repeated realizations over one immutable world. */
export interface RealizationReuseOptions {
  /** Re-solve only seeded spacing corridors and their required continuation closure. */
  readonly incrementalSpacing?: boolean;
  /** Structurally share routes whose complete emitter inputs are unchanged. */
  readonly incrementalEmission?: boolean;
  /** Retain clean-clean merge facts and rescan only pairs involving changed routes. */
  readonly incrementalLineMerges?: boolean;
}

export interface RealizeRouteOptions extends RealizationReuseOptions {
  readonly terminalCenterContinuations?: SpacingOptions['terminalCenterContinuations'];
  readonly independentContinuations?: SpacingOptions['independentContinuations'];
  readonly turnRetrackCorridors?: SpacingOptions['turnRetrackCorridors'];
  readonly continuationTrackClearance?: SpacingOptions['continuationTrackClearance'];
  /** Initial realization is greedy; repair candidates explicitly retain exhaustive quality choice. */
  readonly continuationCutSelection?: 'greedy' | 'exhaustive';
  /** Batch-owned label inputs keyed by route index. */
  readonly labelSpecs?: readonly LabelSpec[];
  /** Earlier authoritative batch for the first pass of a same-topology repair realization. */
  readonly incrementalSpacingBaseline?: RealizedRouteBatch;
}

/**
 * Spread-ready reuse options for a repair-candidate realization over `baseline`.
 * Safe to emit unconditionally: when every reuse flag is falsy the baseline is
 * ignored (initialIncrementalSeed returns undefined), matching an empty spread.
 */
export function reuseOptions(
  reuse: RealizationReuseOptions,
  baseline: RealizedRouteBatch,
): Pick<
  RealizeRouteOptions,
  | 'incrementalSpacing'
  | 'incrementalSpacingBaseline'
  | 'incrementalEmission'
  | 'incrementalLineMerges'
> {
  return {
    incrementalSpacing: reuse.incrementalSpacing,
    incrementalSpacingBaseline: baseline,
    incrementalEmission: reuse.incrementalEmission,
    incrementalLineMerges: reuse.incrementalLineMerges,
  };
}

interface SpacingPass {
  readonly routes: readonly Route[];
  readonly ordering: OrderingResult;
  readonly spacing: SpacingResult;
  readonly missingContentions: readonly MissingSpacingContentionQualityEvent[];
  readonly endpointQuality: readonly RoutingQualityEvent[];
  readonly geometryQuality: GeometryQualityResult;
  readonly wallQuality: readonly RoutingQualityEvent[];
  readonly quality: RoutingQualitySnapshot;
}

interface UncertifiedSpacingPolicy {
  readonly routes: readonly Route[];
  readonly ordering: OrderingResult;
  readonly spacing: SpacingResult;
  readonly qualityLedger: RoutingQualityLedger;
}

interface IncrementalPassSeed {
  readonly baseline: Pick<SpacingPass, 'routes' | 'spacing' | 'geometryQuality'>;
  readonly corridorIndexes: readonly number[];
}

interface EmissionReuse {
  readonly routes: readonly Route[];
  readonly changedRouteIndexes?: ReadonlySet<number>;
}

interface ContinuationCutSelectionContext {
  readonly world: CorridorWorld;
  readonly topologies: readonly Route[];
  readonly ordering: OrderingResult;
  readonly options: RealizeRouteOptions;
  readonly workspace: SpacingRunWorkspace;
  readonly terminalCenterContinuations: boolean;
  readonly greedy: boolean;
}

/** Clone topology and certify emitted contention through the authoritative spacing kernel. */
export function realizeRoutes(
  world: CorridorWorld,
  topologies: readonly Route[],
  options: RealizeRouteOptions = {},
): RealizedRouteBatch {
  const spacingWorkspace = createSpacingRunWorkspace();
  const greedyContinuationCuts = options.continuationCutSelection !== 'exhaustive';
  const orderingRoutes = cloneTopologies(topologies);
  const ordering = orderRoutes(world, orderingRoutes);
  const initialIncremental = initialIncrementalSeed(options, topologies, ordering);
  const incumbent = certifySpacingPolicy(
    world,
    topologies,
    ordering,
    options,
    options.terminalCenterContinuations ?? false,
    spacingWorkspace,
    initialIncremental,
    greedyContinuationCuts,
  );
  const terminalCenter = evaluateTerminalCenterCandidate(
    world,
    topologies,
    ordering,
    options,
    spacingWorkspace,
    greedyContinuationCuts,
    incumbent,
  );
  const selected = selectContinuationCuts(
    {
      world,
      topologies,
      ordering,
      options,
      workspace: spacingWorkspace,
      terminalCenterContinuations:
        (options.terminalCenterContinuations ?? false) || terminalCenter.accepted,
      greedy: greedyContinuationCuts,
    },
    terminalCenter.selected,
  );

  const { routes, spacing, endpointQuality, geometryQuality, wallQuality, quality } = selected;
  const labels = options.labelSpecs ? placeLabels(world, routes, options.labelSpecs) : undefined;
  return {
    routes,
    ordering,
    spacing,
    endpointQuality,
    geometryQuality,
    wallQuality,
    quality,
    ...(labels ? { labels } : {}),
  };
}

interface TerminalCenterEvaluation {
  readonly selected: SpacingPass;
  readonly accepted: boolean;
}

/**
 * When no explicit terminal-center policy is authored and the incumbent surfaced a
 * terminal-center candidate, certify the centered variant and keep it only when it
 * improves quality.
 */
function evaluateTerminalCenterCandidate(
  world: CorridorWorld,
  topologies: readonly Route[],
  ordering: OrderingResult,
  options: RealizeRouteOptions,
  workspace: SpacingRunWorkspace,
  greedyContinuationCuts: boolean,
  incumbent: SpacingPass,
): TerminalCenterEvaluation {
  const hasTerminalCenterCandidate = incumbent.spacing.continuations.some(
    (policy) => policy.terminalCenterCandidate,
  );
  if (options.terminalCenterContinuations !== undefined || !hasTerminalCenterCandidate) {
    return { selected: incumbent, accepted: false };
  }
  const centered = certifySpacingPolicy(
    world,
    topologies,
    ordering,
    options,
    true,
    workspace,
    incrementalSeed(
      options,
      incumbent,
      incumbent.spacing.continuations
        .filter((policy) => policy.terminalCenterCandidate)
        .flatMap((policy) => [policy.beforeCorridorIndex, policy.afterCorridorIndex]),
    ),
    greedyContinuationCuts,
  );
  const accepted = improvesQuality(centered, incumbent);
  return {
    selected: accepted ? centered : incumbent,
    accepted,
  };
}

function selectContinuationCuts(
  context: ContinuationCutSelectionContext,
  initial: SpacingPass,
): SpacingPass {
  const { world, topologies, ordering, options, workspace, terminalCenterContinuations, greedy } =
    context;
  let selected = initial;
  let selectedIndependentContinuations = [...(options.independentContinuations ?? [])];

  while (strictContinuationViolation(selected) > 0) {
    const cuts = infeasibleContinuationCuts(
      world,
      selected,
      selectedIndependentContinuations,
      greedy,
    );
    if (!greedy) {
      let best:
        | {
            readonly cut: IndependentContinuationBoundary;
            readonly pass: SpacingPass;
          }
        | undefined;
      for (const cut of cuts) {
        let candidate: SpacingPass;
        try {
          candidate = certifySpacingPolicy(
            world,
            topologies,
            ordering,
            {
              ...options,
              independentContinuations: [...selectedIndependentContinuations, cut],
            },
            terminalCenterContinuations,
            workspace,
            incrementalSeed(options, selected, continuationCorridors(selected, cut)),
          );
        } catch {
          continue;
        }
        if (!improvesContinuationFeasibility(candidate, selected)) {
          continue;
        }
        if (!best || compareContinuationFeasibility(candidate, best.pass) < 0) {
          best = { cut, pass: candidate };
        }
      }
      if (!best) {
        break;
      }
      selected = best.pass;
      selectedIndependentContinuations = [...selectedIndependentContinuations, best.cut];
      continue;
    }

    let accepted:
      | {
          readonly cut: IndependentContinuationBoundary;
          readonly pass: SpacingPass;
        }
      | undefined;
    for (const cut of cuts.slice(0, MAX_CONTINUATION_CUT_VALIDATIONS_PER_ROUND)) {
      const candidateOptions: RealizeRouteOptions = {
        ...options,
        independentContinuations: [...selectedIndependentContinuations, cut],
        incrementalEmission: true,
        incrementalLineMerges: true,
      };
      const candidateSeed = continuationCandidateSeed(
        selected,
        continuationCorridors(selected, cut),
      );
      let solved: UncertifiedSpacingPolicy;
      try {
        solved = solveSpacingPolicy(
          world,
          topologies,
          ordering,
          candidateOptions,
          terminalCenterContinuations,
          [],
          workspace,
          candidateSeed,
        );
      } catch {
        continue;
      }
      const afterSpacingViolation = strictContinuationSpacingViolation(solved.spacing);
      if (!improvesSpacingContinuationFeasibility(solved.spacing, selected.spacing)) {
        continue;
      }
      const candidate = certifySolvedSpacingPolicy(
        world,
        topologies,
        ordering,
        candidateOptions,
        terminalCenterContinuations,
        solved,
        workspace,
        candidateSeed,
        afterSpacingViolation > 0,
      );
      if (!improvesContinuationFeasibility(candidate, selected)) {
        continue;
      }
      accepted = { cut, pass: candidate };
      break;
    }
    if (!accepted) {
      break;
    }
    selected = accepted.pass;
    selectedIndependentContinuations = [...selectedIndependentContinuations, accepted.cut];
  }

  return selected;
}

function certifySpacingPolicy(
  world: CorridorWorld,
  topologies: readonly Route[],
  ordering: OrderingResult,
  options: RealizeRouteOptions,
  terminalCenterContinuations: boolean,
  workspace: SpacingRunWorkspace,
  incremental?: IncrementalPassSeed,
  deferRequiredContentionsWhileInfeasible = false,
): SpacingPass {
  const solved = solveSpacingPolicy(
    world,
    topologies,
    ordering,
    options,
    terminalCenterContinuations,
    [],
    workspace,
    incremental,
  );
  return certifySolvedSpacingPolicy(
    world,
    topologies,
    ordering,
    options,
    terminalCenterContinuations,
    solved,
    workspace,
    incremental,
    deferRequiredContentionsWhileInfeasible &&
      strictContinuationSpacingViolation(solved.spacing) > 0,
  );
}

function solveSpacingPolicy(
  world: CorridorWorld,
  topologies: readonly Route[],
  ordering: OrderingResult,
  options: RealizeRouteOptions,
  terminalCenterContinuations: boolean,
  requiredContentions: readonly MissingSpacingContentionQualityEvent[],
  workspace: SpacingRunWorkspace,
  incremental?: IncrementalPassSeed,
): UncertifiedSpacingPolicy {
  const policyOptions: RealizeRouteOptions = {
    ...options,
    terminalCenterContinuations,
  };
  const routes = cloneTopologies(topologies);
  applyOrdering(routes, ordering);
  const qualityLedger = new RoutingQualityLedger();
  const spacing = spaceRoutes(world, routes, ordering, {
    qualityLedger,
    terminalCenterContinuations: policyOptions.terminalCenterContinuations,
    independentContinuations: policyOptions.independentContinuations,
    turnRetrackCorridors: policyOptions.turnRetrackCorridors,
    continuationTrackClearance: policyOptions.continuationTrackClearance,
    requiredContentions,
    workspace,
    ...(incremental
      ? {
          incrementalBaseline: {
            routes: incremental.baseline.routes,
            spacing: incremental.baseline.spacing,
            seedCorridorIndexes: incremental.corridorIndexes,
          },
        }
      : {}),
  });
  return { routes, ordering, spacing, qualityLedger };
}

function certifySolvedSpacingPolicy(
  world: CorridorWorld,
  topologies: readonly Route[],
  ordering: OrderingResult,
  options: RealizeRouteOptions,
  terminalCenterContinuations: boolean,
  solved: UncertifiedSpacingPolicy,
  workspace: SpacingRunWorkspace,
  incremental?: IncrementalPassSeed,
  deferRequiredContentions = false,
): SpacingPass {
  const policyOptions: RealizeRouteOptions = {
    ...options,
    terminalCenterContinuations,
  };
  const first = finishSpacingPass(world, solved, policyOptions, incremental);
  const requiredContentions = first.missingContentions;
  if (requiredContentions.length === 0) {
    return first;
  }
  if (deferRequiredContentions) {
    return first;
  }

  const retryIncremental = incrementalSeed(
    options,
    first,
    requiredContentions.map((contention) => contention.corridorIndexes[0]),
  );
  const candidate = finishSpacingPass(
    world,
    solveSpacingPolicy(
      world,
      topologies,
      ordering,
      policyOptions,
      terminalCenterContinuations,
      requiredContentions,
      workspace,
      retryIncremental,
    ),
    policyOptions,
    retryIncremental,
  );
  if (candidate.missingContentions.length > 0) {
    return first;
  }
  if (!improvesQuality(candidate, first)) {
    return first;
  }
  return candidate;
}

function finishSpacingPass(
  world: CorridorWorld,
  solved: UncertifiedSpacingPolicy,
  options: RealizeRouteOptions,
  incremental?: IncrementalPassSeed,
): SpacingPass {
  const { routes, ordering, spacing, qualityLedger } = solved;
  const reuse = reuseEmittedRoutes(
    routes,
    options.incrementalEmission || options.incrementalLineMerges
      ? incremental?.baseline.routes
      : undefined,
    options.incrementalEmission === true,
  );
  emitRoutes(
    world,
    reuse.routes,
    options.incrementalEmission !== true || !reuse.changedRouteIndexes
      ? {}
      : { routeIndexes: reuse.changedRouteIndexes },
  );
  const retainedLineMerges =
    options.incrementalLineMerges && incremental && reuse.changedRouteIndexes
      ? retainedLineMergesForUnchangedRoutes(
          incremental.baseline.geometryQuality,
          reuse.changedRouteIndexes,
        )
      : undefined;
  const lineMergeRouteIndexes = options.incrementalLineMerges
    ? (reuse.changedRouteIndexes ?? new Set<number>())
    : undefined;
  const geometryQuality = collectGeometryQualityEvents(
    reuse.routes,
    spacing.quality.events,
    undefined,
    lineMergeRouteIndexes
      ? {
          lineMergeRouteIndexes,
          ...(retainedLineMerges ? { retainedLineMerges } : {}),
        }
      : {},
  );
  const missingContentions = collectMissingRealizedSpacingQualityEvents(
    world,
    reuse.routes,
    ordering,
    spacing.quality.events,
    geometryQuality.index,
  );
  qualityLedger.replaceSource('spacing:realized-missing', 'spacing', missingContentions);
  const wallQuality = collectWallQualityEvents(world, reuse.routes);
  qualityLedger.replaceSource('emission:wall-quality', 'emission', wallQuality);
  const endpointQuality = collectEndpointQualityEvents(world, reuse.routes);
  qualityLedger.replaceSource('emission:endpoint-quality', 'emission', endpointQuality);
  qualityLedger.replaceSource(
    'emission:geometry-quality',
    'emission',
    geometryQuality.events,
    geometryQuality.scalarCosts,
  );
  const quality = qualityLedger.snapshot();
  return {
    routes: reuse.routes,
    ordering,
    spacing,
    missingContentions,
    endpointQuality,
    geometryQuality,
    wallQuality,
    quality,
  };
}

function reuseEmittedRoutes(
  routes: readonly Route[],
  baselineRoutes: readonly Route[] | undefined,
  reuseUnchanged: boolean,
): EmissionReuse {
  if (!baselineRoutes) {
    return { routes };
  }
  if (routes.length !== baselineRoutes.length) {
    throw new Error('route emission: incremental baseline route count changed');
  }
  const changedRouteIndexes = new Set<number>();
  const sharedRoutes = routes.map((route, routeIndex) => {
    const baseline = baselineRoutes[routeIndex];
    if (haveSameEmissionInputs(route, baseline)) {
      return reuseUnchanged ? baseline : route;
    }
    changedRouteIndexes.add(routeIndex);
    return route;
  });
  return {
    routes: sharedRoutes,
    changedRouteIndexes,
  };
}

function cloneTopologies(topologies: readonly Route[]): Route[] {
  return topologies.map((route) => cloneRoute(route));
}

function applyOrdering(routes: readonly Route[], ordering: OrderingResult): void {
  const orderByRoute = routes.map((route) => new Int32Array(route.visits.length));
  for (const group of ordering.groups) {
    for (const member of group.members) {
      orderByRoute[member.routeIndex][member.visitIndex] = member.order;
    }
  }
  routes.forEach((route, routeIndex) => {
    if (route.visits.length === 0) {
      return;
    }
    route.beginRealization();
    route.setOrder(orderByRoute[routeIndex]);
  });
}

function incrementalSeed(
  options: RealizeRouteOptions,
  baseline: Pick<SpacingPass, 'routes' | 'spacing' | 'geometryQuality'>,
  corridorIndexes: readonly number[],
): IncrementalPassSeed | undefined {
  if (
    !options.incrementalSpacing &&
    !options.incrementalEmission &&
    !options.incrementalLineMerges
  ) {
    return undefined;
  }
  const uniqueCorridorIndexes = [...new Set(corridorIndexes)];
  return {
    baseline,
    corridorIndexes: options.incrementalSpacing ? uniqueCorridorIndexes : [],
  };
}

function continuationCandidateSeed(
  baseline: Pick<SpacingPass, 'routes' | 'spacing' | 'geometryQuality'>,
  corridorIndexes: readonly number[],
): IncrementalPassSeed {
  return {
    baseline,
    corridorIndexes: [...new Set(corridorIndexes)],
  };
}

function initialIncrementalSeed(
  options: RealizeRouteOptions,
  topologies: readonly Route[],
  ordering: OrderingResult,
): IncrementalPassSeed | undefined {
  const baseline = options.incrementalSpacingBaseline;
  if (
    !baseline ||
    (!options.incrementalSpacing && !options.incrementalEmission && !options.incrementalLineMerges)
  ) {
    return undefined;
  }
  const corridorIndexes = new Set<number>();
  topologies.forEach((route, routeIndex) => {
    const baselineRoute = baseline.routes[routeIndex];
    if (baselineRoute && haveSameSpacingInputs(route, baselineRoute)) {
      return;
    }
    for (const visit of route.visits) {
      corridorIndexes.add(visit.corridorIndex);
    }
    for (const visit of baselineRoute?.visits ?? []) {
      corridorIndexes.add(visit.corridorIndex);
    }
  });
  const baselineOrderByCorridor = new Map(
    baseline.ordering.groups.map((group) => [
      group.corridorIndex,
      group.members.map((member) => `${member.routeIndex}:${member.visitIndex}`).join(','),
    ]),
  );
  for (const group of ordering.groups) {
    const signature = group.members
      .map((member) => `${member.routeIndex}:${member.visitIndex}`)
      .join(',');
    if (baselineOrderByCorridor.get(group.corridorIndex) !== signature) {
      corridorIndexes.add(group.corridorIndex);
    }
    baselineOrderByCorridor.delete(group.corridorIndex);
  }
  for (const corridorIndex of baselineOrderByCorridor.keys()) {
    corridorIndexes.add(corridorIndex);
  }
  for (const continuation of options.independentContinuations ?? []) {
    addContinuationCorridors(corridorIndexes, topologies, continuation);
  }
  const requestedIndependentKeys = new Set(
    (options.independentContinuations ?? []).map(
      ({ routeIndex, afterVisitIndex }) => `${routeIndex}:${afterVisitIndex}`,
    ),
  );
  for (const policy of baseline.spacing.continuations) {
    const key = `${policy.routeIndex}:${policy.afterVisitIndex}`;
    const retainedForcedIndependent =
      policy.reason === 'forced-independent' && requestedIndependentKeys.has(key);
    const retainedTerminalCenter =
      policy.reason === 'terminal-center-conflict' && options.terminalCenterContinuations === true;
    if (
      (policy.reason === 'forced-independent' && !retainedForcedIndependent) ||
      (policy.reason === 'terminal-center-conflict' && !retainedTerminalCenter)
    ) {
      corridorIndexes.add(policy.beforeCorridorIndex);
      corridorIndexes.add(policy.afterCorridorIndex);
    }
  }
  for (const corridorIndex of options.turnRetrackCorridors ?? []) {
    corridorIndexes.add(corridorIndex);
  }
  return incrementalSeed(options, baseline, [...corridorIndexes]);
}

function addContinuationCorridors(
  result: Set<number>,
  routes: readonly Route[],
  boundary: IndependentContinuationBoundary,
): void {
  const route = routes[boundary.routeIndex];
  const before = route?.visits[boundary.afterVisitIndex - 1];
  const after = route?.visits[boundary.afterVisitIndex];
  if (before) {
    result.add(before.corridorIndex);
  }
  if (after) {
    result.add(after.corridorIndex);
  }
}

function continuationCorridors(
  pass: SpacingPass,
  boundary: IndependentContinuationBoundary,
): number[] {
  const policy = pass.spacing.continuations.find(
    (candidate) =>
      candidate.routeIndex === boundary.routeIndex &&
      candidate.afterVisitIndex === boundary.afterVisitIndex,
  );
  if (policy) {
    return [policy.beforeCorridorIndex, policy.afterCorridorIndex];
  }
  const route = pass.routes[boundary.routeIndex];
  return [
    route.visits[boundary.afterVisitIndex - 1].corridorIndex,
    route.visits[boundary.afterVisitIndex].corridorIndex,
  ];
}

function improvesQuality(candidate: SpacingPass, incumbent: SpacingPass) {
  return compareRoutingQualityCosts(candidate.quality.cost, incumbent.quality.cost) < 0;
}

function improvesContinuationFeasibility(candidate: SpacingPass, incumbent: SpacingPass): boolean {
  return (
    introducesNoInvalidEvents(candidate.quality.events, incumbent.quality.events) &&
    introducesNoCapEvents(candidate.quality.events, incumbent.quality.events) &&
    strictContinuationViolation(candidate) < strictContinuationViolation(incumbent)
  );
}

function improvesSpacingContinuationFeasibility(
  candidate: SpacingResult,
  incumbent: SpacingResult,
): boolean {
  return (
    introducesNoInvalidEvents(candidate.quality.events, incumbent.quality.events) &&
    introducesNoCapEvents(candidate.quality.events, incumbent.quality.events) &&
    strictContinuationSpacingViolation(candidate) < strictContinuationSpacingViolation(incumbent)
  );
}

function compareContinuationFeasibility(left: SpacingPass, right: SpacingPass): number {
  return (
    strictContinuationViolation(left) - strictContinuationViolation(right) ||
    compareRoutingQualityCosts(left.quality.cost, right.quality.cost)
  );
}

function strictContinuationViolation(pass: SpacingPass): number {
  return strictContinuationSpacingViolation(pass.spacing);
}

function strictContinuationSpacingViolation(spacing: SpacingResult): number {
  return spacing.shortfalls.reduce(
    (total, shortfall) =>
      shortfall.kind === 'straight-continuation'
        ? total + Math.max(0, shortfall.required - shortfall.achieved)
        : total,
    0,
  );
}

function infeasibleContinuationCuts(
  world: CorridorWorld,
  pass: SpacingPass,
  retained: readonly IndependentContinuationBoundary[],
  ranked: boolean,
): IndependentContinuationBoundary[] {
  const offendingVisitsByRoute = new Map<number, Set<number>>();
  const paddedCandidateRanks = new Map<
    string,
    { readonly localRank: number; readonly violation: number }
  >();
  for (const shortfall of pass.spacing.shortfalls) {
    if (shortfall.kind !== 'straight-continuation' || shortfall.achieved >= shortfall.required) {
      continue;
    }
    shortfall.routeIndexes.forEach((routeIndex, index) => {
      const visitIndex = shortfall.visitIndexes[index];
      if (visitIndex !== undefined) {
        const visits = offendingVisitsByRoute.get(routeIndex) ?? new Set<number>();
        visits.add(visitIndex);
        offendingVisitsByRoute.set(routeIndex, visits);
      }
    });
    if (shortfall.reason === 'empty-padded-intersection') {
      const violation = Math.max(0, shortfall.required - shortfall.achieved);
      for (const [localRank, candidate] of (shortfall.candidateContinuations ?? []).entries()) {
        const key = continuationBoundaryKey(candidate);
        const incumbent = paddedCandidateRanks.get(key);
        if (
          !incumbent ||
          violation > incumbent.violation ||
          (violation === incumbent.violation && localRank < incumbent.localRank)
        ) {
          paddedCandidateRanks.set(key, { localRank, violation });
        }
      }
    }
  }
  const retainedKeys = new Set(retained.map(continuationBoundaryKey));
  const candidates = pass.spacing.continuations.flatMap((policy) => {
    const route = pass.routes[policy.routeIndex];
    const offendingVisits = offendingVisitsByRoute.get(policy.routeIndex);
    const boundary = {
      routeIndex: policy.routeIndex,
      afterVisitIndex: policy.afterVisitIndex,
    };
    const key = continuationBoundaryKey(boundary);
    return route &&
      offendingVisits &&
      policy.policy === 'equal' &&
      policy.reason !== 'bundle-safety' &&
      !retainedKeys.has(key) &&
      offendingVisits.has(policy.afterVisitIndex - 1) &&
      offendingVisits.has(policy.afterVisitIndex) &&
      (paddedCandidateRanks.has(key) ||
        (isDirectTerminalContinuationBridge(route) &&
          isSevereEndpointMisalignment(world, route) &&
          offendingVisits.has(0) &&
          offendingVisits.has(route.visits.length - 1)))
      ? [boundary]
      : [];
  });
  return ranked
    ? candidates.sort((left, right) => {
        const leftRank = paddedCandidateRanks.get(continuationBoundaryKey(left));
        const rightRank = paddedCandidateRanks.get(continuationBoundaryKey(right));
        return (
          Number(Boolean(rightRank)) - Number(Boolean(leftRank)) ||
          (rightRank?.violation ?? 0) - (leftRank?.violation ?? 0) ||
          (leftRank?.localRank ?? Number.POSITIVE_INFINITY) -
            (rightRank?.localRank ?? Number.POSITIVE_INFINITY) ||
          left.routeIndex - right.routeIndex ||
          left.afterVisitIndex - right.afterVisitIndex
        );
      })
    : candidates;
}

function continuationBoundaryKey(boundary: IndependentContinuationBoundary): string {
  return `${boundary.routeIndex}:${boundary.afterVisitIndex}`;
}

function isSevereEndpointMisalignment(world: CorridorWorld, route: Route): boolean {
  const ports = route.ports();
  const samples = [
    { endpoint: route.from, point: ports.from },
    { endpoint: route.to, point: ports.to },
  ].map(({ endpoint, point }) => {
    const span = faceCrossSpan(
      (world.sourceEntities ?? world.entities)[endpoint.entityIndex],
      endpoint.face,
    );
    const coordinate = endpoint.face === 'left' || endpoint.face === 'right' ? point.y : point.x;
    const halfSpan = (span[1] - span[0]) / 2;
    return {
      normalizedDeviation:
        halfSpan > 0
          ? Math.abs(coordinate - (endpoint.preferredTrack ?? midpoint(span))) / halfSpan
          : 0,
      edgeDistance: Math.min(coordinate - span[0], span[1] - coordinate),
    };
  });
  return (
    samples.every((sample) => sample.normalizedDeviation >= 0.5) &&
    samples.some((sample) => sample.edgeDistance <= PORT_EDGE_PADDING_PX)
  );
}

function isDirectTerminalContinuationBridge(route: Route): boolean {
  const oppositeFaces =
    (route.from.face === 'left' && route.to.face === 'right') ||
    (route.from.face === 'right' && route.to.face === 'left') ||
    (route.from.face === 'up' && route.to.face === 'down') ||
    (route.from.face === 'down' && route.to.face === 'up');
  return (
    oppositeFaces &&
    route.visits.length > 1 &&
    route.visits
      .slice(1)
      .every((visit) => visit.entry.kind === 'portal' && visit.entry.mode === 'continue-straight')
  );
}

export function introducesNoCapEvents(
  candidate: readonly RoutingQualityEvent[],
  incumbent: readonly RoutingQualityEvent[],
): boolean {
  return introducesNoTierEvents(candidate, incumbent, 'cap');
}

export function introducesNoInvalidEvents(
  candidate: readonly RoutingQualityEvent[],
  incumbent: readonly RoutingQualityEvent[],
): boolean {
  return introducesNoTierEvents(candidate, incumbent, 'invalid');
}

function introducesNoTierEvents(
  candidate: readonly RoutingQualityEvent[],
  incumbent: readonly RoutingQualityEvent[],
  tier: RoutingQualityTier,
): boolean {
  const available = qualityEventCounts(incumbent, tier);
  for (const event of candidate) {
    if (routingQualityTier(event.kind) !== tier) {
      continue;
    }
    const key = capEventKey(event);
    const remaining = available.get(key) ?? 0;
    if (remaining === 0) {
      return false;
    }
    available.set(key, remaining - 1);
  }
  return true;
}

function qualityEventCounts(
  events: readonly RoutingQualityEvent[],
  tier: RoutingQualityTier,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const event of events) {
    if (routingQualityTier(event.kind) === tier) {
      const key = capEventKey(event);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
  }
  return result;
}

function capEventKey(event: RoutingQualityEvent): string {
  if (event.kind === 'line-merge') {
    const merge = event as LineMergeQualityEvent;
    return `line-merge:${merge.corridorIndexes[0]}:${visitKey(merge.visits)}`;
  }
  if (event.kind === 'wall-touch') {
    const touch = event as WallTouchQualityEvent;
    return `wall-touch:${touch.routeIndex}:${touch.entityIndex}:${touch.face}:${touch.bendPointIndex}`;
  }
  return `${event.kind}:${[...event.routeIndexes].sort((a, b) => a - b).join(',')}:${[
    ...(event.corridorIndexes ?? []),
  ]
    .sort((a, b) => a - b)
    .join(',')}:${visitKey(event.visits ?? [])}`;
}

function visitKey(visits: readonly { routeIndex: number; visitIndex: number }[]): string {
  return visits
    .map((visit) => `${visit.routeIndex}:${visit.visitIndex}`)
    .sort()
    .join(',');
}
