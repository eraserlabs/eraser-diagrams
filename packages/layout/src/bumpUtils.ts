import type { Direction } from './types.js';
import { PriorityQueue } from './PriorityQueue.js';
import { addToSet } from './setUtils.js';
import type { LayoutManager } from './LayoutManager.js';
import {
  getAxisForDirection,
  getStartForDirection,
  diffToRangeInDirection,
  checkIfStartsBeyond,
  getEndForDirection,
  getEndOfRangeForDirection,
} from './directionUtils.js';
import { getAllChildIds } from './parentageUtils.js';
import {
  getContainerSizeChanges,
  getDimensions,
  getEntityDimensions,
  getDefaultMarginForDirection,
} from './sizeUtils.js';
import { LayoutConnection, LayoutEntity, LayoutRange } from './types.js';

type DirEntities = Partial<Record<Direction, LayoutEntity[]>>;

export const MAX_DISTANCE_TO_BUMPS_CONNECTED_ENTITIES = 200;

function recursivelyBumpAndExpandInDirection({
  layoutManager,
  direction,
  initialShiftTo,
  initialEntities = [],
  containerIds = [],
  skipEntityIds = new Set<string>(),
}: {
  layoutManager: LayoutManager;
  direction: Direction;
  initialEntities: LayoutEntity[];
  containerIds?: readonly string[];
  skipEntityIds?: Set<string>;
  initialShiftTo: number;
}) {
  if (!initialEntities.length && !containerIds.length) {
    return;
  }

  const axis = getAxisForDirection(direction);
  const changeKey = axis === 'x' ? 'deltaX' : 'deltaY';
  const sizeChangeKey = axis === 'x' ? 'deltaWidth' : 'deltaHeight';
  const isBackwards = direction === 'left' || direction === 'up';
  const shouldSkipContainers = layoutManager.options.skipContainerOverlapBehavior;

  /**
   * This map holds all entities that still need to be bumped and measures how much they need to be bumped by.
   * This is useful because by the time we process an entity from the queue, the bump size might have changed
   * (it should only have gone down)
   */
  const alreadyShifted: Set<string> = new Set();
  const hasBeenAdded: Set<string> = new Set();
  const surroundingContainers = shouldSkipContainers
    ? []
    : layoutManager.getEntitiesById(containerIds);
  const queue = new PriorityQueue<LayoutEntity>();

  // Gets set after first expansion or first entity shift
  let shiftDistance = 0;

  function shouldAddToQueue(entity: LayoutEntity): boolean {
    return (
      !skipEntityIds.has(entity.id) &&
      !hasBeenAdded.has(entity.id) &&
      !containerIds.includes(entity.id) &&
      !(entity.isContainer && shouldSkipContainers)
    );
  }

  function addEntity(entity: LayoutEntity) {
    if (shouldAddToQueue(entity)) {
      queue.push(entity, getStartForDirection(direction, entity));
      hasBeenAdded.add(entity.id);
    }
  }

  function doShift(entity: LayoutEntity) {
    if (alreadyShifted.has(entity.id)) {
      return;
    }

    alreadyShifted.add(entity.id);

    // Do this *before* updating the entity so that we get the current range
    addConnectedEntities(entity);

    const shiftObj = { [changeKey]: shiftDistance };
    // Important to update the entity before the range calculations below and in addConnectedEntities
    layoutManager.updateEntity(entity.id, shiftObj);

    for (const child of layoutManager.getChildEntities(entity.id, true)) {
      alreadyShifted.add(child.id);
      addConnectedEntities(child);
      layoutManager.updateEntity(child.id, shiftObj);
    }

    addSortedEntities(entity.id);
  }

  /**
   * @note There are two conflicting goals with bumping connected entities:
   * 1. If A is near B and they are connected, users probably want to preserve that distance
   * 2. We generally want to avoid bumping entities if we don't need to
   *
   * To compromise, we require two conditions:
   * 1. No "dragging" - we only bump B if it starts beyond the end of A in this direction
   * 2. Only bump B if it is within a certain distance from A
   */
  function addConnectedEntities(entity: LayoutEntity) {
    const entityEnd = getEndForDirection(direction, entity);

    for (const entry of layoutManager.getConnectedEntities(entity.id)) {
      const connectedEnt = layoutManager.getEntityById(entry.otherId);

      if (!connectedEnt || !shouldAddToQueue(connectedEnt)) {
        continue;
      }

      const connectedEntStart = getStartForDirection(direction, connectedEnt);
      const delta = connectedEntStart - entityEnd;
      const isInRightDistance =
        Math.sign(delta) === Math.sign(shiftDistance) &&
        Math.abs(delta) < MAX_DISTANCE_TO_BUMPS_CONNECTED_ENTITIES;

      if (isInRightDistance) {
        addEntity(connectedEnt);
      }
    }
  }

  function addSortedEntities(id: string) {
    const range = getEntityDimensions(layoutManager.getEntityById(id)!, {
      entityRankSpacing: layoutManager.options.entityRankSpacing,
    });
    layoutManager.findEntitiesInRange(range).forEach(addEntity);
  }

  initialEntities.forEach(addEntity);

  const MAX_ITERATIONS = 1000;
  let i = 0;
  let containerIdx = 0;

  while (!queue.isEmpty() || containerIdx < surroundingContainers.length) {
    if (i++ > MAX_ITERATIONS) {
      throw new Error('[LayoutManager] Max iterations reached when bumping entities!');
    }

    const entity = queue.peek();
    const innerMostContainer = surroundingContainers[containerIdx];

    /**
     * @note We want to expand containers once everything inside the container has been bumped
     * This check accomplishes that by seeing if the highet priority entity is beyond the bounds of the container
     */
    if (
      innerMostContainer &&
      (!entity || checkIfStartsBeyond(direction, entity, innerMostContainer))
    ) {
      containerIdx += 1;
      const containerChanges = getContainerSizeChanges(layoutManager, innerMostContainer);

      if (containerChanges) {
        // If we expand a container, the bump size can go down to whatever it was expanded by
        layoutManager.updateEntity(innerMostContainer.id, containerChanges);

        // Once we have expanded a container, we won't be bumping anything internal - skip them all
        addToSet(
          skipEntityIds,
          layoutManager.getChildEntities(innerMostContainer.id, true).map((it) => it.id),
        );

        // Now add anything that the container currently collides with
        addSortedEntities(innerMostContainer.id);

        if (!shiftDistance) {
          // When backwards, the container deltaX/deltaY is negative
          // When forwards, the container deltaWidth/deltaHeight is positive
          shiftDistance = isBackwards
            ? (containerChanges[changeKey] ?? 0)
            : (containerChanges[sizeChangeKey] ?? 0);
        }

        // Go back to the top in case something came in ahead in the queue
        continue;
      } else if (queue.isEmpty()) {
        // If we have no entities left, we are done if there is no expansion
        break;
      }
    }

    if (entity) {
      queue.pop();

      if (!shiftDistance) {
        const mult = isBackwards ? -1 : 1;
        shiftDistance = mult * Math.abs(getStartForDirection(direction, entity) - initialShiftTo);
      }
      doShift(entity);
    }
  }
}

