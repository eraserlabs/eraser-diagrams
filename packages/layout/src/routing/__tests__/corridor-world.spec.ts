import type { LayoutEntity } from '../../types.js';
import { LayoutManager } from '../../LayoutManager.js';
import type { RouteSearchRequest } from '../corridor/contract.js';
import { buildCorridorWorld } from '../corridor/worldConstruction.js';
import { buildBaseCorridorGeometry, buildTerminalAttachments } from '../corridor/world.js';

function buildWorld(entities: readonly LayoutEntity[], requests: readonly RouteSearchRequest[]) {
  return buildCorridorWorld(
    new LayoutManager({ entities: [...entities], connections: [] }),
    requests,
  );
}

function leaf(id: string, x: number, y: number, width: number, height: number): LayoutEntity {
  return { id, x, y, width, height };
}

function request(
  fromEntityIndex: number,
  toEntityIndex: number,
  fromFace: 'up' | 'right' | 'down' | 'left',
  toFace: 'up' | 'right' | 'down' | 'left',
  authoredTrack?: number,
): RouteSearchRequest {
  return {
    requestIndex: 0,
    from: { entityIndex: fromEntityIndex, face: fromFace, authoredTrack },
    to: { entityIndex: toEntityIndex, face: toFace },
  };
}

describe('routing corridor world', () => {
  it('does not attach an inward corridor at a traversable container face', () => {
    const entities: LayoutEntity[] = [
      { id: 'group', x: 0, y: 0, width: 100, height: 100, isContainer: true },
      leaf('target', 200, -100, 20, 20),
    ];
    const corridors = [
      { index: 0, axis: 'y' as const, rect: { x: 0, y: -100, width: 100, height: 100 } },
      { index: 1, axis: 'y' as const, rect: { x: 0, y: 0, width: 20, height: 100 } },
    ];
    const attachments = buildTerminalAttachments(entities, corridors, [
      request(0, 1, 'up', 'down'),
    ]);

    expect(
      attachments
        .filter((attachment) => attachment.entityIndex === 0)
        .map((attachment) => ({
          corridorIndex: attachment.corridorIndex,
          faceSpan: attachment.faceSpan,
        })),
    ).toEqual([{ corridorIndex: 0, faceSpan: [0, 100] }]);
  });

  it('filters shared attachments for an authored track with 0.5px tolerance', () => {
    const entities = [leaf('a', 0, 0, 40, 100), leaf('blocker', 40, 49.6, 30, 30)];
    const near = request(0, 1, 'right', 'left', 50);
    const nearWorld = buildWorld(entities, [near]);
    expect(nearWorld.indexer.attachmentsForEndpoint(near.from)).toHaveLength(1);

    const farEntities = [leaf('a', 0, 0, 40, 100), leaf('blocker', 40, 49.4, 30, 30)];
    const far = request(0, 1, 'right', 'left', 50);
    const farWorld = buildWorld(farEntities, [far]);
    expect(farWorld.indexer.attachmentsForEndpoint(far.from)).toHaveLength(0);
  });

  it('shares free slabs without treating container guide cuts as obstacles', () => {
    const container: LayoutEntity = {
      id: 'group',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      isContainer: true,
    };
    const base = buildBaseCorridorGeometry(
      new LayoutManager({ entities: [container], connections: [] }),
    );

    expect([...base.freeSpace.x.travelCuts]).toEqual([-20, 0, 100, 120]);
    expect([...base.freeSpace.x.slabOffsets]).toEqual([0, 1, 2, 3]);
    expect([...base.freeSpace.x.crossSpans]).toEqual([-20, 120, -20, 120, -20, 120]);
  });

  it('builds byte-stable arrays and answers indexed queries', () => {
    const entities = [leaf('a', 0, 0, 40, 40), leaf('b', 120, 80, 40, 40)];
    const requests = [request(0, 1, 'right', 'left')];
    const first = buildWorld(entities, requests);
    const second = buildWorld(entities, requests);
    expect({
      corridors: first.indexer.corridors,
      portals: first.indexer.portals,
      attachments: first.indexer.attachments,
    }).toEqual({
      corridors: second.indexer.corridors,
      portals: second.indexer.portals,
      attachments: second.indexer.attachments,
    });

    const portal = first.indexer.portals[0];
    expect(portal.kind).toBe('turn');
    if (portal.kind !== 'turn') {
      throw new Error('turn portal expected');
    }
    expect(first.indexer.portalsFrom(portal.xCorridorIndex)).toContain(portal);
    expect(first.indexer.otherCorridorIndex(portal, portal.xCorridorIndex)).toBe(
      portal.yCorridorIndex,
    );
  });
});
