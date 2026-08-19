/**
 * Rounded-corner polygon paths. Each vertex becomes a line to the arc start plus a circular arc;
 * radius is clamped per corner to what the shorter adjacent edge allows. Paths are generated at
 * the element's real size — baking a radius into the 0–100 template frame would distort under
 * non-uniform viewBox stretch.
 */

import { roundedCornerGeometry } from '@eraserlabs/layout';
import { POLYGON_VERTICES, type Vertex } from './shapeVertices.js';

/** Per-kind default corner radii (absolute px). */
export const CORNER_RADIUS: Record<string, number> = {
  parallelogram: 6,
  trapezoid: 8,
  diamond: 6,
  hexagon: 8,
  triangle: 6,
  star: 6,
};

function f3(n: number): number {
  return Number.parseFloat(n.toFixed(3));
}

/**
 * Closed-polygon subset of svg-round-corners roundCommands: every vertex becomes L + A. The
 * corner numbers come from the router's `roundedCornerGeometry` — the same construction that
 * clips connection endpoints to this boundary, so paint and attachment cannot drift apart.
 */
export function roundedPolygonPath(vertices: readonly Vertex[], radius: number): string {
  const n = vertices.length;
  const parts: string[] = [];

  for (let i = 0; i < n; i += 1) {
    const cur = { x: vertices[i]![0], y: vertices[i]![1] };
    const prev = { x: vertices[(i - 1 + n) % n]![0], y: vertices[(i - 1 + n) % n]![1] };
    const next = { x: vertices[(i + 1) % n]![0], y: vertices[(i + 1) % n]![1] };
    const {
      start,
      end,
      radius: r,
      betweenDeg,
      sweep,
    } = roundedCornerGeometry(prev, cur, next, radius);

    parts.push(`${i === 0 ? 'M' : 'L'}${f3(start.x)} ${f3(start.y)}`);
    parts.push(`A${f3(r)} ${f3(r)} ${f3(betweenDeg)} 0 ${sweep} ${f3(end.x)} ${f3(end.y)}`);
  }

  return `${parts.join(' ')} Z`;
}

/** Rounded path for a polygon kind at its real box size; null for non-polygon kinds. */
export function roundedShapePath(kind: string, width: number, height: number): string | null {
  const base = POLYGON_VERTICES[kind];
  const radius = CORNER_RADIUS[kind];

  if (!base || radius === undefined) {
    return null;
  }

  const scaled = base.map(([x, y]): Vertex => [(x * width) / 100, (y * height) / 100]);

  return roundedPolygonPath(scaled, radius);
}
