import type { Direction, LayoutEntity } from '../../types.js';
import { LayoutManager } from '../../LayoutManager.js';
import { isPointAttachment } from '../corridor/contract.js';
import type { Corridor, FaceTerminalAttachment, RouteSearchRequest } from '../corridor/contract.js';
import { buildCorridorWorld } from '../corridor/worldConstruction.js';
import { buildBaseCorridorGeometry, buildTerminalAttachments } from '../corridor/world.js';
import { overlapRect } from '../corridor/geometry.js';
import { certifiedRunFrom } from '../corridor/freeSpaceSubstrate.js';
import { withGroupTitleAvoidance } from '../corridor/groupTitleQuality.js';
import { leaf } from '../routingTestUtils.js';

function buildWorld(entities: readonly LayoutEntity[], requests: readonly RouteSearchRequest[]) {
  return buildCorridorWorld(
    new LayoutManager({ entities: [...entities], connections: [] }),
    requests,
  );
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
  it('shares construction for exact title costs and the optional corridor hint', () => {
    const world = buildWorld(
      [
        {
          id: 'group',
          x: 100,
          y: 200,
          width: 300,
          height: 200,
          isContainer: true,
          textPlacement: { relativeX: 10, relativeY: 10, width: 200, height: 20 },
        },
      ],
      [],
    );
    expect(withGroupTitleAvoidance(world)).toBe(world);
    const originalCosts = world.corridorEntryCosts?.slice();
    const options = { corridorPenalty: 0, intersectionCost: 100, overlapCostPerPx: 1 };
    const exact = withGroupTitleAvoidance(world, options);
    const hinted = withGroupTitleAvoidance(world, { ...options, corridorPenalty: 2 });
    expect(exact.indexer).toBe(world.indexer);
    expect(hinted.indexer).toBe(world.indexer);
    expect(exact.corridorEntryCosts).toBe(world.corridorEntryCosts);
    expect(exact.groupTitleAvoidance?.titles).toEqual([{ x: 110, y: 210, width: 200, height: 20 }]);
    expect(hinted.groupTitleAvoidance?.titles).toEqual(exact.groupTitleAvoidance?.titles);
    expect(
      [...hinted.corridorEntryCosts!].some(
        (cost, index) => cost - (originalCosts?.[index] ?? 0) === 2,
      ),
    ).toBe(true);
    expect(world.corridorEntryCosts).toEqual(originalCosts);
  });

  it('keeps every positive-area turn overlap in corridor-index order', () => {
    const world = buildWorld(
      [
        leaf('a', -100, -40, 40, 40),
        leaf('b', 20, -40, 40, 40),
        leaf('c', -60, 40, 40, 80),
        leaf('d', 60, 120, 80, 40),
      ],
      [request(0, 3, 'right', 'up')],
    );
    // Exhaustive reference: the spatial query must retain membership and stable IDs.
    const corridors = world.indexer.corridors;
    const expected = corridors
      .filter((corridor) => corridor.axis === 'x')
      .flatMap((x) =>
        corridors
          .filter((corridor) => corridor.axis === 'y')
          .flatMap((y) => {
            const rect = overlapRect(x.rect, y.rect, 0);
            return rect ? [{ xCorridorIndex: x.index, yCorridorIndex: y.index, rect }] : [];
          }),
      )
      .map((portal, index) => ({ kind: 'turn', index, ...portal }));

    expect(expected.length).toBeGreaterThan(0);
    expect(world.indexer.portals.filter((portal) => portal.kind === 'turn')).toEqual(expected);
  });

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
        .filter(
          (attachment): attachment is FaceTerminalAttachment =>
            !isPointAttachment(attachment) && attachment.entityIndex === 0,
        )
        .map((attachment) => ({
          corridorIndex: attachment.corridorIndex,
          faceSpan: attachment.faceSpan,
        })),
    ).toEqual([{ corridorIndex: 0, faceSpan: [0, 100] }]);
  });

  it('preserves face coordinates on grid, fractional, and out-of-Int32 attachments', () => {
    const faces: readonly Direction[] = ['up', 'right', 'down', 'left'];
    for (const offset of [-2147483700, -100, -0, 0.25, 2147483700]) {
      const entities = [leaf('source', offset, offset, 40, 40)];
      const corridors: Corridor[] = [
        { index: 10, axis: 'y', rect: { x: offset, y: offset - 40, width: 40, height: 40 } },
        { index: 20, axis: 'x', rect: { x: offset + 40, y: offset, width: 40, height: 40 } },
        { index: 30, axis: 'y', rect: { x: offset, y: offset + 40, width: 40, height: 40 } },
        { index: 40, axis: 'x', rect: { x: offset - 40, y: offset, width: 40, height: 40 } },
      ];
      const requests = faces.map((face) => request(0, 0, face, face));
      const expected = faces.map((face, index) => ({
        index,
        entityIndex: 0,
        face,
        corridorIndex: (index + 1) * 10,
        faceSpan: [offset, offset + 40],
      }));
      expect(buildTerminalAttachments(entities, corridors, requests)).toEqual(expected);
    }
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

  it('keeps container interiors and boundaries traversable on both axes', () => {
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
      [],
    );

    for (const axis of ['x', 'y'] as const) {
      expect(certifiedRunFrom(base.freeSpace[axis], -20, [0, 100], 1, 120)).toBe(120);
      expect(certifiedRunFrom(base.freeSpace[axis], 120, [0, 100], -1, -20)).toBe(-20);
    }
  });
});
