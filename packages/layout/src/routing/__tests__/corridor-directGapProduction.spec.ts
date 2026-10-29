import { LayoutManager } from '../../LayoutManager.js';
import { constructDirectGapCorridors } from '../corridor/directGapCorridorConstruction.js';
import { buildBaseCorridorGeometry } from '../corridor/world.js';
import type { LayoutEntity } from '../../types.js';
import { describe, expect, it } from 'vitest';

describe('routing corridor direct-gap construction', () => {
  it.each([
    { blocked: false, spans: [[-20, 220]] },
    {
      blocked: true,
      spans: [
        [-20, 90],
        [110, 220],
      ],
    },
  ])('joins certified slices only across free bridges (blocked=$blocked)', ({ blocked, spans }) => {
    const entities: LayoutEntity[] = [
      { id: 'upper', x: 0, y: 0, width: 200, height: 20 },
      { id: 'lower', x: 0, y: 60, width: 200, height: 20 },
      // A remote obstacle splits the substrate into several slabs through the same gap.
      { id: 'cut', x: 40, y: -50, width: 5, height: 10 },
    ];
    if (blocked) {
      entities.push({ id: 'blocker', x: 90, y: 20, width: 20, height: 40 });
    }
    const layoutManager = new LayoutManager({ entities, connections: [] });
    const base = buildBaseCorridorGeometry(layoutManager, []);
    const result = constructDirectGapCorridors({
      bounds: base.bounds,
      layoutManager,
      freeSpace: base.freeSpace,
      runways: [],
    });

    expect(
      result.corridors
        .filter(({ axis, rect }) => axis === 'x' && rect.y === 20 && rect.height === 40)
        .map(({ rect }) => [rect.x, rect.x + rect.width]),
    ).toEqual(spans);
  });

  it('seeds only compact certified wall gaps whose travel miss is at most 20px', () => {
    const construct = (miss: number, crossGap = 40) => {
      const entities: readonly LayoutEntity[] = [
        { id: 'upper', x: 0, y: 0, width: 40, height: 40 },
        { id: 'lower', x: 40 + miss, y: 40 + crossGap, width: 40, height: 40 },
      ];
      const layoutManager = new LayoutManager({ entities: [...entities], connections: [] });
      const base = buildBaseCorridorGeometry(layoutManager, []);
      return constructDirectGapCorridors({
        bounds: base.bounds,
        layoutManager,
        freeSpace: base.freeSpace,
        runways: [],
      });
    };

    const atThreshold = construct(20);
    const hasNearMissCorridor = (result: ReturnType<typeof construct>): boolean =>
      result.corridors.some(
        (corridor) =>
          corridor.axis === 'x' &&
          corridor.rect.x === -20 &&
          corridor.rect.y === 40 &&
          corridor.rect.width === 140 &&
          corridor.rect.height === 40,
      );
    expect(hasNearMissCorridor(atThreshold)).toBe(true);
    expect(hasNearMissCorridor(construct(21))).toBe(false);
    expect(hasNearMissCorridor(construct(20, 101))).toBe(false);
  });
});
