import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutEntity, PositionProps } from '../../types.js';
import { CorridorIndexer } from '../corridor/corridorIndex.js';
import { describe, expect, it } from 'vitest';

describe('corridor indexer border profiles', () => {
  it.each([-2147483700, -100, -0, 0.25, 2147483700])(
    'preserves diagram-border coverage at offset %s on either axis',
    (offset) => {
      const layoutManager = new LayoutManager({ entities: [], connections: [] });
      const rect = { x: offset, y: offset, width: 100, height: 120 };
      const indexer = new CorridorIndexer(
        [
          { index: 0, axis: 'x', rect },
          { index: 1, axis: 'y', rect },
        ],
        [],
        [],
        layoutManager,
        rect,
      );

      expect(indexer.corridorBorderProfile(0)).toEqual({
        negative: [offset, offset + 100],
        positive: [offset, offset + 100],
        diagramBorderSides: 3,
      });
      expect(indexer.corridorBorderProfile(1)).toEqual({
        negative: [offset, offset + 120],
        positive: [offset, offset + 120],
        diagramBorderSides: 3,
      });
    },
  );

  it('clips a separated caption spill out of corridor wall profiles', () => {
    const entity: LayoutEntity = {
      id: 'icon',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      textPlacement: { relativeX: -10, relativeY: 55, width: 70, height: 24 },
    };
    const indexer = new CorridorIndexer(
      [{ index: 0, axis: 'x', rect: { x: -10, y: 50, width: 9, height: 29 } }],
      [],
      [],
      new LayoutManager({ entities: [entity], connections: [] }),
      { x: -100, y: -100, width: 300, height: 300 },
    );

    expect(indexer.corridorBorderProfile(0)).toEqual({
      negative: [],
      positive: [],
      diagramBorderSides: 0,
    });
    expect(indexer.wallFacesForCorridor(0)).toEqual([]);
  });

  it('does not attribute the uncovered body-face span to a narrow caption blocker', () => {
    const entity: LayoutEntity = {
      id: 'icon',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      textPlacement: { relativeX: 10, relativeY: 55, width: 20, height: 24 },
    };
    const indexer = new CorridorIndexer(
      [{ index: 0, axis: 'x', rect: { x: 0, y: 55, width: 9, height: 24 } }],
      [],
      [],
      new LayoutManager({ entities: [entity], connections: [] }),
      { x: -100, y: -100, width: 300, height: 300 },
    );

    expect(indexer.corridorBorderProfile(0)).toEqual({
      negative: [],
      positive: [],
      diagramBorderSides: 0,
    });
    expect(indexer.wallFacesForCorridor(0)).toEqual([]);
  });

  it.each(['x', 'y'] as const)(
    'unions overlapping and touching %s-wall spans while preserving gaps and clipping',
    (axis) => {
      const orient = (rect: PositionProps): PositionProps =>
        axis === 'x' ? rect : { x: rect.y, y: rect.x, width: rect.height, height: rect.width };
      const entities = [
        { id: 'clipped-start', x: -10, y: 0, width: 30, height: 10 },
        { id: 'duplicate', x: 0, y: 0, width: 20, height: 10 },
        { id: 'nested', x: 5, y: 0, width: 10, height: 10 },
        { id: 'overlap', x: 15, y: 0, width: 15, height: 10 },
        { id: 'touch', x: 30, y: 0, width: 10, height: 10 },
        { id: 'clipped-end', x: 50, y: 0, width: 70, height: 10 },
        { id: 'point-only', x: 100, y: 30, width: 10, height: 10 },
        { id: 'other-wall', x: 70, y: 30, width: 10, height: 10 },
        { id: 'off-wall', x: 0, y: 1, width: 100, height: 8 },
      ].map((entity) => ({ id: entity.id, ...orient(entity) }));
      const negative = [0, 40, 50, 100];
      const positive = [70, 80];
      for (const ordered of [entities, [...entities].reverse()]) {
        const indexer = new CorridorIndexer(
          [{ index: 0, axis, rect: orient({ x: 0, y: 10, width: 100, height: 20 }) }],
          [],
          [],
          new LayoutManager({ entities: ordered, connections: [] }),
          { x: -100, y: -100, width: 300, height: 300 },
        );
        expect(indexer.corridorBorderProfile(0)).toEqual({
          negative,
          positive,
          diagramBorderSides: 0,
        });
      }
    },
  );
});
