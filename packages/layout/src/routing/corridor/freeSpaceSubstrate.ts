import { touchExternalTextRangeToEntityClippedToBodyFace } from '../textPlacements.js';
import type { Axis, AxisSpan, LayoutEntity, PositionProps } from '../../types.js';
import {
  addUniqueNumber,
  insertIntoSortedBy,
  lowerBoundInt32,
  upperBoundInt32,
} from './sortedArrayUtils.js';

/** Packed, non-overlapping free cross-spans for consecutive travel slabs (grid integers). */
export interface AxisFreeSpace {
  readonly travelCuts: Int32Array;
  /** Interval offsets, not scalar offsets; length equals travelCuts.length. */
  readonly slabOffsets: Uint32Array;
  /** Flat [start, end] pairs. */
  readonly crossSpans: Int32Array;
}

/** One immutable geometric substrate shared by corridor construction consumers. */
export type FreeSpaceSubstrate = Readonly<Record<Axis, AxisFreeSpace>>;

interface FreeSpaceObstacle {
  readonly travelStart: number;
  readonly travelEnd: number;
  readonly crossStart: number;
  readonly crossEnd: number;
}

const compareObstacles = (left: FreeSpaceObstacle, right: FreeSpaceObstacle): number =>
  left.crossStart - right.crossStart || left.crossEnd - right.crossEnd;

/** Containers contribute event cuts but remain traversable in the raw substrate. */
export function buildFreeSpaceSubstrate(
  bounds: PositionProps,
  entities: readonly LayoutEntity[],
): FreeSpaceSubstrate {
  return {
    x: buildAxisFreeSpace(bounds, entities, 'x'),
    y: buildAxisFreeSpace(bounds, entities, 'y'),
  };
}

function buildAxisFreeSpace(
  bounds: PositionProps,
  entities: readonly LayoutEntity[],
  axis: Axis,
): AxisFreeSpace {
  const travelStart = axis === 'x' ? bounds.x : bounds.y;
  const travelEnd = travelStart + (axis === 'x' ? bounds.width : bounds.height);
  const crossStart = axis === 'x' ? bounds.y : bounds.x;
  const crossEnd = crossStart + (axis === 'x' ? bounds.height : bounds.width);
  const travelCuts = [travelStart, travelEnd];
  const obstacles: FreeSpaceObstacle[] = [];
  for (const entity of entities) {
    appendRect(entity, entity.isContainer !== true, axis, travelCuts, obstacles);
    const text = touchExternalTextRangeToEntityClippedToBodyFace(entity);
    if (text) {
      appendRect(text, true, axis, travelCuts, obstacles);
    }
  }
  const starts = new Map<number, FreeSpaceObstacle[]>();
  const ends = new Map<number, FreeSpaceObstacle[]>();
  for (const obstacle of obstacles) {
    appendValue(starts, obstacle.travelStart, obstacle);
    appendValue(ends, obstacle.travelEnd, obstacle);
  }

  const active: FreeSpaceObstacle[] = [];
  const slabOffsets = new Uint32Array(travelCuts.length);
  const crossSpans: number[] = [];
  for (let index = 0; index < travelCuts.length - 1; index += 1) {
    const start = travelCuts[index];
    for (const obstacle of ends.get(start) ?? []) {
      const activeIndex = active.indexOf(obstacle);
      if (activeIndex >= 0) {
        active.splice(activeIndex, 1);
      }
    }
    for (const obstacle of starts.get(start) ?? []) {
      insertIntoSortedBy(active, obstacle, compareObstacles);
    }
    slabOffsets[index] = crossSpans.length >>> 1;
    appendFreeCrossSpans(crossSpans, crossStart, crossEnd, active);
  }
  slabOffsets[travelCuts.length - 1] = crossSpans.length >>> 1;
  return {
    travelCuts: Int32Array.from(travelCuts),
    slabOffsets,
    crossSpans: Int32Array.from(crossSpans),
  };
}

