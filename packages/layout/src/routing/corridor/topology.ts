import { PriorityQueue } from '../../PriorityQueue.js';
import { clampToSpan, intersectSpans, midpoint, spanContains } from '../../rangeUtils.js';
import type { Axis, AxisSpan } from '../../types.js';
import type {
  Corridor,
  CorridorBorderSpan,
  PortalRef,
  RouteEndpoint,
  RouteSearchRequest,
  TerminalAttachment,
} from './contract.js';
import {
  corridorCrossSpan,
  corridorTravelSpan,
  faceCrossSpan,
  faceNormalAxis,
  manhattanCoords,
  terminalFacePlane,
} from './geometry.js';
import { ordinaryBendCost } from './qualityCost.js';
import { Route, type CorridorVisit, type VisitBoundary } from './route.js';
import {
  PORTAL_SEARCH_TIER_ESCAPE,
  PORTAL_SEARCH_TIER_PREFERRED,
  prefersSingletonContainerCenter,
  terminalFaceRouteCount,
  type CorridorWorld,
  type PortalSearchTier,
} from './world.js';

const EPSILON = 1e-6;

const NARROW_SECTION_TARGET_PX = 24;
const NARROW_SECTION_WEIGHT = 1;
/** Wall-adjacent travel is comfortable once the centered track clears the wall by this much. */
const NARROW_WALL_CLEARANCE_TARGET_PX = 16;
const INTERMEDIATE_TURN_NARROWING_WEIGHT = 4;
const INTERMEDIATE_TURN_MIN_ONWARD_TRAVEL_PX = 8;
const TERMINAL_TRANSITION_MIN_CAPACITY_PX = 8;
// Larger faces may intentionally expose multiple independent terminal zones.
const TERMINAL_TRANSITION_MAX_FACE_PX = 50;
const TERMINAL_ALIGNMENT_REFERENCE_FACE_PX = 200;
const TERMINAL_ALIGNMENT_WEIGHT = 0.9;
const SINGLETON_TERMINAL_ALIGNMENT_WEIGHT = 1.5;
const TERMINAL_ALIGNMENT_EDGE_WEIGHT = 2;
/** Small topology preference for a terminal slice that contains the face center. */
const TERMINAL_ATTACHMENT_ALIGNMENT_WEIGHT = 0.001;
const TERMINAL_TURN_CORNER_CLEARANCE_PX = 5;
const STRAIGHT_TERMINAL_FREE_MISALIGNMENT_PX = 32;
const STRAIGHT_TERMINAL_MISALIGNMENT_WEIGHT = 5;
const STRAIGHT_TERMINAL_FULL_WEIGHT_GAP_PX = 40;
const STRAIGHT_TERMINAL_ZERO_WEIGHT_GAP_PX = 80;
const WIDE_COLUMN_ALIGNMENT_MIN_FACE_PX = 160;
const MAX_ROUTE_EXPANSIONS = 50_000;

type RouteFallbackReason =
  'no-source-attachment' | 'no-target-attachment' | 'unreachable' | 'search-budget';

interface RouteTopologyCost {
  readonly distance: number;
  readonly bendCount: number;
  readonly narrow: number;
  readonly terminal: number;
  /** Additive prices charged when entering selected corridors. */
  readonly corridorPenalty?: number;
  /** Estimated realization cost of retracking at same-axis continuation portals. */
  readonly portalPenalty?: number;
  readonly total: number;
}

interface RouteSearchMetrics {
  readonly expansions: number;
  readonly maxQueue: number;
  /** Maximum simultaneous nondominated labels retained for one corridor. */
  readonly maxLabelsPerCorridor: number;
  readonly passCount: number;
}

type RouteSearchPass = 'preferred' | 'escape';

export interface RouteSearchResult {
  readonly route: Route;
  readonly fallback: boolean;
  readonly fallbackReason?: RouteFallbackReason;
  readonly cost?: RouteTopologyCost;
  /** The graph tier used by the selected route, or the last attempted tier for a fallback. */
  readonly searchPass: RouteSearchPass;
  readonly metrics: RouteSearchMetrics;
}

interface RouteSearchOptions {
  /** Portals omitted from this search only; the shared corridor world remains unchanged. */
  readonly hiddenPortalIndexes?: ReadonlySet<number>;
  /** Terminal attachments omitted from this search only. */
  readonly hiddenAttachmentIndexes?: ReadonlySet<number>;
  /** Require the selected topology to visit this corridor at least once. */
  readonly requiredCorridorIndex?: number;
  /** Additive prices charged whenever this search enters a corridor. */
  readonly corridorEntryPenalties?: ReadonlyMap<number, number>;
  /** Skip the small preference for centered terminal attachments. */
  readonly preferCenteredTerminalAttachments?: boolean;
}

interface ResolvedEndpoint {
  readonly endpoint: RouteEndpoint;
  readonly axis: Axis;
  readonly plane: number;
  readonly crossSpan: AxisSpan;
  readonly attachments: readonly TerminalAttachment[];
}

interface SearchLabel {
  readonly corridorIndex: number;
  readonly feasibleTrack: AxisSpan;
  readonly representativeX: number;
  readonly representativeY: number;
  readonly distance: number;
  readonly bendCount: number;
  readonly predictedBendCount: number;
  readonly sourceTerminal: number;
  readonly corridorPenalty: number;
  readonly portalPenalty: number;
  readonly cost: number;
  readonly estimatedTotal: number;
  readonly cameFrom: number;
  readonly entry: VisitBoundary;
  readonly requiredCorridorVisited: boolean;
  dead: boolean;
}

/** An endpoint paired with its precomputed singleton-container-centering preference. */
interface EndpointAlignment {
  readonly endpoint: ResolvedEndpoint;
  readonly centering: boolean;
}

