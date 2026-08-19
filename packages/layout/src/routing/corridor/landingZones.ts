import {
  intersectPositiveSpans,
  spanContains,
  spanLength,
  spanOverlapLength,
  spansEqual,
} from '../../rangeUtils.js';
import type { Axis, AxisSpan, Direction, LayoutEntity, PositionProps } from '../../types.js';
import { touchExternalTextRangeToEntityClippedToBodyFace } from '../textPlacements.js';
import { OPPOSITE_DIRECTION } from '../../directionUtils.js';
import type { RouteSearchRequest } from './contract.js';
import { certifiedRunFrom, type FreeSpaceSubstrate } from './freeSpaceSubstrate.js';
import {
  expandRect,
  faceCrossSpan,
  faceNormalAxis,
  faceOrder,
  outwardSign,
  rectsOverlap,
  terminalFacePlane,
  crossSpanOf,
} from './geometry.js';

/**
 * Deterministic floor recipe shared with the spacing solver's integer track
 * quantization: half-gap splits land exactly on k + 0.5, and floor(value + EPSILON)
 * commits them to the whole-pixel grid the same way everywhere.
 */
const FLOOR_EPSILON = 1e-6;

const LANDING_ZONE_MIN_DEPTH_PX = 24;
const LANDING_ZONE_MULTI_FACE_DEPTH_PX = 40;
const LANDING_ZONE_PREFERRED_DEPTH_PX = 100;
const LANDING_ZONE_OVERLAP_SHARE = 0.85;
const LANDING_ZONE_JOIN_CLEARANCE_PX = 8;

/** A runway claimed for a terminal face that cannot reuse the free-space substrate. */
export type LandingZoneRect = PositionProps & { readonly axis: Axis };

interface UsedFace {
  readonly entityIndex: number;
  readonly face: Direction;
  readonly plane: number;
  readonly crossSpan: AxisSpan;
  readonly sign: -1 | 1;
  readonly authoredTracks: readonly number[];
  readonly requestCount: number;
}

export function planLandingZones(
  bounds: PositionProps,
  entities: readonly LayoutEntity[],
  requests: readonly RouteSearchRequest[],
  freeSpace: FreeSpaceSubstrate,
): readonly LandingZoneRect[] {
  const faces = usedFaces(entities, requests);
  const nearest = faces.map((face, index) => nearestOpposingFace(faces, face, index));
  const handled = new Uint8Array(faces.length);
  const zoneRects: LandingZoneRect[] = [];

  for (let index = 0; index < faces.length; index += 1) {
    if (faceHasCertifiedOutwardRun(faces[index], freeSpace)) {
      handled[index] = 1;
    }
  }

  for (let index = 0; index < faces.length; index += 1) {
    if (handled[index]) {
      continue;
    }
    const face = faces[index];
    const oppositeIndex = nearest[index];
    if (
      oppositeIndex !== undefined &&
      !handled[oppositeIndex] &&
      nearest[oppositeIndex] === index
    ) {
      const opposite = faces[oppositeIndex];
      handled[index] = 1;
      handled[oppositeIndex] = 1;
      const shared = sharedZone(face, opposite, entities);
      if (shared) {
        zoneRects.push({ ...shared, axis: faceNormalAxis(face.face) });
        continue;
      }
      const gap = Math.abs(opposite.plane - face.plane);
      if (gap > LANDING_ZONE_MIN_DEPTH_PX * 2 && nestedFaceSpan(face, opposite, entities)) {
        // Let the narrower face consume slack left by a shallow wider-face zone. The later
        // profile subtraction turns any overlap into two touching containment continuations.
        const [outer, inner] = spanContains(face.crossSpan, opposite.crossSpan, 0)
          ? [face, opposite]
          : [opposite, face];
        addIndividualZone(zoneRects, outer, bounds, entities, preferredDepthForFace(outer));
        addIndividualZone(zoneRects, inner, bounds, entities, preferredDepthForFace(inner));
        continue;
      }
      addIndividualZone(
        zoneRects,
        face,
        bounds,
        entities,
        Math.min(preferredDepthForFace(face), gap / 2),
      );
      addIndividualZone(
        zoneRects,
        opposite,
        bounds,
        entities,
        Math.min(preferredDepthForFace(opposite), gap / 2),
      );
      continue;
    }
    handled[index] = 1;
    addIndividualZone(zoneRects, face, bounds, entities, preferredDepthForFace(face));
  }

  return zoneRects;
}

