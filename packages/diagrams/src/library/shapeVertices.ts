/**
 * Polygon vertices in the template's 0–100 frame — keep in sync with the static paths in
 * Shape.html. Used by the watercolor wash (scaled ×1.5 into the 150-frame) and rounded-corner
 * path generation (scaled to the element's real box).
 */

export type Vertex = readonly [number, number];

export const POLYGON_VERTICES: Record<string, readonly Vertex[]> = {
  parallelogram: [
    [15.3846, 0],
    [100, 0],
    [84.6154, 100],
    [0, 100],
  ],
  trapezoid: [
    [20.6186, 0],
    [79.3814, 0],
    [100, 100],
    [0, 100],
  ],
  diamond: [
    [50, 0],
    [100, 50],
    [50, 100],
    [0, 50],
  ],
  hexagon: [
    [0, 50],
    [25, 99.7965],
    [75, 99.7965],
    [100, 50],
    [75, 0.2035],
    [25, 0.2035],
  ],
  triangle: [
    [50, 0],
    [0, 100],
    [100, 100],
  ],
  star: [
    [50, 0],
    [66.1641, 28.3024],
    [97.5528, 38.0041],
    [76.1541, 65.1976],
    [79.3893, 99.4959],
    [50, 88],
    [20.6107, 99.4959],
    [23.8459, 65.1976],
    [2.4472, 38.0041],
    [33.8359, 28.3024],
  ],
};