type DominanceFields = Pick<
  SearchLabel,
  | 'feasibleTrack'
  | 'representativeX'
  | 'representativeY'
  | 'bendCount'
  | 'predictedBendCount'
  | 'cost'
>;

/**
 * The dominator's feasible span covers the contender's and its cost, translated to the
 * contender's representative point, is no worse. An unbent label can still refund its
 * source-terminal cost, so it is not cost-comparable with an otherwise equivalent label
 * that has already bent.
 */
function dominates(
  dominator: DominanceFields,
  contender: DominanceFields,
  corridor: CorridorWorld['indexer']['corridors'][number],
): boolean {
  return (
    (dominator.bendCount + dominator.predictedBendCount === 0) ===
      (contender.bendCount + contender.predictedBendCount === 0) &&
    spanContains(dominator.feasibleTrack, contender.feasibleTrack, EPSILON) &&
    dominator.cost +
      sectionTravelCost(
        corridor,
        dominator.representativeX,
        dominator.representativeY,
        contender.representativeX,
        contender.representativeY,
      ) <=
      contender.cost + EPSILON
  );
}

/** The label's representative coordinate on the corridor's cross axis. */
function crossOf(axis: Axis, label: SearchLabel): number {
  return axis === 'x' ? label.representativeY : label.representativeX;
}

/** The label's representative coordinate on the corridor's travel axis. */
function travelOf(axis: Axis, label: SearchLabel): number {
  return axis === 'x' ? label.representativeX : label.representativeY;
}

/** Append the candidate unless an epsilon-equal value is already present. */
function pushDistinct(values: number[], candidate: number): void {
  if (!values.some((value) => Math.abs(value - candidate) <= EPSILON)) {
    values.push(candidate);
  }
}

interface GoalHit extends RouteTopologyCost {
  readonly labelId: number;
  readonly attachment: TerminalAttachment;
}

interface SearchRun {
  readonly labels: readonly SearchLabel[];
  readonly hit?: GoalHit;
  readonly expansions: number;
  readonly maxQueue: number;
  readonly maxLabelsPerCorridor: number;
  readonly exhaustedBudget: boolean;
}

/** Corridors that host either of this request's terminal attachments. */
export function requestEndpointCorridorIndexes(
  world: CorridorWorld,
  request: RouteSearchRequest,
  hiddenAttachmentIndexes?: ReadonlySet<number>,
): ReadonlySet<number> {
  const result = new Set<number>();
  for (const endpoint of [request.from, request.to]) {
    for (const attachmentIndex of world.indexer.attachmentsForEndpoint(endpoint)) {
      if (hiddenAttachmentIndexes?.has(attachmentIndex)) {
        continue;
      }
      result.add(world.indexer.attachments[attachmentIndex].corridorIndex);
    }
  }
  return result;
}

/**
 * Estimated realization bends when this request retracks across a continuation portal.
 *
 * Leaving this request's own terminal corridor for a partially-overlapping (non-nested)
 * same-axis partner implies a realization jog, priced as its likely two-bend retrack.
 * A straight shot between the request's two terminal corridors, and any continuation
 * between corridors hosting neither terminal, realizes straight and stays free.
 */
export function continuationBendPenalty(
  world: CorridorWorld,
  endpointCorridorIndexes: ReadonlySet<number>,
  portal: Extract<PortalRef, { kind: 'continue' }>,
): number {
  if (
    endpointCorridorIndexes.has(portal.negativeCorridorIndex) ===
    endpointCorridorIndexes.has(portal.positiveCorridorIndex)
  ) {
    return 0;
  }
  const negativeSpan = corridorCrossSpan(world.indexer.corridors[portal.negativeCorridorIndex]);
  const positiveSpan = corridorCrossSpan(world.indexer.corridors[portal.positiveCorridorIndex]);
  if (
    spanContains(negativeSpan, positiveSpan, EPSILON) ||
    spanContains(positiveSpan, negativeSpan, EPSILON)
  ) {
    return 0;
  }
  return 2;
}

/** Search one fixed-face request over every legal turn portal in the complete world. */
export function searchRoute(
  world: CorridorWorld,
  request: RouteSearchRequest,
  options: RouteSearchOptions = {},
): RouteSearchResult {
  const source = resolveEndpoint(world, request.from, options.hiddenAttachmentIndexes);
  const target = resolveEndpoint(world, request.to, options.hiddenAttachmentIndexes);
  const endpointCorridorIndexes = requestEndpointCorridorIndexes(
    world,
    request,
    options.hiddenAttachmentIndexes,
  );
  const runs: SearchRun[] = [];

  if (source.attachments.length === 0 || target.attachments.length === 0) {
    return fallbackResult(
      request,
      source.attachments.length === 0 ? 'no-source-attachment' : 'no-target-attachment',
      'preferred',
      runs,
    );
  }

  let searchPass: RouteSearchPass = 'preferred';
  let run = runSearch(
    world,
    source,
    target,
    endpointCorridorIndexes,
    PORTAL_SEARCH_TIER_PREFERRED,
    options.hiddenPortalIndexes,
    options.requiredCorridorIndex,
    options.corridorEntryPenalties,
    options.preferCenteredTerminalAttachments !== false,
  );
  runs.push(run);
  if (
    !run.hit &&
    !run.exhaustedBudget &&
    hasVisibleEscapePortals(world, options.hiddenPortalIndexes)
  ) {
    searchPass = 'escape';
    run = runSearch(
      world,
      source,
      target,
      endpointCorridorIndexes,
      PORTAL_SEARCH_TIER_ESCAPE,
      options.hiddenPortalIndexes,
      options.requiredCorridorIndex,
      options.corridorEntryPenalties,
      options.preferCenteredTerminalAttachments !== false,
    );
    runs.push(run);
  }
  if (!run.hit) {
    return fallbackResult(
      request,
      run.exhaustedBudget ? 'search-budget' : 'unreachable',
      searchPass,
      runs,
    );
  }

  const corridorPenalty = run.hit.corridorPenalty ?? 0;
  const portalPenalty = run.hit.portalPenalty ?? 0;
  const cost: RouteTopologyCost = {
    distance: run.hit.distance,
    bendCount: run.hit.bendCount,
    narrow: run.hit.narrow,
    terminal: run.hit.terminal,
    ...(corridorPenalty > EPSILON ? { corridorPenalty } : {}),
    ...(portalPenalty > EPSILON ? { portalPenalty } : {}),
    total: run.hit.total,
  };
  return {
    route: new Route(
      request.requestIndex,
      request.from,
      request.to,
      buildVisits(world, run.labels, run.hit, source, target),
    ),
    fallback: false,
    cost,
    searchPass,
    metrics: metrics(runs),
  };
}

