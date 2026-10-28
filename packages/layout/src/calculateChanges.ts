import { ALL_DIRECTIONS, type Direction } from './types.js';
import { LayoutManager } from './LayoutManager.js';
import { makeRoomForEntities } from './bumpUtils.js';
import { makeMoveChange } from './moveUtils.js';
import { makeModificationChange } from './modifyUtils.js';
import {
  getPositionForEntity,
  getPositionForEntityInContainer,
  tryToDrawGroupAroundEntities,
} from './newPosition.js';
import { getDimensions, entityContainsRange, recursivelyExpandForMove } from './sizeUtils.js';
import { sortMovesAndAdds } from './sortOps.js';
import { RankData } from './structure/ranks.js';
import { mergeMoves } from './mergeOps.js';
import {
  LayoutChanges,
  LayoutEntity,
  NewEntity,
  DeletedEntity,
  MovedEntity,
  MoveBlock,
  ModifiedEntity,
  NewConnection,
  LayoutChange,
  HandleMoveResult,
  DeletedConnection,
} from './types.js';
import { type RouteConnectionsArgs, routeConnections } from './routing/routeConnections.js';

export interface GenerateChangesArgs {
  newEntities?: readonly NewEntity[];
  movedEntities?: readonly MovedEntity[];
  deletedEntities?: readonly DeletedEntity[];
  modifiedEntities?: readonly ModifiedEntity[];
  newConnections?: readonly NewConnection[];
  deletedConnections?: readonly DeletedConnection[];
  oldRankData?: RankData;
  rankData?: RankData;
  beforeRoute?: (layoutManager: LayoutManager) => void;
  /** Shared corridor-routing policy, including the caller's repair policy. */
  routing: Omit<RouteConnectionsArgs, 'layoutManager' | 'connectionsToRoute' | 'updates'>;
  /**
   * Skip sibling overlap-avoidance bumping when staging entities. Parent
   * container expansion still runs — a new child placed outside its container
   * still grows the container. Used by freeform diagrams where users are
   * expected to manage placement themselves.
   */
  noBumping?: boolean;
}

/**
 * Does full layout calculation for new placements, etc
 */
export function generateChanges({
  layoutManager,
  newEntities = [],
  movedEntities = [],
  deletedEntities = [],
  modifiedEntities = [],
  newConnections = [],
  deletedConnections = [],
  routing,
  rankData,
  oldRankData,
  beforeRoute,
  noBumping = false,
}: GenerateChangesArgs & {
  layoutManager: LayoutManager;
}): LayoutChanges {
  const changes = layoutManager.initiateChanges();

  const { singleMoves, moveBlocks } = mergeMoves(layoutManager, movedEntities);
  // Move and add entities. Sort to ensure dependencies are met.
  const sortedMovesAndAdds = sortMovesAndAdds(layoutManager, newEntities, singleMoves, moveBlocks);

  for (const deletedConnection of deletedConnections) {
    layoutManager.removeConnection(deletedConnection.id);
  }

  for (const deletedEntity of deletedEntities) {
    layoutManager.removeEntity(deletedEntity.id);
  }

  for (const modifiedEntity of modifiedEntities) {
    modifyEntity(layoutManager, modifiedEntity, rankData, oldRankData, { noBumping });
  }

  /**
   * @note We do the rank building here - makes it easy to skip modifications
   * Modifications changing ranks are very are so we feel if we use default placement for those
   */
  for (const op of sortedMovesAndAdds) {
    if (op.opType === 'move' || op.opType === 'moveBlock') {
      moveEntity(layoutManager, op.op, rankData, oldRankData, { noBumping });
    } else if (op.opType === 'add') {
      addEntity(layoutManager, op.op, newConnections, rankData, oldRankData, { noBumping });
    }
  }

  beforeRoute?.(layoutManager);

  // Route only connections incident to existing entities updated above; all other routes stay as they are.
  routeConnections({
    layoutManager,
    updates: changes.updates,
    ...routing,
  });

  // Add new connections last to route them around existing ones.
  if (newConnections.length > 0) {
    routeConnections({
      layoutManager,
      connectionsToRoute: newConnections,
      ...routing,
    });
  }

  return changes;
}

/**
 * Simple handler for moving a group of entities by a given deltaX / deltaY
 * Does not do any bumping or modifying unrelated entities
 * Does re-route connections as needed
 * Since this is a continuous operation, we need to return the updates just for this change
 * That allows the caller to apply the changes as we go without using any of the prior changes
 * @todo It would be nice to have some kind of transaction inside of LayoutManager to automate the collection of these changes
 */
