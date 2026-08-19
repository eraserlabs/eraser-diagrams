/**
 * True-boundary endpoint attachment. The router plans against bounding boxes; this module owns
 * the last inch — walking a terminal point inward from the box face to the entity's drawn
 * boundary (`LayoutEntity.outline`). Everything is closed-form: line segments, the circular
 * corner arcs of a rounded polygon, and the box-inscribed ellipse. Deterministic by
 * construction — pure float arithmetic on the descriptor, no sampling at attach time.
 *
 * `roundedCornerGeometry` is the single source of the corner-arc construction: the paint side
 * (diagrams' rounded polygon paths) consumes the same numbers, so the attached endpoint and the
 * painted outline can never drift apart.
 */

import type {
  Direction,
  LayoutEntity,
  OutlineDescriptor,
  OutlineVertex,
  PositionProps,
  XYPoint,
} from './types.js';

const EPSILON = 1e-9;

/** svg-round-corners measures angles as atan2(dx, dy) — axis-swapped on purpose; kept verbatim. */
function angle(from: XYPoint, to: XYPoint): number {
  return Math.atan2(to.x - from.x, to.y - from.y);
}

function safeTan(halfAngle: number, r: number): number {
  const v = r / Math.tan(halfAngle);

  return Number.isFinite(v) ? v : r;
}

export interface CornerGeometry {
  /** Tangent point on the edge toward the previous vertex — where the arc begins. */
  start: XYPoint;
  /** Tangent point on the edge toward the next vertex — where the arc ends. */
  end: XYPoint;
  /** Radius after the per-corner clamp to what the shorter adjacent edge allows. */
  radius: number;
  /** Turn angle in degrees, exactly as the SVG `A` command's rotation slot expects it. */
  betweenDeg: number;
  sweep: 0 | 1;
}

/**
 * One rounded corner of a closed polygon — the `svg-round-corners` construction (see
 * diagrams' roundedPolygon.ts, which renders these numbers verbatim). The vertex is replaced by
 * an arc of `radius` from `start` to `end`, both tangent points on the adjacent edges.
 */
export function roundedCornerGeometry(
  prev: XYPoint,
  cur: XYPoint,
  next: XYPoint,
  radius: number,
): CornerGeometry {
  const toPrev = angle(cur, prev);
  const toNext = angle(cur, next);
  const between = toNext - toPrev;
  const betweenDeg = between * (180 / Math.PI);

  const shortest = Math.min(
    Math.hypot(prev.x - cur.x, prev.y - cur.y),
    Math.hypot(next.x - cur.x, next.y - cur.y),
  );
  const maxRadius = Math.abs((shortest / 2) * Math.tan(between / 2));
  const r = Math.min(radius, maxRadius);

  let offset: number;
  let sweep: 0 | 1;

  if ((betweenDeg < 0 && betweenDeg >= -180) || (betweenDeg > 180 && betweenDeg < 360)) {
    offset = safeTan(between / 2, -r);
    sweep = 0;
  } else {
    offset = safeTan(between / 2, r);
    sweep = 1;
  }

  const start: XYPoint = {
    x: cur.x + Math.sin(toPrev) * offset,
    y: cur.y + Math.cos(toPrev) * offset,
  };
  const end: XYPoint = {
    x: cur.x + Math.sin(toNext) * offset,
    y: cur.y + Math.cos(toNext) * offset,
  };

  return { start, end, radius: r, betweenDeg, sweep };
}

export interface EntityOutline {
  /** Nearest boundary point walking from `origin` along `direction`; null when the ray misses. */
  intersectRay(origin: XYPoint, direction: XYPoint): XYPoint | null;
}

interface SegmentPrimitive {
  kind: 'segment';
  a: XYPoint;
  b: XYPoint;
}

interface ArcPrimitive {
  kind: 'arc';
  center: XYPoint;
  radius: number;
  /** Chord endpoints; the corner arc is the minor arc on the vertex's side of this chord. */
  chordA: XYPoint;
  chordB: XYPoint;
  vertex: XYPoint;
}

type BoundaryPrimitive = SegmentPrimitive | ArcPrimitive;

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function sideOfChord(arc: Pick<ArcPrimitive, 'chordA' | 'chordB'>, point: XYPoint): number {
  return cross(
    arc.chordB.x - arc.chordA.x,
    arc.chordB.y - arc.chordA.y,
    point.x - arc.chordA.x,
    point.y - arc.chordA.y,
  );
}

