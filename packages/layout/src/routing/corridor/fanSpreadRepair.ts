import type { Direction } from '../../types.js';
import type { EndpointSide } from '../types.js';
import type { RouteEndpoint, RouteSearchRequest } from './contract.js';
import { collectEndpointQualityEvents } from './endpointQuality.js';
import { assessFaceSlots, type FaceSlotAssessment } from './faceSlots.js';
import { faceCrossSpan } from './geometry.js';
import { leafCutKeys, type LeafRect } from './leafCuts.js';
import {
  compareRoutingQualityCosts,
  routingQualityCost,
  type RoutingQualityCost,
} from './qualityCost.js';
import { realizeRoutes, reuseOptions, type RealizedRouteBatch } from './realize.js';
import { violatesRepairIdentity } from './repairAcceptance.js';
import { cloneRoute, Route } from './route.js';
import type { IndependentContinuationBoundary } from './continuations.js';
import { PORT_EDGE_PADDING_PX } from './spacing.js';
import { searchRoute } from './topology.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;
/** Faces below this slot charge are visually fine; repairing them cannot pay for itself. */
const MIN_FACE_CHARGE = 0.15;
/** Bounds candidate realizations per repair run; the deadline usually binds first. */
const MAX_FACE_CANDIDATES = 12;

interface FanPortSample {
  readonly routeIndex: number;
  readonly side: EndpointSide;
  readonly coordinate: number;
}

interface FanFace {
  readonly entityIndex: number;
  readonly face: Direction;
  readonly span: readonly [number, number];
  /** Ascending by coordinate; targets are assigned in this order. */
  readonly samples: readonly FanPortSample[];
  readonly assessment: FaceSlotAssessment;
}

interface FanSpreadRepairOptions {
  readonly deadlineAtMs: number;
  readonly leaves: readonly LeafRect[];
  readonly entityCount: number;
  readonly protectedRouteIndexes?: ReadonlySet<number>;
  readonly realization: {
    readonly independentContinuations: readonly IndependentContinuationBoundary[];
    readonly incrementalEmission: boolean;
    readonly incrementalLineMerges: boolean;
  };
}

interface FanSpreadRepairResult {
  readonly batch: RealizedRouteBatch;
  readonly topologies: readonly Route[];
  readonly changed: boolean;
  readonly accepted: boolean;
}

/**
 * Full-strength terminal-spacing repair: one face at a time, worst slot charge first, place
 * the face's endpoints exactly at their expected slot centers. Endpoint order is preserved
 * but corridors and continuations are not: a slot outside the terminal visit's feasible
 * window re-searches that route's topology with the slot injected as an authored track, so
 * the search chooses the terminal corridor that reaches the slot and realization rebuilds or
 * breaks continuations as needed. The injected mark is then stripped and the slot carried as
 * a spacing-side repair pin, keeping the port visible to quality measurement. Each face
 * candidate is re-realized whole and kept only when the standard shared gate (slot-mode
 * costs + identity veto) prices the entire diagram better.
 */
