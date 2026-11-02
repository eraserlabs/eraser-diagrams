import type { Axis, AxisSpan, Direction, PositionProps } from '../../types.js';

export const AUTHORED_PORT_TOLERANCE_PX = 0.5;

/** One obstacle-free rectangle in one directional decomposition. */
export interface Corridor {
  /** Stable hot-path identity and position in the world's corridor array. */
  readonly index: number;
  readonly axis: Axis;
  readonly rect: PositionProps;
}

/** One geometric boundary between corridor visits. */
export type PortalRef =
  | {
      readonly kind: 'turn';
      /** Stable hot-path identity and position in the world's portal array. */
      readonly index: number;
      readonly xCorridorIndex: number;
      readonly yCorridorIndex: number;
      readonly rect: PositionProps;
    }
  | {
      readonly kind: 'continue';
      /** Stable hot-path identity and position in the world's portal array. */
      readonly index: number;
      readonly axis: Axis;
      readonly negativeCorridorIndex: number;
      readonly positiveCorridorIndex: number;
      /** Travel coordinate of the shared boundary plane between the two corridors. */
      readonly planeCoordinate: number;
      readonly crossSpan: AxisSpan;
    };

/** Pure world geometry connecting one entity face to one corridor. */
export interface FaceTerminalAttachment {
  readonly kind?: 'face';
  /** Stable hot-path identity and position in the world's attachment array. */
  readonly index: number;
  readonly entityIndex: number;
  readonly face: Direction;
  readonly corridorIndex: number;
  readonly faceSpan: AxisSpan;
}

/**
 * A zero-extent terminal at an exact point, one per corridor containing the
 * point. Fully pinned: the hosted track is the point's cross coordinate and
 * the terminal plane is the point's travel coordinate.
 */
export interface PointTerminalAttachment {
  readonly kind: 'point';
  /** Stable hot-path identity and position in the world's attachment array. */
  readonly index: number;
  readonly corridorIndex: number;
  readonly x: number;
  readonly y: number;
}

export type TerminalAttachment = FaceTerminalAttachment | PointTerminalAttachment;

export function isPointAttachment(
  attachment: TerminalAttachment,
): attachment is PointTerminalAttachment {
  return attachment.kind === 'point';
}

/** Fixed endpoint facts supplied before corridor search. */
export interface EntityRouteEndpoint {
  readonly kind?: 'entity';
  readonly entityIndex: number;
  readonly face: Direction;
  /** Whether this endpoint needs extra clearance for a rendered arrowhead. */
  readonly hasArrowhead?: boolean;
  /** Absolute coordinate on the face's varying axis when the port is authored. */
  readonly authoredTrack?: number;
  /** Hard track constraint that remains visible to endpoint quality measurement. */
  readonly repairPinTrack?: number;
  /** Soft attachment ideal derived from entity-owned port geometry after face selection. */
  readonly preferredTrack?: number;
  /** Endpoints on the same entity face with this group share one track. */
  readonly portGroup?: number;
}

/**
 * A terminal that is just a point in space — a dragged endpoint mid-gesture or a
 * free ('') connection end anchored by its stored geometry. Fully pinned: search
 * may approach along any hosting corridor; emission lands exactly on the point.
 */
export interface PointRouteEndpoint {
  readonly kind: 'point';
  readonly x: number;
  readonly y: number;
  /** Whether this endpoint needs extra clearance for a rendered arrowhead. */
  readonly hasArrowhead?: boolean;
}

export type RouteEndpoint = EntityRouteEndpoint | PointRouteEndpoint;

export function isPointEndpoint(endpoint: RouteEndpoint): endpoint is PointRouteEndpoint {
  return endpoint.kind === 'point';
}

export function pointAttachmentKey(x: number, y: number): string {
  return `${x}:${y}`;
}

/** The entity an endpoint sits on; undefined for a point endpoint. */
export function endpointEntityIndex(endpoint: RouteEndpoint): number | undefined {
  return isPointEndpoint(endpoint) ? undefined : endpoint.entityIndex;
}

/** One routing job. Human-readable connection identity remains in the batch context. */
export interface RouteSearchRequest {
  readonly requestIndex: number;
  readonly from: RouteEndpoint;
  readonly to: RouteEndpoint;
}
