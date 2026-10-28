import { addToSet } from '../setUtils.js';
import { PriorityQueue } from '../PriorityQueue.js';
import { LayoutManager } from '../LayoutManager.js';
import { LayoutEntity, LayoutRange, ContainerMapping, ParentMapping, Direction } from '../types.js';
import { getDimensions } from '../sizeUtils.js';

interface WithId {
  id: string;
}

interface BaseEdge {
  id?: string;
  from: string;
  to: string;
}

export interface RankedNode {
  id: string;
  /** The final rank of the entity relative to its parent. */
  rank: number;
  /**
   * The overall global rank of this entity
   */
  globalRank: number;
  /**
   * For nested entities, the ranks of the parent entities, from root to container.
   * Attach the rank property to get the full hierarchy.
   */
  rankHierarchy?: number[] | undefined;
  /** Any actual connection, stored all the way up the hierarchy */
  in: Set<string>;
  /** Connections that go to higher ranks */
  out: Set<string>;
  /** For containers, the ranks of the child entities */
  childRanks?: Rank[] | undefined;
}

export interface Rank {
  nodes: RankedNode[];
  /**
   * Just the other nodes at this level that we attach to
   */
  in: string[];
  /**
   * Just the other nodes at this level that we attach from
   */
  out: string[];
  /**
   * The ranks of the nodes that we attach to
   */
  inRanks: number[];
  /**
   * The ranks of the nodes that we attach from
   */
  outRanks: number[];
}

export interface RankData {
  /** @see buildRankedNodesAtLevel */
  ranks: Rank[];
  /** @see buildGlobalRanks */
  globalRanks: Rank[];
  /**
   * Single object that includes all top-level and nested nodes
   */
  rankedNodes: Record<string, RankedNode>;
  /**
   * We add this because the rank data can incorporate proposed changes not yet present in layoutManager
   */
  parentMapping: ParentMapping;
  /**
   * We add this because the rank data can incorporate proposed changes not yet present in layoutManager
   */
  containerMapping: ContainerMapping;
  /**
   * Indicates whether this RankData was created from visual (spatial) ranking
   * rather than connection-based ranking
   */
  isVisualRanking?: boolean;
}

type ConnectionData = [string, string];
type ConnectionDataWithParent = [string, string, string | undefined, string | undefined];

export interface RankingDataStructures<T extends WithId> {
  entitiesById: Record<string, T>;
  containerMapping: ContainerMapping;
  parentMapping: ParentMapping;
  connections: BaseEdge[];
  scoreProperty?: keyof T;
  rankScorer?: (entity: T) => number;
}

/**
 * Core ranking function that works with layout manager data structures
 * @see https://app.eraser.io/workspace/Az2BVJACgJQHvi1IKfHA
 */
