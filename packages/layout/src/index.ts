/**
 * Layout state and connection routing (elbow, straight and arc lines, label placement). No DOM, no
 * browser: this module runs the same in Node and inside a browser bundle. Coordinates are
 * scene-space throughout.
 */

// layout state
export { LayoutManager } from './LayoutManager.js';

// routing
export { COMMIT_REPAIR, isDirectConnection, routeConnections } from './routing/routeConnections.js';
export type {
  ConnectionRoutingRequest,
  EndpointPins,
  RouteConnectionsArgs,
  RoutingResult,
} from './routing/routeConnections.js';
export type { RepairPolicy } from './routing/executeCorridorRouting.js';
export { anchorFromStored, resolveManualLabel } from './routing/manualLabelAnchor.js';

// arc geometry
export {
  ARC_BEND_SNAP_THRESHOLD,
  defaultBendForChord,
  getArcApex,
  getArcPathD,
  getArcPolyline,
  isArcBend,
} from './arcGeometry.js';

// geometry
export {
  addPaddingToRange,
  combineRanges,
  intersectRanges,
  makePropsFromRange,
  makeRangeFromEntity,
  shiftRange,
} from './rangeUtils.js';
export { createEntityOutline, roundedCornerGeometry } from './outline.js';
export type { CornerGeometry, EntityOutline } from './outline.js';

export type {
  ConnectorStyle,
  Direction,
  LayoutConnection,
  LayoutConnectionChange,
  LayoutEntity,
  LayoutRange,
  NewConnection,
  OutlineDescriptor,
  OutlineVertex,
  Port,
  TextPlacement,
} from './types.js';
export { LayoutConnectionTextPlacementSource } from './types.js';
