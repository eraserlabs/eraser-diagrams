const CENTER_DEVIATION_EPSILON = 1e-6;
const CORNER_PRESSURE_START = 0.6;

/** Distance from face center normalized by the face half-span. */
export function normalizedFaceCenterDeviation(
  coordinate: number,
  center: number,
  halfSpan: number,
): number {
  return halfSpan <= CENTER_DEVIATION_EPSILON
    ? 0
    : Math.min(1, Math.abs(coordinate - center) / halfSpan);
}

/** Convex charge shared by production endpoint quality and the external grader. */
export function convexPortCenteringCharge(deviation: number): number {
  return deviation * (1 + deviation * deviation);
}

/** Extra lexical pressure for an individual port approaching a face corner. */
export function portCornerPressure(deviation: number): number {
  const proximity = Math.max(
    0,
    Math.min(1, (deviation - CORNER_PRESSURE_START) / (1 - CORNER_PRESSURE_START)),
  );
  return convexPortCenteringCharge(proximity);
}
