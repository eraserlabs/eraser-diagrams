import { OPPOSITE_DIRECTION } from '../../directionUtils.js';
import { midpoint } from '../../rangeUtils.js';
import type { AxisSpan, Direction, PositionProps, XYPoint } from '../../types.js';
import { terminalDirectionViolation } from '../measure/terminalDirection.js';
import {
  convexPortCenteringCharge,
  normalizedFaceCenterDeviation,
  portCornerPressure,
} from '../measure/portCentering.js';
import type { EndpointSide } from '../types.js';
import { assessFaceSlots } from './faceSlots.js';
import { faceCrossSpan, segmentPiercesRect } from './geometry.js';
import {
  ROUTING_QUALITY_COSTS,
  type FaceFanSymmetryQualityEvent,
  type RoutingQualityEvent,
  type RoutingQualityVisitRef,
  type SiblingSymmetryQualityEvent,
  type TerminalDirectionQualityEvent,
} from './qualityCost.js';
import type { Route } from './route.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;
const LARGE_CONTAINER_FACE_PX = 200;
const LARGE_CONTAINER_SINGLETON_WEIGHT = 0.35;
const NEITHER_ENDPOINT_CENTERED_WEIGHT = 0.5;
const MIRROR_FAMILY_TOLERANCE_PX = 2;
const SYMMETRY_FULL_PENALTY_PX = 24;

interface PortSample {
  readonly routeIndex: number;
  readonly side: EndpointSide;
  readonly entityIndex: number;
  readonly face: Direction;
  readonly coordinate: number;
  readonly visit: RoutingQualityVisitRef;
  readonly corridorIndex: number;
}

interface SingletonPortPenalty {
  readonly deviation: number;
  readonly sample: PortSample;
}

