import type { Axis, AxisSpan, Direction } from '../../types.js';
import type { EndpointSide } from '../types.js';
import {
  clamp,
  coordinateInSpan,
  insetSpan,
  intersectSpans,
  midpoint,
  spanContains,
  spanLength,
  spansOverlapPositive,
} from '../../rangeUtils.js';
import type {
  Corridor,
  CorridorBorderSpan,
  PortalRef,
  ProfiledCorridor,
  RouteEndpoint,
} from './contract.js';
import {
  buildContinuationBoundaryRealizations,
  continuationBundlePlacement,
  type ContinuationGeometryTuning,
} from './continuationGeometry.js';
import {
  continuedSourceTerminalLeadRunEnd,
  continuedTargetTerminalLeadRunStart,
  continuationRoots,
  endpointNeedsTerminalLead,
  isStraightContinuationBoundary,
  mergeContinuationComponentUnit,
  planContinuationPolicies,
  visitHasContinuationBoundary,
  type ContinuationBoundaryPolicy,
  type ContinuationPolicyTuning,
  type FlexibleContinuationRef,
} from './continuationPolicy.js';
import {
  continuationKey,
  continuationKeySet,
  type IndependentContinuationBoundary,
} from './continuations.js';
import {
  boundaryTravelCoordinate,
  corridorCenter,
  corridorCrossSpan,
  endpointCrossCoordinate,
  faceCrossSpan,
  possibleTravelInterval,
  terminalFacePlane,
} from './geometry.js';
import type { CorridorOrderGroup, OrderedVisitRef, OrderingResult } from './ordering.js';
import {
  ROUTING_QUALITY_COSTS,
  RoutingQualityLedger,
  spacingDeficitCost,
  type LineMergeQualityEvent,
  type MissingSpacingContentionQualityEvent,
  type RoutingQualityEvent,
  type RoutingQualityScalarCosts,
  type RoutingQualitySnapshot,
  type RoutingQualityVisitRef,
  type SpacingDeficitQualityEvent,
} from './qualityCost.js';
import type { BoundaryRealization, Route, VisitBoundary } from './route.js';
import type { RouteIndexer } from './routeIndex.js';
import {
  canFitOrderedSpacingGap,
  COMPONENT_SOLVER_TOLERANCE,
  createSpacingKernelWorkspace,
  InfeasibleSpacingComponentError,
  maximumFeasibleSpacingGap,
  solveSpacingKernel,
  type CapacityReduction,
  type ComponentSolveMetrics,
  type SpacingGapConstraint,
  type SpacingKernelWorkspace,
  type SpacingKernelResult,
  type SpacingKernelUnit,
} from './spacingKernel.js';
import { compileTrackDesires, type TrackDesire } from './spacingObjective.js';
import { createUnionFind, type UnionFind } from './unionFind.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;

interface PaddedCutWorkspace {
  readonly unionFind: UnionFind;
  lowerBounds: Float64Array<ArrayBuffer>;
  upperBounds: Float64Array<ArrayBuffer>;
  boundMarks: Uint32Array<ArrayBuffer>;
  generation: number;
  readonly roots: number[];
}

export interface SpacingRunWorkspace {
  readonly continuationUnionFind: UnionFind;
  readonly paddedCut: PaddedCutWorkspace;
  readonly trackUnitUnionFind: UnionFind;
  readonly contentionUnionFind: UnionFind;
  readonly kernel: SpacingKernelWorkspace;
}

/** A corridor-local solve failed; every listed route must leave the strict realization batch. */
export class CorridorSpacingError extends Error {
  readonly corridorIndex: number;
  readonly corridorIndexes: readonly number[];
  readonly routeIndexes: readonly number[];

  constructor(
    corridorIndexes: number | readonly number[],
    routeIndexes: readonly number[],
    message: string,
    options?: ErrorOptions,
  ) {
    const uniqueCorridorIndexes = [
      ...new Set(typeof corridorIndexes === 'number' ? [corridorIndexes] : corridorIndexes),
    ].sort((left, right) => left - right);
    const corridorLabel =
      uniqueCorridorIndexes.length === 1
        ? `corridor ${uniqueCorridorIndexes[0]}`
        : `corridors ${uniqueCorridorIndexes.join(',')}`;
    super(`${corridorLabel}: ${message}`, options);
    this.name = 'CorridorSpacingError';
    this.corridorIndex = uniqueCorridorIndexes[0];
    this.corridorIndexes = uniqueCorridorIndexes;
    this.routeIndexes = [...new Set(routeIndexes)].sort((left, right) => left - right);
  }
}

/** Mutable scratch explicitly owned by one synchronous realization or spacing call. */
export function createSpacingRunWorkspace(): SpacingRunWorkspace {
  return {
    continuationUnionFind: createUnionFind(),
    paddedCut: {
      unionFind: createUnionFind(),
      lowerBounds: new Float64Array(0),
      upperBounds: new Float64Array(0),
      boundMarks: new Uint32Array(0),
      generation: 0,
      roots: [],
    },
    trackUnitUnionFind: createUnionFind(),
    contentionUnionFind: createUnionFind(),
    kernel: createSpacingKernelWorkspace(),
  };
}

export const MIN_TRACK_SEPARATION_PX = 8;
const CORRIDOR_EDGE_PADDING_PX = 4;
export const PORT_EDGE_PADDING_PX = 8;
const IDEAL_TERMINAL_SEPARATION_PX = 16;
const TERMINAL_LEAD_PX = 40;
const SOURCE_TERMINAL_LEAD_PX = 16;
const U_TURN_DEPTH_PX = 24;
const ENDPOINT_DESIRE_WEIGHT = 8;
const DIRECT_FAN_FACE_SPAN_PX = 200;
const TERMINAL_CORRIDOR_IDEAL_WEIGHT = 2;
const U_TURN_CORRIDOR_IDEAL_WEIGHT = 4;
const CORRIDOR_IDEAL_DESIRE_WEIGHT = 0.05;
const CORRIDOR_IDEAL_EDGE_OFFSET_PX = 4;
const BOUNDARY_SHIFT_DEPTH_PX = 24;
const CONTINUATION_NARROW_SPAN_PX = 40;
const CONTINUATION_TERMINAL_CONFLICT_PX = 16;

const CONTINUATION_GEOMETRY_TUNING: ContinuationGeometryTuning = {
  minimumTrackSeparation: MIN_TRACK_SEPARATION_PX,
  corridorEdgePadding: CORRIDOR_EDGE_PADDING_PX,
  boundaryShiftDepth: BOUNDARY_SHIFT_DEPTH_PX,
};

const CONTINUATION_POLICY_TUNING: ContinuationPolicyTuning = {
  minimumTrackSeparation: MIN_TRACK_SEPARATION_PX,
  corridorEdgePadding: CORRIDOR_EDGE_PADDING_PX,
  directFanFaceSpan: DIRECT_FAN_FACE_SPAN_PX,
  narrowSpan: CONTINUATION_NARROW_SPAN_PX,
  terminalConflict: CONTINUATION_TERMINAL_CONFLICT_PX,
};

type SpacingShortfallKind =
  | 'corridor-padding'
  | 'port-padding'
  | 'minimum-separation'
  | 'combined-port'
  | 'straight-continuation'
  | 'quantization';

export interface SpacingShortfall {
  readonly kind: SpacingShortfallKind;
  readonly reason?: 'empty-padded-intersection';
  /** Strict boundaries whose removal mathematically reduces this component deficit. */
  readonly candidateContinuations?: readonly IndependentContinuationBoundary[];
  readonly corridorIndex: number;
  readonly routeIndexes: readonly number[];
  readonly visitIndexes: readonly number[];
  readonly required: number;
  readonly achieved: number;
}

interface SpacingMetrics {
  readonly variableCount: number;
  readonly shortfallCount: number;
  readonly converged: boolean;
  readonly quantizationViolationCount: number;
  /** Present when this pass selectively reused unaffected corridors from an earlier realization. */
  readonly incremental?: { readonly reusedCorridorCount: number };
}

export interface SpacingResult {
  readonly shortfalls: readonly SpacingShortfall[];
  readonly continuations: readonly ContinuationBoundaryPolicy[];
  readonly quality: RoutingQualitySnapshot;
  readonly metrics: SpacingMetrics;
}

interface IncrementalSpacingBaseline {
  readonly routes: readonly Route[];
  readonly spacing: SpacingResult;
  readonly seedCorridorIndexes: readonly number[];
}

export interface SpacingOptions {
  /** Sparse repair input; every requested boundary must remain independently realizable. */
  readonly independentContinuations?: readonly IndependentContinuationBoundary[];
  /** Multi-route turn-mouth relaxation is opt-in by corridor. */
  readonly turnRetrackCorridors?: ReadonlySet<number>;
  /** Repair-only candidate: move continuation jog bundles off perpendicular realized tracks. */
  readonly continuationTrackClearance?: boolean;
  /** Allow terminal-center conflicts to relax straight-continuation equality. */
  readonly terminalCenterContinuations?: boolean;
  /** Optional progressive ledger shared with topology, text, emission, or repair. */
  readonly qualityLedger?: RoutingQualityLedger;
  /** Emitted geometry proved these visit pairs share positive travel in one corridor. */
  readonly requiredContentions?: readonly MissingSpacingContentionQualityEvent[];
  /** Optional run-owned scratch reused by sequential solves; never shared implicitly. */
  readonly workspace?: SpacingRunWorkspace;
  /** Reuse unaffected corridors from a prior solve over the same topology and ordering. */
  readonly incrementalBaseline?: IncrementalSpacingBaseline;
}

interface EndpointGroupRef {
  readonly entityIndex: number;
  readonly face: Direction;
  readonly portGroup: number;
}

const EMPTY_ROUTE_ENDPOINTS: readonly RouteEndpoint[] = Object.freeze([]);
const EMPTY_ENDPOINT_GROUPS: readonly EndpointGroupRef[] = Object.freeze([]);

/** Immutable visit-level scalar specification; the solved value is stored on `Route`. */
interface TrackVariable {
  readonly ref: OrderedVisitRef;
  readonly travelInterval: AxisSpan;
  readonly lower: number;
  readonly upper: number;
  readonly desires: readonly TrackDesire[];
  readonly authored: boolean;
  readonly endpointGroups: readonly EndpointGroupRef[];
  readonly requiredContentionVisitKeys?: ReadonlySet<string>;
}

interface PaddingRule {
  readonly kind: 'corridor-padding' | 'port-padding';
  readonly container: AxisSpan;
  readonly padding: number;
}

interface DeferredPaddingShortfall {
  readonly ref: OrderedVisitRef;
  readonly rule: PaddingRule;
}

interface TrackUnit extends SpacingKernelUnit {
  readonly members: readonly TrackVariable[];
}

interface TerminalMember {
  readonly routeIndex: number;
  readonly visitIndex: number;
  readonly endpoint: RouteEndpoint;
  readonly opposite: RouteEndpoint;
}

interface TerminalFacePreference {
  readonly entityIndex: number;
  readonly face: Direction;
  readonly members: TerminalMember[];
}

interface DesiredTracks {
  readonly values: readonly Float64Array[];
  readonly desires: readonly (readonly (readonly TrackDesire[])[])[];
}

interface CorridorIdealSeed {
  readonly track: number;
  readonly weight: number;
  readonly policy?: CorridorIdealPolicy;
}

type CorridorIdealPolicy =
  | {
      readonly kind: 'terminal-lead';
      readonly desiredTrack: number;
      readonly plane: number;
      readonly direction: 'negative' | 'positive';
    }
  | {
      readonly kind: 'terminal-window';
      readonly desiredTrack: number;
      readonly lower: number;
      readonly upper: number;
    }
  | {
      readonly kind: 'u-turn';
      readonly desiredTrack: number;
    };

interface CorridorWork {
  readonly group: CorridorOrderGroup;
  readonly units: readonly TrackUnit[];
  readonly contentionComponents: readonly (readonly number[])[];
  readonly deferredPaddingShortfalls?: readonly DeferredPaddingShortfall[];
}

interface ContinuedSolveResult {
  readonly metrics: ComponentSolveMetrics;
  readonly boundaryRealizationsByRoute: readonly (readonly BoundaryRealization[])[];
  readonly policies: readonly ContinuationBoundaryPolicy[];
}

interface ContinuedConfigurationResult {
  readonly metrics: ComponentSolveMetrics;
  readonly boundaryRealizationsByRoute: readonly (readonly BoundaryRealization[])[];
  readonly tracksByRoute: readonly Float64Array[];
  readonly shortfalls: readonly SpacingShortfall[];
  readonly desireCostByCorridor: ReadonlyMap<number, number>;
}

interface BoundaryBundleMember {
  readonly routeIndex: number;
  readonly hostCorridorIndex: number;
  readonly hostGlobalUnit: number;
  readonly mouthVisitIndex: number;
  readonly mouthGlobalUnit: number;
}

interface TurnShiftRef {
  readonly routeIndex: number;
  readonly realizationIndex: number;
  readonly shiftIndex: number;
  readonly hostAxis: Axis;
  readonly routeTrack: number;
  readonly routeRun: AxisSpan;
  readonly portalCoordinate: number;
  readonly portalTrack: number;
  readonly shiftCoordinate: number;
}

interface SelectiveSpacingState {
  readonly baseline: IncrementalSpacingBaseline;
  readonly reusableRouteIndexes: ReadonlySet<number>;
  readonly activeCorridorIndexes: ReadonlySet<number>;
}

interface UncommittedSpacingResult {
  readonly spacing: SpacingResult;
  readonly tracksByRoute: readonly Float64Array[];
  readonly boundaryRealizationsByRoute: readonly (readonly BoundaryRealization[])[];
}

/** Whether a baseline route can safely donate tracks to a selective spacing solve. */
export function haveSameSpacingInputs(route: Route, baseline: Route): boolean {
  return (
    route.requestIndex === baseline.requestIndex &&
    sameSpacingEndpoint(route.from, baseline.from) &&
    sameSpacingEndpoint(route.to, baseline.to) &&
    route.visits.length === baseline.visits.length &&
    route.visits.every((visit, visitIndex) => {
      const baselineVisit = baseline.visits[visitIndex];
      return (
        visit.corridorIndex === baselineVisit.corridorIndex &&
        visit.feasibleTrack[0] === baselineVisit.feasibleTrack[0] &&
        visit.feasibleTrack[1] === baselineVisit.feasibleTrack[1] &&
        boundaryIdentity(visit.entry) === boundaryIdentity(baselineVisit.entry) &&
        boundaryIdentity(visit.exit) === boundaryIdentity(baselineVisit.exit)
      );
    })
  );
}