export function buildRanks<T extends WithId = LayoutEntity>({
  entitiesById,
  containerMapping,
  parentMapping,
  connections,
  scoreProperty,
  rankScorer,
}: RankingDataStructures<T>): RankData {
  // Initialize the nodes and data structures
  const rankedNodes: Record<string, RankedNode> = {};
  const connectionsByContainer: Record<string, ConnectionData[]> = {};
  const flatConnections: ConnectionDataWithParent[] = [];
  const topLevelConnections: ConnectionData[] = [];
  const topLevelEntities: T[] = [];
  const topLevelEntityIds: Set<string> = new Set();

  for (const entity of Object.values(entitiesById)) {
    rankedNodes[entity.id] = {
      id: entity.id,
      rank: 0,
      globalRank: Infinity,
      in: new Set(),
      out: new Set(),
      rankHierarchy: undefined,
      childRanks: undefined,
    };

    if (!parentMapping[entity.id]?.length) {
      topLevelEntityIds.add(entity.id);
      topLevelEntities.push(entity);
    }

    if (containerMapping[entity.id]?.size) {
      connectionsByContainer[entity.id] = [];
    }
  }

  for (const connection of connections) {
    const { from, to } = connection;

    // Skip self-connections, they do not help us make ranks
    if (from === to) {
      continue;
    }

    const fromRanked = rankedNodes[from];
    const toRanked = rankedNodes[to];

    if (!fromRanked || !toRanked) {
      warnForMissingEndpointEntity(connection, 'from', rankedNodes);
      warnForMissingEndpointEntity(connection, 'to', rankedNodes);
      continue;
    }

    /**
     * @note This just assumes that from / to should determine rank
     * We can do another pass at this if we want to use the rankScorer to do that
     */
    fromRanked.out.add(to);
    toRanked.in.add(from);

    const fromParents = parentMapping[from] ?? [];
    const toParents = parentMapping[to] ?? [];

    let commonAncestor: string | undefined;

    let highestLevelFrom = from;
    let highestLevelTo = to;

    for (const parent of fromParents) {
      if (toParents.includes(parent)) {
        commonAncestor = parent;
        break;
      }

      highestLevelFrom = parent;
      rankedNodes[parent].out.add(to);
    }

    for (const parent of toParents) {
      if (parent === commonAncestor) {
        break;
      }

      highestLevelTo = parent;
      rankedNodes[parent].in.add(from);
    }

    if (commonAncestor) {
      connectionsByContainer[commonAncestor].push([highestLevelFrom, highestLevelTo]);
    } else {
      topLevelConnections.push([highestLevelFrom, highestLevelTo]);
    }

    flatConnections.push([
      from,
      to,
      from === highestLevelFrom ? undefined : highestLevelFrom,
      to === highestLevelTo ? undefined : highestLevelTo,
    ]);
  }

  const topLevelRanks = buildRankedNodesAtLevel<T>(
    topLevelEntityIds,
    entitiesById,
    rankedNodes,
    undefined,
    topLevelConnections,
    connectionsByContainer,
    containerMapping,
    rankScorer,
    scoreProperty,
  );

  const globalRanks = buildGlobalRanks<T>(
    rankedNodes,
    entitiesById,
    flatConnections,
    containerMapping,
    parentMapping,
    rankScorer,
    scoreProperty,
  );

  return {
    rankedNodes,
    ranks: topLevelRanks,
    globalRanks,
    parentMapping,
    containerMapping,
  };
}

function warnForMissingEndpointEntity(
  connection: BaseEdge,
  endpoint: 'from' | 'to',
  rankedNodes: Record<string, RankedNode>,
) {
  const entityId = connection[endpoint];
  if (!entityId || rankedNodes[entityId]) {
    return;
  }

  const connectionId = connection.id ? ` "${connection.id}"` : '';
  console.warn(
    `[buildRanks] Dropping connection${connectionId}: ${endpoint} endpoint "${entityId}" does not match any entity`,
  );
}

function buildRankedNodesAtLevel<T extends WithId>(
  entityIds: Set<string>,
  entitiesById: Record<string, T>,
  rankedNodes: Record<string, RankedNode>,
  parentHierarchy: number[] | undefined,
  connectionsAtLevel: ConnectionData[],
  connectionsByLevel: Record<string, ConnectionData[]>,
  containerMapping: ContainerMapping,
  rankScorer?: (entity: T) => number,
  scoreProperty?: keyof T,
): Rank[] {
  const cycles = buildCycles(connectionsAtLevel);
  const { inDegrees, ins, outs } = buildInsAndOuts(
    connectionsAtLevel,
    entitiesById,
    cycles,
    rankScorer,
    scoreProperty,
  );

  const pq = new PriorityQueue<string>();

  for (const id of entityIds) {
    const inCount = inDegrees[id] ?? 0;

    if (inCount <= 0) {
      pq.push(id, 0);
    }
  }

  let currentRank = 0;
  let maxRank = 0;

  while (!pq.isEmpty()) {
    const levelSize = pq.getSize();

    for (let i = 0; i < levelSize; i++) {
      const id = pq.pop()!;
      const rankedNode = rankedNodes[id];

      rankedNode.rank = currentRank;
      maxRank = currentRank;
      rankedNode.rankHierarchy = parentHierarchy;

      /**
       * @note Very important here to use outs, not rankedNode.out
       * outs is limited to the connections in this container level and is used to create the ranks
       * rankedNode.out is the full set of connections pointing to the actual terminal
       * */
      for (const outId of outs[id] ?? []) {
        // If the out node is in this container and level and has no more connections, add it to the queue
        if (entitiesById[outId] && --inDegrees[outId] <= 0) {
          pq.push(outId, currentRank + 1);
        }
      }
    }

    currentRank++;
  }

  const ranks: Rank[] = Array.from({ length: maxRank + 1 }, () => {
    return {
      nodes: [],
      in: [],
      out: [],
      inRanks: [],
      outRanks: [],
    };
  });

  for (const id of entityIds) {
    const rankedNode = rankedNodes[id];
    const rank = ranks[rankedNode.rank];

    rank.nodes.push(rankedNode);

    // For local ranks, we dont care if it is a roll-up or not
    // If it is, the target is inside of a childRank, not inside of this rank
    // so the information is useful to know about here
    if (ins[id]) {
      for (const inId of ins[id]) {
        rank.in.push(inId);
        rank.inRanks.push(rankedNodes[inId].rank);
      }
    }

    if (outs[id]) {
      for (const outId of outs[id]) {
        rank.out.push(outId);
        rank.outRanks.push(rankedNodes[outId].rank);
      }
    }

    const children = containerMapping[id];
    if (children) {
      const localParentHierarchy = [...(rankedNode.rankHierarchy ?? []), rankedNode.rank];

      const childRanks = buildRankedNodesAtLevel(
        children,
        entitiesById,
        rankedNodes,
        localParentHierarchy,
        connectionsByLevel[id],
        connectionsByLevel,
        containerMapping,
        rankScorer,
        scoreProperty,
      );

      rankedNode.childRanks = childRanks;
    }
  }

  return ranks;
}

