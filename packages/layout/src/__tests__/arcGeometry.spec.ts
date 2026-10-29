import {
  ARC_BEND_SNAP_THRESHOLD,
  ArcPoint,
  bendFromApex,
  distanceToArc,
  getArcApex,
  getArcBoundingBox,
  getArcCircle,
  getArcPathD,
  getArcPolyline,
  getConnectorLabelRoute,
  isArcBend,
  snapBend,
} from '../arcGeometry.js';

/**
 * Reconstruct the circle center implied by an SVG `A` arc from its endpoints,
 * radius and flags (W3C endpoint-to-center parameterization, simplified for the
 * equal-radii, no-rotation case we emit). Used to prove the emitted flags draw
 * an arc that actually passes through the apex on the intended side.
 */
function svgArcCenter(
  start: ArcPoint,
  end: ArcPoint,
  radius: number,
  largeArc: 0 | 1,
  sweep: 0 | 1,
): ArcPoint {
  const midX = (start[0] - end[0]) / 2;
  const midY = (start[1] - end[1]) / 2;
  const r = radius;
  const denom = r * r;
  const numer = denom - midX * midX - midY * midY;
  const factor = Math.sqrt(Math.max(0, numer / (midX * midX + midY * midY)));
  const sign = largeArc !== sweep ? 1 : -1;
  const cxp = sign * factor * midY;
  const cyp = sign * factor * -midX;
  return [cxp + (start[0] + end[0]) / 2, cyp + (start[1] + end[1]) / 2];
}

