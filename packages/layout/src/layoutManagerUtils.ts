import {
  LayoutEntity,
  LayoutChange,
  LayoutConnection,
  ContainerMapping,
  ParentMapping,
  LayoutConnectionChange,
  LayoutChanges,
  Dims,
} from './types.js';
import { isShift } from './typeChecks.js';
import { LayoutTree } from './LayoutTree.js';
import type { LayoutManager } from './LayoutManager.js';

export type ContainerDepthOrder = 'outermost-first' | 'innermost-first';

/**
 * Container ids sorted by nesting depth. `'outermost-first'` (the default)
 * sorts ascending by {@link LayoutManager.getEntityDepth} so a container is
 * always visited before any container nested inside it; `'innermost-first'`
 * reverses that. Depth is derived from `containerId` parentage (cycle-safe via
 * the parent mapping), so the ordering is stable under pure position shifts.
 */
export function getContainerIdsByDepth(
  lm: LayoutManager,
  order: ContainerDepthOrder = 'outermost-first',
): string[] {
  const containerIds = lm
    .getEntities()
    .filter((entity) => entity.isContainer)
    .map((entity) => entity.id);

  const sign = order === 'outermost-first' ? 1 : -1;
  containerIds.sort((a, b) => sign * (lm.getEntityDepth(a) - lm.getEntityDepth(b)));

  return containerIds;
}

export function getGroupOutsAndIns(
  layoutManager: LayoutManager,
  fromEntity: LayoutEntity | undefined,
  toEntity: LayoutEntity | undefined,
): {
  necessaryGroupOuts: Set<string>;
  necessaryGroupIns: Set<string>;
  sharedContainers: Set<string>;
} {
  const fromContainers: readonly string[] = fromEntity?.containerId
    ? layoutManager.getAllContainerIds(fromEntity.id)
    : [];
  const toContainers: readonly string[] = toEntity?.containerId
    ? layoutManager.getAllContainerIds(toEntity.id)
    : [];

  const fromContainerSet = new Set(fromContainers);
  const toContainerSet = new Set(toContainers);
  const necessaryGroupOuts = new Set<string>();
  const necessaryGroupIns = new Set<string>();
  const sharedContainers = new Set<string>();

  for (const id of fromContainers) {
    if (toContainerSet.has(id)) {
      sharedContainers.add(id);
    } else {
      necessaryGroupOuts.add(id);
    }
  }
  for (const id of toContainers) {
    if (!fromContainerSet.has(id)) {
      necessaryGroupIns.add(id);
    }
  }

  if (fromEntity?.isContainer && !toContainers.includes(fromEntity.id)) {
    necessaryGroupOuts.add(fromEntity.id);
  }
  if (toEntity?.isContainer && !fromContainers.includes(toEntity.id)) {
    necessaryGroupIns.add(toEntity.id);
  }

  return {
    necessaryGroupOuts,
    necessaryGroupIns,
    sharedContainers,
  };
}

export function makeContainerMapping(entities: LayoutEntity[]): ContainerMapping {
  const containerMapping: ContainerMapping = {};

  for (const entity of entities) {
    addEntityToContainerMapping(containerMapping, entity);
  }

  return containerMapping;
}

export function makeParentMapping(entitiesById: Record<string, LayoutEntity>): ParentMapping {
  const parentMapping: ParentMapping = {};

  for (const entity of Object.values(entitiesById)) {
    addEntityToParentMapping(parentMapping, entity, entitiesById);
  }

  return parentMapping;
}

export function addEntityToContainerMapping(
  containerMapping: ContainerMapping,
  entity: LayoutEntity,
): void {
  if (entity.isContainer) {
    containerMapping[entity.id] ??= new Set();
  }

  if (entity.containerId) {
    containerMapping[entity.containerId] ??= new Set();
    containerMapping[entity.containerId].add(entity.id);
  }
}

