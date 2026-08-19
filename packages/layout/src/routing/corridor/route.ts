import type { AxisSpan, XYPoint } from '../../types.js';
import type { EndpointSide } from '../types.js';
import { AUTHORED_PORT_TOLERANCE_PX, type RouteEndpoint } from './contract.js';
import { samePoint } from './geometry.js';

export type VisitBoundary =
  | {
      readonly kind: 'terminal';
      /** World-local index into `CorridorIndexer.attachments`. */
      readonly attachmentIndex: number;
    }
  | {
      readonly kind: 'portal';
      readonly portalIndex: number;
      readonly mode: 'turn' | 'continue-straight';
    };

/** One traversal of one corridor. A route may visit the same corridor more than once. */
export interface CorridorVisit {
  readonly corridorIndex: number;
  readonly entry: VisitBoundary;
  readonly exit: VisitBoundary;
  /** Tracks legal within this visit and its terminal/turn boundaries. */
  readonly feasibleTrack: AxisSpan;
}

interface RoutePorts {
  readonly from: XYPoint;
  readonly to: XYPoint;
}

/** One hosted cross-axis shift, in route-travel order. */
interface BoundaryShiftRealization {
  /** Adjacent visit whose obstacle-free rectangle contains the shift. */
  readonly hostVisitIndex: number;
  /** Coordinate on the host corridor's travel axis where the shift occurs. */
  readonly shiftCoordinate: number;
  /** Track occupied after this shift. */
  readonly trackAfter: number;
}

/** Selected local re-track between adjacent same-axis corridor visits. */
interface ContinueBoundaryRealization {
  readonly kind: 'continue-retrack';
  /** Boundary between visits `afterVisitIndex - 1` and `afterVisitIndex`. */
  readonly afterVisitIndex: number;
  /** The single shift hosted by the containing corridor. */
  readonly shifts: readonly BoundaryShiftRealization[];
}

/** Local re-track that lets an ordered corridor bundle reach a narrower turn mouth. */
interface TurnBoundaryRealization {
  readonly kind: 'turn-retrack';
  /** Boundary between visits `afterVisitIndex - 1` and `afterVisitIndex`. */
  readonly afterVisitIndex: number;
  /** Track used by the preceding corridor at the turn portal. */
  readonly beforePortalTrack: number;
  /** Track used by the following corridor at the turn portal. */
  readonly afterPortalTrack: number;
  /** One hosted shift on either side of the turn, or two when both sides re-track. */
  readonly shifts: readonly BoundaryShiftRealization[];
}

export type BoundaryRealization = ContinueBoundaryRealization | TurnBoundaryRealization;

type RealizationPhase = 'ordering' | 'ordered' | 'spaced' | 'emitted';
type NumericValues = ArrayLike<number> & Iterable<number>;

interface RouteRealization {
  phase: RealizationPhase;
  readonly orderByVisit: Int32Array;
  readonly nominalTrackByVisit: Float64Array;
  boundaryRealizations?: readonly BoundaryRealization[];
  ports?: RoutePorts;
  points?: readonly XYPoint[];
  segmentVisitByIndex?: Int32Array;
}

const PHASE_RANK: Readonly<Record<RealizationPhase, number>> = {
  ordering: 0,
  ordered: 1,
  spaced: 2,
  emitted: 3,
};

/** One route, progressively enhanced from topology through emitted geometry. */
export class Route {
  readonly requestIndex: number;
  readonly from: RouteEndpoint;
  readonly to: RouteEndpoint;
  readonly visits: readonly CorridorVisit[];

  private realization?: RouteRealization;

  constructor(
    requestIndex: number,
    from: RouteEndpoint,
    to: RouteEndpoint,
    visits: readonly CorridorVisit[],
  ) {
    if (!Number.isInteger(requestIndex) || requestIndex < 0) {
      throw new Error(`invalid route request index ${requestIndex}`);
    }
    validateEndpoint(requestIndex, 'from', from);
    validateEndpoint(requestIndex, 'to', to);
    for (let visitIndex = 0; visitIndex < visits.length; visitIndex += 1) {
      validateVisit(requestIndex, visitIndex, visits[visitIndex]);
    }
    this.requestIndex = requestIndex;
    this.from = from;
    this.to = to;
    this.visits = visits;
  }

  hasRealization(): boolean {
    return this.realization !== undefined;
  }

