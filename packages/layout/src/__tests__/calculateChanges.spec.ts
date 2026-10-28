import { vi } from 'vitest';
vi.mock('../constants.js', async () => {
  const constants = await vi.importActual<typeof import('../constants.js')>('../constants.js');
  return {
    ...constants,
    // In case default options change, we want the tests to continue working
    DEFAULT_OPTIONS: {
      marginBetweenEntities: 20,
      marginBetweenRanks: 20,
      /** Make these assymetric to test for edge cases */
      containerPadding: {
        top: 20,
        right: 10,
        bottom: 10,
        left: 20,
      },
      minConnectionLength: 60,
      minConnectionTextMargin: 20,
    },
  };
});

import { generateChanges, generateChangesForMove } from '../calculateChanges.js';
import { COMMIT_REPAIR } from '../routing/routeConnections.js';
import { LayoutEntity } from '../types.js';
import { LayoutManager } from '../LayoutManager.js';
import { simpleEntity } from '../routing/routingTestUtils.js';

const copyFixture = <T>(fixture: T): T => JSON.parse(JSON.stringify(fixture)) as T;
const simpleCase = () => copyFixture(require('./simple'));
const groupCase = () => copyFixture(require('./group'));
const nestedGroupCase = () => copyFixture(require('./nestedGroup'));

