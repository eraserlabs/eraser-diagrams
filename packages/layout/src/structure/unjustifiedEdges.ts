import { buildRanks, RankData } from './ranks.js';
import { ParentMapping } from '../types.js';

// =============================================================================
// Types
// =============================================================================

interface BaseEdge {
  from: string;
  to: string;
}

interface LevelConnection {
  from: string;
  to: string;
  sourceAtLevel: string;
  targetAtLevel: string;
}

// =============================================================================
// Parent/Container Utilities
// =============================================================================

/**
 * Gets the representative node for a given node at a specific container level.
 * If the node is nested inside containers, returns the outermost container
 * that is a direct child of the specified container.
 *
 * @param nodeId - The node to find the representative for
 * @param containerId - The container level (null for top-level)
 * @param parentMapping - Maps nodes to their parent hierarchy
 * @returns The representative node ID at the specified level
 */
function getRepresentativeAtLevel(
  nodeId: string,
  containerId: string | null,
  parentMapping: ParentMapping,
): string {
  // Parents are ordered [innermost, ..., outermost]
  const parents = parentMapping[nodeId] ?? [];

  if (parents.length === 0) {
    return nodeId;
  }

  if (containerId === null) {
    // At diagram level, return outermost parent (last in array)
    return parents[parents.length - 1];
  }

  const containerIndex = parents.indexOf(containerId);

  // Container not in parent chain - node represents itself at this level
  if (containerIndex === -1) {
    return nodeId;
  }

  // Return the element before containerId (one step closer to the node)
  // If containerIndex is 0, the node is a direct child of the container
  if (containerIndex === 0) {
    return nodeId;
  }

  return parents[containerIndex - 1];
}

/**
 * Determines which container level a connection belongs to.
 * Returns the lowest common ancestor of both endpoints.
 *
 * @param edge - The connection to analyze
 * @param parentMapping - Maps nodes to their parent hierarchy
 * @returns Container ID or null for top-level
 */
function getConnectionLevel(edge: BaseEdge, parentMapping: ParentMapping): string | null {
  const fromParents = parentMapping[edge.from] ?? [];
  const toParents = parentMapping[edge.to] ?? [];

  // If either endpoint is at top level, connection is at top level
  if (fromParents.length === 0 || toParents.length === 0) {
    return null;
  }

  // Find outermost common ancestor
  for (const parent of fromParents) {
    if (toParents.includes(parent)) {
      return parent;
    }
  }

  return null;
}

/**
 * Checks if a node is a container (has children).
 */
function isContainer(nodeId: string, containerMapping: Record<string, Set<string>>): boolean {
  return containerMapping[nodeId]?.size > 0;
}

/**
 * Gets all top-level entity IDs (nodes with no parents).
 */
function getTopLevelEntities(
  rankedNodes: Record<string, unknown>,
  parentMapping: ParentMapping,
): Set<string> {
  const topLevel = new Set<string>();

  for (const id of Object.keys(rankedNodes)) {
    const parents = parentMapping[id];
    if (!parents || parents.length === 0) {
      topLevel.add(id);
    }
  }

  return topLevel;
}

// =============================================================================
// Connection Grouping
// =============================================================================

/**
 * Groups connections by their container level.
 */
function groupConnectionsByLevel(
  connections: BaseEdge[],
  parentMapping: ParentMapping,
): Map<string | null, BaseEdge[]> {
  const byLevel = new Map<string | null, BaseEdge[]>();

  for (const conn of connections) {
    const level = getConnectionLevel(conn, parentMapping);
    if (!byLevel.has(level)) {
      byLevel.set(level, []);
    }
    byLevel.get(level)!.push(conn);
  }

  return byLevel;
}

/**
 * Maps connections to their level representatives.
 * Filters out self-connections at this level.
 */
