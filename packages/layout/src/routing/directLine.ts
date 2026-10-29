/**
 * Straight and arc connections: one direct segment between the two ends, never the elbow
 * router's path. An arc is the same two points and a `bend`, the signed offset of its apex off the
 * chord's middle (arcGeometry). Pure: lines and boxes in, points and a label out.
 *
 * Where the ends attach:
 * - a line with no path yet runs centre to centre, cut where it leaves each box;
 * - when a box moves, a straight line's bound end keeps its focus binding: the line through the
 *   other end keeps the same offset from the box's centre, measured in the box's own size, so the
 *   end glides along the outline as the boxes move;
 * - an arc's bound end keeps its fixed anchor: the same fraction across and down its box.
 * The bindings are read from where the line's ends are before the boxes move.
 *
 * The outline a line attaches to is the box's drawn shape where it differs from its box (a named
 * `ellipse` or `diamond` shape, else the entity's outline descriptor); every other box attaches
 * to its bounding box.
 */
import {
  ARC_BEND_SNAP_THRESHOLD,
  defaultBendForChord,
  getArcApex,
  getConnectorLabelRoute,
  isArcBend,
} from '../arcGeometry.js';
import { clipFacePointToOutline } from '../outline.js';
import { getFaceCenterPoint } from '../portUtils.js';
import type { Direction, OutlineDescriptor, PositionProps } from '../types.js';
import { type LabelBox, moveManualLabel } from './manualLabelAnchor.js';
import { labelPositionCenteredOnSegment } from './textPlacements.js';

export type Point = readonly [number, number];

/** A connector style that is drawn as one direct segment. */
export type DirectStyle = 'straight' | 'arc';

/** What the geometry reads of a box: its place and size, and its drawn shape. */
export interface DirectBox extends PositionProps {
  /** A named shape whose outline differs from its box: `ellipse` or `diamond`. */
  readonly shape?: string;
  /** The entity's drawn boundary, used when `shape` names no outline. */
  readonly outline?: OutlineDescriptor;
}

/** A straight or arc line, with its points in absolute coordinates. */
export interface DirectLine {
  readonly style: DirectStyle;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly points: readonly Point[];
  readonly bend?: number | null;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * An arc's bend: its own, else the bow a chord gets the first time it is drawn as an arc; none
 * for a straight line.
 */
export function bendOf(
  line: DirectLine,
  points: readonly Point[] = line.points,
): number | undefined {
  if (line.style !== 'arc' || points.length < 2) {
    return undefined;
  }
  return isArcBend(line.bend)
    ? line.bend
    : defaultBendForChord(points[0]!, points[points.length - 1]!);
}

/** The path a label rides on: an arc's curve, sampled; a straight line's own points. */
export function labelRoute(
  line: DirectLine,
  points: readonly Point[] = line.points,
): [number, number][] {
  return getConnectorLabelRoute(points, bendOf(line, points));
}

// ---- the outline

/** How many corners stand in for an ellipse's outline: enough that the end sits on the drawn curve. */
const ELLIPSE_STEPS = 64;

const centreOf = (box: PositionProps): Point => [box.x + box.width / 2, box.y + box.height / 2];

function ellipseOutline(box: PositionProps): Point[] {
  const [cx, cy] = centreOf(box);
  return Array.from({ length: ELLIPSE_STEPS }, (_, i) => {
    const t = (2 * Math.PI * i) / ELLIPSE_STEPS;
    return [cx + (box.width / 2) * Math.cos(t), cy + (box.height / 2) * Math.sin(t)] as const;
  });
}

/** The box's outline as a polygon, clockwise from the top left for the built-in shapes. */
export function outlineOf(box: DirectBox): Point[] {
  const { x, y, width: w, height: h } = box;
  if (box.shape === 'ellipse') {
    return ellipseOutline(box);
  }
  if (box.shape === 'diamond') {
    return [
      [x + w / 2, y],
      [x + w, y + h / 2],
      [x + w / 2, y + h],
      [x, y + h / 2],
    ];
  }
  if (box.outline?.kind === 'ellipse') {
    return ellipseOutline(box);
  }
  if (box.outline?.kind === 'polygon' && box.outline.vertices.length >= 3) {
    return box.outline.vertices.map(
      ([vx, vy]) => [x + (vx / 100) * w, y + (vy / 100) * h] as const,
    );
  }
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];

/**
 * Where the line through `a` and `b` crosses the box's outline, nearest `a` first. Empty when the
 * line misses the box.
 */
export function crossings(box: DirectBox, a: Point, b: Point): Point[] {
  const d: Point = [b[0] - a[0], b[1] - a[1]];
  if (Math.hypot(d[0], d[1]) < 1e-9) {
    return [];
  }
  const outline = outlineOf(box);
  const hits: { t: number; p: Point }[] = [];
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i]!;
    const q = outline[(i + 1) % outline.length]!;
    const e: Point = [q[0] - p[0], q[1] - p[1]];
    const denom = cross(d, e);
    if (Math.abs(denom) < 1e-12) {
      continue;
    }
    const ap: Point = [p[0] - a[0], p[1] - a[1]];
    // a + t·d = p + s·e
    const t = cross(ap, e) / denom;
    const s = cross(ap, d) / denom;
    if (s < -1e-9 || s > 1 + 1e-9) {
      continue;
    }
    const hit: Point = [a[0] + t * d[0], a[1] + t * d[1]];
    // a corner is on two edges: once is enough
    if (!hits.some((h) => Math.abs(h.p[0] - hit[0]) < 1e-6 && Math.abs(h.p[1] - hit[1]) < 1e-6)) {
      hits.push({ t, p: hit });
    }
  }
  return hits.sort((m, n) => Math.abs(m.t) - Math.abs(n.t)).map((h) => h.p);
}

