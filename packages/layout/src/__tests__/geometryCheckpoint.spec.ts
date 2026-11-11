import { LayoutManager } from '../LayoutManager.js';
import { makeLayoutGeometry } from '../layoutGeometry.js';
import type { LayoutEntity } from '../types.js';

const box = (id: string, x = 0, containerId?: string): LayoutEntity => ({
  id,
  x,
  y: 0,
  width: 100,
  height: 80,
  containerId,
});
const makeLayout = () =>
  new LayoutManager({
    entities: [
      box('a', 0.1),
      box('b', 200),
      { ...box('group'), isContainer: true },
      box('child', 20, 'group'),
    ],
    connections: [{ id: 'line', from: 'a', to: 'b', connectorStyle: 'arc', bend: 15 }],
  });

describe('geometry checkpoints', () => {
  it('reports replacement-frame deltas while retaining the gesture baseline', () => {
    const layout = makeLayout();
    const baseline = makeLayoutGeometry(layout.getEntities());
    const gesture = layout.geometryCheckpoint();
    layout.updateEntity('a', { deltaX: 100 });
    layout.updateEntity('b', { deltaX: 50 });
    const preview = layout.geometryCheckpoint();
    layout.restoreGeometryTo(gesture);
    layout.updateEntity('a', { deltaX: 20 });
    expect(layout.changesSince(preview)).toEqual(
      new Map([
        ['a', { deltaX: -80 }],
        ['b', { deltaX: -50 }],
      ]),
    );
    expect(layout.changesSince(gesture)).toEqual(new Map([['a', { deltaX: 20 }]]));
    layout.release(preview);
    layout.restoreGeometryTo(gesture);
    expect(makeLayoutGeometry(layout.getEntities())).toEqual(baseline);
    expect(layout.changesSince(gesture).size).toBe(0);
    layout.release(gesture);
  });

  it('reuses a journal over many frames, including a committed staged state', () => {
    const layout = makeLayout();
    const gesture = layout.geometryCheckpoint();
    for (let i = 1; i <= 100; i++) {
      const preview = layout.geometryCheckpoint();
      layout.restoreGeometryTo(gesture);
      layout.updateEntity('b', { deltaX: i });
      expect(layout.changesSince(preview)).toEqual(new Map([['b', { deltaX: 1 }]]));
      layout.release(preview);
    }
    layout.applyStagedChanges();
    layout.restoreGeometryTo(gesture);
    expect(layout.getEntityById('b')?.x).toBe(200);
    expect(layout.stagedChanges?.updates.get('b')?.deltaX).toBe(-100);
    layout.release(gesture);
  });

  it('preserves membership, additions and connections during a geometry-only restore', () => {
    const layout = makeLayout();
    const gesture = layout.geometryCheckpoint();
    layout.updateEntity('child', { deltaX: 40, containerId: null });
    layout.removeEntity('b');
    layout.addEntity(box('new'));
    layout.updateConnection('line', { bend: 30 });
    layout.restoreGeometryTo(gesture);
    expect(layout.getEntityById('child')).toMatchObject({ x: 20, containerId: null });
    expect(layout.getEntityById('b')).toBeUndefined();
    expect(layout.getEntityById('new')).toBeDefined();
    expect(layout.getConnectionById('line')?.bend).toBe(30);
    layout.release(gesture);
  });

  it('keeps full snapshots and forks independent of geometry journals', () => {
    const layout = makeLayout();
    const snapshot = layout.checkpoint('saved');
    const gesture = layout.geometryCheckpoint();
    layout.updateEntity('a', { deltaX: 50 });
    layout.updateConnection('line', { bend: 30 });
    const fork = layout.fork(snapshot);
    expect(fork.getEntityById('a')?.x).toBe(0.1);
    expect(fork.getConnectionById('line')?.bend).toBe(15);
    layout.revertTo(gesture);
    expect(layout.getConnectionById('line')?.bend).toBe(30);
    layout.restore(snapshot);
    expect(layout.getConnectionById('line')?.bend).toBe(15);
    expect(layout.hasCheckpoint(snapshot)).toBe(true);
    expect(layout.deleteCheckpoint(snapshot)).toBe(true);
  });

  it('restores exact fractional boxes and their spatial index', () => {
    const layout = makeLayout();
    const range = { minX: 0.1, maxX: 0.1, minY: 1, maxY: 2 };
    expect(layout.findLeafEntitiesInRange(range).map(({ id }) => id)).toEqual(['a']);
    const gesture = layout.geometryCheckpoint();
    layout.updateEntity('a', { deltaX: 13.38 });
    layout.restoreGeometryTo(gesture);
    expect(layout.getEntityById('a')?.x).toBe(0.1);
    expect(layout.findLeafEntitiesInRange(range).map(({ id }) => id)).toEqual(['a']);
    layout.updateEntity('a', { deltaX: 13.38 });
    layout.revertTo(gesture);
    expect(layout.getEntityById('a')?.x).toBe(0.1);
  });

  it('restores removed/recreated entities, container members and pending accounting', () => {
    const layout = makeLayout();
    layout.updateEntity('child', { deltaX: 3 });
    const gesture = layout.geometryCheckpoint();
    layout.updateEntity('child', { deltaX: 10 });
    layout.removeEntity('child');
    layout.addEntity({ ...box('child', 900), width: 999 });
    layout.removeEntity('group');
    layout.addEntity(box('new'));
    layout.revertTo(gesture);
    expect(layout.getEntityById('child')).toMatchObject({
      x: 23,
      width: 100,
      containerId: 'group',
    });
    expect([...layout.getChildIds('group')!]).toEqual(['child']);
    expect(layout.getAllContainerIds('child')).toEqual(['group']);
    expect(layout.getEntityById('new')).toBeUndefined();
    expect(layout.stagedChanges?.updates).toEqual(new Map([['child', { deltaX: 3 }]]));
    expect(layout.stagedChanges?.additions.size).toBe(0);
    expect(layout.stagedChanges?.deletes.size).toBe(0);
  });

  it('releases a middle journal without invalidating outer or inner rollback', () => {
    const layout = makeLayout();
    const outer = layout.geometryCheckpoint();
    layout.addEntity(box('new'));
    const middle = layout.geometryCheckpoint();
    layout.updateEntity('b', { deltaX: 10 });
    const inner = layout.geometryCheckpoint();
    layout.removeEntity('new');
    layout.updateEntity('b', { deltaX: 20 });
    layout.release(middle);
    layout.revertTo(inner);
    expect(layout.getEntityById('new')).toBeDefined();
    expect(layout.getEntityById('b')?.x).toBe(210);
    layout.revertTo(outer);
    expect(layout.getEntityById('new')).toBeUndefined();
    expect(layout.getEntityById('b')?.x).toBe(200);
    expect(() => layout.changesSince(middle)).toThrow();
  });

  it.each(['false', 'throw'] as const)(
    'rolls back failed attempts (%s) without leaking a journal',
    (failure) => {
      const layout = makeLayout();
      const edit = () =>
        layout.attempt(() => {
          layout.updateEntity('a', { deltaX: 13.38 });
          if (failure === 'throw') {
            throw new Error('failed');
          }
          return false;
        });
      if (failure === 'throw') {
        expect(edit).toThrow('failed');
      } else {
        expect(edit()).toBeUndefined();
      }
      expect(layout.getEntityById('a')?.x).toBe(0.1);
      expect(layout.stagedChanges?.updates.size).toBe(0);
      expect(() => layout.setEntityOptions('a', { sizingMode: 'manual' })).not.toThrow();
    },
  );

  it('returns only net geometry changes from a successful attempt', () => {
    const layout = makeLayout();
    const changes = layout.attempt(() => {
      layout.updateEntity('b', { deltaX: 30 });
      layout.updateEntity('a', { deltaX: 10 });
      layout.updateEntity('a', { deltaX: -10 });
      layout.addEntity(box('new'));
      layout.removeEntity('child');
      return true;
    });
    expect(changes).toEqual(new Map([['b', { deltaX: 30 }]]));
  });
});

