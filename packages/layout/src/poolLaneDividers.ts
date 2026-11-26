import type { PositionProps } from './types.js';

/** A decorative segment in the pool's local coordinate system. */
export interface LaneDivider {
  start: [number, number];
  end: [number, number];
}

interface SwimlaneBox extends PositionProps {
  id: string;
  tag: string;
  containerId?: string | null;
  orientation?: 'horizontal' | 'vertical';
}

/** Direct child lanes partition each pool in spatial order, independently of their paint order. */
export function poolLaneDividers(elements: readonly SwimlaneBox[]): Map<string, LaneDivider[]> {
  const lanesByPool = new Map<string, SwimlaneBox[]>();
  for (const lane of elements) {
    if (lane.tag === 'Lane' && lane.containerId) {
      const lanes = lanesByPool.get(lane.containerId) ?? [];
      lanes.push(lane);
      lanesByPool.set(lane.containerId, lanes);
    }
  }
  const result = new Map<string, LaneDivider[]>();
  for (const pool of elements) {
    if (pool.tag === 'Pool') {
      result.set(pool.id, divide(pool, lanesByPool.get(pool.id) ?? []));
    }
  }
  return result;
}

function divide(pool: SwimlaneBox, lanes: readonly PositionProps[]): LaneDivider[] {
  const vertical = pool.orientation === 'vertical';
  const along = vertical ? 'x' : 'y';
  const across = vertical ? 'y' : 'x';
  const length = vertical ? 'width' : 'height';
  const span = vertical ? 'height' : 'width';
  const ordered = [...lanes].sort((a, b) => a[along] - b[along]);
  const dividers: LaneDivider[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const before = ordered[i - 1]!;
    const after = ordered[i]!;
    const at = (before[along] + before[length] + after[along]) / 2 - pool[along];
    const from = Math.max(pool[across], before[across], after[across]) - pool[across];
    const to =
      Math.min(
        pool[across] + pool[span],
        before[across] + before[span],
        after[across] + after[span],
      ) - pool[across];
    if (from < to && at > 0 && at < pool[length]) {
      dividers.push(
        vertical ? { start: [at, from], end: [at, to] } : { start: [from, at], end: [to, at] },
      );
    }
  }
  return dividers;
}

/** A single SVG path for the pool's dividers, including the empty path for a single lane. */
export function poolLaneDividerPath(dividers: readonly LaneDivider[]): string {
  return dividers.map(({ start, end }) => `M${start.join(' ')}L${end.join(' ')}`).join(' ');
}