/** Project every interval-connected corridor group into legal tracks, then commit tracks. */
export function spaceRoutes(
  world: CorridorWorld,
  routes: readonly Route[],
  ordering: OrderingResult,
  options: SpacingOptions = {},
): SpacingResult {
  const incremental = options.incrementalBaseline;
  if (!incremental || incremental.seedCorridorIndexes.length === 0) {
    const solved = solveSpacingRoutes(world, routes, ordering, options);
    commitSpacing(routes, solved);
    return solved.spacing;
  }

  const activeCorridorIndexes = new Set(incremental.seedCorridorIndexes);
  const reusableRouteIndexes = reusableIncrementalRouteIndexes(
    routes,
    incremental.routes,
    activeCorridorIndexes,
  );
  expandStraightContinuationCorridors(routes, activeCorridorIndexes);
  const solved = solveSpacingRoutes(world, routes, ordering, options, {
    baseline: incremental,
    reusableRouteIndexes,
    activeCorridorIndexes,
  });

  const spacing: SpacingResult = {
    ...solved.spacing,
    metrics: {
      ...solved.spacing.metrics,
      incremental: {
        reusedCorridorCount: ordering.groups.filter(
          (group) => !activeCorridorIndexes.has(group.corridorIndex),
        ).length,
      },
    },
  };
  commitSpacing(routes, solved);
  return spacing;
}

function solveSpacingRoutes(
  world: CorridorWorld,
  routes: readonly Route[],
  ordering: OrderingResult,
  options: SpacingOptions,
  selective?: SelectiveSpacingState,
): UncommittedSpacingResult {
  const workspace = options.workspace ?? createSpacingRunWorkspace();
  const qualityLedger = options.qualityLedger ?? new RoutingQualityLedger();
  qualityLedger.removeStage('spacing');
  if (selective) {
    for (const source of selective.baseline.spacing.quality.sources) {
      const corridorIndex = spacingQualitySourceCorridorIndex(source.source);
      const touchesActiveCorridor =
        corridorIndex === undefined
          ? source.events.some((event) =>
              event.corridorIndexes?.some((index) => selective.activeCorridorIndexes.has(index)),
            )
          : selective.activeCorridorIndexes.has(corridorIndex);
      if (!touchesActiveCorridor) {
        qualityLedger.replaceSource(source.source, source.stage, source.events, source.scalarCosts);
      }
    }
  }
  const desiredTracks = buildDesiredTracks(world, routes, ordering);
  const requiredContentionsByVisit = indexRequiredContentions(options.requiredContentions ?? []);
  const tracksByRoute = routes.map((route, routeIndex) => {
    if (route.visits.length > 0) {
      route.assertOrdered();
    }
    const tracks = selective?.reusableRouteIndexes.has(routeIndex)
      ? Float64Array.from(
          route.visits.map((_, visitIndex) =>
            selective.baseline.routes[routeIndex].nominalTrackOf(visitIndex),
          ),
        )
      : new Float64Array(route.visits.length);
    if (!selective?.reusableRouteIndexes.has(routeIndex)) {
      tracks.fill(Number.NaN);
    }
    return tracks;
  });
  const shortfalls: SpacingShortfall[] = selective
    ? selective.baseline.spacing.shortfalls.filter(
        (shortfall) => !selective.activeCorridorIndexes.has(shortfall.corridorIndex),
      )
    : [];
  const continuedCorridors = straightContinuationCorridors(routes);
  const continuedWorks: CorridorWork[] = [];
  let kernelMetrics: ComponentSolveMetrics = {
    converged: true,
    quantizationViolationCount: 0,
  };
  const addKernelMetrics = (metrics: ComponentSolveMetrics): void => {
    kernelMetrics = {
      converged: kernelMetrics.converged && metrics.converged,
      quantizationViolationCount:
        kernelMetrics.quantizationViolationCount + metrics.quantizationViolationCount,
    };
  };
  const buildVariablesFor = (
    group: CorridorOrderGroup,
    shortfallSink: SpacingShortfall[],
    relaxedVisits: ReadonlySet<string> | undefined,
    relaxPadding = false,
  ): TrackVariable[] =>
    group.members.map((ref) =>
      buildVariable(
        world,
        routes,
        desiredTracks,
        group.corridorIndex,
        ref,
        shortfallSink,
        relaxedVisits?.has(visitKey(ref.routeIndex, ref.visitIndex)) ?? false,
        relaxPadding,
        requiredContentionsByVisit,
      ),
    );
  /** Drop only soft padding that makes the already-selected order infeasible at zero gap. */
  const relaxPaddingUntilFeasible = (
    group: CorridorOrderGroup,
    relaxedVisits: ReadonlySet<string>,
  ): {
    readonly units: TrackUnit[];
    readonly shortfalls: SpacingShortfall[];
    readonly deferredPaddingShortfalls: DeferredPaddingShortfall[];
  } => {
    const groupShortfalls: SpacingShortfall[] = [];
    let variables = buildVariablesFor(group, groupShortfalls, relaxedVisits, true);
    const deferredPaddingShortfalls: DeferredPaddingShortfall[] = [];
    for (let variableIndex = 0; variableIndex < variables.length; variableIndex += 1) {
      const ref = group.members[variableIndex];
      for (const rule of variablePaddingRules(world, routes, group.corridorIndex, ref)) {
        const variable = variables[variableIndex];
        const padded = insetSpan(rule.container, rule.padding, EPSILON);
        const bounds = padded
          ? intersectSpans([variable.lower, variable.upper], padded, EPSILON)
          : undefined;
        if (!bounds) {
          groupShortfalls.push({
            kind: rule.kind,
            corridorIndex: group.corridorIndex,
            routeIndexes: [ref.routeIndex],
            visitIndexes: [ref.visitIndex],
            required: rule.padding,
            achieved: maximumClearance([variable.lower, variable.upper], rule.container),
          });
          continue;
        }
        const candidateVariables = variables.slice();
        candidateVariables[variableIndex] = {
          ...variable,
          lower: bounds[0],
          upper: bounds[1],
        };
        const candidateUnits = buildUnits(group, candidateVariables, [], workspace);
        if (canFitOrderedSpacingGap(candidateUnits, undefined, 0)) {
          variables = candidateVariables;
        } else {
          deferredPaddingShortfalls.push({ ref, rule });
        }
      }
    }
    return {
      units: buildUnits(group, variables, groupShortfalls, workspace),
      shortfalls: groupShortfalls,
      deferredPaddingShortfalls,
    };
  };
  for (const group of ordering.groups) {
    if (selective && !selective.activeCorridorIndexes.has(group.corridorIndex)) {
      continue;
    }
    const continued = continuedCorridors.has(group.corridorIndex);
    const strictShortfalls: SpacingShortfall[] = [];
    const strictVariables = buildVariablesFor(group, strictShortfalls, undefined);
    const strictUnits = buildUnits(group, strictVariables, strictShortfalls, workspace);
    const strictContentionComponents = buildContentionComponents(
      strictUnits,
      workspace.contentionUnionFind,
    );
    const mandatoryRelaxedVisits = continued
      ? new Set<string>()
      : congestedTurnVisits(
          world,
          routes,
          strictUnits,
          strictContentionComponents,
          2,
          true,
          COMPONENT_SOLVER_TOLERANCE,
        );
    const candidateRelaxedVisits = options.turnRetrackCorridors?.has(group.corridorIndex)
      ? congestedTurnVisits(
          world,
          routes,
          strictUnits,
          strictContentionComponents,
          Number.POSITIVE_INFINITY,
          false,
          Number.POSITIVE_INFINITY,
        )
      : new Set<string>();
    const relaxedVisits = new Set([...mandatoryRelaxedVisits, ...candidateRelaxedVisits]);
    let groupShortfalls = relaxedVisits.size === 0 ? strictShortfalls : [];
    const variables =
      relaxedVisits.size === 0
        ? strictVariables
        : buildVariablesFor(group, groupShortfalls, relaxedVisits);
    let units =
      relaxedVisits.size === 0
        ? strictUnits
        : buildUnits(group, variables, groupShortfalls, workspace);
    let deferredPaddingShortfalls: DeferredPaddingShortfall[] | undefined;
    if (!continued && !canFitOrderedSpacingGap(units, undefined, 0)) {
      const relaxed = relaxPaddingUntilFeasible(group, relaxedVisits);
      groupShortfalls = relaxed.shortfalls;
      units = relaxed.units;
      deferredPaddingShortfalls = relaxed.deferredPaddingShortfalls;
    }
    shortfalls.push(...groupShortfalls);
    const contentionComponents =
      units === strictUnits
        ? strictContentionComponents
        : buildContentionComponents(units, workspace.contentionUnionFind);
    const work = {
      group,
      units,
      contentionComponents,
      deferredPaddingShortfalls,
    };
    if (continued) {
      continuedWorks.push(work);
    } else {
      addKernelMetrics(
        solveIndependentCorridor(work, tracksByRoute, shortfalls, qualityLedger, workspace),
      );
    }
  }
  const continuedResult = solveContinuedCorridors(
    world,
    routes,
    continuedWorks,
    tracksByRoute,
    shortfalls,
    options.independentContinuations ?? [],
    options.terminalCenterContinuations ?? false,
    options.continuationTrackClearance ?? false,
    qualityLedger,
    workspace,
  );
  addKernelMetrics(continuedResult.metrics);
  const turnRealizationsByRoute = buildTurnBoundaryRealizations(world, routes, tracksByRoute);
  const continuationPolicies = mergeContinuationPolicies(
    routes,
    selective,
    continuedResult.policies,
  );
  const boundaryRealizationsByRoute = routes.map((route, routeIndex) => {
    const retainedContinuations = selective
      ? baselineContinuationRealizations(
          route,
          selective.baseline.routes[routeIndex],
          selective.activeCorridorIndexes,
          selective.reusableRouteIndexes.has(routeIndex),
        )
      : [];
    return [
      ...retainedContinuations,
      ...continuedResult.boundaryRealizationsByRoute[routeIndex],
      ...turnRealizationsByRoute[routeIndex],
    ].sort((left, right) => left.afterVisitIndex - right.afterVisitIndex);
  });
  let variableCount = 0;
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (route.visits.length === 0) {
      continue;
    }
    variableCount += route.visits.length;
    for (let visitIndex = 0; visitIndex < route.visits.length; visitIndex += 1) {
      if (!Number.isFinite(tracksByRoute[routeIndex][visitIndex])) {
        throw new Error(`route ${route.requestIndex}: visit ${visitIndex} was not spaced`);
      }
    }
  }

  if (selective) {
    normalizeSpacingQualitySources(qualityLedger, ordering, continuedCorridors);
  }
  return {
    tracksByRoute,
    boundaryRealizationsByRoute,
    spacing: {
      shortfalls: selective
        ? orderSpacingShortfalls(shortfalls, ordering, continuedCorridors)
        : shortfalls,
      continuations: continuationPolicies,
      quality: qualityLedger.snapshot(),
      metrics: {
        variableCount,
        shortfallCount: shortfalls.length,
        ...kernelMetrics,
      },
    },
  };
}

function commitSpacing(routes: readonly Route[], solved: UncommittedSpacingResult): void {
  routes.forEach((route, routeIndex) => {
    if (route.visits.length === 0) {
      return;
    }
    route.setNominalTracks(
      solved.tracksByRoute[routeIndex],
      solved.boundaryRealizationsByRoute[routeIndex],
    );
  });
}

function reusableIncrementalRouteIndexes(
  routes: readonly Route[],
  baselineRoutes: readonly Route[],
  activeCorridorIndexes: Set<number>,
): ReadonlySet<number> {
  if (routes.length !== baselineRoutes.length) {
    throw new Error('corridor spacing: incremental baseline route count changed');
  }
  const reusable = new Set<number>();
  routes.forEach((route, routeIndex) => {
    const baseline = baselineRoutes[routeIndex];
    if (route.requestIndex !== baseline.requestIndex) {
      throw new Error(`corridor spacing: incremental baseline route ${routeIndex} changed request`);
    }
    if (haveSameSpacingInputs(route, baseline)) {
      reusable.add(routeIndex);
      return;
    }
    for (const visit of route.visits) {
      activeCorridorIndexes.add(visit.corridorIndex);
    }
    for (const visit of baseline.visits) {
      activeCorridorIndexes.add(visit.corridorIndex);
    }
  });
  return reusable;
}

function boundaryIdentity(boundary: VisitBoundary): string {
  return boundary.kind === 'terminal'
    ? `terminal:${boundary.attachmentIndex}`
    : `portal:${boundary.portalIndex}:${boundary.mode}`;
}

function sameSpacingEndpoint(left: RouteEndpoint, right: RouteEndpoint): boolean {
  return (
    left.entityIndex === right.entityIndex &&
    left.face === right.face &&
    left.hasArrowhead === right.hasArrowhead &&
    left.authoredTrack === right.authoredTrack &&
    left.repairPinTrack === right.repairPinTrack &&
    left.portGroup === right.portGroup
  );
}

/** Inside spacing, a repair pin behaves exactly like an authored port; authored wins ties. */
function spacingPinTrack(endpoint: RouteEndpoint): number | undefined {
  return endpoint.authoredTrack ?? endpoint.repairPinTrack;
}

function expandStraightContinuationCorridors(
  routes: readonly Route[],
  corridorIndexes: Set<number>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const route of routes) {
      for (let visitIndex = 1; visitIndex < route.visits.length; visitIndex += 1) {
        const entry = route.visits[visitIndex].entry;
        if (entry.kind !== 'portal' || entry.mode !== 'continue-straight') {
          continue;
        }
        const before = route.visits[visitIndex - 1].corridorIndex;
        const after = route.visits[visitIndex].corridorIndex;
        if (!corridorIndexes.has(before) && !corridorIndexes.has(after)) {
          continue;
        }
        const oldSize = corridorIndexes.size;
        corridorIndexes.add(before);
        corridorIndexes.add(after);
        changed = changed || corridorIndexes.size !== oldSize;
      }
    }
  }
}

