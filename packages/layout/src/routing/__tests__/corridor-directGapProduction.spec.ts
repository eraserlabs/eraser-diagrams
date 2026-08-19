import { LayoutManager } from '../../LayoutManager.js';
import { constructDirectGapCorridors } from '../corridor/directGapCorridorConstruction.js';
import { buildBaseCorridorGeometry } from '../corridor/world.js';
import type { LayoutEntity } from '../../types.js';

describe('routing corridor direct-gap construction', () => {
  it('seeds only compact certified wall gaps whose travel miss is at most 20px', () => {
    const construct = (miss: number, crossGap = 40) => {
      const entities: readonly LayoutEntity[] = [
        { id: 'upper', x: 0, y: 0, width: 40, height: 40 },
        { id: 'lower', x: 40 + miss, y: 40 + crossGap, width: 40, height: 40 },
      ];
      const layoutManager = new LayoutManager({ entities: [...entities], connections: [] });
      const base = buildBaseCorridorGeometry(layoutManager);
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
