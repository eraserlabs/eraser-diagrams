import type { AxisSpan } from '../../types.js';
import { convexPortCenteringCharge } from '../measure/portCentering.js';

/**
 * Track quantization and integer port emission jitter realized coordinates by a pixel or two;
 * deviations inside this band are not defects.
 */
const SLOT_DEVIATION_DEADZONE_PX = 2;

/**
 * Slot model of a face's endpoint arrangement: the face is sliced into one equal slot per
 * endpoint and each endpoint's expectation is its slot center, assigned in coordinate order.
 * The charge is convex per endpoint — deviation normalized by the face half-length, then
 * u * (1 + u^2), the port-centering shape — so one port at face center plus one 8px off
 * prices strictly worse than two ports straddling the center at 4px each. With one endpoint
 * the model degenerates to distance from face center.
 */
export interface FaceSlotAssessment {
  /** Slot centers in ascending order, one per endpoint. */
  readonly expected: readonly number[];
  /** Dead-zoned |coordinate - expected| per endpoint, ascending coordinate order. */
  readonly deviations: readonly number[];
  /** Sum of convex per-endpoint charges; each endpoint contributes at most 2. */
  readonly charge: number;
}

export function assessFaceSlots(
  span: AxisSpan,
  sortedCoordinates: readonly number[],
): FaceSlotAssessment {
  const count = sortedCoordinates.length;
  const length = span[1] - span[0];
  const halfSpan = length / 2;
  const slotLength = length / count;
  const expected: number[] = [];
  const deviations: number[] = [];
  let charge = 0;
  for (let index = 0; index < count; index += 1) {
    const slotCenter = span[0] + slotLength * (index + 0.5);
    expected.push(slotCenter);
    const deviation = Math.max(
      0,
      Math.abs(sortedCoordinates[index] - slotCenter) - SLOT_DEVIATION_DEADZONE_PX,
    );
    deviations.push(deviation);
    if (halfSpan > 0) {
      const normalized = Math.min(1, deviation / halfSpan);
      charge += convexPortCenteringCharge(normalized);
    }
  }
  return { expected, deviations, charge };
}
