import { LayoutManager } from '../../LayoutManager.js';
import { makeEntity } from '../../testUtils.js';
import type { LayoutConnection, LayoutEntity } from '../../types.js';
import { absoluteConnectionPoints } from '../points.js';
import { getShiftedConnection, SHIFT_THRESHOLD } from '../shiftRouting.js';
import type { Point } from '../types.js';

function fixture(points?: Point[], obstacles: LayoutEntity[] = []) {
  const connection: LayoutConnection = {
    id: 'route',
    from: 'source',
    to: 'target',
    x: 100,
    y: 25,
    points: points ?? [
      [0, 0],
      [150, 0],
      [150, 100],
      [450, 100],
      [450, 200],
      [600, 200],
    ],
    relativeFromPort: [1, 0.5],
    relativeToPort: [0, 0.5],
  };
  // Staging copies connection objects, not their point tuples. Freeze the actual
  // initial tuples so both accepted and rejected candidates must be copy-on-write.
  for (const point of connection.points) {
    Object.freeze(point);
  }
  Object.freeze(connection.points);
  const layoutManager = new LayoutManager({
    entities: [
      makeEntity('source', { x: 0, y: 0 }),
      makeEntity('target', { x: 700, y: 200 }),
      ...obstacles,
    ],
    connections: [connection],
    primaryDirection: 'right',
  });
  return { connection, layoutManager };
}

