import { Point, RelativePortPosition } from './routing/types.js';
import type { DirectionActivation } from './directionUtils.js';

export type Axis = 'x' | 'y';

/** Inclusive 1D interval on a layout axis, as `[start, end]`. */
export type AxisSpan = readonly [start: number, end: number];

/** Absolute coordinate in layout space. */
export interface XYPoint {
  x: number;
  y: number;
}

export const ALL_DIRECTIONS = ['down', 'up', 'left', 'right'] as const;
export type Direction = (typeof ALL_DIRECTIONS)[number];
export type Port = 'top' | 'bottom' | 'left' | 'right';

export type Dims = LayoutRange & { midX: number; midY: number };

export interface PositionProps {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RelativePositionProps {
  relativeX: number;
  relativeY: number;
  width: number;
  height: number;
}

/** Outline vertex in the entity's normalized 0–100 frame. */
export type OutlineVertex = readonly [number, number];

/**
 * The entity's true drawn boundary, when it is not its bounding box. Vertices live in the
 * normalized 0–100 frame and stretch with the entity box; corner radii are absolute px applied
 * after scaling — the same convention the painted geometry uses, so a radius never distorts
 * under a non-uniform stretch. `ellipse` is the box-inscribed ellipse, kept analytic so circles
 * attach exactly. Routing still treats the bounding box as the obstacle; only the terminal
 * endpoint walks inward to this boundary.
 */
export type OutlineDescriptor =
  | {
      kind: 'polygon';
      vertices: ReadonlyArray<OutlineVertex>;
      cornerRadius?: number;
      /** Radius as a percentage of the smaller box dimension; the smaller candidate wins. */
      cornerRadiusPercent?: number;
    }
  | { kind: 'ellipse' };

export interface LayoutEntity extends PositionProps {
  id: string;
  containerId?: string | null;
  isContainer?: boolean;
  options?: Partial<LayoutOptions>;
  /**
   * Allows specifying where the ports should be.
   * E.g. for cloud architecture, we might want the right / left ports to be centered on the shape
   **/
  customPorts?: Record<Direction, Point>;
  /**
   * For containers, we have text placement for the title, which should be blocking
   * It is relative because it doesn't really move freely around the entity
   */
  textPlacement?: RelativePositionProps;
  /** True drawn boundary for endpoint attachment; absent means the bounding box is the boundary. */
  outline?: OutlineDescriptor;
}

export interface TextPlacement extends PositionProps {
  entityId: string;
}

export enum LayoutConnectionTextPlacementSource {
  STORED = 'stored',
  MEASURE = 'measure',
}

export interface Placement {
  afterId?: string;
  displaceId?: string;
  displaceDirection?: Direction;
  aroundIds?: string[];
}

export interface NewEntity {
  id: string;
  width: number;
  height: number;
  containerId?: string | null;
  isContainer?: boolean;
  placement?: Placement;
  options?: Partial<LayoutOptions>;
  /**
   * @note When provided, the layout system will
   * use this position instead of auto-calculating it.
   * Useful for incremental mode where elements are
   * manually positioned.
   */
  x?: number;
  y?: number;
}

export interface MovedEntity {
  id: string;
  newContainerId?: string | null;
  newPlacement?: Placement;
}

/**
 * A MoveBlock represents multiple entities that sohuld be moved together.
 * This means they retain their position relative to each other.
 */
export interface MoveBlock {
  ids: string[];
  newContainerId?: string | null;
  newPlacement?: Placement;
}

export interface ModifiedEntity {
  id: string;
  newWidth?: number;
  newHeight?: number;
  newIsContainer?: boolean;
  newTextPlacement?: RelativePositionProps;
}

export interface DeletedEntity {
  id: string;
}

export interface LayoutConnection {
  id: string;
  /** Source entity id, or `''` for a free (unbound) endpoint anchored by `points`. */
  from: string;
  /** Target entity id, or `''` for a free (unbound) endpoint anchored by `points`. */
  to: string;
  /** Starting x */
  x: number;
  /** Starting y */
  y: number;
  /** Segment points relative to fromX / fromY */
  points: Point[];
  /** The port, in relative coordinates of the from entity */
  relativeFromPort?: RelativePortPosition;
  /** Semantic slot identity for the from-side face occupancy */
  fromPortIndex?: number;
  fromPortTotal?: number;
  /** The port, in relative coordinates of the to entity */
  relativeToPort?: RelativePortPosition;
  /** Semantic slot identity for the to-side face occupancy */
  toPortIndex?: number;
  toPortTotal?: number;
  /** Authored face hint: prefer this face for the from-endpoint. */
  authoredFromFace?: Direction;
  /** Authored face hint: prefer this face for the to-endpoint. */
  authoredToFace?: Direction;
  /** Whether the rendered source endpoint carries an arrowhead/terminal marker. */
  fromArrowhead?: boolean;
  /** Whether the rendered target endpoint carries an arrowhead/terminal marker. */
  toArrowhead?: boolean;
  /** If there is text, this is it's position (in absolute grid terms) */
  textPlacement?: PositionProps;
  /** Whether textPlacement came from an authored label position or label measurement only. */
  textPlacementSource?: LayoutConnectionTextPlacementSource;
}

export type NewConnection = Pick<LayoutConnection, 'id' | 'from' | 'to'> &
  Partial<LayoutConnection>;

export type ModifiedConnection = {
  id: string;
};

export interface DeletedConnection {
  id: string;
}

export interface LayoutRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface LayoutChange {
  deltaX?: number;
  deltaY?: number;
  deltaWidth?: number;
  deltaHeight?: number;
  containerId?: string | null;
  isContainer?: boolean;
  options?: Partial<LayoutOptions>;
  textPlacement?: RelativePositionProps;
}

export type LayoutConnectionChange =
  Partial<LayoutConnection> | Pick<LayoutChange, 'deltaX' | 'deltaY'>;

export interface LayoutOptions {
  /**
   * The default spacing between entities
   * Used when placing new entities and when bumping
   * */
  marginBetweenEntities: number;
  /**
   * If defined, this is used when doing rank-based placement.
   */
  marginBetweenRanks: number;
  /**
   * The padding for containers
   * Used when expanding or shrinking containers
   * */
  containerPadding: { top: number; right: number; bottom: number; left: number };
  /**
   * Minimum length to preserve for connections
   * Used when placing new entities and when bumping
   * */
  minConnectionLength: number;
  /**
   * Used alongside minConnectionLength to determine the distance needed
   * Used when placing new entities and when bumping
   * */
  minConnectionTextMargin: number;
  /**
   * Controls whether containers automatically shrink to fit their contents
   */
  sizingMode?: 'auto' | 'manual';
  /**
   * Whether this entity's size may be mutated to absorb an alignment conflict
   * (freeform post-processing only — the `resolveShift` bridge-stretch). Set
   * deterministically from the freeform tag in makeLayoutManager: Shape/Group
   * stretch, Icon/Text do not. Never persisted; the freeform model, Excalidraw,
   * and the LLM are oblivious to it.
   */
  stretchable?: boolean;
  /**
   * Freeform-only authored intent: this entity may intentionally sit across a
   * parent container boundary. Without this, partial boundary straddles are
   * treated as normal members and containers grow to contain them.
   */
  intentionalStraddle?: true;
  /**
   * This property is used when we want to enforce consistent spacing for ranks.
   * When used, it will override the dimensions of non-container entities for certain calculations.
   * e.g. For bumping or overlap detection, we go beyond the strict entitiy bounds,
   * but for line routing, we would not (since lines should touch the actual entity bounds).
   */
  entityRankSpacing?: { width?: number; height?: number };
  /**
   * In some cases, we want to skip the default container behavior on overlaps and do something special.
   */
  skipContainerOverlapBehavior?: boolean;
  /** Body skipped from routing grid; `textPlacement` still acts as a soft block. */
  skipRoutingObstacle?: boolean;
}

export interface OrientedPosition {
  primaryAxis: 'x' | 'y';
  orthogonalAxis: 'x' | 'y';
  primaryDirectionStart: number;
  primaryDirectionSize: number;
  orthogonalDirectionSize: number;
  orthogonalDirectionStart: number;
}

export interface LayoutChanges<T extends LayoutEntity = LayoutEntity> {
  /**
   * id -> new entity
   */
  additions: Map<string, T>;
  /**
   * id -> changes
   */
  updates: Map<string, LayoutChange>;
  /**
   * each id was deleted
   */
  deletes: Set<string>;
  /**
   * id -> new connection
   */
  addedConnections: Map<string, LayoutConnection>;
  /**
   * id -> changed connection.
   */
  updatedConnections: Map<string, LayoutConnectionChange>;
  /**
   * each id was deleted
   */
  deletedConnections: Set<string>;
}

// The children of this container (no nesting)
export type ContainerMapping = Record<string, Set<string>>;
// All parents of this entity (from immediate to root level)
export type ParentMapping = Record<string, string[]>;

/**
 * This interface covers all cases where a dragging element
 * is either overlapping or near overlapping another entity
 * This excludes cases where an element is on top of its own container.
 */
export interface OverlapEntry {
  overlappingEntityId: string;
  overlappedEntityId: string;
  /** @temp For now, we always bump in the diagrams primary direction */
  primaryDirection: Direction;
  /** The sides of the overlappedEntity that are covered (or near)  */
  overlappedSides: DirectionActivation;
  /** This is whether there is a true overlap or just near an entity */
  isOverlapping?: boolean;
  /** This is for expanding entities that are nearing other entities */
  isExpandingInBuffer?: boolean;
}

export interface MoveOrResizeState {
  /**
   * Discriminator for which operation produced this state. Consumers that need
   * to route between move-finalize and resize-finalize MUST branch on `type`
   * rather than inferring from which optional fields are populated.
   */
  type: 'move' | 'resize';
  overlaps?: OverlapEntry[];
  movingEntityIds?: Set<string>;
  resizingEntityIds?: Set<string>;
  routingConnectionIds?: Set<string>;
  /**
   * Entities whose `containerId` will change on finalize. Used by both move and
   * resize:
   *  - For move, entries are the moving entities, with `added`/`removed`
   *    naming the destination and source containers respectively.
   *  - For resize, entries can be (a) the resized container itself (its own
   *    parent may change if it ends up inside a former descendant), (b) its
   *    former direct children that are no longer enclosed, and (c) other
   *    entities whose innermost containment changed because of the resize.
   */
  entityContainerDiff?: Record<string, { added?: string; removed?: string }>;
}

export interface HandleMoveResult {
  entityUpdates: Map<string, LayoutChange>;
  connectionUpdates: Map<string, LayoutConnectionChange>;
}

// LayoutActions type: action name as key, value is argument type
export type LayoutActions = {
  containerResizeToFit: {
    containerId: string;
  };
};

export type SortedOp =
  | { opType: 'move'; op: MovedEntity }
  | { opType: 'add'; op: NewEntity }
  | { opType: 'moveBlock'; op: MoveBlock };
