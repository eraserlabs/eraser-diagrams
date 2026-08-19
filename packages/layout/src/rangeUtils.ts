import {
  Axis,
  type AxisSpan,
  LayoutEntity,
  LayoutRange,
  PositionProps,
  LayoutOptions,
} from './types.js';

export function makeRangeFromEntity(entity: PositionProps): LayoutRange {
  return {
    minX: entity.x,
    maxX: entity.x + entity.width,
    minY: entity.y,
    maxY: entity.y + entity.height,
  };
}

/**
 * A relatively simple util that makes a range for the text placement
 */
export function makeRangeForEntityTextPlacement(
  entity?: LayoutEntity | undefined,
): LayoutRange | undefined {
  if (!entity?.textPlacement) {
    return undefined;
  }

  return {
    minX: entity.x + entity.textPlacement.relativeX,
    maxX: entity.x + entity.textPlacement.relativeX + entity.textPlacement.width,
    minY: entity.y + entity.textPlacement.relativeY,
    maxY: entity.y + entity.textPlacement.relativeY + entity.textPlacement.height,
  };
}

/**
 * Combines multiple LayoutRange objects into a single bounding range
 */
export function combineRanges(...ranges: LayoutRange[]): LayoutRange {
  if (ranges.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  const [first, ...rest] = ranges;
  let { minX, maxX, minY, maxY } = first;

  for (const range of rest) {
    minX = Math.min(minX, range.minX);
    maxX = Math.max(maxX, range.maxX);
    minY = Math.min(minY, range.minY);
    maxY = Math.max(maxY, range.maxY);
  }

  return { minX, maxX, minY, maxY };
}

export function shiftRange(
  range: LayoutRange,
  shift: { deltaX?: number; deltaY?: number },
): LayoutRange {
  return {
    minX: range.minX + (shift.deltaX ?? 0),
    maxX: range.maxX + (shift.deltaX ?? 0),
    minY: range.minY + (shift.deltaY ?? 0),
    maxY: range.maxY + (shift.deltaY ?? 0),
  };
}

export function addBufferToRange(range: LayoutRange, buffer: number): LayoutRange {
  return {
    minX: range.minX - buffer,
    maxX: range.maxX + buffer,
    minY: range.minY - buffer,
    maxY: range.maxY + buffer,
  };
}

export function addPaddingToRange(
  range: LayoutRange,
  padding: LayoutOptions['containerPadding'],
): LayoutRange {
  return {
    minX: range.minX - padding.left,
    maxX: range.maxX + padding.right,
    minY: range.minY - padding.top,
    maxY: range.maxY + padding.bottom,
  };
}

export function isOverlapping(rangeA: LayoutRange, rangeB: LayoutRange): boolean {
  return !(
    rangeA.minX > rangeB.maxX ||
    rangeA.maxX < rangeB.minX ||
    rangeA.minY > rangeB.maxY ||
    rangeA.maxY < rangeB.minY
  );
}

export function rangeIncludes(maybeOuter: LayoutRange, maybeInner: LayoutRange): boolean {
  return (
    maybeOuter.minX <= maybeInner.minX &&
    maybeOuter.maxX >= maybeInner.maxX &&
    maybeOuter.minY <= maybeInner.minY &&
    maybeOuter.maxY >= maybeInner.maxY
  );
}

/**
 * Like {@link isOverlapping} but requires a positive-area intersection: ranges
 * that merely touch at an edge or corner (zero shared area) are NOT considered
 * overlapping. Use this when a bare edge graze must read as "outside" — e.g.
 * deciding whether a child genuinely sits inside its container.
 */
export function strictlyOverlaps(rangeA: LayoutRange, rangeB: LayoutRange): boolean {
  return (
    rangeA.minX < rangeB.maxX &&
    rangeA.maxX > rangeB.minX &&
    rangeA.minY < rangeB.maxY &&
    rangeA.maxY > rangeB.minY
  );
}

export function containsRange(outer: LayoutRange, inner: LayoutRange, tolerance = 0): boolean {
  return (
    outer.minX <= inner.minX + tolerance &&
    outer.maxX >= inner.maxX - tolerance &&
    outer.minY <= inner.minY + tolerance &&
    outer.maxY >= inner.maxY - tolerance
  );
}

export function midpoint(span: AxisSpan): number {
  return (span[0] + span[1]) / 2;
}

export function spanLength(span: AxisSpan): number {
  return span[1] - span[0];
}

export function spansEqual(left: AxisSpan, right: AxisSpan, epsilon: number): boolean {
  return Math.abs(left[0] - right[0]) <= epsilon && Math.abs(left[1] - right[1]) <= epsilon;
}

export function insetSpan(span: AxisSpan, padding: number, epsilon: number): AxisSpan | undefined {
  return span[1] - span[0] >= 2 * padding - epsilon
    ? [span[0] + padding, span[1] - padding]
    : undefined;
}

/** Inclusive intersection: zero-length / edge-touch results are kept when within epsilon. */
export function intersectSpans(
  left: AxisSpan,
  right: AxisSpan,
  epsilon: number,
): AxisSpan | undefined {
  const start = Math.max(left[0], right[0]);
  const end = Math.min(left[1], right[1]);
  return start <= end + epsilon ? [start, Math.max(start, end)] : undefined;
}

/** Positive-length intersection only. */
export function intersectPositiveSpans(
  left: AxisSpan,
  right: AxisSpan,
  epsilon: number,
): AxisSpan | undefined {
  const start = Math.max(left[0], right[0]);
  const end = Math.min(left[1], right[1]);
  return end - start > epsilon ? [start, end] : undefined;
}

export function intersectAllSpans(
  spans: readonly AxisSpan[],
  epsilon: number,
): AxisSpan | undefined {
  if (spans.length === 0) {
    return undefined;
  }
  let result = spans[0];
  for (let index = 1; index < spans.length; index += 1) {
    const next = intersectSpans(result, spans[index], epsilon);
    if (!next) {
      return undefined;
    }
    result = next;
  }
  return result;
}

export function spansOverlapPositive(left: AxisSpan, right: AxisSpan, epsilon: number): boolean {
  return Math.min(left[1], right[1]) - Math.max(left[0], right[0]) > epsilon;
}

export function spanOverlapLength(left: AxisSpan, right: AxisSpan): number {
  return Math.max(0, Math.min(left[1], right[1]) - Math.max(left[0], right[0]));
}

export function spanContains(outer: AxisSpan, inner: AxisSpan, epsilon: number): boolean {
  return outer[0] <= inner[0] + epsilon && outer[1] >= inner[1] - epsilon;
}

export function coordinateInSpan(value: number, span: AxisSpan, epsilon: number): boolean {
  return value >= span[0] - epsilon && value <= span[1] + epsilon;
}

export function clampToSpan(value: number, span: AxisSpan): number {
  return Math.min(Math.max(value, span[0]), span[1]);
}

export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}

