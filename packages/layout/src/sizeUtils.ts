import type { Direction } from './types.js';
import {
  LayoutChange,
  LayoutEntity,
  LayoutConnection,
  LayoutRange,
  LayoutOptions,
  Axis,
} from './types.js';
import { addPaddingToRange, makeRangeForEntityTextPlacement, rangeIncludes } from './rangeUtils.js';
import type { LayoutManager } from './LayoutManager.js';
import { isSameAxis } from './directionUtils.js';

const EXPAND_BUFFER = 10;

type GetDimensionsOptions = {
  entityRankSpacing?: LayoutOptions['entityRankSpacing'];
  excludeTextDimensions?: boolean;
};

function detectExpandingOverlapsForContainer(
  layoutManager: LayoutManager,
  container: LayoutEntity | null | undefined,
  buffer = EXPAND_BUFFER,
): LayoutEntity[] {
  if (!container) {
    return [];
  }

  const childIds = layoutManager.getChildIds(container.id, true);
  const containerIds = layoutManager.getAllContainerIds(container.id);
  const bufferRange = {
    minX: container.x - buffer,
    minY: container.y - buffer,
    maxX: container.x + container.width + buffer,
    maxY: container.y + container.height + buffer,
  };

  return layoutManager.findEntitiesInRange(
    bufferRange,
    (candidate) =>
      !childIds?.has(candidate.id) &&
      !containerIds.includes(candidate.id) &&
      candidate.id !== container.id,
  );
}

export function getDimensions(
  entities: LayoutEntity[],
  options: GetDimensionsOptions & { pendingChanges?: Map<string, LayoutChange> } = {},
): LayoutRange {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const entity of entities) {
    const change = options.pendingChanges?.get(entity.id);
    const finalEnt = change ? applySizeChanges(entity, change, false) : entity;
    const entityDims = getEntityDimensions(finalEnt, options);
    minX = Math.min(minX, entityDims.minX);
    minY = Math.min(minY, entityDims.minY);
    maxX = Math.max(maxX, entityDims.maxX);
    maxY = Math.max(maxY, entityDims.maxY);
  }

  return { minX, minY, maxX, maxY };
}

