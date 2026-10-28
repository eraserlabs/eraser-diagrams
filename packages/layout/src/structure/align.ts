import { getAxisForDirection } from '../directionUtils.js';
import { LayoutManager } from '../LayoutManager.js';
import { LayoutEntity } from '../types.js';
import { generateChangesForMove } from '../calculateChanges.js';
import type { RepairPolicy } from '../routing/executeCorridorRouting.js';
import { RankData, Rank } from './ranks.js';

interface AlignArgs {
  layoutManager: LayoutManager;
  rankData: RankData;
  repair: RepairPolicy;
}

interface AlignResult {
  didChange: boolean;
}

/**
 * Goal: start align, in primary direction, entities that ELK (or user) might put into roughly the same column
 */
export function align({ layoutManager, rankData, repair }: AlignArgs): AlignResult {
  const axis = getAxisForDirection(layoutManager.primaryDirection);

  let didChange = false;

  for (const rank of rankData.ranks) {
    const result = alignRank(layoutManager, rankData, rank, axis, repair);
    didChange = didChange || result;
  }

  return { didChange };
}

function alignRank(
  layoutManager: LayoutManager,
  rankData: RankData,
  rank: Rank,
  axis: 'x' | 'y',
  repair: RepairPolicy,
  parentIds?: string[],
): boolean {
  let didChange = false;
  const rankIds: string[] = [];

  for (const node of rank.nodes) {
    rankIds.push(node.id);

    if (node.childRanks?.length) {
      const parentIdsForChild = parentIds ? [node.id, ...parentIds] : [node.id];
      for (const childRank of node.childRanks) {
        const result = alignRank(
          layoutManager,
          rankData,
          childRank,
          axis,
          repair,
          parentIdsForChild,
        );
        didChange = didChange || result;
      }
    }
  }

  if (rank.nodes.length <= 1) {
    return didChange;
  }

  // Recursively align internal ranks first
  const entities = layoutManager.getEntitiesById(rankIds).sort((a, b) => a[axis] - b[axis]);
  const min = entities[0][axis];

  const rangeFilter = parentIds ? (e: LayoutEntity) => !parentIds?.includes(e.id) : undefined;

  for (const entity of entities) {
    const shiftAmount = min - entity[axis];

    if (shiftAmount === 0) {
      continue;
    }

    const shift =
      axis === 'x' ? { deltaX: shiftAmount, deltaY: 0 } : { deltaY: shiftAmount, deltaX: 0 };

    /**
     * @note We need to deal with the edge case where some of the entities in this rank are fully
     * or portially overlapping in the orthogonal direction. If we start align them, it will cause overlap
     * (this seems to happen in ELK when mixing groups and nodes for some reason)
     * For now, we just bail on those entities. A better solution would be to see if we can shift in both directions.
     */
    const rangeToCheck =
      axis === 'x'
        ? { minX: min, maxX: entity.x - 1, minY: entity.y, maxY: entity.y + entity.height }
        : { minX: entity.x, maxX: entity.x + entity.width, minY: min, maxY: entity.y - 1 };

    const blockers = layoutManager.findEntitiesInRange(rangeToCheck, rangeFilter);

    if (blockers.length > 0) {
      continue;
    }

    // Check if shifting would cause the entity to overlap with any edge labels
    if (wouldOverlapEdgeLabel(layoutManager, entity, shiftAmount, axis)) {
      continue;
    }

    const entityIds = layoutManager.getChildIds(entity.id, true) ?? new Set();
    entityIds.add(entity.id);

    generateChangesForMove(layoutManager, entityIds, shift, { repair });

    didChange = true;
  }

  return didChange;
}

function wouldOverlapEdgeLabel(
  layoutManager: LayoutManager,
  entity: LayoutEntity,
  shiftAmount: number,
  axis: 'x' | 'y',
): boolean {
  const connections = layoutManager.getConnections();

  // Find connections that point TO this entity and have a text placement
  const incomingWithLabels = connections.filter((c) => c.to === entity.id && c.textPlacement);

  if (incomingWithLabels.length === 0) {
    return false;
  }

  // Calculate the entity's new bounds after the shift
  const newEntityBounds = {
    minX: entity.x + (axis === 'x' ? shiftAmount : 0),
    maxX: entity.x + entity.width + (axis === 'x' ? shiftAmount : 0),
    minY: entity.y + (axis === 'y' ? shiftAmount : 0),
    maxY: entity.y + entity.height + (axis === 'y' ? shiftAmount : 0),
  };

  for (const connection of incomingWithLabels) {
    const tp = connection.textPlacement!;
    const labelBounds = {
      minX: tp.x,
      maxX: tp.x + tp.width,
      minY: tp.y,
      maxY: tp.y + tp.height,
    };

    // Check for overlap
    const overlaps = !(
      newEntityBounds.maxX <= labelBounds.minX ||
      labelBounds.maxX <= newEntityBounds.minX ||
      newEntityBounds.maxY <= labelBounds.minY ||
      labelBounds.maxY <= newEntityBounds.minY
    );

    if (overlaps) {
      return true;
    }
  }

  return false;
}