describe('generateChanges', () => {
  describe('newEntities', () => {
    it('should return empty changes object when no elements are added', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [],
        layoutManager: new LayoutManager({ ...simpleCase() }),
      });

      expect(changes).toEqual({
        additions: new Map(),
        updates: new Map(),
        deletes: new Set(),
        addedConnections: new Map(),
        updatedConnections: new Map(),
        deletedConnections: new Set(),
      });
    });

    it('can add a first element', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [{ id: 'new-ent', width: 100, height: 100 }],
        layoutManager: new LayoutManager({ entities: [], connections: [] }),
      });

      expect(changes).toEqual({
        additions: new Map([['new-ent', { id: 'new-ent', x: 0, y: 0, width: 100, height: 100 }]]),
        updates: new Map(),
        deletes: new Set(),
        addedConnections: new Map(),
        updatedConnections: new Map(),
        deletedConnections: new Set(),
      });
    });

    it('should add element to the bottom when no position is provided if diagram goes down', () => {
      const newEnt = { id: 'new-ent', width: 100, height: 100 };

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [newEnt],
        layoutManager: new LayoutManager({ ...simpleCase(), primaryDirection: 'down' }),
      });

      expect(changes).toEqual({
        additions: new Map([['new-ent', { ...newEnt, y: 320, x: 0 }]]),
        updates: new Map(),
        deletes: new Set(),
        addedConnections: new Map(),
        updatedConnections: new Map(),
        deletedConnections: new Set(),
      });
    });

    it('should add element to the right when no position is provided if diagram goes right', () => {
      const newEnt = { id: 'new-ent', width: 100, height: 100 };

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [newEnt],
        layoutManager: new LayoutManager({ ...simpleCase(), primaryDirection: 'right' }),
      });

      expect(changes).toEqual({
        additions: new Map([['new-ent', { ...newEnt, x: 120, y: 100 }]]),
        updates: new Map(),
        deletes: new Set(),
        addedConnections: new Map(),
        updatedConnections: new Map(),
        deletedConnections: new Set(),
      });
    });

    it('should bump elements down when new element is added after existing element', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [{ id: 'new-ent', width: 100, height: 100, placement: { afterId: 'rect0' } }],
        layoutManager: new LayoutManager({ ...simpleCase(), primaryDirection: 'down' }),
      });

      expect(changes).toEqual({
        additions: new Map([['new-ent', { id: 'new-ent', width: 100, height: 100, x: 0, y: 120 }]]),
        updates: new Map([['rect200', { deltaY: 40 }]]),
        deletes: new Set(),
        addedConnections: new Map(),
        updatedConnections: new Map(),
        deletedConnections: new Set(),
      });
    });

    it('should stop when there is no collision', () => {
      const entities = simpleCase().entities;

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [{ id: 'new-ent', width: 100, height: 100, placement: { afterId: 'rect0' } }],
        layoutManager: new LayoutManager({
          entities: entities.concat({
            id: 'rect-beyond-collision',
            x: 0,
            // We want to be below 200 + 100 height + 120 bump = 420
            y: 450,
            width: 100,
            height: 100,
          }),
          connections: [],
          primaryDirection: 'down',
        }),
      });

      expect(changes.updates.has('rect-beyond-collision')).toBe(false);
    });

    it('should bump an entire container + all of its elements', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [
          { id: 'new-ent', width: 100, height: 100, placement: { afterId: 'rect-left' } },
        ],
        layoutManager: new LayoutManager({ ...groupCase(), primaryDirection: 'right' }),
      });

      expect(Object.fromEntries(changes.additions)).toEqual({
        // New entity should be -80 ("rect-left" ends at -100 + 20 margin)
        ['new-ent']: { id: 'new-ent', width: 100, height: 100, x: -80, y: 100 },
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        container: { deltaX: 60 },
        ['rect-right']: { deltaX: 60 },
        ['rect0']: { deltaX: 60 },
        ['rect200']: { deltaX: 60 },
      });
    });

    it('should bump an entire nested container + all of its elements', () => {
      const newEnt = {
        id: 'new-ent',
        width: 100,
        height: 100,
        placement: { afterId: 'rect-left' },
      };

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [newEnt],
        layoutManager: new LayoutManager({
          ...nestedGroupCase(),
          primaryDirection: 'right',
        }),
      });

      expect(Object.fromEntries(changes.additions)).toEqual({
        ['new-ent']: { id: 'new-ent', width: 100, height: 100, x: -180, y: 200 },
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        ['outer-container']: { deltaX: 60 },
        ['inner-container']: { deltaX: 60 },
        ['rect-outer-right']: { deltaX: 60 },
        ['rect-outer-above']: { deltaX: 60 },
        ['rect-outer-below']: { deltaX: 60 },
        ['rect-outer-left']: { deltaX: 60 },
        ['rect0']: { deltaX: 60 },
        ['rect200']: { deltaX: 60 },
        // Also check that entities after the group get bumped
        ['rect-right']: { deltaX: 60 },
      });
    });

    it('should add elements to a container and bump orthogonal elements', () => {
      const newEnt = { id: 'new-ent', containerId: 'container', width: 50, height: 100 };

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [newEnt],
        layoutManager: new LayoutManager({ ...groupCase(), primaryDirection: 'down' }),
      });

      expect(Object.fromEntries(changes.additions)).toEqual({
        ['new-ent']: { ...newEnt, x: 120, y: 95 },
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        // Expand container
        container: { deltaWidth: 70 },
        // Bump orthogonal element by width
        ['rect-right']: { deltaX: 70 },
      });
    });

    it('should add elements to a container and not bump if no collision', () => {
      const newEnt = { id: 'new-ent', containerId: 'container', width: 50, height: 100 };

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [newEnt],
        layoutManager: new LayoutManager({
          entities: groupCase().entities.concat({
            id: 'rect-beyond-collision',
            x: 400,
            y: 100,
            width: 100,
            height: 100,
          }),
          connections: [],
          primaryDirection: 'down',
        }),
      });

      expect(changes.updates.has('rect-beyond-collision')).toBe(false);
    });

    it('should bump orthogonal elements that are partially in plane', () => {
      const newEntities = [{ id: 'new', containerId: 'container', width: 100, height: 100 }];

      // This entity is to the right of container and partly but not fully above it
      const partiallyInPlane = {
        id: 'rect-partially-in-plane',
        x: 160,
        y: -60,
        width: 100,
        height: 100,
      };

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities,
        layoutManager: new LayoutManager({
          entities: groupCase().entities.concat(partiallyInPlane),
          connections: [],
          primaryDirection: 'down',
        }),
      });

      expect(changes.updates.get('rect-partially-in-plane')).toEqual({
        deltaX: 120,
      });
    });

    it('should add elements to a nested container and bump orthogonal elements', () => {
      const newEnt = { id: 'new-ent', containerId: 'inner-container', width: 50, height: 50 };

      // Put rect-right further out, should not get bumped
      const entities = modifyEntity(nestedGroupCase().entities, 'rect-right', { x: 400 });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [newEnt],
        layoutManager: new LayoutManager({
          entities,
          connections: [],
          primaryDirection: 'down',
        }),
      });

      expect(Object.fromEntries(changes.additions)).toEqual({
        ['new-ent']: { ...newEnt, x: 120, y: 120 },
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        ['rect-outer-right']: { deltaX: 70 },
        ['inner-container']: { deltaWidth: 70 },
        ['outer-container']: { deltaWidth: 70 },
      });
    });

    it('should add elements to a container without expanding the container if there is room', () => {
      const entities = modifyEntity(groupCase().entities, 'container', () => ({ height: 450 }));

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [{ id: 'new-ent', width: 100, height: 100, containerId: 'container' }],
        layoutManager: new LayoutManager({
          entities,
          connections: [],
          primaryDirection: 'right',
        }),
      });

      expect(changes.additions.get('new-ent')).toMatchObject({
        x: 0,
        y: 320,
      });
      expect(changes.updates.has('container')).toBe(false);
    });

    it('should add elements to a container and expand by the smallest amount needed', () => {
      const entities = modifyEntity(groupCase().entities, 'container', () => ({ height: 400 }));

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        newEntities: [{ id: 'new-ent', width: 100, height: 100, containerId: 'container' }],
        layoutManager: new LayoutManager({
          entities,
          connections: [],
          primaryDirection: 'right',
        }),
      });

      expect(changes.additions.get('new-ent')).toMatchObject({
        x: 0,
        y: 320,
      });

      expect(changes.updates.get('container')).toEqual({
        deltaHeight: 50,
      });
    });
  });

  describe('movedEntities', () => {
    it('should move elements and shift things down', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager: new LayoutManager({ ...simpleCase(), primaryDirection: 'down' }),
        movedEntities: [{ id: 'rect200', newPlacement: { displaceId: 'rect0' } }],
      });

      // Swap rect200 up to the top and bump rect0 down
      expect(Object.fromEntries(changes.updates)).toEqual({
        rect0: { deltaY: 120 },
        rect200: { deltaY: -200 },
      });
    });

    it('should move elements and shift things right', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager: new LayoutManager({ ...simpleCase(), primaryDirection: 'right' }),
        movedEntities: [{ id: 'rect200', newPlacement: { displaceId: 'rect0' } }],
      });

      // Puts rect200 where rect0 is and bumps rect0 right
      expect(Object.fromEntries(changes.updates)).toEqual({
        rect0: { deltaX: 120 },
        rect200: { deltaY: -200 },
      });
    });

    it('should move elements to a group and bump orthogonal elements', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager: new LayoutManager({ ...groupCase(), primaryDirection: 'down' }),
        movedEntities: [{ id: 'rect-left', newContainerId: 'container' }],
      });

      // rect-left moves into the container, rect-right gets bumped, container expands
      expect(Object.fromEntries(changes.updates)).toEqual({
        container: { deltaWidth: 120 },
        ['rect-left']: { deltaX: 320, deltaY: -5, containerId: 'container' },
        ['rect-right']: { deltaX: 120 },
      });
    });

    it('should displace elements in a group, but not move the whole group', () => {
      const layoutManager = new LayoutManager({
        ...nestedGroupCase(),
        primaryDirection: 'down',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        movedEntities: [
          { id: 'rect-outer-left', newPlacement: { displaceId: 'rect-outer-right' } },
        ],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        ['rect-outer-left']: { deltaX: 275 },
        ['rect-outer-right']: { deltaY: 120 },
        // Shrinks because it no longer needs to adjust the left element
        ['outer-container']: { deltaWidth: -80, deltaX: 80 },
      });
    });

    it('should maintain distance for elements that are connected', () => {
      const layoutManager = new LayoutManager({
        entities: [
          { id: 'rect-moving', x: -100, y: 0, width: 100, height: 100 },
          { id: 'rect-from', x: 100, y: 0, width: 100, height: 100 },
          // Make this one far away - would not otherwise get bumped
          // But within the 200px margin for bumping connected entities
          { id: 'rect-to', x: 380, y: 0, width: 100, height: 100 },
        ],
        connections: [
          {
            id: 'connection',
            from: 'rect-from',
            to: 'rect-to',
            x: 200,
            y: 50,
            points: [
              [0, 0],
              [200, 0],
            ],
          },
        ],
        primaryDirection: 'right',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        movedEntities: [{ id: 'rect-moving', newPlacement: { displaceId: 'rect-from' } }],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        ['rect-moving']: { deltaX: 200 },
        ['rect-from']: { deltaX: 120 },
        ['rect-to']: { deltaX: 120 },
      });
    });

    it('should bump enough to fit a connection', () => {
      const layoutManager = new LayoutManager({
        ...simpleCase(),
        connections: [
          {
            id: 'connection',
            from: 'rect0',
            to: 'rect200',
            x: 50,
            y: 100,
            points: [
              [0, 0],
              [0, 100],
            ],
          },
        ],
        primaryDirection: 'down',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        movedEntities: [{ id: 'rect0', newPlacement: { displaceId: 'rect200' } }],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        rect0: { deltaY: 200 },
        rect200: { deltaY: 160 }, // 100 height + 60 minConnectionLength
      });
    });
  });

  describe('modifyEntities', () => {
    it('should modify elements and bump as needed', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager: new LayoutManager({ ...simpleCase(), primaryDirection: 'down' }),
        modifiedEntities: [{ id: 'rect0', newHeight: 200 }],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        rect0: { deltaHeight: 100 },
        // Bump just enough to have the minimum margin
        rect200: { deltaY: 20 },
      });
    });

    it('should modify elements and not bump if smaller', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager: new LayoutManager({ ...simpleCase(), primaryDirection: 'down' }),
        modifiedEntities: [{ id: 'rect0', newHeight: 50 }],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        rect0: { deltaHeight: -50 },
      });
    });

    it('should modify elements and not bump if unneeded', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager: new LayoutManager({ ...simpleCase(), primaryDirection: 'down' }),
        modifiedEntities: [{ id: 'rect0', newHeight: 110 }],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        rect0: { deltaHeight: 10 },
      });
    });

    it('should unwrap a group, leaving entities in place', () => {
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager: new LayoutManager({ ...groupCase(), primaryDirection: 'down' }),
        modifiedEntities: [{ id: 'container', newIsContainer: false }],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        container: { deltaX: -20, deltaY: 540, isContainer: false },
        rect200: { containerId: null },
        rect0: { containerId: null },
      });
    });
  });

  describe('container complexities', () => {
    it('should handle entities added to a node turned into a container', () => {
      const layoutManager = new LayoutManager({
        entities: simpleCase().entities,
        connections: [],
        primaryDirection: 'down',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        modifiedEntities: [{ id: 'rect0', newIsContainer: true }],
        newEntities: [{ id: 'new-ent', width: 100, height: 100, containerId: 'rect0' }],
      });

      expect(changes.additions.get('new-ent')?.containerId).toBe('rect0');
    });

    it('should create a group around multiple existing elements', () => {
      const layoutManager = new LayoutManager({
        entities: [...simpleCase().entities, { id: 'rect-further-down', x: 0, y: 400 }],
        connections: [],
        primaryDirection: 'down',
      });

      // Move two existing elements into the new container
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        newEntities: [
          {
            id: 'new-container',
            isContainer: true,
            width: 50,
            height: 50,
            placement: { aroundIds: ['rect0', 'rect200'] },
          },
        ],
        movedEntities: [
          { id: 'rect0', newContainerId: 'new-container' },
          { id: 'rect200', newContainerId: 'new-container' },
        ],
      });

      // The existing entities should not move, just get added
      expect(Object.fromEntries(changes.updates)).toEqual({
        rect0: { containerId: 'new-container' },
        rect200: { containerId: 'new-container' },
      });

      // New container should be wrapped around the existing entities and have width and height expanded
      expect(changes.additions.get('new-container')).toEqual({
        id: 'new-container',
        isContainer: true,
        x: -20,
        y: -20,
        width: 130,
        height: 330,
      });
    });

    it('should create a group around multiple existing elements and bump in every direction', () => {
      const layoutManager = new LayoutManager({
        entities: [
          { id: 'a', x: 0, y: 0, width: 100, height: 100 },
          { id: 'b', x: 120, y: 0, width: 100, height: 100 },
          { id: 'left', x: -120, y: 0, width: 100, height: 100 },
          { id: 'right', x: 240, y: 0, width: 100, height: 100 },
          { id: 'top', x: 0, y: -120, width: 100, height: 100 },
          { id: 'bottom', x: 0, y: 120, width: 100, height: 100 },
        ],
        connections: [],
        primaryDirection: 'right',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        newEntities: [
          {
            id: 'container',
            isContainer: true,
            width: 50,
            height: 50,
            placement: { aroundIds: ['a', 'b'] },
          },
        ],
        movedEntities: [
          { id: 'a', newContainerId: 'container' },
          { id: 'b', newContainerId: 'container' },
        ],
      });

      expect(changes.additions.get('container')).toEqual({
        id: 'container',
        isContainer: true,
        x: -20,
        y: -20,
        width: 250,
        height: 130,
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        a: { containerId: 'container' },
        b: { containerId: 'container' },
        right: { deltaX: 10 },
        bottom: { deltaY: 10 },
        // Extra padding bumps these extra
        top: { deltaY: -20 },
        left: { deltaX: -20 },
      });
    });

    it('should move multiple elements into a group, respecting their relative position', () => {
      const layoutManager = new LayoutManager({
        entities: [
          ...simpleCase().entities,
          // Make it tall enough it does not have to expand
          { id: 'container', x: 0, y: 400, width: 300, height: 500 },
        ],
        connections: [],
        primaryDirection: 'down',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        movedEntities: [
          { id: 'rect0', newContainerId: 'container' },
          { id: 'rect200', newContainerId: 'container' },
        ],
      });

      expect(changes.updates.get('rect0')?.deltaY).toBe(changes.updates.get('rect200')?.deltaY);
      expect(changes.updates.get('rect0')?.deltaX).toBe(changes.updates.get('rect200')?.deltaX);
    });

    it('should move elements into a group and bump in both directions if needed', () => {
      const layoutManager = new LayoutManager({
        entities: [
          { id: 'container', x: 0, y: 0, width: 60, height: 60 },
          { id: 'rect-right', x: 80, y: 0, width: 100, height: 100 },
          { id: 'rect-below', x: 0, y: 80, width: 100, height: 100 },
          // We will move these into container, we want them to be top left / bottom right oriented
          // Either one might fit, but together they do not
          { id: 'a', x: -100, y: -100, width: 25, height: 25 },
          { id: 'b', x: -50, y: -50, width: 25, height: 25 },
        ],
        connections: [],
        primaryDirection: 'down',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        movedEntities: [
          { id: 'a', newContainerId: 'container' },
          { id: 'b', newContainerId: 'container' },
        ],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        a: { deltaX: 120, deltaY: 120, containerId: 'container' },
        b: { deltaX: 120, deltaY: 120, containerId: 'container' },
        container: { deltaWidth: 45, deltaHeight: 45 },
        // TODO: It's probably nice for these to be the same since everything is symmetric
        ['rect-below']: { deltaY: 35 },
        ['rect-right']: { deltaX: 45 },
      });
    });

    it('should keep elements where they are if a group is being unwrapped', () => {
      const layoutManager = new LayoutManager({
        ...groupCase(),
        primaryDirection: 'down',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        movedEntities: [
          { id: 'rect0', newContainerId: null },
          { id: 'rect200', newContainerId: null },
        ],
        deletedEntities: [{ id: 'container' }],
      });

      // No change in x / y
      expect(Object.fromEntries(changes.updates)).toEqual({
        rect0: { containerId: null },
        rect200: { containerId: null },
      });
    });

    it('should add new entities and group them without overlapping existing entities', () => {
      // Start with existing entities from simpleCase
      const layoutManager = new LayoutManager({
        ...simpleCase(),
        primaryDirection: 'down',
        options: {
          marginBetweenEntities: 40,
          containerPadding: {
            top: 50,
            right: 20,
            bottom: 20,
            left: 20,
          },
          minConnectionLength: 80,
          minConnectionTextMargin: 40,
        },
      });

      // Add new entities C and D, and a group around them
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        newEntities: [
          {
            id: 'C',
            width: 100,
            height: 50,
            containerId: 'Group',
          },
          {
            id: 'D',
            width: 100,
            height: 50,
            containerId: 'Group',
          },
          {
            id: 'Group',
            width: 100,
            height: 50,
            isContainer: true,
            placement: {
              aroundIds: ['C', 'D'],
            },
          },
        ],
      });

      // New entities C and D should be placed below existing entities
      const entityC = changes.additions.get('C');
      const entityD = changes.additions.get('D');
      const group = changes.additions.get('Group');

      expect(entityC).toBeDefined();
      expect(entityD).toBeDefined();
      expect(group).toBeDefined();

      // The new entities should be positioned below the existing entities (y >= 320)
      // simpleCase has rect0 at y=0 height=100, rect200 at y=200 height=100, so next available is y=320
      expect(entityC!.y).toBeGreaterThanOrEqual(320);
      expect(entityD!.y).toBeGreaterThanOrEqual(320);

      // The group should encompass C and D and not overlap with existing entities
      // Group should be positioned such that it doesn't overlap with rect0 (y=0-100) or rect200 (y=200-300)
      expect(group!.y).toBeGreaterThanOrEqual(300); // Should be below existing entities with some margin

      // Group should contain both C and D
      const groupMinX = Math.min(entityC!.x, entityD!.x);
      const groupMaxX = Math.max(entityC!.x + entityC!.width, entityD!.x + entityD!.width);
      const groupMinY = Math.min(entityC!.y, entityD!.y);
      const groupMaxY = Math.max(entityC!.y + entityC!.height, entityD!.y + entityD!.height);

      // Group should encompass the entities with padding
      expect(group!.x).toBeLessThanOrEqual(groupMinX);
      expect(group!.y).toBeLessThanOrEqual(groupMinY);
      expect(group!.x + group!.width).toBeGreaterThanOrEqual(groupMaxX);
      expect(group!.y + group!.height).toBeGreaterThanOrEqual(groupMaxY);

      // Verify no existing entities were bumped (this is the bug we're testing for)
      expect(changes.updates.has('rect0')).toBe(false);
      expect(changes.updates.has('rect200')).toBe(false);
    });
  });

  describe('connection complexities', () => {
    it('should bump connected entities and cascade those bumps', () => {
      const layoutManager = new LayoutManager({
        entities: [
          simpleEntity('bumper', { x: -100 }),
          simpleEntity('from', { x: 0 }),
          simpleEntity('to', { x: 200 }),
          simpleEntity('cascadeBumpee', { x: 250 }),
        ],
        connections: [
          {
            id: 'from-to',
            from: 'from',
            to: 'to',
            x: 50,
            y: 25,
            points: [
              [0, 0],
              [150, 0],
            ],
          },
        ],
        primaryDirection: 'right',
      });

      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        movedEntities: [
          {
            id: 'bumper',
            newPlacement: {
              displaceId: 'from',
            },
          },
        ],
      });

      expect(Object.fromEntries(changes.updates)).toEqual({
        bumper: { deltaX: 100 },
        from: { deltaX: 70 },
        to: { deltaX: 70 },
        cascadeBumpee: { deltaX: 70 },
      });
    });
  });

  describe('edge cases', () => {
    it('should handle out of order operations', () => {
      const layoutManager = new LayoutManager({
        entities: groupCase().entities,
        connections: [],
        primaryDirection: 'down',
      });

      // Make a bunch of changes out of order
      // Most of the test is just that this runs without errors
      const changes = generateChanges({
        routing: { repair: COMMIT_REPAIR },
        layoutManager,
        newEntities: [
          { id: 'unrelated-ent', width: 100, height: 100 },
          { id: 'unrelated-container', width: 200, height: 200, isContainer: true },
          { id: 'ent', width: 100, height: 100, containerId: 'inner-container' },
          { id: 'ent-in-container', width: 100, height: 100, containerId: 'container' },
          {
            id: 'inner-container',
            width: 100,
            height: 100,
            isContainer: true,
            containerId: 'container',
          },
          {
            id: 'outer-container',
            width: 100,
            height: 100,
            isContainer: true,
          },
        ],
        movedEntities: [
          { id: 'container', newContainerId: 'outer-container' },
          { id: 'rect-below', newContainerId: 'outer-container' },
          { id: 'rect0', newContainerId: 'inner-container' },
        ],
      });

      // Sanity checks to see that some things were added in the correct order
      expect(changes.additions.get('unrelated-ent')?.y).toBeLessThan(
        changes.additions.get('unrelated-container')?.y ?? 0,
      );

      expect(changes.additions.get('ent-in-container')?.x).toBeLessThan(
        changes.additions.get('inner-container')?.x ?? 0,
      );

      // Sanity checks that items were added to the correct containers
      expect(changes.additions.get('inner-container')?.containerId).toBe('container');
      expect(changes.additions.get('ent')?.containerId).toBe('inner-container');
      expect(changes.additions.get('ent-in-container')?.containerId).toBe('container');
      expect(changes.updates.get('container')?.containerId).toBe('outer-container');
      expect(changes.updates.get('rect-below')?.containerId).toBe('outer-container');
    });
  });
});

