import {
  buildVisualRanksFromElk,
  shouldUseVisualRanking,
  ElkNodeLike,
  NodeOrGroup,
  NodeOrGroupType,
} from '../visualRanks.js';
import { buildRanks, RankData } from '../ranks.js';

describe('visualRanks', () => {
  const OVERLAP_THRESHOLD = 0.3;
  const BOUNDARY_MULTIPLIER = 0.75;

  describe('buildVisualRanksFromElk - horizontal (left/right)', () => {
    it('should rank nodes by x-position for left/right direction', () => {
      const elkNodes: ElkNodeLike[] = [
        { id: 'A', x: 0, y: 0, width: 100, height: 50 },
        { id: 'B', x: 200, y: 0, width: 100, height: 50 },
        { id: 'C', x: 400, y: 0, width: 100, height: 50 },
      ];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        A: { id: 'A', type: NodeOrGroupType.NODE },
        B: { id: 'B', type: NodeOrGroupType.NODE },
        C: { id: 'C', type: NodeOrGroupType.NODE },
      };

      const { rankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'left',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // Should have 3 ranks (one for each x-position)
      expect(rankData.ranks.length).toBe(3);
      expect(rankData.rankedNodes['A'].rank).toBe(0);
      expect(rankData.rankedNodes['B'].rank).toBe(1);
      expect(rankData.rankedNodes['C'].rank).toBe(2);
    });

    it('should group nodes with overlapping x-positions in same rank', () => {
      const elkNodes: ElkNodeLike[] = [
        { id: 'A', x: 0, y: 0, width: 100, height: 50 },
        { id: 'B', x: 50, y: 100, width: 100, height: 50 }, // Overlaps with A
        { id: 'C', x: 300, y: 0, width: 100, height: 50 },
      ];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        A: { id: 'A', type: NodeOrGroupType.NODE },
        B: { id: 'B', type: NodeOrGroupType.NODE },
        C: { id: 'C', type: NodeOrGroupType.NODE },
      };

      const { rankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'right',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // A and B should be in same rank (overlapping x), C in different rank
      expect(rankData.rankedNodes['A'].rank).toBe(rankData.rankedNodes['B'].rank);
      expect(rankData.rankedNodes['C'].rank).not.toBe(rankData.rankedNodes['A'].rank);
    });
  });

  describe('buildVisualRanksFromElk - vertical (up/down)', () => {
    it('should rank nodes by y-position for up/down direction', () => {
      const elkNodes: ElkNodeLike[] = [
        { id: 'A', x: 0, y: 0, width: 100, height: 50 },
        { id: 'B', x: 0, y: 100, width: 100, height: 50 },
        { id: 'C', x: 0, y: 200, width: 100, height: 50 },
      ];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        A: { id: 'A', type: NodeOrGroupType.NODE },
        B: { id: 'B', type: NodeOrGroupType.NODE },
        C: { id: 'C', type: NodeOrGroupType.NODE },
      };

      const { rankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'down',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // Should have 3 ranks (one for each y-position)
      expect(rankData.ranks.length).toBe(3);
      expect(rankData.rankedNodes['A'].rank).toBe(0);
      expect(rankData.rankedNodes['B'].rank).toBe(1);
      expect(rankData.rankedNodes['C'].rank).toBe(2);
    });
  });

  describe('buildVisualRanksFromElk', () => {
    it('should extract nodes from ElkNode tree and build visual ranks', () => {
      const elkNodes: ElkNodeLike[] = [
        {
          id: 'A',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
        },
        {
          id: 'B',
          x: 200,
          y: 0,
          width: 100,
          height: 50,
        },
      ];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        A: { id: 'A', type: NodeOrGroupType.NODE },
        B: { id: 'B', type: NodeOrGroupType.NODE },
      };

      const { rankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'left',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      expect(rankData.rankedNodes['A'].rank).toBe(0);
      expect(rankData.rankedNodes['B'].rank).toBe(1);
    });

    it('should handle grid with offsets', () => {
      // Create a layout with staggered horizontal positions (DOWN direction)
      const elkNodes: ElkNodeLike[] = [
        // Primary rank 0 (y=0) - 2 nodes
        { id: 'A1', x: 0, y: 0, width: 100, height: 50 },
        { id: 'A2', x: 200, y: 0, width: 100, height: 50 },

        // Primary rank 1 (y=100) - 3 nodes
        { id: 'B1', x: 0, y: 100, width: 100, height: 50 },
        { id: 'B2', x: 100, y: 100, width: 100, height: 50 },
        { id: 'B3', x: 250, y: 100, width: 100, height: 50 },

        // Primary rank 2 (y=200) - 2 nodes
        { id: 'C1', x: 50, y: 200, width: 100, height: 50 },
        { id: 'C2', x: 200, y: 200, width: 100, height: 50 },
      ];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {};
      elkNodes.forEach((node) => {
        nodeAndClusterMap[node.id] = { id: node.id, type: NodeOrGroupType.NODE };
      });

      const { rankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'down',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // Verify primary ranks (based on y-position)
      expect(rankData.rankedNodes['A1'].rank).toBe(0);
      expect(rankData.rankedNodes['A2'].rank).toBe(0);

      expect(rankData.rankedNodes['B1'].rank).toBe(1);
      expect(rankData.rankedNodes['B2'].rank).toBe(1);
      expect(rankData.rankedNodes['B3'].rank).toBe(1);

      expect(rankData.rankedNodes['C1'].rank).toBe(2);
      expect(rankData.rankedNodes['C2'].rank).toBe(2);

      // Verify each rank is sorted correctly
      expect(rankData.ranks[0].nodes.map((n) => n.id)).toEqual(['A1', 'A2']);
      expect(rankData.ranks[1].nodes.map((n) => n.id)).toEqual(['B1', 'B2', 'B3']);
      expect(rankData.ranks[2].nodes.map((n) => n.id)).toEqual(['C1', 'C2']);

      // Verify we have 3 primary ranks
      expect(rankData.ranks.length).toBe(3);
    });
  });

  describe('shouldUseVisualRanking', () => {
    it('should return true when visual ranks match connection ranks', () => {
      const visualRankData: RankData = {
        ranks: [],
        globalRanks: [],
        rankedNodes: {
          A: { id: 'A', rank: 0, globalRank: 0, in: new Set(), out: new Set() },
          B: { id: 'B', rank: 1, globalRank: 1, in: new Set(), out: new Set() },
        },
        parentMapping: {},
        containerMapping: {},
        isVisualRanking: true,
      };

      const connectionRankData: RankData = {
        ranks: [],
        globalRanks: [],
        rankedNodes: {
          A: { id: 'A', rank: 0, globalRank: 0, in: new Set(), out: new Set() },
          B: { id: 'B', rank: 1, globalRank: 1, in: new Set(), out: new Set() },
        },
        parentMapping: {},
        containerMapping: {},
      };

      expect(shouldUseVisualRanking(visualRankData, connectionRankData)).toBe(true);
    });

    it('should return true when visual ranks are within tolerance', () => {
      const visualRankData: RankData = {
        ranks: [],
        globalRanks: [],
        rankedNodes: {
          A: { id: 'A', rank: 0, globalRank: 0, in: new Set(), out: new Set() },
          B: { id: 'B', rank: 2, globalRank: 2, in: new Set(), out: new Set() },
        },
        parentMapping: {},
        containerMapping: {},
        isVisualRanking: true,
      };

      const connectionRankData: RankData = {
        ranks: [],
        globalRanks: [],
        rankedNodes: {
          A: { id: 'A', rank: 0, globalRank: 0, in: new Set(), out: new Set() },
          B: { id: 'B', rank: 1, globalRank: 1, in: new Set(), out: new Set() }, // Difference of 1, within tolerance
        },
        parentMapping: {},
        containerMapping: {},
      };

      expect(shouldUseVisualRanking(visualRankData, connectionRankData, 1)).toBe(true);
    });

    it('should return false when visual ranks differ significantly', () => {
      const visualRankData: RankData = {
        ranks: [],
        globalRanks: [],
        rankedNodes: {
          A: { id: 'A', rank: 0, globalRank: 0, in: new Set(), out: new Set() },
          B: { id: 'B', rank: 5, globalRank: 5, in: new Set(), out: new Set() },
        },
        parentMapping: {},
        containerMapping: {},
        isVisualRanking: true,
      };

      const connectionRankData: RankData = {
        ranks: [],
        globalRanks: [],
        rankedNodes: {
          A: { id: 'A', rank: 0, globalRank: 0, in: new Set(), out: new Set() },
          B: { id: 'B', rank: 1, globalRank: 1, in: new Set(), out: new Set() }, // Difference of 4, exceeds tolerance of 1
        },
        parentMapping: {},
        containerMapping: {},
      };

      expect(shouldUseVisualRanking(visualRankData, connectionRankData, 1)).toBe(false);
    });
  });

  describe('VisualRankData vs RankData equivalence', () => {
    it('should produce equivalent alignment results for 3x3 grid layout', () => {
      // Create a 3x3 grid layout
      const elkNodes: ElkNodeLike[] = [
        // Row 1
        { id: 'A1', x: 0, y: 0, width: 100, height: 50 },
        { id: 'A2', x: 150, y: 0, width: 100, height: 50 },
        { id: 'A3', x: 300, y: 0, width: 100, height: 50 },
        // Row 2
        { id: 'B1', x: 0, y: 100, width: 100, height: 50 },
        { id: 'B2', x: 150, y: 100, width: 100, height: 50 },
        { id: 'B3', x: 300, y: 100, width: 100, height: 50 },
        // Row 3
        { id: 'C1', x: 0, y: 200, width: 100, height: 50 },
        { id: 'C2', x: 150, y: 200, width: 100, height: 50 },
        { id: 'C3', x: 300, y: 200, width: 100, height: 50 },
      ];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {};
      elkNodes.forEach((node) => {
        nodeAndClusterMap[node.id] = { id: node.id, type: NodeOrGroupType.NODE };
      });

      // Get unified RankData using visual ranking
      const { rankData: visualRankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'down', // Vertical layout
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // Verify the visual ranking produces expected results
      // Row 1 elements should have same rank (0)
      expect(visualRankData.rankedNodes['A1'].rank).toBe(0);
      expect(visualRankData.rankedNodes['A2'].rank).toBe(0);
      expect(visualRankData.rankedNodes['A3'].rank).toBe(0);

      // Row 2 elements should have same rank (1)
      expect(visualRankData.rankedNodes['B1'].rank).toBe(1);
      expect(visualRankData.rankedNodes['B2'].rank).toBe(1);
      expect(visualRankData.rankedNodes['B3'].rank).toBe(1);

      // Row 3 elements should have same rank (2)
      expect(visualRankData.rankedNodes['C1'].rank).toBe(2);
      expect(visualRankData.rankedNodes['C2'].rank).toBe(2);
      expect(visualRankData.rankedNodes['C3'].rank).toBe(2);

      // Now let's create connection-based RankData for comparison
      // For this test, we'll create a simple linear connection pattern: A1->A2->A3, B1->B2->B3, C1->C2->C3
      const entitiesById = Object.fromEntries(
        elkNodes.map((node) => [
          node.id,
          {
            id: node.id,
            x: node.x || 0,
            y: node.y || 0,
            width: node.width || 0,
            height: node.height || 0,
          },
        ]),
      );

      const connections = [
        // Row connections
        { from: 'A1', to: 'A2' },
        { from: 'A2', to: 'A3' },
        { from: 'B1', to: 'B2' },
        { from: 'B2', to: 'B3' },
        { from: 'C1', to: 'C2' },
        { from: 'C2', to: 'C3' },
        // Column connections (to create some cross-dependencies)
        { from: 'A1', to: 'B1' },
        { from: 'B1', to: 'C1' },
      ];

      const connectionRankData = buildRanks({
        entitiesById,
        containerMapping: {},
        parentMapping: {},
        connections,
      });

      // Visual ranking should create 3 ranks (one per row) for spatial grouping
      expect(visualRankData.ranks.length).toBe(3);
      expect(Object.keys(visualRankData.rankedNodes).length).toBe(9);

      // Connection ranking creates more ranks due to topological dependencies
      expect(connectionRankData.ranks.length).toBeGreaterThan(3);
      expect(Object.keys(connectionRankData.rankedNodes).length).toBe(9);

      // Check that all actual nodes are present in both
      const actualNodeIds = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'];
      for (const nodeId of actualNodeIds) {
        expect(visualRankData.rankedNodes[nodeId]).toBeDefined();
        expect(connectionRankData.rankedNodes[nodeId]).toBeDefined();
      }

      // Key comparison: Visual vs Connection ranking strategies

      // Visual ranking groups by spatial position (rows)
      // Row 1 elements (A1, A2, A3) have same rank
      const row1VisualRank = visualRankData.rankedNodes['A1'].rank;
      expect(visualRankData.rankedNodes['A2'].rank).toBe(row1VisualRank);
      expect(visualRankData.rankedNodes['A3'].rank).toBe(row1VisualRank);

      // Connection ranking groups by topological order
      // A1 -> A2 -> A3 should have increasing ranks
      const a1ConnectionRank = connectionRankData.rankedNodes['A1'].rank;
      const a2ConnectionRank = connectionRankData.rankedNodes['A2'].rank;
      const a3ConnectionRank = connectionRankData.rankedNodes['A3'].rank;
      expect(a2ConnectionRank).toBeGreaterThan(a1ConnectionRank);
      expect(a3ConnectionRank).toBeGreaterThan(a2ConnectionRank);

      // Visual ranking enables grid-style alignment (elements in same row align heights)
      // Connection ranking enables flow-style alignment (elements follow dependency order)

      // Both should start from rank 0
      expect(visualRankData.rankedNodes['A1'].rank).toBe(0);
      expect(connectionRankData.rankedNodes['A1'].rank).toBe(0);

      // Key insight: Both approaches are now unified under RankData
      // Visual ranking's spatial grouping is preserved in the unified structure

      // Test the equivalence that matters for alignment:
      // Elements that need to align together should be identifiable in both approaches

      // In visual ranking: same rank = same alignment group
      const visualRow1Elements = ['A1', 'A2', 'A3'];
      const visualRow1Rank = visualRankData.rankedNodes['A1'].rank;
      visualRow1Elements.forEach((id) => {
        expect(visualRankData.rankedNodes[id].rank).toBe(visualRow1Rank);
      });

      // In connection ranking: we can derive alignment groups from spatial analysis
      // (This is what the unified approach would do - use connection ranks but add spatial grouping)

      // The unified approach should preserve both:
      // 1. The topological ordering from connection ranking
      // 2. The spatial grouping capability from visual ranking

      // Additional comparisons for unified approach design:

      // 1. Alignment group identification capability
      // Visual ranking: Row elements naturally grouped by rank
      const visualRow2Elements = ['B1', 'B2', 'B3'];
      const visualRow2Rank = visualRankData.rankedNodes['B1'].rank;
      expect(visualRow2Rank).not.toBe(visualRow1Rank); // Different rows have different ranks
      visualRow2Elements.forEach((id) => {
        expect(visualRankData.rankedNodes[id].rank).toBe(visualRow2Rank);
      });

      // Connection ranking: Would need spatial analysis to identify same alignment groups
      // But the spatial information is preserved in the original node positions

      // 2. Information preservation test
      // Both approaches preserve all node information needed for alignment
      // Visual ranking includes virtual containers, so filter them out for comparison
      const visualActualNodes = Object.keys(visualRankData.rankedNodes).filter(
        (id) => !id.startsWith('rank-container-'),
      );
      expect(visualActualNodes).toHaveLength(9);
      expect(Object.keys(connectionRankData.rankedNodes)).toHaveLength(9);

      // 3. Compatibility test for shouldUseVisualRanking function
      // This function now works with unified RankData
      const shouldUseVisual = shouldUseVisualRanking(
        visualRankData,
        connectionRankData,
        3, // tolerance
      );
      // Should return boolean (either approach could be valid depending on tolerance)
      expect(typeof shouldUseVisual).toBe('boolean');

      // Visual ranking groups rows together, connection ranking separates by topology
      // Row elements should have same rank in visual approach
      expect(visualRankData.rankedNodes['A1'].rank).toBe(0);
      expect(visualRankData.rankedNodes['A2'].rank).toBe(0);
      expect(visualRankData.rankedNodes['A3'].rank).toBe(0);

      // Connection ranking will have different ranks due to A1->A2->A3 connections
      expect(connectionRankData.rankedNodes['A1'].rank).toBe(0);
      expect(connectionRankData.rankedNodes['A2'].rank).toBeGreaterThan(0);
      expect(connectionRankData.rankedNodes['A3'].rank).toBeGreaterThan(
        connectionRankData.rankedNodes['A2'].rank,
      );
    });

    it('should produce equivalent alignment results for horizontal layout', () => {
      // Create a horizontal layout (3 columns, 2 rows)
      const elkNodes: ElkNodeLike[] = [
        // Column 1
        { id: 'A1', x: 0, y: 0, width: 100, height: 50 },
        { id: 'A2', x: 0, y: 100, width: 100, height: 50 },
        // Column 2
        { id: 'B1', x: 150, y: 0, width: 100, height: 50 },
        { id: 'B2', x: 150, y: 100, width: 100, height: 50 },
        // Column 3
        { id: 'C1', x: 300, y: 0, width: 100, height: 50 },
        { id: 'C2', x: 300, y: 100, width: 100, height: 50 },
      ];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {};
      elkNodes.forEach((node) => {
        nodeAndClusterMap[node.id] = { id: node.id, type: NodeOrGroupType.NODE };
      });

      // Get unified RankData using visual ranking for horizontal layout
      const { rankData: visualRankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'right', // Horizontal layout
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // Column 1 elements should have same rank (0)
      expect(visualRankData.rankedNodes['A1'].rank).toBe(0);
      expect(visualRankData.rankedNodes['A2'].rank).toBe(0);

      // Column 2 elements should have same rank (1)
      expect(visualRankData.rankedNodes['B1'].rank).toBe(1);
      expect(visualRankData.rankedNodes['B2'].rank).toBe(1);

      // Column 3 elements should have same rank (2)
      expect(visualRankData.rankedNodes['C1'].rank).toBe(2);
      expect(visualRankData.rankedNodes['C2'].rank).toBe(2);

      // Create connection-based RankData for comparison
      const entitiesById = Object.fromEntries(
        elkNodes.map((node) => [
          node.id,
          {
            id: node.id,
            x: node.x || 0,
            y: node.y || 0,
            width: node.width || 0,
            height: node.height || 0,
          },
        ]),
      );

      const connections = [
        // Column connections
        { from: 'A1', to: 'A2' },
        { from: 'B1', to: 'B2' },
        { from: 'C1', to: 'C2' },
        // Row connections (to create cross-dependencies)
        { from: 'A1', to: 'B1' },
        { from: 'B1', to: 'C1' },
        { from: 'A2', to: 'B2' },
        { from: 'B2', to: 'C2' },
      ];

      const connectionRankData = buildRanks({
        entitiesById,
        containerMapping: {},
        parentMapping: {},
        connections,
      });

      // Compare the two approaches for horizontal layout
      // Visual ranking should create 3 ranks (one per column) for spatial grouping
      expect(visualRankData.ranks.length).toBe(3);

      // Connection ranking creates 4 ranks due to topological dependencies
      expect(connectionRankData.ranks.length).toBe(4);

      // Check that all actual nodes are present in both
      const actualNodeIds = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
      for (const nodeId of actualNodeIds) {
        expect(visualRankData.rankedNodes[nodeId]).toBeDefined();
        expect(connectionRankData.rankedNodes[nodeId]).toBeDefined();
      }

      // For horizontal layout, visual ranking groups by columns (x-position)
      // Columns should have same rank in visual approach
      expect(visualRankData.rankedNodes['A1'].rank).toBe(0); // Column 1
      expect(visualRankData.rankedNodes['A2'].rank).toBe(0); // Column 1
      expect(visualRankData.rankedNodes['B1'].rank).toBe(1); // Column 2
      expect(visualRankData.rankedNodes['B2'].rank).toBe(1); // Column 2
      expect(visualRankData.rankedNodes['C1'].rank).toBe(2); // Column 3
      expect(visualRankData.rankedNodes['C2'].rank).toBe(2); // Column 3

      // Interestingly, connection ranking produces similar primary grouping for this layout!
      expect(connectionRankData.rankedNodes['A1'].rank).toBe(0);
      expect(connectionRankData.rankedNodes['B1'].rank).toBe(1);
      expect(connectionRankData.rankedNodes['C1'].rank).toBe(2);

      // Both approaches enable proper alignment, but visual ranking is more spatially intuitive

      // Additional comparisons for horizontal layout:

      // 1. Column-based alignment groups (visual ranking strength)
      const visualCol1Elements = ['A1', 'A2'];
      const visualCol1Rank = visualRankData.rankedNodes['A1'].rank;
      visualCol1Elements.forEach((id) => {
        expect(visualRankData.rankedNodes[id].rank).toBe(visualCol1Rank);
      });

      // 2. Connection ranking preserves topological order
      // A1->B1->C1 chain should have increasing ranks
      expect(connectionRankData.rankedNodes['B1'].rank).toBeGreaterThan(
        connectionRankData.rankedNodes['A1'].rank,
      );
      expect(connectionRankData.rankedNodes['C1'].rank).toBeGreaterThan(
        connectionRankData.rankedNodes['B1'].rank,
      );

      // 3. Unified approach feasibility
      // Both preserve spatial relationships needed for alignment
      // Visual ranking includes virtual containers, so filter them out for comparison
      const visualActualNodes = Object.keys(visualRankData.rankedNodes).filter(
        (id) => !id.startsWith('rank-container-'),
      );
      expect(visualActualNodes).toHaveLength(6);
      expect(Object.keys(connectionRankData.rankedNodes)).toHaveLength(6);
    });
  });

  // ============================================================================
  // 3-Level Nesting Tests
  // ============================================================================

  describe('buildVisualRanksFromElk - nested hierarchies (3+ levels)', () => {
    it('should handle 3-level nesting with correct offset calculation', () => {
      // Create a 3-level hierarchy:
      // Root (0,0)
      //   └─ VPC (100, 100) - container at level 1
      //       └─ Subnet (50, 50) - container at level 2
      //           ├─ Node1 (10, 10) - absolute position should be (160, 160)
      //           └─ Node2 (10, 100) - absolute position should be (160, 250) - far enough apart

      const node1: ElkNodeLike = {
        id: 'Node1',
        x: 10,
        y: 10,
        width: 50,
        height: 30,
      };

      const node2: ElkNodeLike = {
        id: 'Node2',
        x: 10,
        y: 100, // Far enough from Node1 to be in different rank
        width: 50,
        height: 30,
      };

      const subnet: ElkNodeLike = {
        id: 'Subnet',
        x: 50,
        y: 50,
        width: 100,
        height: 150, // Taller to accommodate Node2
        children: [node1, node2],
      };

      const vpc: ElkNodeLike = {
        id: 'VPC',
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        children: [subnet],
      };

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        VPC: {
          id: 'VPC',
          type: NodeOrGroupType.GROUP,
          groups: [{ id: 'Subnet', type: NodeOrGroupType.GROUP }],
        },
        Subnet: {
          id: 'Subnet',
          type: NodeOrGroupType.GROUP,
          nodes: [
            { id: 'Node1', type: NodeOrGroupType.NODE },
            { id: 'Node2', type: NodeOrGroupType.NODE },
          ],
        },
        Node1: { id: 'Node1', type: NodeOrGroupType.NODE },
        Node2: { id: 'Node2', type: NodeOrGroupType.NODE },
      };

      const { rankData } = buildVisualRanksFromElk(
        [vpc],
        nodeAndClusterMap,
        'down', // Vertical layout
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // Verify all nodes are ranked
      expect(rankData.rankedNodes['VPC']).toBeDefined();
      expect(rankData.rankedNodes['Subnet']).toBeDefined();
      expect(rankData.rankedNodes['Node1']).toBeDefined();
      expect(rankData.rankedNodes['Node2']).toBeDefined();

      // Node1 and Node2 have different Y positions within Subnet
      // Node1 absolute Y: 100 + 50 + 10 = 160
      // Node2 absolute Y: 100 + 50 + 100 = 250
      // They should have different ranks within their parent container
      expect(rankData.rankedNodes['Node1'].rank).toBe(0);
      expect(rankData.rankedNodes['Node2'].rank).toBe(1);

      // Verify parent mapping is correct (immediate parent first, then ancestors)
      // Note: With virtual containers, nodes are children of secondary rank containers
      // The parent mapping will include virtual containers, so we check that the actual
      // parent container name appears somewhere in the parent ID
      const node1Parents = rankData.parentMapping['Node1'] || [];
      const node2Parents = rankData.parentMapping['Node2'] || [];
      const subnetParents = rankData.parentMapping['Subnet'] || [];

      // Node1 and Node2 should have a parent that references Subnet
      expect(node1Parents.some((p) => p.includes('Subnet'))).toBe(true);
      expect(node2Parents.some((p) => p.includes('Subnet'))).toBe(true);

      // Subnet should have a parent that references VPC
      expect(subnetParents.some((p) => p.includes('VPC'))).toBe(true);

      // VPC is at root level, but may be in a virtual container
      expect(rankData.parentMapping['VPC']).toBeDefined();
    });

    it('should handle mixed nesting depths in same diagram', () => {
      // Root
      //   ├─ TopLevelNode (y: 0) - at level 1
      //   └─ VPC (y: 0) - at level 1
      //       └─ Subnet (y: 0)
      //           └─ DeepNode (y: 0) - at level 3, absolute Y still 0

      const topLevelNode: ElkNodeLike = {
        id: 'TopLevelNode',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      };

      const deepNode: ElkNodeLike = {
        id: 'DeepNode',
        x: 0,
        y: 0,
        width: 50,
        height: 30,
      };

      const subnet: ElkNodeLike = {
        id: 'Subnet',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        children: [deepNode],
      };

      const vpc: ElkNodeLike = {
        id: 'VPC',
        x: 200,
        y: 0,
        width: 200,
        height: 100,
        children: [subnet],
      };

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        TopLevelNode: { id: 'TopLevelNode', type: NodeOrGroupType.NODE },
        VPC: {
          id: 'VPC',
          type: NodeOrGroupType.GROUP,
          groups: [{ id: 'Subnet', type: NodeOrGroupType.GROUP }],
        },
        Subnet: {
          id: 'Subnet',
          type: NodeOrGroupType.GROUP,
          nodes: [{ id: 'DeepNode', type: NodeOrGroupType.NODE }],
        },
        DeepNode: { id: 'DeepNode', type: NodeOrGroupType.NODE },
      };

      const { rankData } = buildVisualRanksFromElk(
        [topLevelNode, vpc],
        nodeAndClusterMap,
        'down',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // All nodes at same Y (0) should have same rank despite different nesting depths
      expect(rankData.rankedNodes['TopLevelNode'].rank).toBe(0);
      expect(rankData.rankedNodes['VPC'].rank).toBe(0);
      expect(rankData.rankedNodes['Subnet'].rank).toBe(0);
      expect(rankData.rankedNodes['DeepNode'].rank).toBe(0);

      // Verify parent mappings reflect different depths
      // Note: With virtual containers, parent mappings include virtual container IDs
      expect(rankData.parentMapping['TopLevelNode']).toBeDefined(); // In virtual container
      expect(rankData.parentMapping['VPC']).toBeDefined(); // In virtual container

      // Subnet should have a parent that references VPC
      const subnetParents = rankData.parentMapping['Subnet'] || [];
      expect(subnetParents.some((p) => p.includes('VPC'))).toBe(true);

      // DeepNode should have a parent that references Subnet
      const deepNodeParents = rankData.parentMapping['DeepNode'] || [];
      expect(deepNodeParents.some((p) => p.includes('Subnet'))).toBe(true);
    });

    it('should recursively rank children within nested containers', () => {
      // VPC contains 2x2 grid of subnets
      // Each subnet contains 2 nodes vertically arranged
      //
      // VPC (0, 0)
      //   ├─ Subnet1 (0, 0) - rank 0 within VPC
      //   │   ├─ Node1A (0, 0) - rank 0 within Subnet1
      //   │   └─ Node1B (0, 50) - rank 1 within Subnet1
      //   ├─ Subnet2 (150, 0) - rank 0 within VPC (same row as Subnet1)
      //   │   ├─ Node2A (0, 0) - rank 0 within Subnet2
      //   │   └─ Node2B (0, 50) - rank 1 within Subnet2
      //   ├─ Subnet3 (0, 150) - rank 1 within VPC
      //   │   ├─ Node3A (0, 0) - rank 0 within Subnet3
      //   │   └─ Node3B (0, 50) - rank 1 within Subnet3
      //   └─ Subnet4 (150, 150) - rank 1 within VPC (same row as Subnet3)
      //       ├─ Node4A (0, 0) - rank 0 within Subnet4
      //       └─ Node4B (0, 50) - rank 1 within Subnet4

      const createSubnet = (
        id: string,
        x: number,
        y: number,
        nodeAId: string,
        nodeBId: string,
      ): ElkNodeLike => ({
        id,
        x,
        y,
        width: 100,
        height: 120,
        children: [
          { id: nodeAId, x: 0, y: 0, width: 80, height: 40 },
          { id: nodeBId, x: 0, y: 50, width: 80, height: 40 },
        ],
      });

      const vpc: ElkNodeLike = {
        id: 'VPC',
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        children: [
          createSubnet('Subnet1', 0, 0, 'Node1A', 'Node1B'),
          createSubnet('Subnet2', 150, 0, 'Node2A', 'Node2B'),
          createSubnet('Subnet3', 0, 150, 'Node3A', 'Node3B'),
          createSubnet('Subnet4', 150, 150, 'Node4A', 'Node4B'),
        ],
      };

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        VPC: {
          id: 'VPC',
          type: NodeOrGroupType.GROUP,
          groups: [
            { id: 'Subnet1', type: NodeOrGroupType.GROUP },
            { id: 'Subnet2', type: NodeOrGroupType.GROUP },
            { id: 'Subnet3', type: NodeOrGroupType.GROUP },
            { id: 'Subnet4', type: NodeOrGroupType.GROUP },
          ],
        },
        Subnet1: {
          id: 'Subnet1',
          type: NodeOrGroupType.GROUP,
          nodes: [
            { id: 'Node1A', type: NodeOrGroupType.NODE },
            { id: 'Node1B', type: NodeOrGroupType.NODE },
          ],
        },
        Subnet2: {
          id: 'Subnet2',
          type: NodeOrGroupType.GROUP,
          nodes: [
            { id: 'Node2A', type: NodeOrGroupType.NODE },
            { id: 'Node2B', type: NodeOrGroupType.NODE },
          ],
        },
        Subnet3: {
          id: 'Subnet3',
          type: NodeOrGroupType.GROUP,
          nodes: [
            { id: 'Node3A', type: NodeOrGroupType.NODE },
            { id: 'Node3B', type: NodeOrGroupType.NODE },
          ],
        },
        Subnet4: {
          id: 'Subnet4',
          type: NodeOrGroupType.GROUP,
          nodes: [
            { id: 'Node4A', type: NodeOrGroupType.NODE },
            { id: 'Node4B', type: NodeOrGroupType.NODE },
          ],
        },
        Node1A: { id: 'Node1A', type: NodeOrGroupType.NODE },
        Node1B: { id: 'Node1B', type: NodeOrGroupType.NODE },
        Node2A: { id: 'Node2A', type: NodeOrGroupType.NODE },
        Node2B: { id: 'Node2B', type: NodeOrGroupType.NODE },
        Node3A: { id: 'Node3A', type: NodeOrGroupType.NODE },
        Node3B: { id: 'Node3B', type: NodeOrGroupType.NODE },
        Node4A: { id: 'Node4A', type: NodeOrGroupType.NODE },
        Node4B: { id: 'Node4B', type: NodeOrGroupType.NODE },
      };

      const { rankData } = buildVisualRanksFromElk(
        [vpc],
        nodeAndClusterMap,
        'down',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // Verify subnets are ranked correctly within VPC (2 rows)
      expect(rankData.rankedNodes['Subnet1'].rank).toBe(0); // Row 1
      expect(rankData.rankedNodes['Subnet2'].rank).toBe(0); // Row 1 (same Y as Subnet1)
      expect(rankData.rankedNodes['Subnet3'].rank).toBe(1); // Row 2
      expect(rankData.rankedNodes['Subnet4'].rank).toBe(1); // Row 2 (same Y as Subnet3)

      // Verify nodes are ranked correctly within each subnet
      // All A nodes at Y=0 within their subnet
      expect(rankData.rankedNodes['Node1A'].rank).toBe(0);
      expect(rankData.rankedNodes['Node2A'].rank).toBe(0);
      expect(rankData.rankedNodes['Node3A'].rank).toBe(0);
      expect(rankData.rankedNodes['Node4A'].rank).toBe(0);

      // All B nodes at Y=50 within their subnet
      expect(rankData.rankedNodes['Node1B'].rank).toBe(1);
      expect(rankData.rankedNodes['Node2B'].rank).toBe(1);
      expect(rankData.rankedNodes['Node3B'].rank).toBe(1);
      expect(rankData.rankedNodes['Node4B'].rank).toBe(1);

      // Verify all nodes are present (excluding virtual containers)
      const actualNodes = Object.keys(rankData.rankedNodes).filter(
        (id) => !id.startsWith('rank-container-'),
      );
      expect(actualNodes).toHaveLength(13); // VPC + 4 subnets + 8 nodes
    });
  });

  // ============================================================================
  // Edge Cases and Error Conditions
  // ============================================================================

  describe('buildVisualRanksFromElk - edge cases', () => {
    it('should handle empty node arrays gracefully', () => {
      const { rankData } = buildVisualRanksFromElk(
        [],
        {},
        'down',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      expect(rankData.rankedNodes).toEqual({});
      expect(rankData.ranks).toEqual([]);
      expect(rankData.globalRanks).toEqual([]);
      expect(rankData.parentMapping).toEqual({});
      expect(rankData.containerMapping).toEqual({});
      expect(rankData.isVisualRanking).toBe(true);
    });

    it('should handle single node', () => {
      const elkNodes: ElkNodeLike[] = [{ id: 'A', x: 0, y: 0, width: 100, height: 50 }];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        A: { id: 'A', type: NodeOrGroupType.NODE },
      };

      const { rankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'down',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      expect(rankData.ranks.length).toBe(1);
      expect(rankData.rankedNodes['A']).toBeDefined();
      expect(rankData.rankedNodes['A'].rank).toBe(0);
      // Filter out virtual containers
      const actualNodes = Object.keys(rankData.rankedNodes).filter(
        (id) => !id.startsWith('rank-container-'),
      );
      expect(actualNodes).toHaveLength(1);
    });

    it('should handle container with no children in containerMapping', () => {
      const elkNodes: ElkNodeLike[] = [
        {
          id: 'EmptyContainer',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          children: [], // Empty children array
        },
      ];

      const nodeAndClusterMap: Record<string, NodeOrGroup> = {
        EmptyContainer: { id: 'EmptyContainer', type: NodeOrGroupType.GROUP },
        // No nodes or groups defined for EmptyContainer
      };

      const { rankData } = buildVisualRanksFromElk(
        elkNodes,
        nodeAndClusterMap,
        'down',
        OVERLAP_THRESHOLD,
        BOUNDARY_MULTIPLIER,
      );

      // Should handle empty container gracefully
      expect(rankData.rankedNodes['EmptyContainer']).toBeDefined();
      expect(rankData.rankedNodes['EmptyContainer'].rank).toBe(0);
    });
  });
});
