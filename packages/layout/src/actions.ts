import { LayoutActions } from './types.js';
import { LayoutManager } from './LayoutManager.js';
import { getContainerSizeChanges } from './sizeUtils.js';
import { routeConnections } from './routing/routeConnections.js';
import type { RepairPolicy } from './routing/executeCorridorRouting.js';

function resizeContainerToFitContents(
  layoutManager: LayoutManager,
  containerId: string,
  repair: RepairPolicy,
) {
  const container = layoutManager.getEntityById(containerId, true)!;
  const sizeChanges = getContainerSizeChanges(layoutManager, container, { shrinkToFit: true });

  if (sizeChanges) {
    sizeChanges.options = { sizingMode: 'auto' };
    layoutManager.updateEntity(containerId, sizeChanges);

    routeConnections({
      layoutManager,
      updates: new Map([[containerId, sizeChanges]]),
      repair,
    });
  }
}

export function executeLayoutAction(
  layoutManager: LayoutManager,
  actionName: keyof LayoutActions,
  action: LayoutActions,
  repair: RepairPolicy,
): void {
  switch (actionName) {
    case 'containerResizeToFit': {
      const { containerId } = action.containerResizeToFit;
      resizeContainerToFitContents(layoutManager, containerId, repair);
      break;
    }
    default:
      throw new Error(`[LayoutManager] Unknown action: ${actionName}`);
  }
}