export function addEntityToParentMapping(
  parentMapping: ParentMapping,
  entity: LayoutEntity,
  entitiesById: Record<string, LayoutEntity>,
): void {
  const parents: string[] = [];
  const seen = new Set<string>([entity.id]);
  let currentEntity = entity;

  // LLM-authored container ids can be cyclic; terminate instead of growing
  // the parent array forever.
  while (currentEntity?.containerId) {
    if (seen.has(currentEntity.containerId)) {
      break;
    }
    parents.push(currentEntity.containerId);
    seen.add(currentEntity.containerId);
    currentEntity = entitiesById[currentEntity.containerId];
  }

  parentMapping[entity.id] = parents;
}

export function removeEntityFromContainerMapping(
  containerMapping: ContainerMapping,
  entity: LayoutEntity,
): void {
  if (entity.isContainer) {
    delete containerMapping[entity.id];
  }

  if (entity.containerId) {
    containerMapping[entity.containerId]?.delete(entity.id);
  }
}

export function removeEntityFromParentMapping(
  parentMapping: ParentMapping,
  entity: LayoutEntity,
): void {
  delete parentMapping[entity.id];
}

export function updateEntityContainerMapping(
  containerMapping: ContainerMapping,
  entity: LayoutEntity,
  oldContainerId?: string | null,
  oldWasContainer?: boolean,
): void {
  // Remove from old locations
  if (oldContainerId && entity.containerId !== oldContainerId) {
    containerMapping[oldContainerId]?.delete(entity.id);
  }

  if (oldWasContainer && !entity.isContainer) {
    delete containerMapping[entity.id];
  }

  // Add to new locations
  addEntityToContainerMapping(containerMapping, entity);
}

/**
 * THis is the tricky bit with the parent mapping. if an entity has its container changed
 * we need to make sure we update all of its children's (nested as much as possible) parent mapping
 */
export function updateEntityParentMapping(
  entitiesById: Record<string, LayoutEntity>,
  parentMapping: ParentMapping,
  containerMapping: ContainerMapping,
  entity: LayoutEntity,
  oldContainerId: string | null | undefined,
  oldIsContainer: boolean | undefined,
  oldChildIds: Set<string> | undefined,
): void {
  // Return early if there were no changes relevant to parentage
  if (
    !!oldIsContainer === !!entity.isContainer &&
    (oldContainerId ?? '') === (entity.containerId ?? '')
  ) {
    return;
  }

  addEntityToParentMapping(parentMapping, entity, entitiesById);

  const seenChildIds = new Set<string>();
  function recursivelyUpdateChildren(childIds?: Set<string>) {
    if (childIds?.size) {
      for (const childId of childIds) {
        if (seenChildIds.has(childId)) {
          continue;
        }
        seenChildIds.add(childId);
        addEntityToParentMapping(parentMapping, entitiesById[childId], entitiesById);
        recursivelyUpdateChildren(containerMapping[childId]);
      }
    }
  }

  recursivelyUpdateChildren(oldChildIds);
}

export function makeConnectionMapping(connections: LayoutConnection[]): Record<string, string[]> {
  const connectionMapping: Record<string, string[]> = {};

  for (const connection of connections) {
    const { id, from, to } = connection;

    // A free (unbound) endpoint is `''`; don't register it as an entity key, so
    // a one-bound connection is re-routed only when its *bound* entity moves.
    if (from) {
      if (connectionMapping[from]) {
        connectionMapping[from].push(id);
      } else {
        connectionMapping[from] = [id];
      }
    }

    if (to) {
      if (connectionMapping[to]) {
        connectionMapping[to].push(id);
      } else {
        connectionMapping[to] = [id];
      }
    }
  }

  return connectionMapping;
}

export function addConnectionToMappings(
  connection: LayoutConnection,
  connectionMapping: Record<string, string[]>,
): void {
  const { id, from, to } = connection;

  if (!connectionMapping[from]) {
    connectionMapping[from] = [];
  }

  if (!connectionMapping[from].includes(id)) {
    connectionMapping[from].push(id);
  }

  if (!connectionMapping[to]) {
    connectionMapping[to] = [];
  }

  if (!connectionMapping[to].includes(id)) {
    connectionMapping[to].push(id);
  }
}

