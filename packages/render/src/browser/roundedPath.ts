/**
 * Route path data with square or rounded corners — open-polyline twin of closed-polygon rounding
 * in `@eraserlabs/diagrams` (`library/roundedPolygon.ts`). Rounding is paint only; the polyline stays
 * the geometry of record for labels and the scene box.
 */

/** Mirrors the router's point tuple (`routing/types.ts`). */
type Point = [number, number];

/** Default elbow corner radius; each corner clamps to what its shorter leg allows. */
export const ELBOW_CORNER_RADIUS = 6;

/** Under this the arc is smaller than the path data's own rounding, so the square corner wins. */
const MIN_RADIUS = 0.01;

/** |sin| of the turn. Zero for a point that runs straight through and for one that doubles back. */
const MIN_TURN = 1e-6;

interface Corner {
  start: Point;
  end: Point;
  radius: number;
  sweep: 0 | 1;
}

/**
 * SVG path data for a route. A zero radius emits the bare polyline, byte for byte what this stage
 * produced before rounding existed, so a `straight` connection keeps its previous geometry.
 */
export function toPathData(points: readonly Point[], radius: number): string {
  const first = points[0];

  if (!first) {
    return '';
  }

  const parts: string[] = [`M${f3(first[0])} ${f3(first[1])}`];

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    // Both terminals stay exact: an arrowhead marker takes its direction from the end segment.
    const corner =
      index === points.length - 1
        ? undefined
        : roundCorner(points[index - 1]!, point, points[index + 1]!, radius);

    if (!corner) {
      parts.push(`L${f3(point[0])} ${f3(point[1])}`);
      continue;
    }

    const { start, end, radius: r, sweep } = corner;

    parts.push(
      `L${f3(start[0])} ${f3(start[1])}`,
      // rx equals ry, so the arc's x-axis rotation is a no-op and stays 0.
      `A${f3(r)} ${f3(r)} 0 0 ${sweep} ${f3(end[0])} ${f3(end[1])}`,
    );
  }

  return parts.join('');
}

function roundCorner(
  previous: Point,
  corner: Point,
  next: Point,
  radius: number,
): Corner | undefined {
  const toPrevious = angleTo(corner, previous);
  const toNext = angleTo(corner, next);
  const between = toNext - toPrevious;

  if (Math.abs(Math.sin(between)) < MIN_TURN) {
    return undefined;
  }

  const shortestLeg = Math.min(distance(previous, corner), distance(corner, next));
  // Half a leg each, so two corners that share one segment can never eat into each other.
  const cornerRadius = Math.min(radius, Math.abs((shortestLeg / 2) * Math.tan(between / 2)));

  if (cornerRadius < MIN_RADIUS) {
    return undefined;
  }

  const sweep = isSharpTurn(between * (180 / Math.PI)) ? 0 : 1;
  const offset = tangentOffset(between / 2, sweep === 0 ? -cornerRadius : cornerRadius);

  return {
    start: [corner[0] + Math.sin(toPrevious) * offset, corner[1] + Math.cos(toPrevious) * offset],
    end: [corner[0] + Math.sin(toNext) * offset, corner[1] + Math.cos(toNext) * offset],
    radius: cornerRadius,
    sweep,
  };
}

/** svg-round-corners measures angles as atan2(dx, dy) — axis-swapped on purpose; kept verbatim. */
function angleTo(from: Point, to: Point): number {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}

function distance(from: Point, to: Point): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1]);
}

/** Which side of the corner the arc centre falls on, hence which way the arc sweeps. */
function isSharpTurn(degrees: number): boolean {
  return (degrees < 0 && degrees >= -180) || (degrees > 180 && degrees < 360);
}

/** Corner to tangent point: `r / tan(half)`, which is `r` at a right angle. */
function tangentOffset(half: number, radius: number): number {
  const offset = radius / Math.tan(half);

  return Number.isFinite(offset) ? offset : radius;
}

function f3(value: number): number {
  return Number.parseFloat(value.toFixed(3));
}
