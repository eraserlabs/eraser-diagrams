import { LayoutManager } from '../LayoutManager.js';
import { LayoutConnection } from '../types.js';

const simpleJson = require('./simple');
const groupJson = require('./group');
const nestedGroupJson = require('./nestedGroup');
const simpleConnectionJson = require('./simpleConnection');

const copyFixture = <T>(fixture: T): T => JSON.parse(JSON.stringify(fixture)) as T;
const simpleCase = () => copyFixture(simpleJson);
const simpleConnectionCase = () => copyFixture(simpleConnectionJson);
const groupCase = () => copyFixture(groupJson);
const nestedGroupCase = () => copyFixture(nestedGroupJson);
const sortedIds = (ids: Iterable<string>) => Array.from(ids).sort();
const sortedEntityIds = (entities: Array<{ id: string }>) =>
  entities.map((entity) => entity.id).sort();

describe('layoutManager', () => {
  describe('applyStagedChanges', () => {
    it('should clear staged changes', () => {
      const layoutManager = new LayoutManager({ ...simpleCase(), primaryDirection: 'down' });

      layoutManager.initiateChanges();
      layoutManager.applyStagedChanges();

      expect(layoutManager.stagedChanges).toBeUndefined();
    });
  });

  describe('range queries', () => {
    const queryRange = { minX: 5, minY: 5, maxX: 35, maxY: 35 };
    const containerOnlyRange = { minX: 90, minY: 90, maxX: 95, maxY: 95 };

    function makeRangeQueryLayoutManager() {
      return new LayoutManager({
        entities: [
          { id: 'leaf', x: 10, y: 10, width: 20, height: 20 },
          { id: 'container', x: 0, y: 0, width: 100, height: 100, isContainer: true },
          { id: 'outside-leaf', x: 200, y: 200, width: 20, height: 20 },
          {
            id: 'outside-container',
            x: 200,
            y: 200,
            width: 100,
            height: 100,
            isContainer: true,
          },
        ],
        connections: [],
      });
    }

    it('exposes leaf-only, container-only, and composed all-entity queries', () => {
      const layoutManager = makeRangeQueryLayoutManager();

      expect(sortedEntityIds(layoutManager.findLeafEntitiesInRange(queryRange))).toEqual(['leaf']);
      expect(sortedEntityIds(layoutManager.findContainersInRange(queryRange))).toEqual([
        'container',
      ]);
      expect(sortedEntityIds(layoutManager.findEntitiesInRange(queryRange))).toEqual([
        'container',
        'leaf',
      ]);
      expect(sortedEntityIds(layoutManager._getData().tree?.all() ?? [])).toEqual([
        'leaf',
        'outside-leaf',
      ]);
    });

    it('includes containers in all-entity collision checks', () => {
      const layoutManager = makeRangeQueryLayoutManager();

      expect(layoutManager.findLeafEntitiesInRange(containerOnlyRange)).toEqual([]);
      expect(sortedEntityIds(layoutManager.findContainersInRange(containerOnlyRange))).toEqual([
        'container',
      ]);
      expect(layoutManager.hasEntitiesInRange(containerOnlyRange)).toBe(true);
    });

    it('keeps leaf and container indexes correct through staged mutations and type changes', () => {
      const layoutManager = makeRangeQueryLayoutManager();
      const originalLeafRange = { minX: 10, minY: 10, maxX: 30, maxY: 30 };
      const movedLeafRange = { minX: 400, minY: 10, maxX: 420, maxY: 30 };
      const movedContainerRange = { minX: 500, minY: 0, maxX: 600, maxY: 100 };
      const addedLeafRange = { minX: 700, minY: 0, maxX: 720, maxY: 20 };
      const addedContainerRange = { minX: 800, minY: 0, maxX: 900, maxY: 100 };

      // Materialize the leaf tree before exercising its incremental update path.
      expect(sortedEntityIds(layoutManager.findLeafEntitiesInRange(originalLeafRange))).toEqual([
        'leaf',
      ]);

      layoutManager.addEntity({ id: 'added-leaf', x: 700, y: 0, width: 20, height: 20 });
      layoutManager.addEntity({
        id: 'added-container',
        x: 800,
        y: 0,
        width: 100,
        height: 100,
        isContainer: true,
      });
      layoutManager.updateEntity('leaf', { deltaX: 390 });
      layoutManager.updateEntity('container', { deltaX: 500 });

      expect(sortedEntityIds(layoutManager.findLeafEntitiesInRange(addedLeafRange))).toEqual([
        'added-leaf',
      ]);
      expect(sortedEntityIds(layoutManager.findContainersInRange(addedContainerRange))).toEqual([
        'added-container',
      ]);
      expect(layoutManager.findLeafEntitiesInRange(originalLeafRange)).toEqual([]);
      expect(sortedEntityIds(layoutManager.findLeafEntitiesInRange(movedLeafRange))).toEqual([
        'leaf',
      ]);
      expect(sortedEntityIds(layoutManager.findContainersInRange(movedContainerRange))).toEqual([
        'container',
      ]);
      expect(
        sortedEntityIds(layoutManager.findLeafEntitiesInRange(originalLeafRange, undefined, false)),
      ).toEqual(['leaf']);
      expect(layoutManager.findContainersInRange(movedContainerRange, undefined, false)).toEqual(
        [],
      );

      layoutManager.updateEntity('leaf', { isContainer: true });
      layoutManager.updateEntity('container', { isContainer: false });

      expect(layoutManager.findLeafEntitiesInRange(movedLeafRange)).toEqual([]);
      expect(sortedEntityIds(layoutManager.findContainersInRange(movedLeafRange))).toEqual([
        'leaf',
      ]);
      expect(layoutManager.findContainersInRange(movedContainerRange)).toEqual([]);
      expect(sortedEntityIds(layoutManager.findLeafEntitiesInRange(movedContainerRange))).toEqual([
        'container',
      ]);

      layoutManager.removeEntity('leaf');
      layoutManager.removeEntity('container');

      expect(layoutManager.findEntitiesInRange(movedLeafRange)).toEqual([]);
      expect(layoutManager.findEntitiesInRange(movedContainerRange)).toEqual([]);
    });
  });

  describe('addEntity', () => {
    it('should add an entity to the layout', () => {
      const layoutManager = new LayoutManager({ ...simpleCase(), primaryDirection: 'down' });

      const newEntity = { id: 'new-ent', x: 500, y: 500, width: 100, height: 100 };

      layoutManager.addEntity(newEntity);

      expect(layoutManager.getEntities().length).toBe(3);
      expect(layoutManager.getEntityById('new-ent')).toBe(newEntity);
    });
  });

  describe('updateEntity', () => {
    it('should update an entity in the layout', () => {
      const layoutManager = new LayoutManager({ ...simpleCase(), primaryDirection: 'down' });

      const update = { deltaX: 100, deltaY: 100 };

      layoutManager.initiateChanges();
      layoutManager.updateEntity('rect0', update);

      expect(layoutManager.getEntityById('rect0')).toEqual({
        ...layoutManager.getEntityById('rect0'),
        x: 100,
        y: 100,
      });
    });

    it('should add a container id', () => {
      const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

      layoutManager.updateEntity('rect-left', { containerId: 'container' });

      expect(layoutManager.getEntityById('rect-left')).toEqual({
        ...layoutManager.getEntityById('rect-left', false),
        containerId: 'container',
      });

      expect(layoutManager.stagedChanges?.updates.get('rect-left')).toEqual({
        containerId: 'container',
      });

      expect(layoutManager.getAllContainerIds('rect-left')).toEqual(['container']);

      expect(layoutManager.getContainerMapping().container).toEqual(
        new Set(['rect-left', 'rect0', 'rect200']),
      );
    });

    it('should remove a container id', () => {
      const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

      layoutManager.updateEntity('rect0', { containerId: null });

      expect(layoutManager.getEntityById('rect0')).toEqual({
        ...layoutManager.getEntityById('rect0', false),
        containerId: null,
      });
      expect(layoutManager.stagedChanges?.updates.get('rect0')).toEqual({
        containerId: null,
      });
      expect(layoutManager.getContainerMapping().container).toEqual(new Set(['rect200']));
    });

    it('should apply consecutive changes', () => {
      const layoutManager = new LayoutManager({ ...simpleCase(), primaryDirection: 'down' });

      layoutManager.updateEntity('rect0', { deltaX: 10 });
      layoutManager.updateEntity('rect0', { deltaX: 100, deltaY: 100 });
      layoutManager.updateEntity('rect0', { deltaY: 50 });
      layoutManager.updateEntity('rect0', { deltaX: 50, deltaWidth: 50 });

      expect(layoutManager.getEntityById('rect0')).toEqual({
        ...layoutManager.getEntityById('rect0'),
        x: 160,
        y: 150,
        width: 150,
      });

      expect(layoutManager.stagedChanges?.updates.get('rect0')).toEqual({
        deltaX: 160,
        deltaY: 150,
        deltaWidth: 50,
      });
    });

    it('should remove an entry from the container mapping', () => {
      const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

      layoutManager.updateEntity('container', {
        isContainer: false,
      });

      expect(layoutManager.stagedChanges?.updates.get('container')).toEqual({
        isContainer: false,
      });
      expect(layoutManager.getContainerMapping().container).toBeUndefined();
    });

    it('should handle ungrouping a container', () => {
      const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

      layoutManager.updateEntity('inner-container', { containerId: null });
      layoutManager.updateEntity('outer-container', { isContainer: false });

      expect(layoutManager.getEntityById('outer-container')).toEqual({
        ...layoutManager.getEntityById('outer-container', false),
        isContainer: false,
      });

      expect(layoutManager.getAllContainerIds('inner-container')).toEqual([]);
      expect(layoutManager.getAllContainerIds('outer-container')).toEqual([]);
      expect(layoutManager.getChildIds('outer-container')).toBeUndefined();
      expect(layoutManager.getAllContainerIds('rect0')).toEqual(['inner-container']);
      expect(layoutManager.getAllContainerIds('rect200')).toEqual(['inner-container']);
    });
  });

  describe('removeEntity', () => {
    it('should remove an entity from the layout', () => {
      const layoutManager = new LayoutManager({ ...simpleCase(), primaryDirection: 'down' });

      layoutManager.removeEntity('rect0');

      expect(layoutManager.getEntities()).toHaveLength(1);
      expect(layoutManager.getEntityById('rect0')).toBeUndefined();
    });
  });

  describe('addConnection', () => {
    it('should add a connection to the layout', () => {
      const layoutManager = new LayoutManager({ ...simpleCase(), primaryDirection: 'down' });

      const connection: LayoutConnection = {
        id: 'new-conn',
        from: 'rect0',
        to: 'rect200',
        x: 50,
        y: 100,
        points: [
          [0, 0],
          [0, 100],
        ],
      };

      // Make sure it is part of the connections
      layoutManager.addConnection(connection);
      expect(layoutManager.getConnections().length).toBe(1);
      expect(layoutManager.getConnections()[0]).toEqual(connection);

      // Make sure it gets applied when changes are applied
      layoutManager.applyStagedChanges();
      expect(layoutManager.getConnections().length).toBe(1);
      expect(layoutManager.getConnections()[0]).toEqual(connection);
    });
  });

  describe('getChildEntities', () => {
    it('should get child entities', () => {
      const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

      expect(layoutManager.getChildEntities('container')).toEqual([
        layoutManager.getEntityById('rect0'),
        layoutManager.getEntityById('rect200'),
      ]);
    });

    it('should get recursive child entities', () => {
      const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

      expect(sortedEntityIds(layoutManager.getChildEntities('outer-container', true))).toEqual(
        [
          'inner-container',
          'rect0',
          'rect200',
          'rect-outer-below',
          'rect-outer-right',
          'rect-outer-left',
          'rect-outer-above',
        ].sort(),
      );
    });

    it('should get just first level children', () => {
      const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

      expect(layoutManager.getChildEntities('outer-container', false)).toEqual([
        layoutManager.getEntityById('inner-container'),
        layoutManager.getEntityById('rect-outer-below'),
        layoutManager.getEntityById('rect-outer-right'),
        layoutManager.getEntityById('rect-outer-left'),
        layoutManager.getEntityById('rect-outer-above'),
      ]);
    });

    it('should get recursive child ids without mutating direct child ids', () => {
      const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

      expect(sortedIds(layoutManager.getChildIds('outer-container', true) ?? [])).toEqual(
        [
          'inner-container',
          'rect0',
          'rect200',
          'rect-outer-below',
          'rect-outer-right',
          'rect-outer-left',
          'rect-outer-above',
        ].sort(),
      );

      expect(Array.from(layoutManager.getChildIds('outer-container') ?? [])).toEqual([
        'inner-container',
        'rect-outer-below',
        'rect-outer-right',
        'rect-outer-left',
        'rect-outer-above',
      ]);
    });

    it('should detect ancestor relationships through parent mapping', () => {
      const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

      expect(layoutManager.areRelated('outer-container', 'rect0')).toBe(true);
      expect(layoutManager.areRelated('rect0', 'outer-container')).toBe(true);
      expect(layoutManager.areRelated('rect0', 'rect-outer-left')).toBe(false);
    });

    it('terminates with cyclic containerId chains', () => {
      const layoutManager = new LayoutManager({
        entities: [
          { id: 'a', x: 0, y: 0, width: 100, height: 100, containerId: 'b', isContainer: true },
          { id: 'b', x: 0, y: 0, width: 100, height: 100, containerId: 'a', isContainer: true },
        ],
        connections: [],
      });

      expect(Array.from(layoutManager.getChildIterator('a'))).toEqual(['b']);
      expect(Array.from(layoutManager.getChildIterator('b'))).toEqual(['a']);
      expect(layoutManager.isChildOf({ parentId: 'a', targetId: 'b' })).toBe(true);
      expect(layoutManager.isChildOf({ parentId: 'b', targetId: 'a' })).toBe(true);
      expect(layoutManager.isChildOf({ parentId: 'a', targetId: 'nope' })).toBe(false);
      expect(layoutManager.areRelated('a', 'b')).toBe(true);
    });
  });

  describe('updateConnection', () => {
    it('should handle shifts', () => {
      const layoutManager = new LayoutManager(simpleConnectionCase());

      layoutManager.updateConnection('rel-left-right-forward', {
        deltaY: 10,
      });

      expect(layoutManager.getConnections()[0]).toEqual({
        ...layoutManager.getConnections()[0],
        y: 60,
      });

      layoutManager.updateConnection('rel-left-right-forward', {
        deltaY: 10,
        deltaX: 10,
      });

      expect(layoutManager.getConnections()[0]).toEqual({
        ...layoutManager.getConnections()[0],
        y: 70,
        x: 110,
      });
    });

    it('should handle a shift then a non-shift', () => {
      const layoutManager = new LayoutManager(simpleConnectionCase());
      const textPlacement = {
        x: 150,
        y: 50,
        width: 20,
        height: 10,
      };

      layoutManager.updateConnection('rel-left-right-forward', {
        deltaY: 10,
      });
      layoutManager.updateConnection('rel-left-right-forward', {
        textPlacement,
      });

      expect(layoutManager.getConnections()[0]).toEqual({
        ...layoutManager.getConnections()[0],
        y: 60,
        textPlacement,
      });
    });

    it('shift should combine with changes and bump text placement', () => {
      const layoutManager = new LayoutManager(simpleConnectionCase());
      const textPlacement = {
        x: 150,
        y: 50,
        width: 20,
        height: 10,
      };

      layoutManager.updateConnection('rel-left-right-forward', {
        textPlacement,
      });
      layoutManager.updateConnection('rel-left-right-forward', {
        deltaY: 10,
      });

      expect(layoutManager.getConnections()[0]).toEqual({
        ...layoutManager.getConnections()[0],
        y: 60,
        textPlacement: {
          ...textPlacement,
          y: 60,
        },
      });
    });

    it('should apply shifts to existing text placement', () => {
      const layoutManager = new LayoutManager(simpleConnectionCase());
      layoutManager.updateConnection('rel-left-right-forward', {
        textPlacement: {
          x: 150,
          y: 50,
          width: 20,
          height: 10,
        },
      });
      layoutManager.applyStagedChanges();
      layoutManager.updateConnection('rel-left-right-forward', {
        deltaY: 10,
      });

      const connection = layoutManager.getConnections()[0];
      expect(connection.y).toBe(60);
      expect(connection.textPlacement).toMatchObject({
        x: 150,
        y: 60,
      });
    });
  });

  describe('Parent Mapping', () => {
    describe('initialization', () => {
      it('should build parent mapping on construction', () => {
        const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

        const parentMapping = layoutManager.getParentMapping();

        expect(parentMapping['container']).toEqual([]);
        expect(parentMapping['rect0']).toEqual(['container']);
        expect(parentMapping['rect200']).toEqual(['container']);
        expect(parentMapping['rect-left']).toEqual([]);
      });

      it('should handle nested containers', () => {
        const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

        const parentMapping = layoutManager.getParentMapping();

        expect(parentMapping['outer-container']).toEqual([]);
        expect(parentMapping['inner-container']).toEqual(['outer-container']);
        expect(parentMapping['rect0']).toEqual(['inner-container', 'outer-container']);
        expect(parentMapping['rect200']).toEqual(['inner-container', 'outer-container']);
        expect(parentMapping['rect-outer-below']).toEqual(['outer-container']);
      });
    });

    describe('getAllContainerIds', () => {
      it('should return parent ids in order from immediate to root', () => {
        const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

        expect(layoutManager.getAllContainerIds('rect0')).toEqual([
          'inner-container',
          'outer-container',
        ]);
        expect(layoutManager.getAllContainerIds('inner-container')).toEqual(['outer-container']);
        expect(layoutManager.getAllContainerIds('outer-container')).toEqual([]);
      });

      it('should return empty array for entities with no parents', () => {
        const layoutManager = new LayoutManager({ ...simpleCase(), primaryDirection: 'down' });

        expect(layoutManager.getAllContainerIds('rect0')).toEqual([]);
        expect(layoutManager.getAllContainerIds('rect200')).toEqual([]);
      });
    });

    describe('entity updates', () => {
      it('should update parent mapping when adding a new entity', () => {
        const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

        layoutManager.addEntity({
          id: 'new-child',
          x: 150,
          y: 150,
          width: 50,
          height: 50,
          containerId: 'container',
        });

        expect(layoutManager.getAllContainerIds('new-child')).toEqual(['container']);
      });

      it('should update parent mapping when removing an entity', () => {
        const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

        expect(layoutManager.getAllContainerIds('rect0')).toEqual(['container']);

        layoutManager.removeEntity('rect0');

        expect(layoutManager.getAllContainerIds('rect0')).toEqual([]);
      });

      it('should update parent mapping when changing container id', () => {
        const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

        expect(layoutManager.getAllContainerIds('rect0')).toEqual([
          'inner-container',
          'outer-container',
        ]);

        // Move rect0 directly to outer-container
        layoutManager.updateEntity('rect0', { containerId: 'outer-container' });

        expect(layoutManager.getAllContainerIds('rect0')).toEqual(['outer-container']);
      });

      it('should update parent mapping when removing container id', () => {
        const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

        expect(layoutManager.getAllContainerIds('rect0')).toEqual(['container']);

        layoutManager.updateEntity('rect0', { containerId: null });

        expect(layoutManager.getAllContainerIds('rect0')).toEqual([]);
      });

      it('should update parent mappings for all children when container hierarchy changes', () => {
        const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

        // Add another container as parent of outer-container
        layoutManager.addEntity({
          id: 'super-container',
          x: -50,
          y: -50,
          width: 400,
          height: 400,
          isContainer: true,
        });

        // Move outer-container into super-container
        layoutManager.updateEntity('outer-container', { containerId: 'super-container' });

        // All children should now have super-container in their hierarchy
        expect(layoutManager.getAllContainerIds('outer-container')).toEqual(['super-container']);
        expect(layoutManager.getAllContainerIds('inner-container')).toEqual([
          'outer-container',
          'super-container',
        ]);
        expect(layoutManager.getAllContainerIds('rect0')).toEqual([
          'inner-container',
          'outer-container',
          'super-container',
        ]);
        expect(layoutManager.getAllContainerIds('rect-outer-below')).toEqual([
          'outer-container',
          'super-container',
        ]);
      });

      it('should update parent mapping when an intermedate container is moved', () => {
        const layoutManager = new LayoutManager({ ...nestedGroupCase(), primaryDirection: 'down' });

        layoutManager.updateEntity('inner-container', { containerId: null });

        expect(layoutManager.getAllContainerIds('rect0')).toEqual(['inner-container']);
      });
    });

    describe('staged changes', () => {
      it('should maintain separate staged parent mapping', () => {
        const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

        // Original parent mapping
        expect(layoutManager.getAllContainerIds('rect0', false)).toEqual(['container']);

        // Update with staged changes
        layoutManager.updateEntity('rect0', { containerId: null });

        // Staged should be different
        expect(layoutManager.getAllContainerIds('rect0', true)).toEqual([]);
        // Non-staged should be original
        expect(layoutManager.getAllContainerIds('rect0', false)).toEqual(['container']);

        // Apply changes
        layoutManager.applyStagedChanges();

        // Now both should be the same
        expect(layoutManager.getAllContainerIds('rect0', true)).toEqual([]);
        expect(layoutManager.getAllContainerIds('rect0', false)).toEqual([]);
      });

      it('should clear staged parent mapping when clearing staged changes', () => {
        const layoutManager = new LayoutManager({ ...groupCase(), primaryDirection: 'down' });

        layoutManager.updateEntity('rect0', { containerId: null });

        expect(layoutManager.getAllContainerIds('rect0', true)).toEqual([]);

        layoutManager.clearStagedChanges();

        // Should revert to original
        expect(layoutManager.getAllContainerIds('rect0', true)).toEqual(['container']);
      });
    });
  });
});
