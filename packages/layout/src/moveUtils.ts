import { LayoutChange, LayoutEntity, LayoutRange } from './types.js';

/**
 * Given an existing entity and a new position, return the change
 * This fn is used because layoutManager only accepts deltaX/Y for updates
 * @param blockDimensions - optional, we use the dimensions relative to the block
 * @returns
 */
export function makeMoveChange(
  existing: LayoutEntity,
  { x, y, containerId }: { x: number; y: number; containerId?: string | null },
  blockDimensions?: LayoutRange,
) {
  const change: Partial<LayoutChange> = containerId !== undefined ? { containerId } : {};

  const startX = blockDimensions?.minX ?? existing.x;
  const startY = blockDimensions?.minY ?? existing.y;

  if (x !== startX) {
    change.deltaX = x - startX;
  }

  if (y !== startY) {
    change.deltaY = y - startY;
  }

  return change;
}