describe('arcGeometry', () => {
  const S: ArcPoint = [0, 0];
  const E: ArcPoint = [100, 0];

  it.each([9000, -9000])('fully contains a strongly bent diagonal arc (%s)', (bend) => {
    const start: ArcPoint = [20, 35];
    const end: ArcPoint = [110, 240];
    const bounds = getArcBoundingBox(start, end, bend);
    for (const point of getArcPolyline(start, end, bend, 10000)) {
      expect(point[0]).toBeGreaterThanOrEqual(bounds[0] - 1e-7);
      expect(point[1]).toBeGreaterThanOrEqual(bounds[1] - 1e-7);
      expect(point[0]).toBeLessThanOrEqual(bounds[2] + 1e-7);
      expect(point[1]).toBeLessThanOrEqual(bounds[3] + 1e-7);
    }
  });

  describe('snapBend / isArcBend', () => {
    it('snaps sub-threshold bends to straight', () => {
      expect(snapBend(ARC_BEND_SNAP_THRESHOLD - 0.1)).toBe(0);
      expect(snapBend(-(ARC_BEND_SNAP_THRESHOLD - 0.1))).toBe(0);
    });

    it('keeps bends at or above threshold', () => {
      expect(snapBend(ARC_BEND_SNAP_THRESHOLD + 5)).toBe(ARC_BEND_SNAP_THRESHOLD + 5);
    });

    it('recognizes numeric bends only', () => {
      expect(isArcBend(0)).toBe(true);
      expect(isArcBend(12)).toBe(true);
      expect(isArcBend(undefined)).toBe(false);
      expect(isArcBend(null)).toBe(false);
      expect(isArcBend(NaN)).toBe(false);
    });
  });

  describe('apex round-trips with bend', () => {
    it.each([-180, 180])(
      'collapses continuously through coincident endpoints (bend %s)',
      (bend) => {
        let previous = getArcApex([400, 300], [399, 300.001], bend);
        for (let i = -99; i <= 100; i++) {
          const end: ArcPoint = [400 + i / 100, 300.001];
          const apex = getArcApex([400, 300], end, bend);
          expect(Math.hypot(apex[0] - previous[0], apex[1] - previous[1])).toBeLessThan(0.1);
          expect(bendFromApex([400, 300], end, apex)).toBeCloseTo(bend);
          expect(distanceToArc(apex, [400, 300], end, bend)).toBeCloseTo(0, 4);
          previous = apex;
        }
        expect(getArcApex(S, S, bend)).toEqual(S);
        expect(getArcCircle(S, S, bend)).toBeNull();
        expect(getArcApex(S, E, bend)).toEqual([50, bend]);
      },
    );

    it('places the apex on the perpendicular and recovers bend', () => {
      const apex = getArcApex(S, E, 20);
      // chord is horizontal, perp is +y, so apex sits at (50, 20)
      expect(apex[0]).toBeCloseTo(50);
      expect(apex[1]).toBeCloseTo(20);
      expect(bendFromApex(S, E, apex)).toBeCloseTo(20);
    });

    it('recovers negative bend from an apex on the other side', () => {
      const apex = getArcApex(S, E, -35);
      expect(apex[1]).toBeCloseTo(-35);
      expect(bendFromApex(S, E, apex)).toBeCloseTo(-35);
    });
  });

  describe('getArcCircle flags draw through the apex', () => {
    const cases = [12, 40, 70, 120, -12, -40, -70, -120];
    it.each(cases)('bend=%p produces an arc through the apex', (bend) => {
      const circle = getArcCircle(S, E, bend);
      expect(circle).not.toBeNull();
      const { center, radius, largeArc, sweep } = circle!;

      // The reconstructed SVG center must match the analytic circumcenter.
      const reconstructed = svgArcCenter(S, E, radius, largeArc, sweep);
      expect(reconstructed[0]).toBeCloseTo(center[0], 3);
      expect(reconstructed[1]).toBeCloseTo(center[1], 3);

      // The apex must lie on the circle, on the bend's side of the chord.
      const apex = getArcApex(S, E, bend);
      expect(Math.hypot(apex[0] - center[0], apex[1] - center[1])).toBeCloseTo(radius, 3);
      expect(Math.sign(apex[1])).toBe(Math.sign(bend));
    });

    it('marks bends beyond the half-chord as large arcs', () => {
      // half-chord here is 50; bend 70 > 50 => major arc
      expect(getArcCircle(S, E, 70)!.largeArc).toBe(1);
      expect(getArcCircle(S, E, 30)!.largeArc).toBe(0);
    });

    it('flips sweep with the sign of bend', () => {
      expect(getArcCircle(S, E, 30)!.sweep).toBe(0);
      expect(getArcCircle(S, E, -30)!.sweep).toBe(1);
    });
  });

  describe('getArcBoundingBox', () => {
    it('returns the chord bbox below the snap threshold', () => {
      expect(getArcBoundingBox(S, E, ARC_BEND_SNAP_THRESHOLD - 1)).toEqual([0, 0, 100, 0]);
    });

    it('includes the apex of a semicircle bend', () => {
      // bend == half-chord (50) => semicircle apex at (50, 50)
      const [minX, minY, maxX, maxY] = getArcBoundingBox(S, E, 50);
      expect(minX).toBeCloseTo(0, 1);
      expect(minY).toBeCloseTo(0, 1);
      expect(maxX).toBeCloseTo(100, 1);
      expect(maxY).toBeCloseTo(50, 1);
    });

    it('expands beyond the chord for a major (over-bent) arc', () => {
      const [minX, , maxX, maxY] = getArcBoundingBox(S, E, 120);
      // The apex sits at y=120, well past the chord.
      expect(maxY).toBeGreaterThan(115);
      // A major arc wraps past the endpoints horizontally too.
      expect(minX).toBeLessThan(0);
      expect(maxX).toBeGreaterThan(100);
    });

    it('mirrors for negative bend', () => {
      const [, minY, , maxY] = getArcBoundingBox(S, E, -50);
      expect(minY).toBeCloseTo(-50, 1);
      expect(maxY).toBeCloseTo(0, 1);
    });
  });

  describe('distanceToArc', () => {
    it('is ~0 for a point on the apex of a minor arc', () => {
      expect(distanceToArc(getArcApex(S, E, 60), S, E, 60)).toBeCloseTo(0, 6);
    });

    it('is ~0 for a point on the apex of a major (over-bent) arc', () => {
      // bend 120 > half-chord 50 => the sweep exceeds π; the apex must still be
      // recognized as on-curve (regression for the within-sweep wraparound).
      expect(distanceToArc(getArcApex(S, E, 120), S, E, 120)).toBeCloseTo(0, 6);
    });

    it('is ~0 at the endpoints', () => {
      expect(distanceToArc(S, S, E, 60)).toBeCloseTo(0, 6);
      expect(distanceToArc(E, S, E, 60)).toBeCloseTo(0, 6);
    });

    it('measures radial distance for a point off the curve but within the sweep', () => {
      // bend 50 => semicircle, center (50,0), radius 50. A point 10px inside the
      // apex (50,40) is 10px off the circle.
      expect(distanceToArc([50, 40], S, E, 50)).toBeCloseTo(10, 6);
    });

    it('does not treat the chord midpoint as on the arc', () => {
      // The chord midpoint is far from a strongly bent arc (nearest point is an
      // endpoint, 50px away) — so it is well outside any hit threshold.
      expect(distanceToArc([50, 0], S, E, 80)).toBeCloseTo(50, 3);
    });

    it('falls back to chord-segment distance below the snap threshold', () => {
      // Near-flat: behaves like a straight segment; the midpoint is on it.
      expect(distanceToArc([50, 0], S, E, 2)).toBeCloseTo(0, 6);
      expect(distanceToArc([50, 5], S, E, 2)).toBeCloseTo(5, 6);
    });
  });

  describe('getArcPolyline', () => {
    it('pins the exact endpoints and bulges to the apex at the midpoint', () => {
      const route = getArcPolyline(S, E, 50, 8);
      expect(route[0]).toEqual([0, 0]);
      expect(route[route.length - 1]).toEqual([100, 0]);
      expect(route).toHaveLength(9);
      // Even sample count ⇒ the middle vertex sits on the apex (50, 50).
      const mid = route[4];
      expect(mid[0]).toBeCloseTo(50, 6);
      expect(mid[1]).toBeCloseTo(50, 6);
    });

    it('every sampled vertex lies on the arc circle', () => {
      const route = getArcPolyline(S, E, 60, 16);
      const { center, radius } = getArcCircle(S, E, 60)!;
      for (const [x, y] of route) {
        expect(Math.hypot(x - center[0], y - center[1])).toBeCloseTo(radius, 6);
      }
    });

    it('returns the chord below the snap threshold', () => {
      expect(getArcPolyline(S, E, ARC_BEND_SNAP_THRESHOLD - 1)).toEqual([
        [0, 0],
        [100, 0],
      ]);
    });
  });

  describe('getConnectorLabelRoute', () => {
    it('samples the curve for a 2-point arc', () => {
      const route = getConnectorLabelRoute([S, E], 50);
      expect(route.length).toBeGreaterThan(2);
      // A sampled mid-vertex must sit off the chord (the bow), not on y=0.
      expect(route.some(([, y]) => Math.abs(y) > 1)).toBe(true);
    });

    it('returns the raw points for a straight (no-bend) connector', () => {
      expect(getConnectorLabelRoute([S, E], undefined)).toEqual([
        [0, 0],
        [100, 0],
      ]);
      expect(getConnectorLabelRoute([S, E], 0)).toEqual([
        [0, 0],
        [100, 0],
      ]);
    });

    it('returns the raw points for a multi-point connector even with a bend', () => {
      const elbow: ArcPoint[] = [
        [0, 0],
        [0, 50],
        [100, 50],
      ];
      expect(getConnectorLabelRoute(elbow, 40)).toEqual([
        [0, 0],
        [0, 50],
        [100, 50],
      ]);
    });

    it('falls back to the chord below the snap threshold', () => {
      expect(getConnectorLabelRoute([S, E], ARC_BEND_SNAP_THRESHOLD - 1)).toEqual([
        [0, 0],
        [100, 0],
      ]);
    });
  });

  describe('getArcPathD', () => {
    it('returns a straight segment under the snap threshold', () => {
      expect(getArcPathD(S, E, ARC_BEND_SNAP_THRESHOLD - 1)).toBe('M 0 0 L 100 0');
    });

    it('emits an arc command above the threshold', () => {
      const d = getArcPathD(S, E, 40);
      expect(d.startsWith('M 0 0 A ')).toBe(true);
      expect(d.endsWith('100 0')).toBe(true);
    });

    it('degenerate (coincident) endpoints fall back to a straight segment', () => {
      expect(getArcPathD(S, S, 40)).toBe('M 0 0 L 0 0');
    });
  });
});