function mergeContinuationPolicies(
  routes: readonly Route[],
  selective: SelectiveSpacingState | undefined,
  activePolicies: readonly ContinuationBoundaryPolicy[],
): ContinuationBoundaryPolicy[] {
  if (!selective) {
    return [...activePolicies];
  }
  const retained = selective.baseline.spacing.continuations.filter((policy) => {
    if (!selective.reusableRouteIndexes.has(policy.routeIndex)) {
      return false;
    }
    const route = routes[policy.routeIndex];
    const beforeCorridorIndex = route.visits[policy.afterVisitIndex - 1].corridorIndex;
    const afterCorridorIndex = route.visits[policy.afterVisitIndex].corridorIndex;
    return (
      !selective.activeCorridorIndexes.has(beforeCorridorIndex) &&
      !selective.activeCorridorIndexes.has(afterCorridorIndex)
    );
  });
  return [...retained, ...activePolicies].sort(
    (left, right) =>
      left.routeIndex - right.routeIndex || left.afterVisitIndex - right.afterVisitIndex,
  );
}

function normalizeSpacingQualitySources(
  qualityLedger: RoutingQualityLedger,
  ordering: OrderingResult,
  continuedCorridors: ReadonlySet<number>,
): void {
  const sourceByCorridor = new Map(
    qualityLedger.snapshot().sources.flatMap((source): Array<[number, typeof source]> => {
      const corridorIndex = spacingQualitySourceCorridorIndex(source.source);
      return corridorIndex === undefined ? [] : [[corridorIndex, source]];
    }),
  );
  qualityLedger.removeStage('spacing');
  const orderedGroups = [
    ...ordering.groups.filter((group) => !continuedCorridors.has(group.corridorIndex)),
    ...ordering.groups.filter((group) => continuedCorridors.has(group.corridorIndex)),
  ];
  for (const group of orderedGroups) {
    const source = sourceByCorridor.get(group.corridorIndex);
    if (source) {
      qualityLedger.replaceSource(source.source, source.stage, source.events, source.scalarCosts);
    }
  }
}

function baselineContinuationRealizations(
  route: Route,
  baselineRoute: Route,
  activeCorridorIndexes: ReadonlySet<number>,
  reusable: boolean,
): BoundaryRealization[] {
  if (!reusable) {
    return [];
  }
  const retained: BoundaryRealization[] = [];
  for (let afterVisitIndex = 1; afterVisitIndex < route.visits.length; afterVisitIndex += 1) {
    const realization = baselineRoute.boundaryRealizationAfter(afterVisitIndex);
    if (realization?.kind !== 'continue-retrack') {
      continue;
    }
    const beforeCorridorIndex = route.visits[afterVisitIndex - 1].corridorIndex;
    const afterCorridorIndex = route.visits[afterVisitIndex].corridorIndex;
    if (
      !activeCorridorIndexes.has(beforeCorridorIndex) &&
      !activeCorridorIndexes.has(afterCorridorIndex)
    ) {
      retained.push(realization);
    }
  }
  return retained;
}

function orderSpacingShortfalls(
  shortfalls: readonly SpacingShortfall[],
  ordering: OrderingResult,
  continuedCorridors: ReadonlySet<number>,
): SpacingShortfall[] {
  const rankByCorridor = new Map<number, number>();
  [
    ...ordering.groups.filter((group) => !continuedCorridors.has(group.corridorIndex)),
    ...ordering.groups.filter((group) => continuedCorridors.has(group.corridorIndex)),
  ].forEach((group, rank) => rankByCorridor.set(group.corridorIndex, rank));
  return shortfalls
    .map((shortfall, index) => ({ shortfall, index }))
    .sort(
      (left, right) =>
        (rankByCorridor.get(left.shortfall.corridorIndex) ?? Number.MAX_SAFE_INTEGER) -
          (rankByCorridor.get(right.shortfall.corridorIndex) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ shortfall }) => shortfall);
}

function solveIndependentCorridor(
  work: CorridorWork,
  tracksByRoute: readonly Float64Array[],
  shortfalls: SpacingShortfall[],
  qualityLedger: RoutingQualityLedger,
  workspace: SpacingRunWorkspace,
): ComponentSolveMetrics {
  const constraints = work.contentionComponents.flatMap((indexes) =>
    indexes.slice(1).map((afterIndex, index) => ({
      before: indexes[index],
      after: afterIndex,
      gap: MIN_TRACK_SEPARATION_PX,
    })),
  );
  let solved: SpacingKernelResult;
  try {
    solved = solveSpacingKernel(work.units, constraints, workspace.kernel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof InfeasibleSpacingComponentError) {
      throw new CorridorSpacingError(
        work.group.corridorIndex,
        work.group.members.map((member) => member.routeIndex),
        message,
        { cause: error },
      );
    }
    throw new Error(`corridor ${work.group.corridorIndex}: ${message}`, { cause: error });
  }
  for (const reduction of solved.capacityReductions) {
    shortfalls.push(
      reductionShortfall('minimum-separation', work.group.corridorIndex, reduction, work.units),
    );
  }
  for (const reduction of solved.quantizationReductions) {
    shortfalls.push(
      reductionShortfall('quantization', work.group.corridorIndex, reduction, work.units),
    );
  }
  commitUnitTracks(work.units, solved.tracks, tracksByRoute);
  for (const { ref, rule } of work.deferredPaddingShortfalls ?? []) {
    const track = tracksByRoute[ref.routeIndex][ref.visitIndex];
    const achieved = Math.max(0, Math.min(track - rule.container[0], rule.container[1] - track));
    if (achieved >= rule.padding - EPSILON) {
      continue;
    }
    shortfalls.push({
      kind: rule.kind,
      corridorIndex: work.group.corridorIndex,
      routeIndexes: [ref.routeIndex],
      visitIndexes: [ref.visitIndex],
      required: rule.padding,
      achieved,
    });
  }
  qualityLedger.replaceSource(
    spacingQualitySource(work.group.corridorIndex),
    'spacing',
    spacingQualityEvents(work, tracksByRoute),
    spacingScalarCosts(solved.objective),
  );
  return solved.metrics;
}

function congestedTurnVisits(
  world: CorridorWorld,
  routes: readonly Route[],
  units: readonly TrackUnit[],
  contentionComponents: readonly (readonly number[])[],
  maximumVisitCount = Number.POSITIVE_INFINITY,
  requirePinnedVisit = false,
  capacityTolerance = EPSILON,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const componentIndexes of contentionComponents) {
    let visitCount = 0;
    let pinnedVisitCount = 0;
    for (const unitIndex of componentIndexes) {
      const unit = units[unitIndex];
      visitCount += unit.members.length;
      if (requirePinnedVisit) {
        for (const member of unit.members) {
          const span = routes[member.ref.routeIndex].visits[member.ref.visitIndex].feasibleTrack;
          if (span[1] - span[0] <= COMPONENT_SOLVER_TOLERANCE) {
            pinnedVisitCount += 1;
          }
        }
      }
    }
    if (visitCount > maximumVisitCount) {
      continue;
    }
    if (requirePinnedVisit && pinnedVisitCount !== 1) {
      continue;
    }
    if (
      capacityTolerance !== Number.POSITIVE_INFINITY &&
      maximumFeasibleSpacingGap(units, componentIndexes, MIN_TRACK_SEPARATION_PX) >
        capacityTolerance
    ) {
      continue;
    }
    for (const unitIndex of componentIndexes) {
      const unit = units[unitIndex];
      if (unit.authored) {
        continue;
      }
      for (const member of unit.members) {
        const route = routes[member.ref.routeIndex];
        const visit = route.visits[member.ref.visitIndex];
        const corridor = world.indexer.corridors[visit.corridorIndex];
        const corridorCross = corridorCrossSpan(corridor);
        const hasTurn =
          (visit.entry.kind === 'portal' && visit.entry.mode === 'turn') ||
          (visit.exit.kind === 'portal' && visit.exit.mode === 'turn');
        if (
          hasTurn &&
          (visit.feasibleTrack[0] > corridorCross[0] + EPSILON ||
            visit.feasibleTrack[1] < corridorCross[1] - EPSILON)
        ) {
          result.add(visitKey(member.ref.routeIndex, member.ref.visitIndex));
        }
      }
    }
  }
  return result;
}

function straightContinuationCorridors(routes: readonly Route[]): Set<number> {
  const result = new Set<number>();
  for (const route of routes) {
    for (let visitIndex = 1; visitIndex < route.visits.length; visitIndex += 1) {
      const entry = route.visits[visitIndex].entry;
      if (entry.kind === 'portal' && entry.mode === 'continue-straight') {
        result.add(route.visits[visitIndex - 1].corridorIndex);
        result.add(route.visits[visitIndex].corridorIndex);
      }
    }
  }
  return result;
}

function solveContinuedCorridors(
  world: CorridorWorld,
  routes: readonly Route[],
  works: readonly CorridorWork[],
  tracksByRoute: readonly Float64Array[],
  shortfalls: SpacingShortfall[],
  independentContinuations: readonly IndependentContinuationBoundary[],
  terminalCenterContinuations: boolean,
  continuationTrackClearance: boolean,
  qualityLedger: RoutingQualityLedger,
  workspace: SpacingRunWorkspace,
): ContinuedSolveResult {
  if (works.length === 0) {
    return {
      metrics: { converged: true, quantizationViolationCount: 0 },
      boundaryRealizationsByRoute: routes.map(() => [] as BoundaryRealization[]),
      policies: [],
    };
  }

  const localUnits: TrackUnit[] = [];
  const unitOffsetByCorridor = new Map<number, number>();
  const unitByVisit = new Map<string, number>();
  const continuations: FlexibleContinuationRef[] = [];
  let unitOffset = 0;
  for (const work of works) {
    localUnits.push(...work.units);
    unitOffsetByCorridor.set(work.group.corridorIndex, unitOffset);
    work.units.forEach((unit, localIndex) => {
      for (const member of unit.members) {
        unitByVisit.set(
          visitKey(member.ref.routeIndex, member.ref.visitIndex),
          unitOffset + localIndex,
        );
      }
    });
    unitOffset += work.units.length;
  }
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    for (let visitIndex = 1; visitIndex < route.visits.length; visitIndex += 1) {
      const entry = route.visits[visitIndex].entry;
      if (entry.kind !== 'portal' || entry.mode !== 'continue-straight') {
        continue;
      }
      const before = unitByVisit.get(visitKey(routeIndex, visitIndex - 1));
      const after = unitByVisit.get(visitKey(routeIndex, visitIndex));
      if (before === undefined && after === undefined) {
        continue;
      }
      if (before === undefined || after === undefined) {
        throw new Error(`route ${route.requestIndex}: continuation spacing unit missing`);
      }
      continuations.push({
        routeIndex,
        afterVisitIndex: visitIndex,
        beforeLocalUnit: before,
        afterLocalUnit: after,
      });
    }
  }
  const continuationKeys = continuationKeySet(continuations);
  let policyPlan = planContinuationPolicies(
    world,
    routes,
    localUnits,
    continuations,
    independentContinuations.filter(({ routeIndex, afterVisitIndex }) =>
      continuationKeys.has(continuationKey(routeIndex, afterVisitIndex)),
    ),
    terminalCenterContinuations,
    workspace.continuationUnionFind,
    CONTINUATION_POLICY_TUNING,
  );
  const attempt = (
    flexibleContinuations: readonly FlexibleContinuationRef[],
  ): ContinuedConfigurationResult =>
    solveContinuedConfiguration(
      world,
      routes,
      works,
      localUnits,
      unitOffsetByCorridor,
      continuations,
      flexibleContinuations,
      tracksByRoute,
      continuationTrackClearance,
      workspace,
    );
  let best = attempt(policyPlan.flexibleContinuations);
  const ladderFellThrough = best.metrics.quantizationViolationCount > 0;
  if (ladderFellThrough && policyPlan.flexibleContinuations.length > 0) {
    best = attempt([]);
  }
  // If even the equal-policy configuration cannot quantize feasibly, retain its
  // near-feasible geometry and record the quantization metric and shortfall.
  if (ladderFellThrough) {
    policyPlan = {
      flexibleContinuations: [],
      policies: policyPlan.policies.map((policy) =>
        policy.policy === 'independent'
          ? { ...policy, policy: 'equal', reason: 'solver-fallback' }
          : policy,
      ),
    };
  }

  best.tracksByRoute.forEach((tracks, routeIndex) => {
    tracks.forEach((track, visitIndex) => {
      if (Number.isFinite(track)) {
        tracksByRoute[routeIndex][visitIndex] = track;
      }
    });
  });
  shortfalls.push(...best.shortfalls);
  for (const work of works) {
    qualityLedger.replaceSource(
      spacingQualitySource(work.group.corridorIndex),
      'spacing',
      spacingQualityEvents(work, tracksByRoute),
      spacingScalarCosts(best.desireCostByCorridor.get(work.group.corridorIndex) ?? 0),
    );
  }
  return {
    metrics: best.metrics,
    boundaryRealizationsByRoute: best.boundaryRealizationsByRoute,
    policies: policyPlan.policies,
  };
}

