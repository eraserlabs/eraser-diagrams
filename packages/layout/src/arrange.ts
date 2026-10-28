import { axisEnd, axisStart } from './rangeUtils.js';
import type { Axis, LayoutEntity } from './types.js';

/** Align whole selection units. The caller owns hierarchy, rounding and applying the translations. */
export function alignmentMoves(
  units: readonly LayoutEntity[],
  axis: Axis,
  position: 'start' | 'center' | 'end',
): Array<{ id: string; d: number }> {
  if (units.length < 2) {
    return [];
  }
  const start = Math.min(...units.map((unit) => axisStart(unit, axis)));
  const end = Math.max(...units.map((unit) => axisEnd(unit, axis)));
  return units.map((unit) => ({
    id: unit.id,
    d:
      position === 'start'
        ? start - axisStart(unit, axis)
        : position === 'end'
          ? end - axisEnd(unit, axis)
          : (start + end) / 2 - (axisStart(unit, axis) + axisEnd(unit, axis)) / 2,
  }));
}

/**
 * Equal gaps between units ordered by their centers. When they overlap, space their centers instead,
 * keeping the units at the outer edges fixed. The caller owns grouping and rounding.
 */
export function distributionMoves(
  units: readonly LayoutEntity[],
  axis: Axis,
): Array<{ id: string; d: number }> {
  if (units.length < 2) {
    return [];
  }
  const items = units
    .map((unit) => {
      const start = axisStart(unit, axis);
      const end = axisEnd(unit, axis);
      return { id: unit.id, start, end, mid: (start + end) / 2 };
    })
    .sort((a, b) => a.mid - b.mid);
  const start = Math.min(...items.map((item) => item.start));
  const end = Math.max(...items.map((item) => item.end));
  const span = items.reduce((sum, item) => sum + (item.end - item.start), 0);
  const step = (end - start - span) / (items.length - 1);
  const moves: Array<{ id: string; d: number }> = [];
  if (step < 0) {
    const first = items.findIndex((item) => item.start === start);
    const last = items.findIndex((item) => item.end === end);
    const midStep = (items[last].mid - items[first].mid) / (items.length - 1);
    let pos = items[first].mid;
    items.forEach((item, i) => {
      if (i !== first && i !== last) {
        pos += midStep;
        moves.push({ id: item.id, d: pos - item.mid });
      }
    });
  } else {
    let pos = start;
    for (const item of items) {
      moves.push({ id: item.id, d: pos - item.start });
      pos += step + (item.end - item.start);
    }
  }
  return moves;
}