export function repairFanSpread(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  initialTopologies: readonly Route[],
  initial: RealizedRouteBatch,
  options: FanSpreadRepairOptions,
): FanSpreadRepairResult {
  let incumbent = initial;
  let incumbentCost = slotModeCost(world, incumbent);
  let topologies = [...initialTopologies];
  let candidatesBuilt = 0;
  let candidatesAccepted = 0;

  const faces = slotChargedFaces(world, incumbent.routes);
  for (const fanFace of faces) {
    // Entering the phase at all grants the worst face one attempt; the deadline then
    // governs every further face so a large diagram cannot run away.
    if (candidatesBuilt > 0 && performance.now() >= options.deadlineAtMs) {
      break;
    }
    if (candidatesBuilt >= MAX_FACE_CANDIDATES) {
      break;
    }
    const anchors = straightCoupledAnchors(world, incumbent.routes, fanFace);
    const targets = anchoredSlotTargets(fanFace, anchors);
    const pins = new Map<string, number>();
    fanFace.samples.forEach((sample, sampleIndex) => {
      pins.set(pinKey(sample.routeIndex, sample.side), targets[sampleIndex]);
    });
    for (const [sampleIndex, anchor] of anchors) {
      const sample = fanFace.samples[sampleIndex];
      const oppositeSide: EndpointSide = sample.side === 'from' ? 'to' : 'from';
      pins.set(pinKey(sample.routeIndex, oppositeSide), anchor);
    }
    const valveEndpoint = newWorstBandPinnedEndpoint(world, incumbent.routes, pins, fanFace);
    if (valveEndpoint !== undefined) {
      continue;
    }

    // Routes whose slot lies outside their current terminal corridor re-search topology.
    const researched = new Map<number, Route>();
    let blockedRouteIndex: number | undefined;
    for (const [key, target] of pins) {
      const { routeIndex, side } = parsePinKey(key);
      const route = researched.get(routeIndex) ?? topologies[routeIndex];
      const visit = side === 'from' ? route.visits[0] : route.visits[route.visits.length - 1];
      if (
        visit !== undefined &&
        target >= visit.feasibleTrack[0] - EPSILON &&
        target <= visit.feasibleTrack[1] + EPSILON
      ) {
        continue;
      }
      if (options.protectedRouteIndexes?.has(routeIndex) === true) {
        blockedRouteIndex = routeIndex;
        break;
      }
      const search = searchRoute(
        world,
        pinnedSearchRequest(requests[routeIndex], topologies[routeIndex], pins, routeIndex),
        { preferCenteredTerminalAttachments: false },
      );
      if (search.fallback || !search.cost) {
        blockedRouteIndex = routeIndex;
        break;
      }
      researched.set(routeIndex, search.route);
    }
    if (blockedRouteIndex !== undefined) {
      continue;
    }

    const candidateTopologies = topologies.map((route, routeIndex) => {
      const base = researched.get(routeIndex) ?? route;
      const fromPin = pins.get(pinKey(routeIndex, 'from'));
      const toPin = pins.get(pinKey(routeIndex, 'to'));
      if (fromPin === undefined && toPin === undefined && base === route) {
        return cloneRoute(route);
      }
      // Endpoints come from the incumbent topology (never the search request) so injected
      // authored marks are dropped and pins from earlier accepted faces are preserved.
      return new Route(
        route.requestIndex,
        pinEndpoint(route.from, fromPin),
        pinEndpoint(route.to, toPin),
        base.visits,
      );
    });
    candidatesBuilt += 1;
    let candidate: RealizedRouteBatch;
    try {
      candidate = realizeRoutes(world, candidateTopologies, {
        continuationCutSelection: 'exhaustive',
        independentContinuations: options.realization.independentContinuations,
        ...reuseOptions(
          {
            incrementalEmission: options.realization.incrementalEmission,
            incrementalLineMerges: options.realization.incrementalLineMerges,
          },
          incumbent,
        ),
      });
    } catch {
      continue;
    }
    const candidateCost = slotModeCost(world, candidate);
    const accepted =
      compareRoutingQualityCosts(candidateCost, incumbentCost) < 0 &&
      !violatesRepairIdentity(
        candidate.routes,
        leafCutKeys(
          candidate.routes,
          candidate.geometryQuality.index,
          options.leaves,
          options.entityCount,
        ),
        leafCutKeys(
          incumbent.routes,
          incumbent.geometryQuality.index,
          options.leaves,
          options.entityCount,
        ),
      );
    if (accepted) {
      incumbent = candidate;
      incumbentCost = candidateCost;
      topologies = candidateTopologies;
      candidatesAccepted += 1;
    }
  }

  return {
    batch: incumbent,
    topologies,
    changed: candidatesBuilt > 0,
    accepted: candidatesAccepted > 0,
  };
}

/**
 * The shared-gate cost with the endpoint-quality source swapped for slot-mode events on both
 * sides. When the pipeline-wide event gate is on this is the ledger cost unchanged; when it
 * is off, only this phase prices the slot defect so other phases cannot repeatedly pursue it.
 */
function slotModeCost(world: CorridorWorld, batch: RealizedRouteBatch): RoutingQualityCost {
  const otherEvents = batch.quality.sources
    .filter((source) => source.source !== 'emission:endpoint-quality')
    .flatMap((source) => source.events);
  const endpointQuality = collectEndpointQualityEvents(world, batch.routes, { slotEvents: true });
  return routingQualityCost([...otherEvents, ...endpointQuality], batch.quality.scalarCosts);
}