function solveContinuedConfiguration(
  world: CorridorWorld,
  routes: readonly Route[],
  works: readonly CorridorWork[],
  localUnits: readonly TrackUnit[],
  unitOffsetByCorridor: ReadonlyMap<number, number>,
  continuations: readonly FlexibleContinuationRef[],
  flexibleContinuations: readonly FlexibleContinuationRef[],
  baseTracksByRoute: readonly Float64Array[],
  continuationTrackClearance: boolean,
  workspace: SpacingRunWorkspace,
): ContinuedConfigurationResult {
  const flexibleKeys = continuationKeySet(flexibleContinuations);
  const rootByLocal = continuationRoots(
    localUnits.length,
    continuations,
    flexibleKeys,
    workspace.continuationUnionFind,
  );
  const shortfalls: SpacingShortfall[] = [];
  const localIndexesByRoot = new Map<number, number[]>();
  localUnits.forEach((_, localIndex) => {
    const root = rootByLocal[localIndex];
    const indexes = localIndexesByRoot.get(root) ?? [];
    indexes.push(localIndex);
    localIndexesByRoot.set(root, indexes);
  });

  const globalUnits: TrackUnit[] = [];
  const globalByLocal = new Int32Array(localUnits.length);
  for (const indexes of [...localIndexesByRoot.values()].sort((a, b) => a[0] - b[0])) {
    const merged = mergeContinuationComponentUnit(routes, localUnits, indexes);
    if (merged.emptyPaddedBounds) {
      if (merged.emptyPaddedBounds.rawInfeasible) {
        throw new Error('corridor spacing: A* committed an empty straight-continuation track');
      }
      shortfalls.push({
        ...shortfall(
          'straight-continuation',
          memberCorridorIndex(routes, merged.unit.members),
          merged.unit.members,
          0,
          merged.emptyPaddedBounds.achieved,
        ),
        reason: 'empty-padded-intersection',
        candidateContinuations: reducingPaddedContinuationCuts(
          indexes,
          localUnits,
          continuations,
          flexibleKeys,
          workspace,
        ),
      });
    }
    const globalIndex = globalUnits.length;
    globalUnits.push(merged.unit);
    for (const localIndex of indexes) {
      globalByLocal[localIndex] = globalIndex;
    }
  }

  const constraintsByPair = new Map<string, SpacingGapConstraint>();
  for (const work of works) {
    const offset = unitOffsetByCorridor.get(work.group.corridorIndex) as number;
    const occupants: TrackUnit[] = [];
    const occupantGlobalIndexes: number[] = [];
    for (let localIndex = 0; localIndex < work.units.length; localIndex += 1) {
      const globalIndex = globalByLocal[offset + localIndex];
      const existingIndex = occupantGlobalIndexes.indexOf(globalIndex);
      if (existingIndex >= 0) {
        const existing = occupants[existingIndex];
        occupants[existingIndex] = {
          ...existing,
          members: [...existing.members, ...work.units[localIndex].members],
        };
      } else {
        occupants.push({
          ...globalUnits[globalIndex],
          members: work.units[localIndex].members,
        });
        occupantGlobalIndexes.push(globalIndex);
      }
    }
    const occupantContentionComponents = buildContentionComponents(
      occupants,
      workspace.contentionUnionFind,
    );
    for (const componentIndexes of occupantContentionComponents) {
      const continuousGap = maximumFeasibleSpacingGap(
        occupants,
        componentIndexes,
        MIN_TRACK_SEPARATION_PX,
      );
      const gap =
        continuousGap >= MIN_TRACK_SEPARATION_PX - EPSILON
          ? MIN_TRACK_SEPARATION_PX
          : Math.floor(continuousGap + EPSILON);
      if (gap < MIN_TRACK_SEPARATION_PX - EPSILON) {
        const members: TrackVariable[] = [];
        for (const componentIndex of componentIndexes) {
          members.push(...occupants[componentIndex].members);
        }
        shortfalls.push(
          shortfall(
            'minimum-separation',
            work.group.corridorIndex,
            members,
            MIN_TRACK_SEPARATION_PX,
            gap,
          ),
        );
      }
      if (gap < 0) {
        continue;
      }
      for (let index = 1; index < componentIndexes.length; index += 1) {
        const before = occupantGlobalIndexes[componentIndexes[index - 1]];
        const after = occupantGlobalIndexes[componentIndexes[index]];
        if (mergeConstraint(constraintsByPair, before, after, gap)) {
          const members = [...globalUnits[before].members, ...globalUnits[after].members];
          shortfalls.push(
            shortfall('straight-continuation', work.group.corridorIndex, members, gap, 0),
          );
        }
      }
    }
  }

  addBoundaryBundleConstraints(
    world,
    routes,
    flexibleContinuations,
    globalByLocal,
    constraintsByPair,
    globalUnits,
    shortfalls,
  );
  let solved: SpacingKernelResult;
  try {
    solved = solveSpacingKernel(globalUnits, [...constraintsByPair.values()], workspace.kernel);
  } catch (error) {
    if (!(error instanceof InfeasibleSpacingComponentError)) {
      throw error;
    }
    const members = error.unitIndexes.flatMap((unitIndex) => globalUnits[unitIndex]?.members ?? []);
    const corridorIndexes = new Set(
      members.map(
        (member) => routes[member.ref.routeIndex].visits[member.ref.visitIndex].corridorIndex,
      ),
    );
    const failedWorks = works.filter((work) => corridorIndexes.has(work.group.corridorIndex));
    throw new CorridorSpacingError(
      failedWorks.map((work) => work.group.corridorIndex),
      failedWorks.flatMap((work) => work.group.members.map((member) => member.routeIndex)),
      error.message,
      { cause: error },
    );
  }
  for (const reduction of solved.capacityReductions) {
    const firstUnit = globalUnits[reduction.unitIndexes[0]];
    shortfalls.push(
      reductionShortfall(
        'straight-continuation',
        memberCorridorIndex(routes, firstUnit.members),
        reduction,
        globalUnits,
      ),
    );
  }
  for (const reduction of solved.quantizationReductions) {
    const firstUnit = globalUnits[reduction.unitIndexes[0]];
    shortfalls.push(
      reductionShortfall(
        'quantization',
        memberCorridorIndex(routes, firstUnit.members),
        reduction,
        globalUnits,
      ),
    );
  }

  const tracksByRoute = baseTracksByRoute.map((tracks) => Float64Array.from(tracks));
  const desireCostByCorridor = new Map<number, number>();
  globalUnits.forEach((unit, index) => {
    const corridorIndex = memberCorridorIndex(routes, unit.members);
    desireCostByCorridor.set(
      corridorIndex,
      (desireCostByCorridor.get(corridorIndex) ?? 0) + solved.unitCosts[index],
    );
    for (const member of unit.members) {
      tracksByRoute[member.ref.routeIndex][member.ref.visitIndex] = solved.tracks[index];
    }
  });
  return {
    metrics: solved.metrics,
    tracksByRoute,
    shortfalls,
    desireCostByCorridor,
    boundaryRealizationsByRoute: buildContinuationBoundaryRealizations(
      world,
      routes,
      tracksByRoute,
      flexibleContinuations,
      CONTINUATION_GEOMETRY_TUNING,
      continuationTrackClearance,
    ),
  };
}

function reducingPaddedContinuationCuts(
  localIndexes: readonly number[],
  localUnits: readonly TrackUnit[],
  continuations: readonly FlexibleContinuationRef[],
  flexibleKeys: ReadonlySet<string>,
  workspace: SpacingRunWorkspace,
): IndependentContinuationBoundary[] {
  const indexSet = new Set(localIndexes);
  const strictEdges = continuations.filter(
    (continuation) =>
      !flexibleKeys.has(continuationKey(continuation.routeIndex, continuation.afterVisitIndex)) &&
      indexSet.has(continuation.beforeLocalUnit) &&
      indexSet.has(continuation.afterLocalUnit) &&
      continuation.beforeLocalUnit !== continuation.afterLocalUnit,
  );
  const incumbentViolation = paddedComponentViolation(localIndexes, localUnits);
  const result: Array<{
    readonly boundary: IndependentContinuationBoundary;
    readonly remainingViolation: number;
  }> = [];
  for (const candidate of strictEdges) {
    const candidateViolation = paddedViolationWithoutBoundary(
      localIndexes,
      localUnits,
      strictEdges,
      candidate,
      workspace.paddedCut,
    );
    if (candidateViolation < incumbentViolation - EPSILON) {
      result.push({
        boundary: {
          routeIndex: candidate.routeIndex,
          afterVisitIndex: candidate.afterVisitIndex,
        },
        remainingViolation: candidateViolation,
      });
    }
  }
  return result
    .sort(
      (left, right) =>
        left.remainingViolation - right.remainingViolation ||
        left.boundary.routeIndex - right.boundary.routeIndex ||
        left.boundary.afterVisitIndex - right.boundary.afterVisitIndex,
    )
    .map((candidate) => candidate.boundary);
}

function paddedComponentViolation(
  localIndexes: readonly number[],
  localUnits: readonly TrackUnit[],
): number {
  let lower = Number.NEGATIVE_INFINITY;
  let upper = Number.POSITIVE_INFINITY;
  for (const index of localIndexes) {
    lower = Math.max(lower, localUnits[index].lower);
    upper = Math.min(upper, localUnits[index].upper);
  }
  return Math.max(0, lower - upper);
}

function paddedViolationWithoutBoundary(
  localIndexes: readonly number[],
  localUnits: readonly TrackUnit[],
  edges: readonly FlexibleContinuationRef[],
  removed: FlexibleContinuationRef,
  workspace: PaddedCutWorkspace,
): number {
  workspace.unionFind.reset(localUnits.length);
  for (const edge of edges) {
    if (
      edge.routeIndex !== removed.routeIndex ||
      edge.afterVisitIndex !== removed.afterVisitIndex
    ) {
      workspace.unionFind.unionMin(edge.beforeLocalUnit, edge.afterLocalUnit);
    }
  }

  if (localUnits.length > workspace.lowerBounds.length) {
    const capacity = Math.max(localUnits.length, workspace.lowerBounds.length * 2, 1);
    workspace.lowerBounds = new Float64Array(capacity);
    workspace.upperBounds = new Float64Array(capacity);
    workspace.boundMarks = new Uint32Array(capacity);
  }
  workspace.generation += 1;
  if (workspace.generation === 0xffffffff) {
    workspace.boundMarks.fill(0);
    workspace.generation = 1;
  }
  workspace.roots.length = 0;
  for (const index of localIndexes) {
    const componentRoot = workspace.unionFind.find(index);
    const unit = localUnits[index];
    if (workspace.boundMarks[componentRoot] !== workspace.generation) {
      workspace.boundMarks[componentRoot] = workspace.generation;
      workspace.lowerBounds[componentRoot] = unit.lower;
      workspace.upperBounds[componentRoot] = unit.upper;
      workspace.roots.push(componentRoot);
    } else {
      workspace.lowerBounds[componentRoot] = Math.max(
        workspace.lowerBounds[componentRoot],
        unit.lower,
      );
      workspace.upperBounds[componentRoot] = Math.min(
        workspace.upperBounds[componentRoot],
        unit.upper,
      );
    }
  }
  let violation = 0;
  for (const componentRoot of workspace.roots) {
    violation += Math.max(
      0,
      workspace.lowerBounds[componentRoot] - workspace.upperBounds[componentRoot],
    );
  }
  return violation;
}

function addBoundaryBundleConstraints(
  world: CorridorWorld,
  routes: readonly Route[],
  continuations: readonly FlexibleContinuationRef[],
  globalByLocal: Int32Array,
  constraints: Map<string, SpacingGapConstraint>,
  globalUnits: readonly TrackUnit[],
  shortfalls: SpacingShortfall[],
): void {
  const bundles = new Map<string, BoundaryBundleMember[]>();
  for (const continuation of continuations) {
    const route = routes[continuation.routeIndex];
    const placement = continuationBundlePlacement(world, route, continuation);
    const hostBefore = placement.hostVisitIndex === continuation.afterVisitIndex - 1;
    const hostLocalUnit = hostBefore ? continuation.beforeLocalUnit : continuation.afterLocalUnit;
    const mouthLocalUnit = hostBefore ? continuation.afterLocalUnit : continuation.beforeLocalUnit;
    const members = bundles.get(placement.key) ?? [];
    members.push({
      routeIndex: continuation.routeIndex,
      hostCorridorIndex: placement.hostCorridorIndex,
      mouthVisitIndex: placement.mouthVisitIndex,
      hostGlobalUnit: globalByLocal[hostLocalUnit],
      mouthGlobalUnit: globalByLocal[mouthLocalUnit],
    });
    bundles.set(placement.key, members);
  }

  for (const members of bundles.values()) {
    const ordered = [...members].sort(
      (left, right) =>
        routes[left.routeIndex].orderOf(left.mouthVisitIndex) -
          routes[right.routeIndex].orderOf(right.mouthVisitIndex) ||
        left.routeIndex - right.routeIndex,
    );
    for (const unitField of ['mouthGlobalUnit', 'hostGlobalUnit'] as const) {
      const seen = new Set<number>();
      const unique = ordered.filter((member) => {
        if (seen.has(member[unitField])) {
          return false;
        }
        seen.add(member[unitField]);
        return true;
      });
      for (let index = 1; index < unique.length; index += 1) {
        const before = unique[index - 1][unitField];
        const after = unique[index][unitField];
        if (!mergeConstraint(constraints, before, after, MIN_TRACK_SEPARATION_PX)) {
          continue;
        }
        const conflicting = [...globalUnits[before].members, ...globalUnits[after].members];
        shortfalls.push(
          shortfall(
            'straight-continuation',
            unique[index].hostCorridorIndex,
            conflicting,
            MIN_TRACK_SEPARATION_PX,
            0,
          ),
        );
      }
    }
  }
}

function buildTurnBoundaryRealizations(
  world: CorridorWorld,
  routes: readonly Route[],
  tracksByRoute: readonly Float64Array[],
): readonly (readonly BoundaryRealization[])[] {
  const result = routes.map(() => [] as BoundaryRealization[]);
  routes.forEach((route, routeIndex) => {
    result[routeIndex].push(
      ...buildRouteTurnBoundaryRealizations(world, route, routeIndex, tracksByRoute),
    );
  });
  return packTurnPortalLegs(world, routes, tracksByRoute, result);
}