/**
 * Determines the best direction to push each entity in (we know it overlaps the range somehow)
 * We do this by going through each valid direction.
 * If the entity pokes out of the range in the direction, use that.
 * If not, use the direction where it is closest to the end of the range.
 * @see https://app.eraser.io/workspace/xYczHKRX8QyvApgNVMzi?elements=wLA9MCgReytUfMySG5NbHg
 * @param entities
 * @param directions
 * @param range
 * @returns
 */
function sortEntitiesIntoBestDirection(
  entities: LayoutEntity[],
  directions: readonly Direction[],
  range: LayoutRange,
): DirEntities {
  const ret: DirEntities = Object.fromEntries(directions.map((dir) => [dir, []]));

  // In the simple case, everything is going in one direction
  if (directions.length === 1) {
    for (const entity of entities) {
      ret[directions[0]]?.push(entity);
    }
  } else {
    for (const entity of entities) {
      let best = 0;
      let bestDir: Direction = directions[0];

      for (const dir of directions) {
        const diff = diffToRangeInDirection(dir, entity, range);

        if (diff > best) {
          // If we are outside in this direction, then this is a good direction to push in
          bestDir = dir;
          best = diff;
        }
      }

      ret[bestDir]?.push(entity);
    }
  }

  for (const dir of directions) {
    ret[dir] = ret[dir]!.sort(
      (a, b) => getStartForDirection(dir, a) - getStartForDirection(dir, b),
    );
  }

  return ret;
}

/**
 * Walks the parent-container chain from innermost outward, growing each
 * container to fit its (now possibly out-of-bounds) children. Inner-first
 * order matters: an outer container's size check sees the freshly-resized
 * inner container.
 */
function expandContainerChain(layoutManager: LayoutManager, innermostContainerId: string) {
  const chain = [innermostContainerId, ...layoutManager.getAllContainerIds(innermostContainerId)];

  for (const id of chain) {
    const container = layoutManager.getEntityById(id);
    if (!container) {
      continue;
    }

    const sizeChanges = getContainerSizeChanges(layoutManager, container, { shrinkToFit: false });
    if (sizeChanges) {
      layoutManager.updateEntity(id, sizeChanges);
    }
  }
}

/**
 * Entry method for bumping when making room for one or more entities
 * Called when:
 * - New element is placed
 * - Existing group is expanded
 * - Element is moved and potentially overlaps other entities
 */
