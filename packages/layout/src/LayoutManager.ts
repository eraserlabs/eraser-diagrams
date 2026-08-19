import type { Direction } from './types.js';
import { LayoutTree } from './LayoutTree.js';
import { calculateAllOverlaps, calculateOverlaps } from './overlaps.js';
import { applyConnectionChanges, applySizeChanges, getDimensions } from './sizeUtils.js';
import { DEFAULT_OPTIONS } from './constants.js';
import {
  LayoutEntity,
  LayoutConnection,
  LayoutChanges,
  LayoutChange,
  LayoutRange,
  LayoutOptions,
  ContainerMapping,
  ParentMapping,
  OverlapEntry,
  LayoutConnectionChange,
  TextPlacement,
} from './types.js';
import {
  makeConnectionMapping,
  makeContainerMapping,
  addEntityToContainerMapping,
  removeEntityFromContainerMapping,
  updateEntityContainerMapping,
  removeConnectionFromMappings,
  addConnectionToMappings,
  mergeChanges,
  mergeConnectionChanges,
  makeParentMapping,
  addEntityToParentMapping,
  removeEntityFromParentMapping,
  updateEntityParentMapping,
  makeStagedChanges,
  deepCopyStagedChanges,
  InternalData,
  CheckpointState,
  copyInternalData,
} from './layoutManagerUtils.js';
import { LayoutDuplicateError, LayoutError, MissingEntityError } from './LayoutError.js';
import { isOverlapping, makeRangeFromEntity } from './rangeUtils.js';
import { LayoutAlignment } from './alignmentUtils.js';

interface MakeGraphArgs<T extends LayoutEntity = LayoutEntity> {
  entities: T[];
  connections: LayoutConnection[];
  primaryDirection?: Direction;
  options?: Partial<LayoutOptions>;
  origin?: {
    x: number;
    y: number;
  };
}

/** @internal Pre-built state passed by fork() to skip rebuilding mappings */
type PrebuiltState<T extends LayoutEntity> = Omit<InternalData<T>, 'entities' | 'tree' | 'dims'>;

export class LayoutManager<T extends LayoutEntity = LayoutEntity> {
  public primaryDirection: Direction = 'right';
  public stagedChanges: LayoutChanges<T> | undefined;
  public origin = {
    x: 0,
    y: 0,
  };

  public options: LayoutOptions;

  private _alignment: LayoutAlignment;

  public get alignment(): LayoutAlignment {
    return this._alignment;
  }

  /**
   * Base data state. All persistent mutable data lives here.
   */
  private _data: InternalData<T>;

  /**
   * Staged data state. When changes are initiated, a copy of _data is made here.
   * Access staged data via: this._stagedData?.entities ?? this._data.entities
   */
  private _stagedData: InternalData<T> | undefined;

  /**
   * Checkpoints: snapshots of LayoutManager state that can be restored or forked from.
   */
  private _checkpoints: Map<string, CheckpointState<T>> = new Map();
  private _checkpointCounter = 0;

  constructor(args: MakeGraphArgs<T>, _prebuilt?: PrebuiltState<T>) {
    this.options = { ...DEFAULT_OPTIONS, ...args.options };

    if (args.primaryDirection) {
      this.primaryDirection = args.primaryDirection;
    }

    if (_prebuilt) {
      // Fast path for fork(): reuse pre-built mappings instead of rebuilding from entities
      this._data = {
        entities: args.entities,
        entitiesById: _prebuilt.entitiesById,
        connections: args.connections,
        containerIds: _prebuilt.containerIds,
        containerMapping: _prebuilt.containerMapping,
        parentMapping: _prebuilt.parentMapping,
        connectionMapping: _prebuilt.connectionMapping,
        dims: undefined,
        tree: null,
      };
    } else {
      this._data = this._createInitialData(args.entities, args.connections);
    }

    if (args.origin) {
      this.origin = args.origin;
    }

    this._alignment = new LayoutAlignment(() => this.getEntities());
  }