/**
 * Tarjan's algorithm for finding cycles in a graph.
 * Accepts simplified [from, to] connections.
 * Returns a list of every cycle represented by a set of nodes.
 * Optional: can include only some nodes, which is useful when handling nested cycle edge cases
 */
function buildCycles(
  connections: ConnectionData[] | ConnectionDataWithParent[],
  includeOnly?: Set<string>,
): Set<string>[] {
  const cycles: Set<string>[] = [];

  if (!connections?.length) {
    return cycles;
  }

  // Build the adjacency list
  const adjacencyList: Record<string, string[]> = {};
  for (const [from, to] of connections) {
    if (includeOnly && !includeOnly.has(to)) {
      continue;
    }

    adjacencyList[from] ??= [];
    adjacencyList[from].push(to);
    // Make sure that we have an entry for the to node also so it is visited in the dfs
    adjacencyList[to] ??= [];
  }

  // Set up all the data structures
  const indexMap: Record<string, number> = {};
  const lowLinkMap: Record<string, number> = {};
  const stack: string[] = [];
  let index = 0;

  // Define the recursive dfs function
  function dfs(node: string) {
    index++;
    indexMap[node] = index;
    lowLinkMap[node] = index;
    stack.push(node);

    // Explore all the neighbors
    for (const neighbor of adjacencyList[node] ?? []) {
      if (!indexMap[neighbor]) {
        dfs(neighbor);
        lowLinkMap[node] = Math.min(lowLinkMap[node], lowLinkMap[neighbor]);
      } else if (stack.includes(neighbor)) {
        lowLinkMap[node] = Math.min(lowLinkMap[node], indexMap[neighbor]);
      }
    }

    // If we've found a cycle
    if (indexMap[node] === lowLinkMap[node]) {
      const cycle: Set<string> = new Set([node]);
      let current = stack.pop();
      while (current && current !== node) {
        cycle.add(current);
        current = stack.pop();
      }

      if (cycle.size > 1) {
        cycles.push(cycle);
      }
    }
  }

  // Run the dfs
  for (const node of Object.keys(adjacencyList)) {
    if (!indexMap[node]) {
      dfs(node);
    }
  }

  return cycles;
}

function buildInsAndOuts<T extends WithId>(
  connections: ConnectionData[],
  entitiesById: Record<string, T>,
  cycles: Set<string>[],
  scorer?: (entity: T) => number,
  scoreProperty?: keyof T,
) {
  const winners = determineCycleWinners(cycles, connections, entitiesById, scorer, scoreProperty);

  const inDegrees: Record<string, number> = {};
  const ins: Record<string, string[]> = {};
  const outs: Record<string, string[]> = {};

  if (!connections?.length) {
    return { inDegrees, ins, outs };
  }

  for (const [from, to] of connections) {
    // Ignore self-connections and cycle connections that go to a winner
    if (winners[to]?.has(from) || from === to) {
      continue;
    }

    ins[to] ??= [];
    ins[to].push(from);
    inDegrees[to] ??= 0;
    inDegrees[to]++;

    outs[from] ??= [];
    outs[from].push(to);
  }

  return { inDegrees, ins, outs };
}

