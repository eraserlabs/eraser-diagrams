import type { GuidelineName } from './types.js';
import type { MovingSide } from './resize.js';
import type { PositionProps } from './types.js';

export interface Guide {
  readonly name: GuidelineName;
  readonly pos: number;
  /** a fixed point: where on the other axis it is (the attachment point), for drawing */
  readonly at?: number;
}
export type Segment = readonly [readonly [number, number], readonly [number, number]];

/** Geometry already adapted from the editor's elements and connector attachment points. */
export interface ResizeSnapCandidate {
  readonly bounds: readonly [number, number, number, number];
  readonly x: readonly Guide[];
  readonly y: readonly Guide[];
}

export const gap = (a: ResizeSnapCandidate['bounds'], b: ResizeSnapCandidate['bounds']): number => {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
};

/** One axis of a resize snap: how far the moving side goes to meet the guideline, where that is, and whose it is. */
export interface SideSnap {
  readonly delta: number;
  readonly pos: number;
  /** The bounds of the box the guideline belongs to, for the guide. */
  readonly bounds: readonly [number, number, number, number];
}

export interface ResizeSnap {
  readonly x?: SideSnap;
  readonly y?: SideSnap;
}

/** The guideline nearest `at` within the threshold (findCorrespondingGuideline), or none. */
function nearestGuide(guides: readonly Guide[], at: number, threshold: number): Guide | null {
  let best: Guide | null = null;
  for (const g of guides) {
    const d = Math.abs(g.pos - at);
    if (d <= threshold && (!best || d < Math.abs(best.pos - at))) {
      best = g;
    }
  }
  return best;
}

/**
 * The canvas's align snapping while a box is resized or drawn (maybeSnapToAlign, actions `resizing` and
 * `dragging-new-element`), per axis: only the side that moves snaps; the side that stays is locked
 * (getLockedGuideline). The boxes are tried nearest first and the first with a guideline within the threshold of the
 * moving side wins: any of its guidelines (start, middle, end, a line's fixed point: the canvas pairs guidelines by
 * name only for a move), except the one the side that stays sits on, so both sides never land on one line
 * (getGuidelineToSnap). `bounds` is the box as the pointer sized it; candidates are the boxes that stay.
 */
export function snapResize(
  bounds: readonly [number, number, number, number],
  moving: { readonly x?: MovingSide; readonly y?: MovingSide },
  candidates: readonly ResizeSnapCandidate[],
  threshold: number,
): ResizeSnap {
  const cands = [...candidates].sort((a, b) => gap(a.bounds, bounds) - gap(b.bounds, bounds));
  const out: { x?: SideSnap; y?: SideSnap } = {};
  for (const axis of ['x', 'y'] as const) {
    const side = moving[axis];
    if (!side) {
      continue;
    }
    const lo = axis === 'x' ? bounds[0] : bounds[1];
    const hi = axis === 'x' ? bounds[2] : bounds[3];
    const mine = side === 'start' ? lo : hi;
    const still = side === 'start' ? hi : lo;
    for (const cand of cands) {
      const near = nearestGuide(cand[axis], mine, threshold);
      if (near && near.name !== nearestGuide(cand[axis], still, threshold)?.name) {
        out[axis] = { delta: near.pos - mine, pos: near.pos, bounds: cand.bounds };
        break;
      }
    }
  }
  return out;
}

/**
 * The guides of a resize snap (getGuidelinesToRenderFromSnapData): one per snapped axis, along its guideline, across
 * the box as it now is and the box it snapped to.
 */
export function resizeGuides(
  bounds: readonly [number, number, number, number],
  snap: ResizeSnap,
): Segment[] {
  const guides: Segment[] = [];
  if (snap.x) {
    const b = snap.x.bounds;
    guides.push([
      [snap.x.pos, Math.min(bounds[1], b[1])],
      [snap.x.pos, Math.max(bounds[3], b[3])],
    ]);
  }
  if (snap.y) {
    const b = snap.y.bounds;
    guides.push([
      [Math.min(bounds[0], b[0]), snap.y.pos],
      [Math.max(bounds[2], b[2]), snap.y.pos],
    ]);
  }
  return guides;
}

/** Size at the pointer, snap its moving sides, then size again with the snapped pointer offset. */
export function snapSized<T extends { readonly rect: Readonly<PositionProps> }>(
  size: (ox: number, oy: number) => T,
  moving: { readonly x?: MovingSide; readonly y?: MovingSide },
  candidates: readonly ResizeSnapCandidate[],
  threshold: number,
  keepRatio: boolean,
  sign: 1 | -1,
): { sized: T; guides: Segment[] } {
  const raw = size(0, 0);
  const snap = snapResize(boundsOf(raw.rect), moving, candidates, threshold);
  let kept = snap;
  let ox = snap.x?.delta ?? 0;
  let oy = snap.y?.delta ?? 0;
  if (keepRatio && snap.x) {
    kept = { x: snap.x };
    oy = ox * (raw.rect.height / raw.rect.width) * sign;
  } else if (keepRatio && snap.y) {
    ox = oy * (raw.rect.width / raw.rect.height) * sign;
  }
  const sized = ox !== 0 || oy !== 0 ? size(ox, oy) : raw;
  return { sized, guides: resizeGuides(boundsOf(sized.rect), kept) };
}

const boundsOf = (r: Readonly<PositionProps>): [number, number, number, number] => [
  r.x,
  r.y,
  r.x + r.width,
  r.y + r.height,
];