  /**
   * Create initial Data from entities and connections.
   * This builds all the derived mappings.
   */
  private _createInitialData(entities: T[], connections: LayoutConnection[]): InternalData<T> {
    const entitiesById: Record<string, T> = {};
    for (const entity of entities) {
      entitiesById[entity.id] = entity;
    }
    const containerMapping = makeContainerMapping(entities);
    const containerIds = new Set(
      Object.keys(containerMapping).filter((id) => entitiesById[id]?.isContainer),
    );

    return {
      entities,
      entitiesById,
      connections,
      containerIds,
      containerMapping,
      parentMapping: makeParentMapping(entitiesById),
      connectionMapping: makeConnectionMapping(connections),
      // Lazy properties added on query / read
      dims: undefined,
      tree: null,
    };
  }

  /** Util for making a full range from a partial range. Avoids new object if possible. */
  _makeFullRange(rangeArg: Partial<LayoutRange>): LayoutRange {
    if (
      rangeArg.minX != null &&
      rangeArg.maxX != null &&
      rangeArg.minY != null &&
      rangeArg.maxY != null
    ) {
      return rangeArg as LayoutRange;
    }

    return {
      minX: rangeArg.minX === undefined ? -Infinity : rangeArg.minX,
      minY: rangeArg.minY === undefined ? -Infinity : rangeArg.minY,
      maxX: rangeArg.maxX === undefined ? Infinity : rangeArg.maxX,
      maxY: rangeArg.maxY === undefined ? Infinity : rangeArg.maxY,
    };
  }

  /** Get the appropriate data object (staged or base) based on includeStaged flag */
  _getData(includeStaged = true): InternalData<T> {
    return includeStaged ? (this._stagedData ?? this._data) : this._data;
  }

  /** Finds overlapping leaves and containers. */
  findEntitiesInRange(
    range: Partial<LayoutRange>,
    filterFn?: (t: T) => boolean | undefined,
    includeStaged = true,
  ): T[] {
    const entities = this.findLeafEntitiesInRange(range, filterFn, includeStaged);
    entities.push(...this.findContainersInRange(range, filterFn, includeStaged));
    return entities;
  }

  /** Finds overlapping non-container entities using the spatial tree. */
  findLeafEntitiesInRange(
    range: Partial<LayoutRange>,
    filterFn?: (t: T) => boolean | undefined,
    includeStaged = true,
  ): T[] {
    const tree = this._ensureTree(includeStaged);
    const fullRange = this._makeFullRange(range);
    if (!filterFn) {
      return tree.searchBounds(fullRange.minX, fullRange.minY, fullRange.maxX, fullRange.maxY);
    }
    const entities: T[] = [];
    tree.forEachIntersectingBounds(
      fullRange.minX,
      fullRange.minY,
      fullRange.maxX,
      fullRange.maxY,
      (entity) => {
        if (filterFn(entity)) {
          entities.push(entity);
        }
      },
    );
    return entities;
  }

  /** Finds overlapping containers by scanning the maintained container set. */
  findContainersInRange(
    range: Partial<LayoutRange>,
    filterFn?: (t: T) => boolean | undefined,
    includeStaged = true,
  ): T[] {
    const fullRange = this._makeFullRange(range);
    const data = this._getData(includeStaged);
    const containers: T[] = [];

    for (const containerId of data.containerIds) {
      const container = data.entitiesById[containerId];

      if (
        container &&
        isOverlapping(fullRange, makeRangeFromEntity(container)) &&
        (!filterFn || filterFn(container))
      ) {
        containers.push(container);
      }
    }

    return containers;
  }

  calculateOverlaps(movingEntityIds: Set<string>): OverlapEntry[] {
    return calculateOverlaps(this, movingEntityIds);
  }

  calculateAllOverlaps(): OverlapEntry[] {
    return calculateAllOverlaps(this);
  }

  hasEntitiesInRange(range: Partial<LayoutRange>): boolean {
    const fullRange = this._makeFullRange(range);
    return (
      this._ensureTree().collidesBounds(
        fullRange.minX,
        fullRange.minY,
        fullRange.maxX,
        fullRange.maxY,
      ) || this.findContainersInRange(fullRange).length > 0
    );
  }

  getEntities(includeStaged = true): T[] {
    return this._getData(includeStaged).entities;
  }

