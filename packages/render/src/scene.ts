/**
 * Presentation geometry: what the browser stage hands the apply stage after routing. Coordinates
 * are scene-space throughout; apply translates by the scene origin when it positions DOM.
 *
 * These types describe this package's output, not the router's vocabulary — `@eraserlabs/layout` owns
 * `LayoutEntity` / `LayoutConnection` and speaks in its own terms (see browser/route.ts for the
 * mapping between the two).
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConnectionGeometry {
  /** SVG path data in scene coordinates. */
  d: string;
  /** Unrounded routed polyline in scene coordinates; consumers may derive segment constraints. */
  points: [number, number][];
  /** Where the external label is pinned: the placed label's center, else the path midpoint. */
  label: { x: number; y: number };
  /**
   * An authoritative label box in scene coordinates: either the router's placement or stored
   * authored placement on an adopted path. Absent when neither is available, in which case the
   * label falls back to the path midpoint.
   */
  labelBox?: Box;
}

export interface SceneLayout {
  boxes: Record<string, Box>;
  connections: Record<string, ConnectionGeometry>;
  /** Bounding box of everything plus padding — the canvas the apply stage sizes. */
  scene: Box;
}
