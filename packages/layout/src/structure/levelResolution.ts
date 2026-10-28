import type { ParentMapping } from '../types.js';

export interface BaseEdge {
  id?: string;
  from: string;
  to: string;
}

export function getRepresentativeAtLevel(
  nodeId: string,
  containerId: string | null,
  parentMapping: ParentMapping,
): string {
  const parents = parentMapping[nodeId] ?? [];

  if (parents.length === 0) {
    return nodeId;
  }

  if (containerId === null) {
    return parents[parents.length - 1];
  }

  const containerIndex = parents.indexOf(containerId);

  if (containerIndex === -1) {
    return nodeId;
  }

  if (containerIndex === 0) {
    return nodeId;
  }

  return parents[containerIndex - 1];
}

export function getConnectionLevel(edge: BaseEdge, parentMapping: ParentMapping): string | null {
  const fromParents = parentMapping[edge.from] ?? [];
  const toParents = parentMapping[edge.to] ?? [];

  if (fromParents.length === 0 || toParents.length === 0) {
    return null;
  }

  for (const parent of fromParents) {
    if (toParents.includes(parent)) {
      return parent;
    }
  }

  return null;
}

export function groupConnectionsByLevel(
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
