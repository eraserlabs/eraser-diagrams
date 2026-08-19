import {
  effectiveLabelPerpOffset,
  pointAtArcLengthFraction,
  polylineLength,
  projectPointOntoPolyline,
  projectedHalfExtent,
} from './polylineUtils.js';
import type { Point } from './types.js';
import { LABEL_LINE_GAP } from './textPlacements.js';

/**
 * Shared, pure engine for a manually-placed label pinned to the WHOLE PATH of a line by
 * arc-length, using a 1-D nine-patch ("3-slice") model: two fixed end caps + a stretchable middle.
 *
 *  - A label in an end cap keeps a FIXED arc-distance from that terminal endpoint (the entity it
 *    binds to) — it stays put as the line stretches ("sticky near the ends").
 *  - A label in the middle keeps its FRACTION of the stretchable band — it scales with the line.
 *
 * The mode (head / mid / tail) is LATCHED when the label is dropped and never re-decided, so each
 * label obeys one continuous formula and never kinks. The anchor is route-INDEPENDENT: a split,
 * merge, stretch, translate, or reload is just a re-resolve on the new route — no old route needed.
 *
 * All coordinates are SCENE/ABSOLUTE. Callers convert element-relative `points` → scene
 * (`+line.x,+line.y`) before calling and convert the returned center back to their own store.
 * (Arc-length and the fraction are translation-invariant, so a caller may also run the engine
 * consistently in any single fixed frame, e.g. freeform diagram coords.)
 */

export type LabelOrient = 'h' | 'v' | 'free';

export type LabelAnchorMode = 'head' | 'mid' | 'tail';

export interface ManualLabelAnchor {
  /** Which slice owns the label; latched at drop, never re-decided. */
  mode: LabelAnchorMode;
  /**
   * head/tail: arc-distance (px) from that terminal endpoint.
   * mid: fraction in [0,1] of the stretchable middle band.
   */
  value: number;
  /** Signed perpendicular distance from the line (px), along the canonical normal. 0 = on-line. */
  offset: number;
}

export interface LabelDims {
  width: number;
  height: number;
}

export interface ResolvedLabel {
  center: Readonly<Point>;
  /** Orientation of the segment under the resolved arc-position (for UI relabeling). */
  orient: LabelOrient;
  anchor: ManualLabelAnchor;
}

/** Fixed end-cap arc-length (px). Within a cap the label keeps a fixed arc-distance from its end. */
export const LABEL_END_CAP_PX = 40;

/** |perp/along| below this ⇒ the segment is treated as axis-aligned (~5°). */
const AXIS_ALIGN_TOL = 0.0875;

function classifyOrient(tangent: Readonly<Point>): LabelOrient {
  const adx = Math.abs(tangent[0]);
  const ady = Math.abs(tangent[1]);
  if (ady <= AXIS_ALIGN_TOL * adx) {
    return 'h';
  }
  if (adx <= AXIS_ALIGN_TOL * ady) {
    return 'v';
  }
  return 'free';
}

/**
 * Direction a positive `offset` moves the label center. CANONICAL for axis-aligned segments —
 * up `[0,-1]` for horizontal, right `[1,0]` for vertical — so the sign is traversal-independent and
 * matches the existing `lineOffset` convention (positive = above / right). Diagonal (`free`)
 * segments use the left normal `[-ty, tx]`.
 */
function segmentNormal(orient: LabelOrient, tangent: Readonly<Point>): Readonly<Point> {
  if (orient === 'h') {
    return [0, -1];
  }
  if (orient === 'v') {
    return [1, 0];
  }
  return [-tangent[1], tangent[0]];
}

/** Effective cap arc-length: the fixed cap, clamped so the two caps never overlap on a short line. */
function effectiveCap(totalLength: number, capPx: number): number {
  return Math.min(capPx, totalLength / 2);
}

/** Decide mode + value (the 3-slice classification) for an arc-position `s` on a route length `L`. */
function classifyAlong(
  totalLength: number,
  arcPos: number,
  offset: number,
  capPx: number,
): ManualLabelAnchor {
  const cap = effectiveCap(totalLength, capPx);
  if (arcPos <= cap) {
    return { mode: 'head', value: arcPos, offset };
  }
  if (arcPos >= totalLength - cap) {
    return { mode: 'tail', value: totalLength - arcPos, offset };
  }
  const band = totalLength - 2 * cap;
  return { mode: 'mid', value: band <= 0 ? 0.5 : (arcPos - cap) / band, offset };
}

