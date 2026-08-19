import { axisOrthMin, axisStart, coordinateInSpan } from '../../rangeUtils.js';
import type { Axis, AxisSpan, XYPoint } from '../../types.js';
import { axisPoint, orderedSpan, ROUTING_EPSILON as EPSILON, segmentAxis } from './geometry.js';

const MAX_L_RESIDUAL_PX = 8;

export interface RunDisplacement {
  readonly kind: 'straight' | 'shift' | 'u' | 'l-from' | 'l-to';
  readonly baseTrack: number;
  readonly displacedTrack: number;
}

interface RunDisplacementResult {
  readonly displacement: RunDisplacement;
  readonly points: readonly XYPoint[];
}

interface RunDisplacementRequest {
  readonly points: readonly XYPoint[];
  readonly segmentIndex: number;
  readonly labelWindow: AxisSpan;
  readonly displacedTrack: number;
  readonly jogMargin: number;
  /** L absorption is attempted before a two-jog U when an adjacent bend already spans the track. */
  readonly allowLAbsorption?: boolean;
  /** Move the complete run when both neighboring legs can absorb the new track without reversing. */
  readonly allowFullShift?: boolean;
}

/**
 * Realize one span-local track change without changing topology. Callers retain ownership of
 * candidate selection and batch certification.
 */
export function realizeRunDisplacement(
  request: RunDisplacementRequest,
): RunDisplacementResult | undefined {
  const { points, segmentIndex } = request;
  if (segmentIndex < 0 || segmentIndex + 1 >= points.length) {
    throw new Error(`run displacement: invalid segment ${segmentIndex}`);
  }
  const from = points[segmentIndex];
  const to = points[segmentIndex + 1];
  const axis = segmentAxis(from, to);
  if (!axis) {
    return undefined;
  }
  const baseTrack = axisOrthMin(from, axis);
  if (Math.abs(baseTrack - axisOrthMin(to, axis)) > EPSILON) {
    return undefined;
  }
  if (Math.abs(baseTrack - request.displacedTrack) <= EPSILON) {
    return {
      displacement: {
        kind: 'straight',
        baseTrack,
        displacedTrack: baseTrack,
      },
      points,
    };
  }

  const startTravel = axisStart(from, axis);
  const endTravel = axisStart(to, axis);
  const direction = endTravel >= startTravel ? 1 : -1;
  const length = Math.abs(endTravel - startTravel);
  const window = orderedSpan(request.labelWindow[0], request.labelWindow[1]);
  const windowStart = direction * (window[0] - startTravel);
  const windowEnd = direction * (window[1] - startTravel);
  const windowAlong = orderedSpan(windowStart, windowEnd);
  if (windowAlong[0] < -EPSILON || windowAlong[1] > length + EPSILON) {
    return undefined;
  }
  const displacedStart = Math.max(0, Math.floor(windowAlong[0] - request.jogMargin));
  const displacedEnd = Math.min(length, Math.ceil(windowAlong[1] + request.jogMargin));
  if (displacedEnd - displacedStart <= EPSILON) {
    return undefined;
  }

  const modes: Array<'shift' | 'l-from' | 'l-to' | 'u'> = [];
  if (request.allowLAbsorption !== false) {
    const lCandidates: Array<{ mode: 'l-from' | 'l-to'; extension: number }> = [];
    if (
      displacedEnd < length - EPSILON &&
      canAbsorbAtFrom(points, segmentIndex, axis, request.displacedTrack)
    ) {
      lCandidates.push({ mode: 'l-from', extension: displacedStart });
    }
    if (
      displacedStart > EPSILON &&
      canAbsorbAtTo(points, segmentIndex, axis, request.displacedTrack)
    ) {
      lCandidates.push({ mode: 'l-to', extension: length - displacedEnd });
    }
    lCandidates.sort(
      (left, right) => left.extension - right.extension || left.mode.localeCompare(right.mode),
    );
    const previousTrack =
      segmentIndex > 0 ? axisOrthMin(points[segmentIndex - 1], axis) : undefined;
    const nextTrack =
      segmentIndex + 2 < points.length ? axisOrthMin(points[segmentIndex + 2], axis) : undefined;
    if (
      request.allowFullShift === true &&
      ((displacedStart <= MAX_L_RESIDUAL_PX &&
        canAbsorbAtTo(points, segmentIndex, axis, request.displacedTrack) &&
        previousTrack !== undefined &&
        preservesDirection(previousTrack, baseTrack, request.displacedTrack)) ||
        (length - displacedEnd <= MAX_L_RESIDUAL_PX &&
          canAbsorbAtFrom(points, segmentIndex, axis, request.displacedTrack) &&
          nextTrack !== undefined &&
          preservesDirection(nextTrack, baseTrack, request.displacedTrack)))
    ) {
      modes.push('shift');
    }
    modes.push(...lCandidates.map((candidate) => candidate.mode));
  }
  if (displacedStart > EPSILON && displacedEnd < length - EPSILON) {
    modes.push('u');
  }

  for (const mode of modes) {
    const pieceBounds: AxisSpan =
      mode === 'shift'
        ? [0, length]
        : mode === 'l-from'
          ? [0, displacedEnd]
          : mode === 'l-to'
            ? [displacedStart, length]
            : [displacedStart, displacedEnd];
    const local = localGeometry(
      axis,
      startTravel,
      direction,
      length,
      baseTrack,
      request.displacedTrack,
      pieceBounds,
      mode,
    );
    const realized = splicePoints(points, segmentIndex, local);
    return {
      displacement: {
        kind: mode,
        baseTrack,
        displacedTrack: request.displacedTrack,
      },
      points: realized,
    };
  }
  return undefined;
}

