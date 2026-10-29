/**
 * Pure geometry for "arc" connectors: a 2-endpoint linear element plus a single
 * signed scalar `bend`. `bend` is the perpendicular distance, in element-local
 * coordinates, from the chord midpoint to the arc's apex. Sign selects the side
 * the arc bows toward. The actual circle (center / radius / sweep) is derived
 * from the two endpoints + bend, so it stays consistent as bound endpoints move.
 * Nearly coincident endpoints attenuate the visible bend without changing its
 * stored value, letting the arc collapse continuously as endpoints cross.
 *
 * @note Pure math with no imports, safe in Node and in a browser.
 */

export type ArcPoint = readonly [number, number];

/**
 * Below this many pixels of bend the arc renders as a straight line and the
 * drag handle snaps the stored bend to exactly 0. Mirrors tldraw's
 * MIN_ARROW_BEND so a near-flat arc clicks cleanly to straight.
 */
export const ARC_BEND_SNAP_THRESHOLD = 8;

const ARC_MIN_CHORD_LENGTH = 32;

const getBendScale = (start: ArcPoint, end: ArcPoint): number =>
  Math.min(1, Math.hypot(end[0] - start[0], end[1] - start[1]) / ARC_MIN_CHORD_LENGTH);

/** A connector is treated as an arc when it carries a numeric `bend`. */
export const isArcBend = (bend: number | undefined | null): bend is number =>
  typeof bend === 'number' && Number.isFinite(bend);

/** Snap a bend value to straight (0) when it is within the snap threshold. */
export const snapBend = (bend: number): number =>
  Math.abs(bend) < ARC_BEND_SNAP_THRESHOLD ? 0 : bend;

/** The chord midpoint between the two endpoints. */
export const getChordMidpoint = (start: ArcPoint, end: ArcPoint): ArcPoint => [
  (start[0] + end[0]) / 2,
  (start[1] + end[1]) / 2,
];

/** Unit perpendicular to the chord (rotated +90°, i.e. (-dy, dx) normalized). */
export const getChordPerp = (start: ArcPoint, end: ArcPoint): ArcPoint | null => {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) {
    return null;
  }
  return [-dy / len, dx / len];
};

/** Apex of the arc, attenuated for nearly coincident endpoints to avoid full-loop flips. */
export const getArcApex = (start: ArcPoint, end: ArcPoint, bend: number): ArcPoint => {
  const mid = getChordMidpoint(start, end);
  const perp = getChordPerp(start, end);
  if (!perp) {
    return mid;
  }
  const visibleBend = bend * getBendScale(start, end);
  return [mid[0] + perp[0] * visibleBend, mid[1] + perp[1] * visibleBend];
};

/**
 * Recover the signed bend from a (dragged) apex point: the component of the
 * apex's offset from the chord midpoint along the chord perpendicular.
 */
export const bendFromApex = (start: ArcPoint, end: ArcPoint, apex: ArcPoint): number => {
  const mid = getChordMidpoint(start, end);
  const perp = getChordPerp(start, end);
  if (!perp) {
    return 0;
  }
  return ((apex[0] - mid[0]) * perp[0] + (apex[1] - mid[1]) * perp[1]) / getBendScale(start, end);
};

/** A sensible default bow when a connector is first switched to arc. */
export const defaultBendForChord = (start: ArcPoint, end: ArcPoint): number => {
  const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
  return Math.max(ARC_BEND_SNAP_THRESHOLD * 3, len * 0.2);
};

/** Circumcenter of three points, or null when they are collinear. */
const circumcenter = (a: ArcPoint, b: ArcPoint, c: ArcPoint): ArcPoint | null => {
  const ax = a[0];
  const ay = a[1];
  const bx = b[0];
  const by = b[1];
  const cx = c[0];
  const cy = c[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) {
    return null;
  }
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return [ux, uy];
};

export interface ArcCircle {
  center: ArcPoint;
  radius: number;
  /** SVG arc-flags for `A radius radius 0 largeArc sweep endX endY`. */
  largeArc: 0 | 1;
  sweep: 0 | 1;
}

const TWO_PI = Math.PI * 2;

