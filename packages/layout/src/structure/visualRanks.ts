import { getDimensions } from '../sizeUtils.js';
import { isHorizontal, legacyDirectionToDirection } from '../directionUtils.js';
import { LayoutManager } from '../LayoutManager.js';
import { LayoutEntity, PositionProps } from '../types.js';
import { RankData, RankedNode, Rank } from './ranks.js';
import type { Direction } from '../types.js';

/**
 * Visual ranking - ranks nodes based on spatial position rather than connections
 *
 * Primary/Secondary ranks depend on diagram direction:
 * - LEFT/RIGHT direction: primaryRank = x-position (horizontal), secondaryRank = y-position (vertical)
 * - UP/DOWN direction: primaryRank = y-position (vertical), secondaryRank = x-position (horizontal)
 */

/**
 * Linked list node for spatial ordering
 */
class RankNode {
  nodeIds: string[];
  representativePosition: number; // x for horizontal, y for vertical
  next: RankNode | null;

  constructor(nodeIds: string[], representativePosition: number) {
    this.nodeIds = nodeIds;
    this.representativePosition = representativePosition;
    this.next = null;
  }
}

/**
 * Linked list for building ranks in spatial order
 */
class VisualRankList {
  head: RankNode | null = null;

  /**
   * Insert a new rank in the correct position based on spatial position
   */
  insert(nodeIds: string[], representativePosition: number) {
    const newNode = new RankNode(nodeIds, representativePosition);

    // Empty list
    if (!this.head) {
      this.head = newNode;
      return;
    }

    // Insert before head
    if (representativePosition < this.head.representativePosition) {
      newNode.next = this.head;
      this.head = newNode;
      return;
    }

    // Find insertion point
    let current = this.head;
    while (current.next && current.next.representativePosition < representativePosition) {
      current = current.next;
    }

    // Insert after current
    newNode.next = current.next;
    current.next = newNode;
  }

  /**
   * Return structured data with rank groups
   * Numbers the ranks sequentially in a single pass at the end
   */
  toStructuredRanks(): {
    rankGroups: Array<{ rank: number; nodeIds: string[]; representativePosition: number }>;
  } {
    const rankGroups: Array<{
      rank: number;
      nodeIds: string[];
      representativePosition: number;
    }> = [];

    let current = this.head;
    let rank = 0;

    while (current) {
      rankGroups.push({
        rank,
        nodeIds: current.nodeIds,
        representativePosition: current.representativePosition,
      });

      current = current.next;
      rank++;
    }

    return { rankGroups };
  }
}

/**
 * Build horizontal ranks (columns) by grouping nodes based on x-position overlap
 *
 * Algorithm:
 * 1. Find the widest unprocessed node
 * 2. Create a boundary ±1.5x its width from its midpoint
 * 3. Find all nodes with 30% overlap within this boundary
 * 4. Insert this group into the linked list in correct spatial order (by leftmost x)
 * 5. Repeat until all nodes are processed
 * 6. Number ranks sequentially at the end
 */
function buildHorizontalRanks(
  nodes: LayoutEntity[],
  overlapThreshold: number,
  boundaryMultiplier: number,
): VisualRankList {
  const unprocessed = new Set(nodes.map((n) => n.id));
  const rankList = new VisualRankList();

  while (unprocessed.size > 0) {
    // Find the widest unprocessed node
    const unprocessedNodes = nodes.filter((n) => unprocessed.has(n.id));
    const widestNode = unprocessedNodes.reduce((max, node) =>
      node.width > max.width ? node : max,
    );

    // Create boundary based on widest node's x-position
    const midpoint = widestNode.x + widestNode.width / 2;
    const boundaryWidth = widestNode.width * boundaryMultiplier;
    const leftBoundary = midpoint - boundaryWidth;
    const rightBoundary = midpoint + boundaryWidth;

    // Find all unprocessed nodes with sufficient overlap in this X-range
    const nodesInThisRank: string[] = [];
    let minX = Infinity;

    for (const node of unprocessedNodes) {
      const nodeLeft = node.x;
      const nodeRight = node.x + node.width;

      // Calculate overlap with boundary
      const overlapStart = Math.max(nodeLeft, leftBoundary);
      const overlapEnd = Math.min(nodeRight, rightBoundary);
      const overlap = Math.max(0, overlapEnd - overlapStart);

      // Check if overlap is >= 30% of node's width
      if (overlap >= node.width * overlapThreshold) {
        nodesInThisRank.push(node.id);
        minX = Math.min(minX, node.x);
        unprocessed.delete(node.id);
      }
    }

    // Insert this rank in the correct spatial position (by leftmost x)
    rankList.insert(nodesInThisRank, minX);
  }

  return rankList;
}

