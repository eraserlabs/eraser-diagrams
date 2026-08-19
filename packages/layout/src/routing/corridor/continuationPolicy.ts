import type { AxisSpan } from '../../types.js';
import {
  clamp,
  coordinateInSpan,
  intersectSpans,
  midpoint,
  spanContains,
  spanLength,
} from '../../rangeUtils.js';
import type { RouteEndpoint } from './contract.js';
import { continuationBundlePlacement } from './continuationGeometry.js';
import {
  continuationKey,
  continuationKeySet,
  type ContinuationBoundaryRef,
  type IndependentContinuationBoundary,
} from './continuations.js';
import { boundaryTravelCoordinate, corridorCrossSpan, faceCrossSpan } from './geometry.js';
import type { Route, VisitBoundary } from './route.js';
import { canFitOrderedSpacingGap, type SpacingKernelUnit } from './spacingKernel.js';
import { compileTrackDesires, type TrackDesire } from './spacingObjective.js';
import type { UnionFind } from './unionFind.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;

type ContinuationPolicyReason =
  | 'default-equal'
  | 'equal-span'
  | 'partial-overlap'
  | 'no-host-runway'
  | 'empty-padded-intersection'
  | 'terminal-lead-conflict'
  | 'terminal-center-conflict'
  | 'bundle-safety'
  | 'solver-fallback'
  | 'forced-independent';

export interface ContinuationBoundaryPolicy {
  readonly routeIndex: number;
  readonly afterVisitIndex: number;
  readonly beforeCorridorIndex: number;
  readonly afterCorridorIndex: number;
  readonly policy: 'equal' | 'independent';
  readonly reason: ContinuationPolicyReason;
  /** True when enabling terminal-center relaxation could change this strict boundary. */
  readonly terminalCenterCandidate: boolean;
}

export interface ContinuationPolicyTuning {
  readonly minimumTrackSeparation: number;
  readonly corridorEdgePadding: number;
  readonly directFanFaceSpan: number;
  readonly narrowSpan: number;
  readonly terminalConflict: number;
}

export interface FlexibleContinuationRef extends ContinuationBoundaryRef {
  readonly beforeLocalUnit: number;
  readonly afterLocalUnit: number;
}

/** The policy only needs visit identity and whether a member belongs to an endpoint group. */
interface ContinuationUnitMember {
  readonly ref: {
    readonly routeIndex: number;
    readonly visitIndex: number;
  };
  readonly endpointGroups: readonly unknown[];
}

/** Structural policy view that preserves the caller's concrete member type. */
interface ContinuationPolicyUnit<Member extends ContinuationUnitMember> extends SpacingKernelUnit {
  readonly members: readonly Member[];
}