export function generateChangesForMove(
  layoutManager: LayoutManager,
  movingEntityIds: Set<string>,
  { deltaX, deltaY }: { deltaX: number; deltaY: number },
  routing: GenerateChangesArgs['routing'],
  options?: { expandContainers?: boolean },
): HandleMoveResult {
  if (!movingEntityIds || (deltaX === 0 && deltaY === 0)) {
    return { entityUpdates: new Map(), connectionUpdates: new Map() };
  }

  // Gather the updates for just this particular move
  const entityUpdates = new Map<string, LayoutChange>();

  for (const id of movingEntityIds) {
    entityUpdates.set(id, { deltaX, deltaY });
  }

  const expandContainers = options?.expandContainers ?? true;
  let finalUpdates: Map<string, LayoutChange> = entityUpdates;

  if (expandContainers) {
    const expanded = recursivelyExpandForMove(layoutManager, entityUpdates, movingEntityIds);

    // If the resize causes an overlap and is illegal, we don't apply anything and don't re-route
    if (!expanded) {
      return { entityUpdates: new Map(), connectionUpdates: new Map() };
    }

    finalUpdates = expanded;
  }

  // Actually apply the changes
  for (const [id, change] of finalUpdates.entries()) {
    layoutManager.updateEntity(id, change);
  }

  const { updates: connectionUpdates } = routeConnections({
    layoutManager,
    updates: entityUpdates,
    ...routing,
  });

  return { entityUpdates: finalUpdates, connectionUpdates };
}

/**
 * Modifies an entity without moving it
 * @note does not handle moving items out of an entity that was a container but is not anymore
 * or making sure that all items in a container are still within it
 */
export function modifyEntity(
  layoutManager: LayoutManager,
  modifiedEntity: ModifiedEntity,
  rankData?: RankData,
  oldRankData?: RankData,
  options: { noBumping?: boolean } = {},
) {
  const { id, newWidth, newHeight } = modifiedEntity;
  const existing = layoutManager.getEntityById(id, true)!;
  const change = makeModificationChange(layoutManager, existing, modifiedEntity);

  if (Object.keys(change).length === 0) {
    return;
  }

  /**
   * @edgecase Handle the case of "unwrapping" a container and re-positioning it as a regular entity
   * In this case, we want to leave all the existing container entities where they are
   */
  if (change.isContainer === false) {
    /**
     * Grab the child ids before we do any updates - we need to unset the containerId for them
     * @hack We need to use Array.from here because we mutate the containerMapping on each update
     * (Would be great not to have to worry about this...)
     */
    const childEntityIds = Array.from(layoutManager.getContainerMapping()[id]);

    const { x, y } = getPositionForEntity(layoutManager, {
      id,
      width: newWidth ?? existing.width,
      height: newHeight ?? existing.height,
    });

    const moveChange = makeMoveChange(existing, { x, y });
    layoutManager.updateEntity(id, { ...change, ...moveChange });

    for (const childId of childEntityIds ?? []) {
      layoutManager.updateEntity(childId, { containerId: null });
    }

    return;
  }

  layoutManager.updateEntity(id, change);

  const directions: Direction[] = [];

  if (change.deltaWidth !== undefined && change.deltaWidth > 0) {
    directions.push('right');
  }

  if (change.deltaHeight !== undefined && change.deltaHeight > 0) {
    directions.push('down');
  }

  if (directions.length) {
    makeRoomForEntities({
      layoutManager,
      directions,
      entityIds: [existing.id],
      containerId: existing.containerId,
      noBumping: options.noBumping,
    });
  }
}

