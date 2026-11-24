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

/**
 * Uniformly inset rounded polygon outline (`inset` px perpendicular to every edge) for
 * `borderStyle: 'double'` (e.g. Chen identifying-relationship double diamonds). Returns null
 * when the shape is too small to inset without self-intersection.
 */
export function insetRoundedShapePath(
  kind: string,
  width: number,
  height: number,
  inset: number,
): string | null {
  const base = POLYGON_VERTICES[kind];
  const radius = CORNER_RADIUS[kind];

  if (!base || radius === undefined || base.length < 3) {
    return null;
  }

  const pts = base.map(([x, y]): Vertex => [(x * width) / 100, (y * height) / 100]);
  const n = pts.length;
  let area2 = 0;

  for (let i = 0; i < n; i += 1) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % n]!;
    area2 += ax * by - bx * ay;
  }

  // Positive signed area in SVG screen space (y down) is CW, so inward normal is (-dy, dx).
  const sign = area2 >= 0 ? 1 : -1;
  const tangents: Vertex[] = [];
  const normals: Vertex[] = [];

  for (let i = 0; i < n; i += 1) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % n]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);

    if (len < 1e-6) {
      return null;
    }

    tangents.push([dx / len, dy / len]);
    normals.push([(-sign * dy) / len, (sign * dx) / len]);
  }

  const insetPts: Vertex[] = [];

  for (let i = 0; i < n; i += 1) {
    const prev = (i - 1 + n) % n;
    const [px, py] = pts[i]!;
    const [t1x, t1y] = tangents[prev]!;
    const [t2x, t2y] = tangents[i]!;
    const [n1x, n1y] = normals[prev]!;
    const [n2x, n2y] = normals[i]!;
    const a1x = px + inset * n1x;
    const a1y = py + inset * n1y;
    const a2x = px + inset * n2x;
    const a2y = py + inset * n2y;
    const cross = t1x * t2y - t1y * t2x;

    if (Math.abs(cross) < 1e-6) {
      insetPts.push([a2x, a2y]);
      continue;
    }

    const s = ((a2x - a1x) * t2y - (a2y - a1y) * t2x) / cross;
    insetPts.push([a1x + s * t1x, a1y + s * t1y]);
  }

  // Reject degenerate insets where an edge inverted.
  for (let i = 0; i < n; i += 1) {
    const [ax, ay] = insetPts[i]!;
    const [bx, by] = insetPts[(i + 1) % n]!;
    const [tx, ty] = tangents[i]!;

    if ((bx - ax) * tx + (by - ay) * ty <= 1) {
      return null;
    }
  }

  return roundedPolygonPath(insetPts, Math.max(0, radius - inset * 0.6));
}
