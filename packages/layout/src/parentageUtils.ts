import { addToSet } from './setUtils.js';
import type { LayoutManager } from './LayoutManager.js';

export function getAllChildIds(layoutManager: LayoutManager, initialIds: string[] | Set<string>) {
  const allChildIds: Set<string> = new Set();

  for (const id of initialIds) {
    const childIds = layoutManager.getChildIds(id, true);

    if (childIds?.size) {
      addToSet(allChildIds, childIds);
    }
  }

  return allChildIds;
}
