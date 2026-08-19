import { realizeRunDisplacement } from '../corridor/runDisplacement.js';

describe('routing corridor run displacement', () => {
  it('keeps an already selected track straight', () => {
    const subject = [
      { x: 0, y: 50 },
      { x: 200, y: 50 },
    ];

    const result = realizeRunDisplacement({
      points: subject,
      segmentIndex: 0,
      labelWindow: [80, 120],
      displacedTrack: 50,
      jogMargin: 16,
    });

    expect(result).toEqual({
      displacement: {
        kind: 'straight',
        baseTrack: 50,
        displacedTrack: 50,
      },
      points: subject,
    });
  });

  it('realizes a two-jog U on an interior segment', () => {
    const result = realizeRunDisplacement({
      points: [
        { x: 0, y: 20 },
        { x: 200, y: 20 },
      ],
      segmentIndex: 0,
      labelWindow: [80, 120],
      displacedTrack: 60,
      jogMargin: 16,
    });

    expect(result?.displacement.kind).toBe('u');
    expect(result?.points).toEqual([
      { x: 0, y: 20 },
      { x: 64, y: 20 },
      { x: 64, y: 60 },
      { x: 136, y: 60 },
      { x: 136, y: 20 },
      { x: 200, y: 20 },
    ]);
  });

  it('absorbs a return jog into an adjacent bend as an L', () => {
    const result = realizeRunDisplacement({
      points: [
        { x: 20, y: 20 },
        { x: 20, y: 80 },
        { x: 200, y: 80 },
        { x: 200, y: 20 },
      ],
      segmentIndex: 1,
      labelWindow: [80, 120],
      displacedTrack: 40,
      jogMargin: 16,
    });

    expect(result?.displacement.kind).toBe('l-from');
    expect(result?.points).toEqual([
      { x: 20, y: 20 },
      { x: 20, y: 40 },
      { x: 136, y: 40 },
      { x: 136, y: 80 },
      { x: 200, y: 80 },
      { x: 200, y: 20 },
    ]);
  });

  it('shifts a complete run when both neighboring legs preserve direction', () => {
    const result = realizeRunDisplacement({
      points: [
        { x: 180, y: 0 },
        { x: 180, y: 40 },
        { x: 20, y: 40 },
        { x: 20, y: 100 },
      ],
      segmentIndex: 1,
      labelWindow: [80, 160],
      displacedTrack: 60,
      jogMargin: 16,
      allowFullShift: true,
    });

    expect(result?.displacement.kind).toBe('shift');
    expect(result?.points).toEqual([
      { x: 180, y: 0 },
      { x: 180, y: 60 },
      { x: 20, y: 60 },
      { x: 20, y: 100 },
    ]);
  });
});