/**
 * Unlike the simpler ins and outs, this one also adds the roll-up connections
 * We do this here because it is important to first break the cycles,
 * otherwise we end up with the true cycle connection being ignored but the roll-up still used for ranks
 */
function buildGlobalInsAndOuts<T extends WithId>(
  connections: ConnectionDataWithParent[],
  entitiesById: Record<string, T>,
  cycles: Set<string>[],
  parentMapping: ParentMapping,
  scorer?: (entity: T) => number,
  scoreProperty?: keyof T,
) {
  const winners = determineCycleWinners(cycles, connections, entitiesById, scorer, scoreProperty);

  // We just need basic ins, but we want to also track rolled-up outs for the priority queue
  const ins: Record<string, string[]> = {};
  const outs: Record<string, string[]> = {};
  const rollUpOuts: Record<string, string[]> = {};
  // In degrees is just one for all connections, we just use this for the priority queue
  const inDegrees: Record<string, number> = {};

  for (const [from, to, _highestFrom, highestTo] of connections) {
    if (winners[to]?.has(from)) {
      continue;
    }

    ins[to] ??= [];
    ins[to].push(from);
    inDegrees[to] ??= 0;
    inDegrees[to]++;
    outs[from] ??= [];
    outs[from].push(to);

    if (highestTo) {
      const toParents = parentMapping[to];

      for (let i = 0; i < toParents.length; i++) {
        const parent = toParents[i];

        rollUpOuts[from] ??= [];
        rollUpOuts[from].push(parent);

        if (parent === highestTo) {
          break;
        }
      }
    }
  }

  return { inDegrees, ins, outs, rollUpOuts };
}

/**
 * @see https://app.eraser.io/workspace/Fiezz1h3RUOSImc5k7qQ#iufHni_bEcw7oUMHtzuu0
 */
function determineCycleWinners<T extends WithId>(
  cycles: Set<string>[],
  allConnections: ConnectionData[] | ConnectionDataWithParent[],
  entitiesById: Record<string, T>,
  scorer?: (entity: T) => number,
  scoreProperty?: keyof T,
) {
  /**
   * Map of "winner" -> full set of nodes that were part of the cycle the
   * winner breaks. Used later to ignore edges inbound to that winner.
   */
  const winners: Record<string, Set<string>> = {};

  /**
   * Helper that picks the lowest-scored node inside a cycle according to the
   * provided scorer/scoreProperty.
   */
  function pickWinner(cycle: Set<string>): string {
    let minScore = Infinity;
    let best: string | undefined;

    for (const node of cycle) {
      const score = scoreProperty
        ? (entitiesById[node][scoreProperty] as number)
        : (scorer?.(entitiesById[node]) ?? 0);

      if (!best || score < minScore) {
        best = node;
        minScore = score;
      }
    }

    return best!;
  }

  for (const cycle of cycles) {
    const winner = pickWinner(cycle);
    cycle.delete(winner);

    if (winners[winner]) {
      addToSet(winners[winner], cycle);
    } else {
      winners[winner] = cycle;
    }

    /**
     * Detect parallel or nested cycles
     * @see https://app.eraser.io/workspace/Fiezz1h3RUOSImc5k7qQ#liilrcc0FW0FQqBM-Z9cl
     * */
    const moreCycles = buildCycles(allConnections, cycle);
    cycles.push(...moreCycles);
  }

  return winners;
}

/**
 * Get all entity IDs for a range of ranks
 */
export function getEntityIdsForRanks(
  rankData: RankData,
  start: number,
  end = rankData.ranks.length - 1,
): Set<string> {
  const entityIds = new Set<string>();
  const clampedEnd = Math.min(end, rankData.ranks.length - 1);

  function add(id: string) {
    entityIds.add(id);

    if (rankData.containerMapping[id]) {
      for (const child of rankData.containerMapping[id]) {
        add(child);
      }
    }
  }

  // Get all entities from startRank to endRank (inclusive)
  for (let i = start; i <= clampedEnd; i++) {
    for (const node of rankData.ranks[i].nodes) {
      add(node.id);
    }
  }

  return entityIds;
}