/** Preserve manager/request order; topology does not use earlier routes as input. */
export function searchRoutes(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  options: RouteSearchOptions = {},
): RouteSearchResult[] {
  return requests.map((request) => searchRoute(world, request, options));
}

function runSearch(
  world: CorridorWorld,
  source: ResolvedEndpoint,
  target: ResolvedEndpoint,
  endpointCorridorIndexes: ReadonlySet<number>,
  maximumPortalTier: PortalSearchTier,
  hiddenPortalIndexes: ReadonlySet<number> | undefined,
  requiredCorridorIndex: number | undefined,
  corridorEntryPenalties: ReadonlyMap<number, number> | undefined,
  preferCenteredTerminalAttachments: boolean,
): SearchRun {
  const { indexer } = world;
  const hasEndpointMarkerMetadata =
    source.endpoint.hasArrowhead !== undefined || target.endpoint.hasArrowhead !== undefined;
  // A wide vertical leaf face can justify changing topology to improve its
  // attachment. Other faces retain the distance-sensitive alignment policy
  // and leave centering to spacing on the selected route.
  const sharedTerminalAlignmentWeight = shortTerminalGapWeight(source, target);
  const wideColumnTerminalAlignmentWeight = (endpoint: ResolvedEndpoint): number => {
    const entity = world.entities[endpoint.endpoint.entityIndex];
    const faceSpan = faceCrossSpan(entity, endpoint.endpoint.face);
    return entity.isContainer !== true &&
      (endpoint.endpoint.face === 'left' || endpoint.endpoint.face === 'right') &&
      faceSpan[1] - faceSpan[0] >= WIDE_COLUMN_ALIGNMENT_MIN_FACE_PX - EPSILON
      ? 1
      : 0;
  };
  const terminalAlignmentWeight = (endpoint: ResolvedEndpoint): number =>
    !hasEndpointMarkerMetadata || world.entities[endpoint.endpoint.entityIndex].isContainer === true
      ? sharedTerminalAlignmentWeight
      : Math.max(sharedTerminalAlignmentWeight, wideColumnTerminalAlignmentWeight(endpoint));
  const forceDirectContainerCentering = alignedTerminalCenters(world, source, target);
  const sourceAlignment: EndpointAlignment = {
    endpoint: source,
    centering: prefersSingletonContainerCenter(world, source.endpoint, target.endpoint),
  };
  const targetAlignment: EndpointAlignment = {
    endpoint: target,
    centering: prefersSingletonContainerCenter(world, target.endpoint, source.endpoint),
  };
  const terminalCost = ({ endpoint, centering }: EndpointAlignment, track: number): number =>
    terminalAlignmentWeight(endpoint) * terminalAlignmentCost(endpoint, track, centering);
  const directTerminalCost = ({ endpoint, centering }: EndpointAlignment, track: number): number =>
    (forceDirectContainerCentering ? 1 : terminalAlignmentWeight(endpoint)) *
    terminalAlignmentCost(endpoint, track, centering);
  const terminalAttachmentCost = (
    { endpoint, centering }: EndpointAlignment,
    attachment: TerminalAttachment,
  ): number => {
    if (!preferCenteredTerminalAttachments) {
      return 0;
    }
    const center = preferredEndpointTrack(endpoint);
    if (center >= attachment.faceSpan[0] - EPSILON && center <= attachment.faceSpan[1] + EPSILON) {
      return 0;
    }
    return (
      TERMINAL_ATTACHMENT_ALIGNMENT_WEIGHT *
      terminalAlignmentCost(endpoint, clampToSpan(center, attachment.faceSpan), centering)
    );
  };
  const labels: SearchLabel[] = [];
  const liveByState: (number[] | undefined)[] = new Array(indexer.corridors.length * 2);
  const targetsByCorridor: (TerminalAttachment[] | undefined)[] = new Array(
    indexer.corridors.length,
  );
  const queue = new PriorityQueue<number>((left, right) => left - right);

  for (const attachment of target.attachments) {
    const targets = targetsByCorridor[attachment.corridorIndex] ?? [];
    targets.push(attachment);
    targetsByCorridor[attachment.corridorIndex] = targets;
  }

  let expansions = 0;
  let maxQueue = 0;
  let maxLabelsPerCorridor = 0;
  let hit: GoalHit | undefined;
  let exhaustedBudget = false;

  const addLabel = (
    corridorIndex: number,
    feasibleTrack: AxisSpan,
    representativeX: number,
    representativeY: number,
    distance: number,
    bendCount: number,
    predictedBendCount: number,
    sourceTerminal: number,
    corridorPenalty: number,
    portalPenalty: number,
    cost: number,
    cameFrom: number,
    entry: VisitBoundary,
    requiredCorridorVisited: boolean,
  ): void => {
    const stateIndex = corridorIndex * 2 + Number(requiredCorridorVisited);
    const live = liveByState[stateIndex] ?? [];
    const corridor = indexer.corridors[corridorIndex];
    const candidate: DominanceFields = {
      feasibleTrack,
      representativeX,
      representativeY,
      bendCount,
      predictedBendCount,
      cost,
    };
    for (const otherId of live) {
      const other = labels[otherId];
      if (!other.dead && dominates(other, candidate, corridor)) {
        return;
      }
    }

    const id = labels.length;
    const label: SearchLabel = {
      corridorIndex,
      feasibleTrack,
      representativeX,
      representativeY,
      distance,
      bendCount,
      predictedBendCount,
      sourceTerminal,
      corridorPenalty,
      portalPenalty,
      cost,
      estimatedTotal: cost + distanceToEndpoint(representativeX, representativeY, target),
      cameFrom,
      entry,
      requiredCorridorVisited,
      dead: false,
    };
    labels.push(label);

    let survivorCount = 0;
    for (const otherId of live) {
      const other = labels[otherId];
      if (other.dead) {
        continue;
      }
      if (dominates(candidate, other, corridor)) {
        other.dead = true;
      } else {
        live[survivorCount] = otherId;
        survivorCount += 1;
      }
    }
    live.length = survivorCount;
    live.push(id);
    liveByState[stateIndex] = live;
    maxLabelsPerCorridor = Math.max(maxLabelsPerCorridor, live.length);
    queue.push(id, label.estimatedTotal);
    maxQueue = Math.max(maxQueue, queue.length);
  };

  for (const attachment of source.attachments) {
    const representativeTrack = clampToSpan(
      source.endpoint.authoredTrack ?? preferredEndpointTrack(source),
      attachment.faceSpan,
    );
    const feasibleTrack: AxisSpan =
      source.endpoint.authoredTrack === undefined
        ? attachment.faceSpan
        : [representativeTrack, representativeTrack];
    const sourceTerminal = terminalAttachmentCost(sourceAlignment, attachment);
    const corridorPenalty = corridorEntryPenalty(
      world,
      corridorEntryPenalties,
      attachment.corridorIndex,
    );
    addLabel(
      attachment.corridorIndex,
      feasibleTrack,
      source.axis === 'x' ? source.plane : representativeTrack,
      source.axis === 'x' ? representativeTrack : source.plane,
      0,
      0,
      0,
      sourceTerminal,
      corridorPenalty,
      0,
      sourceTerminal + corridorPenalty,
      -1,
      { kind: 'terminal', attachmentIndex: attachment.index },
      requiredCorridorIndex === undefined || attachment.corridorIndex === requiredCorridorIndex,
    );
  }

  while (!queue.isEmpty()) {
    const labelId = queue.pop();
    if (labelId === undefined) {
      break;
    }
    const label = labels[labelId];
    if (label.dead) {
      continue;
    }
    if (hit && label.estimatedTotal >= hit.total - EPSILON) {
      break;
    }
    if (expansions >= MAX_ROUTE_EXPANSIONS) {
      exhaustedBudget = true;
      break;
    }
    expansions += 1;

    const corridor = indexer.corridors[label.corridorIndex];
    const targetAttachments = targetsByCorridor[label.corridorIndex];
    if (targetAttachments && label.requiredCorridorVisited) {
      for (const attachment of targetAttachments) {
        const feasibleTrack = intersectSpans(
          label.feasibleTrack,
          endpointTrack(target, attachment),
          EPSILON,
        );
        if (
          !feasibleTrack ||
          (label.bendCount > 0 &&
            target.endpoint.authoredTrack === undefined &&
            (feasibleTrack[1] - feasibleTrack[0] <= EPSILON ||
              terminalTurnOverlapOnlyNearCorner(target, feasibleTrack)))
        ) {
          continue;
        }
        const finishCandidates = [clampToSpan(crossOf(corridor.axis, label), feasibleTrack)];
        const preferredFinish = clampToSpan(
          target.endpoint.authoredTrack ?? preferredEndpointTrack(target),
          feasibleTrack,
        );
        pushDistinct(finishCandidates, preferredFinish);
        for (const finishCross of finishCandidates) {
          const finishX = corridor.axis === 'x' ? target.plane : finishCross;
          const finishY = corridor.axis === 'x' ? finishCross : target.plane;
          const incrementalDistance = manhattanCoords(
            label.representativeX,
            label.representativeY,
            finishX,
            finishY,
          );
          const distance = label.distance + incrementalDistance;
          const sourceTerminal =
            label.bendCount === 0
              ? label.sourceTerminal + directTerminalCost(sourceAlignment, finishCross)
              : label.sourceTerminal;
          const targetTerminal =
            terminalAttachmentCost(targetAlignment, attachment) +
            (label.bendCount === 0
              ? directTerminalCost(targetAlignment, finishCross)
              : terminalCost(targetAlignment, finishCross));
          const straightTerminal =
            label.bendCount === 0 ? straightTerminalAlignmentCost(source, target) : 0;
          const terminal = sourceTerminal + targetTerminal + straightTerminal;
          const corridorPenalty = label.corridorPenalty;
          const portalPenalty = label.portalPenalty;
          const total =
            label.cost -
            label.sourceTerminal +
            sourceTerminal +
            sectionTravelCost(
              corridor,
              label.representativeX,
              label.representativeY,
              finishX,
              finishY,
            ) +
            targetTerminal +
            straightTerminal;
          if (!hit || total < hit.total - EPSILON) {
            hit = {
              labelId,
              attachment,
              distance,
              bendCount: label.bendCount,
              narrow: Math.max(
                0,
                total -
                  distance -
                  ordinaryBendCost(label.bendCount) -
                  terminal -
                  corridorPenalty -
                  portalPenalty,
              ),
              terminal,
              corridorPenalty,
              portalPenalty,
              total,
            };
          }
        }
      }
    }

    for (const portal of indexer.portalsFrom(label.corridorIndex)) {
      if (
        hiddenPortalIndexes?.has(portal.index) ||
        (world.portalSearchTiers?.[portal.index] ?? PORTAL_SEARCH_TIER_PREFERRED) >
          maximumPortalTier
      ) {
        continue;
      }
      if (portal.kind === 'continue') {
        if (reversesAtContinuationPlane(world, label.entry, portal)) {
          continue;
        }
        const reachableTrack = intersectSpans(label.feasibleTrack, portal.crossSpan, EPSILON);
        if (!reachableTrack) {
          continue;
        }
        const continueTrack = clampToSpan(crossOf(corridor.axis, label), reachableTrack);
        const plane = portal.planeCoordinate;
        if (!continuesOutwardFromSource(source, label, corridor, plane)) {
          continue;
        }
        const continueX = corridor.axis === 'x' ? plane : continueTrack;
        const continueY = corridor.axis === 'x' ? continueTrack : plane;
        const otherCorridorIndex = indexer.otherCorridorIndex(portal, label.corridorIndex);
        const corridorPenalty = corridorEntryPenalty(
          world,
          corridorEntryPenalties,
          otherCorridorIndex,
        );
        const addedPredictedBends = continuationBendPenalty(world, endpointCorridorIndexes, portal);
        const currentTotalBends = label.bendCount + label.predictedBendCount;
        const nextPredictedBendCount = label.predictedBendCount + addedPredictedBends;
        const bendIncrement =
          ordinaryBendCost(currentTotalBends + addedPredictedBends) -
          ordinaryBendCost(currentTotalBends);
        const portalPenalty =
          ordinaryBendCost(label.bendCount + nextPredictedBendCount) -
          ordinaryBendCost(label.bendCount);
        const incrementalDistance = manhattanCoords(
          label.representativeX,
          label.representativeY,
          continueX,
          continueY,
        );
        addLabel(
          otherCorridorIndex,
          reachableTrack,
          continueX,
          continueY,
          label.distance + incrementalDistance,
          label.bendCount,
          nextPredictedBendCount,
          label.sourceTerminal,
          label.corridorPenalty + corridorPenalty,
          portalPenalty,
          label.cost +
            sectionTravelCost(
              corridor,
              label.representativeX,
              label.representativeY,
              continueX,
              continueY,
            ) +
            terminalTransitionTrackNarrowingCost(source, label, reachableTrack) +
            bendIncrement +
            corridorPenalty,
          labelId,
          { kind: 'portal', portalIndex: portal.index, mode: 'continue-straight' },
          label.requiredCorridorVisited || otherCorridorIndex === requiredCorridorIndex,
        );
        continue;
      }
      const reachableTrack = intersectSpans(
        label.feasibleTrack,
        portalCrossSpan(portal, corridor.axis),
        EPSILON,
      );
      if (
        !reachableTrack ||
        (reachableTrack[1] - reachableTrack[0] <= EPSILON &&
          (label.bendCount > 0 || source.endpoint.authoredTrack === undefined)) ||
        (label.bendCount === 0 &&
          source.endpoint.authoredTrack === undefined &&
          terminalTurnOverlapOnlyNearCorner(source, reachableTrack))
      ) {
        continue;
      }

      const portalTravel = portalTravelSpan(portal, corridor.axis);
      const turnCross = clampToSpan(crossOf(corridor.axis, label), reachableTrack);
      const otherCorridorIndex = indexer.otherCorridorIndex(portal, label.corridorIndex);
      const otherCorridor = indexer.corridors[otherCorridorIndex];
      const corridorPenalty = corridorEntryPenalty(
        world,
        corridorEntryPenalties,
        otherCorridorIndex,
      );
      const turnTravels = [clampToSpan(travelOf(corridor.axis, label), portalTravel)];
      for (const attachment of targetsByCorridor[otherCorridorIndex] ?? []) {
        const targetSpan = intersectSpans(portalTravel, endpointTrack(target, attachment), EPSILON);
        if (!targetSpan) {
          continue;
        }
        const targetTrack = clampToSpan(
          target.endpoint.authoredTrack ?? preferredEndpointTrack(target),
          targetSpan,
        );
        pushDistinct(turnTravels, targetTrack);
      }
      for (const turnTravel of turnTravels) {
        const turnX = corridor.axis === 'x' ? turnTravel : turnCross;
        const turnY = corridor.axis === 'x' ? turnCross : turnTravel;
        const incrementalDistance = manhattanCoords(
          label.representativeX,
          label.representativeY,
          turnX,
          turnY,
        );
        const sourceTerminal =
          label.bendCount === 0
            ? label.sourceTerminal + terminalCost(sourceAlignment, turnCross)
            : label.sourceTerminal;
        const currentTotalBends = label.bendCount + label.predictedBendCount;
        const nextBendCount = label.bendCount + 1;
        const bendIncrement =
          ordinaryBendCost(currentTotalBends + 1) - ordinaryBendCost(currentTotalBends);
        const portalPenalty =
          ordinaryBendCost(nextBendCount + label.predictedBendCount) -
          ordinaryBendCost(nextBendCount);
        addLabel(
          otherCorridorIndex,
          portalTravel,
          turnX,
          turnY,
          label.distance + incrementalDistance,
          nextBendCount,
          label.predictedBendCount,
          sourceTerminal,
          label.corridorPenalty + corridorPenalty,
          portalPenalty,
          label.cost +
            sourceTerminal -
            label.sourceTerminal +
            sectionTravelCost(
              corridor,
              label.representativeX,
              label.representativeY,
              turnX,
              turnY,
            ) +
            terminalTransitionTrackNarrowingCost(source, label, reachableTrack) +
            intermediateTurnTrackNarrowingCost(label, reachableTrack, otherCorridor, portal) +
            bendIncrement +
            corridorPenalty,
          labelId,
          { kind: 'portal', portalIndex: portal.index, mode: 'turn' },
          label.requiredCorridorVisited || otherCorridorIndex === requiredCorridorIndex,
        );
      }
    }
  }

  return {
    labels,
    hit,
    expansions,
    maxQueue,
    maxLabelsPerCorridor,
    exhaustedBudget,
  };
}

