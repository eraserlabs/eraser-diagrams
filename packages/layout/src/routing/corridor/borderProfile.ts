import type { LayoutManager } from '../../LayoutManager.js';
import { intersectPositiveSpans, makeRangeFromEntity } from '../../rangeUtils.js';
import type { Axis, AxisSpan, LayoutEntity, PositionProps } from '../../types.js';
import type { Corridor, CorridorBorderProfile, CorridorBorderSpan } from './contract.js';
import { corridorCrossSpan, corridorTravelSpan, crossSpanOf, travelSpanOf } from './geometry.js';
import { addUniqueNumber } from './sortedArrayUtils.js';

type EntityBorderSpan = Extract<CorridorBorderSpan, { kind: 'entity' }>;

/** Build one full two-sided profile when a corridor first needs border facts. */
export function buildCorridorBorderProfile(
  layoutManager: LayoutManager,
  bounds: PositionProps,
  corridor: Corridor,
  externalTextEntities: readonly LayoutEntity[],
): CorridorBorderProfile {
  const cross = corridorCrossSpan(corridor);
  const travel = corridorTravelSpan(corridor);
  const boundsCross = crossSpanOf(corridor.axis, bounds);
  const negativeIsDiagramBorder = cross[0] === boundsCross[0] || cross[0] === boundsCross[1];
  const positiveIsDiagramBorder = cross[1] === boundsCross[0] || cross[1] === boundsCross[1];
  const bodyEntities =
    negativeIsDiagramBorder && positiveIsDiagramBorder
      ? []
      : layoutManager.findEntitiesInRange(makeRangeFromEntity(corridor.rect));
  const entities = [...bodyEntities, ...externalTextEntities];
  const negative = negativeIsDiagramBorder
    ? [{ span: travel, kind: 'diagram-border' as const }]
    : entityBorderSpans(travel, entityCandidates(corridor.axis, travel, cross[0], entities));
  const positive = positiveIsDiagramBorder
    ? [{ span: travel, kind: 'diagram-border' as const }]
    : entityBorderSpans(travel, entityCandidates(corridor.axis, travel, cross[1], entities));
  return corridor.axis === 'x'
    ? { axis: 'x', top: negative, bottom: positive }
    : { axis: 'y', left: negative, right: positive };
}

function entityCandidates(
  axis: Axis,
  travel: AxisSpan,
  coordinate: number,
  entities: readonly LayoutEntity[],
): EntityBorderSpan[] {
  return entities.flatMap((entity) => {
    const entityCross = crossSpanOf(axis, entity);
    const entityTravel = travelSpanOf(axis, entity);
    if (
      (entityCross[0] !== coordinate && entityCross[1] !== coordinate) ||
      !intersectPositiveSpans(travel, entityTravel, 0)
    ) {
      return [];
    }
    return [
      {
        span: entityTravel,
        kind: 'entity' as const,
        entityId: entity.id,
      },
    ];
  });
}

function entityBorderSpans(
  border: AxisSpan,
  candidates: readonly EntityBorderSpan[],
): readonly CorridorBorderSpan[] {
  if (border[0] === border[1]) {
    return [];
  }

  const cuts: number[] = [border[0], border[1]];
  const clipped: EntityBorderSpan[] = [];

  for (const candidate of candidates) {
    const span = intersectPositiveSpans(border, candidate.span, 0);
    if (span) {
      clipped.push({ ...candidate, span });
      const index = addUniqueNumber(cuts, span[0], 0);
      addUniqueNumber(cuts, span[1], Math.max(index, 0));
    }
  }

  const result: CorridorBorderSpan[] = [];
  for (let index = 1; index < cuts.length; index += 1) {
    const span: AxisSpan = [cuts[index - 1], cuts[index]];
    if (span[1] <= span[0]) {
      continue;
    }
    const midpoint = (span[0] + span[1]) / 2;
    let winner: EntityBorderSpan | undefined;
    for (const candidate of clipped) {
      if (
        midpoint > candidate.span[0] &&
        midpoint < candidate.span[1] &&
        (!winner || candidate.entityId < winner.entityId)
      ) {
        winner = candidate;
      }
    }
    if (!winner) {
      continue;
    }
    const previous = result[result.length - 1];
    if (
      previous?.kind === 'entity' &&
      previous.entityId === winner.entityId &&
      previous.span[1] === span[0]
    ) {
      result[result.length - 1] = { ...previous, span: [previous.span[0], span[1]] };
    } else {
      result.push({ span, kind: 'entity', entityId: winner.entityId });
    }
  }
  return result;
}