export function planContinuationPolicies<Member extends ContinuationUnitMember>(
  world: CorridorWorld,
  routes: readonly Route[],
  localUnits: readonly ContinuationPolicyUnit<Member>[],
  continuations: readonly FlexibleContinuationRef[],
  independentContinuations: readonly IndependentContinuationBoundary[],
  terminalCenterContinuations: boolean,
  continuationUnionFind: UnionFind,
  tuning: ContinuationPolicyTuning,
) {
  const forcedIndependentKeys = continuationKeySet(independentContinuations);
  const continuationKeys = new Set<string>();
  const relaxationReasonByKey = new Map<string, ContinuationPolicyReason>();
  const proposedReasons = new Map<string, ContinuationPolicyReason>();
  const terminalCenterCandidateKeys = new Set<string>();
  for (const continuation of continuations) {
    const key = continuationKey(continuation.routeIndex, continuation.afterVisitIndex);
    continuationKeys.add(key);
    relaxationReasonByKey.set(
      key,
      continuationRelaxationReason(world, routes[continuation.routeIndex], continuation),
    );
    if (forcedIndependentKeys.has(key)) {
      proposedReasons.set(key, 'forced-independent');
    }
  }
  for (const key of forcedIndependentKeys) {
    if (!continuationKeys.has(key)) {
      throw new Error(`corridor spacing: forced continuation ${key} does not exist`);
    }
  }
  for (const continuation of continuations) {
    const key = continuationKey(continuation.routeIndex, continuation.afterVisitIndex);
    const route = routes[continuation.routeIndex];
    if (proposedReasons.has(key)) {
      continue;
    }
    const relaxationReason = relaxationReasonByKey.get(key) as ContinuationPolicyReason;
    const relaxationEligible = relaxationReason === 'default-equal';
    const beforeUnit = localUnits[continuation.beforeLocalUnit];
    const afterUnit = localUnits[continuation.afterLocalUnit];
    const hasTerminalConflict = singletonTerminalCenterConflict(
      world,
      route,
      continuation,
      beforeUnit,
      afterUnit,
      tuning,
    );
    const terminalPartialOverlap =
      relaxationReason === 'partial-overlap' &&
      hasTerminalConflict &&
      terminalConflictHasContainingHost(world, route, continuation, beforeUnit, afterUnit) &&
      continuationHasHostRunway(world, route, continuation);
    const terminalLeadConflict =
      relaxationReason === 'no-host-runway' &&
      collapsedTerminalLeadConflict(world, route, continuation, beforeUnit, afterUnit, tuning);
    if (!relaxationEligible && !terminalPartialOverlap && !terminalLeadConflict) {
      continue;
    }
    const paddedIntersection = intersectSpans(
      [beforeUnit.lower, beforeUnit.upper],
      [afterUnit.lower, afterUnit.upper],
      EPSILON,
    );
    if (
      hasTerminalConflict &&
      (relaxationEligible || terminalPartialOverlap) &&
      paddedIntersection
    ) {
      terminalCenterCandidateKeys.add(key);
    }
    if (terminalCenterContinuations && hasTerminalConflict) {
      proposedReasons.set(key, 'terminal-center-conflict');
    } else if (terminalLeadConflict) {
      proposedReasons.set(key, 'terminal-lead-conflict');
    } else if (!paddedIntersection) {
      proposedReasons.set(key, 'empty-padded-intersection');
    }
  }

  const proposed = continuations.filter((continuation) =>
    proposedReasons.has(continuationKey(continuation.routeIndex, continuation.afterVisitIndex)),
  );
  const flexibleContinuations = discoverFlexibleContinuations(
    world,
    routes,
    localUnits,
    continuations,
    proposed,
    continuationUnionFind,
  );
  const flexibleKeys = continuationKeySet(flexibleContinuations);
  for (const key of forcedIndependentKeys) {
    if (!flexibleKeys.has(key)) {
      throw new Error(`corridor spacing: forced continuation ${key} is not bundle-safe`);
    }
  }
  const policies = continuations.map((continuation): ContinuationBoundaryPolicy => {
    const route = routes[continuation.routeIndex];
    const key = continuationKey(continuation.routeIndex, continuation.afterVisitIndex);
    const relaxationReason = relaxationReasonByKey.get(key) as ContinuationPolicyReason;
    const proposedReason = proposedReasons.get(key);
    const policy = flexibleKeys.has(key) ? 'independent' : 'equal';
    const reason = proposedReason && policy === 'equal' ? 'bundle-safety' : proposedReason;
    return {
      routeIndex: continuation.routeIndex,
      afterVisitIndex: continuation.afterVisitIndex,
      beforeCorridorIndex: route.visits[continuation.afterVisitIndex - 1].corridorIndex,
      afterCorridorIndex: route.visits[continuation.afterVisitIndex].corridorIndex,
      policy,
      reason: reason ?? relaxationReason,
      terminalCenterCandidate: terminalCenterCandidateKeys.has(key),
    };
  });
  return { flexibleContinuations, policies };
}