function mapConnectionsToLevel(
  connections: BaseEdge[],
  containerId: string | null,
  parentMapping: ParentMapping,
): LevelConnection[] {
  const result: LevelConnection[] = [];

  for (const conn of connections) {
    const sourceAtLevel = getRepresentativeAtLevel(conn.from, containerId, parentMapping);
    const targetAtLevel = getRepresentativeAtLevel(conn.to, containerId, parentMapping);

    // Skip self-connections at this level
    if (sourceAtLevel === targetAtLevel) {
      continue;
    }

    result.push({
      from: conn.from,
      to: conn.to,
      sourceAtLevel,
      targetAtLevel,
    });
  }

  return result;
}

/**
 * Groups level connections by their target.
 */
function groupByTarget(
  levelConnections: LevelConnection[],
  excludeEdges: Set<string>,
): Record<string, LevelConnection[]> {
  const byTarget: Record<string, LevelConnection[]> = {};

  for (const conn of levelConnections) {
    const edgeKey = `${conn.from}->${conn.to}`;
    if (excludeEdges.has(edgeKey)) {
      continue;
    }

    byTarget[conn.targetAtLevel] ??= [];
    byTarget[conn.targetAtLevel].push(conn);
  }

  return byTarget;
}

// =============================================================================
// Chain Detection
// =============================================================================

/**
 * Builds incoming edge map for nodes, using targetAtLevel for grouping.
 */
function buildIncomingEdgeMap(connections: LevelConnection[]): Map<string, LevelConnection[]> {
  const incoming = new Map<string, LevelConnection[]>();

  for (const conn of connections) {
    if (!incoming.has(conn.targetAtLevel)) {
      incoming.set(conn.targetAtLevel, []);
    }
    incoming.get(conn.targetAtLevel)!.push(conn);
  }

  return incoming;
}

/**
 * Builds outgoing edge map for nodes, using sourceAtLevel for grouping.
 * Maps each effective source to the set of effective targets it connects to.
 */
function buildOutgoingEdgeMap(connections: LevelConnection[]): Map<string, Set<string>> {
  const outgoing = new Map<string, Set<string>>();

  for (const conn of connections) {
    if (!outgoing.has(conn.sourceAtLevel)) {
      outgoing.set(conn.sourceAtLevel, new Set());
    }
    outgoing.get(conn.sourceAtLevel)!.add(conn.targetAtLevel);
  }

  return outgoing;
}

/**
 * Traces backwards through a chain of non-container nodes.
 * A chain is a sequence of nodes with the same parent, connected sequentially.
 *
 * @returns Set of edge keys that are part of the chain
 */
function traceChainBackwards(
  startNode: string,
  expectedRank: number,
  parentId: string | null,
  incomingEdges: Map<string, LevelConnection[]>,
  entitiesAtLevel: Set<string>,
  rankData: RankData,
  visited: Set<string>,
): Set<string> {
  const chainEdges = new Set<string>();

  if (visited.has(startNode)) {
    return chainEdges;
  }
  visited.add(startNode);

  const incoming = incomingEdges.get(startNode);
  if (!incoming) {
    return chainEdges;
  }

  for (const edge of incoming) {
    const sourceNode = edge.sourceAtLevel;

    // Must be at this level
    if (!entitiesAtLevel.has(sourceNode)) {
      continue;
    }

    // Must not be a container
    if (isContainer(sourceNode, rankData.containerMapping)) {
      continue;
    }

    // Must be at expected rank
    const sourceRank = rankData.rankedNodes[sourceNode]?.rank ?? 0;
    if (sourceRank !== expectedRank) {
      continue;
    }

    // Must share the same parent
    const sourceParents = rankData.parentMapping[sourceNode];
    const sourceParent = sourceParents?.[0] ?? null;
    if (sourceParent !== parentId) {
      continue;
    }

    // This edge is part of the chain (use original from->to for edge key)
    chainEdges.add(`${edge.from}->${edge.to}`);

    // Continue tracing backwards
    const upstream = traceChainBackwards(
      sourceNode,
      sourceRank - 1,
      parentId,
      incomingEdges,
      entitiesAtLevel,
      rankData,
      visited,
    );

    for (const key of upstream) {
      chainEdges.add(key);
    }
  }

  return chainEdges;
}

