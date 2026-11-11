import type { PositionProps } from './types.js';

/** A caller-owned geometry frame in the same coordinates as the working layout. */
export type LayoutGeometry = ReadonlyMap<string, Readonly<PositionProps>>;

/** Copy entity boxes into a stable geometry frame. */
export function makeLayoutGeometry(
  entities: readonly (Readonly<PositionProps> & { id: string })[],
): LayoutGeometry {
  return new Map(entities.map(({ id, x, y, width, height }) => [id, { x, y, width, height }]));
}