  /**
   * Gathers all text placements from containers and connections
   */
  getTextPlacements(includeStaged = true): TextPlacement[] {
    const textPlacements: TextPlacement[] = [];

    for (const entity of this.getEntities(includeStaged)) {
      if (entity.textPlacement) {
        textPlacements.push({
          entityId: entity.id,
          width: entity.textPlacement.width,
          height: entity.textPlacement.height,
          x: entity.x + entity.textPlacement.relativeX,
          y: entity.y + entity.textPlacement.relativeY,
        });
      }
    }

    for (const connection of this.getConnections(includeStaged)) {
      if (connection.textPlacement) {
        textPlacements.push({ entityId: connection.id, ...connection.textPlacement });
      }
    }

    return textPlacements;
  }

  getEntitiesMapping(includeStaged = true): Record<string, T> {
    return this._getData(includeStaged).entitiesById;
  }

  getConnectionMapping(includeStaged = true): Record<string, string[]> {
    return this._getData(includeStaged).connectionMapping;
  }

  getConnectedEntities(entityId: string): Array<{ otherId: string; connection: LayoutConnection }> {
    const connectionIds = this.getConnectionMapping()[entityId];

    if (!connectionIds) {
      return [];
    }

    const connectedEntities: Array<{ otherId: string; connection: LayoutConnection }> = [];

    for (const connectionId of connectionIds) {
      const connection = this.getConnectionById(connectionId);

      if (!connection) {
        continue;
      }

      const otherId = connection.from === entityId ? connection.to : connection.from;

      connectedEntities.push({ otherId, connection });
    }

    return connectedEntities;
  }

  isConnected(entityId: string, otherId: string | string[]): boolean {
    for (const entry of this.getConnectedEntities(entityId)) {
      if (
        entry.otherId === otherId ||
        (Array.isArray(otherId) && otherId.includes(entry.otherId))
      ) {
        return true;
      }
    }

    return false;
  }

  getContainerMapping(includeStaged = true): ContainerMapping {
    return this._getData(includeStaged).containerMapping;
  }

  getChildIds(id: string, recursive = false, includeStaged = true): Set<string> | undefined {
    const containerMapping = this.getContainerMapping(includeStaged);
    const directChildIds = containerMapping[id];

    if (!recursive || !directChildIds?.size) {
      return directChildIds;
    }

    const childIds = new Set<string>();
    const visited = new Set<string>([id]);
    const queue = Array.from(directChildIds);

    for (let index = 0; index < queue.length; index++) {
      const childId = queue[index];

      if (visited.has(childId)) {
        continue;
      }

      visited.add(childId);
      childIds.add(childId);

      const nestedChildIds = containerMapping[childId];

      if (!nestedChildIds?.size) {
        continue;
      }

      for (const nestedChildId of nestedChildIds) {
        queue.push(nestedChildId);
      }
    }

    return childIds;
  }

  /** Useful for lazily iterating over children */
  *getChildIterator(id: string, recursive = true, includeStaged = true): Generator<string> {
    const childIds = this.getChildIds(id, recursive, includeStaged);

    if (!childIds?.size) {
      return;
    }

    for (const childId of childIds) {
      yield childId;
    }
  }

  /** Util for seeing if one entity is a child (nested or otherwise) of another */
  isChildOf(args: { parentId: string; targetId: string; includeStaged?: boolean }): boolean {
    const parentIds = this.getParentMapping(args.includeStaged ?? true)[args.targetId];
    return parentIds?.includes(args.parentId) ?? false;
  }

  /** Util for seeing if one entity is a child (nested or otherwise) of another */
  areRelated(idA: string, idB: string, includeStaged = true): boolean {
    const parentsA = this.getParentMapping(includeStaged)[idA];

    if (parentsA?.includes(idB)) {
      return true;
    }

    const parentsB = this.getParentMapping(includeStaged)[idB];
    return parentsB?.includes(idA) ?? false;
  }

  getChildEntities(id: string, recursive = false, includeStaged = true): T[] {
    const ret: T[] = [];
    const childIds = this.getChildIds(id, recursive, includeStaged);

    if (!childIds?.size) {
      return ret;
    }

    for (const childId of childIds) {
      const child = this.getEntityById(childId, false, includeStaged);

      if (child) {
        ret.push(child);
      }
    }

    return ret;
  }
  /** Direct members of a sibling scope: a container's children, or the root entities. */
  getEntitiesInScope(scope: string | null, includeStaged = true): T[] {
    return scope
      ? this.getChildEntities(scope, false, includeStaged)
      : this.getEntities(includeStaged).filter((e) => !e.containerId);
  }