function singletonTerminalCenterConflict<Member extends ContinuationUnitMember>(
  world: CorridorWorld,
  route: Route,
  continuation: FlexibleContinuationRef,
  before: ContinuationPolicyUnit<Member>,
  after: ContinuationPolicyUnit<Member>,
  tuning: ContinuationPolicyTuning,
): boolean {
  if (before.members.length !== 1 || after.members.length !== 1) {
    return false;
  }
  const beforeTerminal = before.desires.find((desire) => desire.kind === 'terminal');
  const afterTerminal = after.desires.find((desire) => desire.kind === 'terminal');
  if (beforeTerminal && afterTerminal) {
    return (
      Math.abs(beforeTerminal.track - afterTerminal.track) >= tuning.terminalConflict - EPSILON
    );
  }
  const terminal = beforeTerminal ?? afterTerminal;
  if (!terminal) {
    return false;
  }
  const terminalVisitIndex = beforeTerminal
    ? continuation.afterVisitIndex - 1
    : continuation.afterVisitIndex;
  const endpoint =
    terminalVisitIndex === 0
      ? route.from
      : terminalVisitIndex === route.visits.length - 1
        ? route.to
        : undefined;
  if (
    !endpoint ||
    spanLength(faceCrossSpan(world.entities[endpoint.entityIndex], endpoint.face)) >
      tuning.directFanFaceSpan + EPSILON
  ) {
    return false;
  }
  const neighbor = beforeTerminal ? after : before;
  return terminal.track < neighbor.lower - EPSILON || terminal.track > neighbor.upper + EPSILON;
}

function terminalConflictHasContainingHost<Member extends ContinuationUnitMember>(
  world: CorridorWorld,
  route: Route,
  continuation: FlexibleContinuationRef,
  before: ContinuationPolicyUnit<Member>,
  after: ContinuationPolicyUnit<Member>,
): boolean {
  const beforeTerminal = before.desires.find((desire) => desire.kind === 'terminal');
  const afterTerminal = after.desires.find((desire) => desire.kind === 'terminal');
  if (!beforeTerminal || !afterTerminal) {
    return false;
  }
  const beforeCorridor =
    world.indexer.corridors[route.visits[continuation.afterVisitIndex - 1].corridorIndex];
  const afterCorridor =
    world.indexer.corridors[route.visits[continuation.afterVisitIndex].corridorIndex];
  return (
    coordinateInSpan(afterTerminal.track, corridorCrossSpan(beforeCorridor), EPSILON) ||
    coordinateInSpan(beforeTerminal.track, corridorCrossSpan(afterCorridor), EPSILON)
  );
}

function collapsedTerminalLeadConflict<Member extends ContinuationUnitMember>(
  world: CorridorWorld,
  route: Route,
  continuation: FlexibleContinuationRef,
  before: ContinuationPolicyUnit<Member>,
  after: ContinuationPolicyUnit<Member>,
  tuning: ContinuationPolicyTuning,
): boolean {
  if (
    !continuationHasTerminalLead(world, route, continuation.afterVisitIndex, tuning) ||
    !continuationHasGuaranteedShiftRunway(world, route, continuation, tuning)
  ) {
    return false;
  }
  const beforeVisit = route.visits[continuation.afterVisitIndex - 1];
  const afterVisit = route.visits[continuation.afterVisitIndex];
  const sharedTrack = intersectSpans(beforeVisit.feasibleTrack, afterVisit.feasibleTrack, EPSILON);
  if (!sharedTrack || spanLength(sharedTrack) > EPSILON) {
    return false;
  }
  const equalTrack = midpoint(sharedTrack);
  const beforeDesired = clamp(
    compileTrackDesires(before.desires).track,
    before.lower,
    before.upper,
  );
  const afterDesired = clamp(compileTrackDesires(after.desires).track, after.lower, after.upper);
  return (
    Math.max(Math.abs(beforeDesired - equalTrack), Math.abs(afterDesired - equalTrack)) >=
    tuning.minimumTrackSeparation - EPSILON
  );
}

