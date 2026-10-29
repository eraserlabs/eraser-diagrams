import type { PositionProps } from '../../types.js';
import {
  makePropsFromRange,
  makeRangeForEntityTextPlacement,
  makeRangeFromEntity,
  strictlyOverlaps,
} from '../../rangeUtils.js';
import type { RoutingQualityEvent, RoutingQualityVisitRef } from './qualityCost.js';
import type { RouteIndexer } from './routeIndex.js';
import type { CorridorWorld } from './world.js';

export interface GroupTitleCosts {
  readonly intersectionCost: number;
  readonly overlapCostPerPx: number;
}

export interface GroupTitleOptions extends GroupTitleCosts {
  readonly corridorPenalty: number;
}

export interface GroupTitleAvoidance extends GroupTitleCosts {
  readonly titles: readonly PositionProps[];
}

export interface GroupTitleQualityEvent extends RoutingQualityEvent {
  readonly kind: 'group-title';
  readonly titleIndex: number;
  readonly overlapLength: number;
}

/** One measured title list for the coarse search hint and exact emitted-geometry cost. */
export function withGroupTitleAvoidance(
  world: CorridorWorld,
  options?: GroupTitleOptions,
): CorridorWorld {
  if (!options) {
    return world;
  }
  const ranges = world.entities.flatMap((entity) => {
    const range = entity.isContainer ? makeRangeForEntityTextPlacement(entity) : undefined;
    return range && range.maxX > range.minX && range.maxY > range.minY ? [range] : [];
  });
  if (ranges.length === 0) {
    return world;
  }
  let costs = world.corridorEntryCosts;
  if (options.corridorPenalty !== 0) {
    costs = costs?.slice() ?? new Float64Array(world.indexer.corridors.length);
    for (const corridor of world.indexer.corridors) {
      const range = makeRangeFromEntity(corridor.rect);
      if (ranges.some((title) => strictlyOverlaps(range, title))) {
        costs[corridor.index] += options.corridorPenalty;
      }
    }
  }
  return {
    ...world,
    corridorEntryCosts: costs,
    groupTitleAvoidance: { ...options, titles: ranges.map(makePropsFromRange) },
  };
}

/** Price actual ink through title rectangles, once per route/title, independent of corridor splits. */
export function collectGroupTitleQualityEvents(
  avoidance: GroupTitleAvoidance,
  index: RouteIndexer,
): GroupTitleQualityEvent[] {
  const events: GroupTitleQualityEvent[] = [];
  if (avoidance.intersectionCost === 0 && avoidance.overlapCostPerPx === 0) {
    return events;
  }
  for (let titleIndex = 0; titleIndex < avoidance.titles.length; titleIndex += 1) {
    const title = avoidance.titles[titleIndex];
    const hits = new Map<
      number,
      { length: number; visits: Map<number, RoutingQualityVisitRef>; corridors: Set<number> }
    >();
    for (const segment of index.unsortedSegmentsInRect(title)) {
      const start = segment.axis === 'x' ? title.x : title.y;
      const end = start + (segment.axis === 'x' ? title.width : title.height);
      const crossStart = segment.axis === 'x' ? title.y : title.x;
      const crossEnd = crossStart + (segment.axis === 'x' ? title.height : title.width);
      const length = Math.min(end, segment.travel[1]) - Math.max(start, segment.travel[0]);
      if (length <= 0 || segment.track <= crossStart || segment.track >= crossEnd) {
        continue;
      }
      let hit = hits.get(segment.routeIndex);
      if (!hit) {
        hit = { length: 0, visits: new Map(), corridors: new Set() };
        hits.set(segment.routeIndex, hit);
      }
      hit.length += length;
      hit.visits.set(segment.visitIndex, {
        routeIndex: segment.routeIndex,
        visitIndex: segment.visitIndex,
      });
      hit.corridors.add(segment.corridorIndex);
    }
    for (const [routeIndex, hit] of hits) {
      events.push({
        kind: 'group-title',
        titleIndex,
        overlapLength: hit.length,
        cost: avoidance.intersectionCost + avoidance.overlapCostPerPx * hit.length,
        routeIndexes: [routeIndex],
        corridorIndexes: [...hit.corridors],
        visits: [...hit.visits.values()],
      });
    }
  }
  return events;
}