  beginRealization(): void {
    if (this.realization) {
      throw new Error(`route ${this.requestIndex}: realization already active`);
    }
    this.realization = {
      phase: 'ordering',
      orderByVisit: new Int32Array(this.visits.length),
      nominalTrackByVisit: new Float64Array(this.visits.length),
    };
  }

  setOrder(orderByVisit: NumericValues): void {
    const realization = this.expectPhase('ordering', 'setOrder');
    this.expectVisitValues(orderByVisit, 'orders');
    for (const order of orderByVisit) {
      if (!Number.isInteger(order) || order < 0) {
        throw new Error(`route ${this.requestIndex}: invalid order ${order}`);
      }
    }
    realization.orderByVisit.set(orderByVisit);
    realization.phase = 'ordered';
  }

  setNominalTracks(
    nominalTrackByVisit: NumericValues,
    boundaryRealizations: readonly BoundaryRealization[] = [],
  ): void {
    const realization = this.expectPhase('ordered', 'setNominalTracks');
    this.expectVisitValues(nominalTrackByVisit, 'nominal tracks');
    validateBoundaryRealizations(this.requestIndex, this.visits.length, boundaryRealizations);
    for (let visitIndex = 0; visitIndex < nominalTrackByVisit.length; visitIndex += 1) {
      const track = nominalTrackByVisit[visitIndex];
      const [start, end] = this.visits[visitIndex].feasibleTrack;
      const authorizedTurnTrack = boundaryRealizations.some(
        (candidate) =>
          candidate.kind === 'turn-retrack' &&
          candidate.shifts.some((shift) => shift.hostVisitIndex === visitIndex),
      );
      if (!Number.isFinite(track) || (!authorizedTurnTrack && (track < start || track > end))) {
        throw new Error(
          `route ${this.requestIndex}: track ${track} outside visit ${visitIndex} span ` +
            `[${start}, ${end}]`,
        );
      }
    }
    realization.nominalTrackByVisit.set(nominalTrackByVisit);
    realization.boundaryRealizations = boundaryRealizations;
    realization.phase = 'spaced';
  }

  setGeometry(
    ports: RoutePorts,
    points: readonly XYPoint[],
    segmentVisitByIndex: NumericValues,
  ): void {
    const realization = this.expectPhase('spaced', 'setGeometry');
    validateGeometry(this.requestIndex, this.from, this.to, ports, points);
    validateSegmentProvenance(
      this.requestIndex,
      this.visits.length,
      points.length,
      segmentVisitByIndex,
    );
    realization.ports = ports;
    realization.points = points;
    realization.segmentVisitByIndex = Int32Array.from(segmentVisitByIndex);
    realization.phase = 'emitted';
  }

  assertOrdered(): void {
    this.expectAtLeast('ordered', 'assertOrdered');
  }

  assertSpaced(): void {
    this.expectAtLeast('spaced', 'assertSpaced');
  }

  assertEmitted(): void {
    this.expectAtLeast('emitted', 'assertEmitted');
  }

  orderOf(visitIndex: number): number {
    const realization = this.expectAtLeast('ordered', 'orderOf');
    return realization.orderByVisit[this.expectVisitIndex(visitIndex)];
  }

  nominalTrackOf(visitIndex: number): number {
    const realization = this.expectAtLeast('spaced', 'nominalTrackOf');
    return realization.nominalTrackByVisit[this.expectVisitIndex(visitIndex)];
  }

  boundaryRealizationAfter(afterVisitIndex: number): BoundaryRealization | undefined {
    const realization = this.expectAtLeast('spaced', 'boundaryRealizationAfter');
    if (
      !Number.isInteger(afterVisitIndex) ||
      afterVisitIndex <= 0 ||
      afterVisitIndex >= this.visits.length
    ) {
      throw new Error(
        `route ${this.requestIndex}: boundary after visit ${afterVisitIndex} out of range`,
      );
    }
    return realization.boundaryRealizations?.find(
      (candidate) => candidate.afterVisitIndex === afterVisitIndex,
    );
  }

  ports(): RoutePorts {
    const realization = this.expectAtLeast('emitted', 'ports');
    return realization.ports as RoutePorts;
  }

  points(): readonly XYPoint[] {
    const realization = this.expectAtLeast('emitted', 'points');
    return realization.points as readonly XYPoint[];
  }

