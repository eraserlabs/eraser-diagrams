import { LayoutManager } from '../LayoutManager.js';
import { DEFAULT_OPTIONS } from '../constants.js';
import type { LayoutConnection, LayoutEntity } from '../types.js';

function makeEntities(): LayoutEntity[] {
  return [
    { id: 'A', x: 0, y: 0, width: 100, height: 80 },
    { id: 'B', x: 150, y: 0, width: 120, height: 60 },
    { id: 'C', x: 0, y: 100, width: 80, height: 100, containerId: 'parent' },
    { id: 'parent', x: 0, y: 100, width: 200, height: 200, isContainer: true },
  ];
}

function makeEntitiesWithSecondParent(): LayoutEntity[] {
  return [
    ...makeEntities(),
    { id: 'other-parent', x: 300, y: 100, width: 200, height: 200, isContainer: true },
  ];
}

function makeLM(entities = makeEntities()): LayoutManager {
  return new LayoutManager({
    entities,
    connections: [],
    options: DEFAULT_OPTIONS,
  });
}

function sortedIds(ids: Iterable<string> | undefined): string[] {
  return [...(ids ?? [])].sort();
}

describe('LayoutManager checkpoint/fork/restore', () => {
  describe('checkpoint', () => {
    it('returns a checkpoint ID', () => {
      const lm = makeLM();
      const id = lm.checkpoint();
      expect(typeof id).toBe('string');
    });

    it('accepts a custom label', () => {
      const lm = makeLM();
      const id = lm.checkpoint('my-checkpoint');
      expect(id).toBe('my-checkpoint');
      expect(lm.hasCheckpoint('my-checkpoint')).toBe(true);
    });

    it('auto-generates unique IDs', () => {
      const lm = makeLM();
      const id1 = lm.checkpoint();
      const id2 = lm.checkpoint();
      expect(id1).not.toBe(id2);
    });

    it('captures staged state when available', () => {
      const lm = makeLM();
      lm.updateEntity('A', { deltaX: 50 });
      const cpId = lm.checkpoint();

      // The checkpoint should have captured A at x=50
      const fork = lm.fork(cpId);
      const a = fork.getEntityById('A');
      expect(a?.x).toBe(50);
    });

    it('captures base state when no staged changes', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();

      const fork = lm.fork(cpId);
      const a = fork.getEntityById('A');
      expect(a?.x).toBe(0);
    });
  });

  describe('fork', () => {
    it('creates an independent LayoutManager', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();
      const fork = lm.fork(cpId);

      // Mutate the fork
      fork.updateEntity('A', { deltaX: 200 });

      // Original should be unaffected
      expect(lm.getEntityById('A')?.x).toBe(0);
      expect(fork.getEntityById('A')?.x).toBe(200);
    });

    it('preserves container relationships', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();
      const fork = lm.fork(cpId);

      const childIds = fork.getChildIds('parent');
      expect(childIds?.has('C')).toBe(true);
    });

    it('preserves options', () => {
      const lm = new LayoutManager({
        entities: makeEntities(),
        connections: [],
        options: { ...DEFAULT_OPTIONS, marginBetweenEntities: 99 },
      });
      const fork = lm.fork();
      expect(fork.options.marginBetweenEntities).toBe(99);
    });

    it('forks from current state when no checkpoint ID given', () => {
      const lm = makeLM();
      lm.updateEntity('A', { deltaX: 75 });

      const fork = lm.fork();
      expect(fork.getEntityById('A')?.x).toBe(75);
    });

    it('fork mutations do not affect the checkpoint', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();

      const fork1 = lm.fork(cpId);
      fork1.updateEntity('A', { deltaX: 100 });

      // Fork again from same checkpoint — should still be at original position
      const fork2 = lm.fork(cpId);
      expect(fork2.getEntityById('A')?.x).toBe(0);
    });

    it('forks independently after the source spatial tree has been materialized', () => {
      const lm = makeLM();
      const originalRange = { minX: -1, minY: -1, maxX: 101, maxY: 81 };
      const movedRange = { minX: 499, minY: -1, maxX: 601, maxY: 81 };

      // Materialize the source tree before checkpointing.
      expect(lm.findEntitiesInRange(originalRange).map((entity) => entity.id)).toEqual(['A']);

      const cpId = lm.checkpoint();
      const fork = lm.fork(cpId);

      fork.updateEntity('A', { deltaX: 500 });

      expect(lm.getEntityById('A')?.x).toBe(0);
      expect(fork.getEntityById('A')?.x).toBe(500);

      expect(lm.findEntitiesInRange(originalRange).map((entity) => entity.id)).toEqual(['A']);
      expect(lm.findEntitiesInRange(movedRange).map((entity) => entity.id)).toEqual([]);
      expect(fork.findEntitiesInRange(originalRange).map((entity) => entity.id)).toEqual([]);
      expect(fork.findEntitiesInRange(movedRange).map((entity) => entity.id)).toEqual(['A']);
    });

    it('forks leaf and container query state independently', () => {
      const lm = makeLM();
      const leafRange = { minX: 0, minY: 0, maxX: 100, maxY: 80 };
      const containerOnlyRange = { minX: 190, minY: 290, maxX: 195, maxY: 295 };

      expect(lm.findLeafEntitiesInRange(leafRange).map((entity) => entity.id)).toEqual(['A']);
      expect(lm.findContainersInRange(containerOnlyRange).map((entity) => entity.id)).toEqual([
        'parent',
      ]);

      const fork = lm.fork(lm.checkpoint());
      fork.updateEntity('A', { isContainer: true });
      fork.updateEntity('parent', { isContainer: false });

      expect(lm.findLeafEntitiesInRange(leafRange).map((entity) => entity.id)).toEqual(['A']);
      expect(lm.findContainersInRange(containerOnlyRange).map((entity) => entity.id)).toEqual([
        'parent',
      ]);
      expect(fork.findLeafEntitiesInRange(leafRange)).toEqual([]);
      expect(fork.findContainersInRange(leafRange).map((entity) => entity.id)).toEqual(['A']);
      expect(fork.findContainersInRange(containerOnlyRange)).toEqual([]);
      expect(fork.findLeafEntitiesInRange(containerOnlyRange).map((entity) => entity.id)).toEqual([
        'parent',
      ]);
    });

    it('forks connection mappings independently', () => {
      const lm = new LayoutManager({
        entities: makeEntities(),
        connections: [
          {
            id: 'A-to-B',
            from: 'A',
            to: 'B',
            x: 100,
            y: 40,
            points: [
              [0, 0],
              [50, 0],
            ],
          },
        ],
        options: DEFAULT_OPTIONS,
      });
      const cpId = lm.checkpoint();
      const fork = lm.fork(cpId);
      const forkOnlyConnection: LayoutConnection = {
        id: 'B-to-C',
        from: 'B',
        to: 'C',
        x: 270,
        y: 30,
        points: [
          [0, 0],
          [0, 70],
        ],
      };

      fork.addConnection(forkOnlyConnection);

      expect(lm.getConnectionMapping().B).toEqual(['A-to-B']);
      expect(lm.getConnectionById('B-to-C')).toBeUndefined();
      expect(fork.getConnectionMapping().B).toEqual(['A-to-B', 'B-to-C']);
      expect(fork.getConnectionById('B-to-C')).toEqual(forkOnlyConnection);
    });

    it('forks container and parent mappings independently when adding and reparenting children', () => {
      const lm = makeLM(makeEntitiesWithSecondParent());
      const cpId = lm.checkpoint();
      const fork = lm.fork(cpId);

      expect(lm.getContainerMapping()).not.toBe(fork.getContainerMapping());
      expect(lm.getContainerMapping().parent).not.toBe(fork.getContainerMapping().parent);
      expect(lm.getParentMapping()).not.toBe(fork.getParentMapping());
      expect(lm.getParentMapping().C).not.toBe(fork.getParentMapping().C);

      fork.addEntity({
        id: 'D',
        x: 40,
        y: 130,
        width: 50,
        height: 50,
        containerId: 'parent',
      } as LayoutEntity);
      fork.updateEntity('C', { containerId: 'other-parent' });

      expect(sortedIds(lm.getChildIds('parent'))).toEqual(['C']);
      expect(sortedIds(lm.getChildIds('other-parent'))).toEqual([]);
      expect(lm.getAllContainerIds('C')).toEqual(['parent']);
      expect(lm.getParentMapping().C).toEqual(['parent']);
      expect(lm.getParentMapping().D).toBeUndefined();

      expect(sortedIds(fork.getChildIds('parent'))).toEqual(['D']);
      expect(sortedIds(fork.getChildIds('other-parent'))).toEqual(['C']);
      expect(fork.getAllContainerIds('C')).toEqual(['other-parent']);
      expect(fork.getParentMapping().C).toEqual(['other-parent']);
      expect(fork.getParentMapping().D).toEqual(['parent']);
    });

    it('throws on invalid checkpoint ID', () => {
      const lm = makeLM();
      expect(() => lm.fork('nonexistent')).toThrow();
    });
  });

  describe('restore', () => {
    it('reverts staged state to checkpoint', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();

      // Make some changes
      lm.updateEntity('A', { deltaX: 300 });
      lm.updateEntity('B', { deltaY: 200 });
      expect(lm.getEntityById('A')?.x).toBe(300);

      // Restore
      lm.restore(cpId);
      expect(lm.getEntityById('A')?.x).toBe(0);
      expect(lm.getEntityById('B')?.y).toBe(0);
    });

    it('allows further mutations after restore', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();

      lm.updateEntity('A', { deltaX: 300 });
      lm.restore(cpId);
      lm.updateEntity('A', { deltaX: 50 });

      expect(lm.getEntityById('A')?.x).toBe(50);
    });

    it('preserves container mappings on restore', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();

      // Add a new entity to the container
      lm.addEntity({
        id: 'D',
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        containerId: 'parent',
      } as LayoutEntity);
      expect(lm.getChildIds('parent')?.has('D')).toBe(true);

      // Restore — D should be gone
      lm.restore(cpId);
      expect(lm.getEntityById('D')).toBeUndefined();
      expect(lm.getChildIds('parent')?.has('D')).toBeFalsy();
    });

    it('restores independently after the staged spatial tree has been materialized', () => {
      const lm = makeLM();
      const originalRange = { minX: -1, minY: -1, maxX: 101, maxY: 81 };
      const movedRange = { minX: 499, minY: -1, maxX: 601, maxY: 81 };

      // Materialize the base tree before checkpointing.
      expect(lm.findEntitiesInRange(originalRange).map((entity) => entity.id)).toEqual(['A']);

      const cpId = lm.checkpoint();
      lm.updateEntity('A', { deltaX: 500 });

      expect(lm.findEntitiesInRange(originalRange).map((entity) => entity.id)).toEqual([]);
      expect(lm.findEntitiesInRange(movedRange).map((entity) => entity.id)).toEqual(['A']);

      lm.restore(cpId);

      expect(lm.findEntitiesInRange(originalRange).map((entity) => entity.id)).toEqual(['A']);
      expect(lm.findEntitiesInRange(movedRange).map((entity) => entity.id)).toEqual([]);
    });

    it('restores the leaf tree and container set after entity type changes', () => {
      const lm = makeLM();
      const leafRange = { minX: 0, minY: 0, maxX: 100, maxY: 80 };
      const containerOnlyRange = { minX: 190, minY: 290, maxX: 195, maxY: 295 };

      // Materialize the leaf-only tree before checkpointing it.
      expect(lm.findLeafEntitiesInRange(leafRange).map((entity) => entity.id)).toEqual(['A']);
      const cpId = lm.checkpoint();

      lm.updateEntity('A', { isContainer: true });
      lm.updateEntity('parent', { isContainer: false });
      expect(lm.findLeafEntitiesInRange(leafRange)).toEqual([]);
      expect(lm.findContainersInRange(leafRange).map((entity) => entity.id)).toEqual(['A']);
      expect(lm.findLeafEntitiesInRange(containerOnlyRange).map((entity) => entity.id)).toEqual([
        'parent',
      ]);
      expect(lm.findContainersInRange(containerOnlyRange)).toEqual([]);

      lm.restore(cpId);

      expect(lm.findLeafEntitiesInRange(leafRange).map((entity) => entity.id)).toEqual(['A']);
      expect(lm.findContainersInRange(leafRange)).toEqual([]);
      expect(lm.findLeafEntitiesInRange(containerOnlyRange)).toEqual([]);
      expect(lm.findContainersInRange(containerOnlyRange).map((entity) => entity.id)).toEqual([
        'parent',
      ]);
    });

    it('restores container and parent mappings independently after adding and reparenting children', () => {
      const lm = makeLM(makeEntitiesWithSecondParent());
      const cpId = lm.checkpoint();

      lm.addEntity({
        id: 'D',
        x: 40,
        y: 130,
        width: 50,
        height: 50,
        containerId: 'parent',
      } as LayoutEntity);
      lm.updateEntity('C', { containerId: 'other-parent' });

      expect(sortedIds(lm.getChildIds('parent'))).toEqual(['D']);
      expect(sortedIds(lm.getChildIds('other-parent'))).toEqual(['C']);
      expect(lm.getParentMapping().C).toEqual(['other-parent']);
      expect(lm.getParentMapping().D).toEqual(['parent']);

      lm.restore(cpId);

      const baseContainerMapping = lm.getContainerMapping(false);
      const restoredContainerMapping = lm.getContainerMapping();
      const baseParentMapping = lm.getParentMapping(false);
      const restoredParentMapping = lm.getParentMapping();

      expect(restoredContainerMapping).not.toBe(baseContainerMapping);
      expect(restoredContainerMapping.parent).not.toBe(baseContainerMapping.parent);
      expect(restoredParentMapping).not.toBe(baseParentMapping);
      expect(restoredParentMapping.C).not.toBe(baseParentMapping.C);

      expect(sortedIds(lm.getChildIds('parent'))).toEqual(['C']);
      expect(sortedIds(lm.getChildIds('other-parent'))).toEqual([]);
      expect(lm.getAllContainerIds('C')).toEqual(['parent']);
      expect(lm.getEntityById('D')).toBeUndefined();
      expect(restoredParentMapping.C).toEqual(['parent']);
      expect(restoredParentMapping.D).toBeUndefined();
    });

    it('throws on invalid checkpoint ID', () => {
      const lm = makeLM();
      expect(() => lm.restore('nonexistent')).toThrow();
    });
  });

  describe('deleteCheckpoint', () => {
    it('removes the checkpoint', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();
      expect(lm.hasCheckpoint(cpId)).toBe(true);
      lm.deleteCheckpoint(cpId);
      expect(lm.hasCheckpoint(cpId)).toBe(false);
    });
  });

  describe('complex workflow', () => {
    it('checkpoint → mutate → checkpoint → restore first → works', () => {
      const lm = makeLM();
      const cp1 = lm.checkpoint('before');

      lm.updateEntity('A', { deltaX: 100 });
      const cp2 = lm.checkpoint('after-move');

      lm.updateEntity('A', { deltaX: 50 }); // now at 150
      expect(lm.getEntityById('A')?.x).toBe(150);

      // Restore to first checkpoint
      lm.restore(cp1);
      expect(lm.getEntityById('A')?.x).toBe(0);

      // Restore to second checkpoint
      lm.restore(cp2);
      expect(lm.getEntityById('A')?.x).toBe(100);
    });

    it('multiple forks from same checkpoint work independently', () => {
      const lm = makeLM();
      const cpId = lm.checkpoint();

      const fork1 = lm.fork(cpId);
      const fork2 = lm.fork(cpId);
      const fork3 = lm.fork(cpId);

      fork1.updateEntity('A', { deltaX: 10 });
      fork2.updateEntity('A', { deltaX: 20 });
      fork3.updateEntity('A', { deltaX: 30 });

      expect(fork1.getEntityById('A')?.x).toBe(10);
      expect(fork2.getEntityById('A')?.x).toBe(20);
      expect(fork3.getEntityById('A')?.x).toBe(30);
      expect(lm.getEntityById('A')?.x).toBe(0);
    });
  });
});