/** Normalize an angle delta into (-π, π]. */
const normalizeDelta = (delta: number): number => {
  let d = delta;
  while (d <= -Math.PI) {
    d += TWO_PI;
  }
  while (d > Math.PI) {
    d -= TWO_PI;
  }
  return d;
};

interface ArcAngles {
  center: ArcPoint;
  radius: number;
  /** Angle (radians) of the start endpoint about the center. */
  startAngle: number;
  /** Signed angular sweep from start to end passing through the apex. */
  delta: number;
}

/**
 * Center, radius and the signed angular sweep (start → apex → end) for the
 * circular arc. Null when the arc degenerates to a straight line.
 */
const getArcAngles = (start: ArcPoint, end: ArcPoint, bend: number): ArcAngles | null => {
  if (Math.abs(bend) < 1e-6) {
    return null;
  }
  const apex = getArcApex(start, end, bend);
  const center = circumcenter(start, apex, end);
  if (!center) {
    return null;
  }
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);

  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const aApex = Math.atan2(apex[1] - center[1], apex[0] - center[0]);

  const raw = normalizeDelta(a1 - a0);
  const apexOffset = normalizeDelta(aApex - a0);
  // The minor sweep from a0 to a1 passes through the apex only when the apex's
  // angular offset shares sign with `raw` and is no larger in magnitude.
  const apexOnMinorArc =
    Math.sign(apexOffset) === Math.sign(raw) && Math.abs(apexOffset) <= Math.abs(raw);
  const delta = apexOnMinorArc ? raw : raw - Math.sign(raw) * TWO_PI;

  return { center, radius, startAngle: a0, delta };
};

/**
 * Derive the circle and SVG arc flags for the true circular arc that runs from
 * `start` through the apex to `end`. Returns null when the arc degenerates to a
 * straight line (zero/near-zero bend or coincident endpoints).
 */
export const getArcCircle = (start: ArcPoint, end: ArcPoint, bend: number): ArcCircle | null => {
  const angles = getArcAngles(start, end, bend);
  if (!angles) {
    return null;
  }
  const { center, radius, delta } = angles;
  return {
    center,
    radius,
    largeArc: Math.abs(delta) > Math.PI ? 1 : 0,
    // SVG sweep-flag: 1 == increasing angle (clockwise in y-down screen space).
    sweep: delta > 0 ? 1 : 0,
  };
};

const distanceToSegment = (p: ArcPoint, a: ArcPoint, b: ArcPoint): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    return Math.hypot(p[0] - a[0], p[1] - a[1]);
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

/**
 * Shortest distance from `p` to the connector between the two endpoints,
 * following the true arc (chord segment when the bend is below the snap
 * threshold or the geometry degenerates). Cache-independent — used for
 * hit-testing arc connectors directly from `points + bend`.
 */
export const distanceToArc = (
  p: ArcPoint,
  start: ArcPoint,
  end: ArcPoint,
  bend: number,
): number => {
  const angles = Math.abs(bend) < ARC_BEND_SNAP_THRESHOLD ? null : getArcAngles(start, end, bend);
  if (!angles) {
    return distanceToSegment(p, start, end);
  }
  const { center, radius, startAngle, delta } = angles;
  const toCenter = Math.hypot(p[0] - center[0], p[1] - center[1]);
  if (toCenter < 1e-9) {
    return radius;
  }
  // Is p's angle within the arc's swept span? If so, the closest point is the
  // radial projection onto the circle; otherwise it's the nearer endpoint.
  // `delta` can exceed ±π for a major (over-bent) arc, so resolve the offset in
  // the sweep's rotational direction rather than the (-π, π] principal range.
  const pAngle = Math.atan2(p[1] - center[1], p[0] - center[0]);
  const raw = pAngle - startAngle;
  const offset =
    delta >= 0
      ? ((raw % TWO_PI) + TWO_PI) % TWO_PI // [0, 2π)
      : -(((-raw % TWO_PI) + TWO_PI) % TWO_PI); // (-2π, 0]
  const within = delta >= 0 ? offset <= delta : offset >= delta;
  if (within) {
    return Math.abs(toCenter - radius);
  }
  return Math.min(
    Math.hypot(p[0] - start[0], p[1] - start[1]),
    Math.hypot(p[0] - end[0], p[1] - end[1]),
  );
};

