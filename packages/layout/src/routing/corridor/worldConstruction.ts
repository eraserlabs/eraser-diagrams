import { LayoutManager } from '../../LayoutManager.js';
import { LayoutTree } from '../../LayoutTree.js';
import type { PositionProps } from '../../types.js';
import type { Corridor, PortalRef, RouteSearchRequest } from './contract.js';
import { CorridorIndexer } from './corridorIndex.js';
import { CorridorSpans } from './corridorSpans.js';
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
  const base = buildBaseCorridorGeometry(routingManager, requests);
  const runways = planLandingZones(
    base.bounds,
    entities,
    requests,
    base.freeSpace,
    base.externalTextEntities,
  );
  const geometry = buildCorridorGeometry(routingManager, base, runways);
  const attachments = buildTerminalAttachments(
    entities,
    geometry.corridors,
    requests,
    geometry.spans,
  );
  const indexer = new CorridorIndexer(
    geometry.corridors,
    geometry.portals,
    attachments,
    routingManager,
    base.bounds,
    base.externalTextEntities,
    geometry.spans,
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
  const scan = new CorridorSpans(corridors);
  const turns = buildTurnPortals(corridors, scan.xIndices, scan.yIndices);
  const continuationPortals = buildContinuationPortals(corridors, scan, turns.length);
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
    spans: scan,
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
  const yTree = new LayoutTree<PositionProps & { readonly index: number }>().load(
    yIndices.map((index) => ({ ...corridors[index].rect, index })),
  );
  for (const xIndex of xIndices) {
    const xRect = corridors[xIndex].rect;
    // Preserve corridor-index order: portal indexes are part of routing identity.
    const candidates = yTree
      .searchBounds(xRect.x, xRect.y, xRect.x + xRect.width, xRect.y + xRect.height)
      .sort((left, right) => left.index - right.index);
    for (const candidate of candidates) {
      const rect = overlapRect(xRect, candidate, 0);
      if (!rect) {
        continue;
      }
      portals.push({
        kind: 'turn',
        index: portals.length,
        xCorridorIndex: xIndex,
        yCorridorIndex: candidate.index,
        rect,
      });
    }
  }
  return portals;
}

type PendingContinuationPortal = Omit<Extract<PortalRef, { kind: 'continue' }>, 'index'> & {
  index: number;
};

function buildContinuationPortals(
  corridors: readonly Corridor[],
  scan: CorridorSpans,
  firstIndex: number,
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
          index: 0,
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
  result.sort(
    (a, b) =>
      a.axis.localeCompare(b.axis) ||
      a.planeCoordinate - b.planeCoordinate ||
      a.crossSpan[0] - b.crossSpan[0] ||
      a.crossSpan[1] - b.crossSpan[1] ||
      a.negativeCorridorIndex - b.negativeCorridorIndex ||
      a.positiveCorridorIndex - b.positiveCorridorIndex,
  );
  for (let position = 0; position < result.length; position += 1) {
    result[position].index = firstIndex + position;
  }
  return result;
}

function append<K, T>(map: Map<K, T[]>, key: K, value: T): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}