  segmentVisitOf(segmentIndex: number): number {
    const realization = this.expectAtLeast('emitted', 'segmentVisitOf');
    const segmentCount = (realization.points as readonly XYPoint[]).length - 1;
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= segmentCount) {
      throw new Error(`route ${this.requestIndex}: segment ${segmentIndex} out of range`);
    }
    return (realization.segmentVisitByIndex as Int32Array)[segmentIndex];
  }

  private expectVisitValues(values: ArrayLike<number>, name: string): void {
    if (values.length !== this.visits.length) {
      throw new Error(
        `route ${this.requestIndex}: ${values.length} ${name} for ${this.visits.length} visits`,
      );
    }
  }

  private expectVisitIndex(visitIndex: number): number {
    if (!Number.isInteger(visitIndex) || visitIndex < 0 || visitIndex >= this.visits.length) {
      throw new Error(`route ${this.requestIndex}: visit ${visitIndex} out of range`);
    }
    return visitIndex;
  }

  private expectPhase(phase: RealizationPhase, caller: string): RouteRealization {
    const realization = this.realization;
    if (!realization) {
      throw new Error(`route ${this.requestIndex}: ${caller} requires an active realization`);
    }
    if (realization.phase !== phase) {
      throw new Error(
        `route ${this.requestIndex}: ${caller} requires phase '${phase}', at ` +
          `'${realization.phase}'`,
      );
    }
    return realization;
  }

  private expectAtLeast(phase: RealizationPhase, caller: string): RouteRealization {
    const realization = this.realization;
    if (!realization) {
      throw new Error(`route ${this.requestIndex}: ${caller} requires an active realization`);
    }
    if (PHASE_RANK[realization.phase] < PHASE_RANK[phase]) {
      throw new Error(
        `route ${this.requestIndex}: ${caller} requires phase >= '${phase}', at ` +
          `'${realization.phase}'`,
      );
    }
    return realization;
  }
}

function validateVisit(requestIndex: number, visitIndex: number, visit: CorridorVisit): void {
  if (!Number.isInteger(visit.corridorIndex) || visit.corridorIndex < 0) {
    throw new Error(`route ${requestIndex}: invalid corridor for visit ${visitIndex}`);
  }
  const [start, end] = visit.feasibleTrack;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error(`route ${requestIndex}: invalid feasible track for visit ${visitIndex}`);
  }
  validateBoundary(requestIndex, visitIndex, 'entry', visit.entry);
  validateBoundary(requestIndex, visitIndex, 'exit', visit.exit);
}

/** Topology-only clone; optional `requestIndex` remaps the batch slot. */
export function cloneRoute(route: Route, requestIndex: number = route.requestIndex): Route {
  return new Route(requestIndex, route.from, route.to, route.visits);
}

function validateEndpoint(requestIndex: number, side: EndpointSide, endpoint: RouteEndpoint): void {
  if (!Number.isInteger(endpoint.entityIndex) || endpoint.entityIndex < 0) {
    throw new Error(`route ${requestIndex}: invalid ${side} entity index`);
  }
  if (endpoint.authoredTrack !== undefined && !Number.isFinite(endpoint.authoredTrack)) {
    throw new Error(`route ${requestIndex}: invalid ${side} authored track`);
  }
  if (
    endpoint.portGroup !== undefined &&
    (!Number.isInteger(endpoint.portGroup) || endpoint.portGroup < 0)
  ) {
    throw new Error(`route ${requestIndex}: invalid ${side} port group`);
  }
}

function validateBoundary(
  requestIndex: number,
  visitIndex: number,
  side: 'entry' | 'exit',
  boundary: VisitBoundary,
): void {
  const index = boundary.kind === 'terminal' ? boundary.attachmentIndex : boundary.portalIndex;
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`route ${requestIndex}: invalid ${side} boundary for visit ${visitIndex}`);
  }
}

function validateGeometry(
  requestIndex: number,
  from: RouteEndpoint,
  to: RouteEndpoint,
  ports: RoutePorts,
  points: readonly XYPoint[],
): void {
  if (points.length < 2) {
    throw new Error(`route ${requestIndex}: emitted polyline needs at least 2 points`);
  }
  if (!samePoint(points[0], ports.from) || !samePoint(points[points.length - 1], ports.to)) {
    throw new Error(`route ${requestIndex}: emitted endpoints do not match ports`);
  }
  const authoredX = authoredTracksOnAxis(from, to, 'x');
  const authoredY = authoredTracksOnAxis(from, to, 'y');
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    const terminal = pointIndex === 0 || pointIndex === points.length - 1;
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      (!terminal &&
        (!quantizedOrAuthored(point.x, authoredX) || !quantizedOrAuthored(point.y, authoredY)))
    ) {
      throw new Error(`route ${requestIndex}: emitted point ${pointIndex} is not quantized`);
    }
    if (pointIndex === 0) {
      continue;
    }
    const previous = points[pointIndex - 1];
    if (samePoint(previous, point)) {
      throw new Error(`route ${requestIndex}: duplicate emitted point ${pointIndex}`);
    }
    if (previous.x !== point.x && previous.y !== point.y) {
      throw new Error(`route ${requestIndex}: diagonal emitted segment ${pointIndex - 1}`);
    }
  }
}