function continuesOutwardFromSource(
  source: ResolvedEndpoint,
  label: SearchLabel,
  corridor: Corridor,
  plane: number,
): boolean {
  if (label.bendCount > 0 || corridor.axis !== source.axis) {
    return true;
  }
  const currentTravel = corridor.axis === 'x' ? label.representativeX : label.representativeY;
  const outwardSign = source.endpoint.face === 'left' || source.endpoint.face === 'up' ? -1 : 1;
  return (plane - currentTravel) * outwardSign > EPSILON;
}

function reversesAtContinuationPlane(
  world: CorridorWorld,
  entry: VisitBoundary,
  exit: Extract<PortalRef, { kind: 'continue' }>,
): boolean {
  if (entry.kind !== 'portal' || entry.mode !== 'continue-straight') {
    return false;
  }
  const entryPortal = world.indexer.portals[entry.portalIndex];
  return entryPortal.kind === 'continue' && entryPortal.planeCoordinate === exit.planeCoordinate;
}

function buildVisits(
  world: CorridorWorld,
  labels: readonly SearchLabel[],
  hit: GoalHit,
  source: ResolvedEndpoint,
  target: ResolvedEndpoint,
): CorridorVisit[] {
  const chain: SearchLabel[] = [];
  for (let labelId = hit.labelId; labelId !== -1; labelId = labels[labelId].cameFrom) {
    chain.push(labels[labelId]);
  }
  chain.reverse();

  return chain.map((label, chainIndex) => {
    const next = chain[chainIndex + 1];
    if (!next) {
      const exit: VisitBoundary = {
        kind: 'terminal',
        attachmentIndex: hit.attachment.index,
      };
      return {
        corridorIndex: label.corridorIndex,
        entry: label.entry,
        exit,
        feasibleTrack: localVisitTrack(
          world,
          world.indexer.corridors[label.corridorIndex],
          label.entry,
          exit,
          chainIndex === 0 ? source : undefined,
          target,
        ),
      };
    }
    if (next.entry.kind !== 'portal') {
      throw new Error('route search: label has a non-portal predecessor');
    }
    if (next.entry.mode !== 'turn' && next.entry.mode !== 'continue-straight') {
      throw new Error('route search: label has an unsupported predecessor mode');
    }
    const corridor = world.indexer.corridors[label.corridorIndex];
    const feasibleTrack = localVisitTrack(
      world,
      corridor,
      label.entry,
      next.entry,
      chainIndex === 0 ? source : undefined,
      undefined,
    );
    return {
      corridorIndex: label.corridorIndex,
      entry: label.entry,
      exit: next.entry,
      feasibleTrack,
    };
  });
}