function continuationHasGuaranteedShiftRunway(
  world: CorridorWorld,
  route: Route,
  continuation: FlexibleContinuationRef,
  tuning: ContinuationPolicyTuning,
): boolean {
  const placement = continuationBundlePlacement(world, route, continuation);
  const hostBefore = placement.hostVisitIndex === continuation.afterVisitIndex - 1;
  const hostVisit = route.visits[placement.hostVisitIndex];
  const farBoundary = hostBefore ? hostVisit.entry : hostVisit.exit;
  const adjacentVisitIndex = hostBefore
    ? placement.hostVisitIndex - 1
    : placement.hostVisitIndex + 1;
  const adjacentVisit = route.visits[adjacentVisitIndex];
  const entry = route.visits[continuation.afterVisitIndex].entry;
  if (
    farBoundary.kind !== 'portal' ||
    farBoundary.mode !== 'turn' ||
    !adjacentVisit ||
    entry.kind !== 'portal'
  ) {
    return false;
  }
  const portal = world.indexer.portals[entry.portalIndex];
  if (portal.kind !== 'continue') {
    return false;
  }
  const eventCoordinate = portal.planeCoordinate;
  const guaranteedDistance = Math.max(
    adjacentVisit.feasibleTrack[0] - eventCoordinate,
    eventCoordinate - adjacentVisit.feasibleTrack[1],
    0,
  );
  return guaranteedDistance >= tuning.minimumTrackSeparation + tuning.corridorEdgePadding - EPSILON;
}

function continuationRelaxationReason(
  world: CorridorWorld,
  route: Route,
  continuation: FlexibleContinuationRef,
): ContinuationPolicyReason {
  const before =
    world.indexer.corridors[route.visits[continuation.afterVisitIndex - 1].corridorIndex];
  const after = world.indexer.corridors[route.visits[continuation.afterVisitIndex].corridorIndex];
  const beforeCross = corridorCrossSpan(before);
  const afterCross = corridorCrossSpan(after);
  const beforeLength = spanLength(beforeCross);
  const afterLength = spanLength(afterCross);
  if (Math.abs(beforeLength - afterLength) <= EPSILON) {
    return 'equal-span';
  }
  if (
    !spanContains(beforeCross, afterCross, EPSILON) &&
    !spanContains(afterCross, beforeCross, EPSILON)
  ) {
    return 'partial-overlap';
  }
  if (!continuationHasHostRunway(world, route, continuation)) {
    return 'no-host-runway';
  }
  return 'default-equal';
}

function discoverFlexibleContinuations<Member extends ContinuationUnitMember>(
  world: CorridorWorld,
  routes: readonly Route[],
  localUnits: readonly ContinuationPolicyUnit<Member>[],
  continuations: readonly FlexibleContinuationRef[],
  candidates: readonly FlexibleContinuationRef[],
  continuationUnionFind: UnionFind,
): FlexibleContinuationRef[] {
  let retained = [...candidates];
  while (true) {
    const retainedKeys = continuationKeySet(retained);
    const strictRootByLocal = continuationRoots(
      localUnits.length,
      continuations,
      retainedKeys,
      continuationUnionFind,
    );
    const feasible = feasibleBoundaryContinuations(
      world,
      routes,
      localUnits,
      strictRootByLocal,
      retained,
    );
    if (feasible.length === retained.length) {
      return feasible;
    }
    retained = feasible;
  }
}

export function continuationRoots(
  unitCount: number,
  continuations: readonly FlexibleContinuationRef[],
  flexibleKeys: ReadonlySet<string>,
  continuationUnionFind: UnionFind,
): Int32Array {
  continuationUnionFind.reset(unitCount);
  for (const continuation of continuations) {
    if (flexibleKeys.has(continuationKey(continuation.routeIndex, continuation.afterVisitIndex))) {
      continue;
    }
    continuationUnionFind.unionInto(continuation.beforeLocalUnit, continuation.afterLocalUnit);
  }
  const roots = new Int32Array(unitCount);
  for (let index = 0; index < unitCount; index += 1) {
    roots[index] = continuationUnionFind.find(index);
  }
  return roots;
}

