/**
 * Pure line-decoration geometry shared between `@eraserlabs/render`'s full router and single-element
 * hosts (`@eraserlabs/render/fill`): double-line rail offsetting and start/end cardinality label
 * placement. Zero `@eraserlabs/layout` imports so lightweight presentation bundles stay small.
 */
import type { Box } from '@eraserlabs/render';
import { toPathData } from './roundedPath.js';

type Point = [number, number];

export function boxesOverlap(a: Box, b: Box, clearance = 0): boolean {
  return (
    a.x < b.x + b.width + clearance &&
    a.x + a.width + clearance > b.x &&
    a.y < b.y + b.height + clearance &&
    a.y + a.height + clearance > b.y
  );
}

/**
 * Place a connection endpoint label (`startLabel` / `endLabel`) beside the path near its terminal,
 * past any arrowhead marker and shifted off the stroke along the upper (or rightward for vertical
 * segments) perpendicular normal so it never overlaps the node edge, arrowhead, or line. Pass
 * `normalSign = -1` to mirror across the stroke when the two endpoint labels collide on short lines.
 */
export function placeEndpointLabel(
  points: readonly Readonly<Point>[],
  side: 'start' | 'end',
  size: { readonly width: number; readonly height: number },
  hasMarker: boolean,
  isDoubleLine: boolean,
  normalSign: 1 | -1 = 1,
): Box | undefined {
  if (
    points.length < 2 ||
    !Number.isFinite(size.width) ||
    size.width <= 0 ||
    !Number.isFinite(size.height) ||
    size.height <= 0
  ) {
    return undefined;
  }

  const totalLen = polylineLength(points);
  const inset = hasMarker ? 20 : 10;
  const atEnd = pointAtArcLengthFraction(points, side === 'start' ? 0 : 1);
  const halfAlong = projectedHalfExtent(atEnd.tangent, size.width, size.height);
  const along = Math.min(inset + halfAlong, Math.max(inset * 0.5, totalLen * 0.42));
  const fraction = totalLen > 0 ? (side === 'start' ? along / totalLen : 1 - along / totalLen) : 0;
  const { point: anchor, tangent } = pointAtArcLengthFraction(points, fraction);

  // Perpendicular normal: prefer upward (ny < 0); for vertical segments (ny === 0), prefer right.
  let nx = -tangent[1];
  let ny = tangent[0];

  if (ny > 1e-6 || (Math.abs(ny) <= 1e-6 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }

  nx *= normalSign;
  ny *= normalSign;

  const gap = isDoubleLine ? 7 : 5;
  const perp = projectedHalfExtent([nx, ny], size.width, size.height) + gap;
  const cx = anchor[0] + nx * perp;
  const cy = anchor[1] + ny * perp;

  return {
    x: cx - size.width / 2,
    y: cy - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

/**
 * Two parallel rails offset ±halfGap perpendicular to the route (Chen total participation). Keeps
 * a transparent center gap over any background, matches elbow corner rounding, and returns the
 * outer stroke bounds of both rails so PNG exports never clip thick double lines.
 */
export function doubleRailsGeometry(
  rawPoints: readonly Readonly<Point>[],
  cornerRadius: number,
  lineWidthPx: number,
): { d: string; boundsPolylines: Point[][] } | undefined {
  const pts = dedupePoints(rawPoints);

  if (pts.length < 2) {
    return undefined;
  }

  const offset = Math.max(2.2, lineWidthPx * 1.15);
  const left = offsetPolyline(pts, offset);
  const right = offsetPolyline(pts, -offset);
  const halfStroke = lineWidthPx / 2;

  return {
    d: `${toPathData(left, cornerRadius)} ${toPathData(right, cornerRadius)}`,
    boundsPolylines: [
      offsetPolyline(pts, offset + halfStroke),
      offsetPolyline(pts, -(offset + halfStroke)),
    ],
  };
}

function polylineLength(points: readonly Readonly<Point>[]): number {
  let total = 0;

  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }

  return total;
}

function projectedHalfExtent(tangent: Readonly<Point>, width: number, height: number): number {
  return (Math.abs(tangent[0]) * width) / 2 + (Math.abs(tangent[1]) * height) / 2;
}

function pointAtArcLengthFraction(
  points: readonly Readonly<Point>[],
  fraction: number,
): { point: Point; tangent: Point } {
  const clamped = Math.min(1, Math.max(0, fraction));

  if (points.length < 2) {
    const p = points[0];
    return { point: p ? [p[0], p[1]] : [0, 0], tangent: [0, 0] };
  }

  const lengths: number[] = [];
  let total = 0;

  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    lengths.push(len);
    total += len;
  }

  if (total === 0) {
    return { point: [points[0]![0], points[0]![1]], tangent: [0, 0] };
  }

  const target = clamped * total;
  let distance = 0;

  for (let i = 0; i < lengths.length; i += 1) {
    const len = lengths[i]!;

    if (distance + len >= target || i === lengths.length - 1) {
      const start = points[i]!;
      const end = points[i + 1]!;
      const ratio = len === 0 ? 0 : (target - distance) / len;
      return {
        point: [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio],
        tangent: len === 0 ? [0, 0] : [(end[0] - start[0]) / len, (end[1] - start[1]) / len],
      };
    }

    distance += len;
  }

  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  const len = Math.hypot(last[0] - prev[0], last[1] - prev[1]);

  return {
    point: [last[0], last[1]],
    tangent: len === 0 ? [0, 0] : [(last[0] - prev[0]) / len, (last[1] - prev[1]) / len],
  };
}

function dedupePoints(points: readonly Readonly<Point>[]): Point[] {
  const out: Point[] = [];

  for (const pt of points) {
    const prev = out[out.length - 1];

    if (!prev || Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 1e-4) {
      out.push([pt[0], pt[1]]);
    }
  }

  return out;
}

function offsetPolyline(points: readonly Point[], signedOffset: number): Point[] {
  const segCount = points.length - 1;
  const tangents: Point[] = [];
  const normals: Point[] = [];

  for (let i = 0; i < segCount; i += 1) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[i + 1]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const tx = (bx - ax) / len;
    const ty = (by - ay) / len;
    tangents.push([tx, ty]);
    normals.push([-ty, tx]);
  }

  const out: Point[] = [];
  const [n0x, n0y] = normals[0]!;
  out.push([points[0]![0] + signedOffset * n0x, points[0]![1] + signedOffset * n0y]);

  const miterLimit = Math.abs(signedOffset) * 3;

  for (let i = 1; i < segCount; i += 1) {
    const [px, py] = points[i]!;
    const [t1x, t1y] = tangents[i - 1]!;
    const [t2x, t2y] = tangents[i]!;
    const [n1x, n1y] = normals[i - 1]!;
    const [n2x, n2y] = normals[i]!;
    const a1x = px + signedOffset * n1x;
    const a1y = py + signedOffset * n1y;
    const a2x = px + signedOffset * n2x;
    const a2y = py + signedOffset * n2y;
    const cross = t1x * t2y - t1y * t2x;

    if (Math.abs(cross) < 1e-4) {
      out.push([a2x, a2y]);
      continue;
    }

    const s = ((a2x - a1x) * t2y - (a2y - a1y) * t2x) / cross;

    if (Math.abs(s) > miterLimit) {
      out.push([a1x, a1y], [a2x, a2y]);
    } else {
      out.push([a1x + s * t1x, a1y + s * t1y]);
    }
  }

  const [nLastX, nLastY] = normals[segCount - 1]!;
  const [ex, ey] = points[segCount]!;
  out.push([ex + signedOffset * nLastX, ey + signedOffset * nLastY]);

  return out;
}
