import type { LayoutManager } from './LayoutManager.js';
import type { MovedEntity, MoveBlock, LayoutEntity } from './types.js';

export function mergeMoves(
  layoutManager: LayoutManager,
  movedEntities: readonly MovedEntity[],
): {
  singleMoves: MovedEntity[];
  moveBlocks: MoveBlock[];
} {
  const singleMoves: MovedEntity[] = [];
  const moveBlocks: MoveBlock[] = [];

  const indexesById = new Map<string, number>();
  const containersById = new Map<string, string>();

  /**
   * Helper function - this is not the final determination, but it checks whether a match is even possible
   * The final check requires we know all the ids that might be involved
   */
  function isMatch(
    move: MovedEntity,
    currentEntity: LayoutEntity,
    compareAgainst: MoveBlock | MovedEntity,
  ): boolean {
    // First, the simple checks
    const firstId = 'id' in compareAgainst ? compareAgainst.id : compareAgainst.ids[0];
    const compareEntityId = containersById.get(firstId) ?? '';

    if ((currentEntity.containerId ?? '') !== compareEntityId) {
      return false;
    }

    if ((move.newContainerId ?? '') !== (compareAgainst.newContainerId ?? '')) {
      return false;
    }

    return true;
  }

  function findMatch(move: MovedEntity, currentEntity: LayoutEntity): MoveBlock | undefined {
    // TEMP: we just don't support placement changes yet
    if (move.newPlacement) {
      return undefined;
    }

    const blockMatch = moveBlocks.find((block) => isMatch(move, currentEntity, block));

    if (blockMatch) {
      return blockMatch;
    }

    const singleMatchIndex = singleMoves.findIndex((single) =>
      isMatch(move, currentEntity, single),
    );

    // Here we want to convert this single match to a block match
    if (singleMatchIndex !== -1) {
      const theMatch = singleMoves[singleMatchIndex];
      singleMoves.splice(singleMatchIndex, 1);

      const block: MoveBlock = {
        ids: [theMatch.id],
        newContainerId: theMatch.newContainerId,
        newPlacement: theMatch.newPlacement,
      };

      moveBlocks.push(block);

      return block;
    }

    return undefined;
  }

  // Ok lets start with the simple basics of merging
  for (const [index, movedEntity] of movedEntities.entries()) {
    const current = layoutManager.getEntityById(movedEntity.id);

    if (!current) {
      continue;
    }

    indexesById.set(movedEntity.id, index);
    containersById.set(movedEntity.id, current.containerId ?? '');

    const match = findMatch(movedEntity, current);

    if (match) {
      match.ids.push(movedEntity.id);
    } else {
      singleMoves.push(movedEntity);
    }
  }

  return {
    singleMoves: singleMoves.sort((a, b) => indexesById.get(a.id)! - indexesById.get(b.id)!),
    moveBlocks: moveBlocks.sort((a, b) => indexesById.get(a.ids[0])! - indexesById.get(b.ids[0])!),
  };
}
