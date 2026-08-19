import { clipFacePointToOutline } from '../../outline.js';
import type { XYPoint } from '../../types.js';
import type { Corridor, PortalRef, RouteEndpoint } from './contract.js';
import { axisPoint, facePlane, pointInRect, samePoint, terminalFacePlane } from './geometry.js';
import { Route, type BoundaryRealization, type VisitBoundary } from './route.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;

interface EmissionOptions {
  /** Only these routes need geometry; every other route is already emitted and structurally shared. */
  readonly routeIndexes?: ReadonlySet<number>;
}

/** Whether two realized routes provide byte-identical inputs to the geometry emitter. */
export function haveSameEmissionInputs(route: Route, baseline: Route): boolean {
  if (
    route.requestIndex !== baseline.requestIndex ||
    !sameEndpoint(route.from, baseline.from) ||
    !sameEndpoint(route.to, baseline.to) ||
    route.visits.length !== baseline.visits.length
  ) {
    return false;
  }
  if (route.visits.length === 0) {
    return true;
  }
  for (let visitIndex = 0; visitIndex < route.visits.length; visitIndex += 1) {
    const visit = route.visits[visitIndex];
    const baselineVisit = baseline.visits[visitIndex];
    if (
      visit.corridorIndex !== baselineVisit.corridorIndex ||
      visit.feasibleTrack[0] !== baselineVisit.feasibleTrack[0] ||
      visit.feasibleTrack[1] !== baselineVisit.feasibleTrack[1] ||
      !sameBoundary(visit.entry, baselineVisit.entry) ||
      !sameBoundary(visit.exit, baselineVisit.exit) ||
      route.orderOf(visitIndex) !== baseline.orderOf(visitIndex) ||
      route.nominalTrackOf(visitIndex) !== baseline.nominalTrackOf(visitIndex)
    ) {
      return false;
    }
  }
  for (let afterVisitIndex = 1; afterVisitIndex < route.visits.length; afterVisitIndex += 1) {
    if (
      !sameBoundaryRealization(
        route.boundaryRealizationAfter(afterVisitIndex),
        baseline.boundaryRealizationAfter(afterVisitIndex),
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Convert spaced visit tracks into ports and cardinal polylines without new choices. */
export function emitRoutes(
  world: CorridorWorld,
  routes: readonly Route[],
  options: EmissionOptions = {},
): void {
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (route.visits.length === 0) {
      continue;
    }
    if (options.routeIndexes && !options.routeIndexes.has(routeIndex)) {
      route.assertEmitted();
      continue;
    }
    route.assertSpaced();
    // Terminal emission is the one place we leave the whole-pixel grid: endpoints
    // re-anchor to the caller's true (unsnapped) entity faces so lines meet the drawn
    // border exactly. Only the face-normal coordinate floats; tracks stay on-grid.
    const from = emittedEndpointPoint(world, route.from, route.nominalTrackOf(0));
    const to = emittedEndpointPoint(world, route.to, route.nominalTrackOf(route.visits.length - 1));
    const raw: XYPoint[] = [from];
    const rawSegmentVisits: number[] = [];
    for (let visitIndex = 0; visitIndex + 1 < route.visits.length; visitIndex += 1) {
      const current = route.visits[visitIndex];
      const next = route.visits[visitIndex + 1];
      const portal = sharedPortal(world, current.exit, next.entry);
      const currentCorridor = world.indexer.corridors[current.corridorIndex];
      const nextCorridor = world.indexer.corridors[next.corridorIndex];
      if (portal.kind === 'continue') {
        emitContinuation(
          raw,
          rawSegmentVisits,
          route,
          visitIndex,
          currentCorridor,
          nextCorridor,
          portal,
        );
        continue;
      }
      emitTurn(raw, rawSegmentVisits, route, visitIndex, currentCorridor, nextCorridor, portal);
    }
    appendRaw(raw, rawSegmentVisits, to, route.visits.length - 1);
    const { points, segmentVisitByIndex } = simplifyEmittedGeometry(
      route.requestIndex,
      raw,
      rawSegmentVisits,
    );
    route.setGeometry({ from, to }, points, segmentVisitByIndex);
  }
}

function emittedEndpointPoint(
  world: CorridorWorld,
  endpoint: RouteEndpoint,
  track: number,
): XYPoint {
  const sourceEntities = world.sourceEntities ?? world.entities;
  const source = sourceEntities[endpoint.entityIndex];
  const plane = terminalFacePlane(source, endpoint.face);
  const point =
    endpoint.face === 'left' || endpoint.face === 'right'
      ? { x: plane, y: track }
      : { x: track, y: plane };
  // A caption-extended plane attaches to the text's edge, not the body — never clip through it.
  if (plane !== facePlane(source, endpoint.face)) {
    return point;
  }
  return clipFacePointToOutline(source, endpoint.face, point);
}

function routeError(route: Route, message: string): never {
  throw new Error(`route ${route.requestIndex}: ${message}`);
}

/** Emit the boundary geometry for one straight continuation, appending to raw in place. */
function emitContinuation(
  raw: XYPoint[],
  rawSegmentVisits: number[],
  route: Route,
  visitIndex: number,
  currentCorridor: Corridor,
  nextCorridor: Corridor,
  portal: Extract<PortalRef, { readonly kind: 'continue' }>,
): void {
  const currentTrack = route.nominalTrackOf(visitIndex);
  const nextTrack = route.nominalTrackOf(visitIndex + 1);
  if (currentCorridor.axis !== nextCorridor.axis) {
    routeError(route, `invalid straight continuation at visit ${visitIndex}`);
  }
  const plane = portal.planeCoordinate;
  const realization = route.boundaryRealizationAfter(visitIndex + 1);
  if (Math.abs(currentTrack - nextTrack) <= EPSILON) {
    if (
      currentTrack < portal.crossSpan[0] - EPSILON ||
      currentTrack > portal.crossSpan[1] + EPSILON
    ) {
      routeError(route, `straight continuation misses portal ${portal.index}`);
    }
    appendRaw(
      raw,
      rawSegmentVisits,
      axisPoint(currentCorridor.axis, plane, currentTrack),
      visitIndex,
    );
    return;
  }
  if (!realization) {
    routeError(route, `continuation ${visitIndex} changed track without a host`);
  }
  if (realization.kind !== 'continue-retrack') {
    routeError(route, `continuation ${visitIndex} has a turn realization`);
  }
  appendBoundaryRealization(
    raw,
    rawSegmentVisits,
    route,
    visitIndex,
    currentCorridor,
    nextCorridor,
    plane,
    currentTrack,
    nextTrack,
    realization,
  );
}

/** Emit the corner for one turn boundary. */
function emitTurn(
  raw: XYPoint[],
  rawSegmentVisits: number[],
  route: Route,
  visitIndex: number,
  currentCorridor: Corridor,
  nextCorridor: Corridor,
  portal: Extract<PortalRef, { readonly kind: 'turn' }>,
): void {
  if (currentCorridor.axis === nextCorridor.axis) {
    routeError(route, 'turn portal does not change axis');
  }
  const turnRealization = route.boundaryRealizationAfter(visitIndex + 1);
  if (turnRealization) {
    if (turnRealization.kind !== 'turn-retrack') {
      routeError(route, `turn ${visitIndex} has a continuation plan`);
    }
    appendTurnBoundaryRealization(
      raw,
      rawSegmentVisits,
      route,
      visitIndex,
      currentCorridor,
      nextCorridor,
      portal,
      turnRealization,
    );
    return;
  }
  // The corner sits on the next visit's track along the current corridor's axis and on
  // the current visit's track along the cross axis.
  const corner = axisPoint(
    currentCorridor.axis,
    route.nominalTrackOf(visitIndex + 1),
    route.nominalTrackOf(visitIndex),
  );
  if (!pointInRect(corner, portal.rect)) {
    routeError(route, `portal corner ${visitIndex} outside portal ${portal.index}`);
  }
  appendRaw(raw, rawSegmentVisits, corner, visitIndex);
}

function sameEndpoint(left: Route['from'], right: Route['from']): boolean {
  return (
    left.entityIndex === right.entityIndex &&
    left.face === right.face &&
    left.authoredTrack === right.authoredTrack &&
    left.portGroup === right.portGroup
  );
}

function sameBoundary(left: VisitBoundary, right: VisitBoundary): boolean {
  return left.kind === 'terminal'
    ? right.kind === 'terminal' && left.attachmentIndex === right.attachmentIndex
    : right.kind === 'portal' && left.portalIndex === right.portalIndex && left.mode === right.mode;
}

function sameBoundaryRealization(
  left: BoundaryRealization | undefined,
  right: BoundaryRealization | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (
    left.kind !== right.kind ||
    left.afterVisitIndex !== right.afterVisitIndex ||
    left.shifts.length !== right.shifts.length
  ) {
    return false;
  }
  if (
    left.kind === 'turn-retrack' &&
    (right.kind !== 'turn-retrack' ||
      left.beforePortalTrack !== right.beforePortalTrack ||
      left.afterPortalTrack !== right.afterPortalTrack)
  ) {
    return false;
  }
  return left.shifts.every((shift, shiftIndex) => {
    const candidate = right.shifts[shiftIndex];
    return (
      shift.hostVisitIndex === candidate.hostVisitIndex &&
      shift.shiftCoordinate === candidate.shiftCoordinate &&
      shift.trackAfter === candidate.trackAfter
    );
  });
}

function appendTurnBoundaryRealization(
  raw: XYPoint[],
  rawSegmentVisits: number[],
  route: Route,
  visitIndex: number,
  currentCorridor: Corridor,
  nextCorridor: Corridor,
  portal: Extract<PortalRef, { readonly kind: 'turn' }>,
  realization: Extract<BoundaryRealization, { readonly kind: 'turn-retrack' }>,
): void {
  const currentTrack = route.nominalTrackOf(visitIndex);
  const nextTrack = route.nominalTrackOf(visitIndex + 1);
  const currentShift = realization.shifts.find((shift) => shift.hostVisitIndex === visitIndex);
  const nextShift = realization.shifts.find((shift) => shift.hostVisitIndex === visitIndex + 1);
  if (realization.shifts.length !== Number(Boolean(currentShift)) + Number(Boolean(nextShift))) {
    throw new Error(`route ${route.requestIndex}: turn ${visitIndex} has a remote shift`);
  }
  if (currentShift) {
    if (Math.abs(currentShift.trackAfter - realization.beforePortalTrack) > EPSILON) {
      throw new Error(`route ${route.requestIndex}: turn ${visitIndex} misses its before track`);
    }
    assertHostedShift(
      route,
      visitIndex,
      currentCorridor,
      currentTrack,
      currentShift.trackAfter,
      currentShift.shiftCoordinate,
    );
    appendRaw(
      raw,
      rawSegmentVisits,
      axisPoint(currentCorridor.axis, currentShift.shiftCoordinate, currentTrack),
      visitIndex,
    );
    appendRaw(
      raw,
      rawSegmentVisits,
      axisPoint(currentCorridor.axis, currentShift.shiftCoordinate, currentShift.trackAfter),
      visitIndex,
    );
  }
  const corner = axisPoint(
    currentCorridor.axis,
    realization.afterPortalTrack,
    realization.beforePortalTrack,
  );
  if (!pointInRect(corner, portal.rect)) {
    throw new Error(
      `route ${route.requestIndex}: re-tracked portal corner ${visitIndex} outside portal ${portal.index}`,
    );
  }
  appendRaw(raw, rawSegmentVisits, corner, visitIndex);
  if (nextShift) {
    if (Math.abs(nextShift.trackAfter - nextTrack) > EPSILON) {
      throw new Error(`route ${route.requestIndex}: turn ${visitIndex} misses its after track`);
    }
    assertHostedShift(
      route,
      visitIndex,
      nextCorridor,
      realization.afterPortalTrack,
      nextShift.trackAfter,
      nextShift.shiftCoordinate,
    );
    appendRaw(
      raw,
      rawSegmentVisits,
      axisPoint(nextCorridor.axis, nextShift.shiftCoordinate, realization.afterPortalTrack),
      visitIndex + 1,
    );
    appendRaw(
      raw,
      rawSegmentVisits,
      axisPoint(nextCorridor.axis, nextShift.shiftCoordinate, nextShift.trackAfter),
      visitIndex + 1,
    );
  }
}

function appendBoundaryRealization(
  raw: XYPoint[],
  rawSegmentVisits: number[],
  route: Route,
  visitIndex: number,
  currentCorridor: Corridor,
  nextCorridor: Corridor,
  plane: number,
  currentTrack: number,
  nextTrack: number,
  realization: Extract<BoundaryRealization, { readonly kind: 'continue-retrack' }>,
): void {
  let activeTrack = currentTrack;
  let crossedBoundary = false;
  for (const shift of realization.shifts) {
    const hostIsCurrent = shift.hostVisitIndex === visitIndex;
    const hostIsNext = shift.hostVisitIndex === visitIndex + 1;
    if (!hostIsCurrent && !hostIsNext) {
      throw new Error(`route ${route.requestIndex}: continuation ${visitIndex} has a remote host`);
    }
    if (hostIsCurrent && crossedBoundary) {
      throw new Error(`route ${route.requestIndex}: continuation shifts reverse across boundary`);
    }
    const hostCorridor = hostIsCurrent ? currentCorridor : nextCorridor;
    assertHostedShift(
      route,
      visitIndex,
      hostCorridor,
      activeTrack,
      shift.trackAfter,
      shift.shiftCoordinate,
    );
    if (hostIsNext && !crossedBoundary) {
      appendRaw(
        raw,
        rawSegmentVisits,
        axisPoint(currentCorridor.axis, plane, activeTrack),
        visitIndex,
      );
      crossedBoundary = true;
    }
    appendRaw(
      raw,
      rawSegmentVisits,
      axisPoint(currentCorridor.axis, shift.shiftCoordinate, activeTrack),
      shift.hostVisitIndex,
    );
    appendRaw(
      raw,
      rawSegmentVisits,
      axisPoint(currentCorridor.axis, shift.shiftCoordinate, shift.trackAfter),
      shift.hostVisitIndex,
    );
    activeTrack = shift.trackAfter;
  }
  if (!crossedBoundary) {
    appendRaw(
      raw,
      rawSegmentVisits,
      axisPoint(currentCorridor.axis, plane, activeTrack),
      visitIndex,
    );
  }
  if (Math.abs(activeTrack - nextTrack) > EPSILON) {
    throw new Error(`route ${route.requestIndex}: continuation ${visitIndex} ends off track`);
  }
}

function assertHostedShift(
  route: Route,
  visitIndex: number,
  hostCorridor: Corridor,
  fromTrack: number,
  toTrack: number,
  shiftCoordinate: number,
): void {
  const hostCrossStart = hostCorridor.axis === 'x' ? hostCorridor.rect.y : hostCorridor.rect.x;
  const hostCrossEnd =
    hostCrossStart +
    (hostCorridor.axis === 'x' ? hostCorridor.rect.height : hostCorridor.rect.width);
  const hostTravelStart = hostCorridor.axis === 'x' ? hostCorridor.rect.x : hostCorridor.rect.y;
  const hostTravelEnd =
    hostTravelStart +
    (hostCorridor.axis === 'x' ? hostCorridor.rect.width : hostCorridor.rect.height);
  if (
    fromTrack < hostCrossStart - EPSILON ||
    fromTrack > hostCrossEnd + EPSILON ||
    toTrack < hostCrossStart - EPSILON ||
    toTrack > hostCrossEnd + EPSILON ||
    shiftCoordinate < hostTravelStart - EPSILON ||
    shiftCoordinate > hostTravelEnd + EPSILON
  ) {
    throw new Error(`route ${route.requestIndex}: continuation ${visitIndex} escapes its host`);
  }
}

function appendRaw(
  raw: XYPoint[],
  rawSegmentVisits: number[],
  point: XYPoint,
  visitIndex: number,
): void {
  raw.push(point);
  rawSegmentVisits.push(visitIndex);
}

function sharedPortal(world: CorridorWorld, exit: VisitBoundary, entry: VisitBoundary): PortalRef {
  if (
    exit.kind !== 'portal' ||
    entry.kind !== 'portal' ||
    exit.portalIndex !== entry.portalIndex ||
    exit.mode !== entry.mode ||
    (exit.mode !== 'turn' && exit.mode !== 'continue-straight')
  ) {
    throw new Error('route emission: adjacent visits do not share one supported portal');
  }
  const portal = world.indexer.portals[exit.portalIndex];
  if (
    (exit.mode === 'turn' && portal.kind !== 'turn') ||
    (exit.mode === 'continue-straight' && portal.kind !== 'continue')
  ) {
    throw new Error('route emission: boundary mode does not match portal kind');
  }
  return portal;
}

function simplifyEmittedGeometry(
  requestIndex: number,
  points: readonly XYPoint[],
  rawSegmentVisits: readonly number[],
): {
  points: readonly XYPoint[];
  segmentVisitByIndex: Int32Array;
} {
  const result: XYPoint[] = [];
  const segmentVisitByIndex: number[] = [];
  for (let rawSegmentIndex = 0; rawSegmentIndex + 1 < points.length; rawSegmentIndex += 1) {
    const from = points[rawSegmentIndex];
    const to = points[rawSegmentIndex + 1];
    if (samePoint(from, to)) {
      continue;
    }
    if (result.length === 0) {
      result.push(from);
    }
    const previous = result[result.length - 2];
    const current = result[result.length - 1];
    const visitIndex = rawSegmentVisits[rawSegmentIndex];
    const previousVisitIndex = segmentVisitByIndex[segmentVisitByIndex.length - 1];
    if (
      previous &&
      collinear(requestIndex, previous, current, to) &&
      previousVisitIndex === visitIndex
    ) {
      result[result.length - 1] = to;
    } else {
      result.push(to);
      segmentVisitByIndex.push(visitIndex);
    }
  }
  if (result.length < 2) {
    throw new Error('route emission: polyline collapsed below two points');
  }
  return { points: result, segmentVisitByIndex: Int32Array.from(segmentVisitByIndex) };
}

function collinear(requestIndex: number, first: XYPoint, second: XYPoint, third: XYPoint): boolean {
  const vertical = first.x === second.x && second.x === third.x;
  const horizontal = first.y === second.y && second.y === third.y;
  if (!vertical && !horizontal) {
    return false;
  }
  const firstDelta = vertical ? second.y - first.y : second.x - first.x;
  const secondDelta = vertical ? third.y - second.y : third.x - second.x;
  if (firstDelta * secondDelta < 0) {
    throw new Error(
      `route ${requestIndex}: emitted cardinal segment reverses direction ` +
        `${JSON.stringify([first, second, third])}`,
    );
  }
  return true;
}