export function removeConnectionFromMappings(
  connectionId: string,
  connections: LayoutConnection[],
  connectionMapping: Record<string, string[]>,
): void {
  const index = connections.findIndex((c) => c.id === connectionId);

  if (index === -1) {
    return;
  }

  const connection = connections[index];
  connections.splice(index, 1);

  const { from, to } = connection;

  const fromIndex = connectionMapping[from]?.indexOf(connectionId);
  if (fromIndex !== undefined && fromIndex !== -1) {
    connectionMapping[from].splice(fromIndex, 1);
  }

  const toIndex = connectionMapping[to]?.indexOf(connectionId);
  if (toIndex !== undefined && toIndex !== -1) {
    connectionMapping[to].splice(toIndex, 1);
  }
}

export function mergeChanges(change: LayoutChange, existingChange?: LayoutChange): LayoutChange {
  if (!existingChange) {
    return change;
  }

  const final: LayoutChange = { ...existingChange };

  if ('deltaX' in change && change.deltaX !== undefined) {
    final.deltaX = (existingChange.deltaX ?? 0) + change.deltaX;
  }

  if ('deltaY' in change && change.deltaY !== undefined) {
    final.deltaY = (existingChange.deltaY ?? 0) + change.deltaY;
  }

  if ('deltaWidth' in change && change.deltaWidth !== undefined) {
    final.deltaWidth = (existingChange.deltaWidth ?? 0) + change.deltaWidth;
  }

  if ('deltaHeight' in change && change.deltaHeight !== undefined) {
    final.deltaHeight = (existingChange.deltaHeight ?? 0) + change.deltaHeight;
  }

  if ('containerId' in change && change.containerId !== undefined) {
    final.containerId = change.containerId;
  }

  if ('isContainer' in change && change.isContainer !== undefined) {
    final.isContainer = change.isContainer;
  }

  if ('options' in change && change.options !== undefined) {
    final.options = { ...(existingChange.options ?? {}), ...change.options };
  }

  if ('textPlacement' in change && change.textPlacement !== undefined) {
    final.textPlacement = change.textPlacement;
  }

  return final;
}

export function mergeConnectionChanges(
  change: LayoutConnectionChange,
  existingChange?: LayoutConnectionChange,
): LayoutConnectionChange {
  if (!existingChange) {
    return change;
  }

  // The simple case where we are just adding the shift
  if (!isShift(change)) {
    return { ...existingChange, ...change };
  }

  const final: LayoutConnectionChange = { ...existingChange };

  if ('deltaX' in change && change.deltaX !== undefined) {
    if ('x' in final) {
      final.x = (final.x ?? 0) + change.deltaX;
    } else {
      // @ts-expect-error Existing should be a shift
      final.deltaX = (final.deltaX ?? 0) + change.deltaX;
    }
  }

  if ('deltaY' in change && change.deltaY !== undefined) {
    if ('y' in final) {
      final.y = (final.y ?? 0) + change.deltaY;
    } else {
      // @ts-expect-error Existing should be a shift
      final.deltaY = (final.deltaY ?? 0) + change.deltaY;
    }
  }

  return final;
}

/**
 * Centralized data container for LayoutManager state.
 * All mutable data is grouped here to simplify copying, checkpointing, and staging.
 */
export interface InternalData<T extends LayoutEntity = LayoutEntity> {
  entities: T[];
  entitiesById: Record<string, T>;
  connections: LayoutConnection[];
  containerIds: Set<string>;
  containerMapping: ContainerMapping;
  parentMapping: ParentMapping;
  connectionMapping: Record<string, string[]>;
  dims: Dims | undefined;
  tree: LayoutTree<T> | null;
}

/**
 * Deep copy of LayoutChanges - each Map and Set is copied
 */
export function deepCopyStagedChanges<T extends LayoutEntity>(
  changes: LayoutChanges<T> | undefined,
): LayoutChanges<T> | undefined {
  if (!changes) {
    return undefined;
  }

  return {
    additions: new Map(changes.additions),
    updates: new Map(changes.updates),
    deletes: new Set(changes.deletes),
    addedConnections: new Map(changes.addedConnections),
    updatedConnections: new Map(changes.updatedConnections),
    deletedConnections: new Set(changes.deletedConnections),
  };
}

/**
 * Checkpoint state - like Data but:
 * - entities is omitted (derived from entitiesById)
 * - tree is serialized as treeJson for storage
 */
