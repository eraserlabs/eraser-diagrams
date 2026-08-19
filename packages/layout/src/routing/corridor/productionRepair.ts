import { dedupeContinuations, type IndependentContinuationBoundary } from './continuations.js';
import { leafCutKeys, leafRects, type LeafRect } from './leafCuts.js';
import { repairMergedSpacing } from './mergedSpacingRepair.js';
import { repairPortalJump, type PortalJumpRepairDiagnostics } from './portalJumpRepair.js';
import { compareRoutingQualityCosts } from './qualityCost.js';
import { violatesRepairIdentity } from './repairAcceptance.js';
import {
  realizeRoutes,
  reuseOptions,
  type RealizationReuseOptions,
  type RealizedRouteBatch,
} from './realize.js';
import { Route, cloneRoute } from './route.js';
import {
  boundaryKey,
  repairSelectedPortals,
  repairWallRoutes,
  type SelectedPortalRepairMetrics,
} from './selectedPortalRepair.js';
import { repairFanSpread } from './fanSpreadRepair.js';
import type { RouteSearchRequest } from './contract.js';
import type { CorridorWorld } from './world.js';

export interface ProductionRepairPortalDiagnostics {
  readonly metrics: SelectedPortalRepairMetrics;
  /** The phase produced geometry different from its input, before the outer production gate. */
  readonly changed: boolean;
  readonly accepted: boolean;
}

export const DEFAULT_PRODUCTION_REPAIR_TIME_BUDGET_MS = 100;

const PRODUCTION_REPAIR_PHASES = [
  'selectedPortal',
  'wallPortal',
  'mergedSpacing',
  'residualWallPortal',
  'endpointPortal',
  'fanSpread',
] as const;

export type ProductionRepairPhase = (typeof PRODUCTION_REPAIR_PHASES)[number];

/**
 * Relative share of the total time budget reserved for each phase, in execution
 * order. Deadlines are cumulative — a phase's deadline is the repair start plus
 * the budget times the normalized weight of itself and every earlier phase — so
 * a phase that finishes early donates its unused reservation to all later
 * phases, and no phase deadline can pass the outer deadline. The floors only
 * bind under scarcity: with a plentiful budget every phase finishes inside its
 * reservation and behavior is identical to one shared deadline.
 *
 * mergedSpacing runs a small fixed batch and takes no deadline; its row holds
 * its place in the cumulative ladder so later floors stay honest.
 *
 * A future phase claims a share by adding its row here (in
 * PRODUCTION_REPAIR_PHASES order); weights are normalized by the table total,
 * so existing phases shrink proportionally without further edits.
 */
const PHASE_BUDGET_WEIGHTS: Readonly<Record<ProductionRepairPhase, number>> = {
  selectedPortal: 40,
  wallPortal: 25,
  mergedSpacing: 10,
  residualWallPortal: 5,
  endpointPortal: 20,
  fanSpread: 10,
};

function phaseDeadlines(
  startedAt: number,
  timeBudgetMs: number,
  outerDeadlineAtMs: number,
): Record<ProductionRepairPhase, number> {
  const totalWeight = PRODUCTION_REPAIR_PHASES.reduce(
    (total, phase) => total + PHASE_BUDGET_WEIGHTS[phase],
    0,
  );
  const deadlines = {} as Record<ProductionRepairPhase, number>;
  let cumulativeWeight = 0;
  for (const phase of PRODUCTION_REPAIR_PHASES) {
    cumulativeWeight += PHASE_BUDGET_WEIGHTS[phase];
    deadlines[phase] = Math.min(
      outerDeadlineAtMs,
      startedAt + (timeBudgetMs * cumulativeWeight) / totalWeight,
    );
  }
  return deadlines;
}

interface ProductionRepairBudgetDiagnostics {
  readonly timeBudgetMs: number;
  readonly exhausted: boolean;
  readonly completedPhases: readonly ProductionRepairPhase[];
  readonly stoppedBeforePhase?: ProductionRepairPhase;
}

export interface ProductionRepairDiagnostics {
  readonly budget: ProductionRepairBudgetDiagnostics;
  readonly selectedPortal?: ProductionRepairPortalDiagnostics;
  readonly wallPortal?: ProductionRepairPortalDiagnostics;
  readonly residualWallPortal?: ProductionRepairPortalDiagnostics;
  readonly mergedSpacing?: {
    readonly acceptedContinuationBoundary?: IndependentContinuationBoundary;
    readonly changed: boolean;
    readonly accepted: boolean;
  };
  readonly endpointPortal?: PortalJumpRepairDiagnostics;
  readonly fanSpread?: {
    readonly changed: boolean;
    readonly accepted: boolean;
  };
}