function appendRect(
  rect: PositionProps,
  blocks: boolean,
  axis: Axis,
  cutValues: number[],
  obstacles: FreeSpaceObstacle[],
): void {
  const rectTravelStart = axis === 'x' ? rect.x : rect.y;
  const rectTravelEnd = rectTravelStart + (axis === 'x' ? rect.width : rect.height);
  addUniqueNumber(cutValues, rectTravelStart, 0);
  addUniqueNumber(cutValues, rectTravelEnd, 0);
  if (!blocks) {
    return;
  }
  const rectCrossStart = axis === 'x' ? rect.y : rect.x;
  obstacles.push({
    travelStart: rectTravelStart,
    travelEnd: rectTravelEnd,
    crossStart: rectCrossStart,
    crossEnd: rectCrossStart + (axis === 'x' ? rect.height : rect.width),
  });
}

function appendValue<T>(map: Map<number, T[]>, key: number, value: T): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** Does the slab's packed free cross-span list contain `span` entirely? */
function slabContainsSpan(lane: AxisFreeSpace, slabIndex: number, span: AxisSpan): boolean {
  for (
    let intervalIndex = lane.slabOffsets[slabIndex];
    intervalIndex < lane.slabOffsets[slabIndex + 1];
    intervalIndex += 1
  ) {
    const start = lane.crossSpans[intervalIndex * 2];
    const end = lane.crossSpans[intervalIndex * 2 + 1];
    if (start <= span[0] && end >= span[1]) {
      return true;
    }
    if (start > span[0]) {
      break;
    }
  }
  return false;
}

/** First slab whose end lies beyond `coord`; earlier slabs cannot overlap. */
function firstSlabEndingBeyond(cuts: Int32Array, coord: number): number {
  const low = upperBoundInt32(cuts, coord);
  return low > 0 ? low - 1 : 0;
}

/** Last slab that starts before `coord`, or -1; later slabs cannot overlap. */
function lastSlabStartingBefore(cuts: Int32Array, coord: number): number {
  return lowerBoundInt32(cuts, coord) - 1;
}

/**
 * Walk certified free space outward from `plane` in `sign` direction while every slab
 * still contains `cross`, returning the furthest coordinate reached (clamped to `cap`).
 * Slabs partition the bounds, so the walk is contiguous by construction.
 */
export function certifiedRunFrom(
  lane: AxisFreeSpace,
  plane: number,
  cross: AxisSpan,
  sign: 1 | -1,
  cap: number,
): number {
  const cuts = lane.travelCuts;
  let reached = plane;
  if (sign > 0) {
    for (let slab = firstSlabEndingBeyond(cuts, reached); slab < cuts.length - 1; slab += 1) {
      if (cuts[slab + 1] <= reached) {
        continue;
      }
      if (cuts[slab] > reached || !slabContainsSpan(lane, slab, cross)) {
        break;
      }
      reached = Math.min(cuts[slab + 1], cap);
      if (reached >= cap) {
        break;
      }
    }
    return reached;
  }
  for (
    let slab = Math.min(lastSlabStartingBefore(cuts, reached), cuts.length - 2);
    slab >= 0;
    slab -= 1
  ) {
    if (cuts[slab] >= reached) {
      continue;
    }
    if (cuts[slab + 1] < reached || !slabContainsSpan(lane, slab, cross)) {
      break;
    }
    reached = Math.max(cuts[slab], cap);
    if (reached <= cap) {
      break;
    }
  }
  return reached;
}

function appendFreeCrossSpans(
  result: number[],
  crossStart: number,
  crossEnd: number,
  obstacles: readonly FreeSpaceObstacle[],
): void {
  let cursor = crossStart;
  for (const obstacle of obstacles) {
    const start = Math.max(crossStart, obstacle.crossStart);
    if (start > cursor) {
      result.push(cursor, Math.min(start, crossEnd));
    }
    cursor = Math.max(cursor, obstacle.crossEnd);
    if (cursor >= crossEnd) {
      return;
    }
  }
  if (cursor < crossEnd) {
    result.push(cursor, crossEnd);
  }
}
