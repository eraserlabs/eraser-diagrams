import { Axis, LayoutConnectionChange } from './types.js';

export function isAxis(arg: unknown): arg is Axis {
  return arg === 'x' || arg === 'y';
}

export function isShift(
  change: LayoutConnectionChange,
): change is { deltaX?: number; deltaY?: number } {
  return 'deltaX' in change || 'deltaY' in change;
}