/**
 * Build vertical ranks (rows) by grouping nodes based on y-position overlap
 * Same algorithm as horizontal but using y-position and height
 */
function buildVerticalRanks(
  nodes: LayoutEntity[],
  overlapThreshold: number,
  boundaryMultiplier: number,
): VisualRankList {
  const unprocessed = new Set(nodes.map((n) => n.id));
  const rankList = new VisualRankList();

  while (unprocessed.size > 0) {
    // Find the tallest unprocessed node
    const unprocessedNodes = nodes.filter((n) => unprocessed.has(n.id));
    const tallestNode = unprocessedNodes.reduce((max, node) =>
      node.height > max.height ? node : max,
    );

    // Create boundary based on tallest node's y-position
    const midpoint = tallestNode.y + tallestNode.height / 2;
    const boundaryHeight = tallestNode.height * boundaryMultiplier;
    const topBoundary = midpoint - boundaryHeight;
    const bottomBoundary = midpoint + boundaryHeight;

    // Find all unprocessed nodes with sufficient overlap in this Y-range
    const nodesInThisRank: string[] = [];
    let minY = Infinity;

    for (const node of unprocessedNodes) {
      const nodeTop = node.y;
      const nodeBottom = node.y + node.height;

      // Calculate overlap with boundary
      const overlapStart = Math.max(nodeTop, topBoundary);
      const overlapEnd = Math.min(nodeBottom, bottomBoundary);
      const overlap = Math.max(0, overlapEnd - overlapStart);

      // Check if overlap is >= 30% of node's height
      if (overlap >= node.height * overlapThreshold) {
        nodesInThisRank.push(node.id);
        minY = Math.min(minY, node.y);
        unprocessed.delete(node.id);
      }
    }

    // Insert this rank in the correct spatial position (by topmost y)
    rankList.insert(nodesInThisRank, minY);
  }

  return rankList;
}
// TODO 1 fix mapping of containers for parents to no longer have actual nodes as children when bounding box was created
/**
 * Build visual ranks recursively for nodes at a given level
 * Mirrors buildRankedNodesAtLevel from ranks.ts
 *
 * @param nodes - Nodes at this container level with their positions
 * @param containerMapping - Map of container ID to children IDs
 * @param allNodesById - All nodes including nested ones (for recursive processing)
 * @param direction - Diagram direction to determine primary/secondary ranking
 * @param parentContainerId - ID of the parent container (undefined for root level)
 * @returns RankData with virtual rank containers and bounding boxes
 */
