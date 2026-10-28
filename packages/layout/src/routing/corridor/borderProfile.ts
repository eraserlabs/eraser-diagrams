import type { LayoutManager } from '../../LayoutManager.js';
import {
  axisEnd,
  axisOrthMax,
  axisOrthMin,
  axisStart,
  makeRangeFromEntity,
} from '../../rangeUtils.js';
import type { Axis, AxisSpan, LayoutEntity, PositionProps } from '../../types.js';
import type { Corridor } from './contract.js';
import type { CorridorSpans } from './corridorSpans.js';

/** Sorted, disjoint wall coverage along each side's travel axis, as flat start/end pairs. */
export interface CorridorBorderProfile {
  readonly negative: readonly number[];
  readonly positive: readonly number[];
  /** Mask: 1 = negative diagram boundary, 2 = positive. Unset sides contain entity coverage. */
  readonly diagramBorderSides: number;
}

/** Build one full two-sided profile when a corridor first needs border facts. */
export function buildCorridorBorderProfile(
  layoutManager: LayoutManager,
  bounds: PositionProps,
  corridor: Corridor,
  externalTextEntities: readonly LayoutEntity[],
  spans: CorridorSpans,
): CorridorBorderProfile {
  const crossStart = spans.crossStarts[corridor.index];
  const crossEnd = spans.crossEnds[corridor.index];
  const travel = spans.travelSpan(corridor.index);
  const boundsStart = axisOrthMin(bounds, corridor.axis);
  const boundsEnd = axisOrthMax(bounds, corridor.axis);
  const negativeIsDiagramBorder = crossStart === boundsStart || crossStart === boundsEnd;
  const positiveIsDiagramBorder = crossEnd === boundsStart || crossEnd === boundsEnd;
  const bodyEntities =
    negativeIsDiagramBorder && positiveIsDiagramBorder
      ? []
      : layoutManager.findEntitiesInRange(makeRangeFromEntity(corridor.rect));
  const entities = [...bodyEntities, ...externalTextEntities];
  const negative = negativeIsDiagramBorder
    ? travel
    : entityBorderSpans(corridor.axis, travel, crossStart, entities);
  const positive = positiveIsDiagramBorder
    ? travel
    : entityBorderSpans(corridor.axis, travel, crossEnd, entities);
  return {
    negative,
    positive,
    diagramBorderSides: (negativeIsDiagramBorder ? 1 : 0) | (positiveIsDiagramBorder ? 2 : 0),
  };
}

/** Border consumers need wall coverage, not ownership of overlapping wall pieces. */
function entityBorderSpans(
  axis: Axis,
  travel: AxisSpan,
  coordinate: number,
  entities: readonly LayoutEntity[],
): number[] {
  const spans: AxisSpan[] = [];
  for (const entity of entities) {
    if (axisOrthMin(entity, axis) !== coordinate && axisOrthMax(entity, axis) !== coordinate) {
      continue;
    }
    const start = Math.max(travel[0], axisStart(entity, axis));
    const end = Math.min(travel[1], axisEnd(entity, axis));
    if (end > start) {
      spans.push([start, end]);
    }
  }
  spans.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const result: number[] = [];
  for (const span of spans) {
    const last = result.length - 1;
    if (last >= 0 && span[0] <= result[last]) {
      result[last] = Math.max(result[last], span[1]);
    } else {
      result.push(span[0], span[1]);
    }
  }
  return result;
}
