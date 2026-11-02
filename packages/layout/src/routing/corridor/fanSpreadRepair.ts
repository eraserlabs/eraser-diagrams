import type { Direction } from '../../types.js';
import type { EndpointSide } from '../types.js';
import { isPointEndpoint } from './contract.js';
import type { RouteEndpoint, RouteSearchRequest } from './contract.js';
import { assessFaceSlots, type FaceSlotAssessment } from './faceSlots.js';
import { faceCrossSpan } from './geometry.js';
import { ROUTING_QUALITY_COSTS } from './qualityCost.js';
import {
  replaceRepairRoutes,
  type RepairContext,
  type RepairProposal,
  type RepairState,
} from './repairProposal.js';
import { Route } from './route.js';
import { PORT_EDGE_PADDING_PX } from './spacing.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;
/** Faces below this slot charge are visually fine; repairing them cannot pay for itself. */
const MIN_FACE_CHARGE = 0.15;

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

/**
 * Move a face's ports together, preserving their order. A target outside its current
 * terminal corridor re-searches that route; targets remain repair pins, not authored ports.
 */
export function collectFaceProposals(context: RepairContext): RepairProposal[] {
  if (context.mode === 'caps') {
    return [];
  }
  return slotChargedFaces(context.world, context.batch.routes)
    .filter((face) =>
      face.samples.every((sample) => !context.protectedRouteIndexes.has(sample.routeIndex)),
    )
    .map((face) => {
      const routeIndexes = [...new Set(face.samples.map((sample) => sample.routeIndex))];
      return {
        kind: 'face',
        key: `${face.entityIndex}:${face.face}`,
        routeIndexes,
        cost: {
          invalid: 0,
          cap: 0,
          scalar: ROUTING_QUALITY_COSTS.portCentering * face.assessment.charge,
        },
        build: () => buildFaceProposal(context, face, routeIndexes),
      };
    });
}

function buildFaceProposal(
  context: RepairContext,
  face: FanFace,
  routeIndexes: readonly number[],
): RepairState | undefined {
  const { world, batch, topologies, requests } = context;
  const anchors = straightCoupledAnchors(world, batch.routes, face);
  const targets = anchoredSlotTargets(face, anchors);
  const pins = new Map<string, number>();
  face.samples.forEach((sample, index) => {
    pins.set(pinKey(sample.routeIndex, sample.side), targets[index]);
  });
  for (const [index, anchor] of anchors) {
    const sample = face.samples[index];
    pins.set(pinKey(sample.routeIndex, sample.side === 'from' ? 'to' : 'from'), anchor);
  }
  const researched = new Map<number, Route>();
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
    const search = context.search.search(
      pinnedSearchRequest(requests[routeIndex], topologies[routeIndex], pins, routeIndex),
      { preferCenteredTerminalAttachments: false },
    );
    if (search.fallback || !search.cost) {
      return undefined;
    }
    researched.set(routeIndex, search.route);
  }
  const replacements = new Map<number, Route>();
  for (const routeIndex of routeIndexes) {
    const route = topologies[routeIndex];
    // Keep incumbent endpoints so temporary search constraints do not become authored pins.
    replacements.set(
      routeIndex,
      new Route(
        route.requestIndex,
        pinEndpoint(route.from, pins.get(pinKey(routeIndex, 'from'))),
        pinEndpoint(route.to, pins.get(pinKey(routeIndex, 'to'))),
        (researched.get(routeIndex) ?? route).visits,
      ),
    );
  }
  return replaceRepairRoutes(context, replacements, new Set(researched.keys()));
}

function pinKey(routeIndex: number, side: EndpointSide): string {
  return `${routeIndex}|${side}`;
}

function parsePinKey(key: string): { routeIndex: number; side: EndpointSide } {
  const [routeIndex, side] = key.split('|');
  return { routeIndex: Number(routeIndex), side: side as EndpointSide };
}

function pinEndpoint(endpoint: RouteEndpoint, pin: number | undefined): RouteEndpoint {
  if (pin === undefined || isPointEndpoint(endpoint)) {
    return endpoint;
  }
  return { ...endpoint, repairPinTrack: pin };
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
    if (isPointEndpoint(endpoint)) {
      return endpoint;
    }
    const routed = route[side];
    const track =
      pins.get(pinKey(routeIndex, side)) ??
      (isPointEndpoint(routed) ? undefined : routed.repairPinTrack);
    return track === undefined ? endpoint : { ...endpoint, authoredTrack: track };
  };
  return { ...request, from: sideEndpoint('from'), to: sideEndpoint('to') };
}

/** Faces whose slot charge is worth a candidate; the shared scheduler orders proposals. */
function slotChargedFaces(world: CorridorWorld, routes: readonly Route[]): FanFace[] {
  const faces: FanFace[] = [];
  for (const [key, samples] of facePortRecords(routes)) {
    const [entityKey, faceKey] = key.split('|');
    const entityIndex = Number(entityKey);
    const face = faceKey as Direction;
    const entity = (world.sourceEntities ?? world.entities)[entityIndex];
    const span = faceCrossSpan(entity, face);
    const assessment = assessFaceSlots(
      span,
      samples.map((sample) => sample.coordinate),
    );
    if (assessment.charge < MIN_FACE_CHARGE) {
      continue;
    }
    faces.push({ entityIndex, face, span, samples, assessment });
  }
  return faces;
}

/** Stock worst band starts here; the slot model's own charge also treats it as extreme. */
const WORST_BAND_DEVIATION = 0.6;

function facePortRecords(routes: readonly Route[]): Map<string, FanPortSample[]> {
  const byFace = new Map<string, FanPortSample[]>();
  routes.forEach((route, routeIndex) => {
    if (route.visits.length === 0) {
      return;
    }
    const ports = route.ports();
    for (const side of ['from', 'to'] as const) {
      const endpoint = route[side];
      if (isPointEndpoint(endpoint) || endpoint.authoredTrack !== undefined) {
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
 * Straight routes and solitary far ports can couple parallel faces. Pick the integer track
 * minimizing both slot charges, preserving face bounds and far-port order. The shared repair
 * objective judges the realized result, including any bends needed to reach these targets.
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
    if (isPointEndpoint(opposite) || opposite.authoredTrack !== undefined) {
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
    // the anchor, and shared scoring judges the complete arrangement.
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
