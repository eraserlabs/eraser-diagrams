import { subtractSpans } from '../../rangeUtils.js';
import type { PositionProps, XYPoint } from '../../types.js';
import { overlapLength, ROUTING_EPSILON as EPSILON } from './geometry.js';
import { LABEL_LINE_CLEARANCE_PX, type LabelSize } from './text.js';
import type { CorridorWorld } from './world.js';

/**
 * Travel-span / free-interval algebra for placing a label along a host segment:
 * clip the legal travel window to world bounds, subtract entity, occupied-label,
 * and route-line exclusions, and report the surviving clear intervals.
 */

export const TERMINAL_LABEL_GAP_PX = 8;

interface TravelSpaceProfile {
  readonly bounds: readonly [number, number];
  readonly clear: Array<readonly [number, number]>;
  readonly structural: Array<readonly [number, number]>;
}

/** The fields of a label's host segment the travel-span algebra reads. */
interface TravelHostSegment {
  readonly index: number;
  readonly axis: 'x' | 'y';
  readonly from: XYPoint;
}

/** Spatial index over route segments (labelPlacement's TextRouteSegmentIndex satisfies it). */
interface TravelSegmentIndex {
  segmentsInRect(
    rect: PositionProps,
    excludedRouteIndex?: number,
  ): readonly { readonly from: XYPoint; readonly to: XYPoint }[];
}

export function clearTravelSpans(
  world: CorridorWorld,
  routeSegmentIndex: TravelSegmentIndex,
  ownerPoints: readonly XYPoint[],
  occupied: readonly PositionProps[],
  ownerRouteIndex: number,
  segment: TravelHostSegment,
  size: LabelSize,
  legal: readonly [number, number],
): TravelSpaceProfile {
  const alongExtent = segment.axis === 'x' ? size.width : size.height;
  const crossExtent = segment.axis === 'x' ? size.height : size.width;
  const track = segment.axis === 'x' ? segment.from.y : segment.from.x;
  const worldAlong: readonly [number, number] =
    segment.axis === 'x'
      ? [world.bounds.x + alongExtent / 2, world.bounds.x + world.bounds.width - alongExtent / 2]
      : [world.bounds.y + alongExtent / 2, world.bounds.y + world.bounds.height - alongExtent / 2];
  const worldCross: readonly [number, number] =
    segment.axis === 'x'
      ? [world.bounds.y, world.bounds.y + world.bounds.height]
      : [world.bounds.x, world.bounds.x + world.bounds.width];
  if (
    track - crossExtent / 2 < worldCross[0] - EPSILON ||
    track + crossExtent / 2 > worldCross[1] + EPSILON
  ) {
    return { bounds: legal, clear: [], structural: [] };
  }
  const bounded: readonly [number, number] = [
    Math.max(legal[0], worldAlong[0]),
    Math.min(legal[1], worldAlong[1]),
  ];
  if (bounded[0] > bounded[1] + EPSILON) {
    return { bounds: bounded, clear: [], structural: [] };
  }

  const excluded: Array<readonly [number, number]> = [];
  for (const entity of world.entities) {
    if (entity.isContainer === true) {
      addContainerBoundaryExclusions(excluded, segment, size, entity);
    } else {
      addRectTravelExclusion(excluded, segment, size, entity, 0);
    }
  }
  const structural = subtractSpans(bounded, excluded, EPSILON);
  for (const rect of occupied) {
    addRectTravelExclusion(excluded, segment, size, rect, TERMINAL_LABEL_GAP_PX);
  }

  const searchRect =
    segment.axis === 'x'
      ? {
          x: bounded[0] - alongExtent / 2,
          y: track - crossExtent / 2 - LABEL_LINE_CLEARANCE_PX,
          width: bounded[1] - bounded[0] + alongExtent,
          height: crossExtent + 2 * LABEL_LINE_CLEARANCE_PX,
        }
      : {
          x: track - crossExtent / 2 - LABEL_LINE_CLEARANCE_PX,
          y: bounded[0] - alongExtent / 2,
          width: crossExtent + 2 * LABEL_LINE_CLEARANCE_PX,
          height: bounded[1] - bounded[0] + alongExtent,
        };
  for (const other of routeSegmentIndex.segmentsInRect(searchRect, ownerRouteIndex)) {
    addLineTravelExclusion(excluded, segment, size, other.from, other.to, LABEL_LINE_CLEARANCE_PX);
  }
  for (let index = 0; index + 1 < ownerPoints.length; index += 1) {
    if (index === segment.index) {
      continue;
    }
    addLineTravelExclusion(
      excluded,
      segment,
      size,
      ownerPoints[index],
      ownerPoints[index + 1],
      LABEL_LINE_CLEARANCE_PX,
    );
  }
  return { bounds: bounded, clear: subtractSpans(bounded, excluded, EPSILON), structural };
}

