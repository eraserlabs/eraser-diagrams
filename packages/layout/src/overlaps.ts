import { addToSet } from './setUtils.js';
import { GenerateChangesArgs, generateChanges } from './calculateChanges.js';
import { DirectionActivation, OPPOSITE_DIRECTION } from './directionUtils.js';
import type { LayoutManager } from './LayoutManager.js';
import type { LayoutEntity, LayoutRange, OverlapEntry } from './types.js';
import { getEntityDimensions } from './sizeUtils.js';
import { addBufferToRange, isOverlapping } from './rangeUtils.js';

// Temp - just picking a number
const EXPAND_BUFFER = 10;

/**
 * Determine the overlaps for entities that are being moved or resized (containers that are expanding)
 */
export function calculateOverlaps(
  layoutManager: LayoutManager,
  movingEntityIds: Set<string>,
): OverlapEntry[] {
  const overlaps: OverlapEntry[] = [];
  const buffer = layoutManager.options.marginBetweenEntities; // We'll see if we want a smaller constant
  const skipContainers = layoutManager.options.skipContainerOverlapBehavior;
  const containedEntityIds: Set<string> = new Set();

  for (const entityId of movingEntityIds) {
    const childIds = layoutManager.getChildIds(entityId, true) ?? [];
    addToSet(containedEntityIds, childIds);
  }

  function isValidOverlap(entity: LayoutEntity, overlappedEntity: LayoutEntity): boolean {
    // We don't count other entities being moved or children inside of it
    if (movingEntityIds.has(overlappedEntity.id) || containedEntityIds.has(overlappedEntity.id)) {
      return false;
    }

    if (skipContainers && overlappedEntity.isContainer) {
      return false;
    }

    // We don't count containers of the entity being moved or children inside of it
    // (unclear what to do if some elements are in and some are out)
    if (
      (overlappedEntity.isContainer || entity.isContainer) &&
      layoutManager.areRelated(overlappedEntity.id, entity.id)
    ) {
      return false;
    }

    return true;
  }

  for (const entityId of movingEntityIds) {
    if (containedEntityIds.has(entityId)) {
      continue;
    }

    const entity = layoutManager.getEntityById(entityId);

    if (!entity) {
      continue;
    }

    const dimensions = getEntityDimensions(entity);
    const bufferRange = addBufferToRange({ ...dimensions }, buffer);

    const entriesInBufferRange = layoutManager.findEntitiesInRange(
      bufferRange,
      (overlappedEntity) => isValidOverlap(entity, overlappedEntity),
    );

    if (!entriesInBufferRange.length) {
      continue;
    }

    // If we overlap an outer container, we don't care if we also overlap any inner entities
    const containerIds = getContainerIds(entriesInBufferRange);
    for (const entry of entriesInBufferRange) {
      if (entry.containerId && containerIds.has(entry.containerId)) {
        continue;
      }

      const entryDimensions = getEntityDimensions(entry);

      overlaps.push({
        overlappingEntityId: entityId,
        overlappedEntityId: entry.id,
        isOverlapping: isOverlapping(dimensions, entryDimensions),
        primaryDirection: layoutManager.primaryDirection,
        overlappedSides: determineOverlappedSides(dimensions, entryDimensions),
      });
    }
  }

  return overlaps;
}

/**
 * Calculates all overlaps for all entities in the layout manager
 * Not performant! Don't call while dragging.
 */
export function calculateAllOverlaps(layoutManager: LayoutManager, buffer = 0): OverlapEntry[] {
  const overlaps: OverlapEntry[] = [];

  // Perf - cache dimensions to avoid recalculating them
  const dimensionCache = new Map<string, LayoutRange>();

  function getDimesions(entity: LayoutEntity): LayoutRange {
    const cached = dimensionCache.get(entity.id);
    if (cached) {
      return cached;
    }
    const dimensions = getEntityDimensions(entity);
    dimensionCache.set(entity.id, dimensions);
    return dimensions;
  }

  // Perf - if we already have a pairwise mapping, we don't need to
  const overlappedByEntityId = new Map<string, Set<string>>();

  function isValidOverlap(entity: LayoutEntity, overlappedEntity: LayoutEntity): boolean {
    if (entity === overlappedEntity) {
      return false;
    }

    const eId = entity.id;
    const oId = overlappedEntity.id;

    if (eId === oId) {
      return false;
    }

    const hasOverlap =
      overlappedByEntityId.get(eId)?.has(oId) || overlappedByEntityId.get(oId)?.has(eId);
    if (hasOverlap) {
      return false;
    }

    // Groups and their children naturally overlap
    if (layoutManager.areRelated(eId, oId)) {
      return false;
    }

    return true;
  }

  for (const entity of layoutManager.getEntities()) {
    const dimensions = getDimesions(entity);
    const bufferRange = buffer ? addBufferToRange({ ...dimensions }, buffer) : dimensions;

    const entriesInBufferRange = layoutManager.findEntitiesInRange(
      bufferRange,
      (overlappedEntity) => isValidOverlap(entity, overlappedEntity),
    );

    if (!entriesInBufferRange.length) {
      continue;
    }

    // If we overlap an outer container, we don't care if we also overlap any inner entities
    const containerIds = getContainerIds(entriesInBufferRange);
    for (const overlappedEntity of entriesInBufferRange) {
      if (overlappedEntity.containerId && containerIds.has(overlappedEntity.containerId)) {
        continue;
      }

      const overlappedDimensions = getDimesions(overlappedEntity);

      overlaps.push({
        overlappingEntityId: entity.id,
        overlappedEntityId: overlappedEntity.id,
        isOverlapping: isOverlapping(dimensions, overlappedDimensions),
        primaryDirection: layoutManager.primaryDirection,
        overlappedSides: determineOverlappedSides(dimensions, overlappedDimensions),
      });

      // Add the overlap so that we don't create a symmetric duplicate
      const set = overlappedByEntityId.get(entity.id);
      if (set) {
        set.add(overlappedEntity.id);
      } else {
        overlappedByEntityId.set(entity.id, new Set([overlappedEntity.id]));
      }
    }
  }

  return overlaps;
}