export type ProductionRepairPhaseDiagnostics = NonNullable<
  ProductionRepairDiagnostics[ProductionRepairPhase]
>;

export interface ProductionRepairPhaseObservation {
  readonly phase: ProductionRepairPhase;
  readonly before: RealizedRouteBatch;
  readonly after: RealizedRouteBatch;
  readonly diagnostics: ProductionRepairPhaseDiagnostics;
}

type MutableProductionRepairDiagnostics = {
  -readonly [Phase in keyof Omit<ProductionRepairDiagnostics, 'budget'>]: Omit<
    ProductionRepairDiagnostics,
    'budget'
  >[Phase];
};

export interface ProductionRepairResult extends RealizedRouteBatch {
  readonly topologies: readonly Route[];
  readonly independentContinuations: readonly IndependentContinuationBoundary[];
  readonly diagnostics: ProductionRepairDiagnostics;
}

export interface ProductionRepairOptions extends RealizationReuseOptions {
  /** Total cooperative wall-clock budget. Infinity disables the production deadline. */
  readonly timeBudgetMs?: number;
  /**
   * Route indexes whose corridor topology must not change during repair
   * (authored / still-pinned drop lines). Topology-changing phases may still
   * run for peers; guarded slots are restored from the initial topologies
   * after every phase has run.
   */
  readonly guardedTopologyIndexes?: ReadonlySet<number>;
  /** Optional read-only observer of each completed production repair phase. */
  readonly onPhaseComplete?: (observation: ProductionRepairPhaseObservation) => void;
}

