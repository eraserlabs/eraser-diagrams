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

/** Shadow silhouette and its outside-only clip, shared by fill and live resize. */
export function rectangleShadowPaths(width: number, height: number, sharp = false) {
  const body = rectanglePath(width, height, sharp);
  const geoShadowPath = rectanglePath(width, height, sharp, 4, 4);
  return { geoShadowPath, geoShadowClip: `${body} ${geoShadowPath}` };
}
