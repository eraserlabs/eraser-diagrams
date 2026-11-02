/**
 * Entity and container dimensions, plus helpers that apply a LayoutChange to an entity or a
 * connection. Container fit and move sizing live in advancedLayout/containerSizing.
 */
import type {
  LayoutChange,
  LayoutEntity,
  LayoutConnection,
  LayoutRange,
  LayoutOptions,
  PositionProps,
} from './types.js';
import { makeRangeForEntityTextPlacement } from './rangeUtils.js';

type GetDimensionsOptions = {
  entityRankSpacing?: LayoutOptions['entityRankSpacing'];
  excludeTextDimensions?: boolean;
};

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

/** Inverse of {@link buildChanges}: position/size delta from one box to another. */
export function getLayoutChangeBetween(before: PositionProps, after: PositionProps): LayoutChange {
  return {
    deltaX: after.x - before.x,
    deltaY: after.y - before.y,
    deltaWidth: after.width - before.width,
    deltaHeight: after.height - before.height,
  };
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