/** Measure final face-fan centering once emitted terminal coordinates are authoritative. */
export function collectEndpointQualityEvents(
  world: CorridorWorld,
  routes: readonly Route[],
  options: { readonly slotEvents?: boolean } = {},
): readonly RoutingQualityEvent[] {
  // Slot events are fan-spread's internal pricing. The production ledger keeps the classic
  // events so another phase cannot repeatedly chase the same slot defect.
  const slotEventEnabled = options.slotEvents === true;
  const groups = new Map<string, PortSample[]>();
  const events: RoutingQualityEvent[] = [];

  routes.forEach((route, routeIndex) => {
    if (route.visits.length === 0) {
      return;
    }
    const points = route.points();
    const ports = route.ports();
    for (const side of ['from', 'to'] as const) {
      const endpoint = route[side];
      const visitIndex = side === 'from' ? 0 : route.visits.length - 1;
      const corridorIndex = route.visits[visitIndex].corridorIndex;
      const violation = terminalDirectionViolation(points, endpoint.face, side);
      const entity = (world.sourceEntities ?? world.entities)[endpoint.entityIndex];
      const violationKind =
        violation?.kind ??
        (entity.isContainer === true && terminalContainerExcursion(points, entity, side)
          ? 'inward'
          : undefined);
      if (violationKind) {
        const event: TerminalDirectionQualityEvent = {
          kind: 'terminal-direction',
          cost: ROUTING_QUALITY_COSTS.terminalDirection,
          routeIndexes: [routeIndex],
          corridorIndexes: [corridorIndex],
          visits: [{ routeIndex, visitIndex }],
        };
        events.push(event);
      }
      if (endpoint.authoredTrack !== undefined) {
        continue;
      }
      const point = ports[side];
      const sample: PortSample = {
        routeIndex,
        side,
        entityIndex: endpoint.entityIndex,
        face: endpoint.face,
        coordinate: endpoint.face === 'left' || endpoint.face === 'right' ? point.y : point.x,
        visit: { routeIndex, visitIndex },
        corridorIndex,
      };
      const groupKey = `${endpoint.entityIndex}|${endpoint.face}`;
      const group = groups.get(groupKey) ?? [];
      group.push(sample);
      groups.set(groupKey, group);
    }
  });

  const singletonPenaltyByRouteSide = new Map<string, SingletonPortPenalty>();

  for (const group of groups.values()) {
    const first = group[0];
    const entity = (world.sourceEntities ?? world.entities)[first.entityIndex];
    const faceSpan = faceCrossSpan(entity, first.face);
    const halfSpan = (faceSpan[1] - faceSpan[0]) / 2;
    const center = midpoint(faceSpan);
    const centroid = group.reduce((sum, sample) => sum + sample.coordinate, 0) / group.length;
    const deviation = normalizedFaceCenterDeviation(centroid, center, halfSpan);
    const singletonWeight =
      entity.isContainer === true && halfSpan * 2 >= LARGE_CONTAINER_FACE_PX
        ? LARGE_CONTAINER_SINGLETON_WEIGHT + (1 - LARGE_CONTAINER_SINGLETON_WEIGHT) * deviation
        : 1;
    const perPortPenalty =
      convexPortCenteringCharge(deviation) * (group.length === 1 ? singletonWeight : 1);
    const contribution = perPortPenalty * group.length;
    // The slot event subsumes the centroid concept: under the gate the group's
    // distance-from-center contribution is replaced, never double-priced.
    if (!slotEventEnabled && contribution > EPSILON) {
      events.push({
        kind: 'port-centering',
        cost: ROUTING_QUALITY_COSTS.portCentering * contribution,
        routeIndexes: [...new Set(group.map((sample) => sample.routeIndex))],
        corridorIndexes: [...new Set(group.map((sample) => sample.corridorIndex))],
        visits: group.map((sample) => sample.visit),
      });
    }
    if (slotEventEnabled) {
      const fanEvent = faceFanSymmetryEvent(
        group,
        faceSpan,
        group.length === 1 ? singletonWeight : 1,
      );
      if (fanEvent) {
        events.push(fanEvent);
      }
    }
    // Corner pressure and the neither-endpoint-centered pair term are both
    // distance-from-face-center concepts; in slot mode the slot charge is the sole
    // authority on where a port should sit (an outer slot center on a full fan lies
    // beyond the corner-pressure knee by construction).
    if (slotEventEnabled) {
      continue;
    }
    for (const sample of group) {
      const individualDeviation = normalizedFaceCenterDeviation(
        sample.coordinate,
        center,
        halfSpan,
      );
      const individualCornerPressure = portCornerPressure(individualDeviation);
      if (individualCornerPressure <= EPSILON) {
        continue;
      }
      events.push({
        kind: 'port-centering',
        cost: ROUTING_QUALITY_COSTS.portCentering * individualCornerPressure,
        routeIndexes: [sample.routeIndex],
        corridorIndexes: [sample.corridorIndex],
        visits: [sample.visit],
      });
    }
    if (group.length === 1) {
      singletonPenaltyByRouteSide.set(routeSideKey(first.routeIndex, first.side), {
        deviation,
        sample: first,
      });
    }
  }

  routes.forEach((_, routeIndex) => {
    const from = singletonPenaltyByRouteSide.get(routeSideKey(routeIndex, 'from'));
    const to = singletonPenaltyByRouteSide.get(routeSideKey(routeIndex, 'to'));
    if (!from || !to) {
      return;
    }
    const contribution = Math.min(from.deviation, to.deviation) * NEITHER_ENDPOINT_CENTERED_WEIGHT;
    if (contribution <= EPSILON) {
      return;
    }
    events.push({
      kind: 'port-centering',
      cost: ROUTING_QUALITY_COSTS.portCentering * contribution,
      routeIndexes: [routeIndex],
      corridorIndexes: [from.sample.corridorIndex, to.sample.corridorIndex],
      visits: [from.sample.visit, to.sample.visit],
    });
  });

  events.push(...siblingSymmetryEvents(world, routes, groups));
  return events;
}

/**
 * Slot cost of a face's endpoint arrangement: slice the face into one equal slot per endpoint
 * and charge each endpoint convexly for its distance from its slot center in coordinate order.
 * This replaces both gap variance and group distance-from-center pricing; with one endpoint it
 * degenerates to the classic singleton centering charge and preserves its container weight.
 */
