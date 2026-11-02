import { LayoutManager } from '../../LayoutManager.js';
import { assignFaces } from '../faces.js';
import type { LayoutEntity } from '../../types.js';

describe('assignFaces sibling consensus', () => {
  it('carries a strict incoming face across diagonal siblings sharing a target', () => {
    const layoutManager = testLayoutManager([
      entity('client-aligned', 0, 0),
      entity('client-middle', 0, 120),
      entity('client-lower', 0, 240),
      entity('load-balancer', 300, 0, 'aws'),
      entity('bounds-marker', 0, 900),
    ]);
    const assignments = faces(layoutManager, [
      ['aligned', 'client-aligned', 'load-balancer'],
      ['middle', 'client-middle', 'load-balancer'],
      ['lower', 'client-lower', 'load-balancer'],
    ]);

    expect(assignments).toMatchObject([
      { from: 'right', to: 'left' },
      { from: 'right', to: 'left' },
      { from: 'right', to: 'left' },
    ]);
  });

  it('carries a strict outgoing face only to targets primarily on that side', () => {
    const layoutManager = testLayoutManager([
      entity('api', 0, 0, 'aws'),
      entity('aligned-service', 300, 0),
      entity('diagonal-service', 300, 100),
      entity('lower-service', -20, 300, 'aws'),
      entity('bounds-marker', 0, 900),
    ]);
    const assignments = faces(layoutManager, [
      ['aligned', 'api', 'aligned-service'],
      ['diagonal', 'api', 'diagonal-service'],
      ['lower', 'api', 'lower-service'],
    ]);

    expect(assignments).toMatchObject([
      { from: 'right', to: 'left' },
      { from: 'right', to: 'left' },
      { from: 'down', to: 'up' },
    ]);
  });

  it('keeps the diagram-aspect choice without an established sibling face', () => {
    const layoutManager = testLayoutManager([
      entity('source', 0, 0),
      entity('target', 300, 100),
      entity('bounds-marker', 0, 900),
    ]);

    expect(faces(layoutManager, [['route', 'source', 'target']])).toMatchObject([
      { from: 'down', to: 'up' },
    ]);
  });

  it('does not impose sibling consensus within one container', () => {
    const layoutManager = testLayoutManager([
      entity('aligned-source', 0, 0, 'group'),
      entity('diagonal-source', 0, 120, 'group'),
      entity('target', 300, 0, 'group'),
      entity('bounds-marker', 0, 900),
    ]);

    expect(
      faces(layoutManager, [
        ['aligned', 'aligned-source', 'target'],
        ['diagonal', 'diagonal-source', 'target'],
      ]),
    ).toMatchObject([
      { from: 'right', to: 'left' },
      { from: 'up', to: 'down' },
    ]);
  });
});

function faces(
  layoutManager: LayoutManager,
  definitions: readonly (readonly [string, string, string])[],
) {
  const assigned = assignFaces(
    layoutManager,
    definitions.map(([id, from, to]) => ({ id, from, to })),
  );
  return definitions.map(([id]) => assigned.get(id));
}

function testLayoutManager(entities: readonly LayoutEntity[]): LayoutManager {
  return new LayoutManager({ entities: [...entities], connections: [] });
}

function entity(id: string, x: number, y: number, containerId?: string): LayoutEntity {
  return { id, x, y, width: 60, height: 60, ...(containerId ? { containerId } : {}) };
}