function localVisitTrack(
  world: CorridorWorld,
  corridor: Corridor,
  entry: VisitBoundary,
  exit: VisitBoundary,
  source?: ResolvedEndpoint,
  target?: ResolvedEndpoint,
): AxisSpan {
  let feasibleTrack = corridorCrossSpan(corridor);
  for (const boundary of [entry, exit]) {
    if (boundary.kind !== 'portal') {
      continue;
    }
    const portal = world.indexer.portals[boundary.portalIndex];
    if (portal.kind === 'turn') {
      feasibleTrack = requireIntersection(
        feasibleTrack,
        portalCrossSpan(portal, corridor.axis),
        `turn portal ${portal.index}`,
      );
    }
  }
  if (source) {
    const attachment = terminalAttachment(world, entry, 'source');
    feasibleTrack = requireIntersection(
      feasibleTrack,
      endpointTrack(source, attachment),
      'source terminal',
    );
  }
  if (target) {
    const attachment = terminalAttachment(world, exit, 'target');
    feasibleTrack = requireIntersection(
      feasibleTrack,
      endpointTrack(target, attachment),
      'target terminal',
    );
  }
  return feasibleTrack;
}

function terminalAttachment(
  world: CorridorWorld,
  boundary: VisitBoundary,
  side: 'source' | 'target',
): TerminalAttachment {
  if (boundary.kind !== 'terminal') {
    throw new Error(`route search: ${side} visit has no terminal boundary`);
  }
  return world.indexer.attachments[boundary.attachmentIndex];
}