/** Is the point strictly inside the box's outline (not on it)? Exact for convex outlines. */
function inside(box: DirectBox, p: Point): boolean {
  const outline = outlineOf(box);
  let sign = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const c = cross([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]]);
    if (Math.abs(c) < 1e-6) {
      return false;
    }
    if (sign === 0) {
      sign = Math.sign(c);
    } else if (Math.sign(c) !== sign) {
      return false;
    }
  }
  return true;
}

// ---- where the ends attach

/**
 * A line with no path yet, from one box to the other: centre to centre, each end where that line
 * leaves its box (the crossing nearer the other centre); a centre when it never leaves (boxes on
 * top of each other).
 */
export function centreSegment(from: DirectBox, to: DirectBox): [Point, Point] {
  const a = centreOf(from);
  const b = centreOf(to);
  const leave = (box: DirectBox, c: Point, toward: Point): Point => {
    const hits = crossings(box, c, toward);
    if (hits.length === 0) {
      return c;
    }
    const near = (p: Point) => Math.hypot(p[0] - toward[0], p[1] - toward[1]);
    return hits.reduce((best, p) => (near(p) < near(best) ? p : best));
  };
  return [leave(from, a, b), leave(to, b, a)];
}

/**
 * A line with no path whose ends name faces: a named face puts that end on the face's midpoint,
 * walked in to the drawn outline; a free end attaches where the line from its box's centre toward
 * the other end leaves the box. The far end aims at the near one already resolved, so one named
 * face tilts the whole segment toward it.
 */
export function faceAnchoredSegment(
  from: DirectBox,
  to: DirectBox,
  fromFace: Direction | undefined,
  toFace: Direction | undefined,
): [Point, Point] {
  const towardTarget = toFace ? facePoint(to, toFace) : centreOf(to);
  const start = fromFace ? facePoint(from, fromFace) : boundaryToward(from, towardTarget);
  const end = toFace ? towardTarget : boundaryToward(to, start);
  return [start, end];
}

function facePoint(box: DirectBox, face: Direction): Point {
  const [x, y] = getFaceCenterPoint({ id: '', ...box }, face);
  const clipped = clipFacePointToOutline({ id: '', ...box }, face, { x, y });
  return [clipped.x, clipped.y];
}

/** Where the ray from the box's centre toward `target` leaves its outline; the centre when it cannot. */
function boundaryToward(box: DirectBox, target: Point): Point {
  const c = centreOf(box);
  const hits = crossings(box, c, target).filter(
    (h) => (h[0] - c[0]) * (target[0] - c[0]) + (h[1] - c[1]) * (target[1] - c[1]) > 0,
  );
  return hits[0] ?? c;
}