function faceFanSymmetryEvent(
  group: readonly PortSample[],
  faceSpan: AxisSpan,
  weight: number,
): FaceFanSymmetryQualityEvent | undefined {
  const coordinates = group.map((sample) => sample.coordinate).sort((left, right) => left - right);
  const assessment = assessFaceSlots(faceSpan, coordinates);
  if (assessment.charge * weight <= EPSILON) {
    return undefined;
  }
  return {
    kind: 'face-fan-symmetry',
    cost: ROUTING_QUALITY_COSTS.portCentering * assessment.charge * weight,
    routeIndexes: [...new Set(group.map((sample) => sample.routeIndex))],
    corridorIndexes: [...new Set(group.map((sample) => sample.corridorIndex))],
    visits: group.map((sample) => sample.visit),
  };
}

/** A container terminal may be touched only by its own endpoint segment. */
function terminalContainerExcursion(
  points: readonly XYPoint[],
  entity: PositionProps,
  side: EndpointSide,
): boolean {
  const interior = {
    x: entity.x + EPSILON,
    y: entity.y + EPSILON,
    width: entity.width - 2 * EPSILON,
    height: entity.height - 2 * EPSILON,
  };
  if (interior.width <= 0 || interior.height <= 0) {
    return false;
  }
  const startSegmentIndex = side === 'from' ? 1 : 0;
  const endSegmentIndex = side === 'to' ? points.length - 2 : points.length - 1;
  for (let segmentIndex = startSegmentIndex; segmentIndex < endSegmentIndex; segmentIndex += 1) {
    if (segmentPiercesRect(points[segmentIndex], points[segmentIndex + 1], interior)) {
      return true;
    }
  }
  return false;
}

function siblingSymmetryEvents(
  world: CorridorWorld,
  routes: readonly Route[],
  groups: ReadonlyMap<string, readonly PortSample[]>,
): SiblingSymmetryQualityEvent[] {
  const events: SiblingSymmetryQualityEvent[] = [];
  for (const group of groups.values()) {
    if (!group.every((sample) => sample.side === group[0].side)) {
      continue;
    }
    if (group.length === 2) {
      const event = twoRouteSiblingSymmetryEvent(world, routes, group);
      if (event) {
        events.push(event);
      }
      continue;
    }
    if (group.length !== 3) {
      continue;
    }
    const sharedSide = group[0].side;
    const sharedFace = group[0].face;
    const expectedOppositeFace = OPPOSITE_DIRECTION[sharedFace];
    const ranked = group
      .map((sample) => {
        const route = routes[sample.routeIndex];
        const endpoint = route[sharedSide === 'from' ? 'to' : 'from'];
        const entity = world.entities[endpoint.entityIndex];
        return {
          sample,
          endpoint,
          coordinate:
            sharedFace === 'left' || sharedFace === 'right'
              ? entity.y + entity.height / 2
              : entity.x + entity.width / 2,
        };
      })
      .sort((left, right) => left.coordinate - right.coordinate);
    if (ranked.some((record) => record.endpoint.face !== expectedOppositeFace)) {
      continue;
    }
    const sharedEntity = (world.sourceEntities ?? world.entities)[group[0].entityIndex];
    const sharedCenter = midpoint(faceCrossSpan(sharedEntity, sharedFace));
    if (
      Math.abs(ranked[1].coordinate - sharedCenter) > MIRROR_FAMILY_TOLERANCE_PX ||
      Math.abs(ranked[0].coordinate + ranked[2].coordinate - sharedCenter * 2) >
        MIRROR_FAMILY_TOLERANCE_PX
    ) {
      continue;
    }
    const outerTurnCoordinates = [ranked[0], ranked[2]].map(({ sample }) =>
      firstCrossAxisTurn(routes[sample.routeIndex], sharedSide, sharedFace),
    );
    if (outerTurnCoordinates[0] === undefined || outerTurnCoordinates[1] === undefined) {
      continue;
    }
    const alignmentError = Math.abs(outerTurnCoordinates[0] - outerTurnCoordinates[1]);
    if (alignmentError <= EPSILON) {
      continue;
    }
    events.push({
      kind: 'sibling-symmetry',
      cost: ROUTING_QUALITY_COSTS.symmetry * Math.min(1, alignmentError / SYMMETRY_FULL_PENALTY_PX),
      routeIndexes: ranked.map(({ sample }) => sample.routeIndex),
      corridorIndexes: ranked.map(({ sample }) => sample.corridorIndex),
      visits: ranked.map(({ sample }) => sample.visit),
    });
  }
  return events;
}