export const axisStart = (b: { x: number; y: number }, axis: Axis): number =>
  axis === 'x' ? b.x : b.y;
export const axisEnd = (b: PositionProps, axis: Axis): number =>
  axis === 'x' ? b.x + b.width : b.y + b.height;
export const axisOrthMin = (b: { x: number; y: number }, axis: Axis): number =>
  axis === 'x' ? b.y : b.x;
export const axisOrthMax = (b: PositionProps, axis: Axis): number =>
  axis === 'x' ? b.y + b.height : b.x + b.width;

export const orthOverlaps = (a: PositionProps, b: PositionProps, axis: Axis): boolean =>
  axisOrthMin(b, axis) < axisOrthMax(a, axis) && axisOrthMin(a, axis) < axisOrthMax(b, axis);

export function makePropsFromRange(range: LayoutRange): PositionProps {
  return {
    x: range.minX,
    y: range.minY,
    width: range.maxX - range.minX,
    height: range.maxY - range.minY,
  };
}

/**
 * Remove one cut from a span, yielding the 0-2 surviving pieces. This is the primitive:
 * callers with a single cut pay no sort and no exclusion array.
 */
export function subtractSpan(source: AxisSpan, cut: AxisSpan, epsilon: number): AxisSpan[] {
  const overlap = intersectPositiveSpans(source, cut, epsilon);
  if (!overlap) {
    return [source];
  }
  const result: AxisSpan[] = [];
  if (overlap[0] > source[0]) {
    result.push([source[0], overlap[0]]);
  }
  if (overlap[1] < source[1]) {
    result.push([overlap[1], source[1]]);
  }
  return result;
}

/**
 * Every gap left in `bounds` once `exclusions` are removed. A single cursor sweep rather
 * than a fold over `subtractSpan`, which would re-allocate the surviving pieces per cut.
 */
export function subtractSpans(
  bounds: AxisSpan,
  exclusions: readonly AxisSpan[],
  epsilon: number,
): AxisSpan[] {
  const clipped = exclusions
    .map((span): AxisSpan => [Math.max(bounds[0], span[0]), Math.min(bounds[1], span[1])])
    .filter((span) => span[0] <= span[1] + epsilon)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const available: AxisSpan[] = [];
  let cursor = bounds[0];
  for (const exclusion of clipped) {
    if (exclusion[0] > cursor + epsilon) {
      available.push([cursor, exclusion[0]]);
    }
    cursor = Math.max(cursor, exclusion[1]);
    if (cursor >= bounds[1] - epsilon) {
      break;
    }
  }
  if (cursor < bounds[1] - epsilon) {
    available.push([cursor, bounds[1]]);
  }
  return available;
}