/**
 * An end's focus binding: `focus` is how far the line passes from the box's centre, measured in
 * the box's own extent across the line (−1 and 1 graze the outline, 0 runs through the centre);
 * `far` says the end sits on the outline's far crossing, past the centre.
 */
export interface Focus {
  readonly focus: number;
  readonly far: boolean;
}

/** How far the outline reaches from the centre along the unit normal `n` (the support of the shape). */
function reach(box: DirectBox, n: Point): number {
  const c = centreOf(box);
  return Math.max(...outlineOf(box).map((v) => n[0] * (v[0] - c[0]) + n[1] * (v[1] - c[1])));
}

/** The focus binding of the end at `edge`, the line coming from `adjacent`. */
export function focusOf(box: DirectBox, adjacent: Point, edge: Point): Focus {
  const length = Math.hypot(edge[0] - adjacent[0], edge[1] - adjacent[1]);
  if (length < 1e-9) {
    return { focus: 0, far: false };
  }
  const d: Point = [(edge[0] - adjacent[0]) / length, (edge[1] - adjacent[1]) / length];
  const c = centreOf(box);
  const extent = reach(box, [-d[1], d[0]]);
  const focus =
    extent < 1e-9 ? 0 : clamp(cross(d, [adjacent[0] - c[0], adjacent[1] - c[1]]) / extent, -1, 1);
  const hits = crossings(box, adjacent, edge);
  const off = (p: Point) => Math.hypot(p[0] - edge[0], p[1] - edge[1]);
  return { focus, far: hits.length > 1 && off(hits[1]!) < off(hits[0]!) };
}

/**
 * The end on `box` for its focus binding, the line now coming from `adjacent`: the line from
 * `adjacent` that grazes the box shrunk by the focus about its centre (on the focus's side), where
 * it crosses the outline. Null when it misses the box.
 */
export function snapToFocus(box: DirectBox, focus: Focus, adjacent: Point): Point | null {
  const c = centreOf(box);
  let through: Point = c;
  if (focus.focus !== 0) {
    const scale = Math.abs(focus.focus);
    const side = Math.sign(focus.focus);
    const toCentre: Point = [adjacent[0] - c[0], adjacent[1] - c[1]];
    let best = Number.NEGATIVE_INFINITY;
    for (const v of outlineOf(box)) {
      const k: Point = [c[0] + (v[0] - c[0]) * scale, c[1] + (v[1] - c[1]) * scale];
      const length = Math.hypot(k[0] - adjacent[0], k[1] - adjacent[1]);
      if (length < 1e-9) {
        continue;
      }
      const offset =
        side * cross([(k[0] - adjacent[0]) / length, (k[1] - adjacent[1]) / length], toCentre);
      if (offset > best) {
        best = offset;
        through = k;
      }
    }
  }
  const hits = crossings(box, adjacent, through);
  if (hits.length === 0) {
    return null;
  }
  return focus.far ? (hits[1] ?? hits[0]!) : hits[0]!;
}

/** An arc end's fixed anchor: the fraction across and down its box the end sits at. */
export function anchorOf(box: PositionProps, p: Point): Point {
  return [
    box.width === 0 ? 0.5 : (p[0] - box.x) / box.width,
    box.height === 0 ? 0.5 : (p[1] - box.y) / box.height,
  ];
}

/** The point at a fixed anchor of the box as it is now. */
export function anchorPoint(box: PositionProps, anchor: Point): Point {
  return [box.x + anchor[0] * box.width, box.y + anchor[1] * box.height];
}

/** How each bound end of a straight or arc line holds to its box. */
export interface EndBinding {
  readonly focus: Focus;
  readonly anchor: Point;
}
export interface DirectBinding {
  readonly from?: EndBinding;
  readonly to?: EndBinding;
}

/** The line's bindings, read from where its ends are now. */
export function bindingOf(
  line: DirectLine,
  boxOf: (id: string) => DirectBox | undefined,
): DirectBinding {
  const pts = line.points;
  if (pts.length < 2) {
    return {};
  }
  const start = pts[0]!;
  const end = pts[pts.length - 1]!;
  const fromBox = line.from ? boxOf(line.from) : undefined;
  const toBox = line.to ? boxOf(line.to) : undefined;
  return {
    ...(fromBox
      ? { from: { focus: focusOf(fromBox, end, start), anchor: anchorOf(fromBox, start) } }
      : {}),
    ...(toBox ? { to: { focus: focusOf(toBox, start, end), anchor: anchorOf(toBox, end) } } : {}),
  };
}