function buildRouteTurnBoundaryRealizations(
  world: CorridorWorld,
  route: Route,
  routeIndex: number,
  tracksByRoute: readonly Float64Array[],
): BoundaryRealization[] {
  const result: BoundaryRealization[] = [];
  for (let afterVisitIndex = 1; afterVisitIndex < route.visits.length; afterVisitIndex += 1) {
    const boundary = route.visits[afterVisitIndex].entry;
    if (boundary.kind !== 'portal' || boundary.mode !== 'turn') {
      continue;
    }
    const portal = world.indexer.portals[boundary.portalIndex];
    if (portal.kind !== 'turn') {
      throw new Error(`route ${route.requestIndex}: turn portal missing`);
    }
    const beforeVisitIndex = afterVisitIndex - 1;
    const beforeCorridor = world.indexer.corridors[route.visits[beforeVisitIndex].corridorIndex];
    const afterCorridor = world.indexer.corridors[route.visits[afterVisitIndex].corridorIndex];
    const beforeTrack = tracksByRoute[routeIndex][beforeVisitIndex];
    const afterTrack = tracksByRoute[routeIndex][afterVisitIndex];
    const beforeSpan = turnPortalCrossSpan(portal, beforeCorridor.axis);
    const afterSpan = turnPortalCrossSpan(portal, afterCorridor.axis);
    const beforePortalTrack = clamp(beforeTrack, beforeSpan[0], beforeSpan[1]);
    const afterPortalTrack = clamp(afterTrack, afterSpan[0], afterSpan[1]);
    const shifts = [] as Array<{
      hostVisitIndex: number;
      shiftCoordinate: number;
      trackAfter: number;
    }>;
    if (!coordinateInSpan(beforeTrack, beforeSpan, EPSILON)) {
      shifts.push({
        hostVisitIndex: beforeVisitIndex,
        shiftCoordinate: turnShiftCoordinate(
          world,
          beforeCorridor,
          afterPortalTrack,
          route.visits[beforeVisitIndex].entry,
        ),
        trackAfter: beforePortalTrack,
      });
    }
    if (!coordinateInSpan(afterTrack, afterSpan, EPSILON)) {
      shifts.push({
        hostVisitIndex: afterVisitIndex,
        shiftCoordinate: turnShiftCoordinate(
          world,
          afterCorridor,
          beforePortalTrack,
          route.visits[afterVisitIndex].exit,
        ),
        trackAfter: afterTrack,
      });
    }
    if (shifts.length > 0) {
      result.push({
        kind: 'turn-retrack',
        afterVisitIndex,
        beforePortalTrack,
        afterPortalTrack,
        shifts,
      });
    }
  }
  return result;
}

/** Keep collinear portal legs disjoint across compatible turn hosts. */
function packTurnPortalLegs(
  world: CorridorWorld,
  routes: readonly Route[],
  tracksByRoute: readonly Float64Array[],
  realizationsByRoute: readonly (readonly BoundaryRealization[])[],
): readonly (readonly BoundaryRealization[])[] {
  const shifts = turnShiftRefs(world, routes, tracksByRoute, realizationsByRoute);
  const coordinateByShift = new Map<string, number>(
    shifts.map((shift) => [turnShiftKey(shift), shift.shiftCoordinate]),
  );
  const groups = new Map<string, TurnShiftRef[]>();
  for (const shift of shifts) {
    const key = `${shift.hostAxis}:${shift.portalTrack}`;
    const group = groups.get(key) ?? [];
    group.push(shift);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.portalCoordinate - right.portalCoordinate || left.routeIndex - right.routeIndex,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const left = ordered[index - 1];
      const right = ordered[index];
      const leftKey = turnShiftKey(left);
      const rightKey = turnShiftKey(right);
      let leftCoordinate = coordinateByShift.get(leftKey) as number;
      let rightCoordinate = coordinateByShift.get(rightKey) as number;
      const leftEntersGap = leftCoordinate > left.portalCoordinate + EPSILON;
      const rightEntersGap = rightCoordinate < right.portalCoordinate - EPSILON;
      if (!leftEntersGap && !rightEntersGap) {
        continue;
      }
      if (leftEntersGap && rightEntersGap) {
        const middle = (left.portalCoordinate + right.portalCoordinate) / 2;
        leftCoordinate = Math.min(
          leftCoordinate,
          Math.floor(middle - MIN_TRACK_SEPARATION_PX / 2 + EPSILON),
        );
        rightCoordinate = Math.max(
          rightCoordinate,
          Math.ceil(middle + MIN_TRACK_SEPARATION_PX / 2 - EPSILON),
        );
        leftCoordinate = nudgeTowardPortal(left, right, leftCoordinate);
        rightCoordinate = nudgeTowardPortal(right, left, rightCoordinate);
      } else if (leftEntersGap) {
        leftCoordinate = Math.min(leftCoordinate, right.portalCoordinate - MIN_TRACK_SEPARATION_PX);
      } else {
        rightCoordinate = Math.max(
          rightCoordinate,
          left.portalCoordinate + MIN_TRACK_SEPARATION_PX,
        );
      }
      coordinateByShift.set(
        leftKey,
        clampTowardPortal(leftCoordinate, left.portalCoordinate, left.shiftCoordinate),
      );
      coordinateByShift.set(
        rightKey,
        clampTowardPortal(rightCoordinate, right.portalCoordinate, right.shiftCoordinate),
      );
    }
    if (!groupIsCertified(ordered, coordinateByShift)) {
      for (const shift of group) {
        coordinateByShift.set(turnShiftKey(shift), shift.shiftCoordinate);
      }
    }
  }
  return realizationsByRoute.map((realizations, routeIndex) =>
    realizations.map((realization, realizationIndex) => {
      if (realization.kind !== 'turn-retrack') {
        return realization;
      }
      return {
        ...realization,
        shifts: realization.shifts.map((shift, shiftIndex) => ({
          ...shift,
          shiftCoordinate:
            coordinateByShift.get(turnShiftKey({ routeIndex, realizationIndex, shiftIndex })) ??
            shift.shiftCoordinate,
        })),
      };
    }),
  );
}

function clampTowardPortal(candidate: number, portal: number, desired: number): number {
  return Math.round(clamp(candidate, Math.min(portal, desired), Math.max(portal, desired)));
}

function nearPortalShiftCoordinate(shift: TurnShiftRef): number {
  return (
    shift.portalCoordinate +
    Math.sign(shift.shiftCoordinate - shift.portalCoordinate) * CORRIDOR_EDGE_PADDING_PX
  );
}

function turnShiftKey(
  shift: Pick<TurnShiftRef, 'routeIndex' | 'realizationIndex' | 'shiftIndex'>,
): string {
  return `${shift.routeIndex}:${shift.realizationIndex}:${shift.shiftIndex}`;
}

/** Move an interleaved sweep near its portal only when the neighbor's route run stays clear. */
function nudgeTowardPortal(
  shift: TurnShiftRef,
  neighbor: TurnShiftRef,
  coordinate: number,
): number {
  const nearPortal = nearPortalShiftCoordinate(shift);
  if (
    strictlyInside(neighbor.routeTrack, shift.routeTrack, shift.portalTrack) &&
    !coordinateInSpan(nearPortal, neighbor.routeRun, EPSILON)
  ) {
    return nearPortal;
  }
  return coordinate;
}

/** Adjacent packed legs must keep min separation (or all available room) between portals. */
function groupIsCertified(
  ordered: readonly TurnShiftRef[],
  coordinateByShift: ReadonlyMap<string, number>,
): boolean {
  return ordered.slice(1).every((right, index) => {
    const left = ordered[index];
    const available = right.portalCoordinate - left.portalCoordinate;
    const leftEnd = Math.max(
      left.portalCoordinate,
      coordinateByShift.get(turnShiftKey(left)) as number,
    );
    const rightStart = Math.min(
      right.portalCoordinate,
      coordinateByShift.get(turnShiftKey(right)) as number,
    );
    return (
      available > EPSILON &&
      rightStart - leftEnd >= Math.min(MIN_TRACK_SEPARATION_PX, available) - EPSILON
    );
  });
}

function turnShiftRefs(
  world: CorridorWorld,
  routes: readonly Route[],
  tracksByRoute: readonly Float64Array[],
  realizationsByRoute: readonly (readonly BoundaryRealization[])[],
): TurnShiftRef[] {
  const result: TurnShiftRef[] = [];
  realizationsByRoute.forEach((realizations, routeIndex) => {
    realizations.forEach((realization, realizationIndex) => {
      if (realization.kind !== 'turn-retrack') {
        return;
      }
      realization.shifts.forEach((shift, shiftIndex) => {
        const hostBefore = shift.hostVisitIndex === realization.afterVisitIndex - 1;
        const hostCorridorIndex = routes[routeIndex].visits[shift.hostVisitIndex].corridorIndex;
        const hostCorridor = world.indexer.corridors[hostCorridorIndex];
        result.push({
          routeIndex,
          realizationIndex,
          shiftIndex,
          hostAxis: hostCorridor.axis,
          routeTrack: hostBefore
            ? tracksByRoute[routeIndex][shift.hostVisitIndex]
            : shift.trackAfter,
          routeRun: realizedVisitTravelSpan(
            world,
            routes[routeIndex],
            routeIndex,
            shift.hostVisitIndex,
            tracksByRoute,
            realizationsByRoute[routeIndex],
          ),
          portalCoordinate: hostBefore
            ? realization.afterPortalTrack
            : realization.beforePortalTrack,
          portalTrack: hostBefore ? realization.beforePortalTrack : realization.afterPortalTrack,
          shiftCoordinate: shift.shiftCoordinate,
        });
      });
    });
  });
  return result;
}

function turnShiftCoordinate(
  world: CorridorWorld,
  corridor: Corridor,
  portalTravel: number,
  farBoundary: VisitBoundary,
): number {
  const farTravel = boundaryTravelCoordinate(world, corridor, farBoundary);
  const direction = Math.sign(farTravel - portalTravel);
  if (direction === 0) {
    return Math.round(portalTravel);
  }
  const depth = Math.min(
    BOUNDARY_SHIFT_DEPTH_PX,
    Math.max(0, Math.abs(farTravel - portalTravel) - CORRIDOR_EDGE_PADDING_PX),
  );
  return Math.round(portalTravel + direction * depth);
}

function realizedVisitTravelSpan(
  world: CorridorWorld,
  route: Route,
  routeIndex: number,
  visitIndex: number,
  tracksByRoute: readonly Float64Array[],
  realizations: readonly BoundaryRealization[],
): AxisSpan {
  const corridor = world.indexer.corridors[route.visits[visitIndex].corridorIndex];
  const coordinate = (side: 'entry' | 'exit'): number => {
    const boundary = route.visits[visitIndex][side];
    if (boundary.kind !== 'portal' || boundary.mode !== 'turn') {
      return boundaryTravelCoordinate(world, corridor, boundary);
    }
    const afterVisitIndex = side === 'entry' ? visitIndex : visitIndex + 1;
    const realization = realizations.find(
      (candidate) =>
        candidate.kind === 'turn-retrack' && candidate.afterVisitIndex === afterVisitIndex,
    );
    if (realization?.kind === 'turn-retrack') {
      const hostedShift = realization.shifts.find((shift) => shift.hostVisitIndex === visitIndex);
      if (hostedShift) {
        return hostedShift.shiftCoordinate;
      }
      return side === 'entry' ? realization.beforePortalTrack : realization.afterPortalTrack;
    }
    const adjacentVisitIndex = side === 'entry' ? visitIndex - 1 : visitIndex + 1;
    return tracksByRoute[routeIndex][adjacentVisitIndex];
  };
  const entry = coordinate('entry');
  const exit = coordinate('exit');
  return [Math.min(entry, exit), Math.max(entry, exit)];
}

function strictlyInside(value: number, first: number, second: number): boolean {
  return value > Math.min(first, second) + EPSILON && value < Math.max(first, second) - EPSILON;
}

function mergeConstraint(
  constraints: Map<string, SpacingGapConstraint>,
  before: number,
  after: number,
  gap: number,
): boolean {
  if (before === after) {
    return false;
  }
  const reverse = constraints.get(`${after}:${before}`);
  if (reverse) {
    const canonicalBefore = Math.min(before, after);
    const canonicalAfter = Math.max(before, after);
    constraints.delete(`${before}:${after}`);
    constraints.delete(`${after}:${before}`);
    constraints.set(`${canonicalBefore}:${canonicalAfter}`, {
      before: canonicalBefore,
      after: canonicalAfter,
      gap: Math.max(gap, reverse.gap),
    });
    return true;
  }
  const key = `${before}:${after}`;
  const existing = constraints.get(key);
  if (!existing || gap > existing.gap) {
    constraints.set(key, { before, after, gap });
  }
  return false;
}

function commitUnitTracks(
  units: readonly TrackUnit[],
  tracks: readonly number[],
  tracksByRoute: readonly Float64Array[],
): void {
  units.forEach((unit, unitIndex) => {
    for (const member of unit.members) {
      tracksByRoute[member.ref.routeIndex][member.ref.visitIndex] = tracks[unitIndex];
    }
  });
}

function spacingQualitySource(corridorIndex: number): string {
  return `spacing:corridor:${corridorIndex}`;
}

function spacingQualitySourceCorridorIndex(source: string): number | undefined {
  const prefix = 'spacing:corridor:';
  if (!source.startsWith(prefix)) {
    return undefined;
  }
  const corridorIndex = Number(source.slice(prefix.length));
  return Number.isInteger(corridorIndex) ? corridorIndex : undefined;
}

function spacingScalarCosts(spacingDesire: number): RoutingQualityScalarCosts {
  return { ordinaryBends: 0, pathLength: 0, spacingDesire };
}

function spacingDeficitQualityEvent(
  corridorIndex: number,
  achievedGap: number,
  sharedTravelLength: number,
  visits: readonly RoutingQualityVisitRef[],
): SpacingDeficitQualityEvent {
  return {
    kind: 'spacing-deficit',
    cost: spacingDeficitCost(MIN_TRACK_SEPARATION_PX, achievedGap, sharedTravelLength),
    routeIndexes: [...new Set(visits.map((visit) => visit.routeIndex))],
    corridorIndexes: [corridorIndex],
    visits,
  };
}

/** Add contention between adjacent visits that appears only after emission. */
export function collectMissingRealizedSpacingQualityEvents(
  world: CorridorWorld,
  routes: readonly Route[],
  ordering: OrderingResult,
  provisionalEvents: readonly RoutingQualityEvent[],
  geometryIndex: RouteIndexer,
): MissingSpacingContentionQualityEvent[] {
  const events: MissingSpacingContentionQualityEvent[] = [];
  for (const group of ordering.groups) {
    const corridor = world.indexer.corridors[group.corridorIndex];
    const corridorSegments = geometryIndex.segmentsForCorridor(group.corridorIndex);
    for (let index = 1; index < group.members.length; index += 1) {
      const before = group.members[index - 1];
      const after = group.members[index];
      const [beforeSegment, afterSegment] = [before, after].map((visit) =>
        corridorSegments.find(
          (segment) =>
            segment.routeIndex === visit.routeIndex &&
            segment.visitIndex === visit.visitIndex &&
            segment.axis === corridor.axis &&
            Math.abs(
              segment.track - routes[segment.routeIndex].nominalTrackOf(segment.visitIndex),
            ) <= EPSILON,
        ),
      );
      const achievedGap = Math.abs(
        routes[after.routeIndex].nominalTrackOf(after.visitIndex) -
          routes[before.routeIndex].nominalTrackOf(before.visitIndex),
      );

      if (achievedGap >= MIN_TRACK_SEPARATION_PX - EPSILON) {
        continue;
      }

      const sharedTravelLength =
        beforeSegment && afterSegment
          ? Math.max(
              0,
              Math.min(beforeSegment.travel[1], afterSegment.travel[1]) -
                Math.max(beforeSegment.travel[0], afterSegment.travel[0]),
            )
          : 0;
      if (sharedTravelLength <= EPSILON) {
        continue;
      }
      const alreadyReported = provisionalEvents.some(
        (event) =>
          event.kind === 'spacing-deficit' &&
          event.corridorIndexes?.includes(group.corridorIndex) &&
          event.routeIndexes.includes(before.routeIndex) &&
          event.routeIndexes.includes(after.routeIndex),
      );
      if (alreadyReported) {
        continue;
      }
      const visits: MissingSpacingContentionQualityEvent['visits'] = [before, after];
      events.push({
        kind: 'missing-spacing-contention',
        cost: ROUTING_QUALITY_COSTS.invalidGeometry,
        routeIndexes: [...new Set(visits.map((visit) => visit.routeIndex))],
        corridorIndexes: [group.corridorIndex],
        visits,
      });
    }
  }
  return events;
}