/** Resolve an anchor back to an arc-position on a route of length `L` (the inverse of classifyAlong). */
function anchorToArcPos(totalLength: number, anchor: ManualLabelAnchor, capPx: number): number {
  const cap = effectiveCap(totalLength, capPx);
  if (anchor.mode === 'head') {
    return Math.min(anchor.value, cap);
  }
  if (anchor.mode === 'tail') {
    return totalLength - Math.min(anchor.value, cap);
  }
  return cap + Math.min(1, Math.max(0, anchor.value)) * (totalLength - 2 * cap);
}

/** Label center at arc-position `s`: the on-line point + perpendicular offset (with clearance clamp). */
function centerAtArcPos(
  routeScene: readonly Readonly<Point>[],
  totalLength: number,
  arcPos: number,
  offset: number,
  dims: LabelDims,
): { center: Readonly<Point>; orient: LabelOrient } {
  const fraction = totalLength === 0 ? 0 : arcPos / totalLength;
  const { point, tangent } = pointAtArcLengthFraction(routeScene, fraction);
  const orient = classifyOrient(tangent);
  const normal = segmentNormal(orient, tangent);
  // Clear by the label's perpendicular half-extent (height for h, width for v) so a wide label on a
  // vertical run doesn't straddle the line — the same effective offset the placement resolver uses,
  // so the label keeps its perpendicular position across a reroute.
  const perpHalfExtent = projectedHalfExtent(normal, dims.width, dims.height);
  const effOffset = effectiveLabelPerpOffset(offset, perpHalfExtent, LABEL_LINE_GAP);
  return {
    center: [point[0] + normal[0] * effOffset, point[1] + normal[1] * effOffset],
    orient,
  };
}

/**
 * Drag drop point → a fresh anchor. The arc-position comes from projecting the drop onto the
 * polyline; the perpendicular component is discarded (perp is owned by `offset`, set via the
 * stepper — drag is along-line only). Returns null for a degenerate route.
 */
export function deriveAnchorFromDrop(
  routeScene: readonly Readonly<Point>[],
  dropScene: Readonly<Point>,
  _dims: LabelDims,
  prevOffset = 0,
  capPx = LABEL_END_CAP_PX,
): ManualLabelAnchor | null {
  if (routeScene.length < 2) {
    return null;
  }
  const totalLength = polylineLength(routeScene);
  if (totalLength === 0) {
    return null;
  }
  const { fraction } = projectPointOntoPolyline(dropScene, routeScene);
  return classifyAlong(totalLength, fraction * totalLength, prevOffset, capPx);
}

/**
 * Reconstruct an anchor from a persisted label center (+ its nominal `lineOffset`) by projecting the
 * center onto the route. Used to legalize a legacy `labelPlacement` that has no latched mode/value,
 * and by the UI to read the owning-segment orientation. Returns null for a degenerate route.
 */
export function anchorFromStored(
  routeScene: readonly Readonly<Point>[],
  centerScene: Readonly<Point>,
  nominalOffset: number,
  capPx = LABEL_END_CAP_PX,
): ManualLabelAnchor | null {
  if (routeScene.length < 2) {
    return null;
  }
  const totalLength = polylineLength(routeScene);
  if (totalLength === 0) {
    return null;
  }
  const { fraction } = projectPointOntoPolyline(centerScene, routeScene);
  return classifyAlong(totalLength, fraction * totalLength, nominalOffset, capPx);
}

/**
 * Resolve an anchor to a label center on ANY route (stable, stretched, translated, or after a
 * split/merge — the anchor is route-independent). Never invalidates; the caller already knows the
 * label is manual. Returns null only for a degenerate route.
 */
export function resolveManualLabel(
  routeScene: readonly Readonly<Point>[],
  anchor: ManualLabelAnchor,
  dims: LabelDims,
  capPx = LABEL_END_CAP_PX,
): ResolvedLabel | null {
  if (routeScene.length < 2) {
    return null;
  }
  const totalLength = polylineLength(routeScene);
  if (totalLength === 0) {
    return null;
  }
  const arcPos = anchorToArcPos(totalLength, anchor, capPx);
  const { center, orient } = centerAtArcPos(routeScene, totalLength, arcPos, anchor.offset, dims);
  return { center, orient, anchor: { ...anchor } };
}