function buildVisualRanksRecursive(
  rankData: RankData,
  layoutManager: LayoutManager,
  overlapThreshold: number,
  boundaryMultiplier: number,
  parentContainerId?: string,
  parentRankHierarchy?: number[],
): void {
  // Get the nodes at this level
  const nodes = parentContainerId
    ? layoutManager.getChildEntities(parentContainerId)
    : layoutManager.getEntities().filter((n) => !n.containerId);

  // Called with a leaf node or empty container
  if (!nodes?.length) {
    return;
  }

  // Determine which dimension is primary based on direction
  const isHorizontalPrimary = isHorizontal(layoutManager.primaryDirection);

  // Step 1: Build primary ranks for nodes at this level
  const primaryRankList = isHorizontalPrimary
    ? buildHorizontalRanks(nodes, overlapThreshold, boundaryMultiplier)
    : buildVerticalRanks(nodes, overlapThreshold, boundaryMultiplier);
  const { rankGroups: primaryGroups } = primaryRankList.toStructuredRanks();

  const parentRankedNode = parentContainerId ? rankData.rankedNodes[parentContainerId] : undefined;

  if (parentRankedNode && !parentRankedNode.childRanks) {
    parentRankedNode.childRanks = [];
  }
  const ranksForThisLevel: Rank[] = parentRankedNode
    ? parentRankedNode.childRanks!
    : rankData.ranks;

  for (const primaryGroup of primaryGroups) {
    const nodesInPrimaryRank = nodes.filter((n) => primaryGroup.nodeIds.includes(n.id));

    // Build secondary ranks within this primary rank
    const secondaryRankList = isHorizontalPrimary
      ? buildVerticalRanks(nodesInPrimaryRank, overlapThreshold, boundaryMultiplier)
      : buildHorizontalRanks(nodesInPrimaryRank, overlapThreshold, boundaryMultiplier);
    const { rankGroups: secondaryGroups } = secondaryRankList.toStructuredRanks();

    const primaryRank: Rank = {
      nodes: [],
      in: [],
      out: [],
      inRanks: [],
      outRanks: [],
    };

    const newHierarchy = parentRankHierarchy
      ? [...parentRankHierarchy, primaryGroup.rank]
      : [primaryGroup.rank];

    for (const secondaryGroup of secondaryGroups) {
      // Only create a wrapper container if there are multiple nodes
      const needsContainer = secondaryGroup.nodeIds.length > 1;

      // This is the hard case - we need to create a wrapper and recurse
      if (needsContainer) {
        // Wrapper id is e.g. "node1 | node2 | node3"
        const secondaryContainerId = secondaryGroup.nodeIds.join(' | ');

        // Skip wrapper creation if we're already inside a wrapper (parentContainerId contains |)
        // We don't want to create nested wrappers - instead process children individually
        if (parentContainerId?.includes(' | ')) {
          // Process each child individually
          for (const nodeId of secondaryGroup.nodeIds) {
            const rankedNode: RankedNode = {
              id: nodeId,
              rank: primaryGroup.rank,
              globalRank: Infinity,
              in: new Set(),
              out: new Set(),
              rankHierarchy: newHierarchy,
            };
            rankData.rankedNodes[nodeId] = rankedNode;
            primaryRank.nodes.push(rankedNode);

            // Recurse into this node if it's a container
            const entity = layoutManager.getEntityById(nodeId);
            if (entity?.isContainer) {
              buildVisualRanksRecursive(
                rankData,
                layoutManager,
                overlapThreshold,
                boundaryMultiplier,
                nodeId,
                newHierarchy,
              );
            }
          }
          continue;
        }

        const bounds = calculateBoundingBox(secondaryGroup.nodeIds, layoutManager);

        // Layout manager stuff - create new entity, make sure to update all the parentage
        const newEntity: LayoutEntity = {
          id: secondaryContainerId,
          ...bounds,
          containerId: parentContainerId,
          isContainer: true,
        };

        layoutManager.addEntity(newEntity);
        layoutManager.updateMany(secondaryGroup.nodeIds, {
          containerId: secondaryContainerId,
        });

        // Rank data stuff - create new ranked node and push it onto the parent's nodes
        const rankedNode: RankedNode = {
          id: secondaryContainerId,
          rank: primaryGroup.rank,
          rankHierarchy: parentRankHierarchy,
          globalRank: Infinity,
          in: new Set(),
          out: new Set(),
        };

        primaryRank.nodes.push(rankedNode);
        rankData.rankedNodes[secondaryContainerId] = rankedNode;

        // Recurse into each child container individually, not into the wrapper
        // The wrapper is artificial - we should recurse into the actual containers
        const childEntities = layoutManager.getChildEntities(secondaryContainerId);
        for (const child of childEntities) {
          if (child.isContainer) {
            buildVisualRanksRecursive(
              rankData,
              layoutManager,
              overlapThreshold,
              boundaryMultiplier,
              child.id,
              newHierarchy,
            );
          }
        }
        continue;
      }

      // Simple case - there's only one node id. We just add that to the rank.
      const [nodeId] = secondaryGroup.nodeIds;
      const rankedNode: RankedNode = {
        id: nodeId,
        rank: primaryGroup.rank,
        globalRank: Infinity,
        in: new Set(),
        out: new Set(),
        rankHierarchy: parentRankHierarchy,
      };
      rankData.rankedNodes[nodeId] = rankedNode;
      primaryRank.nodes.push(rankedNode);

      // Recurse to check for children (will return early if none exist)
      buildVisualRanksRecursive(
        rankData,
        layoutManager,
        overlapThreshold,
        boundaryMultiplier,
        nodeId,
        newHierarchy,
      );
    }

    ranksForThisLevel.push(primaryRank);
  }
}

// Helper function to calculate bounding box from nodes
const calculateBoundingBox = (nodeIds: string[], layoutManager: LayoutManager): PositionProps => {
  const nodePositions = layoutManager.getEntitiesById(nodeIds);
  const dims = getDimensions(nodePositions);

  return {
    x: dims.minX,
    y: dims.minY,
    width: dims.maxX - dims.minX,
    height: dims.maxY - dims.minY,
  };
};

/**
 * Compare visual ranks with connection-based ranks to determine if visual ranking should be used
 *
 * @param visualRankData - Visual RankData from buildVisualRanksFromElk
 * @param connectionRankData - Connection-based RankData from buildRanks
 * @param tolerance - Maximum allowed difference in rank (default: 1)
 * @returns true if visual ranking is close enough to connection-based ranking
 */