function spacingQualityEvents(
  work: CorridorWork,
  tracksByRoute: readonly Float64Array[],
): RoutingQualityEvent[] {
  const events: RoutingQualityEvent[] = [];
  for (const indexes of work.contentionComponents) {
    for (let index = 1; index < indexes.length; index += 1) {
      const before = work.units[indexes[index - 1]];
      const after = work.units[indexes[index]];
      const beforeTrack = unitTrack(before, tracksByRoute);
      const afterTrack = unitTrack(after, tracksByRoute);
      const achievedGap = afterTrack - beforeTrack;
      if (achievedGap >= MIN_TRACK_SEPARATION_PX - EPSILON) {
        continue;
      }
      const sharedTravelLength = unitSharedTravelLength(before, after);
      if (sharedTravelLength <= EPSILON) {
        continue;
      }
      const visits = qualityVisits([...before.members, ...after.members]);
      const corridorIndex = work.group.corridorIndex;
      events.push(
        spacingDeficitQualityEvent(corridorIndex, achievedGap, sharedTravelLength, visits),
      );
      if (Math.abs(achievedGap) <= EPSILON) {
        const routeIndexes = [...new Set(visits.map((visit) => visit.routeIndex))];
        const merge: LineMergeQualityEvent = {
          kind: 'line-merge',
          cost: ROUTING_QUALITY_COSTS.lineMerge,
          routeIndexes,
          corridorIndexes: [corridorIndex],
          visits,
        };
        events.push(merge);
      }
    }
  }
  return events;
}

function unitTrack(unit: TrackUnit, tracksByRoute: readonly Float64Array[]): number {
  const member = unit.members[0];
  return tracksByRoute[member.ref.routeIndex][member.ref.visitIndex];
}

function qualityVisits(members: readonly TrackVariable[]): RoutingQualityVisitRef[] {
  const visits = new Map<string, RoutingQualityVisitRef>();
  for (const member of members) {
    const { routeIndex, visitIndex } = member.ref;
    visits.set(visitKey(routeIndex, visitIndex), { routeIndex, visitIndex });
  }
  return [...visits.values()];
}

function unitSharedTravelLength(left: TrackUnit, right: TrackUnit): number {
  const overlaps: AxisSpan[] = [];
  for (const leftMember of left.members) {
    for (const rightMember of right.members) {
      const overlap = intersectSpans(
        leftMember.travelInterval,
        rightMember.travelInterval,
        EPSILON,
      );
      if (overlap) {
        overlaps.push(overlap);
      }
    }
  }
  overlaps.sort((leftSpan, rightSpan) => leftSpan[0] - rightSpan[0]);
  let result = 0;
  let current: AxisSpan | undefined;
  for (const overlap of overlaps) {
    if (!current || overlap[0] > current[1] + EPSILON) {
      if (current) {
        result += spanLength(current);
      }
      current = overlap;
    } else {
      current = [current[0], Math.max(current[1], overlap[1])];
    }
  }
  return result + (current ? spanLength(current) : 0);
}

function visitKey(routeIndex: number, visitIndex: number): string {
  return `${routeIndex}:${visitIndex}`;
}

function requiredContentionVisitKey(
  corridorIndex: number,
  ref: { readonly routeIndex: number; readonly visitIndex: number },
): string {
  return `${corridorIndex}:${visitKey(ref.routeIndex, ref.visitIndex)}`;
}

function indexRequiredContentions(
  contentions: readonly MissingSpacingContentionQualityEvent[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const contention of contentions) {
    const [first, second] = contention.visits;
    if (first.routeIndex === second.routeIndex && first.visitIndex === second.visitIndex) {
      continue;
    }
    for (const [visit, partner] of [
      [first, second],
      [second, first],
    ] as const) {
      const key = requiredContentionVisitKey(contention.corridorIndexes[0], visit);
      const partners = result.get(key) ?? new Set<string>();
      partners.add(visitKey(partner.routeIndex, partner.visitIndex));
      result.set(key, partners);
    }
  }
  return result;
}

function buildDesiredTracks(
  world: CorridorWorld,
  routes: readonly Route[],
  ordering: OrderingResult,
): DesiredTracks {
  const desires: TrackDesire[][][] = routes.map((route) => route.visits.map(() => []));
  const corridorIdealSeeds: (CorridorIdealSeed | undefined)[][] = routes.map((route) =>
    route.visits.map(() => undefined),
  );
  const groupByCorridor = new Map(ordering.groups.map((group) => [group.corridorIndex, group]));
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (route.visits.length === 0) {
      continue;
    }
    if (route.visits.length >= 3) {
      if (route.visits.length === 3 && !visitHasContinuationBoundary(route.visits[1])) {
        corridorIdealSeeds[routeIndex][1] = bridgeTerminalIdealSeed(world, route);
      } else {
        if (
          endpointNeedsTerminalLead(route.from) &&
          !visitHasContinuationBoundary(route.visits[1])
        ) {
          const seed = outsideTerminalIdealSeed(
            world,
            route.from,
            route.visits[1],
            TERMINAL_LEAD_PX,
          );
          corridorIdealSeeds[routeIndex][1] = seed;
        } else {
          const sourceRunEnd = continuedSourceTerminalLeadRunEnd(
            world,
            route,
            CONTINUATION_POLICY_TUNING,
          );
          if (sourceRunEnd !== undefined) {
            const sourceRunIsUncontended = !runHasTopologicalContention(
              world,
              routes,
              groupByCorridor,
              routeIndex,
              1,
              sourceRunEnd,
            );
            const sourceFaceSpan = faceCrossSpan(
              world.entities[route.from.entityIndex],
              route.from.face,
            );
            const sourceTerminalSpan = route.visits[0].feasibleTrack;
            const sourceTerminalCoversFace =
              spanContains(sourceTerminalSpan, sourceFaceSpan, EPSILON) &&
              spanContains(sourceFaceSpan, sourceTerminalSpan, EPSILON);
            const seed = outsideTerminalIdealSeed(
              world,
              route.from,
              route.visits[1],
              SOURCE_TERMINAL_LEAD_PX,
              sourceRunIsUncontended && sourceTerminalCoversFace,
            );
            for (let visitIndex = 1; visitIndex <= sourceRunEnd; visitIndex += 1) {
              corridorIdealSeeds[routeIndex][visitIndex] = seed;
            }
          }
        }
        const beforeLast = route.visits.length - 2;
        if (
          endpointNeedsTerminalLead(route.to) &&
          !visitHasContinuationBoundary(route.visits[beforeLast])
        ) {
          const seed = outsideTerminalIdealSeed(
            world,
            route.to,
            route.visits[beforeLast],
            TERMINAL_LEAD_PX,
          );
          corridorIdealSeeds[routeIndex][beforeLast] = seed;
        } else {
          const targetRunStart = continuedTargetTerminalLeadRunStart(
            world,
            route,
            CONTINUATION_POLICY_TUNING,
          );
          if (targetRunStart !== undefined) {
            const seed = outsideTerminalIdealSeed(
              world,
              route.to,
              route.visits[beforeLast],
              TERMINAL_LEAD_PX,
            );
            for (let visitIndex = targetRunStart; visitIndex <= beforeLast; visitIndex += 1) {
              corridorIdealSeeds[routeIndex][visitIndex] = seed;
            }
          }
        }
      }
    }
    for (let visitIndex = 1; visitIndex + 1 < route.visits.length; visitIndex += 1) {
      const desired = uTurnCoordinate(world, route, visitIndex);
      if (desired === undefined) {
        continue;
      }
      corridorIdealSeeds[routeIndex][visitIndex] = {
        track: desired,
        weight: U_TURN_CORRIDOR_IDEAL_WEIGHT,
        policy: {
          kind: 'u-turn',
          desiredTrack: desired,
        },
      };
    }
  }

  addTerminalFaceDesires(world, routes, desires, groupByCorridor);
  harmonizeSoloDirectTerminalDesires(routes, desires);

  const collapseVisitValues = (
    fallback?: (routeIndex: number, visitIndex: number) => number,
  ): Float64Array[] =>
    routes.map((route, routeIndex) => {
      const result = new Float64Array(route.visits.length);
      for (let visitIndex = 0; visitIndex < route.visits.length; visitIndex += 1) {
        const visitDesires = desires[routeIndex][visitIndex];
        result[visitIndex] =
          visitDesires.length > 0 || !fallback
            ? compileTrackDesires(visitDesires).track
            : fallback(routeIndex, visitIndex);
      }
      return result;
    });
  const provisionalValues = collapseVisitValues(
    (routeIndex, visitIndex) =>
      corridorIdealSeeds[routeIndex][visitIndex]?.track ??
      corridorCenter(world.indexer.corridors[routes[routeIndex].visits[visitIndex].corridorIndex]),
  );

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    for (let visitIndex = 0; visitIndex < route.visits.length; visitIndex += 1) {
      const visitDesires = desires[routeIndex][visitIndex];
      if (visitDesires.length > 0) {
        continue;
      }
      const corridor = world.indexer.corridors[route.visits[visitIndex].corridorIndex];
      const travelInterval = possibleTravelInterval(
        world,
        corridor,
        route,
        visitIndex,
        provisionalValues[routeIndex],
      );
      const seed = corridorIdealSeeds[routeIndex][visitIndex];
      visitDesires.push({
        kind: seed?.policy?.kind ?? 'corridor-ideal',
        track: seed?.policy
          ? corridorIdealTrack(corridor, travelInterval, seed.policy)
          : (seed?.track ?? corridorIdealTrack(corridor, travelInterval)),
        weight: seed?.weight ?? CORRIDOR_IDEAL_DESIRE_WEIGHT,
      });
    }
  }

  return {
    values: collapseVisitValues(),
    desires,
  };
}

/** A direct route has one track, so two solo terminal centers are one shared preference. */
function harmonizeSoloDirectTerminalDesires(
  routes: readonly Route[],
  desires: TrackDesire[][][],
): void {
  const terminalCounts = new Map<string, number>();
  for (const route of routes) {
    if (route.visits.length === 0) {
      continue;
    }
    for (const endpoint of [route.from, route.to]) {
      const key = terminalKey(endpoint);
      terminalCounts.set(key, (terminalCounts.get(key) ?? 0) + 1);
    }
  }

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (
      route.visits.length !== 1 ||
      spacingPinTrack(route.from) !== undefined ||
      spacingPinTrack(route.to) !== undefined ||
      route.from.portGroup !== undefined ||
      route.to.portGroup !== undefined ||
      terminalCounts.get(terminalKey(route.from)) !== 1 ||
      terminalCounts.get(terminalKey(route.to)) !== 1
    ) {
      continue;
    }
    const feasible = route.visits[0].feasibleTrack;
    const usable = insetSpan(feasible, PORT_EDGE_PADDING_PX, EPSILON) ?? feasible;
    desires[routeIndex][0] = [
      {
        kind: 'terminal',
        track: midpoint(usable),
        weight: ENDPOINT_DESIRE_WEIGHT,
      },
    ];
  }
}

function terminalKey(endpoint: RouteEndpoint): string {
  return `${endpoint.entityIndex}:${endpoint.face}`;
}

type BorderInfluence = 'entity' | 'diagram-border' | 'open';

/**
 * Ideal lane for a run bounded by an entity on exactly one side.
 *
 * Against a real far border (the diagram edge) the run is pushed to
 * CORRIDOR_IDEAL_EDGE_OFFSET_PX off that border, away from the entity —
 * mirrored one-sided pushes in adjacent lanes then sit 8px apart.
 *
 * A missing far border is only a corridor decomposition plane, so there is no
 * physical edge to hug and the unconstrained lane remains centered.
 */
function oneSidedIdealTrack(
  entityOnNegative: boolean,
  cross: AxisSpan,
  center: number,
  farInfluence: BorderInfluence,
): number {
  if (farInfluence === 'open') {
    return center;
  }
  return entityOnNegative
    ? cross[1] - CORRIDOR_IDEAL_EDGE_OFFSET_PX
    : cross[0] + CORRIDOR_IDEAL_EDGE_OFFSET_PX;
}

export function corridorIdealTrack(
  corridor: ProfiledCorridor,
  travelInterval: AxisSpan,
  policy?: CorridorIdealPolicy,
): number {
  const cross = corridorCrossSpan(corridor);
  const center = midpoint(cross);
  const [negative, positive] = corridorBorderInfluences(corridor, travelInterval);
  const ordinary =
    (negative === 'entity') === (positive === 'entity')
      ? center
      : // Mirrored one-sided entity pushes in adjacent open space sit 8px apart.
        oneSidedIdealTrack(
          negative === 'entity',
          cross,
          center,
          negative === 'entity' ? positive : negative,
        );
  if (!policy) {
    return ordinary;
  }
  if (policy.kind === 'u-turn') {
    return policy.desiredTrack;
  }
  const entityBounded = negative === 'entity' && positive === 'entity';
  if (policy.kind === 'terminal-window') {
    return entityBounded && policy.lower <= policy.upper
      ? clamp(ordinary, policy.lower, policy.upper)
      : policy.desiredTrack;
  }
  // Between two entity walls, the border ideal owns placement once terminal clearance is safe.
  if (!entityBounded) {
    return policy.desiredTrack;
  }
  return policy.direction === 'negative'
    ? Math.min(ordinary, policy.plane - IDEAL_TERMINAL_SEPARATION_PX)
    : Math.max(ordinary, policy.plane + IDEAL_TERMINAL_SEPARATION_PX);
}