/**
 * Axis-aligned bounding box `[minX, minY, maxX, maxY]` of the connector between
 * the two endpoints, accounting for the arc's bulge. Falls back to the chord
 * bbox below the snap threshold or when the arc degenerates. Include the circle's
 * extrema within the sweep so even strongly bent arcs are fully contained.
 */
export const getArcBoundingBox = (
  start: ArcPoint,
  end: ArcPoint,
  bend: number,
): [number, number, number, number] => {
  let minX = Math.min(start[0], end[0]);
  let minY = Math.min(start[1], end[1]);
  let maxX = Math.max(start[0], end[0]);
  let maxY = Math.max(start[1], end[1]);

  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const angles = Math.abs(bend) < ARC_BEND_SNAP_THRESHOLD ? null : getArcAngles(start, end, bend);
  if (angles) {
    const { center, radius, startAngle, delta } = angles;
    for (let i = 0; i < 4; i++) {
      const angle = (Math.PI * i) / 2;
      const raw = (angle - startAngle) * Math.sign(delta);
      const offset = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
      if (offset <= Math.abs(delta)) {
        include(center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle));
      }
    }
  }

  return [minX, minY, maxX, maxY];
};

/** Segments used to approximate an arc as a polyline for label anchoring. */
export const ARC_LABEL_ROUTE_SAMPLES = 32;

/**
 * Sample the true arc into a polyline of `samples + 1` points from `start` to
 * `end`. Falls back to the chord `[start, end]` below the snap threshold or when
 * the geometry degenerates. The endpoints are pinned exactly so the route shares
 * its terminals with the chord regardless of sampling round-off. Used to give the
 * manual-label engine an arc-length route that follows the visible curve instead
 * of the straight chord. Output shares the caller's coordinate frame.
 */
export const getArcPolyline = (
  start: ArcPoint,
  end: ArcPoint,
  bend: number,
  samples: number = ARC_LABEL_ROUTE_SAMPLES,
): [number, number][] => {
  const angles = Math.abs(bend) < ARC_BEND_SNAP_THRESHOLD ? null : getArcAngles(start, end, bend);
  if (!angles || samples < 1) {
    return [
      [start[0], start[1]],
      [end[0], end[1]],
    ];
  }
  const { center, radius, startAngle, delta } = angles;
  const route: [number, number][] = [[start[0], start[1]]];
  for (let i = 1; i < samples; i++) {
    const t = startAngle + (delta * i) / samples;
    route.push([center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)]);
  }
  route.push([end[0], end[1]]);
  return route;
};

/**
 * Polyline route used to anchor a manually-dragged connector label. For a
 * 2-point arc it returns the sampled curve so the label resolves in arc-length
 * along the visible bow; every other connector returns its `points` unchanged
 * (the polyline already IS the visible path). `points` and the result share the
 * caller's coordinate frame.
 */
export const getConnectorLabelRoute = (
  points: readonly ArcPoint[],
  bend: number | undefined | null,
): [number, number][] => {
  if (points.length === 2 && isArcBend(bend) && Math.abs(bend) >= ARC_BEND_SNAP_THRESHOLD) {
    return getArcPolyline(points[0], points[1], bend);
  }
  return points.map((point): [number, number] => [point[0], point[1]]);
};

/**
 * SVG path `d` string for the connector between two element-local points. Falls
 * back to a straight `M…L…` when the bend is below the snap threshold or the
 * geometry degenerates, so callers can use this for both arc and straight.
 */
export const getArcPathD = (start: ArcPoint, end: ArcPoint, bend: number): string => {
  const move = `M ${start[0]} ${start[1]}`;
  const straight = `${move} L ${end[0]} ${end[1]}`;
  if (Math.abs(bend) < ARC_BEND_SNAP_THRESHOLD) {
    return straight;
  }
  const circle = getArcCircle(start, end, bend);
  if (!circle) {
    return straight;
  }
  const { radius, largeArc, sweep } = circle;
  return `${move} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end[0]} ${end[1]}`;
};
