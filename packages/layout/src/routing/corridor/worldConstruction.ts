import { LayoutManager } from '../../LayoutManager.js';
import type { Corridor, PortalRef, RouteSearchRequest } from './contract.js';
import { CorridorIndexer } from './corridorIndex.js';
import { constructDirectGapCorridors } from './directGapCorridorConstruction.js';
import { type LandingZoneRect, planLandingZones } from './landingZones.js';
import { overlapRect, snapEntitiesToGrid } from './geometry.js';
import {
  buildBaseCorridorGeometry,
  buildTerminalFaceRouteCounts,
  buildTerminalAttachments,
  PORTAL_SEARCH_TIER_ESCAPE,
  type CorridorWorld,
} from './world.js';

/** Build the routed corridor world, including only terminal faces used by this batch. */
export function buildCorridorWorld(
  layoutManager: LayoutManager,
  requests: readonly RouteSearchRequest[],
): CorridorWorld {
  // Routing's whole-pixel view: snap once here, into routing-owned copies — the
  // caller's entities are never mutated. When the scene is already on-grid the
  // original manager is reused wholesale.
  const sourceEntities = layoutManager.getEntities();
  const entities = snapEntitiesToGrid(sourceEntities);
  const routingManager =
    entities === sourceEntities
      ? layoutManager
      : new LayoutManager({
          entities: [...entities],
          connections: [],
          primaryDirection: layoutManager.primaryDirection,
          options: layoutManager.options,
          origin: layoutManager.origin,
        });
  const base = buildBaseCorridorGeometry(routingManager);
  const runways = planLandingZones(base.bounds, entities, requests, base.freeSpace);
  const geometry = buildCorridorGeometry(routingManager, base, runways);
  const attachments = buildTerminalAttachments(entities, geometry.corridors, requests);
  const indexer = new CorridorIndexer(
    geometry.corridors,
    geometry.portals,
    attachments,
    routingManager,
    base.bounds,
  );
  return {
    bounds: base.bounds,
    entities,
    sourceEntities,
    indexer,
    terminalFaceRouteCounts: buildTerminalFaceRouteCounts(entities.length, requests),
    corridorSearchTiers: geometry.corridorSearchTiers,
    corridorEntryCosts: geometry.corridorEntryCosts,
    portalSearchTiers: geometry.portalSearchTiers,
  };
}

/**
 * One pass over the final corridors: axis partition and travel/cross spans as flat typed
 * arrays. Everything downstream (turn portals, continuations, search-tier metadata) reads
 * these instead of re-deriving per corridor.
 */
interface CorridorScan {
  readonly xIndices: readonly number[];
  readonly yIndices: readonly number[];
  readonly travelStarts: Int32Array;
  readonly travelEnds: Int32Array;
  readonly crossStarts: Int32Array;
  readonly crossEnds: Int32Array;
}

function scanCorridors(corridors: readonly Corridor[]): CorridorScan {
  const count = corridors.length;
  const xIndices: number[] = [];
  const yIndices: number[] = [];
  const travelStarts = new Int32Array(count);
  const travelEnds = new Int32Array(count);
  const crossStarts = new Int32Array(count);
  const crossEnds = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    const corridor = corridors[index];
    const rect = corridor.rect;
    if (corridor.axis === 'x') {
      xIndices.push(index);
      travelStarts[index] = rect.x;
      travelEnds[index] = rect.x + rect.width;
      crossStarts[index] = rect.y;
      crossEnds[index] = rect.y + rect.height;
    } else {
      yIndices.push(index);
      travelStarts[index] = rect.y;
      travelEnds[index] = rect.y + rect.height;
      crossStarts[index] = rect.x;
      crossEnds[index] = rect.x + rect.width;
    }
  }
  return { xIndices, yIndices, travelStarts, travelEnds, crossStarts, crossEnds };
}

