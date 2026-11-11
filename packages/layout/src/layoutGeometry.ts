import type { PositionProps } from './types.js';

/** A caller-owned geometry frame in the same coordinates as the working layout. */
export type LayoutGeometry = ReadonlyMap<string, Readonly<PositionProps>>;

/** A complete finite box; callers decide whether zero or negative sizes are allowed. */
export function isFiniteBox<T extends Partial<Record<keyof PositionProps, unknown>>>(
  box: T | null | undefined,
): box is T & PositionProps {
  return (
    box != null &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  );
}

/** Copy entity boxes into a stable geometry frame. */
export function makeLayoutGeometry(
  entities: readonly (Readonly<PositionProps> & { id: string })[],
): LayoutGeometry {
  return new Map(entities.map(({ id, x, y, width, height }) => [id, { x, y, width, height }]));
}
