import type { Axis, AxisSpan, Direction, LayoutEntity, PositionProps } from '../../types.js';
import type { LayoutManager } from '../../LayoutManager.js';
import {
  addBufferToRange,
  coordinateInSpan,
  intersectPositiveSpans,
  makePropsFromRange,
} from '../../rangeUtils.js';
import type {
  Corridor,
  RouteEndpoint,
  RouteSearchRequest,
  TerminalAttachment,
} from './contract.js';
import type { CorridorIndexer } from './corridorIndex.js';
import { buildFreeSpaceSubstrate } from './freeSpaceSubstrate.js';
import {
  corridorCrossSpan,
  corridorTravelSpan,
  faceCrossSpan,
  faceNormalAxis,
  faceOrder,
  facePlane,
  terminalFacePlane,
} from './geometry.js';

const ROOT_BOUNDS_MARGIN_PX = 20;

export const PORTAL_SEARCH_TIER_PREFERRED = 0;
export const PORTAL_SEARCH_TIER_ESCAPE = 1;
export type PortalSearchTier =
  typeof PORTAL_SEARCH_TIER_PREFERRED | typeof PORTAL_SEARCH_TIER_ESCAPE;

const ORDERED_FACES: readonly Direction[] = ['up', 'right', 'down', 'left'];

export interface CorridorWorld {
  readonly bounds: PositionProps;
  /** Routing's whole-pixel view of the scene; every world coordinate matches these. */
  readonly entities: readonly LayoutEntity[];
  /**
   * Caller-supplied geometry before grid snapping; terminal emission re-anchors
   * endpoints to these true faces. When absent, `entities` is authoritative.
   */
  readonly sourceEntities?: readonly LayoutEntity[];
  readonly indexer: CorridorIndexer;
  /** Batch cardinality by entity face; absent entries have zero routed terminals. */
  readonly terminalFaceRouteCounts?: Uint16Array;
  /** Preferred/escape provenance for final corridors; escape corridors remain certified. */
  readonly corridorSearchTiers?: Uint8Array;
  /** Immutable topology price for entering a corridor, independent of repair-local prices. */
  readonly corridorEntryCosts?: Float64Array;
  /** Search policy only. Every portal remains present for geometry and downstream consumers. */
  readonly portalSearchTiers?: Uint8Array;
}

export function terminalFaceRouteCount(world: CorridorWorld, endpoint: RouteEndpoint): number {
  return (
    world.terminalFaceRouteCounts?.[
      endpoint.entityIndex * ORDERED_FACES.length + faceOrder(endpoint.face)
    ] ?? 0
  );
}

export function prefersSingletonContainerCenter(
  world: CorridorWorld,
  endpoint: RouteEndpoint,
  opposite: RouteEndpoint,
): boolean {
  const entity = world.entities[endpoint.entityIndex];
  if (entity.isContainer !== true || terminalFaceRouteCount(world, endpoint) !== 1) {
    return false;
  }
  if (faceNormalAxis(endpoint.face) !== faceNormalAxis(opposite.face)) {
    return true;
  }
  return (
    facePlane(entity, endpoint.face) !==
    facePlane(world.entities[opposite.entityIndex], opposite.face)
  );
}

export function buildTerminalFaceRouteCounts(
  entityCount: number,
  requests: readonly RouteSearchRequest[],
): Uint16Array {
  const counts = new Uint16Array(entityCount * ORDERED_FACES.length);
  for (const request of requests) {
    for (const endpoint of [request.from, request.to]) {
      counts[endpoint.entityIndex * ORDERED_FACES.length + faceOrder(endpoint.face)] += 1;
    }
  }
  return counts;
}

export function buildBaseCorridorGeometry(layoutManager: LayoutManager) {
  const entities = layoutManager.getEntities();
  const bounds = makePropsFromRange(
    addBufferToRange(layoutManager.getDims(), ROOT_BOUNDS_MARGIN_PX),
  );
  return { bounds, freeSpace: buildFreeSpaceSubstrate(bounds, entities) };
}