/**
 * The line's two ends once its boxes have moved: an arc's bound ends at their fixed anchors; a
 * straight line's bound ends snapped from their focus bindings, the start against the end where it
 * was, then the end against the new start; a free end stays where it is. An end that cannot be
 * snapped (the line misses the box) stays where it was.
 */
export function followBoxes(
  line: DirectLine,
  binding: DirectBinding,
  boxOf: (id: string) => DirectBox | undefined,
): [Point, Point] {
  const pts = line.points;
  const start = pts[0]!;
  const end = pts[pts.length - 1]!;
  const fromBox = line.from ? boxOf(line.from) : undefined;
  const toBox = line.to ? boxOf(line.to) : undefined;
  const from = fromBox && binding.from ? { box: fromBox, ...binding.from } : null;
  const to = toBox && binding.to ? { box: toBox, ...binding.to } : null;
  if (line.style === 'arc') {
    return [
      from ? anchorPoint(from.box, from.anchor) : start,
      to ? anchorPoint(to.box, to.anchor) : end,
    ];
  }
  if (from && to) {
    const s = snapToFocus(from.box, from.focus, end) ?? start;
    return [s, snapToFocus(to.box, to.focus, s) ?? end];
  }
  if (from) {
    return [snapToFocus(from.box, from.focus, end) ?? start, end];
  }
  if (to) {
    return [start, snapToFocus(to.box, to.focus, start) ?? end];
  }
  return [start, end];
}

/**
 * A bound end left inside its box (a line drawn from deep inside one) put where the line leaves
 * the box, toward the line's other end; anywhere else it stays.
 */
export function onOutline(box: DirectBox, end: Point, other: Point): Point {
  if (!inside(box, end)) {
    return end;
  }
  const hits = crossings(box, end, other);
  const ahead = hits.filter(
    (p) => (p[0] - end[0]) * (other[0] - end[0]) + (p[1] - end[1]) * (other[1] - end[1]) >= 0,
  );
  return ahead[0] ?? end;
}

/**
 * A bound end placed outside its box's outline but on the box (an ellipse's corner) brought in to
 * the outline, toward the centre; an end on or inside the outline stays where it was put.
 */
export function ontoOutline(box: DirectBox, p: Point): Point {
  if (inside(box, p)) {
    return p;
  }
  const c = centreOf(box);
  const hits = crossings(box, p, c).filter(
    (h) => (h[0] - p[0]) * (c[0] - p[0]) + (h[1] - p[1]) * (c[1] - p[1]) >= 0,
  );
  return hits[0] ?? p;
}

// ---- the label

/** A manually placed label: the line it was placed on, its box there, and its offset off the line. */
export interface ManualLabel {
  readonly on: DirectLine;
  readonly box: LabelBox;
  /** Signed perpendicular offset from the line. */
  readonly lineOffset: number;
}

/**
 * Where a straight or arc line's label goes on the line's path: a manual label keeps its place
 * along the line and its offset off it, read from where it sat on `manual.on`; an arc's other label
 * centres on the apex; a straight line's on the segment's middle, lifted clear when the segment is
 * too short for it. Undefined for a line with no path.
 */
export function directLabel(
  line: DirectLine,
  size: { readonly width: number; readonly height: number },
  manual?: ManualLabel,
): LabelBox | undefined {
  const points = line.points;
  if (points.length < 2) {
    return undefined;
  }
  const moved =
    manual &&
    moveManualLabel(labelRoute(manual.on), manual.box, manual.lineOffset, labelRoute(line), size);
  if (moved) {
    return moved;
  }
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const bend = bendOf(line, points);
  if (bend !== undefined && Math.abs(bend) >= ARC_BEND_SNAP_THRESHOLD) {
    const [cx, cy] = getArcApex(start, end, bend);
    return { x: cx - size.width / 2, y: cy - size.height / 2, width: size.width, height: size.height };
  }
  const placedBox = labelPositionCenteredOnSegment(size, [
    { x: start[0], y: start[1] },
    { x: end[0], y: end[1] },
  ]);
  return { x: placedBox.x, y: placedBox.y, width: size.width, height: size.height };
}