export type CheckpointState<T extends LayoutEntity> = Omit<InternalData<T>, 'entities' | 'tree'> & {
  /** Serialized R-tree, or null if the tree had not been built at checkpoint time */
  treeJson?: ReturnType<LayoutTree<T>['toJSON']> | null;
  /** Staged changes at the time of checkpoint, deep copied */
  stagedChanges?: LayoutChanges<T>;
};

/**
 * Copy an entity-by-id map using structural sharing: entities that are the same reference
 * as in `baseEntitiesById` are shared (not copied), and entities that differ are shallow-copied.
 *
 * This is safe because _update's canMutate check (`entity !== this._data.entitiesById[entity.id]`)
 * never mutates shared base entities in place — it creates a new copy on first mutation.
 */
export function copyEntitiesWithSharing<T extends LayoutEntity>(
  baseEntitiesById: Record<string, T>,
  sourceEntitiesById?: Record<string, T> | undefined,
): Record<string, T> {
  if (!sourceEntitiesById) {
    return { ...baseEntitiesById };
  }

  const result: Record<string, T> = {};
  for (const [key, entity] of Object.entries(sourceEntitiesById)) {
    result[key] = entity === baseEntitiesById[key] ? entity : { ...entity };
  }
  return result;
}

type LayoutTreeJson<T extends LayoutEntity> = ReturnType<LayoutTree<T>['toJSON']>;

function copyTreeJsonWithEntities<T extends LayoutEntity>(
  treeJson: LayoutTreeJson<T>,
  entitiesById: Record<string, T>,
): LayoutTreeJson<T> {
  return {
    ...treeJson,
    children: treeJson.children.map((child: T | LayoutTreeJson<T>) =>
      treeJson.leaf
        ? (entitiesById[(child as T).id] ?? (child as T))
        : copyTreeJsonWithEntities(child as LayoutTreeJson<T>, entitiesById),
    ),
  };
}

function copyLayoutTree<T extends LayoutEntity>(
  treeJson: LayoutTreeJson<T>,
  entitiesById: Record<string, T>,
): LayoutTree<T> {
  return new LayoutTree<T>().fromJSON(copyTreeJsonWithEntities(treeJson, entitiesById));
}

/**
 * Copy data from source to target, performing deep copies where needed.
 * This is used for staging changes and checkpoint/restore operations.
 * @param original - The original data that created a layout manager
 * @param current - Optional, an up-to-date copy that will be used
 */
export function copyInternalData<T extends LayoutEntity>(
  original: InternalData<T>,
  current?: InternalData<T> | CheckpointState<T> | undefined,
): InternalData<T> {
  const base = current ?? original;
  const entitiesById = copyEntitiesWithSharing(original.entitiesById, current?.entitiesById);

  const tree =
    'tree' in base && base.tree
      ? copyLayoutTree(base.tree.toJSON(), entitiesById)
      : 'treeJson' in base && base.treeJson
        ? copyLayoutTree(base.treeJson, entitiesById)
        : null;

  const connectionMapping: Record<string, string[]> = {};
  for (const [id, connectionIds] of Object.entries(base.connectionMapping)) {
    connectionMapping[id] = [...connectionIds];
  }
  const containerMapping: ContainerMapping = {};
  for (const [id, childIds] of Object.entries(base.containerMapping)) {
    containerMapping[id] = new Set(childIds);
  }
  const parentMapping: ParentMapping = {};
  for (const [id, parentIds] of Object.entries(base.parentMapping)) {
    parentMapping[id] = [...parentIds];
  }

  return {
    entities: Object.values(entitiesById),
    connections: base.connections.map((c) => ({ ...c })),
    entitiesById,
    connectionMapping,
    containerIds: new Set(base.containerIds),
    containerMapping,
    parentMapping,
    dims: base.dims ? { ...base.dims } : undefined,
    tree,
  };
}

export function makeStagedChanges<T extends LayoutEntity>(): LayoutChanges<T> {
  return {
    additions: new Map(),
    updates: new Map(),
    deletes: new Set(),
    addedConnections: new Map(),
    deletedConnections: new Set(),
    updatedConnections: new Map(),
  };
}