describe('generateChangesForMove', () => {
  it('should handle a basic move', () => {
    const layoutManager = new LayoutManager({
      entities: simpleCase().entities,
      connections: [],
      primaryDirection: 'down',
    });

    const changes = generateChangesForMove(
      layoutManager,
      new Set(['rect0']),
      {
        deltaX: 10,
        deltaY: 10,
      },
      { repair: COMMIT_REPAIR },
    );

    expect(Object.fromEntries(changes.entityUpdates)).toEqual({
      rect0: { deltaX: 10, deltaY: 10 },
    });
  });

  it('should expand a container if needed', () => {
    const layoutManager = new LayoutManager({
      entities: groupCase().entities,
      connections: [],
      primaryDirection: 'down',
    });

    const changes = generateChangesForMove(
      layoutManager,
      new Set(['rect0']),
      {
        deltaX: 0,
        deltaY: -100,
      },
      { repair: COMMIT_REPAIR },
    );

    expect(Object.fromEntries(changes.entityUpdates)).toEqual({
      rect0: { deltaX: 0, deltaY: -100 },
      // Expand up by 100 and expand height by 100 to fit rect0
      container: { deltaY: -100, deltaHeight: 100 },
    });
  });

  it('should return now updates if the move causes an expansion overlap', () => {
    const layoutManager = new LayoutManager({
      entities: groupCase().entities,
      connections: [],
      primaryDirection: 'down',
    });

    const changes = generateChangesForMove(
      layoutManager,
      new Set(['rect0']),
      {
        deltaX: 0,
        deltaY: -300,
      },
      { repair: COMMIT_REPAIR },
    );

    expect(Object.fromEntries(changes.entityUpdates)).toEqual({});
  });

  it('should recursively expand parent containers', () => {
    const entities = [
      ...groupCase().entities,
      {
        id: 'outer-container',
        x: -40,
        y: -40,
        width: 160,
        height: 360,
        isContainer: true,
      },
    ];
    modifyEntity(entities, 'container', { containerId: 'outer-container' });

    const layoutManager = new LayoutManager({
      entities,
      connections: [],
      primaryDirection: 'down',
    });

    const changes = generateChangesForMove(
      layoutManager,
      new Set(['rect0']),
      {
        deltaX: 0,
        deltaY: -100,
      },
      { repair: COMMIT_REPAIR },
    );

    expect(Object.fromEntries(changes.entityUpdates)).toEqual({
      rect0: { deltaX: 0, deltaY: -100 },
      container: { deltaY: -100, deltaHeight: 100 },
      'outer-container': { deltaY: -100, deltaHeight: 100 },
    });
  });

  it('should not resize container when interior node moves without changing bounds', () => {
    // Create a container with multiple nodes where one node is well inside
    // (not at any edge). Moving it should not cause container resize.
    const entities: LayoutEntity[] = [
      {
        id: 'container',
        isContainer: true,
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        options: { sizingMode: 'auto' },
      },
      {
        id: 'node-top-left',
        x: 50,
        y: 50,
        width: 100,
        height: 100,
        containerId: 'container',
      },
      {
        id: 'node-top-right',
        x: 350,
        y: 50,
        width: 100,
        height: 100,
        containerId: 'container',
      },
      {
        id: 'node-bottom-left',
        x: 50,
        y: 350,
        width: 100,
        height: 100,
        containerId: 'container',
      },
      {
        id: 'node-bottom-right',
        x: 350,
        y: 350,
        width: 100,
        height: 100,
        containerId: 'container',
      },
      {
        id: 'node-interior',
        x: 200,
        y: 200,
        width: 100,
        height: 100,
        containerId: 'container',
      },
    ];

    const layoutManager = new LayoutManager({
      entities,
      connections: [],
      primaryDirection: 'down',
    });

    // Move the interior node - it's not at any edge, so container bounds shouldn't change
    const changes = generateChangesForMove(
      layoutManager,
      new Set(['node-interior']),
      {
        deltaX: 20,
        deltaY: 30,
      },
      { repair: COMMIT_REPAIR },
    );

    // The interior node should move, but container should NOT resize
    expect(Object.fromEntries(changes.entityUpdates)).toEqual({
      'node-interior': { deltaX: 20, deltaY: 30 },
      // Container should NOT be in the updates
    });
    expect(changes.entityUpdates.has('container')).toBe(false);
  });

  it('should resize container when interior node moves to an edge', () => {
    // Similar setup, but this time move the interior node to an edge position
    const entities: LayoutEntity[] = [
      {
        id: 'container',
        isContainer: true,
        x: 0,
        y: 0,
        width: 500,
        height: 500,
        options: { sizingMode: 'auto' },
      },
      {
        id: 'node-top-left',
        x: 50,
        y: 50,
        width: 100,
        height: 100,
        containerId: 'container',
      },
      {
        id: 'node-top-right',
        x: 350,
        y: 50,
        width: 100,
        height: 100,
        containerId: 'container',
      },
      {
        id: 'node-bottom-left',
        x: 50,
        y: 350,
        width: 100,
        height: 100,
        containerId: 'container',
      },
      {
        id: 'node-interior',
        x: 200,
        y: 200,
        width: 100,
        height: 100,
        containerId: 'container',
      },
    ];

    const layoutManager = new LayoutManager({
      entities,
      connections: [],
      primaryDirection: 'down',
    });

    // Move the interior node to the right edge (beyond node-top-right)
    const changes = generateChangesForMove(
      layoutManager,
      new Set(['node-interior']),
      {
        deltaX: 200, // Moves it to x=400, which extends beyond node-top-right at x=350+100=450
        deltaY: 0,
      },
      { repair: COMMIT_REPAIR },
    );

    // Container should expand to accommodate the new right edge
    expect(changes.entityUpdates.has('node-interior')).toBe(true);
    expect(changes.entityUpdates.has('container')).toBe(true);
    const containerUpdate = changes.entityUpdates.get('container');
    expect(containerUpdate).toBeDefined();
    // Should expand width (deltaWidth > 0) or shift/expand to accommodate
    expect(containerUpdate!.deltaWidth !== undefined || containerUpdate!.deltaX !== undefined).toBe(
      true,
    );
  });
});

/** Helper to modify a default entity from the test data */
function modifyEntity(
  entities: LayoutEntity[],
  id: string,
  modifier: Partial<LayoutEntity> | ((entity: LayoutEntity) => Partial<LayoutEntity>),
): LayoutEntity[] {
  const entity = entities.find((e) => e.id === id);
  if (!entity) {
    return entities;
  }

  const updatedEntity = typeof modifier === 'function' ? modifier(entity) : modifier;
  Object.assign(entity, updatedEntity);

  return entities;
}
