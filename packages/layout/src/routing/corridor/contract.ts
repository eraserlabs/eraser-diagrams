import type { Axis, AxisSpan, Direction, PositionProps } from '../../types.js';

export const AUTHORED_PORT_TOLERANCE_PX = 0.5;

/** One obstacle-free rectangle in one directional decomposition. */
export interface Corridor {
  /** Stable hot-path identity and position in the world's corridor array. */
  readonly index: number;
  readonly axis: Axis;
  readonly rect: PositionProps;
}

/** One canonical, non-overlapping attribution interval along a corridor border. */
export type CorridorBorderSpan =
  | {
      readonly span: AxisSpan;
      readonly kind: 'entity';
      readonly entityId: string;
    }
  | {
      readonly span: AxisSpan;
      readonly kind: 'diagram-border';
    };

export type CorridorBorderProfile =
  | {
      readonly axis: 'x';
      readonly top: readonly CorridorBorderSpan[];
      readonly bottom: readonly CorridorBorderSpan[];
    }
  | {
      readonly axis: 'y';
      readonly left: readonly CorridorBorderSpan[];
      readonly right: readonly CorridorBorderSpan[];
    };

/** A corridor after immutable world-border attribution has been attached. */
export interface ProfiledCorridor extends Corridor {
  readonly borderProfile: CorridorBorderProfile;
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
export interface TerminalAttachment {
  /** Stable hot-path identity and position in the world's attachment array. */
  readonly index: number;
  readonly entityIndex: number;
  readonly face: Direction;
  readonly corridorIndex: number;
  readonly faceSpan: AxisSpan;
}

/** Fixed endpoint facts supplied before corridor search. */
export interface RouteEndpoint {
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

/** One routing job. Human-readable connection identity remains in the batch context. */
export interface RouteSearchRequest {
  readonly requestIndex: number;
  readonly from: RouteEndpoint;
  readonly to: RouteEndpoint;
}