function pinKey(routeIndex: number, side: EndpointSide): string {
  return `${routeIndex}|${side}`;
}

function parsePinKey(key: string): { routeIndex: number; side: EndpointSide } {
  const [routeIndex, side] = key.split('|');
  return { routeIndex: Number(routeIndex), side: side as EndpointSide };
}

function pinEndpoint(endpoint: RouteEndpoint, pin: number | undefined): RouteEndpoint {
  return pin === undefined ? endpoint : { ...endpoint, repairPinTrack: pin };
}

/**
 * Search request with every pinned side of this route injected as an authored track: the
 * search must honor the slot exactly (choosing whichever terminal corridor reaches it), and
 * a pre-existing pin from an earlier accepted face keeps its corridor the same way.
 */
function pinnedSearchRequest(
  request: RouteSearchRequest,
  route: Route,
  pins: ReadonlyMap<string, number>,
  routeIndex: number,
): RouteSearchRequest {
  const sideEndpoint = (side: EndpointSide): RouteEndpoint => {
    const endpoint = side === 'from' ? request.from : request.to;
    const track = pins.get(pinKey(routeIndex, side)) ?? route[side].repairPinTrack;
    return track === undefined ? endpoint : { ...endpoint, authoredTrack: track };
  };
  return { ...request, from: sideEndpoint('from'), to: sideEndpoint('to') };
}

/** Worst-first list of faces whose slot charge is worth a candidate. */
function slotChargedFaces(world: CorridorWorld, routes: readonly Route[]): FanFace[] {
  const groups = new Map<
    string,
    { entityIndex: number; face: Direction; samples: FanPortSample[] }
  >();
  routes.forEach((route, routeIndex) => {
    if (route.visits.length === 0) {
      return;
    }
    const ports = route.ports();
    for (const side of ['from', 'to'] as const) {
      const endpoint = route[side];
      if (endpoint.authoredTrack !== undefined) {
        continue;
      }
      const point = ports[side];
      const coordinate = endpoint.face === 'left' || endpoint.face === 'right' ? point.y : point.x;
      const key = `${endpoint.entityIndex}|${endpoint.face}`;
      const group = groups.get(key) ?? {
        entityIndex: endpoint.entityIndex,
        face: endpoint.face,
        samples: [],
      };
      group.samples.push({ routeIndex, side, coordinate });
      groups.set(key, group);
    }
  });
  const faces: FanFace[] = [];
  for (const group of groups.values()) {
    const samples = [...group.samples].sort((left, right) => left.coordinate - right.coordinate);
    const entity = (world.sourceEntities ?? world.entities)[group.entityIndex];
    const span = faceCrossSpan(entity, group.face);
    const assessment = assessFaceSlots(
      span,
      samples.map((sample) => sample.coordinate),
    );
    if (assessment.charge < MIN_FACE_CHARGE) {
      continue;
    }
    faces.push({ entityIndex: group.entityIndex, face: group.face, span, samples, assessment });
  }
  return faces.sort((left, right) => right.assessment.charge - left.assessment.charge);
}

/** Stock worst band starts here; the slot model's own charge also treats it as extreme. */
const WORST_BAND_DEVIATION = 0.6;

interface FacePortRecord {
  readonly routeIndex: number;
  readonly side: EndpointSide;
  readonly coordinate: number;
}

function facePortRecords(routes: readonly Route[]): Map<string, FacePortRecord[]> {
  const byFace = new Map<string, FacePortRecord[]>();
  routes.forEach((route, routeIndex) => {
    if (route.visits.length === 0) {
      return;
    }
    const ports = route.ports();
    for (const side of ['from', 'to'] as const) {
      const endpoint = route[side];
      if (endpoint.authoredTrack !== undefined) {
        continue;
      }
      const point = ports[side];
      const coordinate = endpoint.face === 'left' || endpoint.face === 'right' ? point.y : point.x;
      const key = `${endpoint.entityIndex}|${endpoint.face}`;
      const list = byFace.get(key) ?? [];
      list.push({ routeIndex, side, coordinate });
      byFace.set(key, list);
    }
  });
  for (const list of byFace.values()) {
    list.sort((left, right) => left.coordinate - right.coordinate);
  }
  return byFace;
}