function corridorBorderInfluences(
  corridor: ProfiledCorridor,
  travelInterval: AxisSpan,
): readonly [negative: BorderInfluence, positive: BorderInfluence] {
  const isX = corridor.borderProfile.axis === 'x';
  const negativeSpans = isX ? corridor.borderProfile.top : corridor.borderProfile.left;
  const positiveSpans = isX ? corridor.borderProfile.bottom : corridor.borderProfile.right;
  return [
    borderInfluence(negativeSpans, travelInterval),
    borderInfluence(positiveSpans, travelInterval),
  ];
}

function borderInfluence(
  spans: readonly CorridorBorderSpan[],
  travelInterval: AxisSpan,
): BorderInfluence {
  let diagramBorder = false;
  for (const border of spans) {
    if (!borderOverlapsTravel(border.span, travelInterval)) {
      continue;
    }
    if (border.kind === 'entity') {
      return 'entity';
    }
    diagramBorder = true;
  }
  return diagramBorder ? 'diagram-border' : 'open';
}

function borderOverlapsTravel(border: AxisSpan, travel: AxisSpan): boolean {
  return (
    Math.min(border[1], travel[1]) - Math.max(border[0], travel[0]) > EPSILON ||
    (travel[1] - travel[0] <= EPSILON && coordinateInSpan(travel[0], border, EPSILON))
  );
}