function moveEntity(
  layoutManager: LayoutManager,
  moveOp: MoveBlock | MovedEntity,
  rankData?: RankData,
  oldRankData?: RankData,
  options: { noBumping?: boolean } = {},
) {
  const { newContainerId: containerId, newPlacement: placement } = moveOp;
  const ids: string[] = 'ids' in moveOp ? moveOp.ids : [moveOp.id];

  const existingEntities = layoutManager.getEntitiesById(ids, true);
  const container = layoutManager.getEntityById(containerId);

  /** @note in current implementation, all entities in a move block should have the same container (or none) */
  const currentContainerId = existingEntities.find((el) => el?.containerId)?.containerId;
  const existingContainer = layoutManager.getEntityById(currentContainerId);

  /** @specialcase we are "moving" out of a container that got deleted - don't do any bumping */
  if (currentContainerId && !existingContainer && !placement) {
    layoutManager.updateMany(ids, { containerId: null });
    return;
  }

  const dimensions = getDimensions(existingEntities, {
    entityRankSpacing: layoutManager.options.entityRankSpacing,
  });

  /** @specialcase moving into a container that already contains the block - just update containerId */
  if (container && entityContainsRange(layoutManager, container, dimensions, true)) {
    layoutManager.updateMany(ids, { containerId });
    return;
  }

  /**
   * @todo We should add some way to reject the move block if the dimensions are ridiculous
   * A basic heuristic is the # of elements inside the dimensions that are not
   * being moved (not part of the move block)
   * If there are a lot of them, we can reject the move
   * But in order to implement this, we need some sort of "no-go" handling
   * both in terms of the UI (displaying a cursor, etc)
   * and in terms of simulating the change so that we would know if it is invalid
   */
  const positionArg = {
    id: ids[0],
    width: dimensions.maxX - dimensions.minX,
    height: dimensions.maxY - dimensions.minY,
    containerId: container ? containerId : undefined,
    placement,
  };
  const { x, y, bumpDirection } = container
    ? getPositionForEntityInContainer(layoutManager, container, positionArg)
    : getPositionForEntity(layoutManager, positionArg, rankData);

  for (const existing of existingEntities) {
    /**
     * @note This "change" is to bring the entity from where it is (which may be mid-overlap, or very far away, etc.)
     * to where it should be (which might be taking the place of the overlapping entity).
     */
    const change = makeMoveChange(existing, { x, y, containerId }, dimensions);
    layoutManager.updateEntity(existing.id, change);
    const childIds = layoutManager.getChildIds(existing.id, true);
    layoutManager.updateMany(childIds, {
      deltaX: change.deltaX ?? 0,
      deltaY: change.deltaY ?? 0,
    });
  }

  if (bumpDirection) {
    makeRoomForEntities({
      layoutManager,
      entityIds: ids,
      directions: Array.isArray(bumpDirection) ? bumpDirection : [bumpDirection],
      containerId: containerId ?? existingEntities[0].containerId,
      noBumping: options.noBumping,
    });
  }
}

/**
 * Finds a reasonable place for a new entity and adds it to the layout
 * Does not route new connections but does account for them when determining spacing
 */
function addEntity(
  layoutManager: LayoutManager,
  newEntity: NewEntity,
  newConnections: readonly NewConnection[],
  rankData?: RankData,
  oldRankData?: RankData,
  options: { noBumping?: boolean } = {},
) {
  const { placement, ...entity } = newEntity;

  // Special case: drawing a group around existing entities
  if (newEntity.isContainer && placement?.aroundIds) {
    const drawResult = tryToDrawGroupAroundEntities(
      layoutManager,
      layoutManager.getEntitiesById(placement.aroundIds),
      newEntity.options,
    );

    if (drawResult) {
      const newEntityWithPosition: LayoutEntity = {
        ...entity,
        x: drawResult.x,
        y: drawResult.y,
        width: drawResult.width,
        height: drawResult.height,
      };

      layoutManager.addEntity(newEntityWithPosition);
      layoutManager.updateMany(placement.aroundIds, {
        containerId: newEntityWithPosition.id,
      });

      makeRoomForEntities({
        layoutManager,
        entityIds: [newEntityWithPosition.id],
        containerId: newEntity.containerId,
        directions: ALL_DIRECTIONS,
        noBumping: options.noBumping,
      });

      return;
    }
  }

  /**
   * If explicit coordinates are provided (e.g., for incremental mode with manual positioning),
   * use them directly instead of auto-calculating position.
   * However, we still need to handle overlaps and container expansion.
   */
  let x: number;
  let y: number;
  let bumpDirection: Direction | readonly Direction[] | null = null;

  if (newEntity.x !== undefined && newEntity.y !== undefined) {
    x = newEntity.x;
    y = newEntity.y;
    /**
     * @note Even with explicit positioning,
     * we may need to expand containers or resolve overlaps
     * Use ALL_DIRECTIONS to check all sides
     * for potential container expansion
     */
    bumpDirection = ALL_DIRECTIONS;
    /**
     * @todo One edge case is that when there's
     * an element near the group, increasing the
     * group size would cause the group
     * to cover that element(s).
     */
  } else {
    const positionResult = getPositionForEntity(
      layoutManager,
      newEntity,
      rankData,
      newConnections.filter((c) => c.to === newEntity.id),
    );
    x = positionResult.x;
    y = positionResult.y;
    bumpDirection = positionResult.bumpDirection;
  }

  const newEntityWithPosition: LayoutEntity = {
    ...entity,
    x,
    y,
  };

  layoutManager.addEntity(newEntityWithPosition);

  if (bumpDirection) {
    makeRoomForEntities({
      layoutManager,
      entityIds: [newEntityWithPosition.id],
      directions: typeof bumpDirection === 'string' ? [bumpDirection] : bumpDirection,
      containerId: newEntity.containerId,
      noBumping: options.noBumping,
    });
  }
}