export function calculateRankMetrics(
  layoutManager: LayoutManager,
  rankData: RankData,
): LayoutRange[] {
  return rankData.ranks.map((rank) => {
    const entities = layoutManager.getEntitiesById(rank.nodes.map((e) => e.id));
    return getDimensions(entities);
  });
}

/**
 * Size estimate for aspect ratio calculation.
 * Uses unit counts (not pixels) for simpler estimation.
 */
interface SizeEstimate {
  width: number;
  height: number;
}

/**
 * Recursively estimates the size of a node/group.
 * - Leaf node = nodeSize x nodeSize
 * - Group = largest rank width x total rank height + spacing
 *
 * @param nodeId - The ID of the node/group to measure
 * @param rankData - The rank data structure
 * @param direction - Layout direction ('down', 'up', 'right', 'left')
 * @param nodeSize - Size of a single node in pixels
 * @param nodeSpacing - Spacing between nodes in pixels
 * @returns Size estimate in pixels
 */
function estimateGroupSize(
  nodeId: string,
  rankData: RankData,
  direction: Direction = 'down',
  nodeSize = 50,
  nodeSpacing = 40,
): SizeEstimate {
  const rankedNode = rankData.rankedNodes[nodeId];
  const childRanks = rankedNode?.childRanks;

  // Leaf node = nodeSize x nodeSize
  if (!childRanks?.length) {
    return { width: nodeSize, height: nodeSize };
  }

  const isVertical = direction === 'down' || direction === 'up';

  // Count total children across all ranks
  let totalChildren = 0;
  for (const rank of childRanks) {
    totalChildren += rank.nodes.length;
  }

  // For more than 2 children, assume a grid-like arrangement
  // instead of stacking them all vertically in ranks
  if (totalChildren > 2) {
    // Arrange in a roughly square grid
    const gridDim = Math.ceil(Math.sqrt(totalChildren));
    const gridWidth = gridDim * nodeSize + Math.max(0, gridDim - 1) * nodeSpacing;
    const gridHeight = gridDim * nodeSize + Math.max(0, gridDim - 1) * nodeSpacing;

    const groupOffset = nodeSpacing;
    return {
      width: gridWidth + groupOffset,
      height: gridHeight + groupOffset,
    };
  }

  // For 1-2 children, use the original rank-based layout
  let largestRankSize = 0;
  let totalRankDepth = 0;

  for (const rank of childRanks) {
    let rankSize = 0;
    let maxChildDepth = 0;

    for (let i = 0; i < rank.nodes.length; i++) {
      const node = rank.nodes[i];
      const child = estimateGroupSize(node.id, rankData, direction, nodeSize, nodeSpacing);
      // Primary axis: sum children in rank (side-by-side) with spacing
      rankSize += isVertical ? child.width : child.height;
      if (i > 0) {
        rankSize += nodeSpacing;
      }
      // Secondary axis: take max child depth
      maxChildDepth = Math.max(maxChildDepth, isVertical ? child.height : child.width);
    }

    largestRankSize = Math.max(largestRankSize, rankSize);
    totalRankDepth += maxChildDepth;
    if (totalRankDepth > 0 && childRanks.indexOf(rank) > 0) {
      totalRankDepth += nodeSpacing;
    }
  }

  // Add offset for group chrome
  const groupOffset = nodeSpacing;
  if (isVertical) {
    return { width: largestRankSize + groupOffset, height: totalRankDepth + groupOffset };
  } else {
    return { width: totalRankDepth + groupOffset, height: largestRankSize + groupOffset };
  }
}

/**
 * Metric for evaluating layout balance based on rank widths.
 * Used to decide whether removing unjustified edges improves layout.
 */
export interface RankWidthMetric {
  /** The width of the widest rank (most nodes in one rank) */
  widestRankWidth: number;
  /** Sum of all node widths across all ranks */
  totalWidth: number;
  /**
   * Ratio of widestRankWidth / totalWidth.
   * - High ratio (close to 1): Most nodes in one rank → tall/narrow layout
   * - Low ratio: Nodes spread across ranks → wide/balanced layout
   */
  ratio: number;
  /** Estimated height based on number of ranks */
  estimatedHeight: number;
  /**
   * Aspect ratio (width / height).
   * - Closer to 1.0 (1:1 square) is considered more balanced
   */
  aspectRatio: number;
  /**
   * Distance from the ideal 1:1 aspect ratio.
   * Lower is better.
   */
  distanceFromIdeal: number;
  /** Number of ranks used for calculation (for debugging) */
  ranksUsed?: number;
}

