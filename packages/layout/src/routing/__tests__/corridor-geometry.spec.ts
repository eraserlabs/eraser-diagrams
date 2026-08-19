import {
  clampToSpan,
  coordinateInSpan,
  insetSpan,
  intersectSpans,
  midpoint,
  spanContains,
  spanLength,
} from '../../rangeUtils.js';
import type { Direction } from '../../types.js';
import type { Corridor, RouteEndpoint } from '../corridor/contract.js';
import {
  corridorCenter,
  corridorCrossSpan,
  corridorTravelSpan,
  endpointCrossCoordinate,
  endpointPoint,
} from '../corridor/geometry.js';

const EPSILON = 1e-6;

describe('routing corridor geometry', () => {
  it('projects corridor geometry without changing axis semantics', () => {
    const horizontal: Corridor = {
      index: 0,
      axis: 'x',
      rect: { x: 10, y: 20, width: 80, height: 30 },
    };
    const vertical: Corridor = { ...horizontal, index: 1, axis: 'y' };

    expect(corridorTravelSpan(horizontal)).toEqual([10, 90]);
    expect(corridorCrossSpan(horizontal)).toEqual([20, 50]);
    expect(corridorCenter(horizontal)).toBe(35);
    expect(corridorTravelSpan(vertical)).toEqual([20, 50]);
    expect(corridorCrossSpan(vertical)).toEqual([10, 90]);
    expect(corridorCenter(vertical)).toBe(50);
  });

  it('makes tolerance explicit in span operations', () => {
    expect(midpoint([10, 20])).toBe(15);
    expect(spanLength([10, 20])).toBe(10);
    expect(insetSpan([10, 20], 4, EPSILON)).toEqual([14, 16]);
    expect(intersectSpans([0, 10], [10 + EPSILON / 2, 20], EPSILON)).toEqual([
      10 + EPSILON / 2,
      10 + EPSILON / 2,
    ]);
    expect(spanContains([0, 10], [-EPSILON / 2, 10 + EPSILON / 2], EPSILON)).toBe(true);
    expect(coordinateInSpan(10 + EPSILON / 2, [0, 10], EPSILON)).toBe(true);
    expect(clampToSpan(12, [0, 10])).toBe(10);
  });

  it('reads endpoint cross coordinates without constructing an intermediate point', () => {
    const entities = [{ id: 'entity', x: 10, y: 20, width: 80, height: 30 }];
    const endpointFaces: readonly Direction[] = ['left', 'right', 'up', 'down'];
    const referenceFaces: readonly Direction[] = ['left', 'right', 'up', 'down'];

    for (const endpointFace of endpointFaces) {
      for (const authoredTrack of [undefined, 37]) {
        const endpoint: RouteEndpoint = {
          entityIndex: 0,
          face: endpointFace,
          ...(authoredTrack === undefined ? {} : { authoredTrack }),
        };
        const point = endpointPoint(entities, endpoint);
        for (const referenceFace of referenceFaces) {
          const expected =
            referenceFace === 'left' || referenceFace === 'right' ? point.y : point.x;
          expect(endpointCrossCoordinate(entities, endpoint, referenceFace)).toBe(expected);
        }
      }
    }
  });
});