/** Circle center for a corner arc: equidistant from both tangent points, across the chord from the vertex. */
function arcCenter(start: XYPoint, end: XYPoint, radius: number, vertex: XYPoint): XYPoint | null {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const chordX = end.x - start.x;
  const chordY = end.y - start.y;
  const chordLength = Math.hypot(chordX, chordY);

  if (chordLength < EPSILON) {
    return null;
  }

  const halfChord = chordLength / 2;
  const apothem = Math.sqrt(Math.max(0, radius * radius - halfChord * halfChord));
  const normalX = (-chordY / chordLength) * apothem;
  const normalY = (chordX / chordLength) * apothem;
  const first: XYPoint = { x: midX + normalX, y: midY + normalY };
  const second: XYPoint = { x: midX - normalX, y: midY - normalY };
  const chord = { chordA: start, chordB: end };
  const vertexSide = sideOfChord(chord, vertex);

  // The arc bulges toward the vertex, so its center sits on the opposite side of the chord.
  return sideOfChord(chord, first) * vertexSide <= 0 ? first : second;
}

function raySegmentHit(
  origin: XYPoint,
  direction: XYPoint,
  segment: SegmentPrimitive,
): number | null {
  const edgeX = segment.b.x - segment.a.x;
  const edgeY = segment.b.y - segment.a.y;
  const denominator = cross(direction.x, direction.y, edgeX, edgeY);

  if (Math.abs(denominator) < EPSILON) {
    return null;
  }

  const offsetX = segment.a.x - origin.x;
  const offsetY = segment.a.y - origin.y;
  const t = cross(offsetX, offsetY, edgeX, edgeY) / denominator;
  const s = cross(offsetX, offsetY, direction.x, direction.y) / denominator;

  if (t < -EPSILON || s < -EPSILON || s > 1 + EPSILON) {
    return null;
  }

  return t;
}

function rayArcHits(origin: XYPoint, direction: XYPoint, arc: ArcPrimitive): number[] {
  const toOriginX = origin.x - arc.center.x;
  const toOriginY = origin.y - arc.center.y;
  const a = direction.x * direction.x + direction.y * direction.y;
  const b = 2 * (direction.x * toOriginX + direction.y * toOriginY);
  const c = toOriginX * toOriginX + toOriginY * toOriginY - arc.radius * arc.radius;
  const discriminant = b * b - 4 * a * c;

  if (a < EPSILON || discriminant < 0) {
    return [];
  }

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const hits: number[] = [];

  for (const t of [(-b - sqrtDiscriminant) / (2 * a), (-b + sqrtDiscriminant) / (2 * a)]) {
    if (t < -EPSILON) {
      continue;
    }

    const point: XYPoint = { x: origin.x + direction.x * t, y: origin.y + direction.y * t };
    const vertexSide = sideOfChord(arc, arc.vertex);
    const pointSide = sideOfChord(arc, point);

    // On the corner arc iff on the vertex's side of the chord (tangent points sit on it).
    if (pointSide * vertexSide >= -EPSILON) {
      hits.push(t);
    }
  }

  return hits;
}

class PolygonOutline implements EntityOutline {
  private readonly primitives: BoundaryPrimitive[];

  constructor(vertices: readonly XYPoint[], cornerRadius: number) {
    this.primitives = [];
    const corners = vertices.map((cur, index) => {
      const prev = vertices[(index - 1 + vertices.length) % vertices.length]!;
      const next = vertices[(index + 1) % vertices.length]!;

      if (cornerRadius <= EPSILON) {
        return { start: cur, end: cur, radius: 0 };
      }

      const corner = roundedCornerGeometry(prev, cur, next, cornerRadius);
      const center =
        corner.radius > EPSILON ? arcCenter(corner.start, corner.end, corner.radius, cur) : null;

      if (center) {
        this.primitives.push({
          kind: 'arc',
          center,
          radius: corner.radius,
          chordA: corner.start,
          chordB: corner.end,
          vertex: cur,
        });
      }

      return center ? corner : { start: cur, end: cur, radius: 0 };
    });

    for (const [index, corner] of corners.entries()) {
      const nextCorner = corners[(index + 1) % corners.length]!;
      const a = corner.end;
      const b = nextCorner.start;

      if (Math.hypot(b.x - a.x, b.y - a.y) > EPSILON) {
        this.primitives.push({ kind: 'segment', a, b });
      }
    }
  }

