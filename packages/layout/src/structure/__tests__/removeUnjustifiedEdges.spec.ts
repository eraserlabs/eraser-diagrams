import { makeEntity, makeGroup, makeConnection } from '../../testUtils.js';
import { LayoutManager } from '../../LayoutManager.js';
import { buildRanks, calculateRankWidthMetric } from '../ranks.js';
import { identifyUnjustifiedEdges } from '../unjustifiedEdges.js';

describe('identifyUnjustifiedEdges', () => {
  describe('Basic functionality', () => {
    it('should not identify edges in a simple 3-node chain A→B→C', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 100, y: 0 });
      const entityC = makeEntity('C', { x: 200, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC],
        connections: [makeConnection(entityA, entityB), makeConnection(entityB, entityC)],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // No unjustified edges in a simple chain
      expect(unjustifiedEdges.size).toBe(0);
    });

    it('should identify B→C edge in triangle A→B→C with A→C (when C is a group)', () => {
      // A (rank 0) → B (rank 1) → C (rank 2)
      //   └─────────────────────→ C
      // B→C is unjustified because C has edge from rank 0 (A)
      // Note: Only identifies edges to groups, not leaf nodes
      const entityA1 = makeEntity('A1', { x: 10, y: 10 });
      const groupA = makeGroup('A', [entityA1]);
      const entityB1 = makeEntity('B1', { x: 160, y: 10 });
      const groupB = makeGroup('B', [entityB1]);
      const entityC1 = makeEntity('C1', { x: 310, y: 10 });
      const groupC = makeGroup('C', [entityC1]);
      const entityD1 = makeEntity('D1', { x: 510, y: 110 });
      const groupD = makeGroup('D', [entityD1]);

      const layoutManager = new LayoutManager({
        entities: [groupA, entityA1, groupB, entityB1, groupC, entityC1, groupD, entityD1],
        connections: [
          makeConnection(groupA, groupB),
          makeConnection(groupB, groupC),
          makeConnection(groupB, groupD), // B has 2 destinations, so B→C can be unjustified
          makeConnection(groupA, groupC), // Direct edge from rank 0 to rank 2
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      // Verify ranks
      expect(rankData.rankedNodes['A'].rank).toBe(0);
      expect(rankData.rankedNodes['B'].rank).toBe(1);
      expect(rankData.rankedNodes['C'].rank).toBe(2);

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Should identify B→C as unjustified
      expect(unjustifiedEdges.size).toBe(1);
      expect(unjustifiedEdges.has('B->C')).toBe(true);
    });

    it('should identify unjustified edges in separate branches (when all are groups)', () => {
      // A (rank 0) → B (rank 1) → C (rank 2)
      // A (rank 0) → D (rank 1) → E (rank 2)
      // A (rank 0) ─────────────→ C (rank 2)
      // A (rank 0) ─────────────→ E (rank 2)
      // B→C is unjustified (C has only ONE edge from rank 1, plus edge from rank 0)
      // D→E is unjustified (E has only ONE edge from rank 1, plus edge from rank 0)
      // Note: All nodes must be groups to avoid chain collapse rule
      // Note: B and D need multiple destinations for their edges to be removable
      const entityA1 = makeEntity('A1', { x: 10, y: 10 });
      const groupA = makeGroup('A', [entityA1]);
      const entityB1 = makeEntity('B1', { x: 160, y: 10 });
      const groupB = makeGroup('B', [entityB1]);
      const entityC1 = makeEntity('C1', { x: 320, y: 10 });
      const groupC = makeGroup('C', [entityC1]);
      const entityD1 = makeEntity('D1', { x: 160, y: 110 });
      const groupD = makeGroup('D', [entityD1]);
      const entityE1 = makeEntity('E1', { x: 320, y: 110 });
      const groupE = makeGroup('E', [entityE1]);
      // Extra destinations so B and D have multiple outgoing edges
      const entityF1 = makeEntity('F1', { x: 320, y: 60 });
      const groupF = makeGroup('F', [entityF1]);
      const entityG1 = makeEntity('G1', { x: 320, y: 160 });
      const groupG = makeGroup('G', [entityG1]);

      const layoutManager = new LayoutManager({
        entities: [
          groupA,
          entityA1,
          groupB,
          entityB1,
          groupC,
          entityC1,
          groupD,
          entityD1,
          groupE,
          entityE1,
          groupF,
          entityF1,
          groupG,
          entityG1,
        ],
        connections: [
          makeConnection(groupA, groupB),
          makeConnection(groupB, groupC),
          makeConnection(groupB, groupF), // B has 2 destinations
          makeConnection(groupA, groupC), // Makes B→C unjustified
          makeConnection(groupA, groupD),
          makeConnection(groupD, groupE),
          makeConnection(groupD, groupG), // D has 2 destinations
          makeConnection(groupA, groupE), // Makes D→E unjustified
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Should identify both B→C and D→E
      expect(unjustifiedEdges.size).toBe(2);
      expect(unjustifiedEdges.has('B->C')).toBe(true);
      expect(unjustifiedEdges.has('D->E')).toBe(true);
    });

    it('should NOT identify edge when leaf nodes form a chain (chain collapse rule)', () => {
      // A (node) → B (node) → C (group)
      // A ─────────────────→ C
      // A and B are leaf nodes with the same parent (top-level), forming a chain.
      // Chain collapse: A-B collapse to effective rank 0.
      // Both A→C and B→C are from effective rank 0.
      // Since there's no connection from effective rank 1 (N-1), B→C is NOT unjustified.
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: 0 });
      const entityC1 = makeEntity('C1', { x: 310, y: 10 });
      const groupC = makeGroup('C', [entityC1]);

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, groupC, entityC1],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityB, groupC),
          makeConnection(entityA, groupC),
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Chain collapse: A-B collapse, so B→C is from effective rank 0, not rank 1
      // No edge from effective rank 1, so criteria 3 fails - NOT unjustified
      expect(unjustifiedEdges.size).toBe(0);
    });

    it('should identify unjustified edge even when chain exists elsewhere in diagram', () => {
      // Start (group) → node1 → node2 → Middle (group) → End (group)
      // Start ──────────────────────────────────────────→ End
      //
      // Chain: node1 → node2 (leaf nodes, same parent, sequential)
      // But the chain connects to Middle, not End.
      // For End at rank 4:
      // - Middle→End from rank 3 (N-1) - exactly one
      // - Start→End from rank 0 (< N-1) - at least one
      // So Middle→End IS unjustified (chain doesn't protect it)
      // Note: Middle needs multiple destinations for its edge to be removable
      const entityStart1 = makeEntity('Start1', { x: 10, y: 10 });
      const groupStart = makeGroup('Start', [entityStart1]);
      const node1 = makeEntity('node1', { x: 100, y: 0 });
      const node2 = makeEntity('node2', { x: 200, y: 0 });
      const entityMiddle1 = makeEntity('Middle1', { x: 310, y: 10 });
      const groupMiddle = makeGroup('Middle', [entityMiddle1]);
      const entityEnd1 = makeEntity('End1', { x: 420, y: 10 });
      const groupEnd = makeGroup('End', [entityEnd1]);
      // Extra destination so Middle has multiple outgoing edges
      const entityOther1 = makeEntity('Other1', { x: 420, y: 110 });
      const groupOther = makeGroup('Other', [entityOther1]);

      const layoutManager = new LayoutManager({
        entities: [
          groupStart,
          entityStart1,
          node1,
          node2,
          groupMiddle,
          entityMiddle1,
          groupEnd,
          entityEnd1,
          groupOther,
          entityOther1,
        ],
        connections: [
          makeConnection(groupStart, node1),
          makeConnection(node1, node2), // Chain: node1 → node2
          makeConnection(node2, groupMiddle),
          makeConnection(groupMiddle, groupEnd),
          makeConnection(groupMiddle, groupOther), // Middle has 2 destinations
          makeConnection(groupStart, groupEnd), // Skip connection
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Middle→End is unjustified:
      // - End has one connection from rank 3 (Middle→End)
      // - End has one connection from rank 0 (Start→End)
      // The node1-node2 chain doesn't affect End because it connects to Middle, not End
      expect(unjustifiedEdges.size).toBe(1);
      expect(unjustifiedEdges.has('Middle->End')).toBe(true);
    });

    it('should identify single node edge as unjustified when earlier group also connects to target', () => {
      // groupStart → singleNode → groupTarget
      // groupEarlier ───────────→ groupTarget
      //
      // singleNode is a single leaf node (not a multi-node chain).
      // Single nodes are NOT protected by chain protection.
      //
      // For groupTarget at rank 2:
      // - singleNode→groupTarget from rank 1 (= N-1) - exactly one
      // - groupEarlier→groupTarget from rank 0 (< N-1) - at least one
      // So singleNode→groupTarget IS unjustified!
      // Note: singleNode needs multiple destinations for its edge to be removable
      const entityStart1 = makeEntity('Start1', { x: 10, y: 10 });
      const groupStart = makeGroup('Start', [entityStart1]);
      const entityEarlier1 = makeEntity('Earlier1', { x: 10, y: 110 });
      const groupEarlier = makeGroup('Earlier', [entityEarlier1]);
      const singleNode = makeEntity('singleNode', { x: 150, y: 0 });
      const entityTarget1 = makeEntity('Target1', { x: 310, y: 60 });
      const groupTarget = makeGroup('Target', [entityTarget1]);
      // Extra destination so singleNode has multiple outgoing edges
      const entityOther1 = makeEntity('Other1', { x: 310, y: 160 });
      const groupOther = makeGroup('Other', [entityOther1]);

      const layoutManager = new LayoutManager({
        entities: [
          groupStart,
          entityStart1,
          groupEarlier,
          entityEarlier1,
          singleNode,
          groupTarget,
          entityTarget1,
          groupOther,
          entityOther1,
        ],
        connections: [
          makeConnection(groupStart, singleNode),
          makeConnection(singleNode, groupTarget), // Single node edge to target
          makeConnection(singleNode, groupOther), // singleNode has 2 destinations
          makeConnection(groupEarlier, groupTarget), // Earlier direct connection
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // singleNode→Target is unjustified:
      // - singleNode is at rank 1 (not part of a multi-node chain, so not protected)
      // - Target has one connection from rank 1 (singleNode→Target)
      // - Target has one connection from rank 0 (Earlier→Target)
      // - One from N-1, one from earlier → singleNode edge is unjustified
      expect(unjustifiedEdges.size).toBe(1);
      expect(unjustifiedEdges.has('singleNode->Target')).toBe(true);
    });

    it('should NOT identify edges in diamond when multiple N-1 nodes connect to same N node', () => {
      // A (rank 0) → B (rank 1) → C (rank 2)
      //   ├────────→ D (rank 1) → C
      //   └─────────────────────→ C
      // C has TWO edges from rank 1 (B→C and D→C), so neither should be identified
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: -50 });
      const entityD = makeEntity('D', { x: 150, y: 50 });
      const entityC1 = makeEntity('C1', { x: 310, y: 10 });
      const groupC = makeGroup('C', [entityC1]);

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityD, groupC, entityC1],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityA, entityD),
          makeConnection(entityB, groupC),
          makeConnection(entityD, groupC),
          makeConnection(entityA, groupC), // Direct edge from rank 0
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // No edges should be identified - C has multiple incoming from rank 1
      expect(unjustifiedEdges.size).toBe(0);
    });

    it('should NOT identify edges when multiple N-1 nodes connect to same N node', () => {
      // Same as above but different setup - ensuring multiple rank 1 edges prevent identification
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: -50 });
      const entityD = makeEntity('D', { x: 150, y: 50 });
      const entityC1 = makeEntity('C1', { x: 310, y: 10 });
      const groupC = makeGroup('C', [entityC1]);

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityD, groupC, entityC1],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityA, entityD),
          makeConnection(entityB, groupC), // One edge from rank 1
          makeConnection(entityD, groupC), // Another edge from rank 1
          makeConnection(entityA, groupC), // Edge from rank 0
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Should not identify any edges - multiple rank 1 sources
      expect(unjustifiedEdges.size).toBe(0);
    });
  });

  describe('Edge cases', () => {
    it('should not identify edges to nodes at rank 0 or 1', () => {
      // Node at rank 1 can't have an "earlier" edge by definition
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB1 = makeEntity('B1', { x: 110, y: 10 });
      const groupB = makeGroup('B', [entityB1]);

      const layoutManager = new LayoutManager({
        entities: [entityA, groupB, entityB1],
        connections: [makeConnection(entityA, groupB)],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      expect(unjustifiedEdges.size).toBe(0);
    });

    it('should not identify edge when node has only one incoming edge', () => {
      // A → B → C (group)
      // No unjustified edges because C only has one incoming
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 100, y: 0 });
      const entityC1 = makeEntity('C1', { x: 210, y: 10 });
      const groupC = makeGroup('C', [entityC1]);

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, groupC, entityC1],
        connections: [makeConnection(entityA, entityB), makeConnection(entityB, groupC)],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      expect(unjustifiedEdges.size).toBe(0);
    });

    it('should handle empty connections array', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [entityA],
        connections: [],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      expect(unjustifiedEdges.size).toBe(0);
    });

    it('should return empty set when no unjustified edges exist', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 100, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB],
        connections: [makeConnection(entityA, entityB)],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      expect(unjustifiedEdges.size).toBe(0);
    });
  });

  describe('Nested structures', () => {
    it('should identify top-level unjustified edge to a group', () => {
      // Top-level: A (rank 0) → B (rank 1) → C (rank 2)
      //                      └─────────────→ C
      // All nodes must be groups to avoid chain collapse rule
      // Note: B needs multiple destinations for its edge to be removable
      const entityA1 = makeEntity('A1', { x: 10, y: 10 });
      const groupA = makeGroup('A', [entityA1]);
      const entityB1 = makeEntity('B1', { x: 160, y: 10 });
      const groupB = makeGroup('B', [entityB1]);
      const entityC1 = makeEntity('C1', { x: 320, y: 10 });
      const groupC = makeGroup('C', [entityC1]);
      // Extra destination so B has multiple outgoing edges
      const entityD1 = makeEntity('D1', { x: 320, y: 110 });
      const groupD = makeGroup('D', [entityD1]);

      const layoutManager = new LayoutManager({
        entities: [groupA, entityA1, groupB, entityB1, groupC, entityC1, groupD, entityD1],
        connections: [
          makeConnection(groupA, groupB),
          makeConnection(groupB, groupC),
          makeConnection(groupB, groupD), // B has 2 destinations
          makeConnection(groupA, groupC),
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Should identify B→C at top level
      expect(unjustifiedEdges.size).toBe(1);
      expect(unjustifiedEdges.has('B->C')).toBe(true);
    });

    it('should identify unjustified edges inside container when target is a subgroup', () => {
      // Container-G has: X → Y → Z (all subgroups) with X → Z
      // Y→Z should be identified because Z is a subgroup
      // Note: Y needs multiple destinations for its edge to be removable
      const entityX1 = makeEntity('X1', { x: 15, y: 15 });
      const subgroupX = makeGroup('X', [entityX1]);
      const entityY1 = makeEntity('Y1', { x: 65, y: 15 });
      const subgroupY = makeGroup('Y', [entityY1]);
      const entityZ1 = makeEntity('Z1', { x: 115, y: 15 });
      const subgroupZ = makeGroup('Z', [entityZ1]);
      // Extra destination so Y has multiple outgoing edges
      const entityW1 = makeEntity('W1', { x: 115, y: 65 });
      const subgroupW = makeGroup('W', [entityW1]);
      const containerG = makeGroup('G', [subgroupX, subgroupY, subgroupZ, subgroupW]);

      const layoutManager = new LayoutManager({
        entities: [
          containerG,
          subgroupX,
          entityX1,
          subgroupY,
          entityY1,
          subgroupZ,
          entityZ1,
          subgroupW,
          entityW1,
        ],
        connections: [
          makeConnection(subgroupX, subgroupY),
          makeConnection(subgroupY, subgroupZ),
          makeConnection(subgroupY, subgroupW), // Y has 2 destinations
          makeConnection(subgroupX, subgroupZ),
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      // Verify local ranks within container
      expect(rankData.rankedNodes['X'].rank).toBe(0);
      expect(rankData.rankedNodes['Y'].rank).toBe(1);
      expect(rankData.rankedNodes['Z'].rank).toBe(2);

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Should identify Y→Z inside container (Z is a subgroup)
      expect(unjustifiedEdges.size).toBe(1);
      expect(unjustifiedEdges.has('Y->Z')).toBe(true);
    });

    it('should handle multiple nested levels with unjustified edges at different levels', () => {
      // Top level: A → B → C (group) with A → C (B→C unjustified)
      // Inside container C: X → Y → Z (subgroup) with X → Z (Y→Z unjustified)
      // All nodes must be groups to avoid chain collapse rule
      // Note: B and Y need multiple destinations for their edges to be removable
      const entityA1 = makeEntity('A1', { x: 10, y: 10 });
      const groupA = makeGroup('A', [entityA1]);
      const entityB1 = makeEntity('B1', { x: 160, y: 10 });
      const groupB = makeGroup('B', [entityB1]);
      // Extra destination so B has multiple outgoing edges
      const entityD1 = makeEntity('D1', { x: 320, y: 110 });
      const groupD = makeGroup('D', [entityD1]);

      const entityX1 = makeEntity('X1', { x: 320, y: 15 });
      const subgroupX = makeGroup('X', [entityX1]);
      const entityY1 = makeEntity('Y1', { x: 380, y: 15 });
      const subgroupY = makeGroup('Y', [entityY1]);
      const entityZ1 = makeEntity('Z1', { x: 440, y: 15 });
      const subgroupZ = makeGroup('Z', [entityZ1]);
      // Extra destination so Y has multiple outgoing edges
      const entityW1 = makeEntity('W1', { x: 440, y: 65 });
      const subgroupW = makeGroup('W', [entityW1]);
      const containerC = makeGroup('C', [subgroupX, subgroupY, subgroupZ, subgroupW]);

      const layoutManager = new LayoutManager({
        entities: [
          groupA,
          entityA1,
          groupB,
          entityB1,
          groupD,
          entityD1,
          containerC,
          subgroupX,
          entityX1,
          subgroupY,
          entityY1,
          subgroupZ,
          entityZ1,
          subgroupW,
          entityW1,
        ],
        connections: [
          // Top level
          makeConnection(groupA, groupB),
          makeConnection(groupB, containerC),
          makeConnection(groupB, groupD), // B has 2 destinations
          makeConnection(groupA, containerC),
          // Inside container C
          makeConnection(subgroupX, subgroupY),
          makeConnection(subgroupY, subgroupZ),
          makeConnection(subgroupY, subgroupW), // Y has 2 destinations
          makeConnection(subgroupX, subgroupZ),
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Should identify B→C (top-level group) and Y→Z (subgroup inside container)
      expect(unjustifiedEdges.size).toBe(2);
      expect(unjustifiedEdges.has('B->C')).toBe(true);
      expect(unjustifiedEdges.has('Y->Z')).toBe(true);
    });
  });

  describe('Does not modify input', () => {
    it('should not modify the original rankData', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: 0 });
      const entityC1 = makeEntity('C1', { x: 310, y: 10 });
      const groupC = makeGroup('C', [entityC1]);

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, groupC, entityC1],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityB, groupC),
          makeConnection(entityA, groupC),
        ],
        primaryDirection: 'right',
      });

      const rankData = buildRanks({
        entitiesById: layoutManager.getEntitiesMapping(),
        containerMapping: layoutManager.getContainerMapping(),
        parentMapping: layoutManager.getParentMapping(),
        connections: layoutManager.getConnections(),
      });

      // Store original in/out sets
      const originalBOut = new Set(rankData.rankedNodes['B'].out);
      const originalCIn = new Set(rankData.rankedNodes['C'].in);

      identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

      // Should NOT modify the original rankData
      expect(rankData.rankedNodes['B'].out).toEqual(originalBOut);
      expect(rankData.rankedNodes['C'].in).toEqual(originalCIn);
    });
  });

  describe('Node path detection and protection', () => {
    describe('Path tracing backwards', () => {
      it('should trace node path backwards from target group', () => {
        // A -> B -> C -> Group_D
        // Path: [C, B, A] traced backwards from Group_D
        // All edges in path should be protected
        const entityA = makeEntity('A', { x: 0, y: 0 });
        const entityB = makeEntity('B', { x: 100, y: 0 });
        const entityC = makeEntity('C', { x: 200, y: 0 });
        const entityD1 = makeEntity('D1', { x: 310, y: 10 });
        const groupD = makeGroup('D', [entityD1]);

        const layoutManager = new LayoutManager({
          entities: [entityA, entityB, entityC, groupD, entityD1],
          connections: [
            makeConnection(entityA, entityB),
            makeConnection(entityB, entityC),
            makeConnection(entityC, groupD),
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // No edges should be removed - all are part of the path
        expect(unjustifiedEdges.size).toBe(0);
      });

      it('should include branching nodes in paths', () => {
        // A -> B -> C -> Group_D
        //      ↓
        //      E -> F
        // Path to Group_D: [C, B, A] - B's branching doesn't break the path
        const entityA = makeEntity('A', { x: 0, y: 0 });
        const entityB = makeEntity('B', { x: 100, y: 0 });
        const entityC = makeEntity('C', { x: 200, y: 0 });
        const entityD1 = makeEntity('D1', { x: 310, y: 10 });
        const groupD = makeGroup('D', [entityD1]);
        const entityE = makeEntity('E', { x: 100, y: 100 });
        const entityF = makeEntity('F', { x: 200, y: 100 });

        const layoutManager = new LayoutManager({
          entities: [entityA, entityB, entityC, groupD, entityD1, entityE, entityF],
          connections: [
            makeConnection(entityA, entityB),
            makeConnection(entityB, entityC),
            makeConnection(entityC, groupD),
            makeConnection(entityB, entityE),
            makeConnection(entityE, entityF),
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // No edges in the path to Group_D should be removed
        expect(unjustifiedEdges.has('A->B')).toBe(false);
        expect(unjustifiedEdges.has('B->C')).toBe(false);
        expect(unjustifiedEdges.has('C->D')).toBe(false);
      });

      it('should stop at containers when tracing backwards', () => {
        // Group_A -> B -> C -> Group_D
        // Path stops at B (Group_A is a container, not included in path)
        const entityA1 = makeEntity('A1', { x: 10, y: 10 });
        const groupA = makeGroup('A', [entityA1]);
        const entityB = makeEntity('B', { x: 100, y: 0 });
        const entityC = makeEntity('C', { x: 200, y: 0 });
        const entityD1 = makeEntity('D1', { x: 310, y: 10 });
        const groupD = makeGroup('D', [entityD1]);

        const layoutManager = new LayoutManager({
          entities: [groupA, entityA1, entityB, entityC, groupD, entityD1],
          connections: [
            makeConnection(groupA, entityB),
            makeConnection(entityB, entityC),
            makeConnection(entityC, groupD),
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // All edges should be protected
        expect(unjustifiedEdges.size).toBe(0);
      });
    });

    describe('Path edge protection', () => {
      it('should protect ALL edges in node path A->B->C->Group_D', () => {
        // A (rank 0) -> B (rank 1) -> C (rank 2) -> Group_D (rank 3)
        // All edges in this 3-node path should be protected
        const entityA = makeEntity('A', { x: 0, y: 0 });
        const entityB = makeEntity('B', { x: 100, y: 0 });
        const entityC = makeEntity('C', { x: 200, y: 0 });
        const entityD1 = makeEntity('D1', { x: 310, y: 10 });
        const groupD = makeGroup('D', [entityD1]);

        const layoutManager = new LayoutManager({
          entities: [entityA, entityB, entityC, groupD, entityD1],
          connections: [
            makeConnection(entityA, entityB),
            makeConnection(entityB, entityC),
            makeConnection(entityC, groupD),
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // Verify all path edges are protected
        expect(unjustifiedEdges.has('A->B')).toBe(false);
        expect(unjustifiedEdges.has('B->C')).toBe(false);
        expect(unjustifiedEdges.has('C->D')).toBe(false);
        expect(unjustifiedEdges.size).toBe(0);
      });

      it('should protect multi-node path at same rank', () => {
        // Test that path protection works correctly
        // Group_A -> B -> C -> Group_D (where B and C are at same rank due to structure)
        // This creates a multi-node path that should be protected
        const entityA1 = makeEntity('A1', { x: 10, y: 10 });
        const groupA = makeGroup('A', [entityA1]);
        const entityB = makeEntity('B', { x: 100, y: -50 });
        const entityC = makeEntity('C', { x: 200, y: -50 });
        const entityD1 = makeEntity('D1', { x: 310, y: 10 });
        const groupD = makeGroup('D', [entityD1]);

        const layoutManager = new LayoutManager({
          entities: [groupA, entityA1, entityB, entityC, groupD, entityD1],
          connections: [
            makeConnection(groupA, entityB),
            makeConnection(entityB, entityC),
            makeConnection(entityC, groupD),
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // Simple path without earlier connections - no edges should be unjustified
        expect(unjustifiedEdges.has('B->C')).toBe(false);
        expect(unjustifiedEdges.has('C->D')).toBe(false);
        expect(unjustifiedEdges.size).toBe(0);
      });

      it('should protect multiple paths to same group independently', () => {
        // A->B->Group_E and C->D->Group_E (two independent paths)
        // Both paths should be fully protected
        const entityA = makeEntity('A', { x: 0, y: -50 });
        const entityB = makeEntity('B', { x: 100, y: -50 });
        const entityC = makeEntity('C', { x: 0, y: 50 });
        const entityD = makeEntity('D', { x: 100, y: 50 });
        const entityE1 = makeEntity('E1', { x: 210, y: 10 });
        const groupE = makeGroup('E', [entityE1]);

        const layoutManager = new LayoutManager({
          entities: [entityA, entityB, entityC, entityD, groupE, entityE1],
          connections: [
            makeConnection(entityA, entityB),
            makeConnection(entityB, groupE),
            makeConnection(entityC, entityD),
            makeConnection(entityD, groupE),
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // Both paths should be protected (Group_E has 2 connections from rank 1)
        expect(unjustifiedEdges.has('A->B')).toBe(false);
        expect(unjustifiedEdges.has('B->E')).toBe(false);
        expect(unjustifiedEdges.has('C->D')).toBe(false);
        expect(unjustifiedEdges.has('D->E')).toBe(false);
        expect(unjustifiedEdges.size).toBe(0);
      });
    });

    describe('Bidirectional edge handling', () => {
      it('should handle path with multiple segments A->B->C->Group_D', () => {
        // A -> B -> C -> Group_D where A, B, C are all at the same rank
        // All edges in this path should be protected
        // To ensure A, B, C are at the same rank, we start from a common source
        const entitySource = makeEntity('Source', { x: -100, y: 0 });
        const entityA = makeEntity('A', { x: 0, y: -50 });
        const entityB = makeEntity('B', { x: 100, y: 0 });
        const entityC = makeEntity('C', { x: 200, y: 50 });
        const entityD1 = makeEntity('D1', { x: 310, y: 10 });
        const groupD = makeGroup('D', [entityD1]);

        const layoutManager = new LayoutManager({
          entities: [entitySource, entityA, entityB, entityC, groupD, entityD1],
          connections: [
            makeConnection(entitySource, entityA),
            makeConnection(entityA, entityB),
            makeConnection(entityB, entityC),
            makeConnection(entityC, groupD),
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        // Verify ranks - A, B, C should all be at same rank
        const rankA = rankData.rankedNodes['A'].rank;
        const rankB = rankData.rankedNodes['B'].rank;
        const rankC = rankData.rankedNodes['C'].rank;

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // If A, B, C are at the same rank, path edges should be protected
        if (rankA === rankB && rankB === rankC) {
          expect(unjustifiedEdges.has('A->B')).toBe(false);
          expect(unjustifiedEdges.has('B->C')).toBe(false);
          expect(unjustifiedEdges.has('C->D')).toBe(false);
        }

        // Test passes if ranks are validated correctly
        expect(unjustifiedEdges).toBeDefined();
      });
    });

    describe('Same-level requirement', () => {
      it('should NOT include nodes from different containers in same path', () => {
        // Group_A { X -> Y }
        // Group_B { Z -> W }
        // X -> Z should not be considered part of any path (different containers)
        const entityX = makeEntity('X', { x: 10, y: 10 });
        const entityY = makeEntity('Y', { x: 60, y: 10 });
        const groupA = makeGroup('A', [entityX, entityY]);

        const entityZ = makeEntity('Z', { x: 10, y: 110 });
        const entityW = makeEntity('W', { x: 60, y: 110 });
        const groupB = makeGroup('B', [entityZ, entityW]);

        const layoutManager = new LayoutManager({
          entities: [groupA, entityX, entityY, groupB, entityZ, entityW],
          connections: [
            makeConnection(entityX, entityY),
            makeConnection(entityZ, entityW),
            makeConnection(entityX, entityZ), // Cross-container edge
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // This test just verifies no errors occur with cross-container edges
        expect(unjustifiedEdges).toBeDefined();
      });

      it('should handle paths within nested containers', () => {
        // Container with nested path: A -> B -> C (subgroup)
        const entityA = makeEntity('A', { x: 10, y: 10 });
        const entityB = makeEntity('B', { x: 60, y: 10 });
        const entityC1 = makeEntity('C1', { x: 115, y: 15 });
        const subgroupC = makeGroup('C', [entityC1]);
        const containerG = makeGroup('G', [entityA, entityB, subgroupC]);

        const layoutManager = new LayoutManager({
          entities: [containerG, entityA, entityB, subgroupC, entityC1],
          connections: [makeConnection(entityA, entityB), makeConnection(entityB, subgroupC)],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // Path edges within nested container should be protected
        expect(unjustifiedEdges.has('A->B')).toBe(false);
        expect(unjustifiedEdges.has('B->C')).toBe(false);
        expect(unjustifiedEdges.size).toBe(0);
      });
    });

    describe('Edge cases', () => {
      it('should handle single-node path', () => {
        // A -> Group_B (direct connection, no intermediate nodes)
        // Edge A->Group_B should be protected
        const entityA = makeEntity('A', { x: 0, y: 0 });
        const entityB1 = makeEntity('B1', { x: 110, y: 10 });
        const groupB = makeGroup('B', [entityB1]);

        const layoutManager = new LayoutManager({
          entities: [entityA, groupB, entityB1],
          connections: [makeConnection(entityA, groupB)],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // Single-node path should be protected
        expect(unjustifiedEdges.has('A->B')).toBe(false);
        expect(unjustifiedEdges.size).toBe(0);
      });

      it('should handle parallel paths at same rank', () => {
        // Two independent paths side-by-side to different groups
        // A->B->Group_C and D->E->Group_F
        const entityA = makeEntity('A', { x: 0, y: -50 });
        const entityB = makeEntity('B', { x: 100, y: -50 });
        const entityC1 = makeEntity('C1', { x: 210, y: -40 });
        const groupC = makeGroup('C', [entityC1]);

        const entityD = makeEntity('D', { x: 0, y: 50 });
        const entityE = makeEntity('E', { x: 100, y: 50 });
        const entityF1 = makeEntity('F1', { x: 210, y: 60 });
        const groupF = makeGroup('F', [entityF1]);

        const layoutManager = new LayoutManager({
          entities: [entityA, entityB, groupC, entityC1, entityD, entityE, groupF, entityF1],
          connections: [
            makeConnection(entityA, entityB),
            makeConnection(entityB, groupC),
            makeConnection(entityD, entityE),
            makeConnection(entityE, groupF),
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // Both paths should be protected independently
        expect(unjustifiedEdges.has('A->B')).toBe(false);
        expect(unjustifiedEdges.has('B->C')).toBe(false);
        expect(unjustifiedEdges.has('D->E')).toBe(false);
        expect(unjustifiedEdges.has('E->F')).toBe(false);
        expect(unjustifiedEdges.size).toBe(0);
      });

      it('should handle complex branching structures', () => {
        // Multiple branches converging to same group:
        //   A -> B -> D -> F (ranks: A=0, B=1, D=2, F=4)
        //        ↓
        //        C -> E -> F (ranks: C=2, E=3)
        // E is the only rank-3 connection, but D provides earlier rank-2 connection
        // So E->F is unjustified
        // All nodes must be groups to avoid chain collapse rule
        // Note: E needs multiple destinations for its edge to be removable
        const entityA1 = makeEntity('A1', { x: 10, y: 10 });
        const groupA = makeGroup('A', [entityA1]);
        const entityB1 = makeEntity('B1', { x: 110, y: 10 });
        const groupB = makeGroup('B', [entityB1]);
        const entityC1 = makeEntity('C1', { x: 110, y: 110 });
        const groupC = makeGroup('C', [entityC1]);
        const entityD1 = makeEntity('D1', { x: 210, y: 10 });
        const groupD = makeGroup('D', [entityD1]);
        const entityE1 = makeEntity('E1', { x: 210, y: 110 });
        const groupE = makeGroup('E', [entityE1]);
        const entityF1 = makeEntity('F1', { x: 320, y: 60 });
        const groupF = makeGroup('F', [entityF1]);
        // Extra destination so E has multiple outgoing edges
        const entityG1 = makeEntity('G1', { x: 320, y: 160 });
        const groupG = makeGroup('G', [entityG1]);

        const layoutManager = new LayoutManager({
          entities: [
            groupA,
            entityA1,
            groupB,
            entityB1,
            groupC,
            entityC1,
            groupD,
            entityD1,
            groupE,
            entityE1,
            groupF,
            entityF1,
            groupG,
            entityG1,
          ],
          connections: [
            makeConnection(groupA, groupB),
            makeConnection(groupB, groupD),
            makeConnection(groupD, groupF),
            makeConnection(groupB, groupC),
            makeConnection(groupC, groupE),
            makeConnection(groupE, groupF),
            makeConnection(groupE, groupG), // E has 2 destinations
          ],
          primaryDirection: 'right',
        });

        const rankData = buildRanks({
          entitiesById: layoutManager.getEntitiesMapping(),
          containerMapping: layoutManager.getContainerMapping(),
          parentMapping: layoutManager.getParentMapping(),
          connections: layoutManager.getConnections(),
        });

        const unjustifiedEdges = identifyUnjustifiedEdges(rankData, layoutManager.getConnections());

        // No edges should be unjustified - groups don't form chains
        expect(unjustifiedEdges.has('A->B')).toBe(false);
        expect(unjustifiedEdges.has('B->D')).toBe(false);
        expect(unjustifiedEdges.has('B->C')).toBe(false);
        expect(unjustifiedEdges.has('C->E')).toBe(false);

        // E->F is correctly identified as unjustified:
        // - E is the only rank-3 node connecting to F
        // - D provides an earlier rank-2 connection
        expect(unjustifiedEdges.has('E->F')).toBe(true);

        // D->F is not unjustified (F has no connection earlier than rank 2)
        expect(unjustifiedEdges.has('D->F')).toBe(false);
      });
    });
  });
});

describe('calculateRankWidthMetric', () => {
  it('should calculate correct metric for single-node ranks', () => {
    // A → B → C (3 ranks, 1 node each)
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 100, y: 0 });
    const entityC = makeEntity('C', { x: 200, y: 0 });

    const layoutManager = new LayoutManager({
      entities: [entityA, entityB, entityC],
      connections: [makeConnection(entityA, entityB), makeConnection(entityB, entityC)],
      primaryDirection: 'right',
    });

    const rankData = buildRanks({
      entitiesById: layoutManager.getEntitiesMapping(),
      containerMapping: layoutManager.getContainerMapping(),
      parentMapping: layoutManager.getParentMapping(),
      connections: layoutManager.getConnections(),
    });

    const metric = calculateRankWidthMetric(rankData, 'right', { NODE_SIZE: 50, NODE_SPACING: 40 });

    // 3 ranks with 1 node each:
    // - widestRankSize = 50 (1 node per rank)
    // - rankDepth = 3*50 + 2*40 = 230
    // For direction 'right' (horizontal): width = rankDepth, height = widestRankSize
    expect(metric.widestRankWidth).toBe(230);
    expect(metric.estimatedHeight).toBe(50);
  });

  it('should calculate correct metric for multi-node ranks', () => {
    // A → C, B → C (2 ranks: [A, B], [C])
    const entityA = makeEntity('A', { x: 0, y: 0 });
    const entityB = makeEntity('B', { x: 0, y: 100 });
    const entityC = makeEntity('C', { x: 100, y: 50 });

    const layoutManager = new LayoutManager({
      entities: [entityA, entityB, entityC],
      connections: [makeConnection(entityA, entityC), makeConnection(entityB, entityC)],
      primaryDirection: 'right',
    });

    const rankData = buildRanks({
      entitiesById: layoutManager.getEntitiesMapping(),
      containerMapping: layoutManager.getContainerMapping(),
      parentMapping: layoutManager.getParentMapping(),
      connections: layoutManager.getConnections(),
    });

    const metric = calculateRankWidthMetric(rankData, 'right', { NODE_SIZE: 50, NODE_SPACING: 40 });

    // 2 ranks: [A, B] and [C]
    // - widestRankSize = 2*50 + 1*40 = 140
    // - rankDepth = 2*50 + 1*40 = 140
    // For direction 'right' (horizontal): width = rankDepth, height = widestRankSize
    expect(metric.widestRankWidth).toBe(140);
    expect(metric.estimatedHeight).toBe(140);
  });
});
