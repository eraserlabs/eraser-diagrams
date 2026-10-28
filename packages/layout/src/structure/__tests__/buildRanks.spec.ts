import { buildLayoutRanks } from '../ranks.js';
import { vi } from 'vitest';
import { makeEntity, makeGroup, makeConnection } from '../../testUtils.js';
import { LayoutManager } from '../../LayoutManager.js';
import { buildRanks } from '../ranks.js';
import { LayoutEntity } from '../../types.js';

describe('buildRanks', () => {
  it('should create a simple A > B > C linear rankedNodes with correct ranks', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 150, y: 0 });
    const entityC = makeEntity('C', { x: 300, y: 0 });

    const layoutManager = new LayoutManager({
      entities: [entityA, entityB, entityC],
      connections: [makeConnection(entityA, entityB), makeConnection(entityB, entityC)],
      primaryDirection: 'right',
    });

    // Create entitiesById mapping
    const entities = layoutManager.getEntities();
    const entitiesById = entities.reduce(
      (acc, entity) => {
        acc[entity.id] = entity;
        return acc;
      },
      {} as Record<string, LayoutEntity>,
    );

    const { rankedNodes } = buildRanks({
      entitiesById,
      containerMapping: layoutManager.getContainerMapping(),
      parentMapping: layoutManager.getParentMapping(),
      connections: layoutManager.getConnections(),
    });

    // Verify rankedNodes structure
    expect(Object.keys(rankedNodes)).toHaveLength(3);
    expect(rankedNodes['A']).toBeDefined();
    expect(rankedNodes['B']).toBeDefined();
    expect(rankedNodes['C']).toBeDefined();

    // Verify ranks
    expect(rankedNodes['A'].rank).toBe(0);
    expect(rankedNodes['B'].rank).toBe(1);
    expect(rankedNodes['C'].rank).toBe(2);

    // Verify connections
    expect(rankedNodes['A'].out).toEqual(new Set(['B']));
    expect(rankedNodes['A'].in).toEqual(new Set([]));

    expect(rankedNodes['B'].out).toEqual(new Set(['C']));
    expect(rankedNodes['B'].in).toEqual(new Set(['A']));

    expect(rankedNodes['C'].out).toEqual(new Set([]));
    expect(rankedNodes['C'].in).toEqual(new Set(['B']));
  });

  it('should drop connections without both endpoints in the entity map', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 150, y: 0 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const layoutManager = new LayoutManager({
      entities: [entityA, entityB],
      connections: [
        makeConnection(entityA, entityB),
        { ...makeConnection(entityA, entityB), id: 'missing-from', from: '' },
        { ...makeConnection(entityA, entityB), id: 'missing-to', to: '' },
        { ...makeConnection(entityA, entityB), id: 'unknown-from', from: 'missing' },
        { ...makeConnection(entityA, entityB), id: 'unknown-to', to: 'missing' },
      ],
      primaryDirection: 'right',
    });

    try {
      const { rankedNodes, ranks, globalRanks } = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      expect(rankedNodes['A'].rank).toBe(0);
      expect(rankedNodes['B'].rank).toBe(1);
      expect(rankedNodes['A'].out).toEqual(new Set(['B']));
      expect(rankedNodes['B'].in).toEqual(new Set(['A']));
      expect(ranks.flatMap((rank) => rank.in)).toEqual(['A']);
      expect(ranks.flatMap((rank) => rank.out)).toEqual(['B']);
      expect(globalRanks.flatMap((rank) => rank.in)).toEqual(['A']);
      expect(globalRanks.flatMap((rank) => rank.out)).toEqual(['B']);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        '[buildRanks] Dropping connection "unknown-from": from endpoint "missing" does not match any entity',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[buildRanks] Dropping connection "unknown-to": to endpoint "missing" does not match any entity',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('should handle containers as single nodes', () => {
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB1 = makeEntity('B1', { x: 160, y: 10 });
    const entityB2 = makeEntity('B2', { x: 160, y: 50 });
    const entityC = makeEntity('C', { x: 400, y: 0 });
    const containerB = makeGroup('container-B', [entityB1, entityB2]);

    const layoutManager = new LayoutManager({
      entities: [entityA, containerB, entityB1, entityB2, entityC],
      connections: [makeConnection(entityA, entityB1), makeConnection(entityB2, entityC)],
      primaryDirection: 'right',
    });

    const { rankedNodes } = buildRanks({
      entitiesById: layoutManager.getEntitiesMapping(),
      containerMapping: layoutManager.getContainerMapping(),
      parentMapping: layoutManager.getParentMapping(),
      connections: layoutManager.getConnections(),
    });

    // Should only have root-level entities (A, container-B, C)
    expect(Object.keys(rankedNodes)).toHaveLength(5);

    // Verify ranks: A -> container-B -> C
    expect(rankedNodes['A'].rank).toBe(0);
    expect(rankedNodes['container-B'].rank).toBe(1);
    expect(rankedNodes['C'].rank).toBe(2);

    // Verify internal ranks are equal because there are no internal connections
    expect(rankedNodes['B1'].rank).toBe(0);
    expect(rankedNodes['B1'].rankHierarchy).toEqual([1]);
    expect(rankedNodes['B2'].rank).toBe(0);
    expect(rankedNodes['B2'].rankHierarchy).toEqual([1]);

    // Verify connections are mapped to the true entity, but also recorded at container level
    expect(rankedNodes['A'].out).toEqual(new Set(['B1']));
    expect(rankedNodes['container-B'].in).toEqual(new Set(['A']));
    expect(rankedNodes['B1'].in).toEqual(new Set(['A']));
    expect(rankedNodes['container-B'].out).toEqual(new Set(['C']));
    expect(rankedNodes['B2'].out).toEqual(new Set(['C']));
    expect(rankedNodes['C'].in).toEqual(new Set(['B2']));
  });

  it('should handle parallel branches with correct ranks', () => {
    // Create test entities: A -> B, A -> C, B -> D, D -> E, C -> E
    const entityA = makeEntity('A', { x: 0, y: 50 });
    const entityB = makeEntity('B', { x: 150, y: 0 });
    const entityC = makeEntity('C', { x: 150, y: 100 });
    const entityD = makeEntity('D', { x: 300, y: 50 });
    const entityE = makeEntity('E', { x: 450, y: 50 });

    const entities = [entityA, entityB, entityC, entityD, entityE];

    const connections = [
      makeConnection(entityA, entityB),
      makeConnection(entityA, entityC),
      makeConnection(entityB, entityD),
      makeConnection(entityC, entityE),
      makeConnection(entityD, entityE),
    ];

    const layoutManager = new LayoutManager({
      entities,
      connections,
      primaryDirection: 'right',
    });

    const { rankedNodes } = buildRanks({
      entitiesById: layoutManager.getEntitiesMapping(),
      containerMapping: layoutManager.getContainerMapping(),
      parentMapping: layoutManager.getParentMapping(),
      connections: layoutManager.getConnections(),
    });

    // Verify all entities are present
    expect(Object.keys(rankedNodes)).toHaveLength(5);

    // Verify ranks: A at rank 0, B and C at rank 1, D at rank 2
    expect(rankedNodes['A'].rank).toBe(0);
    expect(rankedNodes['B'].rank).toBe(1);
    expect(rankedNodes['C'].rank).toBe(1);
    expect(rankedNodes['D'].rank).toBe(2);
    expect(rankedNodes['E'].rank).toBe(3);

    // Verify connections
    expect(rankedNodes['A'].out).toEqual(new Set(['B', 'C']));
    expect(rankedNodes['B'].out).toEqual(new Set(['D']));
    expect(rankedNodes['C'].out).toEqual(new Set(['E']));
    expect(rankedNodes['E'].in).toEqual(new Set(['C', 'D']));
  });

  it('should handle cycles', () => {
    // Cycle with a start node and end node
    const entityStart = makeEntity('start', { x: 0, y: 0 });
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 150, y: 0 });
    const entityC = makeEntity('C', { x: 300, y: 0 });
    const entityEnd = makeEntity('end', { x: 450, y: 0 });
    const connections = [
      // Connect to the cycle
      makeConnection(entityStart, entityA),
      // A > B > C > A cycle
      makeConnection(entityA, entityB),
      makeConnection(entityB, entityC),
      makeConnection(entityC, entityA),
      // Out of the cycle
      makeConnection(entityC, entityEnd),
    ];

    const layoutManager = new LayoutManager({
      entities: [entityStart, entityA, entityB, entityC, entityEnd],
      connections,
      primaryDirection: 'right',
    });

    const { rankedNodes } = buildRanks({
      entitiesById: layoutManager.getEntitiesMapping(),
      containerMapping: layoutManager.getContainerMapping(),
      parentMapping: layoutManager.getParentMapping(),
      connections: layoutManager.getConnections(),
    });

    expect(rankedNodes['start'].rank).toBe(0);
    expect(rankedNodes['A'].rank).toBe(1);
    expect(rankedNodes['B'].rank).toBe(2);
    expect(rankedNodes['C'].rank).toBe(3);
    expect(rankedNodes['end'].rank).toBe(4);

    // The in rank should still be recorded for the rankedNode, including the cycle
    expect(rankedNodes['A'].in).toEqual(new Set(['start', 'C']));
  });

  describe('nested entities', () => {
    it('should rank entities inside a single container', () => {
      // A -> Container(B1 -> B2) -> C
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB1 = makeEntity('B1', { x: 160, y: 10 }, { containerId: 'container' });
      const entityB2 = makeEntity('B2', { x: 160, y: 60 }, { containerId: 'container' });
      const entityC = makeEntity('C', { x: 400, y: 0 });
      const container = makeGroup('container', [entityB1, entityB2]);

      const layoutManager = new LayoutManager({
        entities: [entityA, container, entityB1, entityB2, entityC],
        connections: [
          makeConnection(entityA, entityB1),
          makeConnection(entityB1, entityB2),
          makeConnection(entityB2, entityC),
        ],
        primaryDirection: 'right',
      });

      const { rankedNodes, parentMapping, containerMapping } = buildLayoutRanks(layoutManager);

      // Top-level entities should have regular ranks
      expect(rankedNodes['A'].rank).toBe(0);
      expect(rankedNodes['container'].rank).toBe(1);
      expect(rankedNodes['C'].rank).toBe(2);

      // Top-level entities should NOT have rankHierarchy
      expect(rankedNodes['A'].rankHierarchy).toBeUndefined();
      expect(rankedNodes['container'].rankHierarchy).toBeUndefined();
      expect(rankedNodes['C'].rankHierarchy).toBeUndefined();

      // Nested entities should have correct rank, rankHierarchy, and in/out connections
      expect(rankedNodes['B1']).toMatchObject({
        rank: 0,
        rankHierarchy: [1],
        out: new Set(['B2']),
      });
      expect(rankedNodes['B2']).toMatchObject({
        rank: 1,
        rankHierarchy: [1],
        in: new Set(['B1']),
      });

      // Verify metadata is attached
      expect(parentMapping).toBeDefined();
      expect(containerMapping).toBeDefined();
    });

    it('should handle multiple containers with internal rankings', () => {
      // A -> Container1(B1 -> B2) -> Container2(C1 -> C2) -> D
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB1 = makeEntity('B1', { x: 160, y: 10 }, { containerId: 'container1' });
      const entityB2 = makeEntity('B2', { x: 160, y: 60 }, { containerId: 'container1' });
      const entityC1 = makeEntity('C1', { x: 320, y: 10 }, { containerId: 'container2' });
      const entityC2 = makeEntity('C2', { x: 320, y: 60 }, { containerId: 'container2' });
      const entityD = makeEntity('D', { x: 480, y: 0 });
      const container1 = makeGroup('container1', [entityB1, entityB2]);
      const container2 = makeGroup('container2', [entityC1, entityC2]);

      const layoutManager = new LayoutManager({
        entities: [
          entityA,
          container1,
          container2,
          entityB1,
          entityB2,
          entityC1,
          entityC2,
          entityD,
        ],
        connections: [
          makeConnection(entityA, entityB1),
          makeConnection(entityB1, entityB2),
          makeConnection(entityB2, entityC1),
          makeConnection(entityC1, entityC2),
          makeConnection(entityC2, entityD),
        ],
        primaryDirection: 'right',
      });

      const { rankedNodes } = buildLayoutRanks(layoutManager);

      // Top-level rankings: A(0) -> container1(1) -> container2(2) -> D(3)
      expect(rankedNodes['A'].rank).toBe(0);
      expect(rankedNodes['container1'].rank).toBe(1);
      expect(rankedNodes['container2'].rank).toBe(2);
      expect(rankedNodes['D'].rank).toBe(3);

      // Container1 internal rankings
      expect(rankedNodes['B1']).toMatchObject({
        rank: 0,
        rankHierarchy: [1],
        in: new Set(['A']),
        out: new Set(['B2']),
      });
      expect(rankedNodes['B2']).toMatchObject({
        rank: 1,
        rankHierarchy: [1],
        in: new Set(['B1']),
        out: new Set(['C1']),
      });

      // Container2 internal rankings
      expect(rankedNodes['C1']).toMatchObject({
        rank: 0,
        rankHierarchy: [2],
        in: new Set(['B2']),
        out: new Set(['C2']),
      });
      expect(rankedNodes['C2']).toMatchObject({
        rank: 1,
        rankHierarchy: [2],
        in: new Set(['C1']),
        out: new Set(['D']),
      });

      expect(rankedNodes['D'].in).toEqual(new Set(['C2']));
    });

    it('should handle containers with no internal connections', () => {
      // A -> Container(B1, B2, B3) -> C (no connections between B1, B2, B3)
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB1 = makeEntity('B1', { x: 160, y: 10 }, { containerId: 'container' });
      const entityB2 = makeEntity('B2', { x: 160, y: 40 }, { containerId: 'container' });
      const entityB3 = makeEntity('B3', { x: 160, y: 70 }, { containerId: 'container' });
      const entityC = makeEntity('C', { x: 400, y: 0 });
      const container = makeGroup('container', [entityB1, entityB2, entityB3]);

      const layoutManager = new LayoutManager({
        entities: [entityA, container, entityB1, entityB2, entityB3, entityC],
        connections: [makeConnection(entityA, entityB1), makeConnection(entityB2, entityC)],
        primaryDirection: 'right',
      });

      const { rankedNodes } = buildLayoutRanks(layoutManager);

      // Top-level structure
      expect(rankedNodes['A'].rank).toBe(0);
      expect(rankedNodes['container'].rank).toBe(1);
      expect(rankedNodes['C'].rank).toBe(2);

      // All entities in container should have same container rank but different local ranks
      expect(rankedNodes['B1']).toMatchObject({
        rank: 0,
        rankHierarchy: [1],
        in: new Set(['A']),
      });
      expect(rankedNodes['B2']).toMatchObject({
        rank: 0,
        rankHierarchy: [1],
        out: new Set(['C']),
      });
      expect(rankedNodes['B3']).toMatchObject({
        rank: 0,
        rankHierarchy: [1],
      });

      expect(rankedNodes['container'].childRanks?.length).toBe(1);
    });

    it('should handle deeply nested containers', () => {
      // A -> Container1(Container2(B1 -> B2) -> B3) -> C
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB1 = makeEntity('B1', { x: 160, y: 10 });
      const entityB2 = makeEntity('B2', { x: 160, y: 40 });
      const entityB3 = makeEntity('B3', { x: 160, y: 80 });
      const entityC = makeEntity('C', { x: 400, y: 0 });
      const container2 = makeGroup('container2', [entityB1, entityB2]);
      const container1 = makeGroup('container1', [container2, entityB3]);

      const layoutManager = new LayoutManager({
        entities: [entityA, container1, container2, entityB1, entityB2, entityB3, entityC],
        connections: [
          makeConnection(entityA, entityB1),
          makeConnection(entityB1, entityB2),
          makeConnection(entityB2, entityB3),
          makeConnection(entityB3, entityC),
        ],
        primaryDirection: 'right',
      });

      const { rankedNodes, ranks } = buildLayoutRanks(layoutManager);

      // Should have all entities
      expect(Object.keys(rankedNodes)).toHaveLength(7);

      // Check all the rank properties
      // Top-level ranks: A(0) -> container1(1) -> C(2)
      expect(rankedNodes['A'].rank).toBe(0);
      expect(rankedNodes['container1'].rank).toBe(1);
      expect(rankedNodes['C'].rank).toBe(2);

      // Container1 level: container2 and B3
      expect(rankedNodes['container2'].rank).toBe(0);
      expect(rankedNodes['container2'].rankHierarchy).toEqual([1]);
      expect(rankedNodes['B3'].rank).toBe(1);
      expect(rankedNodes['B3'].rankHierarchy).toEqual([1]);

      // Container2 level (deeply nested): B1 -> B2
      expect(rankedNodes['B1'].rankHierarchy).toEqual([1, 0]);
      expect(rankedNodes['B1'].rank).toBe(0);
      expect(rankedNodes['B2'].rankHierarchy).toEqual([1, 0]);
      expect(rankedNodes['B2'].rank).toBe(1);

      // Check the ins and outs
      expect(rankedNodes['A'].out).toEqual(new Set(['B1']));
      expect(rankedNodes['container1'].in).toEqual(new Set(['A']));
      expect(rankedNodes['container1'].out).toEqual(new Set(['C']));
      expect(rankedNodes['C'].in).toEqual(new Set(['B3']));
      expect(rankedNodes['container2'].in).toEqual(new Set(['A']));
      expect(rankedNodes['container2'].out).toEqual(new Set(['B3']));
      expect(rankedNodes['B1'].out).toEqual(new Set(['B2']));
      expect(rankedNodes['B2'].in).toEqual(new Set(['B1']));
      expect(rankedNodes['B2'].out).toEqual(new Set(['B3']));
      expect(rankedNodes['B3'].in).toEqual(new Set(['B2']));
      expect(rankedNodes['C'].in).toEqual(new Set(['B3']));

      // Ranks
      expect(ranks.length).toBe(3);
      expect(ranks[0]).toEqual({
        nodes: [rankedNodes['A']],
        in: [],
        out: ['container1'],
        inRanks: [],
        outRanks: [1],
      });
      expect(ranks[1]).toEqual({
        nodes: [rankedNodes['container1']],
        in: ['A'],
        out: ['C'],
        inRanks: [0],
        outRanks: [2],
      });
      expect(ranks[2]).toEqual({
        nodes: [rankedNodes['C']],
        in: ['container1'],
        out: [],
        inRanks: [1],
        outRanks: [],
      });

      // Child ranks, top level container
      const container1Ranks = rankedNodes['container1'].childRanks;
      expect(container1Ranks).toBeDefined();
      expect(container1Ranks?.length).toBe(2);
      expect(container1Ranks?.[0]).toEqual({
        nodes: [rankedNodes['container2']],
        in: [],
        inRanks: [],
        out: ['B3'],
        outRanks: [1],
      });
      expect(container1Ranks?.[1]).toEqual({
        nodes: [rankedNodes['B3']],
        in: ['container2'],
        inRanks: [0],
        out: [],
        outRanks: [],
      });

      // Child ranks, nested container
      const container2Ranks = rankedNodes['container2'].childRanks;
      expect(container2Ranks).toBeDefined();
      expect(container2Ranks?.length).toBe(2);
      expect(container2Ranks?.[0]).toEqual({
        nodes: [rankedNodes['B1']],
        in: [],
        inRanks: [],
        out: ['B2'],
        outRanks: [1],
      });
      expect(container2Ranks?.[1]).toEqual({
        nodes: [rankedNodes['B2']],
        in: ['B1'],
        inRanks: [0],
        out: [],
        outRanks: [],
      });
    });

    it('should handle mixed top-level and nested entities with complex connections', () => {
      // A -> B, A -> Container(C1 -> C2), B -> C2, C2 -> D
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 0, y: 100 });
      const entityC1 = makeEntity('C1', { x: 200, y: 10 }, { containerId: 'container' });
      const entityC2 = makeEntity('C2', { x: 200, y: 60 }, { containerId: 'container' });
      const entityD = makeEntity('D', { x: 400, y: 0 });
      const container = makeGroup('container', [entityC1, entityC2]);

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, container, entityC1, entityC2, entityD],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityA, entityC1),
          makeConnection(entityC1, entityC2),
          makeConnection(entityB, entityC2),
          makeConnection(entityC2, entityD),
        ],
        primaryDirection: 'right',
      });

      const { rankedNodes, ranks } = buildLayoutRanks(layoutManager);

      // Should have all entities
      expect(Object.keys(rankedNodes)).toHaveLength(6);

      // Top-level rankings
      expect(rankedNodes['A'].rank).toBe(0);
      expect(rankedNodes['B'].rank).toBe(1);
      expect(rankedNodes['container'].rank).toBe(2);
      expect(rankedNodes['D'].rank).toBe(3);

      // Container internal rankings
      expect(rankedNodes['C1']).toMatchObject({
        rank: 0,
        rankHierarchy: [2],
        in: new Set(['A']),
        out: new Set(['C2']),
      });
      expect(rankedNodes['C2']).toMatchObject({
        rank: 1,
        rankHierarchy: [2],
        in: new Set(['B', 'C1']),
        out: new Set(['D']),
      });

      expect(ranks.length).toBe(4);
      expect(ranks[0]).toMatchObject({
        nodes: [rankedNodes['A']],
        out: ['B', 'container'],
        outRanks: [1, 2],
      });
      expect(ranks[1]).toMatchObject({
        nodes: [rankedNodes['B']],
        in: ['A'],
        inRanks: [0],
        out: ['container'],
        outRanks: [2],
      });
      expect(ranks[2]).toMatchObject({
        nodes: [rankedNodes['container']],
        in: ['A', 'B'],
        inRanks: [0, 1],
        out: ['D'],
        outRanks: [3],
      });
      expect(ranks[3]).toMatchObject({
        nodes: [rankedNodes['D']],
        in: ['container'],
        inRanks: [2],
      });
    });
  });

  describe('global ranks', () => {
    it('should assign global ranks for a simple linear graph', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: 0 });
      const entityC = makeEntity('C', { x: 300, y: 0 });
      const entityD = makeEntity('D', { x: 450, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC, entityD],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityB, entityC),
          makeConnection(entityB, entityD),
        ],
        primaryDirection: 'right',
      });

      const { rankedNodes, globalRanks } = buildLayoutRanks(layoutManager);

      // There should be 3 global ranks
      expect(globalRanks.length).toBe(3);

      // Rank buckets contain the correct nodes
      expect(globalRanks[0].nodes.map((n) => n.id)).toEqual(['A']);
      expect(globalRanks[1].nodes.map((n) => n.id)).toEqual(['B']);
      expect(globalRanks[2].nodes.map((n) => n.id)).toEqual(['C', 'D']);

      // Each node has the expected global rank. Good for sanity checking.
      expect(rankedNodes['A'].globalRank).toBe(0);
      expect(rankedNodes['B'].globalRank).toBe(1);
      expect(rankedNodes['C'].globalRank).toBe(2);
      expect(rankedNodes['D'].globalRank).toBe(2);
    });

    /**
     * @note This test has pretty odd behavior and shows how global rank can be hard to define.
     * Specifically, there are only 2 connections, and we realistically want 3 ranks
     */
    it('should handle sparse connections with containers', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB1 = makeEntity('B1', { x: 160, y: 10 });
      const entityB2 = makeEntity('B2', { x: 160, y: 50 });
      const entityB3 = makeEntity('B3', { x: 160, y: 90 }); // Unconnected sibling
      const entityC = makeEntity('C', { x: 400, y: 0 });
      const containerB = makeGroup('container-B', [entityB1, entityB2, entityB3]);
      const entityD = makeEntity('D', { x: -200, y: 0 }); // Unconnected top-level node

      const layoutManager = new LayoutManager({
        entities: [entityA, entityD, containerB, entityB1, entityB2, entityB3, entityC],
        connections: [makeConnection(entityA, entityB1), makeConnection(entityB2, entityC)],
        primaryDirection: 'right',
      });

      const { globalRanks, ranks } = buildLayoutRanks(layoutManager);

      expect(globalRanks.length).toBe(2);
      expect(globalRanks[0].nodes.map((n) => n.id)).toEqual(['A', 'D', 'B2', 'B3']);
      expect(globalRanks[1].nodes.map((n) => n.id)).toEqual(['container-B', 'B1', 'C']);

      expect(ranks.length).toBe(3);
    });

    it('should account for external and internal connections', () => {
      // Same setup as above but with an internal connection
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB1 = makeEntity('B1', { x: 160, y: 10 });
      const entityB2 = makeEntity('B2', { x: 160, y: 50 });
      const entityB3 = makeEntity('B3', { x: 160, y: 90 }); // Unconnected sibling
      const entityC = makeEntity('C', { x: 400, y: 0 });
      const containerB = makeGroup('container-B', [entityB1, entityB2, entityB3]);
      const entityD = makeEntity('D', { x: -200, y: 0 }); // Unconnected top-level node

      const layoutManager = new LayoutManager({
        entities: [entityA, entityD, containerB, entityB1, entityB2, entityB3, entityC],
        connections: [
          makeConnection(entityA, entityB1),
          makeConnection(entityB1, entityB2),
          makeConnection(entityB2, entityC),
        ],
        primaryDirection: 'right',
      });

      const { globalRanks } = buildLayoutRanks(layoutManager);

      expect(globalRanks.length).toBe(4);
      expect(globalRanks[0].nodes.map((n) => n.id)).toEqual(['A', 'D', 'B3']);
      expect(globalRanks[1].nodes.map((n) => n.id)).toEqual(['container-B', 'B1']);
      expect(globalRanks[2].nodes.map((n) => n.id)).toEqual(['B2']);
      expect(globalRanks[3].nodes.map((n) => n.id)).toEqual(['C']);

      // Check that the relationships are proper
      expect(globalRanks[0].in).toEqual([]);
      expect(globalRanks[0].out).toEqual(['B1']);
      expect(globalRanks[1].in).toEqual(['A']);
      expect(globalRanks[1].out).toEqual(['B2']);
      expect(globalRanks[2].in).toEqual(['B1']);
      expect(globalRanks[2].out).toEqual(['C']);
      expect(globalRanks[3].in).toEqual(['B2']);
      expect(globalRanks[3].out).toEqual([]);
    });

    it('works for entirely unconnected entities', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: 0 });
      const entityC = makeEntity('C', { x: 300, y: 0 });
      const group = makeGroup('group', [entityA]);

      const layoutManager = new LayoutManager({
        entities: [group, entityA, entityB, entityC],
        connections: [makeConnection(entityB, entityC)],
        primaryDirection: 'right',
      });

      const { rankedNodes, globalRanks } = buildLayoutRanks(layoutManager);

      expect(globalRanks.length).toBe(2);
      expect(globalRanks[0].nodes.map((n) => n.id)).toEqual(['group', 'A', 'B']);
      expect(globalRanks[1].nodes.map((n) => n.id)).toEqual(['C']);

      expect(rankedNodes['group'].globalRank).toBe(0);
      expect(rankedNodes['A'].globalRank).toBe(0);
      expect(rankedNodes['B'].globalRank).toBe(0);
      expect(rankedNodes['C'].globalRank).toBe(1);
    });

    it('should account for nested cycles', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: 0 });
      const entityC = makeEntity('C', { x: 300, y: 0 });
      const groupA = makeGroup('groupA', [entityA]);
      const groupB = makeGroup('groupB', [entityB]);
      const groupC = makeGroup('groupC', [entityC]);

      const layoutManager = new LayoutManager({
        entities: [groupA, groupB, groupC, entityA, entityB, entityC],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityB, entityC),
          makeConnection(entityC, entityA),
        ],
        primaryDirection: 'right',
      });

      const { rankedNodes, globalRanks } = buildLayoutRanks(layoutManager);

      expect(globalRanks.length).toBe(3);
      expect(globalRanks[0].nodes.map((n) => n.id)).toEqual(['groupA', 'A']);
      expect(globalRanks[1].nodes.map((n) => n.id)).toEqual(['groupB', 'B']);
      expect(globalRanks[2].nodes.map((n) => n.id)).toEqual(['groupC', 'C']);

      expect(rankedNodes['groupA'].globalRank).toBe(0);
      expect(rankedNodes['A'].globalRank).toBe(0);
      expect(rankedNodes['groupB'].globalRank).toBe(1);
      expect(rankedNodes['B'].globalRank).toBe(1);
      expect(rankedNodes['groupC'].globalRank).toBe(2);
      expect(rankedNodes['C'].globalRank).toBe(2);
    });

    it('should account for mixed cycles', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: 0 });
      const entityC = makeEntity('C', { x: 300, y: 0 });
      const groupA = makeGroup('groupA', [entityA]);
      const groupC = makeGroup('groupC', [entityC]);
      const entityBefore = makeEntity('before', { x: -150, y: 0 });
      const entityAfter = makeEntity('after', { x: 450, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [groupA, groupC, entityA, entityB, entityC, entityBefore, entityAfter],
        connections: [
          makeConnection(entityBefore, entityA),
          makeConnection(entityA, entityB),
          makeConnection(entityB, entityC),
          makeConnection(entityC, entityA),
          makeConnection(entityC, entityAfter),
        ],
      });

      const { rankedNodes, globalRanks } = buildLayoutRanks(layoutManager);

      expect(globalRanks.length).toBe(5);
      expect(globalRanks[0].nodes.map((n) => n.id)).toEqual(['before']);

      expect(globalRanks[1].nodes.map((n) => n.id)).toEqual(['groupA', 'A']);
      expect(globalRanks[2].nodes.map((n) => n.id)).toEqual(['B']);
      expect(globalRanks[3].nodes.map((n) => n.id)).toEqual(['groupC', 'C']);
      expect(globalRanks[4].nodes.map((n) => n.id)).toEqual(['after']);

      expect(rankedNodes['before'].globalRank).toBe(0);
      expect(rankedNodes['groupA'].globalRank).toBe(1);
      expect(rankedNodes['A'].globalRank).toBe(1);
      expect(rankedNodes['B'].globalRank).toBe(2);
      expect(rankedNodes['groupC'].globalRank).toBe(3);
      expect(rankedNodes['C'].globalRank).toBe(3);
      expect(rankedNodes['after'].globalRank).toBe(4);
    });

    describe('edge cases', () => {
      /**
       * @see our voiceOfCustomer4 storybook example for real world
       * This behavior is genuinely unclear
       * Based on this situation, we
       */
      it('should work with weird psuedo-cycle of groups', () => {
        const entityFirst = makeEntity('First', { x: 0, y: 0 });
        const entityLater = makeEntity('Later', { x: 150, y: 0 });
        const entityMiddle = makeEntity('Middle', { x: 300, y: 0 });
        const groupA = makeGroup('groupA', [entityFirst, entityLater]);

        const layoutManager = new LayoutManager({
          entities: [groupA, entityFirst, entityLater, entityMiddle],
          connections: [
            makeConnection(entityFirst, entityMiddle),
            makeConnection(entityMiddle, entityLater),
          ],
          primaryDirection: 'right',
        });
        const { ranks, globalRanks } = buildLayoutRanks(layoutManager);

        // Global ranks
        expect(globalRanks.length).toBe(3);
        expect(globalRanks[0].nodes.map((n) => n.id)).toEqual(['First']);
        expect(globalRanks[1].nodes.map((n) => n.id)).toEqual(['Middle']);
        expect(globalRanks[2].nodes.map((n) => n.id)).toEqual(['groupA', 'Later']);

        // Nested ranks
        expect(ranks.length).toBe(2);
        expect(ranks[0].nodes.map((n) => n.id)).toEqual(['groupA']);
        expect(ranks[1].nodes.map((n) => n.id)).toEqual(['Middle']);
      });

      /** @see https://app.eraser.io/workspace/Fiezz1h3RUOSImc5k7qQ#liilrcc0FW0FQqBM-Z9cl */
      it('handles parallel lines and nested cycles', () => {
        const entityA1 = makeEntity('A1', { x: 0, y: 0 });
        const entityA2 = makeEntity('A2', { x: 0, y: 100 });
        const entityB1 = makeEntity('B1', { x: 150, y: 0 });
        const entityB2 = makeEntity('B2', { x: 150, y: 100 });
        const entityC = makeEntity('C', { x: 300, y: 0 });

        const layoutManager = new LayoutManager({
          entities: [entityA1, entityA2, entityB1, entityB2, entityC],
          connections: [
            makeConnection(entityA1, entityB1),
            makeConnection(entityA2, entityB2),
            makeConnection(entityB1, entityA1),
            makeConnection(entityB2, entityC),
            makeConnection(entityB1, entityC),
            makeConnection(entityC, entityA1),
            makeConnection(entityC, entityA2),
          ],
        });

        const { rankedNodes, globalRanks, ranks } = buildLayoutRanks(layoutManager);

        expect(rankedNodes['A1']).toMatchObject({
          globalRank: 0,
          rank: 0,
        });
        expect(rankedNodes['A2']).toMatchObject({
          globalRank: 0,
          rank: 0,
        });
        expect(rankedNodes['B1']).toMatchObject({
          globalRank: 1,
          rank: 1,
        });
        expect(rankedNodes['B2']).toMatchObject({
          globalRank: 1,
          rank: 1,
        });
        expect(rankedNodes['C']).toMatchObject({
          globalRank: 2,
          rank: 2,
        });

        // Check that the global ranks are correct
        expect(globalRanks.length).toBe(3);
        expect(globalRanks[0].nodes.map((n) => n.id)).toEqual(['A1', 'A2']);
        expect(globalRanks[1].nodes.map((n) => n.id)).toEqual(['B1', 'B2']);
        expect(globalRanks[2].nodes.map((n) => n.id)).toEqual(['C']);

        // Check that the nested ranks are correct
        expect(ranks.length).toBe(3);
        expect(ranks[0].nodes.map((n) => n.id)).toEqual(['A1', 'A2']);
        expect(ranks[1].nodes.map((n) => n.id)).toEqual(['B1', 'B2']);
        expect(ranks[2].nodes.map((n) => n.id)).toEqual(['C']);
      });
    });
  });

  describe('edge cases', () => {
    it('should handle group with relationship to internal nodes + cycle', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: 0 });
      const entityC = makeEntity('C', { x: 300, y: 0 });
      const group = makeGroup('group', [entityA, entityB, entityC]);

      const layoutManager = new LayoutManager({
        entities: [group, entityA, entityB, entityC],
        connections: [
          makeConnection(group, entityA),
          makeConnection(entityB, group),
          makeConnection(entityB, entityC),
          makeConnection(entityC, entityB),
        ],
      });

      const { rankedNodes, ranks } = buildLayoutRanks(layoutManager);

      // Group should be at rank 0
      expect(rankedNodes['group']).toMatchObject({
        globalRank: 1, // Comes after B
        rank: 0,
        rankHierarchy: undefined,
        in: new Set(['B', 'group']),
        out: new Set(['A', 'group']),
      });

      // Check entities within the group
      // Since B and C form a cycle, they should have the same rank
      // A depends on group (rank 0), so it should have rank 1 within the container
      expect(rankedNodes['A']).toMatchObject({
        globalRank: 2, // Comes after group
        rank: 0,
        rankHierarchy: [0],
        in: new Set(['group']),
        out: new Set([]),
      });

      // B and C form a cycle, so they should have rank 0 within the container
      expect(rankedNodes['B']).toMatchObject({
        globalRank: 0,
        rank: 0,
        rankHierarchy: [0],
        in: new Set(['C']),
        out: new Set(['group', 'C']),
      });

      expect(rankedNodes['C']).toMatchObject({
        globalRank: 1, // Comes after B
        rank: 1,
        rankHierarchy: [0],
        in: new Set(['B']),
        out: new Set(['B']),
      });

      // Verify top-level ranks structure
      expect(ranks.length).toBe(1);
      expect(ranks[0].nodes.map((n) => n.id)).toEqual(['group']);

      // Verify child ranks within the group
      const childRanks = rankedNodes['group'].childRanks;
      expect(childRanks).toBeDefined();
      expect(childRanks?.length).toBe(2);

      expect(childRanks?.[0].nodes.map((n) => n.id)).toEqual(['A', 'B']);
      expect(childRanks?.[1].nodes.map((n) => n.id)).toEqual(['C']);
    });
  });
});
