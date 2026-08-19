import { corridorIdealTrack, MIN_TRACK_SEPARATION_PX } from '../corridor/spacing.js';
import {
  COMPONENT_SOLVER_TOLERANCE,
  InfeasibleSpacingComponentError,
  type SpacingGapConstraint,
  type SpacingKernelResult,
  type SpacingKernelUnit,
  solveSpacingKernel,
} from '../corridor/spacingKernel.js';
import type { CorridorBorderSpan, ProfiledCorridor } from '../corridor/contract.js';
import type { TrackDesire } from '../corridor/spacingObjective.js';

function unit(
  desires: readonly TrackDesire[],
  bounds: readonly [number, number] = [0, 100],
): SpacingKernelUnit {
  return {
    lower: bounds[0],
    upper: bounds[1],
    desires,
    authored: false,
  };
}

function orderedGaps(count: number, gap = MIN_TRACK_SEPARATION_PX): SpacingGapConstraint[] {
  return Array.from({ length: Math.max(0, count - 1) }, (_, before) => ({
    before,
    after: before + 1,
    gap,
  }));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function expectConverged(solved: SpacingKernelResult): SpacingKernelResult {
  expect(solved.metrics.converged).toBe(true);
  return solved;
}

describe('routing corridor spacing kernel desire priorities', () => {
  const center = (track = 50): TrackDesire => ({
    kind: 'corridor-ideal',
    track,
    weight: 1,
  });

  it('centers an ordinary minimum-gap pack around corridor center', () => {
    const units = [unit([center()]), unit([center()]), unit([center()])];

    const solved = solveSpacingKernel(units, orderedGaps(units.length));

    expect(solved.tracks).toEqual([42, 50, 58]);
  });

  it('lets a terminal desire suppress the corridor fallback', () => {
    const solved = solveSpacingKernel(
      [unit([center(), { kind: 'terminal', track: 70, weight: 0.25 }])],
      [],
    );

    expect(solved.tracks).toEqual([70]);
    expect([...solved.unitCosts]).toEqual([0]);
    expect(solved.objective).toBe(0);
  });

  it('lets a U-turn desire suppress the corridor fallback', () => {
    const solved = solveSpacingKernel(
      [unit([center(), { kind: 'u-turn', track: 20, weight: 4 }])],
      [],
    );

    expect(solved.tracks).toEqual([20]);
    expect([...solved.unitCosts]).toEqual([0]);
    expect(solved.objective).toBe(0);
  });

  it.each(['terminal-lead', 'terminal-window'] as const)(
    'lets a %s desire suppress the corridor fallback',
    (kind) => {
      const solved = solveSpacingKernel([unit([center(), { kind, track: 30, weight: 2 }])], []);

      expect(solved.tracks).toEqual([30]);
      expect(solved.objective).toBe(0);
    },
  );

  it('captures the solved semantic objective without reintroducing the corridor fallback', () => {
    const solved = solveSpacingKernel(
      [
        unit([
          { kind: 'corridor-ideal', track: 100, weight: 100 },
          { kind: 'terminal', track: 20, weight: 1 },
          { kind: 'u-turn', track: 40, weight: 3 },
        ]),
      ],
      [],
    );

    expect(solved.tracks).toEqual([35]);
    expect([...solved.unitCosts]).toEqual([300]);
    expect(solved.objective).toBe(300);
  });

  it('keeps an ordinary pack centered when a strong U-turn has room beside it', () => {
    const units = [
      unit([{ kind: 'corridor-ideal', track: 20, weight: 4 }]),
      unit([center()]),
      unit([center()]),
    ];

    const solved = solveSpacingKernel(units, orderedGaps(units.length));

    expect(solved.tracks).toEqual([20, 46, 54]);
  });
});

describe('routing corridor spacing kernel projection', () => {
  const desire = (track: number, weight: number): TrackDesire => ({
    kind: 'corridor-ideal',
    track,
    weight,
  });

  it('holds a pinned lower===upper unit at its pin', () => {
    const solved = solveSpacingKernel(
      [
        { lower: 36, upper: 36, desires: [desire(48, 1)], authored: false },
        { lower: 40, upper: 80, desires: [desire(41, 1)], authored: false },
      ],
      [{ before: 0, after: 1, gap: 8 }],
    );

    expect(solved.tracks).toEqual([36, 44]);
    expect(solved.metrics.converged).toBe(true);
  });

  it('attributes zero-gap infeasibility to only the failed component', () => {
    let failure: unknown;
    try {
      solveSpacingKernel(
        [unit([desire(10, 1)], [10, 10]), unit([desire(0, 1)], [0, 0]), unit([desire(50, 1)])],
        [{ before: 0, after: 1, gap: 8 }],
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InfeasibleSpacingComponentError);
    expect((failure as InfeasibleSpacingComponentError).unitIndexes).toEqual([0, 1]);
  });

  it('keeps bounds inside PAVA block minimization instead of clamping afterward', () => {
    const units = [
      { lower: -100, upper: 2, desires: [desire(10, 1)], authored: true },
      { lower: -100, upper: 100, desires: [desire(0, 1)], authored: true },
    ];
    const constraint = { before: 0, after: 1, gap: 0 };
    const solved = solveSpacingKernel(units, [constraint]);
    const general = expectConverged(solveSpacingKernel(units, [constraint, { ...constraint }]));

    expect(solved.tracks).toEqual([2, 2]);
    general.tracks.forEach((track, index) => {
      expect(track).toBeCloseTo(solved.tracks[index], 4);
    });
  });

  it('absorbs sub-epsilon capacity-fit noise for a fully pinned path', () => {
    const units = Array.from({ length: 3 }, () => ({
      lower: 310,
      upper: 310,
      desires: [desire(310, 1)],
      authored: true,
    }));

    const solved = expectConverged(solveSpacingKernel(units, orderedGaps(3)));

    expect(solved.tracks).toEqual([310, 310, 310]);
    expect(solved.capacityReductions).toHaveLength(1);
    expect(solved.capacityReductions[0].achieved).toBeLessThan(1e-12);
  });

  it('reports spacing lost to track quantization instead of rejecting the solve', () => {
    const solved = expectConverged(
      solveSpacingKernel(
        [unit([desire(0, 1)], [-100, 100]), unit([desire(1, 1)], [-100, 100])],
        [{ before: 0, after: 1, gap: 1.5 }],
      ),
    );

    expect(solved.tracks[0]).toBeCloseTo(0);
    expect(solved.tracks[1]).toBe(1);
    expect(solved.quantizationReductions).toEqual([
      { unitIndexes: [0, 1], required: 1.5, achieved: 1 },
    ]);
    expect(solved.metrics.quantizationViolationCount).toBe(0);
  });

  it('matches the general solver on an extreme unconstrained-bound weight split', () => {
    const units = [unit([desire(50, 0.05)], [-100, 100]), unit([desire(50, 64)], [-100, 100])].map(
      (candidate) => ({ ...candidate, authored: true }),
    );
    const constraint = { before: 0, after: 1, gap: 8 };

    const pava = expectConverged(solveSpacingKernel(units, [constraint]));
    const general = expectConverged(solveSpacingKernel(units, [constraint, { ...constraint }]));

    pava.tracks.forEach((track, index) => {
      expect(track).toBeCloseTo(general.tracks[index], 6);
    });
  });

  it('matches the corrected general solver on generated bounded weighted paths', () => {
    const random = seededRandom(0x5a17c0de);
    const weights = [0.05, 0.25, 1, 4, 64];
    let generalComparisonCount = 0;
    for (let sample = 0; sample < 80; sample += 1) {
      const count = 2 + Math.floor(random() * 7);
      const path = shuffled(
        Array.from({ length: count }, (_, index) => index),
        random,
      );
      // Half-pixel gaps keep the post-solve integer quantizer from masking the
      // continuous differential comparison while still exercising offsets.
      const gaps = Array.from({ length: count - 1 }, () => Math.floor(random() * 13) + 0.5);
      const feasibleTracks = new Array<number>(count);
      let feasibleTrack = Math.floor(random() * 41) - 20;
      feasibleTracks[path[0]] = feasibleTrack;
      for (let position = 1; position < count; position += 1) {
        feasibleTrack += gaps[position - 1] + Math.floor(random() * 9);
        feasibleTracks[path[position]] = feasibleTrack;
      }
      const pinnedIndex = sample % 5 === 0 ? path[Math.floor(random() * count)] : undefined;
      const units = feasibleTracks.map((track, unitIndex): SpacingKernelUnit => {
        const pinned = unitIndex === pinnedIndex;
        const lower = pinned ? track : track - Math.floor(random() * 21);
        const upper = pinned ? track : track + Math.floor(random() * 21);
        return {
          lower,
          upper,
          desires: [
            desire(
              track + Math.floor(random() * 81) - 40,
              pinnedIndex === undefined ? weights[Math.floor(random() * weights.length)] : 1,
            ),
          ],
          authored: true,
        };
      });
      const constraints = shuffled(
        path.slice(1).map((after, position) => ({
          before: path[position],
          after,
          gap: gaps[position],
        })),
        random,
      );

      const pava = expectConverged(solveSpacingKernel(units, constraints));
      pava.tracks.forEach((track, unitIndex) => {
        expect(track).toBeGreaterThanOrEqual(units[unitIndex].lower - 1e-9);
        expect(track).toBeLessThanOrEqual(units[unitIndex].upper + 1e-9);
      });
      for (const constraint of constraints) {
        expect(
          pava.tracks[constraint.after] - pava.tracks[constraint.before],
        ).toBeGreaterThanOrEqual(constraint.gap - 1e-9);
      }
      if (pinnedIndex !== undefined) {
        expect(pava.tracks[pinnedIndex]).toBeCloseTo(feasibleTracks[pinnedIndex], 10);
      }

      const sampleWeights = units.map((candidate) => candidate.desires[0].weight);
      const weightRatio = Math.max(...sampleWeights) / Math.min(...sampleWeights);
      if (weightRatio <= 16) {
        const dummyTrack = Math.min(...units.map((candidate) => candidate.lower)) - 1_000;
        const generalUnits = [
          ...units,
          {
            lower: dummyTrack,
            upper: dummyTrack,
            desires: [desire(dummyTrack, 1)],
            authored: true,
          },
          {
            lower: dummyTrack - 1,
            upper: dummyTrack - 1,
            desires: [desire(dummyTrack - 1, 1)],
            authored: true,
          },
        ];
        const general = expectConverged(
          solveSpacingKernel(generalUnits, [
            ...constraints,
            { before: units.length, after: path[0], gap: 0 },
            { before: units.length + 1, after: path[0], gap: 0 },
          ]),
        );
        pava.tracks.forEach((track, unitIndex) => {
          expect(Math.abs(track - general.tracks[unitIndex])).toBeLessThanOrEqual(
            COMPONENT_SOLVER_TOLERANCE * 8,
          );
        });
        generalComparisonCount += 1;
      }
    }
    expect(generalComparisonCount).toBeGreaterThanOrEqual(15);
  });

  it('uses the path walk rather than array or constraint order', () => {
    const solved = solveSpacingKernel(
      [unit([desire(50, 1)]), unit([desire(50, 1)]), unit([desire(50, 1)])],
      [
        { before: 0, after: 1, gap: 8 },
        { before: 2, after: 0, gap: 8 },
      ],
    );

    expect(solved.tracks).toEqual([50, 58, 42]);
  });

  it('waits for residual stabilization in the general fallback', () => {
    const constraints = orderedGaps(4);

    // Residual stabilization prevents primal movement from appearing converged
    // before the weighted projection has settled.
    const solved = solveSpacingKernel(
      [
        { lower: 36, upper: 36, desires: [desire(48, 1)], authored: true },
        { lower: 54, upper: 59, desires: [desire(13, 1)], authored: true },
        { lower: 56, upper: 63, desires: [desire(49, 1)], authored: true },
        { lower: 41, upper: 73, desires: [desire(55, 1)], authored: true },
      ],
      [...constraints, { ...constraints[0] }],
    );

    expect(solved.metrics.converged).toBe(true);
    solved.tracks.forEach((track, index) => {
      expect(track).toBeCloseTo([36, 54, 62, 70][index], 6);
    });
    expect(solved.objective).toBeCloseTo(2219, 6);
  });

  it('records converged=false when the general solver hits its iteration cap', () => {
    // A pinned unit dragging a heavy partner through a weighted split of
    // 0.05 : 64 creeps slower than the cap allows. The kernel records the
    // failure and still emits legal tracks.
    const units = [
      { lower: 52, upper: 52, desires: [desire(18, 0.05)], authored: false },
      { lower: 15, upper: 60, desires: [desire(39, 64)], authored: false },
    ];
    const constraint = { before: 0, after: 1, gap: 8 };
    const exact = expectConverged(solveSpacingKernel(units, [constraint]));
    expect(exact.tracks).toEqual([52, 60]);

    // The duplicate is mathematically redundant but deliberately fails the
    // strict path detector so this continues to specify general-solver cap semantics.
    const constraints = [constraint, { ...constraint }];

    const degraded = solveSpacingKernel(units, constraints);
    expect(degraded.metrics.converged).toBe(false);
    expect(degraded.tracks).toEqual([52, 60]);
  });
});

function border(kind: CorridorBorderSpan['kind'], start = 0, end = 100) {
  return kind === 'entity'
    ? ({ kind, span: [start, end] as const, entityId: 'entity' } as const)
    : ({ kind, span: [start, end] as const } as const);
}

function profiledX(
  top: readonly CorridorBorderSpan[],
  bottom: readonly CorridorBorderSpan[],
): ProfiledCorridor {
  return {
    index: 0,
    axis: 'x',
    rect: { x: 0, y: 0, width: 100, height: 100 },
    borderProfile: { axis: 'x', top, bottom },
  };
}

function profiledY(
  left: readonly CorridorBorderSpan[],
  right: readonly CorridorBorderSpan[],
): ProfiledCorridor {
  return {
    index: 0,
    axis: 'y',
    rect: { x: 0, y: 0, width: 100, height: 100 },
    borderProfile: { axis: 'y', left, right },
  };
}

describe('routing corridor corridor ideal producer', () => {
  it('centers between entities or through open space', () => {
    expect(corridorIdealTrack(profiledX([border('entity')], [border('entity')]), [0, 100])).toBe(
      50,
    );
    expect(corridorIdealTrack(profiledX([], []), [0, 100])).toBe(50);
    expect(
      corridorIdealTrack(
        profiledX([border('diagram-border')], [border('diagram-border')]),
        [0, 100],
      ),
    ).toBe(50);
  });

  it('centers one-sided entity runs whose far border is a phantom plane', () => {
    expect(corridorIdealTrack(profiledX([border('entity')], []), [0, 100])).toBe(50);
    expect(corridorIdealTrack(profiledX([], [border('entity')]), [0, 100])).toBe(50);
    expect(corridorIdealTrack(profiledY([border('entity')], []), [0, 100])).toBe(50);
  });

  it('places entity-boundary runs four pixels from the diagram side', () => {
    expect(
      corridorIdealTrack(profiledX([border('diagram-border')], [border('entity')]), [0, 100]),
    ).toBe(4);
    expect(
      corridorIdealTrack(profiledX([border('entity')], [border('diagram-border')]), [0, 100]),
    ).toBe(96);
  });

  it('reduces each side over only the run span', () => {
    const corridor = profiledX([border('entity', 70, 100)], []);
    expect(corridorIdealTrack(corridor, [0, 60])).toBe(50);
    // Entity overlaps the run but the far border stays phantom: still centered.
    expect(corridorIdealTrack(corridor, [0, 100])).toBe(50);
  });
});
