import type { AxisSpan, Direction, LayoutEntity, PositionProps } from '../../types.js';
import type { LayoutManager } from '../../LayoutManager.js';
import { addBufferToRange, combineRanges, makePropsFromRange } from '../../rangeUtils.js';
import { isPointEndpoint, pointAttachmentKey } from './contract.js';
import type {
  Corridor,
  RouteEndpoint,
  RouteSearchRequest,
  TerminalAttachment,
} from './contract.js';
import type { CorridorIndexer } from './corridorIndex.js';
import { CorridorSpans } from './corridorSpans.js';
import { buildFreeSpaceSubstrate } from './freeSpaceSubstrate.js';
import { buildExternalTextEntities } from './externalTextGeometry.js';
import {
  faceCrossSpan,
  faceNormalAxis,
  faceOrder,
  facePlane,
  terminalFacePlane,
} from './geometry.js';
import type { GroupTitleAvoidance } from './groupTitleQuality.js';

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
  readonly groupTitleAvoidance?: GroupTitleAvoidance;
  /** Search policy only. Every portal remains present for geometry and downstream consumers. */
  readonly portalSearchTiers?: Uint8Array;
}

export function terminalFaceRouteCount(world: CorridorWorld, endpoint: RouteEndpoint): number {
  if (isPointEndpoint(endpoint)) {
    return 0;
  }
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
  if (isPointEndpoint(endpoint)) {
    return false;
  }
  const entity = world.entities[endpoint.entityIndex];
  if (entity.isContainer !== true || terminalFaceRouteCount(world, endpoint) !== 1) {
    return false;
  }
  if (isPointEndpoint(opposite)) {
    return true;
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
      if (isPointEndpoint(endpoint)) {
        continue;
      }
      counts[endpoint.entityIndex * ORDERED_FACES.length + faceOrder(endpoint.face)] += 1;
    }
  }
  return counts;
}

export function buildBaseCorridorGeometry(
  layoutManager: LayoutManager,
  requests: readonly RouteSearchRequest[],
) {
  const entities = layoutManager.getEntities();
  // The world must host every point terminal: a dragged endpoint routinely
  // leaves the content bounds.
  const pointRanges = requests
    .flatMap((request) => [request.from, request.to])
    .filter(isPointEndpoint)
    .map(({ x, y }) => ({ minX: x, maxX: x, minY: y, maxY: y }));
  const bounds = makePropsFromRange(
    addBufferToRange(combineRanges(layoutManager.getDims(), ...pointRanges), ROOT_BOUNDS_MARGIN_PX),
  );
  const externalTextEntities = buildExternalTextEntities(entities);
  return {
    bounds,
    externalTextEntities,
    freeSpace: buildFreeSpaceSubstrate(bounds, entities, externalTextEntities),
  };
}

export function buildTerminalAttachments(
  entities: readonly LayoutEntity[],
  corridors: readonly Corridor[],
  requests: readonly RouteSearchRequest[],
  spans = new CorridorSpans(corridors),
): TerminalAttachment[] {
  const requestedFaces = new Uint8Array(entities.length * ORDERED_FACES.length);
  const requestedPoints = new Map<string, { readonly x: number; readonly y: number }>();
  for (const request of requests) {
    for (const endpoint of [request.from, request.to]) {
      if (isPointEndpoint(endpoint)) {
        requestedPoints.set(pointAttachmentKey(endpoint.x, endpoint.y), endpoint);
        continue;
      }
      requestedFaces[endpoint.entityIndex * ORDERED_FACES.length + faceOrder(endpoint.face)] = 1;
    }
  }
  const indexByAxis = {
    x: buildCorridorStabbingIndex(spans.xIndices, spans),
    y: buildCorridorStabbingIndex(spans.yIndices, spans),
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
      for (const position of collectAttachingCorridorPositions(
        indexByAxis[axis],
        plane,
        face === 'right' || face === 'down',
        faceSpan,
        spans,
      )) {
        attachments.push({
          index: attachments.length,
          entityIndex,
          face,
          corridorIndex: corridors[position].index,
          faceSpan: [
            Math.max(faceSpan[0], spans.crossStarts[position]),
            Math.min(faceSpan[1], spans.crossEnds[position]),
          ],
        });
      }
    }
  }
  // Point terminals attach to every corridor whose rect contains the point. A
  // point inside an entity has no hosting corridor and yields no attachments;
  // its route then reports a terminal-attachment fallback instead of crashing.
  for (const point of requestedPoints.values()) {
    for (let position = 0; position < corridors.length; position += 1) {
      const corridor = corridors[position];
      const travelCoordinate = corridor.axis === 'x' ? point.x : point.y;
      const crossCoordinate = corridor.axis === 'x' ? point.y : point.x;
      if (
        !spans.travelIncludes(position, travelCoordinate, 0) ||
        !spans.crossIncludes(position, crossCoordinate, 0)
      ) {
        continue;
      }
      attachments.push({
        kind: 'point',
        index: attachments.length,
        corridorIndex: corridor.index,
        x: point.x,
        y: point.y,
      });
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
  corridorPositions: readonly number[],
  spans: CorridorSpans,
): CorridorStabbingIndex {
  const { travelStarts, travelEnds } = spans;
  const positions = Int32Array.from(corridorPositions);
  positions.sort((left, right) => travelStarts[left] - travelStarts[right] || left - right);
  const size = positions.length;
  let leafBase = 1;
  while (leafBase < size) {
    leafBase *= 2;
  }
  const starts = new Float64Array(size);
  const maxEnds = new Float64Array(2 * leafBase).fill(Number.NEGATIVE_INFINITY);
  for (let sortedIndex = 0; sortedIndex < size; sortedIndex += 1) {
    const position = positions[sortedIndex];
    starts[sortedIndex] = travelStarts[position];
    maxEnds[leafBase + sortedIndex] = travelEnds[position];
  }
  for (let node = leafBase - 1; node >= 1; node -= 1) {
    maxEnds[node] = Math.max(maxEnds[2 * node], maxEnds[2 * node + 1]);
  }
  return { positions, starts, leafBase, maxEnds };
}

/** Filter before collecting/sorting, retaining stable corridor-array order for attachments. */
function collectAttachingCorridorPositions(
  index: CorridorStabbingIndex,
  plane: number,
  forward: boolean,
  faceSpan: AxisSpan,
  spans: CorridorSpans,
): number[] {
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
      const position = index.positions[nodeLo];
      const start = spans.travelStarts[position];
      const end = spans.travelEnds[position];
      if (
        plane >= start &&
        plane <= end &&
        (forward ? end > plane : start < plane) &&
        Math.min(faceSpan[1], spans.crossEnds[position]) >
          Math.max(faceSpan[0], spans.crossStarts[position])
      ) {
        positions.push(position);
      }
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