/** Authoritative post-spacing repair composition. Graders may observe this result, never select it. */
export function repairProductionRoutes(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  initialTopologies: readonly Route[],
  initial: RealizedRouteBatch,
  options: ProductionRepairOptions = {},
): ProductionRepairResult {
  const startedAt = performance.now();
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_PRODUCTION_REPAIR_TIME_BUDGET_MS;
  const incrementalSpacing = options.incrementalSpacing !== false;
  const incrementalEmission = options.incrementalEmission ?? incrementalSpacing;
  const incrementalLineMerges = options.incrementalLineMerges ?? incrementalEmission;
  if (Number.isNaN(timeBudgetMs) || timeBudgetMs < 0 || timeBudgetMs === Number.NEGATIVE_INFINITY) {
    throw new Error(`timeBudgetMs must be a non-negative number, got ${timeBudgetMs}`);
  }
  const deadlineAtMs =
    timeBudgetMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : startedAt + timeBudgetMs;
  const phaseDeadlineAtMs = phaseDeadlines(startedAt, timeBudgetMs, deadlineAtMs);
  let incumbent = initial;
  let topologies = [...initialTopologies];
  let independentContinuations: IndependentContinuationBoundary[] = [];
  const leaves = leafRects(world);
  const endpointProtectedRouteIndexes = new Set<number>();
  const diagnostics: MutableProductionRepairDiagnostics = {};
  const completedPhases: ProductionRepairPhase[] = [];

  const deadlineReached = (): boolean => performance.now() >= deadlineAtMs;
  const completePhase = (phase: ProductionRepairPhase): void => {
    completedPhases.push(phase);
  };
  const observePhase = (
    phase: ProductionRepairPhase,
    before: RealizedRouteBatch,
    phaseDiagnostics: ProductionRepairPhaseDiagnostics,
  ): void => {
    options.onPhaseComplete?.({ phase, before, after: incumbent, diagnostics: phaseDiagnostics });
  };
  const finish = (stoppedBeforePhase?: ProductionRepairPhase): ProductionRepairResult => ({
    ...incumbent,
    topologies,
    independentContinuations,
    diagnostics: {
      ...diagnostics,
      budget: {
        timeBudgetMs,
        exhausted: deadlineReached(),
        completedPhases,
        ...(stoppedBeforePhase ? { stoppedBeforePhase } : {}),
      },
    },
  });

  if (deadlineReached()) {
    return finish('selectedPortal');
  }
  let phaseInput = incumbent;
  const selected = repairSelectedPortals(world, requests, topologies, incumbent, {
    deadlineAtMs: phaseDeadlineAtMs.selectedPortal,
    incrementalSpacing,
    incrementalEmission,
    incrementalLineMerges,
  });
  const selectedAssessment = assessPhase(leaves, world.entities.length, incumbent, selected);
  const selectedAccepted = selectedAssessment.accepted;
  if (selectedAccepted) {
    incumbent = selected;
    topologies = [...selected.topologies];
    independentContinuations = [...selected.independentContinuations];
  }
  diagnostics.selectedPortal = portalDiagnostics(
    selected,
    selectedAssessment.changed,
    selectedAccepted,
  );
  observePhase('selectedPortal', phaseInput, diagnostics.selectedPortal);
  completePhase('selectedPortal');

  if (deadlineReached()) {
    return finish('wallPortal');
  }
  phaseInput = incumbent;
  const wall = repairWallRoutes(world, requests, topologies, incumbent, {
    deadlineAtMs: phaseDeadlineAtMs.wallPortal,
    incrementalSpacing,
    incrementalEmission,
    incrementalLineMerges,
  });
  const wallAssessment = assessPhase(leaves, world.entities.length, incumbent, wall);
  const wallAccepted = wallAssessment.accepted;
  if (wallAccepted) {
    addCorridorPreservingRepairIndexes(endpointProtectedRouteIndexes, wall.metrics);
    incumbent = wall;
    topologies = [...wall.topologies];
    independentContinuations = [...wall.independentContinuations];
  }
  diagnostics.wallPortal = portalDiagnostics(wall, wallAssessment.changed, wallAccepted);
  observePhase('wallPortal', phaseInput, diagnostics.wallPortal);
  completePhase('wallPortal');

  if (deadlineReached()) {
    return finish('mergedSpacing');
  }
  // repairMergedSpacing cannot observe a deadline once started, so it is only
  // admitted while its slot is still open (before wallPortal's cumulative
  // deadline, where its own reservation begins). Started any later, its fixed
  // batch would spend the floors reserved for the remaining phases; denial
  // falls through to the later phases instead of ending the repair.
  let mergedChangedGeometry = false;
  if (performance.now() < phaseDeadlineAtMs.wallPortal) {
    phaseInput = incumbent;
    const merged = repairMergedSpacing(world, incumbent, {
      incrementalSpacing,
      incrementalEmission,
      incrementalLineMerges,
    });
    const mergedAssessment = assessPhase(leaves, world.entities.length, incumbent, merged);
    const mergedCandidateChanged = mergedAssessment.changed;
    const mergedAccepted = mergedAssessment.accepted;
    if (mergedAccepted) {
      incumbent = merged;
    }
    mergedChangedGeometry = mergedAccepted && mergedCandidateChanged;
    independentContinuations = dedupeContinuations([
      ...independentContinuations,
      ...(merged.acceptedContinuationBoundary ? [merged.acceptedContinuationBoundary] : []),
    ]);
    diagnostics.mergedSpacing = {
      ...(merged.acceptedContinuationBoundary
        ? { acceptedContinuationBoundary: merged.acceptedContinuationBoundary }
        : {}),
      changed: mergedCandidateChanged,
      accepted: mergedAccepted,
    };
    observePhase('mergedSpacing', phaseInput, diagnostics.mergedSpacing);
    completePhase('mergedSpacing');
  }

  // Merged-spacing changes can expose wall costs that the first wall pass could not observe.
  if (mergedChangedGeometry) {
    if (deadlineReached()) {
      return finish('residualWallPortal');
    }
    phaseInput = incumbent;
    const residualWall = repairWallRoutes(world, requests, topologies, incumbent, {
      initialIndependentContinuations: independentContinuations,
      deadlineAtMs: phaseDeadlineAtMs.residualWallPortal,
      incrementalSpacing,
      incrementalEmission,
      incrementalLineMerges,
    });
    const residualWallAssessment = assessPhase(
      leaves,
      world.entities.length,
      incumbent,
      residualWall,
    );
    const residualWallAccepted = residualWallAssessment.accepted;
    if (residualWallAccepted) {
      addCorridorPreservingRepairIndexes(endpointProtectedRouteIndexes, residualWall.metrics);
      incumbent = residualWall;
      topologies = [...residualWall.topologies];
      independentContinuations = [...residualWall.independentContinuations];
    }
    diagnostics.residualWallPortal = portalDiagnostics(
      residualWall,
      residualWallAssessment.changed,
      residualWallAccepted,
    );
    observePhase('residualWallPortal', phaseInput, diagnostics.residualWallPortal);
    completePhase('residualWallPortal');
  }

  if (deadlineReached()) {
    return finish('endpointPortal');
  }
  phaseInput = incumbent;
  const endpoint = repairPortalJump(world, requests, topologies, incumbent, {
    protectedRouteIndexes: endpointProtectedRouteIndexes,
    realization: {
      independentContinuations,
      incrementalEmission,
      incrementalLineMerges,
    },
    deadlineAtMs: phaseDeadlineAtMs.endpointPortal,
  });
  const endpointAccepted = assessPhase(leaves, world.entities.length, incumbent, endpoint).accepted;
  if (endpointAccepted) {
    incumbent = endpoint;
    topologies = [...endpoint.topologies];
    independentContinuations = [...endpoint.independentContinuations];
  }
  diagnostics.endpointPortal = {
    accepted: endpointAccepted,
  };
  observePhase('endpointPortal', phaseInput, diagnostics.endpointPortal);
  completePhase('endpointPortal');

  if (deadlineReached()) {
    return finish('fanSpread');
  }
  phaseInput = incumbent;
  const fan = repairFanSpread(world, requests, topologies, incumbent, {
    deadlineAtMs: phaseDeadlineAtMs.fanSpread,
    leaves,
    entityCount: world.entities.length,
    protectedRouteIndexes: endpointProtectedRouteIndexes,
    realization: {
      independentContinuations,
      incrementalEmission,
      incrementalLineMerges,
    },
  });
  if (fan.accepted) {
    incumbent = fan.batch;
    topologies = [...fan.topologies];
  }
  diagnostics.fanSpread = {
    changed: fan.changed,
    accepted: fan.accepted,
  };
  observePhase('fanSpread', phaseInput, diagnostics.fanSpread);
  completePhase('fanSpread');

  const guardedTopologyIndexes = options.guardedTopologyIndexes;
  if (guardedTopologyIndexes !== undefined && guardedTopologyIndexes.size > 0) {
    const needsRestore = [...guardedTopologyIndexes].some((index) => {
      const baseline = initialTopologies[index];
      const current = topologies[index];
      return (
        baseline === undefined || current === undefined || changedTopology([baseline], [current])
      );
    });
    if (needsRestore) {
      topologies = topologies.map((route, index) =>
        guardedTopologyIndexes.has(index)
          ? cloneRoute(initialTopologies[index], route.requestIndex)
          : cloneRoute(route),
      );
      incumbent = realizeRoutes(world, topologies, {
        continuationCutSelection: 'exhaustive',
        independentContinuations,
        ...reuseOptions({ incrementalEmission, incrementalLineMerges }, incumbent),
      });
    }
  }

  return finish();
}