function requireIntersection(left: AxisSpan, right: AxisSpan, context: string): AxisSpan {
  const result = intersectSpans(left, right, EPSILON);
  if (!result) {
    throw new Error(`route search: local visit lost ${context}`);
  }
  return result;
}

function resolveEndpoint(
  world: CorridorWorld,
  endpoint: RouteEndpoint,
  hiddenAttachmentIndexes?: ReadonlySet<number>,
): ResolvedEndpoint {
  const entity = world.entities[endpoint.entityIndex];
  const axis = faceNormalAxis(endpoint.face);
  return {
    endpoint,
    axis,
    plane: terminalFacePlane(entity, endpoint.face),
    crossSpan: faceCrossSpan(entity, endpoint.face),
    attachments: world.indexer
      .attachmentsForEndpoint(endpoint)
      .filter((attachmentIndex) => !hiddenAttachmentIndexes?.has(attachmentIndex))
      .map((attachmentIndex) => world.indexer.attachments[attachmentIndex]),
  };
}

function endpointTrack(endpoint: ResolvedEndpoint, attachment: TerminalAttachment): AxisSpan {
  if (endpoint.endpoint.authoredTrack === undefined) {
    return attachment.faceSpan;
  }
  const track = clampToSpan(endpoint.endpoint.authoredTrack, attachment.faceSpan);
  return [track, track];
}

