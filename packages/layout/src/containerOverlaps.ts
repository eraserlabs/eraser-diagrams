import type { LayoutManager } from './LayoutManager.js';
import type { LayoutEntity } from './types.js';

// Temp - just picking a number
const EXPAND_BUFFER = 10;

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
