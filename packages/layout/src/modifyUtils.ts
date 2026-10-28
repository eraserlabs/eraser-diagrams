import { LayoutEntity, LayoutChange, ModifiedEntity } from './types.js';
import { getDimensions } from './sizeUtils.js';
import type { LayoutManager } from './LayoutManager.js';

export function makeModificationChange(
  layoutManager: LayoutManager,
  existing: LayoutEntity,
  { newWidth, newHeight, newIsContainer }: ModifiedEntity,
) {
  const change: Partial<LayoutChange> = {};

  if (newWidth !== undefined && newWidth !== existing.width) {
    change.deltaWidth = newWidth - existing.width;
  }

  if (newHeight !== undefined && newHeight !== existing.height) {
    change.deltaHeight = newHeight - existing.height;
  }

  if (newIsContainer !== undefined && newIsContainer !== existing.isContainer) {
    change.isContainer = !!newIsContainer;
  }

  // For containers, we need to make sure that the width and height still include the children
  if (existing.isContainer && change.isContainer !== false) {
    const children = layoutManager.getEntitiesById(
      layoutManager.getChildIds(existing.id, true) ?? [],
    );

    const dimensions = getDimensions(children);
    const padding = layoutManager.getEntityOption(existing, 'containerPadding');

    let minWidth = dimensions.maxX - dimensions.minX + (padding?.right ?? 0) + (padding?.left ?? 0);
    const minHeight =
      dimensions.maxY - dimensions.minY + (padding?.bottom ?? 0) + (padding?.top ?? 0);

    // Also consider the container's own text placement when calculating minimum size
    if (existing.textPlacement) {
      minWidth = Math.max(
        minWidth,
        existing.textPlacement.width + existing.textPlacement.relativeX * 2,
      );
    }

    if (change.deltaHeight !== undefined) {
      change.deltaHeight = Math.max(change.deltaHeight, minHeight - existing.height);
    }

    if (change.deltaWidth !== undefined) {
      change.deltaWidth = Math.max(change.deltaWidth, minWidth - existing.width);
    }
  }

  return change;
}