function runHasTopologicalContention(
  world: CorridorWorld,
  routes: readonly Route[],
  groupByCorridor: ReadonlyMap<number, CorridorOrderGroup>,
  routeIndex: number,
  runStart: number,
  runEnd: number,
): boolean {
  const route = routes[routeIndex];
  for (let visitIndex = runStart; visitIndex <= runEnd; visitIndex += 1) {
    const visit = route.visits[visitIndex];
    const group = groupByCorridor.get(visit.corridorIndex);
    if (!group) {
      continue;
    }
    const interval = topologicalTravelInterval(world, route, visitIndex);
    for (const member of group.members) {
      if (member.routeIndex === routeIndex && member.visitIndex === visitIndex) {
        continue;
      }
      if (
        spansOverlapPositive(
          interval,
          topologicalTravelInterval(world, routes[member.routeIndex], member.visitIndex),
          EPSILON,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function topologicalTravelInterval(
  world: CorridorWorld,
  route: Route,
  visitIndex: number,
): AxisSpan {
  const visit = route.visits[visitIndex];
  const corridor = world.indexer.corridors[visit.corridorIndex];
  const entry = boundaryTravelCoordinate(world, corridor, visit.entry);
  const exit = boundaryTravelCoordinate(world, corridor, visit.exit);
  return [Math.min(entry, exit), Math.max(entry, exit)];
}

function addTerminalMember(
  preferences: TerminalFacePreference[],
  routeIndex: number,
  visitIndex: number,
  endpoint: RouteEndpoint,
  opposite: RouteEndpoint,
): void {
  let preference = preferences.find(
    (candidate) =>
      candidate.entityIndex === endpoint.entityIndex && candidate.face === endpoint.face,
  );
  if (!preference) {
    preference = { entityIndex: endpoint.entityIndex, face: endpoint.face, members: [] };
    preferences.push(preference);
  }
  preference.members.push({ routeIndex, visitIndex, endpoint, opposite });
}

/**
 * A visit whose track is rigidly tied (through straight continuations) to one of its route's
 * terminals behaves as that terminal in every corridor it crosses: displacing it displaces the
 * port itself.
 */
function visitTiedTerminalEnd(route: Route, visitIndex: number): 'from' | 'to' | undefined {
  let start = visitIndex;
  while (start > 0 && isStraightContinuationBoundary(route.visits[start].entry)) {
    start -= 1;
  }
  if (start === 0) {
    return 'from';
  }
  let end = visitIndex;
  while (end < route.visits.length - 1 && isStraightContinuationBoundary(route.visits[end].exit)) {
    end += 1;
  }
  if (end === route.visits.length - 1) {
    return 'to';
  }
  return undefined;
}

/**
 * True when the terminal visit shares its corridor with another route's terminal-tied track at
 * overlapping travel. The pair solves jointly under a separation constraint, so an off-center
 * desire on one port is paid for by the other port moving off its own center: the clamp stops
 * expressing "closer to my face center" and becomes a transfer onto the neighbour's port.
 */
function terminalContendsWithOtherTerminalTrack(
  world: CorridorWorld,
  routes: readonly Route[],
  groupByCorridor: ReadonlyMap<number, CorridorOrderGroup>,
  routeIndex: number,
  visitIndex: number,
): boolean {
  const route = routes[routeIndex];
  const group = groupByCorridor.get(route.visits[visitIndex].corridorIndex);
  if (!group) {
    return false;
  }
  const interval = topologicalTravelInterval(world, route, visitIndex);
  for (const member of group.members) {
    if (member.routeIndex === routeIndex) {
      continue;
    }
    if (
      visitTiedTerminalEnd(routes[member.routeIndex], member.visitIndex) !== undefined &&
      spansOverlapPositive(
        interval,
        topologicalTravelInterval(world, routes[member.routeIndex], member.visitIndex),
        EPSILON,
      )
    ) {
      return true;
    }
  }
  return false;
}

function addTerminalFaceDesires(
  world: CorridorWorld,
  routes: readonly Route[],
  desires: TrackDesire[][][],
  groupByCorridor: ReadonlyMap<number, CorridorOrderGroup>,
): void {
  const preferences: TerminalFacePreference[] = [];
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (route.visits.length === 0) {
      continue;
    }
    addTerminalMember(preferences, routeIndex, 0, route.from, route.to);
    addTerminalMember(preferences, routeIndex, route.visits.length - 1, route.to, route.from);
  }

  for (const preference of preferences) {
    const faceSpan = faceCrossSpan(world.entities[preference.entityIndex], preference.face);
    const usableFace = insetSpan(faceSpan, PORT_EDGE_PADDING_PX, EPSILON) ?? faceSpan;
    const ordered = terminalPreferenceUnits(preference.members)
      .map((members) => ({
        members,
        orderCoordinate:
          members.reduce(
            (sum, member) =>
              sum + endpointCrossCoordinate(world.entities, member.opposite, preference.face),
            0,
          ) / members.length,
        usable: sharedTerminalUsableSpan(world, routes, members),
      }))
      .sort(
        (left, right) =>
          left.orderCoordinate - right.orderCoordinate ||
          left.members[0].routeIndex - right.members[0].routeIndex ||
          left.members[0].visitIndex - right.members[0].visitIndex,
      );
    const gap =
      ordered.length <= 1
        ? 0
        : Math.min(IDEAL_TERMINAL_SEPARATION_PX, spanLength(usableFace) / (ordered.length - 1));
    const packedWidth = gap * (ordered.length - 1);
    const first = clamp(
      midpoint(usableFace) - packedWidth / 2,
      usableFace[0],
      usableFace[1] - packedWidth,
    );
    ordered.forEach((unit, unitIndex) => {
      const pinnedTrack = unit.members
        .map((member) => spacingPinTrack(member.endpoint))
        .find((track) => track !== undefined);
      const ideal = pinnedTrack ?? first + unitIndex * gap;
      // A singleton whose face-center ideal falls outside its feasible window stops at the
      // nearest feasible point instead of jumping to the window middle — unless its track is
      // corridor-coupled to another route's terminal, where the clamp would only transfer the
      // displacement onto the neighbour's port through the separation constraint.
      const singletonOutsideUsable =
        unit.usable !== undefined &&
        ordered.length === 1 &&
        !coordinateInSpan(ideal, unit.usable, EPSILON);
      const guarded =
        singletonOutsideUsable &&
        unit.members.some((member) =>
          terminalContendsWithOtherTerminalTrack(
            world,
            routes,
            groupByCorridor,
            member.routeIndex,
            member.visitIndex,
          ),
        );
      const desired = unit.usable
        ? singletonOutsideUsable && guarded
          ? midpoint(unit.usable)
          : clamp(ideal, unit.usable[0], unit.usable[1])
        : ideal;
      for (const member of unit.members) {
        desires[member.routeIndex][member.visitIndex].push({
          kind: 'terminal',
          track: spacingPinTrack(member.endpoint) ?? desired,
          weight: ENDPOINT_DESIRE_WEIGHT,
        });
      }
    });
  }
}

function sharedTerminalUsableSpan(
  world: CorridorWorld,
  routes: readonly Route[],
  members: readonly TerminalMember[],
): AxisSpan | undefined {
  let shared: AxisSpan | undefined;
  for (const member of members) {
    const faceSpan = faceCrossSpan(
      world.entities[member.endpoint.entityIndex],
      member.endpoint.face,
    );
    const feasible = intersectSpans(
      faceSpan,
      routes[member.routeIndex].visits[member.visitIndex].feasibleTrack,
      EPSILON,
    );
    if (!feasible) {
      return undefined;
    }
    const pinTrack = spacingPinTrack(member.endpoint);
    const usable =
      pinTrack === undefined
        ? (insetSpan(feasible, PORT_EDGE_PADDING_PX, EPSILON) ?? feasible)
        : ([pinTrack, pinTrack] as const);
    shared = shared ? intersectSpans(shared, usable, EPSILON) : usable;
    if (!shared) {
      return undefined;
    }
  }
  return shared;
}

function terminalPreferenceUnits(members: readonly TerminalMember[]): TerminalMember[][] {
  const memberGroups: TerminalMember[][] = [];
  for (const member of members) {
    const existing =
      member.endpoint.portGroup === undefined
        ? undefined
        : memberGroups.find(
            (unit) =>
              unit[0].endpoint.portGroup === member.endpoint.portGroup &&
              unit[0].endpoint.entityIndex === member.endpoint.entityIndex &&
              unit[0].endpoint.face === member.endpoint.face,
          );
    if (existing) {
      existing.push(member);
    } else {
      memberGroups.push([member]);
    }
  }
  return memberGroups;
}

function buildVariable(
  world: CorridorWorld,
  routes: readonly Route[],
  desiredTracks: DesiredTracks,
  corridorIndex: number,
  ref: OrderedVisitRef,
  shortfalls: SpacingShortfall[],
  relaxTurns: boolean,
  relaxPadding: boolean,
  requiredContentionsByVisit: ReadonlyMap<string, ReadonlySet<string>>,
): TrackVariable {
  const route = routes[ref.routeIndex];
  const visit = route.visits[ref.visitIndex];
  let bounds: AxisSpan = relaxTurns
    ? corridorCrossSpan(world.indexer.corridors[corridorIndex])
    : visit.feasibleTrack;
  bounds = terminalApproachBounds(world, route, ref.visitIndex, bounds);
  const endpoints = visitEndpoints(route, ref.visitIndex);
  // Authored ports arrive with their feasible track already collapsed by topology; repair pins
  // reuse incumbent visits, so the collapse to the pinned track happens here instead.
  for (const endpoint of endpoints) {
    if (endpoint.authoredTrack === undefined && endpoint.repairPinTrack !== undefined) {
      bounds = [
        Math.max(bounds[0], endpoint.repairPinTrack),
        Math.min(bounds[1], endpoint.repairPinTrack),
      ];
    }
  }
  let authored = false;
  let endpointGroups: EndpointGroupRef[] | undefined;
  for (const endpoint of endpoints) {
    authored = authored || spacingPinTrack(endpoint) !== undefined;
    if (endpoint.portGroup !== undefined) {
      if (!endpointGroups) {
        endpointGroups = [];
      }
      endpointGroups.push({
        entityIndex: endpoint.entityIndex,
        face: endpoint.face,
        portGroup: endpoint.portGroup,
      });
    }
  }
  if (!relaxPadding && !authored) {
    bounds = applyPadding(
      'corridor-padding',
      corridorIndex,
      ref,
      bounds,
      corridorCrossSpan(world.indexer.corridors[corridorIndex]),
      CORRIDOR_EDGE_PADDING_PX,
      shortfalls,
    );
  }
  for (const endpoint of endpoints) {
    if (!relaxPadding && spacingPinTrack(endpoint) === undefined) {
      bounds = applyPadding(
        'port-padding',
        corridorIndex,
        ref,
        bounds,
        faceCrossSpan(world.entities[endpoint.entityIndex], endpoint.face),
        PORT_EDGE_PADDING_PX,
        shortfalls,
      );
    }
  }
  const corridor = world.indexer.corridors[corridorIndex];
  const travelInterval = possibleTravelInterval(
    world,
    corridor,
    route,
    ref.visitIndex,
    desiredTracks.values[ref.routeIndex],
  );
  return {
    ref,
    travelInterval,
    lower: bounds[0],
    upper: bounds[1],
    desires: desiredTracks.desires[ref.routeIndex][ref.visitIndex],
    authored,
    endpointGroups: endpointGroups ?? EMPTY_ENDPOINT_GROUPS,
    requiredContentionVisitKeys:
      requiredContentionsByVisit.size === 0
        ? undefined
        : requiredContentionsByVisit.get(requiredContentionVisitKey(corridorIndex, ref)),
  };
}

function variablePaddingRules(
  world: CorridorWorld,
  routes: readonly Route[],
  corridorIndex: number,
  ref: OrderedVisitRef,
): PaddingRule[] {
  const route = routes[ref.routeIndex];
  const endpoints = visitEndpoints(route, ref.visitIndex);
  const rules: PaddingRule[] = [];
  if (!endpoints.some((endpoint) => spacingPinTrack(endpoint) !== undefined)) {
    rules.push({
      kind: 'corridor-padding',
      container: corridorCrossSpan(world.indexer.corridors[corridorIndex]),
      padding: CORRIDOR_EDGE_PADDING_PX,
    });
  }
  for (const endpoint of endpoints) {
    if (spacingPinTrack(endpoint) === undefined) {
      rules.push({
        kind: 'port-padding',
        container: faceCrossSpan(world.entities[endpoint.entityIndex], endpoint.face),
        padding: PORT_EDGE_PADDING_PX,
      });
    }
  }
  return rules;
}

function terminalApproachBounds(
  world: CorridorWorld,
  route: Route,
  visitIndex: number,
  bounds: AxisSpan,
): AxisSpan {
  let result = bounds;
  const sourceApproach = terminalApproachVisitIndex(world, route, 'from');
  if (sourceApproach === visitIndex) {
    result = clipToTerminalOutwardSide(world, route.from, result);
  }
  const targetApproach = terminalApproachVisitIndex(world, route, 'to');
  if (targetApproach === visitIndex) {
    result = clipToTerminalOutwardSide(world, route.to, result);
  }
  return result;
}

function terminalApproachVisitIndex(
  world: CorridorWorld,
  route: Route,
  side: EndpointSide,
): number | undefined {
  if (route.visits.length < 2) {
    return undefined;
  }
  const terminalVisitIndex = side === 'from' ? 0 : route.visits.length - 1;
  const terminalAxis = world.indexer.corridors[route.visits[terminalVisitIndex].corridorIndex].axis;
  const step = side === 'from' ? 1 : -1;
  for (
    let visitIndex = terminalVisitIndex + step;
    visitIndex >= 0 && visitIndex < route.visits.length;
    visitIndex += step
  ) {
    const axis = world.indexer.corridors[route.visits[visitIndex].corridorIndex].axis;
    if (axis !== terminalAxis) {
      return visitIndex;
    }
  }
  return undefined;
}

function clipToTerminalOutwardSide(
  world: CorridorWorld,
  endpoint: RouteEndpoint,
  bounds: AxisSpan,
): AxisSpan {
  const plane = terminalFacePlane(world.entities[endpoint.entityIndex], endpoint.face);
  const outwardPlane = endpoint.face === 'left' || endpoint.face === 'up' ? plane - 1 : plane + 1;
  const lower =
    endpoint.face === 'right' || endpoint.face === 'down'
      ? Math.max(bounds[0], Math.min(bounds[1], outwardPlane))
      : bounds[0];
  const upper =
    endpoint.face === 'left' || endpoint.face === 'up'
      ? Math.min(bounds[1], Math.max(bounds[0], outwardPlane))
      : bounds[1];
  if (lower > upper + EPSILON) {
    throw new Error(
      `corridor spacing: terminal ${endpoint.entityIndex}:${endpoint.face} has no outward approach`,
    );
  }
  return [lower, Math.max(lower, upper)];
}

function turnPortalCrossSpan(
  portal: Extract<PortalRef, { readonly kind: 'turn' }>,
  axis: Corridor['axis'],
): AxisSpan {
  return axis === 'x'
    ? [portal.rect.y, portal.rect.y + portal.rect.height]
    : [portal.rect.x, portal.rect.x + portal.rect.width];
}

function applyPadding(
  kind: 'corridor-padding' | 'port-padding',
  corridorIndex: number,
  ref: OrderedVisitRef,
  bounds: AxisSpan,
  container: AxisSpan,
  padding: number,
  shortfalls: SpacingShortfall[],
): AxisSpan {
  const padded = insetSpan(container, padding, EPSILON);
  const intersection = padded ? intersectSpans(bounds, padded, EPSILON) : undefined;
  if (intersection) {
    return intersection;
  }
  shortfalls.push({
    kind,
    corridorIndex,
    routeIndexes: [ref.routeIndex],
    visitIndexes: [ref.visitIndex],
    required: padding,
    achieved: maximumClearance(bounds, container),
  });
  return bounds;
}

function buildUnits(
  group: CorridorOrderGroup,
  variables: readonly TrackVariable[],
  shortfalls: SpacingShortfall[],
  workspace: SpacingRunWorkspace,
): TrackUnit[] {
  const { trackUnitUnionFind } = workspace;
  trackUnitUnionFind.reset(variables.length);
  for (let left = 0; left < variables.length; left += 1) {
    for (let right = left + 1; right < variables.length; right += 1) {
      if (sharesEndpointGroup(variables[left], variables[right])) {
        trackUnitUnionFind.unionInto(left, right);
      }
    }
  }

  const membersByRoot = new Map<number, number[]>();
  for (let index = 0; index < variables.length; index += 1) {
    const componentRoot = trackUnitUnionFind.find(index);
    const indexes = membersByRoot.get(componentRoot) ?? [];
    indexes.push(index);
    membersByRoot.set(componentRoot, indexes);
  }
  const units: TrackUnit[] = [];
  // Indexes are visited in ascending order, so map insertion order is already
  // ascending by each component's first member.
  for (const indexes of membersByRoot.values()) {
    const contiguous = indexes[indexes.length - 1] - indexes[0] + 1 === indexes.length;
    const members: TrackVariable[] = [];
    let lower = Number.NEGATIVE_INFINITY;
    let upper = Number.POSITIVE_INFINITY;
    for (const memberIndex of indexes) {
      const member = variables[memberIndex];
      members.push(member);
      lower = Math.max(lower, member.lower);
      upper = Math.min(upper, member.upper);
    }
    if (!contiguous || lower > upper + EPSILON) {
      shortfalls.push(shortfall('combined-port', group.corridorIndex, members, 0, upper - lower));
      for (const member of members) {
        units.push({
          members: [member],
          lower: member.lower,
          upper: member.upper,
          desires: member.desires,
          authored: member.authored,
        });
      }
      continue;
    }
    const desires: TrackDesire[] = [];
    for (const member of members) {
      desires.push(...member.desires);
    }
    units.push({
      members,
      lower,
      upper: Math.max(lower, upper),
      desires,
      authored: members.some((member) => member.authored),
    });
  }
  return units;
}

function sharesEndpointGroup(left: TrackVariable, right: TrackVariable): boolean {
  return left.endpointGroups.some((leftGroup) =>
    right.endpointGroups.some(
      (rightGroup) =>
        leftGroup.entityIndex === rightGroup.entityIndex &&
        leftGroup.face === rightGroup.face &&
        leftGroup.portGroup === rightGroup.portGroup,
    ),
  );
}

function buildContentionComponents(units: readonly TrackUnit[], unionFind: UnionFind): number[][] {
  unionFind.reset(units.length);
  for (let left = 0; left < units.length; left += 1) {
    for (let right = left + 1; right < units.length; right += 1) {
      if (!unitsContend(units[left], units[right])) {
        continue;
      }
      unionFind.unionMin(left, right);
    }
  }
  const indexesByRoot = new Map<number, number[]>();
  for (let index = 0; index < units.length; index += 1) {
    const componentRoot = unionFind.find(index);
    const indexes = indexesByRoot.get(componentRoot);
    if (indexes) {
      indexes.push(index);
    } else {
      indexesByRoot.set(componentRoot, [index]);
    }
  }
  // unionMin makes the first member the root, so insertion order is canonical.
  return [...indexesByRoot.values()];
}

function unitsContend(left: TrackUnit, right: TrackUnit): boolean {
  for (const leftMember of left.members) {
    for (const rightMember of right.members) {
      if (
        spansOverlapPositive(leftMember.travelInterval, rightMember.travelInterval, EPSILON) ||
        leftMember.requiredContentionVisitKeys?.has(
          visitKey(rightMember.ref.routeIndex, rightMember.ref.visitIndex),
        ) === true ||
        rightMember.requiredContentionVisitKeys?.has(
          visitKey(leftMember.ref.routeIndex, leftMember.ref.visitIndex),
        ) === true
      ) {
        return true;
      }
    }
  }
  return false;
}

function shortfall(
  kind: SpacingShortfallKind,
  corridorIndex: number,
  variables: readonly TrackVariable[],
  required: number,
  achieved: number,
): SpacingShortfall {
  return {
    kind,
    corridorIndex,
    routeIndexes: variables.map((variable) => variable.ref.routeIndex),
    visitIndexes: variables.map((variable) => variable.ref.visitIndex),
    required,
    achieved,
  };
}

function memberCorridorIndex(routes: readonly Route[], members: readonly TrackVariable[]): number {
  return routes[members[0].ref.routeIndex].visits[members[0].ref.visitIndex].corridorIndex;
}

function reductionShortfall(
  kind: SpacingShortfallKind,
  corridorIndex: number,
  reduction: CapacityReduction,
  units: readonly TrackUnit[],
): SpacingShortfall {
  const routeIndexes: number[] = [];
  const visitIndexes: number[] = [];
  for (const unitIndex of reduction.unitIndexes) {
    for (const member of units[unitIndex].members) {
      routeIndexes.push(member.ref.routeIndex);
      visitIndexes.push(member.ref.visitIndex);
    }
  }
  return {
    kind,
    corridorIndex,
    routeIndexes,
    visitIndexes,
    required: reduction.required,
    achieved: reduction.achieved,
  };
}

function visitEndpoints(route: Route, visitIndex: number): readonly RouteEndpoint[] {
  if (visitIndex === 0) {
    return route.visits.length === 1 ? [route.from, route.to] : [route.from];
  }
  return visitIndex === route.visits.length - 1 ? [route.to] : EMPTY_ROUTE_ENDPOINTS;
}

function outsideTerminalIdealSeed(
  world: CorridorWorld,
  endpoint: RouteEndpoint,
  adjacentVisit: Route['visits'][number],
  terminalLead: number,
  balanceNarrowEntityGap = false,
): CorridorIdealSeed {
  const entity = world.entities[endpoint.entityIndex];
  const plane = terminalFacePlane(entity, endpoint.face);
  const corridor = world.indexer.corridors[adjacentVisit.corridorIndex];
  const center = corridorCenter(corridor);
  const direction = endpoint.face === 'left' || endpoint.face === 'up' ? 'negative' : 'positive';
  const desiredTrack =
    direction === 'negative'
      ? Math.min(center, plane - terminalLead)
      : Math.max(center, plane + terminalLead);
  const policy: CorridorIdealPolicy = {
    kind: 'terminal-lead',
    desiredTrack,
    plane,
    direction,
  };
  const travelInterval = faceCrossSpan(entity, endpoint.face);
  const ordinary = corridorIdealTrack(corridor, travelInterval);
  const [negative, positive] = corridorBorderInfluences(corridor, travelInterval);
  const centeredLead = direction === 'negative' ? plane - ordinary : ordinary - plane;
  const paddedFeasible =
    insetSpan(adjacentVisit.feasibleTrack, CORRIDOR_EDGE_PADDING_PX, EPSILON) ??
    adjacentVisit.feasibleTrack;
  const realizableLeadTrack = clamp(desiredTrack, paddedFeasible[0], paddedFeasible[1]);
  const useBalancedGap =
    balanceNarrowEntityGap &&
    negative === 'entity' &&
    positive === 'entity' &&
    centeredLead < IDEAL_TERMINAL_SEPARATION_PX - EPSILON &&
    Math.abs(realizableLeadTrack - ordinary) >= CORRIDOR_EDGE_PADDING_PX - EPSILON;
  return {
    track: useBalancedGap ? ordinary : desiredTrack,
    weight: useBalancedGap ? CORRIDOR_IDEAL_DESIRE_WEIGHT : TERMINAL_CORRIDOR_IDEAL_WEIGHT,
    ...(useBalancedGap ? {} : { policy }),
  };
}

function bridgeTerminalIdealSeed(world: CorridorWorld, route: Route): CorridorIdealSeed {
  const visit = route.visits[1];
  const center = corridorCenter(world.indexer.corridors[visit.corridorIndex]);
  let lower = Number.NEGATIVE_INFINITY;
  let upper = Number.POSITIVE_INFINITY;
  let idealLower = Number.NEGATIVE_INFINITY;
  let idealUpper = Number.POSITIVE_INFINITY;
  const endpoints = [route.from, route.to].filter(endpointNeedsTerminalLead);
  if (endpoints.length === 0) {
    return { track: center, weight: CORRIDOR_IDEAL_DESIRE_WEIGHT };
  }
  for (const endpoint of endpoints) {
    const plane = terminalFacePlane(world.entities[endpoint.entityIndex], endpoint.face);
    if (endpoint.face === 'left' || endpoint.face === 'up') {
      upper = Math.min(upper, plane - TERMINAL_LEAD_PX);
      idealUpper = Math.min(idealUpper, plane - IDEAL_TERMINAL_SEPARATION_PX);
    } else {
      lower = Math.max(lower, plane + TERMINAL_LEAD_PX);
      idealLower = Math.max(idealLower, plane + IDEAL_TERMINAL_SEPARATION_PX);
    }
  }
  const desiredTrack = lower <= upper ? clamp(center, lower, upper) : (lower + upper) / 2;
  return {
    track: desiredTrack,
    weight: TERMINAL_CORRIDOR_IDEAL_WEIGHT,
    policy: {
      kind: 'terminal-window',
      desiredTrack,
      lower: idealLower,
      upper: idealUpper,
    },
  };
}

/** Prefer a compact crossbar when the neighboring legs reverse direction. */
function uTurnCoordinate(
  world: CorridorWorld,
  route: Route,
  visitIndex: number,
): number | undefined {
  const previous = route.visits[visitIndex - 1];
  const visit = route.visits[visitIndex];
  const next = route.visits[visitIndex + 1];
  const previousCorridor = world.indexer.corridors[previous.corridorIndex];
  const corridor = world.indexer.corridors[visit.corridorIndex];
  const nextCorridor = world.indexer.corridors[next.corridorIndex];
  if (
    previousCorridor.axis !== nextCorridor.axis ||
    previousCorridor.axis === corridor.axis ||
    visitHasContinuationBoundary(visit)
  ) {
    return undefined;
  }

  const previousOuter = boundaryTravelCoordinate(world, previousCorridor, previous.entry);
  const nextOuter = boundaryTravelCoordinate(world, nextCorridor, next.exit);
  const outerStart = Math.min(previousOuter, nextOuter);
  const outerEnd = Math.max(previousOuter, nextOuter);
  const cross = corridorCrossSpan(corridor);
  const center = midpoint(cross);
  if (cross[1] <= outerStart + EPSILON) {
    return Math.max(center, cross[1] - U_TURN_DEPTH_PX);
  }
  if (cross[0] >= outerEnd - EPSILON) {
    return Math.min(center, cross[0] + U_TURN_DEPTH_PX);
  }
  return undefined;
}

function maximumClearance(bounds: AxisSpan, container: AxisSpan): number {
  const best = clamp(midpoint(container), bounds[0], bounds[1]);
  return Math.max(0, Math.min(best - container[0], container[1] - best));
}