function terminalTurnOverlapOnlyNearCorner(endpoint: ResolvedEndpoint, overlap: AxisSpan): boolean {
  const overlapMidpoint = midpoint(overlap);
  return (
    overlapMidpoint <= endpoint.crossSpan[0] + TERMINAL_TURN_CORNER_CLEARANCE_PX + EPSILON ||
    overlapMidpoint >= endpoint.crossSpan[1] - TERMINAL_TURN_CORNER_CLEARANCE_PX - EPSILON
  );
}

function distanceToEndpoint(x: number, y: number, endpoint: ResolvedEndpoint): number {
  let best = Number.POSITIVE_INFINITY;
  for (const attachment of endpoint.attachments) {
    const targetSpan = endpointTrack(endpoint, attachment);
    const distance =
      endpoint.axis === 'x'
        ? Math.abs(x - endpoint.plane) + distanceToSpan(y, targetSpan)
        : Math.abs(y - endpoint.plane) + distanceToSpan(x, targetSpan);
    best = Math.min(best, distance);
  }
  return best;
}

/** Prefer face center smoothly; small faces make the same absolute miss more expensive. */
function terminalAlignmentCost(
  endpoint: ResolvedEndpoint,
  track: number,
  singletonCenteringAllowed: boolean,
): number {
  if (endpoint.endpoint.authoredTrack !== undefined) {
    return 0;
  }
  const faceLength = endpoint.crossSpan[1] - endpoint.crossSpan[0];
  if (faceLength <= EPSILON) {
    return 0;
  }
  const deviation = Math.abs(track - preferredEndpointTrack(endpoint));
  const normalized = Math.min(1, deviation / (faceLength / 2));
  const faceScale = singletonCenteringAllowed
    ? 1
    : Math.min(1, TERMINAL_ALIGNMENT_REFERENCE_FACE_PX / faceLength);
  const centerWeight = singletonCenteringAllowed
    ? SINGLETON_TERMINAL_ALIGNMENT_WEIGHT
    : TERMINAL_ALIGNMENT_WEIGHT;
  return (
    deviation *
    faceScale *
    (centerWeight + TERMINAL_ALIGNMENT_EDGE_WEIGHT * normalized * normalized)
  );
}

function straightTerminalAlignmentCost(source: ResolvedEndpoint, target: ResolvedEndpoint): number {
  if (
    source.axis !== target.axis ||
    source.endpoint.authoredTrack !== undefined ||
    target.endpoint.authoredTrack !== undefined
  ) {
    return 0;
  }
  const misalignment = Math.abs(preferredEndpointTrack(source) - preferredEndpointTrack(target));
  return (
    Math.max(0, misalignment - STRAIGHT_TERMINAL_FREE_MISALIGNMENT_PX) *
    STRAIGHT_TERMINAL_MISALIGNMENT_WEIGHT *
    shortTerminalGapWeight(source, target)
  );
}

function alignedTerminalCenters(
  world: CorridorWorld,
  source: ResolvedEndpoint,
  target: ResolvedEndpoint,
): boolean {
  return (
    source.axis === target.axis &&
    world.entities[source.endpoint.entityIndex].isContainer === true &&
    world.entities[target.endpoint.entityIndex].isContainer === true &&
    (terminalFaceRouteCount(world, source.endpoint) > 1 ||
      terminalFaceRouteCount(world, target.endpoint) > 1) &&
    Math.abs(preferredEndpointTrack(source) - preferredEndpointTrack(target)) <= EPSILON
  );
}

function preferredEndpointTrack(endpoint: ResolvedEndpoint): number {
  return endpoint.endpoint.preferredTrack ?? midpoint(endpoint.crossSpan);
}

function shortTerminalGapWeight(source: ResolvedEndpoint, target: ResolvedEndpoint): number {
  if (source.axis !== target.axis) {
    return 0;
  }
  const normalGap = Math.abs(source.plane - target.plane);
  return clampToSpan(
    (STRAIGHT_TERMINAL_ZERO_WEIGHT_GAP_PX - normalGap) /
      (STRAIGHT_TERMINAL_ZERO_WEIGHT_GAP_PX - STRAIGHT_TERMINAL_FULL_WEIGHT_GAP_PX),
    [0, 1],
  );
}

function portalCrossSpan(portal: Extract<PortalRef, { kind: 'turn' }>, axis: Axis): AxisSpan {
  return axis === 'x'
    ? [portal.rect.y, portal.rect.y + portal.rect.height]
    : [portal.rect.x, portal.rect.x + portal.rect.width];
}

function portalTravelSpan(portal: Extract<PortalRef, { kind: 'turn' }>, axis: Axis): AxisSpan {
  return axis === 'x'
    ? [portal.rect.x, portal.rect.x + portal.rect.width]
    : [portal.rect.y, portal.rect.y + portal.rect.height];
}

function distanceToSpan(value: number, span: AxisSpan): number {
  return value < span[0] ? span[0] - value : value > span[1] ? value - span[1] : 0;
}