interface TransverseVisit {
  readonly corridorIndex: number;
  readonly track: number;
  readonly visit: RoutingQualityVisitRef;
}

/**
 * Score a two-route fan only when both remote approaches resolve onto the same
 * transverse corridor. This distinguishes an intended mirrored trunk from two
 * unrelated routes that merely happen to share an entity face.
 */
function twoRouteSiblingSymmetryEvent(
  world: CorridorWorld,
  routes: readonly Route[],
  group: readonly PortSample[],
): SiblingSymmetryQualityEvent | undefined {
  const sharedSide = group[0].side;
  const sharedFace = group[0].face;
  const expectedOppositeFace = OPPOSITE_DIRECTION[sharedFace];
  const ranked = group
    .map((sample) => {
      const route = routes[sample.routeIndex];
      const endpoint = route[sharedSide === 'from' ? 'to' : 'from'];
      const entity = world.entities[endpoint.entityIndex];
      return {
        sample,
        endpoint,
        coordinate:
          sharedFace === 'left' || sharedFace === 'right'
            ? entity.y + entity.height / 2
            : entity.x + entity.width / 2,
      };
    })
    .sort((left, right) => left.coordinate - right.coordinate);
  if (ranked.some((record) => record.endpoint.face !== expectedOppositeFace)) {
    return undefined;
  }
  const sharedEntity = (world.sourceEntities ?? world.entities)[group[0].entityIndex];
  const sharedCenter = midpoint(faceCrossSpan(sharedEntity, sharedFace));
  if (
    ranked[0].coordinate >= sharedCenter - EPSILON ||
    ranked[1].coordinate <= sharedCenter + EPSILON
  ) {
    return undefined;
  }
  const transverseVisits = ranked.map(({ sample }) =>
    firstTransverseVisit(
      world,
      routes[sample.routeIndex],
      sample.routeIndex,
      sharedSide,
      sharedFace,
    ),
  );
  const firstVisit = transverseVisits[0];
  const secondVisit = transverseVisits[1];
  if (!firstVisit || !secondVisit || firstVisit.corridorIndex !== secondVisit.corridorIndex) {
    return undefined;
  }
  const alignmentError = Math.abs(firstVisit.track - secondVisit.track);
  if (alignmentError <= EPSILON) {
    return undefined;
  }
  const routeIndexes = [ranked[0].sample.routeIndex, ranked[1].sample.routeIndex];
  return {
    kind: 'sibling-symmetry',
    cost: ROUTING_QUALITY_COSTS.symmetry * Math.min(1, alignmentError / SYMMETRY_FULL_PENALTY_PX),
    routeIndexes,
    corridorIndexes: [firstVisit.corridorIndex],
    visits: [firstVisit.visit, secondVisit.visit],
  };
}

function firstTransverseVisit(
  world: CorridorWorld,
  route: Route,
  routeIndex: number,
  sharedSide: EndpointSide,
  sharedFace: Direction,
): TransverseVisit | undefined {
  const normalAxis = sharedFace === 'left' || sharedFace === 'right' ? 'x' : 'y';
  const visitIndexes = route.visits.map((_, visitIndex) => visitIndex);
  if (sharedSide === 'from') {
    visitIndexes.reverse();
  }
  for (const visitIndex of visitIndexes) {
    const visit = route.visits[visitIndex];
    if (world.indexer.corridors[visit.corridorIndex].axis === normalAxis) {
      continue;
    }
    return {
      corridorIndex: visit.corridorIndex,
      track: route.nominalTrackOf(visitIndex),
      visit: { routeIndex, visitIndex },
    };
  }
  return undefined;
}

function firstCrossAxisTurn(
  route: Route,
  sharedSide: EndpointSide,
  sharedFace: Direction,
): number | undefined {
  const points = sharedSide === 'to' ? route.points() : [...route.points()].reverse();
  const normalAxis = sharedFace === 'left' || sharedFace === 'right' ? 'x' : 'y';
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    const segmentAxis = before.x === after.x ? 'y' : before.y === after.y ? 'x' : undefined;
    if (segmentAxis && segmentAxis !== normalAxis) {
      return normalAxis === 'x' ? before.x : before.y;
    }
  }
  return undefined;
}

function routeSideKey(routeIndex: number, side: EndpointSide): string {
  return `${routeIndex}|${side}`;
}