export function makeRoomForEntities({
  layoutManager,
  entityIds,
  directions = [layoutManager.primaryDirection],
  containerId,
  noBumping = false,
}: {
  layoutManager: LayoutManager;
  entityIds: string[];
  directions?: readonly Direction[];
  containerId?: string | null;
  /**
   * Skip sibling overlap-avoidance bumping. Parent-container expansion still
   * runs, so a new child placed outside its container still grows the container.
   */
  noBumping?: boolean;
}) {
  if (!entityIds.length) {
    return;
  }

  if (noBumping) {
    if (containerId) {
      expandContainerChain(layoutManager, containerId);
    }
    return;
  }

  const skipEntityIds = new Set([...entityIds, ...getAllChildIds(layoutManager, entityIds)]);
  const containerIds = containerId
    ? [containerId, ...layoutManager.getAllContainerIds(containerId)]
    : undefined;

  const entities = layoutManager.getEntitiesById(entityIds, true);
  const initialRange = getInitialRange(layoutManager, entities, directions);

  const inRange = layoutManager.findEntitiesInRange(
    initialRange,
    (ent) => !skipEntityIds.has(ent.id),
  );
  const sortedEntities = sortEntitiesIntoBestDirection(inRange, directions, initialRange);

  for (const direction of directions) {
    const inRangeForDir = sortedEntities[direction] ?? [];

    if (!inRangeForDir?.length && !containerIds?.length) {
      continue;
    }

    /**
     * @note We only want to bump entities in a single direction.
     * If an entity is marked as wanting shifting in another direction, we ignore it for this round.
     */
    const ignoreForDirection = new Set([...skipEntityIds]);

    for (const [otherDir, otherEntities] of Object.entries(sortedEntities)) {
      if (otherDir !== direction) {
        addToSet(
          ignoreForDirection,
          otherEntities.map((it) => it.id),
        );
      }
    }

    const initialShiftTo = getInitialShiftTo(
      layoutManager,
      direction,
      initialRange,
      entityIds,
      inRangeForDir,
    );

    recursivelyBumpAndExpandInDirection({
      layoutManager,
      direction,
      initialShiftTo,
      containerIds,
      skipEntityIds: ignoreForDirection,
      initialEntities: inRangeForDir,
    });
  }
}

function getInitialRange(
  layoutManager: LayoutManager,
  entities: LayoutEntity[],
  directions: readonly Direction[],
): LayoutRange {
  const initialRange = getDimensions(entities, {
    entityRankSpacing: layoutManager.options.entityRankSpacing,
  });

  const bufferX = getDefaultMarginForDirection(layoutManager, 'x');
  const bufferY = getDefaultMarginForDirection(layoutManager, 'y');

  if (directions.includes('left')) {
    initialRange.minX -= bufferX;
  }
  if (directions.includes('up')) {
    initialRange.minY -= bufferY;
  }
  if (directions.includes('right')) {
    initialRange.maxX += bufferX;
  }
  if (directions.includes('down')) {
    initialRange.maxY += bufferY;
  }

  return initialRange;
}

/**
 * When we first start the shift, we need to determine what the initial target is.
 * Then when the first element is shifted, that determines the shift size for all later shifts.
 * By default we use the edge of the range (which includes the margin),
 * but we might increase it to account for close connected entities that need more margin
 */
function getInitialShiftTo(
  layoutManager: LayoutManager,
  direction: Direction,
  initialRange: LayoutRange,
  entityIds: string[],
  inRangeEntitites: LayoutEntity[],
): number {
  const isBackwards = direction === 'left' || direction === 'up';
  const mult = isBackwards ? -1 : 1;
  let shiftTo = getEndOfRangeForDirection(direction, initialRange);

  for (const entity of inRangeEntitites) {
    for (const entry of layoutManager.getConnectedEntities(entity.id)) {
      if (entityIds.includes(entry.otherId)) {
        // The connectedEntity is one of the original entities we are making space for
        // We look for the end of that + (or - if backwards) the min connection length
        const connectedEntity = layoutManager.getEntityById(entry.otherId)!;
        const connectionLength =
          mult * minConnectionLength(layoutManager, entry.connection, direction);
        const target = getEndForDirection(direction, connectedEntity) + connectionLength;

        if (isBackwards ? target < shiftTo : target > shiftTo) {
          shiftTo = target;
        }
      }
    }
  }

  return shiftTo;
}

function minConnectionLength(
  layoutManager: LayoutManager,
  connection: LayoutConnection,
  direction: Direction | undefined,
) {
  if (!connection.textPlacement) {
    return layoutManager.options.minConnectionLength;
  }

  const property = direction === 'up' || direction === 'down' ? 'height' : 'width';

  return connection.textPlacement[property] + 2 * layoutManager.options.minConnectionTextMargin;
}
