/**
 * Layout geometry and the corridor connection router. No DOM, no browser — this module runs
 * identically in Node (unit tests) and inside the render bundle in Chromium. Coordinates are
 * scene-space throughout.
 */

export { LayoutManager } from './LayoutManager.js';
export { createEntityOutline, roundedCornerGeometry } from './outline.js';
export type { CornerGeometry, EntityOutline } from './outline.js';
export { routeCorridorConnectionBatch } from './routing/corridorRoutingAdapter.js';
export { anchorFromStored, resolveManualLabel } from './routing/manualLabelAnchor.js';
export { straightConnectionEndpoints } from './routing/straightConnection.js';
export type { StraightConnectionOptions } from './routing/straightConnection.js';
export type {
  CorridorConnectionBatchRoutingOptions,
  CorridorConnectionBatchRoutingResult,
  CorridorConnectionRoutingResult,
  RouteCorridorConnectionBatchArgs,
} from './routing/corridorRoutingAdapter.js';
export type {
  Direction,
  LayoutConnection,
  LayoutConnectionChange,
  LayoutEntity,
  NewConnection,
  OutlineDescriptor,
  OutlineVertex,
  Port,
  TextPlacement,
} from './types.js';