  getSiblingEntities(entityArg: T | string, includeStaged = true): T[] {
    const entity =
      typeof entityArg === 'string'
        ? this.getEntityById(entityArg, false, includeStaged)
        : entityArg;

    if (!entity) {
      return [];
    }

    const { containerId } = entity;
    return containerId
      ? this.getChildEntities(containerId, false, includeStaged).filter((e) => e.id !== entity.id)
      : this.getEntities(includeStaged).filter((e) => e.id !== entity.id && !e.containerId);
  }

  initiateChanges() {
    if (this.stagedChanges != null) {
      return this.stagedChanges;
    }

    this.stagedChanges = makeStagedChanges<T>();

    // Copy all data from base to staged
    this._stagedData = copyInternalData(this._data);

    return this.stagedChanges;
  }

  addEntity(entity: T): void {
    if (!this.stagedChanges) {
      this.initiateChanges();
    }

    this.stagedChanges!.additions.set(entity.id, entity);
    this._add(entity);
  }

  addConnection(connection: LayoutConnection): void {
    if (!this.stagedChanges) {
      this.initiateChanges();
    }

    const staged = this._stagedData!;
    if (staged.connections.find((c) => c.id === connection.id)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(new LayoutDuplicateError('Connection already exists', connection.id));
      }
      return;
    }