function validateBoundaryRealizations(
  requestIndex: number,
  visitCount: number,
  realizations: readonly BoundaryRealization[],
): void {
  let previousAfterVisitIndex = 0;
  for (const realization of realizations) {
    if (
      !Number.isInteger(realization.afterVisitIndex) ||
      realization.afterVisitIndex <= previousAfterVisitIndex ||
      realization.afterVisitIndex >= visitCount
    ) {
      throw new Error(
        `route ${requestIndex}: invalid boundary realization ${realization.afterVisitIndex}`,
      );
    }
    if (realization.kind === 'turn-retrack') {
      if (
        !Number.isFinite(realization.beforePortalTrack) ||
        !Number.isFinite(realization.afterPortalTrack) ||
        realization.shifts.length < 1 ||
        realization.shifts.length > 2 ||
        realization.shifts.some(
          (shift) =>
            (shift.hostVisitIndex !== realization.afterVisitIndex - 1 &&
              shift.hostVisitIndex !== realization.afterVisitIndex) ||
            !Number.isFinite(shift.shiftCoordinate) ||
            !Number.isFinite(shift.trackAfter),
        )
      ) {
        throw new Error(
          `route ${requestIndex}: boundary ${realization.afterVisitIndex} has invalid turn re-track`,
        );
      }
      previousAfterVisitIndex = realization.afterVisitIndex;
      continue;
    }
    if (realization.shifts.length !== 1) {
      throw new Error(`route ${requestIndex}: boundary has invalid shift count`);
    }
    for (const shift of realization.shifts) {
      if (
        shift.hostVisitIndex !== realization.afterVisitIndex - 1 &&
        shift.hostVisitIndex !== realization.afterVisitIndex
      ) {
        throw new Error(
          `route ${requestIndex}: boundary ${realization.afterVisitIndex} has invalid host visit`,
        );
      }
      if (!Number.isFinite(shift.shiftCoordinate) || !Number.isFinite(shift.trackAfter)) {
        throw new Error(
          `route ${requestIndex}: boundary ${realization.afterVisitIndex} has invalid shift`,
        );
      }
    }
    previousAfterVisitIndex = realization.afterVisitIndex;
  }
}

function validateSegmentProvenance(
  requestIndex: number,
  visitCount: number,
  pointCount: number,
  segmentVisitByIndex: ArrayLike<number>,
): void {
  const segmentCount = pointCount - 1;
  if (segmentVisitByIndex.length !== segmentCount) {
    throw new Error(
      `route ${requestIndex}: ${segmentVisitByIndex.length} segment visits for ` +
        `${segmentCount} emitted segments`,
    );
  }
  for (let segmentIndex = 0; segmentIndex < segmentVisitByIndex.length; segmentIndex += 1) {
    const visitIndex = segmentVisitByIndex[segmentIndex];
    if (!Number.isInteger(visitIndex) || visitIndex < 0 || visitIndex >= visitCount) {
      throw new Error(
        `route ${requestIndex}: invalid visit ${visitIndex} for segment ${segmentIndex}`,
      );
    }
  }
}

function authoredTracksOnAxis(from: RouteEndpoint, to: RouteEndpoint, axis: 'x' | 'y'): number[] {
  const result: number[] = [];
  for (const endpoint of [from, to]) {
    const trackAxis = endpoint.face === 'left' || endpoint.face === 'right' ? 'y' : 'x';
    if (trackAxis === axis && endpoint.authoredTrack !== undefined) {
      result.push(endpoint.authoredTrack);
    }
  }
  return result;
}

function quantizedOrAuthored(value: number, authoredTracks: readonly number[]): boolean {
  return (
    Number.isInteger(value) ||
    authoredTracks.some(
      (authoredTrack) => Math.abs(value - authoredTrack) <= AUTHORED_PORT_TOLERANCE_PX,
    )
  );
}