function nestedFaceSpan(
  first: UsedFace,
  second: UsedFace,
  entities: readonly LayoutEntity[],
): boolean {
  if (spansEqual(first.crossSpan, second.crossSpan, 0)) {
    return false;
  }
  const inner = spanContains(first.crossSpan, second.crossSpan, 0)
    ? second.crossSpan
    : spanContains(second.crossSpan, first.crossSpan, 0)
      ? first.crossSpan
      : undefined;
  if (
    inner === undefined ||
    ![...first.authoredTracks, ...second.authoredTracks].every(
      (track) => track >= inner[0] && track <= inner[1],
    )
  ) {
    return false;
  }
  const bridge = normalRect(first, Math.abs(second.plane - first.plane), inner);
  return leafClear(
    expandRect(bridge, LANDING_ZONE_JOIN_CLEARANCE_PX),
    entities,
    first.entityIndex,
    second.entityIndex,
  );
}

/**
 * A face needs no landing-zone claim when certified free space already runs outward from
 * its plane by at least the preferred depth over a band containing the face - the
 * constructed corridors will host its approach without help.
 */
function faceHasCertifiedOutwardRun(face: UsedFace, freeSpace: FreeSpaceSubstrate): boolean {
  const lane = freeSpace[faceNormalAxis(face.face)];
  const target = face.plane + face.sign * LANDING_ZONE_PREFERRED_DEPTH_PX;
  const reached = certifiedRunFrom(lane, face.plane, face.crossSpan, face.sign, target);
  return face.sign > 0 ? reached >= target : reached <= target;
}

function preferredDepthForFace(face: UsedFace): number {
  return face.requestCount === 1
    ? LANDING_ZONE_PREFERRED_DEPTH_PX
    : LANDING_ZONE_MULTI_FACE_DEPTH_PX;
}

function usedFaces(
  entities: readonly LayoutEntity[],
  requests: readonly RouteSearchRequest[],
): UsedFace[] {
  const byKey = new Map<
    string,
    {
      entityIndex: number;
      face: Direction;
      authored: number[];
      requestCount: number;
    }
  >();
  for (const request of requests) {
    for (const endpoint of [request.from, request.to]) {
      const key = `${endpoint.entityIndex}:${faceOrder(endpoint.face)}`;
      const existing = byKey.get(key) ?? {
        entityIndex: endpoint.entityIndex,
        face: endpoint.face,
        authored: [],
        requestCount: 0,
      };
      existing.requestCount += 1;
      if (endpoint.authoredTrack !== undefined) {
        existing.authored.push(endpoint.authoredTrack);
      }
      byKey.set(key, existing);
    }
  }
  return [...byKey.values()]
    .sort(
      (left, right) =>
        left.entityIndex - right.entityIndex || faceOrder(left.face) - faceOrder(right.face),
    )
    .map(({ entityIndex, face, authored, requestCount }) => ({
      entityIndex,
      face,
      plane: terminalFacePlane(entities[entityIndex], face),
      crossSpan: faceCrossSpan(entities[entityIndex], face),
      sign: outwardSign(face),
      authoredTracks: [...new Set(authored)].sort((left, right) => left - right),
      requestCount,
    }));
}

function nearestOpposingFace(
  faces: readonly UsedFace[],
  source: UsedFace,
  sourceIndex: number,
): number | undefined {
  let best: number | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let index = 0; index < faces.length; index += 1) {
    const candidate = faces[index];
    const gap = source.sign * (candidate.plane - source.plane);
    if (
      index === sourceIndex ||
      candidate.face !== OPPOSITE_DIRECTION[source.face] ||
      gap <= 0 ||
      spanOverlapLength(source.crossSpan, candidate.crossSpan) <= 0
    ) {
      continue;
    }
    if (gap < bestGap || (gap === bestGap && index < (best ?? index))) {
      best = index;
      bestGap = gap;
    }
  }
  return best;
}