/** Merge one strict continuation component: intersect padded bounds, fall back to raw tracks. */
export function mergeContinuationComponentUnit<Member extends ContinuationUnitMember>(
  routes: readonly Route[],
  localUnits: readonly ContinuationPolicyUnit<Member>[],
  indexes: readonly number[],
) {
  const members = indexes.flatMap((index) => localUnits[index].members);
  let lower = Math.max(...indexes.map((index) => localUnits[index].lower));
  let upper = Math.min(...indexes.map((index) => localUnits[index].upper));
  let emptyPaddedBounds: { readonly achieved: number; readonly rawInfeasible: boolean } | undefined;
  if (lower > upper + EPSILON) {
    const achieved = upper - lower;
    lower = Math.max(
      ...members.map(
        (member) => routes[member.ref.routeIndex].visits[member.ref.visitIndex].feasibleTrack[0],
      ),
    );
    upper = Math.min(
      ...members.map(
        (member) => routes[member.ref.routeIndex].visits[member.ref.visitIndex].feasibleTrack[1],
      ),
    );
    emptyPaddedBounds = { achieved, rawInfeasible: lower > upper + EPSILON };
  }
  return {
    unit: {
      members,
      lower,
      upper: Math.max(lower, upper),
      desires: continuationComponentDesires(
        indexes,
        localUnits,
        members,
        lower,
        Math.max(lower, upper),
      ),
      authored: indexes.some((index) => localUnits[index].authored),
    },
    emptyPaddedBounds,
  };
}

function continuationComponentDesires<Member extends ContinuationUnitMember>(
  indexes: readonly number[],
  localUnits: readonly ContinuationPolicyUnit<Member>[],
  members: readonly Member[],
  lower: number,
  upper: number,
): TrackDesire[] {
  const desires = indexes.flatMap((index) => localUnits[index].desires);
  if (desires.length < 2 || desires.some((desire) => desire.kind !== 'corridor-ideal')) {
    return desires;
  }
  const routeIndex = members[0]?.ref.routeIndex;
  if (
    members.some(
      (member) => member.endpointGroups.length > 0 || member.ref.routeIndex !== routeIndex,
    )
  ) {
    return desires;
  }
  const realizableOrdinary = desires.filter(
    (desire) => desire.track >= lower - EPSILON && desire.track <= upper + EPSILON,
  );
  if (realizableOrdinary.length === 0) {
    return desires;
  }
  const consensusTrack = realizableOrdinary[0].track;
  if (realizableOrdinary.some((desire) => Math.abs(desire.track - consensusTrack) > EPSILON)) {
    return desires;
  }
  return realizableOrdinary;
}

function continuationHasHostRunway(
  world: CorridorWorld,
  route: Route,
  continuation: FlexibleContinuationRef,
): boolean {
  const placement = continuationBundlePlacement(world, route, continuation);
  const hostBefore = placement.hostVisitIndex === continuation.afterVisitIndex - 1;
  const hostVisit = route.visits[placement.hostVisitIndex];
  const farBoundary = hostBefore ? hostVisit.entry : hostVisit.exit;
  const hostCorridor = world.indexer.corridors[hostVisit.corridorIndex];
  const entry = route.visits[continuation.afterVisitIndex].entry;
  if (entry.kind !== 'portal') {
    throw new Error(`route ${route.requestIndex}: continuation portal missing`);
  }
  const portal = world.indexer.portals[entry.portalIndex];
  if (portal.kind !== 'continue') {
    throw new Error(`route ${route.requestIndex}: continuation event missing`);
  }
  const eventCoordinate = portal.planeCoordinate;
  if (farBoundary.kind === 'portal' && farBoundary.mode === 'turn') {
    const turn = world.indexer.portals[farBoundary.portalIndex];
    if (turn.kind !== 'turn') {
      throw new Error(`route ${route.requestIndex}: turn runway boundary missing`);
    }
    const turnTravel: AxisSpan =
      hostCorridor.axis === 'x'
        ? [turn.rect.x, turn.rect.x + turn.rect.width]
        : [turn.rect.y, turn.rect.y + turn.rect.height];
    if (coordinateInSpan(eventCoordinate, turnTravel, EPSILON)) {
      return false;
    }
  }
  return (
    Math.abs(boundaryTravelCoordinate(world, hostCorridor, farBoundary) - eventCoordinate) > EPSILON
  );
}