  intersectRay(origin: XYPoint, direction: XYPoint): XYPoint | null {
    let nearest: number | null = null;

    for (const primitive of this.primitives) {
      const hits =
        primitive.kind === 'segment'
          ? [raySegmentHit(origin, direction, primitive)].filter((t): t is number => t !== null)
          : rayArcHits(origin, direction, primitive);

      for (const t of hits) {
        if (nearest === null || t < nearest) {
          nearest = t;
        }
      }
    }

    if (nearest === null) {
      return null;
    }

    return { x: origin.x + direction.x * nearest, y: origin.y + direction.y * nearest };
  }
}

class EllipseOutline implements EntityOutline {
  constructor(private readonly box: PositionProps) {}

  intersectRay(origin: XYPoint, direction: XYPoint): XYPoint | null {
    const radiusX = this.box.width / 2;
    const radiusY = this.box.height / 2;

    if (radiusX < EPSILON || radiusY < EPSILON) {
      return null;
    }

    // Scale to the unit circle and solve the quadratic there.
    const centerX = this.box.x + radiusX;
    const centerY = this.box.y + radiusY;
    const originU = (origin.x - centerX) / radiusX;
    const originV = (origin.y - centerY) / radiusY;
    const directionU = direction.x / radiusX;
    const directionV = direction.y / radiusY;
    const a = directionU * directionU + directionV * directionV;
    const b = 2 * (originU * directionU + originV * directionV);
    const c = originU * originU + originV * originV - 1;
    const discriminant = b * b - 4 * a * c;

    if (a < EPSILON || discriminant < 0) {
      return null;
    }

    const sqrtDiscriminant = Math.sqrt(discriminant);
    const near = (-b - sqrtDiscriminant) / (2 * a);
    const far = (-b + sqrtDiscriminant) / (2 * a);
    const t = near >= -EPSILON ? near : far >= -EPSILON ? far : null;

    if (t === null) {
      return null;
    }

    return { x: origin.x + direction.x * t, y: origin.y + direction.y * t };
  }
}

function effectiveCornerRadius(
  descriptor: Extract<OutlineDescriptor, { kind: 'polygon' }>,
  box: PositionProps,
): number {
  const fromPercent =
    descriptor.cornerRadiusPercent !== undefined
      ? (descriptor.cornerRadiusPercent / 100) * Math.min(box.width, box.height)
      : Number.POSITIVE_INFINITY;
  const fromPx = descriptor.cornerRadius ?? Number.POSITIVE_INFINITY;
  const radius = Math.min(fromPx, fromPercent);

  return Number.isFinite(radius) ? radius : 0;
}

function scaleVertex(vertex: OutlineVertex, box: PositionProps): XYPoint {
  return {
    x: box.x + (vertex[0] / 100) * box.width,
    y: box.y + (vertex[1] / 100) * box.height,
  };
}

export function createEntityOutline(
  descriptor: OutlineDescriptor,
  box: PositionProps,
): EntityOutline | null {
  if (descriptor.kind === 'ellipse') {
    return new EllipseOutline(box);
  }

  if (descriptor.vertices.length < 3) {
    return null;
  }

  const vertices = descriptor.vertices.map((vertex) => scaleVertex(vertex, box));

  return new PolygonOutline(vertices, effectiveCornerRadius(descriptor, box));
}

const INWARD_DIRECTION: Record<Direction, XYPoint> = {
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
};

/**
 * Walk a face-plane endpoint inward to the entity's drawn boundary. Identity when the entity has
 * no outline or the inward ray misses (a graze past an extreme vertex keeps the box point).
 */
export function clipFacePointToOutline(
  entity: LayoutEntity,
  face: Direction,
  point: XYPoint,
): XYPoint {
  if (!entity.outline) {
    return point;
  }

  const outline = createEntityOutline(entity.outline, entity);

  return outline?.intersectRay(point, INWARD_DIRECTION[face]) ?? point;
}