function localGeometry(
  axis: Axis,
  startTravel: number,
  direction: 1 | -1,
  length: number,
  baseTrack: number,
  displacedTrack: number,
  pieceBounds: AxisSpan,
  mode: 'shift' | 'u' | 'l-from' | 'l-to',
): XYPoint[] {
  const point = (along: number, track: number): XYPoint =>
    pointOnRun(axis, startTravel, direction, along, track);
  if (mode === 'shift') {
    return [point(0, displacedTrack), point(length, displacedTrack)];
  }
  if (mode === 'l-from') {
    return [
      point(0, displacedTrack),
      point(pieceBounds[1], displacedTrack),
      point(pieceBounds[1], baseTrack),
      point(length, baseTrack),
    ];
  }
  if (mode === 'l-to') {
    return [
      point(0, baseTrack),
      point(pieceBounds[0], baseTrack),
      point(pieceBounds[0], displacedTrack),
      point(length, displacedTrack),
    ];
  }
  return [
    point(0, baseTrack),
    point(pieceBounds[0], baseTrack),
    point(pieceBounds[0], displacedTrack),
    point(pieceBounds[1], displacedTrack),
    point(pieceBounds[1], baseTrack),
    point(length, baseTrack),
  ];
}

function pointOnRun(
  axis: Axis,
  startTravel: number,
  direction: 1 | -1,
  along: number,
  track: number,
): XYPoint {
  return axisPoint(axis, startTravel + direction * along, track);
}

function preservesDirection(
  endpointTrack: number,
  baseTrack: number,
  displacedTrack: number,
): boolean {
  const original = baseTrack - endpointTrack;
  const shifted = displacedTrack - endpointTrack;
  return Math.abs(shifted) > EPSILON && original * shifted > 0;
}

function splicePoints(
  points: readonly XYPoint[],
  segmentIndex: number,
  local: readonly XYPoint[],
): readonly XYPoint[] {
  return [...points.slice(0, segmentIndex), ...local, ...points.slice(segmentIndex + 2)];
}

function canAbsorbAtFrom(
  points: readonly XYPoint[],
  segmentIndex: number,
  axis: Axis,
  track: number,
): boolean {
  if (segmentIndex === 0) {
    return false;
  }
  const previous = points[segmentIndex - 1];
  const corner = points[segmentIndex];
  return (
    segmentAxis(previous, corner) !== axis &&
    coordinateInSpan(
      track,
      orderedSpan(axisOrthMin(previous, axis), axisOrthMin(corner, axis)),
      EPSILON,
    )
  );
}

function canAbsorbAtTo(
  points: readonly XYPoint[],
  segmentIndex: number,
  axis: Axis,
  track: number,
): boolean {
  if (segmentIndex + 2 >= points.length) {
    return false;
  }
  const corner = points[segmentIndex + 1];
  const next = points[segmentIndex + 2];
  return (
    segmentAxis(corner, next) !== axis &&
    coordinateInSpan(
      track,
      orderedSpan(axisOrthMin(corner, axis), axisOrthMin(next, axis)),
      EPSILON,
    )
  );
}