/**
 * Detects whether an expanding container is getting (near to) overlapping another entity.
 * Can return early if we only care whether there is or is not an overlap
 */
export function detectExpandingOverlapsForContainer(
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
    (c) => !childIds?.has(c.id) && !containerIds.includes(c.id) && c.id !== container.id,
  );
}

function getContainerIds(entities: LayoutEntity[]): Set<string> {
  const containerIds = new Set<string>();
  for (const entity of entities) {
    if (entity.isContainer) {
      containerIds.add(entity.id);
    }
  }
  return containerIds;
}

/**
 * Resolves each overlap by displacing the overlapping entity away from the overlapped one.
 * @note It is unclear if we are able to handle a layout manager that has dirty changes coming into this
 */
export function resolveOverlaps(
  layoutManager: LayoutManager,
  overlaps: OverlapEntry[],
  { routing, beforeRoute }: Pick<GenerateChangesArgs, 'routing' | 'beforeRoute'>,
): void {
  for (const overlap of overlaps) {
    const overlappingEntity = layoutManager.getEntityById(overlap.overlappingEntityId);
    const overlappedEntity = layoutManager.getEntityById(overlap.overlappedEntityId);
    if (checkShouldSkipOverlap(layoutManager, overlap, overlappingEntity, overlappedEntity)) {
      continue;
    }
    generateChanges({
      layoutManager,
      movedEntities: [
        {
          id: overlappingEntity!.id,
          newPlacement: {
            displaceId: overlappedEntity!.id,
            displaceDirection: OPPOSITE_DIRECTION[overlap.primaryDirection],
          },
        },
      ],
      routing,
      beforeRoute,
    });
  }
}

function checkShouldSkipOverlap(
  layoutManager: LayoutManager,
  overlap: OverlapEntry,
  overlappingEntity: LayoutEntity | undefined,
  overlappedEntity: LayoutEntity | undefined,
): boolean {
  if (!overlappingEntity || !overlappedEntity) {
    console.warn('[DiagramLayoutAdapter] Could not find overlapping or overlapped entity', {
      overlap,
      overlappedEntity,
      overlappingEntity,
    });
    return true;
  }

  if (!overlap.isOverlapping) {
    /** @todo Implement the snapping */
    return true;
  }

  if (layoutManager.stagedChanges?.updates.get(overlap.overlappedEntityId)) {
    console.warn('[DiagramLayoutAdapter] Skipping overlap resolution for overlapped entity', {
      overlap,
    });
    /** @hack For now we skip if we've already moved */
    /** @todo Implement the correct logic */
    return true;
  }

  if (layoutManager.stagedChanges?.updates.get(overlap.overlappingEntityId)) {
    console.warn('[DiagramLayoutAdapter] Skipping overlap resolution for overlapping entity', {
      overlap,
    });
    /** @hack For now we skip if we've already moved */
    /** @todo Implement the correct logic */
    return true;
  }

  return false;
}

function determineOverlappedSides(
  entity: LayoutRange,
  overlappedRange: LayoutRange,
): DirectionActivation {
  const overlappedSides = new Uint8Array(4);

  // Up
  if (entity.minY < overlappedRange.minY) {
    overlappedSides[0] = 1;
  }

  // Down
  if (entity.maxY > overlappedRange.maxY) {
    overlappedSides[1] = 1;
  }

  // Left
  if (entity.minX < overlappedRange.minX) {
    overlappedSides[2] = 1;
  }

  // Right
  if (entity.maxX > overlappedRange.maxX) {
    overlappedSides[3] = 1;
  }

  return overlappedSides;
}