/**
 * Identifies edges that are part of node chains leading to target groups.
 * These edges should be protected from removal.
 */
function findChainEdges(
  rankData: RankData,
  levelConnections: LevelConnection[],
  entitiesAtLevel: Set<string>,
  targetGroups: Set<string>,
): Set<string> {
  const protectedEdges = new Set<string>();
  const incomingEdges = buildIncomingEdgeMap(levelConnections);

  for (const targetGroup of targetGroups) {
    const targetRank = rankData.rankedNodes[targetGroup]?.rank ?? 0;
    const chainRank = targetRank - 1;

    const edgesToGroup = incomingEdges.get(targetGroup);
    if (!edgesToGroup) {
      continue;
    }

    for (const edge of edgesToGroup) {
      const sourceNode = edge.sourceAtLevel;

      // Skip containers
      if (isContainer(sourceNode, rankData.containerMapping)) {
        continue;
      }

      // Must be at this level
      if (!entitiesAtLevel.has(sourceNode)) {
        continue;
      }

      // Must be at chain rank
      const sourceRank = rankData.rankedNodes[sourceNode]?.rank ?? 0;
      if (sourceRank !== chainRank) {
        continue;
      }

      // Get source's parent
      const sourceParents = rankData.parentMapping[sourceNode];
      const sourceParent = sourceParents?.[sourceParents.length - 1] ?? null;

      // Trace backwards to find chain and collect chain nodes
      const visited = new Set<string>();
      const chainEdges = traceChainBackwards(
        sourceNode,
        sourceRank - 1,
        sourceParent,
        incomingEdges,
        entitiesAtLevel,
        rankData,
        visited,
      );

      // Only protect if this is part of a multi-node chain (use original from->to for edge key)
      if (chainEdges.size > 0) {
        protectedEdges.add(`${edge.from}->${edge.to}`);
        for (const key of chainEdges) {
          protectedEdges.add(key);
        }
      }
    }
  }

  return protectedEdges;
}

// =============================================================================
// Unjustified Edge Detection
// =============================================================================

/**
 * Evaluates connections to a target group and identifies unjustified edges.
 *
 * An edge is unjustified if:
 * 1. Target is a container
 * 2. Target rank >= 1
 * 3. Exactly one connection from rank N-1
 * 4. At least one connection from rank < N-1
 * 5. The source has more than one destination
 */
function findUnjustifiedEdge(
  targetId: string,
  connections: LevelConnection[],
  rankedNodes: Record<string, { rank: number }>,
  containerMapping: Record<string, Set<string>>,
  protectedEdges: Set<string>,
  outgoingEdges: Map<string, Set<string>>,
): { edgeKey: string; sourceAtLevel: string; targetAtLevel: string } | null {
  // Must be a container
  if (!isContainer(targetId, containerMapping)) {
    return null;
  }

  const targetRank = rankedNodes[targetId]?.rank ?? 0;

  // Must be at rank >= 1
  if (targetRank < 1) {
    return null;
  }

  // Categorize connections by source rank
  const fromPrevRank: LevelConnection[] = [];
  let hasEarlierConnection = false;

  for (const conn of connections) {
    const sourceRank = rankedNodes[conn.sourceAtLevel]?.rank ?? 0;
    if (sourceRank === targetRank - 1) {
      fromPrevRank.push(conn);
    } else if (sourceRank < targetRank - 1) {
      hasEarlierConnection = true;
    }
  }

  // Must have exactly one from N-1 and at least one from earlier
  if (fromPrevRank.length !== 1 || !hasEarlierConnection) {
    return null;
  }

  const candidate = fromPrevRank[0];
  const edgeKey = `${candidate.from}->${candidate.to}`;

  // Don't remove if it's part of a chain
  if (protectedEdges.has(edgeKey)) {
    return null;
  }

  // Don't remove if the source only has one destination
  const sourceDestinations = outgoingEdges.get(candidate.sourceAtLevel);
  if (!sourceDestinations || sourceDestinations.size <= 1) {
    return null;
  }

  return {
    edgeKey,
    sourceAtLevel: candidate.sourceAtLevel,
    targetAtLevel: candidate.targetAtLevel,
  };
}

