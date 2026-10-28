import type { TransformHandleDirection } from './types.js';
import type { PositionProps } from './types.js';

export type MovingSide = 'start' | 'end';

export interface ResizeOptions {
  /** The box keeps its ratio of width to height. */
  readonly keepRatio?: boolean;
  /** The box resizes about its centre: the opposite side moves as far the other way. */
  readonly fromCentre?: boolean;
  /** The narrowest the box gets (a text box's side); 1 px when left out. */
  readonly minWidth?: number;
}

/** Where a grip sits on `r`: its corner, or the middle of its side. The pointer keeps its offset from it (getResizeOffsetXY). */
export function gripPoint(
  r: Readonly<PositionProps>,
  corner: TransformHandleDirection,
): [number, number] {
  const x = corner.includes('w') ? r.x : corner.includes('e') ? r.x + r.width : r.x + r.width / 2;
  const y = corner.includes('n') ? r.y : corner.includes('s') ? r.y + r.height : r.y + r.height / 2;
  return [x, y];
}

/** resizeSingleElement: `start` with its `corner` grip at the pointer (x, y). */
export function resizeRect(
  start: Readonly<PositionProps>,
  corner: TransformHandleDirection,
  x: number,
  y: number,
  o: ResizeOptions = {},
): Readonly<PositionProps> {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const west = corner.includes('w');
  const north = corner.includes('n');
  let width = west ? right - x : corner.includes('e') ? x - start.x : start.width;
  let height = north ? bottom - y : corner.includes('s') ? y - start.y : start.height;
  if (o.fromCentre) {
    width = 2 * width - start.width;
    height = 2 * height - start.height;
  }
  width = Math.max(o.minWidth ?? 1, width);
  height = Math.max(1, height);
  if (o.keepRatio) {
    const wr = width / start.width;
    const hr = height / start.height;
    // a side: the other axis follows it; a corner: the larger of its two ratios
    const r = corner.length === 2 ? Math.max(wr, hr) : corner === 'e' || corner === 'w' ? wr : hr;
    width = Math.max(1, start.width * r);
    height = Math.max(1, start.height * r);
  }
  let left = west ? right - width : start.x;
  let top = north ? bottom - height : start.y;
  // a side with the ratio kept grows the other axis about its middle; from the centre, both axes are
  if (o.fromCentre || (o.keepRatio && (corner === 'n' || corner === 's'))) {
    left = start.x + start.width / 2 - width / 2;
  }
  if (o.fromCentre || (o.keepRatio && (corner === 'e' || corner === 'w'))) {
    top = start.y + start.height / 2 - height / 2;
  }
  return { x: left, y: top, width, height };
}

/**
 * The one factor a corner grip scales by (resizeMultipleElements, a text box's corner): the larger of the two ratios
 * the pointer makes with the corner that stays.
 */
export function cornerScale(
  r: Readonly<PositionProps>,
  corner: TransformHandleDirection,
  x: number,
  y: number,
): number {
  const sx = (corner.includes('w') ? r.x + r.width - x : x - r.x) / r.width;
  const sy = (corner.includes('n') ? r.y + r.height - y : y - r.y) / r.height;
  return Math.max(sx, sy);
}

/** The corner that stays while `corner` is dragged. */
export function anchorOf(
  r: Readonly<PositionProps>,
  corner: TransformHandleDirection,
): [number, number] {
  return [corner.includes('w') ? r.x + r.width : r.x, corner.includes('n') ? r.y + r.height : r.y];
}

/** `r` scaled by `s` about the point `at`: its place and its size (resizeMultipleElements' getNextXY). */
export function scaleAbout(
  r: Readonly<PositionProps>,
  at: readonly [number, number],
  s: number,
): Readonly<PositionProps> {
  return {
    x: at[0] + (r.x - at[0]) * s,
    y: at[1] + (r.y - at[1]) * s,
    width: r.width * s,
    height: r.height * s,
  };
}

/** The side that moves on each axis while `corner` is dragged; a side grip moves none on its other axis. */
export function movingSides(corner: TransformHandleDirection): { x?: MovingSide; y?: MovingSide } {
  return {
    ...(corner.includes('w') ? { x: 'start' as const } : {}),
    ...(corner.includes('e') ? { x: 'end' as const } : {}),
    ...(corner.includes('n') ? { y: 'start' as const } : {}),
    ...(corner.includes('s') ? { y: 'end' as const } : {}),
  };
}

/** A ne or sw grip grows one axis as the pointer moves the other way on its other axis. */
export const ratioSign = (corner: TransformHandleDirection): 1 | -1 =>
  corner === 'ne' || corner === 'sw' ? -1 : 1;