/**
 * Calculates a metric for evaluating layout balance based on rank widths.
 * This metric helps decide whether removing unjustified edges improves the layout.
 *
 * Uses recursive size estimation to account for nested groups:
 * - Groups determine the overall layout shape
 * - Leaf nodes inside groups don't affect top-level aspect ratio
 *
 * @param rankData - The rank data structure
 * @param direction - Layout direction (default: 'down')
 * @param config - Config with NODE_SIZE and NODE_SPACING
 * @returns RankWidthMetric with widestRankWidth, totalWidth, and ratio
 */
export function calculateRankWidthMetric(
  rankData: RankData,
  direction: Direction = 'down',
  config: { NODE_SIZE: number; NODE_SPACING: number } = { NODE_SIZE: 50, NODE_SPACING: 40 },
): RankWidthMetric {
  const { NODE_SIZE, NODE_SPACING } = config;
  const isVertical = direction === 'down' || direction === 'up';

  // Check if we have any nested groups
  const hasNestedGroups = Object.values(rankData.rankedNodes).some(
    (node) => node.childRanks && node.childRanks.length > 0,
  );

  let totalWidth: number;
  let maxHeight: number;

  if (hasNestedGroups) {
    // Use recursive size estimation for nested structures
    // Calculate size at each top-level rank and combine
    let widestRankSize = 0;
    let totalRankDepth = 0;

    for (const rank of rankData.ranks) {
      let rankWidth = 0;
      let maxRankHeight = 0;

      for (let i = 0; i < rank.nodes.length; i++) {
        const node = rank.nodes[i];
        const size = estimateGroupSize(node.id, rankData, direction, NODE_SIZE, NODE_SPACING);
        rankWidth += isVertical ? size.width : size.height;
        if (i > 0) {
          rankWidth += NODE_SPACING;
        }
        maxRankHeight = Math.max(maxRankHeight, isVertical ? size.height : size.width);
      }

      widestRankSize = Math.max(widestRankSize, rankWidth);
      if (totalRankDepth > 0) {
        totalRankDepth += NODE_SPACING;
      }
      totalRankDepth += maxRankHeight;
    }

    if (isVertical) {
      totalWidth = widestRankSize;
      maxHeight = totalRankDepth;
    } else {
      totalWidth = totalRankDepth;
      maxHeight = widestRankSize;
    }
  } else {
    // Flat diagram: use rank-based calculation
    let widestRankSize = 0;
    let totalNodeSize = 0;

    for (const rank of rankData.ranks) {
      const nodeCount = rank.nodes.length;
      // Primary axis (width for vertical, height for horizontal)
      const rankSize = nodeCount * NODE_SIZE + Math.max(0, nodeCount - 1) * NODE_SPACING;
      widestRankSize = Math.max(widestRankSize, rankSize);
      totalNodeSize += nodeCount * NODE_SIZE;
    }

    // Secondary axis (height for vertical, width for horizontal)
    const numRanks = rankData.ranks.length;
    const rankDepth = numRanks * NODE_SIZE + Math.max(0, numRanks - 1) * NODE_SPACING;

    if (isVertical) {
      totalWidth = widestRankSize;
      maxHeight = rankDepth;
    } else {
      totalWidth = rankDepth;
      maxHeight = widestRankSize;
    }
  }

  // Calculate aspect ratio (width / height)
  const aspectRatio = maxHeight > 0 ? totalWidth / maxHeight : 0;

  // Distance from ideal 1:1 ratio (square)
  const TARGET_RATIO = 1;
  const distanceFromIdeal = Math.abs(aspectRatio - TARGET_RATIO);

  return {
    widestRankWidth: totalWidth,
    totalWidth,
    ratio: maxHeight > 0 ? totalWidth / maxHeight : 0,
    estimatedHeight: maxHeight,
    aspectRatio,
    distanceFromIdeal,
    ranksUsed: rankData.ranks.length,
  };
}

/**
 * @see buildRanks.spec.ts for some tests that describe intended behavior
 */
