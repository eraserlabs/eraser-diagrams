import { RTree } from './rtree/RTree.js';
import type { LayoutEntity, PositionProps } from './types.js';

/**
 * Named compatibility surface for layout callers using the shared R-tree.
 */
export class LayoutTree<T extends PositionProps = LayoutEntity> extends RTree<T> {}
