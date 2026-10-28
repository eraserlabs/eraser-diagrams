import { LayoutManager } from '../LayoutManager.js';
import { makeRoomForEntities, MAX_DISTANCE_TO_BUMPS_CONNECTED_ENTITIES } from '../bumpUtils.js';
import { makeConnection, makeEntity, makeGroup } from '../testUtils.js';

describe('makeRoomForEntities', () => {
  it('makes room when entity is placed on another', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const layoutManager = new LayoutManager({
      entities: [entityA],
      connections: [],
      primaryDirection: 'right',
    });
    const entityB = makeEntity('B', { x: 0, y: 0 });
    layoutManager.addEntity(entityB);

    makeRoomForEntities({
      layoutManager,
      entityIds: ['B'],
      directions: ['right'],
    });

    const movedEntityA = layoutManager.getEntityById('A');
    const expectedBump = entityB.width + layoutManager.options.marginBetweenRanks;
    expect(movedEntityA!.x).toBe(expectedBump);
  });

  it('noops when entities do not overlap', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const layoutManager = new LayoutManager({
      entities: [entityA],
      connections: [],
      primaryDirection: 'right',
    });
    const entityB = makeEntity('B', { x: 300, y: 0 });
    layoutManager.addEntity(entityB);

    makeRoomForEntities({
      layoutManager,
      entityIds: ['B'],
      directions: ['right'],
    });

    const movedEntityA = layoutManager.getEntityById('A');
    expect(movedEntityA!.x).toBe(0);
  });

  it('performs cascading bumps to non-connected entities', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 100, y: 0 });
    const layoutManager = new LayoutManager({
      entities: [entityA, entityB],
      connections: [],
      primaryDirection: 'right',
    });

    const entityC = makeEntity('C', { x: 0, y: 0 });
    layoutManager.addEntity(entityC);

    makeRoomForEntities({
      layoutManager,
      entityIds: ['C'],
      directions: ['right'],
    });

    const movedEntityA = layoutManager.getEntityById('A');
    const movedEntityB = layoutManager.getEntityById('B');

    const expectedBump = entityC.width + layoutManager.options.marginBetweenRanks;

    expect(movedEntityA!.x).toBe(expectedBump);
    expect(movedEntityB!.x).toBe(100 + expectedBump);
  });

  it('performs cascading bumps to connected entities', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 200, y: 0 });
    const layoutManager = new LayoutManager({
      entities: [entityA, entityB],
      connections: [makeConnection(entityA, entityB)],
      primaryDirection: 'right',
    });

    const entityC = makeEntity('C', { x: 0, y: 0 });
    layoutManager.addEntity(entityC);

    makeRoomForEntities({
      layoutManager,
      entityIds: ['C'],
      directions: ['right'],
    });

    const movedEntityA = layoutManager.getEntityById('A');
    const movedEntityB = layoutManager.getEntityById('B');

    const expectedBump = entityC.width + layoutManager.options.marginBetweenRanks;

    expect(movedEntityA!.x).toBe(expectedBump);
    expect(movedEntityB!.x).toBe(200 + expectedBump);
  });

  it('performs cascading bumps to connected entities in a chain', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 150, y: 0 });
    const entityC = makeEntity('C', { x: 300, y: 0 });
    const overlap = makeEntity('Overlap', { x: 0, y: 0 }); // The overlap
    const connBC = makeConnection(entityB, entityC);

    const layoutManager = new LayoutManager({
      entities: [entityA, entityB, entityC, overlap],
      connections: [connBC],
      primaryDirection: 'right',
    });

    makeRoomForEntities({
      layoutManager,
      entityIds: ['Overlap'],
      directions: ['right'],
    });

    const movedEntityA = layoutManager.getEntityById('A');
    const movedEntityB = layoutManager.getEntityById('B');
    const movedEntityC = layoutManager.getEntityById('C');

    const expectedBump = overlap.width + layoutManager.options.marginBetweenRanks;

    expect(movedEntityA!.x).toBe(0 + expectedBump);
    expect(movedEntityB!.x).toBe(150 + expectedBump);
    expect(movedEntityC!.x).toBe(300 + expectedBump);
  });

  it('performs bumps when there are circular connections', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 150, y: 0 });
    const entityC = makeEntity('C', { x: 300, y: 0 });
    const entityD = makeEntity('D', { x: 450, y: 0 });

    const connCD = makeConnection(entityC, entityD);
    const connCDBack = makeConnection(entityD, entityC);

    const layoutManager = new LayoutManager({
      entities: [entityA, entityB, entityC, entityD],
      connections: [connCD, connCDBack],
      primaryDirection: 'right',
    });

    const entityE = makeEntity('E', { x: 0, y: 0 });
    layoutManager.addEntity(entityE);

    makeRoomForEntities({
      layoutManager,
      entityIds: ['E'],
      directions: ['right'],
    });

    const movedEntityA = layoutManager.getEntityById('A');
    const movedEntityB = layoutManager.getEntityById('B');
    const movedEntityC = layoutManager.getEntityById('C');
    const movedEntityD = layoutManager.getEntityById('D');
    const movedEntityE = layoutManager.getEntityById('E');

    const expectedBump = entityE.width + layoutManager.options.marginBetweenRanks;

    expect(movedEntityA!.x).toBe(0 + expectedBump);
    expect(movedEntityB!.x).toBe(150 + expectedBump);
    expect(movedEntityC!.x).toBe(300 + expectedBump);
    expect(movedEntityD!.x).toBe(450 + expectedBump);
    expect(movedEntityE!.x).toBe(0);
  });

  it('moves internal entities when a container is bumped and bumps connected entities', () => {
    const childA = makeEntity('A', { x: 50, y: 0 });
    const childB = makeEntity('B', { x: 200, y: 0 });
    const connected = makeEntity('Connected', { x: 400, y: 0 });

    const superFar = makeEntity('SuperFar', {
      x: childB.x + childB.width + MAX_DISTANCE_TO_BUMPS_CONNECTED_ENTITIES + 1,
      y: 200,
    }); // Make it below so that connected does not bump it
    const container = makeGroup('Container', [childA, childB]);
    const overlap = makeEntity('Overlap', { x: container.x, y: 0 });

    const layoutManager = new LayoutManager({
      entities: [container, childA, childB, overlap, connected, superFar],
      connections: [makeConnection(childB, connected), makeConnection(childB, superFar)],
      primaryDirection: 'right',
    });

    makeRoomForEntities({
      layoutManager,
      entityIds: ['Overlap'],
      directions: ['right'],
    });

    const expectedBump = overlap.width + layoutManager.options.marginBetweenRanks;

    expect(layoutManager.getEntityById('Container')!.x).toBe(container.x + expectedBump);
    expect(layoutManager.getEntityById('A')!.x).toBe(50 + expectedBump);
    expect(layoutManager.getEntityById('B')!.x).toBe(200 + expectedBump);
    expect(layoutManager.getEntityById('Connected')!.x).toBe(400 + expectedBump);
    expect(layoutManager.getEntityById('SuperFar')!.x).toBe(superFar.x); // Does not move
  });

  /**
   * Test a specific case of CAD with this syntax:
   * Outer {
   *   Inner {
   *     A
   *   }
   *   B
   * }
   * C
   *
   * When the user drags Inner over B, we want to bump C.
   */
  it('cascades when a group bumps an entity', () => {
    const entitiesById = {
      Outer: {
        id: 'Outer',
        x: 0,
        y: 0,
        width: 177,
        height: 209,
        isContainer: true,
      },
      Inner: {
        id: 'Inner',
        x: 107,
        y: 50,
        width: 100,
        height: 139,
        containerId: 'Outer',
        isContainer: true,
      },
      A: {
        id: 'A',
        x: 127,
        y: 100,
        width: 50,
        height: 50,
        containerId: 'Inner',
        isContainer: false,
      },
      B: {
        id: 'B',
        x: 107,
        y: 94,
        width: 50,
        height: 50,
        containerId: 'Outer',
        isContainer: false,
      },
      C: {
        id: 'C',
        x: 227,
        y: 94,
        width: 50,
        height: 50,
        isContainer: false,
      },
    };

    const connAB = makeConnection(entitiesById.A, entitiesById.B); // A > B
    const connBC = makeConnection(entitiesById.B, entitiesById.C); // B > C

    const layoutManager = new LayoutManager({
      entities: Object.values(entitiesById),
      connections: [connAB, connBC],
      primaryDirection: 'right',
      options: {
        containerPadding: { top: 50, right: 20, bottom: 20, left: 20 },
        marginBetweenEntities: 40,
        marginBetweenRanks: 40,
      },
    });

    makeRoomForEntities({
      layoutManager,
      entityIds: ['Inner'],
      directions: ['right'],
      containerId: 'Outer',
    });

    const expectedBump = entitiesById.Inner.width + layoutManager.options.marginBetweenRanks;

    expect(layoutManager.getEntityById('C')!.x).toBe(entitiesById.C.x + expectedBump);
    expect(layoutManager.getEntityById('B')!.x).toBe(entitiesById.B.x + expectedBump);
  });
});