export function shouldUseVisualRanking(
  visualRankData: RankData,
  connectionRankData: RankData | undefined,
  tolerance = 1,
): boolean {
  if (!connectionRankData) {
    // No connection-based ranking available, use visual ranking
    return true;
  }

  // Compare ranks between visual and connection-based RankData
  for (const [nodeId, visualNode] of Object.entries(visualRankData.rankedNodes)) {
    const connectionNode = connectionRankData.rankedNodes[nodeId];
    if (!connectionNode) {
      // Node exists in visual ranking but not in connection ranking
      // This shouldn't happen, but if it does, fall back to connection ranking
      return false;
    }

    // Compare ranks
    const difference = Math.abs(visualNode.rank - connectionNode.rank);
    if (difference > tolerance) {
      return false;
    }
  }

  return true;
}

/**
 * Helper type for ElkNode (minimal interface needed for visual ranking)
 * This avoids importing elkjs in the shared package
 */
export interface ElkNodeLike {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNodeLike[];
}

/**
 * Helper type for node/group entities
 * Note: CAD diagrams use 'cluster' terminology internally in the parser,
 * but transform to 'group' in the parse() function before reaching this code.
 */
export interface NodeOrGroup {
  id: string;
  type: NodeOrGroupType;
  nodes?: NodeOrGroup[];
  groups?: NodeOrGroup[];
}

/** Node or group discriminator, as string values so callers can pass their own enum members. */
export const NodeOrGroupType = { NODE: 'node', GROUP: 'group' } as const;
export type NodeOrGroupType = (typeof NodeOrGroupType)[keyof typeof NodeOrGroupType];

/**
 * Build visual ranks from ElkNode tree using spatial (position-based) ranking
 * Returns unified RankData structure with isVisualRanking flag set to true
 *
 * @param elkNodes - Array of ElkNode (typically directChildren from postProcessCadGraph)
 * @param nodeAndGroupMap - Map of all nodes and groups in the diagram
 * @param direction - Diagram direction to determine primary/secondary ranking
 * @param relationships - Optional array of relationships to populate in/out connections
 * @param parentContainerId - Optional parent container ID for recursive calls
 * @returns RankData with isVisualRanking flag set to true
 */
export function buildVisualRanksFromElk(
  elkNodes: ElkNodeLike[],
  nodeAndGroupMap: Record<string, NodeOrGroup>,
  direction: Direction | string,
  overlapThreshold: number,
  boundaryMultiplier: number,
): { rankData: RankData; layoutManager: LayoutManager } {
  const entities: LayoutEntity[] = [];

  function traverse(node: ElkNodeLike, containerId?: string | undefined, parentX = 0, parentY = 0) {
    const diagramItem = nodeAndGroupMap[node.id];

    // If node not in map and doesn't look like an ELK wrapper, warn about it
    if (!diagramItem && !node.id.match(/\|/)) {
      console.warn(`Diagram item not found for node ${node.id}`);
      return;
    }

    // Calculate absolute position by adding parent's position
    const absoluteX = parentX + (node.x || 0);
    const absoluteY = parentY + (node.y || 0);

    if (!diagramItem) {
      // This is probably an ELK-created layout group (e.g. for boxing/grouping)
      // We should still traverse its children, but not add it as an entity
      if (node.children) {
        for (const child of node.children) {
          // Use the same containerId, not node.id, since we're skipping this wrapper
          // Pass the accumulated absolute position
          traverse(child, containerId, absoluteX, absoluteY);
        }
      }
      return;
    }

    if (diagramItem.id === '|MAIN|') {
      return;
    }

    entities.push({
      id: node.id,
      x: absoluteX,
      y: absoluteY,
      width: node.width || 0,
      height: node.height || 0,
      isContainer: diagramItem.type === NodeOrGroupType.GROUP,
      containerId,
    });

    if (node.children) {
      for (const child of node.children) {
        traverse(child, node.id, absoluteX, absoluteY);
      }
    }
  }

  for (const elkNode of elkNodes) {
    traverse(elkNode);
  }

  const layoutManager = new LayoutManager({
    entities,
    connections: [],
    primaryDirection: legacyDirectionToDirection(direction),
  });

  const rankData = buildVisualRanksFromLayoutManager(
    layoutManager,
    overlapThreshold,
    boundaryMultiplier,
  );

  return { rankData, layoutManager };
}

export function buildVisualRanksFromLayoutManager(
  layoutManager: LayoutManager,
  overlapThreshold: number,
  boundaryMultiplier: number,
): RankData {
  const rankData: RankData = {
    ranks: [],
    globalRanks: [],
    rankedNodes: {},
    // These will be populated after the recursive process
    parentMapping: {},
    containerMapping: {},
    isVisualRanking: true,
  };

  buildVisualRanksRecursive(
    rankData,
    layoutManager,
    overlapThreshold,
    boundaryMultiplier,
    undefined,
  );

  // Get the final mappings after all containers have been created
  rankData.parentMapping = layoutManager.getParentMapping();
  rankData.containerMapping = layoutManager.getContainerMapping();

  return rankData;
}
