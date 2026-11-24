/** Canvas rectangle: quadratic corners, capped at 12px. Coordinates may be offset for its silhouette shadow. */
export function rectanglePath(
  width: number,
  height: number,
  sharp: boolean,
  x0 = 0,
  y0 = 0,
): string {
  const radius = Math.min(Math.min(width, height) * 0.15, 12);
  // to a thousandth of a pixel: 72 × 0.15 is 10.8, not 10.799999999999999, in the path
  const r = sharp ? 0 : Math.round(radius * 1000) / 1000;
  const [x1, y1] = [x0 + width, y0 + height];
  return [
    `M ${x0 + r} ${y0} L ${x1 - r} ${y0} Q ${x1} ${y0}, ${x1} ${y0 + r}`,
    `L ${x1} ${y1 - r} Q ${x1} ${y1}, ${x1 - r} ${y1}`,
    `L ${x0 + r} ${y1} Q ${x0} ${y1}, ${x0} ${y1 - r}`,
    `L ${x0} ${y0 + r} Q ${x0} ${y0}, ${x0 + r} ${y0}`,
  ].join(' ');
}

/** Concentric inner outline inset by `inset` px on every side (double-border rectangles). */
export function insetRectanglePath(
  width: number,
  height: number,
  sharp: boolean,
  inset: number,
): string | null {
  const innerW = width - inset * 2;
  const innerH = height - inset * 2;

  if (innerW <= 2 || innerH <= 2) {
    return null;
  }

  const outerR = sharp ? 0 : Math.min(Math.min(width, height) * 0.15, 12);
  const r = sharp ? 0 : Math.max(0, Math.round((outerR - inset) * 1000) / 1000);
  const [x0, y0, x1, y1] = [inset, inset, width - inset, height - inset];

  return [
    `M ${x0 + r} ${y0} L ${x1 - r} ${y0} Q ${x1} ${y0}, ${x1} ${y0 + r}`,
    `L ${x1} ${y1 - r} Q ${x1} ${y1}, ${x1 - r} ${y1}`,
    `L ${x0 + r} ${y1} Q ${x0} ${y1}, ${x0} ${y1 - r}`,
    `L ${x0} ${y0 + r} Q ${x0} ${y0}, ${x0 + r} ${y0}`,
  ].join(' ');
}

/** Shadow silhouette and its outside-only clip, shared by fill and live resize. */
export function rectangleShadowPaths(width: number, height: number, sharp = false) {
  const body = rectanglePath(width, height, sharp);
  const geoShadowPath = rectanglePath(width, height, sharp, 4, 4);
  return { geoShadowPath, geoShadowClip: `${body} ${geoShadowPath}` };
}