function sharedZone(
  first: UsedFace,
  second: UsedFace,
  entities: readonly LayoutEntity[],
): PositionProps | undefined {
  const overlap = intersectPositiveSpans(first.crossSpan, second.crossSpan, 0);
  if (!overlap) {
    return undefined;
  }
  const unionScale = Math.max(spanLength(first.crossSpan), spanLength(second.crossSpan));
  if (
    spanLength(overlap) / unionScale < LANDING_ZONE_OVERLAP_SHARE ||
    ![...first.authoredTracks, ...second.authoredTracks].every(
      (track) => track >= overlap[0] && track <= overlap[1],
    )
  ) {
    return undefined;
  }
  const rect = normalRect(first, Math.abs(second.plane - first.plane), overlap);
  if (!leafClear(rect, entities, first.entityIndex, second.entityIndex)) {
    return undefined;
  }
  return rect;
}

function addIndividualZone(
  zoneRects: LandingZoneRect[],
  face: UsedFace,
  bounds: PositionProps,
  entities: readonly LayoutEntity[],
  requestedDepth: number,
): void {
  const clearDepth = maximumClearDepth(face, bounds, entities);
  const depth = Math.floor(Math.min(requestedDepth, clearDepth) + FLOOR_EPSILON);
  if (depth > 0) {
    zoneRects.push({
      ...normalRect(face, depth, face.crossSpan),
      axis: faceNormalAxis(face.face),
    });
  }
}

function maximumClearDepth(
  face: UsedFace,
  bounds: PositionProps,
  entities: readonly LayoutEntity[],
): number {
  const normalAxis = faceNormalAxis(face.face);
  const boundStart = normalAxis === 'x' ? bounds.x : bounds.y;
  const boundEnd = boundStart + (normalAxis === 'x' ? bounds.width : bounds.height);
  let result = face.sign > 0 ? boundEnd - face.plane : face.plane - boundStart;

  for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
    const entity = entities[entityIndex];
    if (entityIndex === face.entityIndex || entity.isContainer === true) {
      continue;
    }

    result = determineLesserDistance(face, normalAxis, entity, result);
    const text = touchExternalTextRangeToEntityClippedToBodyFace(entity);
    if (text) {
      result = determineLesserDistance(face, normalAxis, text, result);
    }

    if (result <= 0) {
      break;
    }
  }
  return Math.max(0, result);
}

function determineLesserDistance(
  face: UsedFace,
  normalAxis: Axis,
  obstacle: PositionProps,
  currentDistance: number,
): number {
  const obstacleCross = crossSpanOf(normalAxis, obstacle);
  if (spanOverlapLength(face.crossSpan, obstacleCross) <= 0) {
    return currentDistance;
  }
  const start = normalAxis === 'x' ? obstacle.x : obstacle.y;
  const end = start + (normalAxis === 'x' ? obstacle.width : obstacle.height);
  const distance =
    face.sign > 0
      ? start >= face.plane
        ? start - face.plane
        : end > face.plane
          ? 0
          : Number.POSITIVE_INFINITY
      : end <= face.plane
        ? face.plane - end
        : start < face.plane
          ? 0
          : Number.POSITIVE_INFINITY;
  return Math.min(currentDistance, distance);
}

function normalRect(face: UsedFace, depth: number, crossSpan: AxisSpan): PositionProps {
  const start = face.sign > 0 ? face.plane : face.plane - depth;
  return faceNormalAxis(face.face) === 'x'
    ? { x: start, y: crossSpan[0], width: depth, height: spanLength(crossSpan) }
    : { x: crossSpan[0], y: start, width: spanLength(crossSpan), height: depth };
}

function leafClear(
  rect: PositionProps,
  entities: readonly LayoutEntity[],
  firstEntityIndex: number,
  secondEntityIndex?: number,
): boolean {
  return entities.every((entity, index) => {
    if (index === firstEntityIndex || index === secondEntityIndex || entity.isContainer === true) {
      return true;
    }
    const text = touchExternalTextRangeToEntityClippedToBodyFace(entity);
    return !rectsOverlap(rect, entity) && (!text || !rectsOverlap(rect, text));
  });
}