function addRectTravelExclusion(
  excluded: Array<readonly [number, number]>,
  segment: TravelHostSegment,
  size: LabelSize,
  rect: PositionProps,
  clearance: number,
): void {
  const alongExtent = segment.axis === 'x' ? size.width : size.height;
  const crossExtent = segment.axis === 'x' ? size.height : size.width;
  const track = segment.axis === 'x' ? segment.from.y : segment.from.x;
  const crossStart = segment.axis === 'x' ? rect.y : rect.x;
  const crossLength = segment.axis === 'x' ? rect.height : rect.width;
  if (
    overlapLength(
      track - crossExtent / 2 - clearance,
      crossExtent + 2 * clearance,
      crossStart,
      crossLength,
    ) <= EPSILON
  ) {
    return;
  }
  const travelStart = segment.axis === 'x' ? rect.x : rect.y;
  const travelLength = segment.axis === 'x' ? rect.width : rect.height;
  excluded.push([
    travelStart - alongExtent / 2 - clearance,
    travelStart + travelLength + alongExtent / 2 + clearance,
  ]);
}

function addContainerBoundaryExclusions(
  excluded: Array<readonly [number, number]>,
  segment: TravelHostSegment,
  size: LabelSize,
  container: PositionProps,
): void {
  const corners: readonly XYPoint[] = [
    { x: container.x, y: container.y },
    { x: container.x + container.width, y: container.y },
    { x: container.x + container.width, y: container.y + container.height },
    { x: container.x, y: container.y + container.height },
  ];
  for (let index = 0; index < corners.length; index += 1) {
    addLineTravelExclusion(
      excluded,
      segment,
      size,
      corners[index],
      corners[(index + 1) % corners.length],
      0,
    );
  }
}

function addLineTravelExclusion(
  excluded: Array<readonly [number, number]>,
  segment: TravelHostSegment,
  size: LabelSize,
  from: XYPoint,
  to: XYPoint,
  clearance: number,
): void {
  const alongExtent = segment.axis === 'x' ? size.width : size.height;
  const crossExtent = segment.axis === 'x' ? size.height : size.width;
  const track = segment.axis === 'x' ? segment.from.y : segment.from.x;
  const lineFollowsHostAxis =
    segment.axis === 'x' ? Math.abs(from.y - to.y) <= EPSILON : Math.abs(from.x - to.x) <= EPSILON;
  const lineCrossStart = lineFollowsHostAxis
    ? segment.axis === 'x'
      ? from.y
      : from.x
    : Math.min(segment.axis === 'x' ? from.y : from.x, segment.axis === 'x' ? to.y : to.x);
  const lineCrossLength = lineFollowsHostAxis
    ? 0
    : Math.abs(segment.axis === 'x' ? to.y - from.y : to.x - from.x);
  if (
    lineCrossStart > track + crossExtent / 2 + clearance + EPSILON ||
    lineCrossStart + lineCrossLength < track - crossExtent / 2 - clearance - EPSILON
  ) {
    return;
  }
  const firstTravel = segment.axis === 'x' ? from.x : from.y;
  const secondTravel = segment.axis === 'x' ? to.x : to.y;
  excluded.push([
    Math.min(firstTravel, secondTravel) - alongExtent / 2 - clearance,
    Math.max(firstTravel, secondTravel) + alongExtent / 2 + clearance,
  ]);
}
