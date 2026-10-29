/**
 * Layout and routing: where entities go (placement, bumping, auto-layout, resize) and where
 * connections go (elbow, straight and arc routing, label placement). No DOM, no browser: this
 * module runs the same in Node and inside a browser bundle. Coordinates are scene-space throughout.
 *
 * The root exports the main API. Every other module is also reachable by its path, for example
 * `@eraserlabs/layout/routing/points`.
 */

// layout state and editing
export { LayoutManager } from './LayoutManager.js';
export { generateChanges, generateChangesForMove } from './calculateChanges.js';
export { makeRoomForEntities } from './bumpUtils.js';
export { getPositionForEntity } from './newPosition.js';

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
  GuidelineName,
  LayoutConnection,
  LayoutConnectionChange,
  LayoutEntity,
  LayoutRange,
  NewConnection,
  OutlineDescriptor,
  OutlineVertex,
  Port,
  TextPlacement,
  TransformHandleDirection,
} from './types.js';
export { GUIDELINE_NAME } from './types.js';
