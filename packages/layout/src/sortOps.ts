import type { LayoutManager } from './LayoutManager.js';
import type { MovedEntity, NewEntity, MoveBlock, SortedOp } from './types.js';

/**
 * Moves and odds might be interdependent - to a container or relative to another entity
 * We need to make sure that all dependencies are met before we perform an operation
 * So we sort the operations, keeping with the following rules:
 * - Always do moves before adds if possible (so that they do not affect the layout calcs)
 * - Always perform ops in the order given when possible
 *
 * NOTE: this implementation is ~O(n^2). We can optimize if needed.
 * @param layoutManager
 * @param newEntities
 * @param movedEntities
 * @returns
 */
export function sortMovesAndAdds(
  layoutManager: LayoutManager,
  newEntities: readonly NewEntity[],
  movedEntities: readonly MovedEntity[],
  moveBlocks: readonly MoveBlock[],
): SortedOp[] {
  const sortedOps: SortedOp[] = [];

  // First, we will determine the dependencies of each entity
  // When it is time to operate on that entity, we will first make sure that the dependencies exist
  const dependsOn: Map<string, Set<string>> = new Map();
  const isDependedOn: Map<string, Set<string>> = new Map();

  function addDep(id: string, dep?: string | null) {
    if (!dep || layoutManager.getEntityById(dep)) {
      return;
    }

    const arr = dependsOn.get(id);

    if (arr) {
      arr.add(dep);
    } else {
      dependsOn.set(id, new Set([dep]));
    }

    const otherArr = isDependedOn.get(dep);

    if (otherArr) {
      otherArr.add(id);
    } else {
      isDependedOn.set(dep, new Set([id]));
    }
  }

  function markDepComplete(id: string) {
    const dependOnThisId = isDependedOn.get(id);

    if (!dependOnThisId) {
      return;
    }

    for (const depId of dependOnThisId) {
      const deps = dependsOn.get(depId);

      if (deps) {
        deps.delete(id);

        if (deps.size === 0) {
          dependsOn.delete(depId);
        }
      }
    }
  }

  const remainingOps: SortedOp[] = [];

  for (const movedEntity of movedEntities) {
    addDep(movedEntity.id, movedEntity.newContainerId);
    addDep(movedEntity.id, movedEntity.newPlacement?.afterId);
    addDep(movedEntity.id, movedEntity.newPlacement?.displaceId);

    remainingOps.push({ opType: 'move', op: movedEntity });
  }

  for (const moveBlock of moveBlocks) {
    for (const id of moveBlock.ids) {
      addDep(id, moveBlock.newContainerId);
      addDep(id, moveBlock.newPlacement?.afterId);
      addDep(id, moveBlock.newPlacement?.displaceId);
    }

    remainingOps.push({ opType: 'moveBlock', op: moveBlock });
  }

  for (const newEntity of newEntities) {
    addDep(newEntity.id, newEntity.containerId);
    addDep(newEntity.id, newEntity.placement?.afterId);
    addDep(newEntity.id, newEntity.placement?.displaceId);

    remainingOps.push({ opType: 'add', op: newEntity });
  }

  let i = 0;

  while (remainingOps.length) {
    const op = remainingOps[i];
    const ids = 'ids' in op.op ? op.op.ids : [op.op.id];

    if (!ids.some((id) => dependsOn.has(id))) {
      // If we don't depend on anything, add this op to the sorted list
      // And mark it as completed for the sake of dependents
      const op = remainingOps.splice(i, 1)[0];
      sortedOps.push(op);
      ids.forEach(markDepComplete);

      // Reset - this makes sure that we are always going in order if possible
      i = 0;
    } else {
      // If we made it all the way to the end and we still have remaining ops, we have a cycle
      if (i === remainingOps.length - 1 && i > 0) {
        console.warn({
          i,
          dependsOn,
          isDependedOn,
          remainingOps: remainingOps.flatMap((o) => ('ids' in o.op ? o.op.ids : [o.op.id])),
          newEntities,
          movedEntities,
          ents: layoutManager.getEntities(),
        });
        throw new Error('[LayoutManager] Cyclic dependency detected when sorting moves and adds!');
      }

      // We have deps - go to the next item
      i += 1;
    }
  }

  return sortedOps;
}
