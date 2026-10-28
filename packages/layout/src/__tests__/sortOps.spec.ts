import { LayoutManager } from '../LayoutManager.js';
import { sortMovesAndAdds } from '../sortOps.js';
import type { MovedEntity, NewEntity } from '../types.js';

const copyFixture = <T>(fixture: T): T => JSON.parse(JSON.stringify(fixture)) as T;
const groupsCase = () => copyFixture(require('./group.json'));

/**
 * This is testing an implementation detail of calculateChanges
 * But it is a pretty complicated function so it is good to have some tests
 * We can add some sanity tests in calculateChanges, but this will be more precise
 */
describe('sortMovesAndAdds', () => {
  it('should sort moves and adds correctly', () => {
    const layoutManager = new LayoutManager({
      ...groupsCase(),
      primaryDirection: 'down',
    });

    const newEntities: NewEntity[] = [
      { id: 'unrelated-ent', width: 100, height: 100 },
      { id: 'unrelated-container', width: 200, height: 200, isContainer: true },
      { id: 'ent-in-inner', width: 100, height: 100, containerId: 'inner-container' },
      { id: 'ent-in-container', width: 100, height: 100, containerId: 'container' },
      {
        id: 'inner-container',
        width: 100,
        height: 100,
        isContainer: true,
        containerId: 'container',
      },
      {
        id: 'outer-container',
        width: 100,
        height: 100,
        isContainer: true,
      },
    ];

    const movedEntities: MovedEntity[] = [
      { id: 'container', newContainerId: 'outer-container' },
      { id: 'rect-below', newContainerId: 'outer-container' },
      { id: 'rect0', newContainerId: 'inner-container' },
    ];

    const sortedOps = sortMovesAndAdds(layoutManager, newEntities, movedEntities, []);
    // @ts-expect-error We aren't having move blocks
    const simplified = sortedOps.map((o) => ({ id: o.op.id, opType: o.opType }));

    expect(simplified).toEqual([
      { opType: 'add', id: 'unrelated-ent' },
      { opType: 'add', id: 'unrelated-container' },
      { opType: 'add', id: 'ent-in-container' },
      { opType: 'add', id: 'inner-container' },
      { opType: 'move', id: 'rect0' },
      { opType: 'add', id: 'ent-in-inner' },
      { opType: 'add', id: 'outer-container' },
      { opType: 'move', id: 'container' },
      { opType: 'move', id: 'rect-below' },
    ]);
  });

  it('should handle nested groups', () => {
    const layoutManager = new LayoutManager({
      entities: [
        {
          id: 'A',
          isContainer: true,
          x: 0,
          y: 0,
          height: 400,
          width: 400,
        },
        {
          id: 'C',
          x: 100,
          y: 100,
          height: 100,
          width: 100,
        },
      ],
      connections: [],
      primaryDirection: 'down',
    });

    const newEntities: NewEntity[] = [
      { id: 'B', width: 100, height: 100, containerId: 'A', isContainer: true },
    ];

    const movedEntities: MovedEntity[] = [{ id: 'C', newContainerId: 'B' }];

    const sortedOps = sortMovesAndAdds(layoutManager, newEntities, movedEntities, []);
    // @ts-expect-error We don't have move blocks
    const simplified = sortedOps.map((o) => ({ id: o.op.id, opType: o.opType }));

    expect(simplified).toEqual([
      { opType: 'add', id: 'B' },
      { opType: 'move', id: 'C' },
    ]);
  });

  it('should give preference to entity moving out of a group over new entity', () => {
    const layoutManager = new LayoutManager({
      ...groupsCase(),
      primaryDirection: 'down',
    });

    const newEntities: NewEntity[] = [
      { id: 'A', width: 100, height: 100, containerId: 'container' },
    ];

    const movedEntities: MovedEntity[] = [{ id: 'rect0', newContainerId: undefined }];

    const sortedOps = sortMovesAndAdds(layoutManager, newEntities, movedEntities, []);

    // @ts-expect-error We don't have move blocks
    const simplified = sortedOps.map((o) => ({ id: o.op.id, opType: o.opType }));

    expect(simplified).toEqual([
      { opType: 'move', id: 'rect0' },
      { opType: 'add', id: 'A' },
    ]);
  });
});