function buildCorridorGeometry(
  layoutManager: LayoutManager,
  base: ReturnType<typeof buildBaseCorridorGeometry>,
  runways: readonly LandingZoneRect[],
) {
  const directConstruction = constructDirectGapCorridors({
    bounds: base.bounds,
    layoutManager,
    freeSpace: base.freeSpace,
    runways,
  });
  const corridors = directConstruction.corridors;
  const scan = scanCorridors(corridors);
  const turns = buildTurnPortals(corridors, scan.xIndices, scan.yIndices);
  const continuationPortals = buildContinuationPortals(corridors, scan).map((portal, position) => ({
    ...portal,
    index: turns.length + position,
  }));
  const escapeCorridors = directConstruction.searchTiers;
  const portals: PortalRef[] = [...turns, ...continuationPortals];
  const portalSearchTiers = new Uint8Array(portals.length);
  for (const portal of portals) {
    const firstIndex =
      portal.kind === 'turn' ? portal.xCorridorIndex : portal.negativeCorridorIndex;
    const secondIndex =
      portal.kind === 'turn' ? portal.yCorridorIndex : portal.positiveCorridorIndex;
    if (escapeCorridors[firstIndex] === 1 || escapeCorridors[secondIndex] === 1) {
      portalSearchTiers[portal.index] = PORTAL_SEARCH_TIER_ESCAPE;
    }
  }
  return {
    corridors,
    portals,
    corridorSearchTiers: directConstruction.searchTiers,
    corridorEntryCosts: directConstruction.entryCosts,
    portalSearchTiers,
  };
}

function buildTurnPortals(
  corridors: readonly Corridor[],
  xIndices: readonly number[],
  yIndices: readonly number[],
): Extract<PortalRef, { kind: 'turn' }>[] {
  const portals: Extract<PortalRef, { kind: 'turn' }>[] = [];
  for (const xIndex of xIndices) {
    const xRect = corridors[xIndex].rect;
    for (const yIndex of yIndices) {
      const rect = overlapRect(xRect, corridors[yIndex].rect, 0);
      if (!rect) {
        continue;
      }
      portals.push({
        kind: 'turn',
        index: portals.length,
        xCorridorIndex: xIndex,
        yCorridorIndex: yIndex,
        rect,
      });
    }
  }
  return portals;
}

type PendingContinuationPortal = Omit<Extract<PortalRef, { kind: 'continue' }>, 'index'>;

function buildContinuationPortals(
  corridors: readonly Corridor[],
  scan: CorridorScan,
): PendingContinuationPortal[] {
  const starts = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  for (let index = 0; index < corridors.length; index += 1) {
    const axis = corridors[index].axis;
    append(starts, `${axis}:${scan.travelStarts[index]}`, index);
    append(ends, `${axis}:${scan.travelEnds[index]}`, index);
  }
  const result: PendingContinuationPortal[] = [];
  for (const [plane, negative] of ends) {
    const positive = starts.get(plane);
    if (!positive) {
      continue;
    }
    const compare = (left: number, right: number): number =>
      scan.crossStarts[left] - scan.crossStarts[right] ||
      scan.crossEnds[left] - scan.crossEnds[right];
    negative.sort(compare);
    positive.sort(compare);
    let left = 0;
    let right = 0;
    while (left < negative.length && right < positive.length) {
      const firstStart = scan.crossStarts[negative[left]];
      const firstEnd = scan.crossEnds[negative[left]];
      const secondStart = scan.crossStarts[positive[right]];
      const secondEnd = scan.crossEnds[positive[right]];
      const start = Math.max(firstStart, secondStart);
      const end = Math.min(firstEnd, secondEnd);
      if (end > start) {
        result.push({
          kind: 'continue',
          axis: corridors[negative[left]].axis,
          negativeCorridorIndex: negative[left],
          positiveCorridorIndex: positive[right],
          planeCoordinate: scan.travelEnds[negative[left]],
          crossSpan: [start, end],
        });
      }
      if (firstEnd <= secondEnd) {
        left += 1;
      }
      if (secondEnd <= firstEnd) {
        right += 1;
      }
    }
  }
  return result.sort(
    (a, b) =>
      a.axis.localeCompare(b.axis) ||
      a.planeCoordinate - b.planeCoordinate ||
      a.crossSpan[0] - b.crossSpan[0] ||
      a.crossSpan[1] - b.crossSpan[1] ||
      a.negativeCorridorIndex - b.negativeCorridorIndex ||
      a.positiveCorridorIndex - b.positiveCorridorIndex,
  );
}

function append<K, T>(map: Map<K, T[]>, key: K, value: T): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}
