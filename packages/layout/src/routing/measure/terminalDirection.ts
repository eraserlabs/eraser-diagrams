import type { Direction, XYPoint } from '../../types.js';
import type { EndpointSide } from '../types.js';

const EPSILON = 0.01;

export type TerminalDirectionViolationKind = 'tangential' | 'inward' | 'diagonal';

export interface TerminalDirectionViolationGeometry {
  readonly kind: TerminalDirectionViolationKind;
  readonly port: XYPoint;
  readonly adjacent: XYPoint;
}

/** A fixed-face terminal must leave its face along the outward normal. */
export function terminalDirectionViolation(
  points: readonly XYPoint[],
  face: Direction,
  endpoint: EndpointSide,
): TerminalDirectionViolationGeometry | undefined {
  if (points.length < 2) {
    return undefined;
  }
  const portIndex = endpoint === 'from' ? 0 : points.length - 1;
  const step = endpoint === 'from' ? 1 : -1;
  const port = points[portIndex];
  let adjacentIndex = portIndex + step;
  while (
    adjacentIndex >= 0 &&
    adjacentIndex < points.length &&
    Math.abs(points[adjacentIndex].x - port.x) <= EPSILON &&
    Math.abs(points[adjacentIndex].y - port.y) <= EPSILON
  ) {
    adjacentIndex += step;
  }
  const adjacent = points[adjacentIndex];
  if (!adjacent) {
    return undefined;
  }

  const dx = adjacent.x - port.x;
  const dy = adjacent.y - port.y;
  const normalX = face === 'left' ? -1 : face === 'right' ? 1 : 0;
  const normalY = face === 'up' ? -1 : face === 'down' ? 1 : 0;
  const outward = dx * normalX + dy * normalY;
  const tangent = dx * normalY - dy * normalX;
  if (outward > EPSILON && Math.abs(tangent) <= EPSILON) {
    return undefined;
  }
  return {
    kind:
      Math.abs(tangent) <= EPSILON
        ? 'inward'
        : Math.abs(outward) <= EPSILON
          ? 'tangential'
          : 'diagonal',
    port: { ...port },
    adjacent: { ...adjacent },
  };
}