export function buildTerminalAttachments(
  entities: readonly LayoutEntity[],
  corridors: readonly Corridor[],
  requests: readonly RouteSearchRequest[],
): TerminalAttachment[] {
  const requestedFaces = new Uint8Array(entities.length * ORDERED_FACES.length);
  for (const request of requests) {
    for (const endpoint of [request.from, request.to]) {
      requestedFaces[endpoint.entityIndex * ORDERED_FACES.length + faceOrder(endpoint.face)] = 1;
    }
  }
  const indexByAxis = {
    x: buildCorridorStabbingIndex(corridors, 'x'),
    y: buildCorridorStabbingIndex(corridors, 'y'),
  };
  const attachments: TerminalAttachment[] = [];
  for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
    for (let faceIndex = 0; faceIndex < ORDERED_FACES.length; faceIndex += 1) {
      if (requestedFaces[entityIndex * ORDERED_FACES.length + faceIndex] === 0) {
        continue;
      }
      const face = ORDERED_FACES[faceIndex];
      const entity = entities[entityIndex];
      const plane = terminalFacePlane(entity, face);
      const faceSpan = faceCrossSpan(entity, face);
      const axis = faceNormalAxis(face);
      for (const position of collectStabbedCorridorPositions(indexByAxis[axis], plane)) {
        const corridor = corridors[position];
        const travelSpan = corridorTravelSpan(corridor);
        if (!coordinateInSpan(plane, travelSpan, 0) || !extendsOutward(travelSpan, plane, face)) {
          continue;
        }
        const sharedSpan = intersectPositiveSpans(faceSpan, corridorCrossSpan(corridor), 0);
        if (sharedSpan) {
          attachments.push({
            index: attachments.length,
            entityIndex,
            face,
            corridorIndex: corridor.index,
            faceSpan: sharedSpan,
          });
        }
      }
    }
  }
  return attachments;
}

/**
 * Superset margin for the stabbing index: candidate collection uses `plane ± SLACK`
 * bounds, and every candidate is re-checked with the exact grid predicates before it
 * attaches — the margin only ever admits extra candidates, never drops a true hit.
 */
const STABBING_CANDIDATE_SLACK = 1e-3;

/** One axis's corridors sorted by travel-span start, with a max-end segment tree over that order. */
interface CorridorStabbingIndex {
  /** Positions in the original corridors array, sorted by travel-span start. */
  readonly positions: Int32Array;
  /** Travel-span starts aligned with positions (ascending). */
  readonly starts: Float64Array;
  /** Power-of-two leaf count of the segment tree. */
  readonly leafBase: number;
  /** Implicit max-end tree: [leafBase + i] holds sorted entry i's travel-span end. */
  readonly maxEnds: Float64Array;
}

function buildCorridorStabbingIndex(
  corridors: readonly Corridor[],
  axis: Axis,
): CorridorStabbingIndex {
  const entries: { position: number; start: number; end: number }[] = [];
  for (let position = 0; position < corridors.length; position += 1) {
    const corridor = corridors[position];
    if (corridor.axis !== axis) {
      continue;
    }
    const travelSpan = corridorTravelSpan(corridor);
    entries.push({ position, start: travelSpan[0], end: travelSpan[1] });
  }
  entries.sort((left, right) => left.start - right.start);
  const size = entries.length;
  let leafBase = 1;
  while (leafBase < size) {
    leafBase *= 2;
  }
  const positions = new Int32Array(size);
  const starts = new Float64Array(size);
  const maxEnds = new Float64Array(2 * leafBase).fill(Number.NEGATIVE_INFINITY);
  entries.forEach((entry, sortedIndex) => {
    positions[sortedIndex] = entry.position;
    starts[sortedIndex] = entry.start;
    maxEnds[leafBase + sortedIndex] = entry.end;
  });
  for (let node = leafBase - 1; node >= 1; node -= 1) {
    maxEnds[node] = Math.max(maxEnds[2 * node], maxEnds[2 * node + 1]);
  }
  return { positions, starts, leafBase, maxEnds };
}

/**
 * Original-array positions of corridors whose travel interval could contain `plane`
 * (a superset within STABBING_CANDIDATE_SLACK), in ascending position order so the
 * caller visits candidates in stable corridor-array order.
 */
function collectStabbedCorridorPositions(index: CorridorStabbingIndex, plane: number): number[] {
  const startLimit = plane + STABBING_CANDIDATE_SLACK;
  const minEnd = plane - STABBING_CANDIDATE_SLACK;
  const sortedLimit = countStartsAtMost(index.starts, startLimit);
  const positions: number[] = [];
  if (sortedLimit === 0) {
    return positions;
  }
  const collect = (node: number, nodeLo: number, nodeSize: number): void => {
    if (nodeLo >= sortedLimit || index.maxEnds[node] < minEnd) {
      return;
    }
    if (nodeSize === 1) {
      positions.push(index.positions[nodeLo]);
      return;
    }
    const half = nodeSize / 2;
    collect(2 * node, nodeLo, half);
    collect(2 * node + 1, nodeLo + half, half);
  };
  collect(1, 0, index.leafBase);
  positions.sort((left, right) => left - right);
  return positions;
}

function countStartsAtMost(starts: Float64Array, limit: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= limit) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function extendsOutward(travelSpan: AxisSpan, plane: number, face: Direction): boolean {
  return face === 'right' || face === 'down' ? travelSpan[1] > plane : travelSpan[0] < plane;
}