describe('session policy and visual queries', () => {
  it('keeps configured options separate from forkable session overrides', () => {
    const layout = new LayoutManager({
      entities: [{ ...box('a'), options: { marginBetweenEntities: 25 } }],
      connections: [],
      options: { marginBetweenEntities: 50 },
    });
    const entity = layout.getEntityById('a')!;
    expect(layout.getEntityOptions(entity).marginBetweenEntities).toBe(25);
    layout.setEntityOptions('a', { marginBetweenEntities: 12 });
    expect(layout.getEntityOptions(entity).marginBetweenEntities).toBe(12);
    expect(layout.getConfiguredOption(entity, 'marginBetweenEntities')).toBe(25);
    expect(layout.stagedChanges).toBeUndefined();
    const fork = layout.fork();
    fork.setEntityOptions('a', { marginBetweenEntities: 7 });
    expect(layout.getEntityOption(entity, 'marginBetweenEntities')).toBe(12);
    expect(fork.getEntityOption(entity, 'marginBetweenEntities')).toBe(7);
    const checkpoint = layout.geometryCheckpoint();
    expect(() => layout.setEntityOptions('a', { marginBetweenEntities: 8 })).toThrow();
    layout.release(checkpoint);
  });

  it('finds labels outside body bounds without changing default range queries', () => {
    const layout = new LayoutManager({
      entities: [
        { ...box('a'), textPlacement: { relativeX: 110, relativeY: 0, width: 50, height: 20 } },
      ],
      connections: [],
    });
    const range = { minX: 120, maxX: 130, minY: 1, maxY: 2 };
    expect(layout.findEntitiesInRange(range)).toEqual([]);
    expect(
      layout.findEntitiesInRange(range, undefined, true, 'visual').map(({ id }) => id),
    ).toEqual(['a']);
  });
});