function convexCharge(deviation: number, halfSpan: number): number {
  if (halfSpan <= 0) {
    return 0;
  }
  const normalized = Math.min(1, Math.max(0, deviation) / halfSpan);
  return normalized * (1 + normalized * normalized);
}

/**
 * The approved narrow joint solve: a route leaving this face straight into another face (or
 * into a face with no other ports) couples both faces' slot expectations through its one
 * shared track. The anchor is the integer track minimising the SUM of both convex slot
 * charges — both endpoints priced, so straight-but-off-centre loses to a Z whenever the far
 * face has capacity, and a genuinely shared optimum keeps the line straight at it. Anchors
 * that cannot stay on the far face, would reorder the far face's ports, or would land in the
 * worst band of either face are skipped: the route then fans out with ordinary bends and the
 * far port keeps its own face's expectation.
 */
function straightCoupledAnchors(
  world: CorridorWorld,
  routes: readonly Route[],
  fanFace: FanFace,
): Map<number, number> {
  const anchors = new Map<number, number>();
  const byFace = facePortRecords(routes);
  const nearSpan = faceCrossSpan(
    (world.sourceEntities ?? world.entities)[fanFace.entityIndex],
    fanFace.face,
  );
  const nearHalfSpan = (nearSpan[1] - nearSpan[0]) / 2;
  let previousAnchor = Number.NEGATIVE_INFINITY;
  fanFace.samples.forEach((sample, sampleIndex) => {
    const route = routes[sample.routeIndex];
    const oppositeSide: EndpointSide = sample.side === 'from' ? 'to' : 'from';
    const opposite = route[oppositeSide];
    if (opposite.authoredTrack !== undefined) {
      return;
    }
    // A shared track only exists between parallel faces. A perpendicular far face's
    // expectation lives on the other axis entirely; treating it as an anchor candidate
    // compares an x-port against a y-expectation that merely happens to be a nearby number.
    const fanFaceIsSide = fanFace.face === 'left' || fanFace.face === 'right';
    const farFaceIsSide = opposite.face === 'left' || opposite.face === 'right';
    if (fanFaceIsSide !== farFaceIsSide) {
      return;
    }
    const farKey = `${opposite.entityIndex}|${opposite.face}`;
    const farPorts = byFace.get(farKey) ?? [];
    if (farPorts.length !== 1 && route.points().length !== 2) {
      return;
    }
    const farEntity = (world.sourceEntities ?? world.entities)[opposite.entityIndex];
    const farSpan = faceCrossSpan(farEntity, opposite.face);
    const farHalfSpan = (farSpan[1] - farSpan[0]) / 2;
    const farAssessment = assessFaceSlots(
      farSpan,
      farPorts.map((port) => port.coordinate),
    );
    const farRank = farPorts.findIndex(
      (port) => port.routeIndex === sample.routeIndex && port.side === oppositeSide,
    );
    if (farRank < 0) {
      return;
    }
    const nearExpectation = fanFace.assessment.expected[sampleIndex];
    const farExpectation = farAssessment.expected[farRank];
    const low = Math.round(Math.min(nearExpectation, farExpectation));
    const high = Math.round(Math.max(nearExpectation, farExpectation));
    let anchor: number | undefined;
    let bestCharge = Number.POSITIVE_INFINITY;
    for (let track = low; track <= high; track += 1) {
      const charge =
        convexCharge(Math.abs(track - nearExpectation), nearHalfSpan) +
        convexCharge(Math.abs(track - farExpectation), farHalfSpan);
      if (charge < bestCharge - EPSILON) {
        bestCharge = charge;
        anchor = track;
      }
    }
    if (anchor === undefined) {
      return;
    }
    const farNeighbourBefore = farPorts[farRank - 1]?.coordinate;
    const farNeighbourAfter = farPorts[farRank + 1]?.coordinate;
    // The anchor must physically sit on both faces and may not push the far port into the
    // worst band of its own expectation; the near face re-slices its remaining slots around
    // the anchor, so its taste is checked by the final valve on the re-sliced arrangement.
    if (
      anchor <= previousAnchor ||
      anchor < nearSpan[0] + PORT_EDGE_PADDING_PX ||
      anchor > nearSpan[1] - PORT_EDGE_PADDING_PX ||
      anchor < farSpan[0] + PORT_EDGE_PADDING_PX ||
      anchor > farSpan[1] - PORT_EDGE_PADDING_PX ||
      (farNeighbourBefore !== undefined && anchor <= farNeighbourBefore) ||
      (farNeighbourAfter !== undefined && anchor >= farNeighbourAfter) ||
      Math.abs(anchor - farExpectation) > WORST_BAND_DEVIATION * farHalfSpan
    ) {
      return;
    }
    previousAnchor = anchor;
    anchors.set(sampleIndex, anchor);
  });
  return anchors;
}