function feasibleBoundaryContinuations<Member extends ContinuationUnitMember>(
  world: CorridorWorld,
  routes: readonly Route[],
  localUnits: readonly ContinuationPolicyUnit<Member>[],
  strictRootByLocal: Int32Array,
  continuations: readonly FlexibleContinuationRef[],
): FlexibleContinuationRef[] {
  const localIndexesByRoot = new Map<number, number[]>();
  strictRootByLocal.forEach((root, localIndex) => {
    const indexes = localIndexesByRoot.get(root) ?? [];
    indexes.push(localIndex);
    localIndexesByRoot.set(root, indexes);
  });
  const unitByRoot = new Map<number, ContinuationPolicyUnit<Member>>();
  for (const [root, indexes] of localIndexesByRoot) {
    unitByRoot.set(root, mergeContinuationComponentUnit(routes, localUnits, indexes).unit);
  }
  const bundles = new Map<
    string,
    Array<{
      readonly continuation: FlexibleContinuationRef;
      readonly hostLocalUnit: number;
      readonly mouthLocalUnit: number;
      readonly mouthOrder: number;
    }>
  >();
  for (const continuation of continuations) {
    const route = routes[continuation.routeIndex];
    const placement = continuationBundlePlacement(world, route, continuation);
    const hostBefore = placement.hostVisitIndex === continuation.afterVisitIndex - 1;
    const members = bundles.get(placement.key) ?? [];
    members.push({
      continuation,
      hostLocalUnit: hostBefore ? continuation.beforeLocalUnit : continuation.afterLocalUnit,
      mouthLocalUnit: hostBefore ? continuation.afterLocalUnit : continuation.beforeLocalUnit,
      mouthOrder: route.orderOf(placement.mouthVisitIndex),
    });
    bundles.set(placement.key, members);
  }

  const retained = new Set<string>();
  for (const members of bundles.values()) {
    const ordered = [...members].sort(
      (left, right) =>
        left.mouthOrder - right.mouthOrder ||
        left.continuation.routeIndex - right.continuation.routeIndex,
    );
    const hostUnits = strictUnits(
      ordered.map((member) => member.hostLocalUnit),
      strictRootByLocal,
      unitByRoot,
    );
    const mouthUnits = strictUnits(
      ordered.map((member) => member.mouthLocalUnit),
      strictRootByLocal,
      unitByRoot,
    );
    if (
      !nondecreasingDesires(hostUnits) ||
      !nondecreasingDesires(mouthUnits) ||
      !canFitOrderedSpacingGap(hostUnits, undefined, 0) ||
      !canFitOrderedSpacingGap(mouthUnits, undefined, 0)
    ) {
      continue;
    }
    for (const member of ordered) {
      retained.add(
        continuationKey(member.continuation.routeIndex, member.continuation.afterVisitIndex),
      );
    }
  }
  return continuations.filter((continuation) =>
    retained.has(continuationKey(continuation.routeIndex, continuation.afterVisitIndex)),
  );
}