function buildGlobalRanks<T extends WithId>(
  rankedNodes: Record<string, RankedNode>,
  entitiesById: Record<string, T>,
  flatConnections: ConnectionDataWithParent[],
  containerMapping: ContainerMapping,
  parentMapping: ParentMapping,
  rankScorer?: (entity: T) => number,
  scoreProperty?: keyof T,
): Rank[] {
  const cycles = buildCycles(flatConnections);
  // Build the ins and outs that also add the roll-up connections
  const { inDegrees, ins, outs, rollUpOuts } = buildGlobalInsAndOuts(
    flatConnections,
    entitiesById,
    cycles,
    parentMapping,
    rankScorer,
    scoreProperty,
  );

  // Topological pass to assign initial global ranks to connected nodes
  const pq = new PriorityQueue<string>();

  for (const id of Object.keys(rankedNodes)) {
    const inCount = inDegrees[id] ?? 0;
    if (inCount <= 0) {
      pq.push(id, 0);
    }
  }

  let currentRank = 0;
  let maxGlobalRank = 0;

  while (!pq.isEmpty()) {
    const levelSize = pq.getSize();

    for (let i = 0; i < levelSize; i++) {
      const id = pq.pop()!;
      const node = rankedNodes[id];
      node.globalRank = currentRank;
      maxGlobalRank = Math.max(maxGlobalRank, currentRank);

      for (const outId of outs[id] ?? []) {
        if (--inDegrees[outId] <= 0) {
          pq.push(outId, currentRank + 1);
        }
      }
    }

    currentRank++;
  }

  // Build the final globalRanks array (flat)
  const globalRanks: Rank[] = Array.from({ length: maxGlobalRank + 1 }, () => {
    return {
      nodes: [],
      in: [],
      out: [],
      inRanks: [],
      outRanks: [],
    };
  });

  // Now apply the roll-up connections to groups to bump their global rank up
  for (const [id, out] of Object.entries(rollUpOuts)) {
    const minGlobalRank = rankedNodes[id].globalRank + 1;

    for (const outId of out) {
      // Ignore relationships from node to parent or itself
      if (id === outId) {
        continue;
      }
      const currentRank = rankedNodes[outId].globalRank;
      rankedNodes[outId].globalRank = Math.max(currentRank, minGlobalRank);
    }
  }

  for (const id in rankedNodes) {
    const node = rankedNodes[id];
    const rankBucket = globalRanks[node.globalRank];

    if (!rankBucket) {
      console.warn('No global rank bucket found for node', id, node.globalRank);
      continue;
    }

    rankBucket.nodes.push(node);

    // For global ranks, we only care about the true connections when building the ins / outs
    // This is because the true connection target is always present in the rank itself
    for (const inId of ins[id] ?? []) {
      rankBucket.in.push(inId);
      rankBucket.inRanks.push(rankedNodes[inId].globalRank);
    }

    for (const out of outs[id] ?? []) {
      rankBucket.out.push(out);
      rankBucket.outRanks.push(rankedNodes[out].globalRank);
    }
  }

  return globalRanks;
}

/**
 * Helper to see which is before using the regular ranks (globalRanks is trivial)
 * Returns -1 if A is before B, 1 if A is after B, 0 if they are the same
 * Climbs down the hierarchy to find the first difference
 * @param rankedNodeA
 * @param rankedNodeB
 * @returns
 */
export function determineRelativeRanks(rankedNodeA: RankedNode, rankedNodeB: RankedNode): number {
  const firstLevelA = rankedNodeA.rankHierarchy?.[0] ?? rankedNodeA.rank;
  const firstLevelB = rankedNodeB.rankHierarchy?.[0] ?? rankedNodeB.rank;

  if (firstLevelA !== firstLevelB) {
    return Math.sign(firstLevelA - firstLevelB);
  }

  const fullArrA = rankedNodeA.rankHierarchy
    ? [...rankedNodeA.rankHierarchy, rankedNodeA.rank]
    : [rankedNodeA.rank];
  const fullArrB = rankedNodeB.rankHierarchy
    ? [...rankedNodeB.rankHierarchy, rankedNodeB.rank]
    : [rankedNodeB.rank];

  for (let i = 0; i < fullArrA.length; i++) {
    // B is a parent of A
    if (fullArrB[i] === undefined) {
      return 0;
    }

    if (fullArrA[i] !== fullArrB[i]) {
      return Math.sign(fullArrA[i] - fullArrB[i]);
    }
  }

  return 0;
}