export function getEntityDimensions(
  entity: LayoutEntity,
  options: GetDimensionsOptions = {},
): LayoutRange {
  let w = entity.width;
  let h = entity.height;
  let xDiffAfterOverride = 0;
  let yDiffAfterOverride = 0;

  if (options.entityRankSpacing && !entity.isContainer) {
    w = options.entityRankSpacing.width ?? w;
    h = options.entityRankSpacing.height ?? h;
    // As now width differs from entity.width, we need to shift the entity by half of the difference
    xDiffAfterOverride = (w - entity.width) / 2;
    yDiffAfterOverride = (h - entity.height) / 2;
  }

  const x = entity.x - xDiffAfterOverride;
  const y = entity.y - yDiffAfterOverride;

  if (!options.excludeTextDimensions) {
    const range = makeRangeForEntityTextPlacement(entity);
    const minY = Math.min(y, range?.minY ?? Infinity);
    const minX = Math.min(x, range?.minX ?? Infinity);
    const maxX = Math.max(x + w, range?.maxX ?? -Infinity);
    const maxY = Math.max(y + h, range?.maxY ?? -Infinity);

    return { minX, minY, maxX, maxY };
  }

  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

/**
 * Given a container, find all entities in the container and return the new size
 * This is a multi-purpose function, so it has many options that support:
 * - Only expanding
 * - Shrink to fit
 * - Applying pending changes that are not yet applied (@see recursivelyExpandForMove )
 */
export function getContainerSizeChanges(
  layoutManager: LayoutManager,
  container?: LayoutEntity | null,
  options?: {
    shrinkToFit?: boolean;
    pendingChanges?: Map<string, LayoutChange>;
    onlyAdjustOnChangesFromEntities?: boolean;
  },
): LayoutChange | null {
  if (!container) {
    return null;
  }

  const sizingMode = layoutManager.getEntityOption(container, 'sizingMode');
  const defaultShrink = sizingMode !== 'manual';
  const {
    shrinkToFit = defaultShrink,
    pendingChanges,
    onlyAdjustOnChangesFromEntities,
  } = options ?? {};

  // If we have pending changes and we're not forcing a shrink, check if the theoretical
  // bounds actually changed. If they didn't, we shouldn't resize the container.
  if (onlyAdjustOnChangesFromEntities && pendingChanges?.size) {
    const oldBounds = getMinContainerBounds(layoutManager, container); // without pendingChanges
    const newBounds = getMinContainerBounds(layoutManager, container, pendingChanges); // with pendingChanges

    // If the theoretical minimum bounds didn't change, don't resize
    const boundsUnchanged =
      Math.abs(oldBounds.minX - newBounds.minX) < 1 &&
      Math.abs(oldBounds.minY - newBounds.minY) < 1 &&
      Math.abs(oldBounds.maxX - newBounds.maxX) < 1 &&
      Math.abs(oldBounds.maxY - newBounds.maxY) < 1;

    if (boundsUnchanged) {
      return null;
    }
  }

  let { minX, minY, maxX, maxY } = getMinContainerBounds(layoutManager, container, pendingChanges);

  if (!shrinkToFit) {
    minX = Math.min(minX, container.x);
    minY = Math.min(minY, container.y);
    maxX = Math.max(maxX, container.x + container.width);
    maxY = Math.max(maxY, container.y + container.height);
  }

  const width = maxX - minX;
  const height = maxY - minY;

  if (
    minX === container.x &&
    minY === container.y &&
    width === container.width &&
    height === container.height
  ) {
    return null;
  }

  const containerChange: Partial<LayoutChange> = {};

  const deltaX = minX - container.x;
  const deltaY = minY - container.y;
  const deltaWidth = width - container.width;
  const deltaHeight = height - container.height;

  if (deltaX < 0 || (deltaX > 0 && shrinkToFit)) {
    containerChange.deltaX = deltaX;
  }

  if (deltaY < 0 || (deltaY > 0 && shrinkToFit)) {
    containerChange.deltaY = deltaY;
  }

  if (deltaWidth > 0 || (deltaWidth < 0 && shrinkToFit)) {
    containerChange.deltaWidth = deltaWidth;
  }

  if (deltaHeight > 0 || (deltaHeight < 0 && shrinkToFit)) {
    containerChange.deltaHeight = deltaHeight;
  }

  return containerChange;
}

export function buildChanges<T extends LayoutEntity = LayoutEntity>(
  entity: T,
  changes: LayoutChange | null | undefined,
): Partial<T> {
  if (!changes) {
    return {};
  }

  const updates: Partial<T> = {};

  if (changes.deltaX) {
    updates.x = entity.x + changes.deltaX;
  }

  if (changes.deltaY) {
    updates.y = entity.y + changes.deltaY;
  }

  if (changes.deltaWidth) {
    updates.width = entity.width + changes.deltaWidth;
  }

  if (changes.deltaHeight) {
    updates.height = entity.height + changes.deltaHeight;
  }

  if (changes.containerId !== undefined) {
    updates.containerId = changes.containerId;
  }

  if (changes.isContainer !== undefined) {
    updates.isContainer = !!changes.isContainer;
  }

  if (changes.options !== undefined) {
    updates.options = { ...(entity.options ?? {}), ...changes.options };
  }

  if (changes.textPlacement !== undefined) {
    updates.textPlacement = changes.textPlacement;
  }

  return updates;
}

export function applySizeChanges<T extends LayoutEntity = LayoutEntity>(
  entity: T,
  changes: LayoutChange | null | undefined,
  mutate: boolean,
): T {
  const updates = buildChanges(entity, changes);

  if (mutate) {
    Object.assign(entity, updates);
    return entity;
  }

  return { ...entity, ...updates };
}

export function applyConnectionChanges(
  connection: LayoutConnection,
  changes: Pick<LayoutChange, 'deltaX' | 'deltaY'> | Partial<LayoutConnection>,
  mutate: boolean,
): LayoutConnection {
  if (!changes) {
    return mutate ? connection : { ...connection };
  }

  let updates: Partial<LayoutConnection> = {};

  if ('deltaX' in changes || 'deltaY' in changes) {
    updates.x = connection.x + (changes.deltaX ?? 0);
    updates.y = connection.y + (changes.deltaY ?? 0);
  } else {
    updates = changes as Partial<LayoutConnection>;
  }

  /**
   * If we are moving x or y, we need to update the text placement also
   * If we receive a new text placement position, don't override, but do update the x / y
   */
  if (connection.textPlacement && !('textPlacement' in updates)) {
    const originalX = connection.x;
    const originalY = connection.y;
    const originalTextPlacementX = connection.textPlacement.x;
    const originalTextPlacementY = connection.textPlacement.y;

    if ('x' in updates) {
      updates.textPlacement ??= { ...connection.textPlacement };
      updates.textPlacement.x = originalTextPlacementX - originalX + (updates.x ?? 0);
    }

    if ('y' in updates) {
      updates.textPlacement ??= { ...connection.textPlacement };
      updates.textPlacement.y = originalTextPlacementY - originalY + (updates.y ?? 0);
    }
  }

  if (mutate) {
    Object.assign(connection, updates);
    return connection;
  }

  return { ...connection, ...updates };
}

/** Strip no-op fields from a LayoutChange (zero or undefined deltas). */
export function removeZeroDeltas(change: LayoutChange): LayoutChange {
  return Object.fromEntries(
    Object.entries(change).filter(([, value]) => value !== 0 && value !== undefined),
  ) as LayoutChange;
}

export function entityContainsRange(
  layoutManager: LayoutManager,
  entity: LayoutEntity,
  range: LayoutRange,
  includePadding = false,
): boolean {
  const dims = getEntityDimensions(entity, { excludeTextDimensions: false });
  const rangeWithPadding =
    entity.isContainer && includePadding
      ? addPaddingToRange(range, layoutManager.getEntityOption(entity, 'containerPadding'))
      : range;

  return rangeIncludes(dims, rangeWithPadding);
}

/**
 * Recursively resize all containers in the layout to fit their contents.
 * Processes containers from innermost to outermost by finding leaf containers first.
 * If the resize would cause an overlap, it will be cancelled and empty changes will be returned.
 * Returns final updates or null if there were overlaps and the updates should be discarded.
 */
export function recursivelyExpandForMove(
  layoutManager: LayoutManager,
  updates: Map<string, LayoutChange>,
  movingEntityIds?: Set<string>,
): Map<string, LayoutChange> | null {
  const affectedContainerIds = getAllContainerIds(layoutManager, updates.keys(), movingEntityIds);

  let finalUpdates: Map<string, LayoutChange> | null = updates;

  for (const containerId of affectedContainerIds) {
    finalUpdates = recursivelyMakeContainerUpdates(
      layoutManager,
      containerId,
      updates,
      movingEntityIds,
    );

    if (!finalUpdates) {
      return null;
    }
  }

  // If there aren't changes, remove it - this makes it easier to reason about the changes
  for (const [id, change] of finalUpdates.entries()) {
    if (!Object.keys(change).length) {
      finalUpdates.delete(id);
    }
  }

  return finalUpdates;
}

/**
 * Recursively resize a container and its parent containers to fit their contents.
 * Starts from the specified container and works outwards through parent containers.
 * Respects minimum dimensions from when dragging started.
 * If changedEntityIds is provided, only adjust the container if the changes are from the entities in the set
 * (this avoids any container changes from mis-matches in padding calculations, etc.)
 * Returns null if the resize would cause an overlap - this lets caller know to cancel the move.
 */
function recursivelyMakeContainerUpdates(
  layoutManager: LayoutManager,
  containerId: string,
  updates: Map<string, LayoutChange>,
  changedEntityIds?: Set<string>,
): Map<string, LayoutChange> | null {
  // Don't double-process the same container if two different children were affected
  if (updates.has(containerId)) {
    return updates;
  }

  const container = layoutManager.getEntityById(containerId)!;
  const sizeChanges = getContainerSizeChanges(layoutManager, container, {
    pendingChanges: updates,
    onlyAdjustOnChangesFromEntities: !!changedEntityIds,
  });

  if (!sizeChanges) {
    updates.set(containerId, {});
    return updates;
  }

  updates.set(containerId, sizeChanges);

  /**
   * @note We do the overlap check, but only if we are actually expanding
   * This is better for perf and avoids any bugs where we prevent shrinking
   */
  if (
    (sizeChanges.deltaX && sizeChanges.deltaX < 0) ||
    (sizeChanges.deltaY && sizeChanges.deltaY < 0) ||
    (sizeChanges.deltaWidth && sizeChanges.deltaWidth > 0) ||
    (sizeChanges.deltaHeight && sizeChanges.deltaHeight > 0)
  ) {
    const overlapsForContainer = detectExpandingOverlapsForContainer(
      layoutManager,
      applySizeChanges(container, sizeChanges, false),
    );

    // Overlaps are not allowed when expanding - we clear out all the changes
    if (overlapsForContainer.length) {
      return null;
    }
  }

  if (container.containerId) {
    return recursivelyMakeContainerUpdates(
      layoutManager,
      container.containerId,
      updates,
      changedEntityIds,
    );
  }

  return updates;
}

export function getAllContainerIds(
  layoutManager: LayoutManager,
  initialKeys: Iterable<string>,
  skipContainerIds?: Set<string>,
): Set<string> {
  const affectedContainerIds: Set<string> = new Set();

  for (const entityId of initialKeys) {
    const entity = layoutManager.getEntityById(entityId, false, true);

    if (entity?.containerId && !skipContainerIds?.has(entity.containerId)) {
      affectedContainerIds.add(entity.containerId);
    }
  }

  return affectedContainerIds;
}

/**
 * Utility to compute the full bounding box a container needs to encompass its children
 * given the current layout state. Unlike `getContainerSizeChanges`, this simply
 * returns the desired bounds (min / max) without generating a `LayoutChange`.
 */
export function getMinContainerBounds(
  layoutManager: LayoutManager,
  container: LayoutEntity,
  pendingChanges?: Map<string, LayoutChange>,
): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  const entities = layoutManager.getChildEntities(container.id, false);
  const dims = getDimensions(entities, { pendingChanges });
  const padding = layoutManager.getEntityOption(container, 'containerPadding');

  let { minX, minY, maxX, maxY } = addPaddingToRange(dims, padding);

  /**
   * @note When considering the text placement, we have to be very surgical
   * We want to make sure that the right-most wall is no less than relativeX (which we assume is x-padding) away
   */
  if (container.textPlacement) {
    const range = makeRangeForEntityTextPlacement(container)!;
    maxX = Math.max(maxX, range.maxX + container.textPlacement.relativeX);
    minX = Math.min(
      minX,
      maxX - container.textPlacement.width - container.textPlacement.relativeX * 2,
    );

    /**
     * If the text placement (which is always in the container... hopefully this does not change!)
     * is taller than the padding, we need to shift the container to accomodoate for that
     * @hack We treat the relativeY as the "bottom padding" below the text placement. This is because we
     * don't yet have any real configuration from it, either in layoutOptions or in the renderConfig.
     * We can figure out something holistic long-term, in the meantime this prevents shapes from being
     * right up against the text placement.
     */
    const textPlacementHeight =
      container.textPlacement.height + container.textPlacement.relativeY * 2;

    if (textPlacementHeight > padding.top) {
      minY -= textPlacementHeight - padding.top;
    }
  }

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function getDefaultMarginForDirection(
  layoutManager: LayoutManager,
  direction: Direction | Axis,
) {
  return isSameAxis(layoutManager.primaryDirection, direction)
    ? layoutManager.options.marginBetweenEntities
    : layoutManager.options.marginBetweenRanks;
}

/**
 * Find the innermost container entity whose bounds enclose the given point —
 * "innermost" defined as smallest area, a reasonable proxy for nesting depth.
 * `excludeIds` skips entities that should not be considered (e.g. the entities
 * currently being moved or resized).
 */
export function findInnermostContainerAt(
  layoutManager: LayoutManager,
  point: { x: number; y: number },
  excludeIds?: Set<string>,
): LayoutEntity | undefined {
  const candidates = layoutManager.findContainersInRange(
    { minX: point.x, maxX: point.x, minY: point.y, maxY: point.y },
    (entity) => !excludeIds?.has(entity.id),
  );

  let innermost: LayoutEntity | undefined;
  let smallestArea = Infinity;

  for (const candidate of candidates) {
    const area = candidate.width * candidate.height;
    if (area < smallestArea) {
      innermost = candidate;
      smallestArea = area;
    }
  }

  return innermost;
}

/**
 * Determine the container diff for a single moving entity based on the pointer position.
 * Returns `undefined` when there is no change (e.g. pointer is still over the same container,
 * or the current container is itself part of the moving selection so children move with it).
 */
export function getMoveEntityContainerDiff(
  layoutManager: LayoutManager,
  pointerX: number,
  pointerY: number,
  currentContainerId: string | null | undefined,
  movingEntityIds: Set<string>,
): { added?: string; removed?: string } | undefined {
  // If the current container is being moved with us, parent/children stay together.
  if (currentContainerId && movingEntityIds.has(currentContainerId)) {
    return undefined;
  }

  const nextContainer = findInnermostContainerAt(
    layoutManager,
    { x: pointerX, y: pointerY },
    movingEntityIds,
  );
  const nextContainerId = nextContainer?.id;

  if ((nextContainerId ?? null) === (currentContainerId ?? null)) {
    return undefined;
  }

  const diff: { added?: string; removed?: string } = {};
  if (nextContainerId) {
    diff.added = nextContainerId;
  }
  if (currentContainerId) {
    diff.removed = currentContainerId;
  }

  return diff;
}