/**
 * Slot targets with anchored ports fixed: each maximal run of free ports between consecutive
 * anchors (or face ends) is sliced into its own equal slots, so order is preserved and the
 * assignment degenerates to plain face slots when nothing is anchored.
 */
function anchoredSlotTargets(fanFace: FanFace, anchors: ReadonlyMap<number, number>): number[] {
  const count = fanFace.samples.length;
  if (anchors.size === 0) {
    return fanFace.assessment.expected.map((expected) => Math.round(expected));
  }
  const faceStart = fanFace.span[0];
  const faceEnd = fanFace.span[1];
  const targets = new Array<number>(count);
  const anchorIndexes = [...anchors.keys()].sort((left, right) => left - right);
  let runStart = 0;
  let leftBound = faceStart;
  const flushRun = (runEndExclusive: number, rightBound: number): void => {
    const freeCount = runEndExclusive - runStart;
    if (freeCount > 0) {
      const subLength = (rightBound - leftBound) / freeCount;
      for (let offset = 0; offset < freeCount; offset += 1) {
        targets[runStart + offset] = Math.round(leftBound + subLength * (offset + 0.5));
      }
    }
  };
  for (const anchorIndex of anchorIndexes) {
    const anchor = anchors.get(anchorIndex) as number;
    flushRun(anchorIndex, anchor);
    targets[anchorIndex] = anchor;
    runStart = anchorIndex + 1;
    leftBound = anchor;
  }
  flushRun(count, faceEnd);
  return targets;
}

/**
 * Reject a candidate that moves a pinned endpoint into the worst band of its own face's slot
 * expectation when it was not already there. Returns the first violating endpoint, or undefined
 * when the candidate is clean.
 */
function newWorstBandPinnedEndpoint(
  world: CorridorWorld,
  routes: readonly Route[],
  pins: ReadonlyMap<string, number>,
  fanFace: FanFace,
): string | undefined {
  const byFace = facePortRecords(routes);
  const fanFaceKey = `${fanFace.entityIndex}|${fanFace.face}`;
  for (const [faceKey, ports] of byFace) {
    // The fan face's own ports sit on the joint-solve targets by construction; the valve
    // protects the OTHER faces that partner pins drag.
    if (faceKey === fanFaceKey) {
      continue;
    }
    if (
      ![...pins.keys()].some((key) =>
        ports.some((port) => pinKey(port.routeIndex, port.side) === key),
      )
    ) {
      continue;
    }
    const [entityIndex, face] = faceKey.split('|');
    const span = faceCrossSpan(
      (world.sourceEntities ?? world.entities)[Number(entityIndex)],
      face as Direction,
    );
    const halfSpan = (span[1] - span[0]) / 2;
    if (halfSpan <= 0) {
      continue;
    }
    const before = assessFaceSlots(
      span,
      ports.map((port) => port.coordinate),
    );
    const pinnedCoordinates = ports
      .map((port) => pins.get(pinKey(port.routeIndex, port.side)) ?? port.coordinate)
      .sort((left, right) => left - right);
    const after = assessFaceSlots(span, pinnedCoordinates);
    for (let rank = 0; rank < ports.length; rank += 1) {
      const wasPinned = pins.has(pinKey(ports[rank].routeIndex, ports[rank].side));
      if (!wasPinned) {
        continue;
      }
      const beforeDeviation = before.deviations[rank] / halfSpan;
      const afterDeviation = after.deviations[rank] / halfSpan;
      if (afterDeviation > WORST_BAND_DEVIATION && beforeDeviation <= WORST_BAND_DEVIATION) {
        return `${faceKey} rank ${rank} (${beforeDeviation.toFixed(2)} -> ${afterDeviation.toFixed(2)})`;
      }
    }
  }
  return undefined;
}