/**
 * Processes a single container level to find unjustified edges.
 */
function processContainerLevel(
  containerId: string | null,
  entitiesAtLevel: Set<string>,
  rankData: RankData,
  connectionsByLevel: Map<string | null, BaseEdge[]>,
  unjustifiedEdges: Set<string>,
): void {
  const connections = connectionsByLevel.get(containerId) ?? [];

  // Map connections to level representatives (computed once)
  const levelConnections = mapConnectionsToLevel(connections, containerId, rankData.parentMapping);

  // Group by target
  const byTarget = groupByTarget(levelConnections, unjustifiedEdges);

  // Find target groups (containers)
  const targetGroups = new Set<string>();
  for (const targetId of Object.keys(byTarget)) {
    if (isContainer(targetId, rankData.containerMapping)) {
      targetGroups.add(targetId);
    }
  }

  // Find protected chain edges
  const protectedEdges = findChainEdges(rankData, levelConnections, entitiesAtLevel, targetGroups);

  // Build outgoing edges map (source -> set of targets)
  const outgoingEdges = buildOutgoingEdgeMap(levelConnections);

  // Evaluate each target group
  for (const [targetId, targetConnections] of Object.entries(byTarget)) {
    const result = findUnjustifiedEdge(
      targetId,
      targetConnections,
      rankData.rankedNodes,
      rankData.containerMapping,
      protectedEdges,
      outgoingEdges,
    );
    if (result) {
      unjustifiedEdges.add(result.edgeKey);
      // Update the outgoing edges map so subsequent checks see the reduced count
      const sourceDestinations = outgoingEdges.get(result.sourceAtLevel);
      if (sourceDestinations) {
        sourceDestinations.delete(result.targetAtLevel);
      }
    }
  }

  // Process nested containers
  for (const entityId of entitiesAtLevel) {
    const children = rankData.containerMapping[entityId];
    if (children?.size > 0) {
      processContainerLevel(entityId, children, rankData, connectionsByLevel, unjustifiedEdges);
    }
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Identifies unjustified edges in a ranked graph.
 *
 * An edge from rank N-1 to rank N is unjustified when:
 * 1. Target is a container (group), not a leaf node
 * 2. Target rank N >= 1
 * 3. Exactly one incoming edge from N-1
 * 4. At least one incoming edge from rank < N-1
 * 5. Edge is not part of a sequential node chain
 *
 * @param rankData - Rank data from buildRanks()
 * @param connections - Array of edges (bidirectional edges should be expanded)
 * @returns Set of edge keys ("from->to") that are unjustified
 */
export function identifyUnjustifiedEdges(rankData: RankData, connections: BaseEdge[]): Set<string> {
  const unjustifiedEdges = new Set<string>();

  const connectionsByLevel = groupConnectionsByLevel(connections, rankData.parentMapping);
  const topLevelEntities = getTopLevelEntities(rankData.rankedNodes, rankData.parentMapping);

  processContainerLevel(null, topLevelEntities, rankData, connectionsByLevel, unjustifiedEdges);

  return unjustifiedEdges;
}

/**
 * Rebuilds rank data with a filtered set of connections.
 * Used to simulate layout with certain edges removed.
 *
 * @param rankData - Original rank data
 * @param connections - Filtered connections
 * @returns New RankData based on filtered connections
 */
export function rebuildRanksWithConnections(rankData: RankData, connections: BaseEdge[]): RankData {
  const entitiesById: Record<string, { id: string }> = {};

  for (const id of Object.keys(rankData.rankedNodes)) {
    entitiesById[id] = { id };
  }

  return buildRanks({
    entitiesById,
    containerMapping: rankData.containerMapping,
    parentMapping: rankData.parentMapping,
    connections,
  });
}