function strictUnits<Member extends ContinuationUnitMember>(
  indexes: readonly number[],
  strictRootByLocal: Int32Array,
  unitByRoot: ReadonlyMap<number, ContinuationPolicyUnit<Member>>,
): ContinuationPolicyUnit<Member>[] {
  const seen = new Set<number>();
  return indexes.flatMap((index) => {
    const root = strictRootByLocal[index];
    if (seen.has(root)) {
      return [];
    }
    seen.add(root);
    return [unitByRoot.get(root) as ContinuationPolicyUnit<Member>];
  });
}

function nondecreasingDesires<Member extends ContinuationUnitMember>(
  units: readonly ContinuationPolicyUnit<Member>[],
): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const unit of units) {
    const desired = compileTrackDesires(unit.desires).track;
    if (previous > desired + EPSILON) {
      return false;
    }
    previous = desired;
  }
  return true;
}

export function isStraightContinuationBoundary(boundary: VisitBoundary): boolean {
  return boundary.kind === 'portal' && boundary.mode === 'continue-straight';
}

export function visitHasContinuationBoundary(visit: Route['visits'][number]): boolean {
  return isStraightContinuationBoundary(visit.entry) || isStraightContinuationBoundary(visit.exit);
}

export function continuedTargetTerminalLeadRunStart(
  world: CorridorWorld,
  route: Route,
  tuning: ContinuationPolicyTuning,
): number | undefined {
  if (!endpointNeedsTerminalLead(route.to) || route.visits.length < 3) {
    return undefined;
  }
  const beforeLast = route.visits.length - 2;
  if (!visitHasContinuationBoundary(route.visits[beforeLast])) {
    return undefined;
  }
  const terminalParallelCorridor = world.indexer.corridors[route.visits[beforeLast].corridorIndex];
  if (
    spanLength(corridorCrossSpan(terminalParallelCorridor)) >=
    2 * tuning.minimumTrackSeparation
  ) {
    return undefined;
  }
  let runStart = beforeLast;
  while (runStart > 0 && isStraightContinuationBoundary(route.visits[runStart].entry)) {
    runStart -= 1;
  }
  return runStart;
}

export function continuedSourceTerminalLeadRunEnd(
  world: CorridorWorld,
  route: Route,
  tuning: ContinuationPolicyTuning,
): number | undefined {
  if (!endpointNeedsTerminalLead(route.from) || route.visits.length < 3) {
    return undefined;
  }
  const afterFirst = 1;
  if (!visitHasContinuationBoundary(route.visits[afterFirst])) {
    return undefined;
  }
  const terminalParallelCorridor = world.indexer.corridors[route.visits[afterFirst].corridorIndex];
  // Source-side continuations need a lead even when they can fit multiple tracks;
  // the topology's existing narrow-span policy bounds how broadly this propagates.
  if (spanLength(corridorCrossSpan(terminalParallelCorridor)) > tuning.narrowSpan + EPSILON) {
    return undefined;
  }
  let runEnd = afterFirst;
  while (
    runEnd + 1 < route.visits.length &&
    isStraightContinuationBoundary(route.visits[runEnd].exit)
  ) {
    runEnd += 1;
  }
  return runEnd;
}

function continuationHasTerminalLead(
  world: CorridorWorld,
  route: Route,
  afterVisitIndex: number,
  tuning: ContinuationPolicyTuning,
): boolean {
  const sourceRunEnd = continuedSourceTerminalLeadRunEnd(world, route, tuning);
  if (sourceRunEnd !== undefined && afterVisitIndex > 1 && afterVisitIndex <= sourceRunEnd) {
    return true;
  }
  const targetRunStart = continuedTargetTerminalLeadRunStart(world, route, tuning);
  return (
    targetRunStart !== undefined &&
    afterVisitIndex > targetRunStart &&
    afterVisitIndex <= route.visits.length - 2
  );
}

export function endpointNeedsTerminalLead(endpoint: RouteEndpoint): boolean {
  // Missing arrowhead metadata defaults to the arrowed endpoint behavior.
  return endpoint.hasArrowhead !== false;
}