    this.stagedChanges!.addedConnections.set(connection.id, connection);
    staged.connections.push(connection);
    addConnectionToMappings(connection, staged.connectionMapping);
  }

  updateEntity(entityId: string, changes: LayoutChange): void {
    if (!this.stagedChanges) {
      this.initiateChanges();
    }

    const { additions, updates } = this.stagedChanges!;
    const existingAddition = additions.get(entityId);

    // If we just added this, just update the added entity
    if (existingAddition) {
      // The _update will already mutate the addition, so we don't need to
    } else {
      updates.set(entityId, mergeChanges(changes, updates.get(entityId)));
    }

    this._update(entityId, changes);
  }

  updateMany(
    entityIds: Set<string | T> | Array<string | T> | undefined,
    changes: LayoutChange,
  ): void {
    if (!entityIds) {
      return;
    }

    // Casting to array avoids some infinite loop bugs if one of the mapping sets is used
    const arr = Array.isArray(entityIds) ? entityIds : Array.from(entityIds);
    for (const arg of arr) {
      const id = typeof arg === 'string' ? arg : arg.id;
      this.updateEntity(id, changes);
    }
  }

  /** Wraps one or more entities in a new container. Requires all entities have the same containerId. */
  wrap(entities: T[], container: Partial<T> & { id: string }): void {
    const currentContainerId = entities[0].containerId;

    if (entities.some((e) => e.containerId !== currentContainerId)) {
      throw new LayoutError('Can only wrap entities that share a container or are at root');
    }

    this.addEntity({
      // Default props for position
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      ...container,
      isContainer: true,
      containerId: currentContainerId,
    } as T);

    this.updateMany(entities, { containerId: container.id });
  }

  unwrap(containerArg: T | string): void {
    const containerId = typeof containerArg === 'string' ? containerArg : containerArg.id;
    const container =
      typeof containerArg === 'string' ? this.getEntityById(containerId) : containerArg;
    if (!container) {
      throw new MissingEntityError('Container not found', containerId);
    }
    const childIds = this.getChildIds(containerId, false);
    this.removeEntity(containerId);
    this.updateMany(childIds, { containerId: container.containerId });
  }

  updateConnection(connectionId: string, changes: LayoutConnectionChange): void {
    if (!this.stagedChanges) {
      this.initiateChanges();
    }
    const connection = this.getConnectionById(connectionId);

    if (!connection) {
      console.warn(new MissingEntityError('Connection does not exist', connectionId));
      return;
    }

    const canMutate = connection !== this.getConnectionById(connectionId, false);

    const updates = this.stagedChanges!.updatedConnections;
    updates.set(connectionId, mergeConnectionChanges(changes, updates.get(connectionId)));
    applyConnectionChanges(connection, changes, canMutate);
  }

  removeEntity(entityId: string): void {
    if (!this.stagedChanges) {
      this.initiateChanges();
    }

    this.stagedChanges!.deletes.add(entityId);
    this._remove(entityId);
  }

  removeConnection(connectionId: string): void {
    if (!this.stagedChanges) {
      this.initiateChanges();
    }

    this.stagedChanges!.deletedConnections.add(connectionId);
    // Make sure we don't have any stale changes for this connection
    this.stagedChanges!.updatedConnections.delete(connectionId);
    this.stagedChanges!.addedConnections.delete(connectionId);
    const staged = this._stagedData!;
    removeConnectionFromMappings(connectionId, staged.connections, staged.connectionMapping);
  }

  applyStagedChanges() {
    const changes = this.stagedChanges;

    if (!changes) {
      console.warn(new LayoutError('Tried to apply staged changes but none exist.'));
      this.clearStagedChanges();
      return;
    }

    if (!this._stagedData) {
      console.warn(new LayoutError('Tried to apply staged changes but no staged data exists.'));
      this.clearStagedChanges();
      return;
    }

    // Adopt staged data as the new base data
    this._data = this._stagedData;

    this.clearStagedChanges();
  }

  clearStagedChanges() {
    this.stagedChanges = undefined;
    this._stagedData = undefined;
  }

  /**
   * Snapshot the current state (staged if available, otherwise base) and return a checkpoint ID.
   * The checkpoint can later be used to restore state or fork a new LayoutManager.
   */
  checkpoint(label?: string): string {
    const id = label ?? `cp-${this._checkpointCounter++}`;

    const copy = copyInternalData(this._data, this._stagedData);

    const checkpoint: CheckpointState<T> = {
      entitiesById: copy.entitiesById,
      connections: copy.connections,
      containerIds: copy.containerIds,
      containerMapping: copy.containerMapping,
      parentMapping: copy.parentMapping,
      connectionMapping: copy.connectionMapping,
      dims: copy.dims,
      treeJson: copy.tree?.toJSON() ?? null,
      // Deep copy staged changes with all Maps and Sets
      stagedChanges: deepCopyStagedChanges(this.stagedChanges),
    };

    this._checkpoints.set(id, checkpoint);

    return id;
  }

  /**
   * Create a new independent LayoutManager from a checkpoint (or from current state if no ID given).
   * The fork is a completely separate instance — mutations to one do not affect the other.
   * Uses structural sharing and copies mapping for perf.
   */
  fork(checkpointId?: string): LayoutManager<T> {
    let data: InternalData<T>;

    if (checkpointId) {
      const state = this._checkpoints.get(checkpointId);
      if (!state) {
        throw new LayoutError(`Checkpoint "${checkpointId}" not found`);
      }

      data = copyInternalData(this._data, state);
    } else {
      data = copyInternalData(this._data, this._stagedData);
    }

    const fork = new LayoutManager<T>(
      {
        entities: data.entities,
        connections: data.connections,
        options: { ...this.options },
        primaryDirection: this.primaryDirection,
        origin: { ...this.origin },
      },
      data,
    );
    fork._alignment = this.alignment.copyFor(() => fork.getEntities());
    return fork;
  }

  /**
   * Restore staged state to a previously saved checkpoint.
   * This replaces the current staged state (initiating changes if needed).
   */
  restore(checkpointId: string): void {
    const state = this._checkpoints.get(checkpointId);
    if (!state) {
      throw new LayoutError(`Checkpoint "${checkpointId}" not found`);
    }

    this._stagedData = copyInternalData(this._data, state);

    // Restore staged changes from checkpoint (already deep copied at checkpoint time)
    this.stagedChanges = state.stagedChanges
      ? deepCopyStagedChanges(state.stagedChanges)
      : makeStagedChanges<T>();
  }

  deleteCheckpoint(checkpointId: string): boolean {
    return this._checkpoints.delete(checkpointId);
  }

  hasCheckpoint(checkpointId: string): boolean {
    return this._checkpoints.has(checkpointId);
  }

  getEntityById(
    id: string | null | undefined,
    throwOnMissing = false,
    withChanges = true,
  ): T | undefined {
    if (!id) {
      return undefined;
    }

    const ret = this._getData(withChanges).entitiesById[id];

    if (throwOnMissing && !ret) {
      throw new MissingEntityError('Entity not found', id);
    }

    return ret;
  }

  getEntitiesById(
    ids: readonly string[] | Set<string>,
    errorOnMissing = false,
    withChanges = true,
  ): T[] {
    const entities: T[] = [];

    for (const id of ids) {
      const entity = this.getEntityById(id, errorOnMissing, withChanges);

      if (entity) {
        entities.push(entity);
      }
    }

    return entities;
  }

  getEntityMapping(includeStaged = true): Record<string, T> {
    return this._getData(includeStaged).entitiesById;
  }

  /**
   * Returns all containers, starting from parent and ending at root
   */
  getAllContainerIds(entityArg: T | string, withChanges = true): readonly string[] {
    const id = typeof entityArg === 'string' ? entityArg : entityArg.id;
    return this.getParentMapping(withChanges)[id] || [];
  }

  getEntityDepth(entityArg: T | string, withChanges = true): number {
    const id = typeof entityArg === 'string' ? entityArg : entityArg.id;
    return this.getAllContainerIds(id, withChanges).length;
  }

  /**
   * Get options for an entity, using the layout manager options as defaults
   */
  public getEntityOptions(entity: Pick<LayoutEntity, 'options'>): LayoutOptions {
    return entity.options
      ? {
          ...entity.options,
          ...this.options,
        }
      : this.options;
  }

  public getEntityOption<K extends keyof LayoutOptions>(
    entity: Pick<LayoutEntity, 'options'>,
    key: K,
  ): LayoutOptions[K] {
    return entity.options?.[key] ?? this.options[key];
  }

  public getConnectionById(
    connectionId: string,
    includeStaged = true,
  ): LayoutConnection | undefined {
    return this._getData(includeStaged).connections.find((c) => c.id === connectionId);
  }

  public getConnections(includeStaged = true): LayoutConnection[] {
    return this._getData(includeStaged).connections;
  }

  private _ensureTree(applyToStaged = true): LayoutTree<T> {
    const data = this._getData(applyToStaged);
    if (!data.tree) {
      data.tree = new LayoutTree<T>();
      data.tree.load(data.entities.filter((entity) => !entity.isContainer));
    }
    return data.tree;
  }

  public resetEntities(entities: T[], connections?: LayoutConnection[]) {
    this.clearStagedChanges();
    const connectionsToUse = connections ?? this._data.connections;
    this._data = this._createInitialData(entities, connectionsToUse);
  }

  public resetConnections(connections: LayoutConnection[]) {
    this.clearStagedChanges();
    this._data = this._createInitialData(this._data.entities, connections);
  }

  private _add(entity: T): void {
    const staged = this._stagedData!;
    staged.entitiesById[entity.id] = entity;
    staged.entities = Object.values(staged.entitiesById);
    if (entity.isContainer) {
      staged.containerIds.add(entity.id);
    } else if (staged.tree) {
      staged.tree.insert(entity);
    }

    addEntityToContainerMapping(staged.containerMapping, entity);
    addEntityToParentMapping(staged.parentMapping, entity, staged.entitiesById);
    this._updatedDimsForEntityAddition(entity);
  }

  private _remove(entityId: string): void {
    const staged = this._stagedData!;
    const entity = staged.entitiesById[entityId];

    if (!entity) {
      return;
    }

    delete staged.entitiesById[entityId];
    staged.entities = Object.values(staged.entitiesById);
    staged.containerIds.delete(entity.id);
    if (staged.tree && !entity.isContainer) {
      staged.tree.remove(entity);
    }

    removeEntityFromContainerMapping(staged.containerMapping, entity);
    removeEntityFromParentMapping(staged.parentMapping, entity);
    this._updatedDimsForEntityRemoval(entity);
  }

  private _update(entityId: string, update: LayoutChange): void {
    const staged = this._stagedData!;
    const entity = staged.entitiesById[entityId];

    if (!entity) {
      console.warn(new MissingEntityError('Tried to update non-existent entity', entityId));
      return;
    }

    const oldContainerId = entity.containerId;
    const oldWasContainer = entity.isContainer;

    /** @note rbush Rtree does not support updating, so we remove and insert */
    if (staged.tree && !oldWasContainer) {
      staged.tree.remove(entity);
    }

    /** @perf - Mutate in place when entity is already a copy (not shared with base/checkpoint) */
    const canMutate = entity !== this._data.entitiesById[entity.id];
    const updatedEntity = applySizeChanges(entity, update, canMutate);

    if (updatedEntity.isContainer) {
      staged.containerIds.add(updatedEntity.id);
    } else {
      staged.containerIds.delete(updatedEntity.id);
    }

    if (staged.tree && !updatedEntity.isContainer) {
      staged.tree.insert(updatedEntity);
    }
    staged.entitiesById[updatedEntity.id] = updatedEntity;
    staged.entities = Object.values(staged.entitiesById);

    const oldChildIds = staged.containerMapping[entity.id];

    // Important to update this before the parent mapping, it is used to determine children
    updateEntityContainerMapping(
      staged.containerMapping,
      updatedEntity,
      oldContainerId,
      oldWasContainer,
    );

    // Update parent mapping for this entity and any entities that might be affected
    updateEntityParentMapping(
      staged.entitiesById,
      staged.parentMapping,
      staged.containerMapping,
      updatedEntity,
      oldContainerId,
      oldWasContainer,
      oldChildIds,
    );

    this._updatedDimsForEntityAddition(updatedEntity);
    this._updatedDimsForEntityRemoval(entity);
  }

  /**
   * Calculating full dimensions is expensive if we are doing it often
   * So if a new entity is added (or updated) we can just do a fast partial check
   */
  private _updatedDimsForEntityAddition(entity: T) {
    const staged = this._stagedData;
    if (staged?.dims) {
      const minX = Math.min(staged.dims.minX, entity.x);
      const minY = Math.min(staged.dims.minY, entity.y);
      const maxX = Math.max(staged.dims.maxX, entity.x + entity.width);
      const maxY = Math.max(staged.dims.maxY, entity.y + entity.height);

      const needsReCalc =
        entity.x !== staged.dims.minX ||
        entity.y !== staged.dims.minY ||
        entity.x + entity.width !== staged.dims.maxX ||
        entity.y + entity.height !== staged.dims.maxY;

      if (needsReCalc) {
        staged.dims = {
          minX,
          minY,
          maxX,
          maxY,
          midX: (minX + maxX) / 2,
          midY: (minY + maxY) / 2,
        };
      }
    }
  }

  /**
   * If an entity is removed, we may need to recalculate the dimensions,
   * but we only want to do that if the entity was on the boundary of the current range
   */
  private _updatedDimsForEntityRemoval(entity: T) {
    const staged = this._stagedData;
    if (staged?.dims) {
      const needsRecalc =
        entity.x <= staged.dims.minX ||
        entity.y <= staged.dims.minY ||
        entity.x + entity.width >= staged.dims.maxX ||
        entity.y + entity.height >= staged.dims.maxY;

      if (needsRecalc) {
        // This will require a full recalculation, we will do it lazily when needed
        staged.dims = undefined;
      }
    }
  }

  private _calcDims(includeStaged = true): LayoutRange & { midX: number; midY: number } {
    const data = this._getData(includeStaged);
    const baseDims = getDimensions(data.entities);

    data.dims = {
      ...baseDims,
      midX: (baseDims.minX + baseDims.maxX) / 2,
      midY: (baseDims.minY + baseDims.maxY) / 2,
    };
    return data.dims;
  }

  get dims(): LayoutRange & { midX: number; midY: number } {
    return this._data.dims || this._calcDims(false);
  }

  get stagedDims(): LayoutRange & { midX: number; midY: number } {
    return this._stagedData?.dims || this._calcDims(true);
  }

  getDims(includeStaged?: boolean): LayoutRange & { midX: number; midY: number } {
    if (includeStaged && this._stagedData?.dims) {
      return this._stagedData.dims;
    }

    return this._calcDims(includeStaged);
  }

  getParentMapping(includeStaged = true): ParentMapping {
    return this._getData(includeStaged).parentMapping;
  }
}
