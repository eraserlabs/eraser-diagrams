import { LayoutManager } from '../../LayoutManager.js';
import type { LayoutEntity, LayoutRange } from '../../types.js';
import type { Corridor } from '../corridor/contract.js';
import { CorridorIndexer } from '../corridor/corridorIndex.js';

describe('corridor indexer border profiles', () => {
  it('attributes entities and diagram borders without profiling adjacent corridors', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const entities: LayoutEntity[] = [
      { id: 'leaf', x: 0, y: 0, width: 40, height: 10 },
      { id: 'group', x: 40, y: 0, width: 60, height: 10, isContainer: true },
    ];
    const corridors: Corridor[] = [
      { index: 0, axis: 'x', rect: { x: 0, y: 10, width: 100, height: 20 } },
      { index: 1, axis: 'x', rect: { x: 20, y: 30, width: 50, height: 20 } },
      { index: 2, axis: 'x', rect: { x: 40, y: -10, width: 60, height: 20 } },
      { index: 3, axis: 'y', rect: { x: 0, y: 60, width: 10, height: 40 } },
    ];

    let rangeQueryCount = 0;
    const layoutManager = new LayoutManager({ entities, connections: [] });
    const findEntitiesInRange = layoutManager.findEntitiesInRange.bind(layoutManager);
    layoutManager.findEntitiesInRange = (range: Partial<LayoutRange>) => {
      rangeQueryCount += 1;
      return findEntitiesInRange(range);
    };

    const indexer = new CorridorIndexer(corridors, [], [], layoutManager, bounds);

    expect(rangeQueryCount).toBe(0);
    expect(indexer.corridors[0].borderProfile).toEqual({
      axis: 'x',
      top: [
        { span: [0, 40], kind: 'entity', entityId: 'leaf' },
        { span: [40, 100], kind: 'entity', entityId: 'group' },
      ],
      bottom: [],
    });
    expect(rangeQueryCount).toBe(1);
    expect(indexer.corridors[0].borderProfile).toBe(indexer.corridors[0].borderProfile);
    expect(rangeQueryCount).toBe(1);
    expect(indexer.corridors[3].borderProfile).toEqual({
      axis: 'y',
      left: [{ span: [60, 100], kind: 'diagram-border' }],
      right: [],
    });
    expect(rangeQueryCount).toBe(2);
  });

  it('skips the entity index when both corridor sides are diagram borders', () => {
    let rangeQueryCount = 0;
    const layoutManager = new LayoutManager({ entities: [], connections: [] });
    const findEntitiesInRange = layoutManager.findEntitiesInRange.bind(layoutManager);
    layoutManager.findEntitiesInRange = (range: Partial<LayoutRange>) => {
      rangeQueryCount += 1;
      return findEntitiesInRange(range);
    };

    const indexer = new CorridorIndexer(
      [{ index: 0, axis: 'x', rect: { x: 0, y: 0, width: 100, height: 100 } }],
      [],
      [],
      layoutManager,
      { x: 0, y: 0, width: 100, height: 100 },
    );

    expect(indexer.corridors[0].borderProfile).toEqual({
      axis: 'x',
      top: [{ span: [0, 100], kind: 'diagram-border' }],
      bottom: [{ span: [0, 100], kind: 'diagram-border' }],
    });
    expect(rangeQueryCount).toBe(0);
  });

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

    expect(indexer.corridors[0].borderProfile).toEqual({
      axis: 'x',
      top: [],
      bottom: [],
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

    expect(indexer.corridors[0].borderProfile).toEqual({
      axis: 'x',
      top: [],
      bottom: [],
    });
    expect(indexer.wallFacesForCorridor(0)).toEqual([]);
  });
});