describe('shared shift routing', () => {
  it.each(['source', 'target'] as const)(
    'shifts the %s terminal while preserving distant bends and the initial snapshot',
    (movingEntity) => {
      const { connection, layoutManager } = fixture();
      const initialPoints = absoluteConnectionPoints(connection);
      layoutManager.updateEntity(movingEntity, { deltaX: -20, deltaY: 10 });

      const result = getShiftedConnection(layoutManager, connection, {
        from: movingEntity === 'source' ? [80, 35] : [100, 25],
        to: movingEntity === 'target' ? [680, 235] : [700, 225],
      });

      expect(absoluteConnectionPoints(result!)).toEqual(
        movingEntity === 'source'
          ? [[80, 35], [250, 35], ...initialPoints.slice(2)]
          : [...initialPoints.slice(0, -2), [550, 235], [680, 235]],
      );
      expect(
        absoluteConnectionPoints(layoutManager.getConnectionById(connection.id, false)!),
      ).toEqual(initialPoints);
      for (const point of result!.points) {
        expect(connection.points).not.toContain(point);
      }
      expect(layoutManager.stagedChanges?.updatedConnections.size).toBe(0);
    },
  );

  it.each(['source', 'target'] as const)(
    'accepts a %s move of exactly the Manhattan shift threshold and rejects one pixel more',
    (movingEntity) => {
      const deltaY = 100;
      const atThreshold = SHIFT_THRESHOLD - deltaY;
      for (const deltaX of [atThreshold, atThreshold + 1]) {
        const { connection, layoutManager } = fixture();
        const sign = movingEntity === 'source' ? -1 : 1;
        layoutManager.updateEntity(movingEntity, { deltaX: sign * deltaX, deltaY: sign * deltaY });
        const result = getShiftedConnection(layoutManager, connection, {
          from: movingEntity === 'source' ? [100 - deltaX, 25 - deltaY] : [100, 25],
          to: movingEntity === 'target' ? [700 + deltaX, 225 + deltaY] : [700, 225],
        });
        if (deltaX === atThreshold) {
          expect(result).toBeDefined();
        } else {
          expect(result).toBeUndefined();
        }
      }
    },
  );

  it('propagates a partial contraction backward while keeping the terminal at its minimum length', () => {
    const { connection, layoutManager } = fixture([
      [0, 0],
      [200, 0],
      [200, 100],
      [570, 100],
      [570, 200],
      [600, 200],
    ]);
    layoutManager.updateEntity('target', { deltaX: -100, deltaY: 10 });

    const result = getShiftedConnection(layoutManager, connection, {
      from: [100, 25],
      to: [600, 235],
    });

    expect(result).toMatchObject({
      points: [
        [0, 0],
        [200, 0],
        [200, 100],
        [470, 100],
        [470, 210],
        [500, 210],
      ],
    });
    expect(connection.points.at(-1)).toEqual([600, 200]);
  });

  it.each(['source', 'target'] as const)(
    'rejects an obstacle intersecting the shifted %s terminal without mutating the baseline',
    (movingEntity) => {
      const obstacle = makeEntity(
        'obstacle',
        movingEntity === 'source' ? { x: 150, y: 30 } : { x: 620, y: 230 },
        { width: 20, height: 20 },
      );
      const { connection, layoutManager } = fixture(undefined, [obstacle]);
      const initialPoints = absoluteConnectionPoints(connection);
      layoutManager.updateEntity(movingEntity, { deltaX: -20, deltaY: 10 });

      expect(
        getShiftedConnection(layoutManager, connection, {
          from: movingEntity === 'source' ? [80, 35] : [100, 25],
          to: movingEntity === 'target' ? [680, 235] : [700, 225],
        }),
      ).toBeUndefined();
      expect(
        absoluteConnectionPoints(layoutManager.getConnectionById(connection.id, false)!),
      ).toEqual(initialPoints);
      expect(layoutManager.stagedChanges?.updatedConnections.size).toBe(0);
    },
  );

  it.each([false, true])(
    'rejects a terminal shift only through a third node caption (caption=%s)',
    (hasCaption) => {
      const icon = makeEntity(
        'icon',
        { x: 580, y: 230 },
        {
          width: 40,
          height: 40,
          ...(hasCaption && {
            textPlacement: { relativeX: -40, relativeY: 45, width: 120, height: 20 },
          }),
        },
      );
      const { connection, layoutManager } = fixture(
        [
          [0, 0],
          [450, 0],
          [450, 200],
          [600, 200],
        ],
        [icon],
      );
      layoutManager.updateEntity('target', { deltaY: 60 });

      const result = getShiftedConnection(layoutManager, connection);

      // The shifted terminal clears the icon body but runs through its caption.
      if (hasCaption) {
        expect(result).toBeUndefined();
      } else {
        expect(absoluteConnectionPoints(result!).slice(-2)).toEqual([
          [550, 285],
          [700, 285],
        ]);
      }
    },
  );

  it('rejects independent movement at both ends', () => {
    const { connection, layoutManager } = fixture();
    layoutManager.updateEntity('source', { deltaY: 10 });
    layoutManager.updateEntity('target', { deltaY: 20 });

    expect(
      getShiftedConnection(layoutManager, connection, { from: [100, 35], to: [700, 245] }),
    ).toBeUndefined();
  });

  it('rejects non-cardinal initial geometry', () => {
    const { connection, layoutManager } = fixture([
      [0, 0],
      [150, 0],
      [150, 90],
      [450, 100],
      [450, 200],
      [600, 200],
    ]);
    layoutManager.updateEntity('target', { deltaY: 10 });

    expect(
      getShiftedConnection(layoutManager, connection, { from: [100, 25], to: [700, 235] }),
    ).toBeUndefined();
  });

  it('preserves a stationary route through the public candidate pipeline', () => {
    const { connection, layoutManager } = fixture();

    expect(
      getShiftedConnection(layoutManager, connection, { from: [100, 25], to: [700, 225] }),
    ).toMatchObject({ x: 100, y: 25, points: connection.points });
  });

  it('keeps a rigid translation beyond the one-end deformation limit', () => {
    const { connection, layoutManager } = fixture();
    const deltaX = SHIFT_THRESHOLD + 100;
    layoutManager.updateEntity('source', { deltaX });
    layoutManager.updateEntity('target', { deltaX });

    expect(
      getShiftedConnection(layoutManager, connection, {
        from: [100 + deltaX, 25],
        to: [700 + deltaX, 225],
      }),
    ).toMatchObject({ x: 100 + deltaX, y: 25, points: connection.points });
  });
});