function assessPhase(
  leaves: readonly LeafRect[],
  entityCount: number,
  incumbent: RealizedRouteBatch,
  candidate: RealizedRouteBatch,
): { readonly changed: boolean; readonly accepted: boolean } {
  const changed = changedGeometry(incumbent.routes, candidate.routes);
  const accepted =
    changed &&
    compareRoutingQualityCosts(candidate.quality.cost, incumbent.quality.cost) < 0 &&
    !violatesRepairIdentity(
      candidate.routes,
      leafCutKeys(candidate.routes, candidate.geometryQuality.index, leaves, entityCount),
      leafCutKeys(incumbent.routes, incumbent.geometryQuality.index, leaves, entityCount),
    );
  return { changed, accepted };
}

function portalDiagnostics(
  result: {
    readonly metrics: SelectedPortalRepairMetrics;
  },
  changed: boolean,
  accepted: boolean,
): ProductionRepairPortalDiagnostics {
  return {
    metrics: result.metrics,
    changed,
    accepted,
  };
}

function changedTopology(left: readonly Route[], right: readonly Route[]): boolean {
  return left.some((route, routeIndex) => {
    const candidate = right[routeIndex];
    return (
      !candidate ||
      route.visits.length !== candidate.visits.length ||
      route.visits.some(
        (visit, visitIndex) =>
          visit.corridorIndex !== candidate.visits[visitIndex]?.corridorIndex ||
          boundaryKey(visit.entry) !== boundaryKey(candidate.visits[visitIndex]?.entry) ||
          boundaryKey(visit.exit) !== boundaryKey(candidate.visits[visitIndex]?.exit),
      )
    );
  });
}

function addCorridorPreservingRepairIndexes(
  target: Set<number>,
  metrics: SelectedPortalRepairMetrics,
): void {
  for (const candidate of metrics.candidates) {
    if (candidate.status === 'accepted' && candidate.requiredCorridorIndex !== undefined) {
      target.add(candidate.routeIndex);
    }
  }
}

function changedGeometry(left: readonly Route[], right: readonly Route[]): boolean {
  return left.some((route, routeIndex) => {
    const candidatePoints = right[routeIndex]?.points();
    const points = route.points();
    return (
      !candidatePoints ||
      points.length !== candidatePoints.length ||
      points.some(
        (point, pointIndex) =>
          point.x !== candidatePoints[pointIndex].x || point.y !== candidatePoints[pointIndex].y,
      )
    );
  });
}