function wallAdjacentLength(
  borders: readonly CorridorBorderSpan[],
  low: number,
  high: number,
): number {
  let length = 0;
  for (const border of borders) {
    if (border.kind !== 'entity') {
      continue;
    }
    const overlap = Math.min(high, border.span[1]) - Math.max(low, border.span[0]);
    if (overlap > 0) {
      length += overlap;
    }
  }
  return length;
}

/**
 * Travel cost for moving within one corridor. Narrowness is priced only where the
 * traveled span actually runs beside entity walls: a thin corridor floating in open
 * space (a decomposition artifact) costs plain distance, while wall-adjacent travel
 * pays by how far the corridor's centered track stays below the clearance target.
 */
function sectionTravelCost(
  corridor: CorridorWorld['indexer']['corridors'][number],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) {
  const distance = manhattanCoords(fromX, fromY, toX, toY);
  const width = corridor.axis === 'x' ? corridor.rect.height : corridor.rect.width;
  const clearance = width / 2;
  const deficit =
    Math.max(0, NARROW_WALL_CLEARANCE_TARGET_PX - clearance) / NARROW_WALL_CLEARANCE_TARGET_PX;
  if (deficit === 0 || distance === 0) {
    return distance;
  }
  const low = corridor.axis === 'x' ? Math.min(fromX, toX) : Math.min(fromY, toY);
  const high = corridor.axis === 'x' ? Math.max(fromX, toX) : Math.max(fromY, toY);
  const profile = corridor.borderProfile;
  const wallLength =
    profile.axis === 'x'
      ? wallAdjacentLength(profile.top, low, high) + wallAdjacentLength(profile.bottom, low, high)
      : wallAdjacentLength(profile.left, low, high) + wallAdjacentLength(profile.right, low, high);
  return distance + 0.5 * wallLength * deficit * deficit * NARROW_SECTION_WEIGHT;
}

function corridorEntryPenalty(
  world: CorridorWorld,
  penalties: ReadonlyMap<number, number> | undefined,
  corridorIndex: number,
): number {
  const penalty =
    (world.corridorEntryCosts?.[corridorIndex] ?? 0) + (penalties?.get(corridorIndex) ?? 0);
  if (!Number.isFinite(penalty) || penalty < 0) {
    throw new Error(`route search: invalid corridor ${corridorIndex} penalty ${penalty}`);
  }
  return penalty;
}

/** Price a small source face's first portal transition when it narrows the track below target. */
function terminalTransitionTrackNarrowingCost(
  source: ResolvedEndpoint,
  label: SearchLabel,
  reachable: AxisSpan,
): number {
  if (
    source.crossSpan[1] - source.crossSpan[0] > TERMINAL_TRANSITION_MAX_FACE_PX ||
    label.bendCount !== 0 ||
    label.entry.kind !== 'terminal' ||
    reachable[1] - reachable[0] >= TERMINAL_TRANSITION_MIN_CAPACITY_PX
  ) {
    return 0;
  }
  return trackNarrowingCost(label.feasibleTrack, reachable);
}

function intermediateTurnTrackNarrowingCost(
  label: SearchLabel,
  reachable: AxisSpan,
  nextCorridor: Corridor,
  portal: Extract<PortalRef, { kind: 'turn' }>,
): number {
  if (
    label.entry.kind !== 'portal' ||
    label.entry.mode !== 'turn' ||
    reachable[1] - reachable[0] > EPSILON
  ) {
    return 0;
  }
  const nextTravel = corridorTravelSpan(nextCorridor);
  const nextPortalTravel = portalTravelSpan(portal, nextCorridor.axis);
  const onwardTravel = Math.max(
    nextPortalTravel[0] - nextTravel[0],
    nextTravel[1] - nextPortalTravel[1],
  );
  if (onwardTravel < INTERMEDIATE_TURN_MIN_ONWARD_TRAVEL_PX) {
    return 0;
  }
  return INTERMEDIATE_TURN_NARROWING_WEIGHT * trackNarrowingCost(label.feasibleTrack, reachable);
}

/** Price the loss of track choice before spacing has to absorb it. */
function trackNarrowingCost(available: AxisSpan, reachable: AxisSpan): number {
  const availableWidth = Math.min(NARROW_SECTION_TARGET_PX, available[1] - available[0]);
  const reachableWidth = Math.min(availableWidth, reachable[1] - reachable[0]);
  return Math.max(0, availableWidth - reachableWidth);
}

function fallbackResult(
  request: RouteSearchRequest,
  fallbackReason: RouteFallbackReason,
  searchPass: RouteSearchPass,
  runs: readonly SearchRun[],
): RouteSearchResult {
  return {
    route: new Route(request.requestIndex, request.from, request.to, []),
    fallback: true,
    fallbackReason,
    searchPass,
    metrics: metrics(runs),
  };
}

function metrics(runs: readonly SearchRun[]): RouteSearchMetrics {
  return {
    expansions: runs.reduce((total, run) => total + run.expansions, 0),
    maxQueue: Math.max(0, ...runs.map((run) => run.maxQueue)),
    maxLabelsPerCorridor: Math.max(0, ...runs.map((run) => run.maxLabelsPerCorridor)),
    passCount: runs.length,
  };
}

function hasVisibleEscapePortals(
  world: CorridorWorld,
  hiddenPortalIndexes: ReadonlySet<number> | undefined,
): boolean {
  return (
    world.portalSearchTiers?.some(
      (tier, portalIndex) =>
        tier === PORTAL_SEARCH_TIER_ESCAPE && !hiddenPortalIndexes?.has(portalIndex),
    ) ?? false
  );
}
