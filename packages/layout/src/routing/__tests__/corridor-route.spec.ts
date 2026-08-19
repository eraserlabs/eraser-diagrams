import type { CorridorVisit } from '../corridor/route.js';
import { Route } from '../corridor/route.js';

const VISITS: readonly CorridorVisit[] = [
  {
    corridorIndex: 3,
    entry: { kind: 'terminal', attachmentIndex: 2 },
    exit: { kind: 'portal', portalIndex: 7, mode: 'turn' },
    feasibleTrack: [10, 30],
  },
  {
    corridorIndex: 8,
    entry: { kind: 'portal', portalIndex: 7, mode: 'turn' },
    exit: { kind: 'terminal', attachmentIndex: 9 },
    feasibleTrack: [40, 80],
  },
];

function route(): Route {
  return new Route(0, { entityIndex: 0, face: 'right' }, { entityIndex: 1, face: 'up' }, VISITS);
}

describe('routing corridor Route', () => {
  it('progressively enhances one route', () => {
    const subject = route();
    expect(() => subject.orderOf(0)).toThrow('requires an active realization');

    subject.beginRealization();
    expect(() => subject.nominalTrackOf(0)).toThrow("requires phase >= 'spaced'");
    subject.setOrder([0, 1]);
    subject.setNominalTracks([20, 60]);
    subject.setGeometry(
      { from: { x: 0, y: 20 }, to: { x: 60, y: 0 } },
      [
        { x: 0, y: 20 },
        { x: 60, y: 20 },
        { x: 60, y: 0 },
      ],
      [0, 1],
    );

    expect(subject.orderOf(1)).toBe(1);
    expect(subject.nominalTrackOf(0)).toBe(20);
    expect(subject.points()).toHaveLength(3);
    expect(subject.visits).toBe(VISITS);
  });

  it('rejects malformed phase writes and tracks outside search feasibility', () => {
    const subject = route();
    subject.beginRealization();
    expect(() => subject.setOrder([0])).toThrow('1 orders for 2 visits');
    expect(() => subject.setOrder([0, -1])).toThrow('invalid order -1');
    subject.setOrder([0, 1]);
    expect(() => subject.setNominalTracks([9, 60])).toThrow('outside visit 0 span');
    expect(() => subject.setNominalTracks([20, Number.NaN])).toThrow('outside visit 1 span');
  });

  it('accepts only final quantized cardinal geometry that terminates at its ports', () => {
    const subject = route();
    subject.beginRealization();
    subject.setOrder([0, 1]);
    subject.setNominalTracks([20, 60]);
    const ports = { from: { x: 0, y: 20 }, to: { x: 60, y: 0 } };

    expect(() =>
      subject.setGeometry(
        ports,
        [
          { x: 1, y: 20 },
          { x: 60, y: 0 },
        ],
        [0],
      ),
    ).toThrow('endpoints do not match ports');
    expect(() =>
      subject.setGeometry(
        ports,
        [
          { x: 0, y: 20 },
          { x: 30, y: 10 },
          { x: 60, y: 0 },
        ],
        [0, 1],
      ),
    ).toThrow('diagonal emitted segment');
    expect(() =>
      subject.setGeometry(
        ports,
        [
          { x: 0, y: 20 },
          { x: 60.5, y: 20 },
          { x: 60, y: 0 },
        ],
        [0, 1],
      ),
    ).toThrow('not quantized');
    expect(() =>
      subject.setGeometry(
        ports,
        [
          { x: 0, y: 20 },
          { x: 60, y: 20 },
          { x: 60, y: 0 },
        ],
        [0],
      ),
    ).toThrow('1 segment visits for 2 emitted segments');
    expect(() =>
      subject.setGeometry(
        ports,
        [
          { x: 0, y: 20 },
          { x: 60, y: 20 },
          { x: 60, y: 0 },
        ],
        [0, 2],
      ),
    ).toThrow('invalid visit 2 for segment 1');
  });

  it('retains segment provenance', () => {
    const subject = route();
    subject.beginRealization();
    subject.setOrder([0, 1]);
    subject.setNominalTracks([20, 60]);
    subject.setGeometry(
      { from: { x: 0, y: 20 }, to: { x: 60, y: 0 } },
      [
        { x: 0, y: 20 },
        { x: 30, y: 20 },
        { x: 30, y: 0 },
        { x: 60, y: 0 },
      ],
      [0, 0, 0],
    );

    expect([0, 1, 2].map((segmentIndex) => subject.segmentVisitOf(segmentIndex))).toEqual([
      0, 0, 0,
    ]);
    expect(subject.segmentVisitOf(2)).toBe(0);
  });
});
