import { LayoutManager } from '../LayoutManager.js';
import {
  Direction,
  LayoutEntity,
  NewConnection,
  PositionProps,
  RelativePositionProps,
} from '../types.js';
import { assignFaces } from './faces.js';
import { CorridorIndexer } from './corridor/corridorIndex.js';
import type {
  Corridor,
  PortalRef,
  RouteSearchRequest,
  TerminalAttachment,
} from './corridor/contract.js';
import type { CorridorWorld } from './corridor/world.js';
import type { Point } from './types.js';

export function simpleEntity(id: string, pos: { x?: number; y?: number }) {
  return {
    id,
    x: pos.x ?? 0,
    y: pos.y ?? 0,
    width: 50,
    height: 50,
  };
}

export function entWithTextBelow(
  id: string,
  pos: { x?: number; y?: number },
  placement: Partial<RelativePositionProps> = {},
): LayoutEntity {
  return {
    ...simpleEntity(id, pos),
    textPlacement: {
      relativeX: 10,
      relativeY: 50,
      width: 30,
      height: 10,
      ...placement,
    },
  };
}

/**
 * Builds a corridor search request per connection from a hand-authored scene: current
 * face selection applied exactly once, then frozen into entity-index/face pairs.
 *
 * Keeps synthetic corridor specs independent of serialized diagram inputs.
 */
export function sceneRouteRequests(
  entities: readonly LayoutEntity[],
  connections: readonly NewConnection[],
  primaryDirection: Direction = 'right',
): { layoutManager: LayoutManager<LayoutEntity>; requests: RouteSearchRequest[] } {
  const layoutManager = new LayoutManager<LayoutEntity>({
    entities: [...entities],
    connections: [],
    primaryDirection,
  });
  const entityIndexById = new Map(
    layoutManager.getEntities().map((entity, index) => [entity.id, index]),
  );
  const faces = assignFaces(layoutManager, connections);

  return {
    layoutManager,
    requests: connections.map((connection, requestIndex) => {
      const fromEntityIndex = entityIndexById.get(connection.from);
      const toEntityIndex = entityIndexById.get(connection.to);
      if (fromEntityIndex === undefined || toEntityIndex === undefined) {
        throw new Error(`request ${connection.id}: endpoint entity missing`);
      }
      const { from, to } = faces.get(connection.id)!;
      return {
        requestIndex,
        from: { entityIndex: fromEntityIndex, face: from },
        to: { entityIndex: toEntityIndex, face: to },
      };
    }),
  };
}

export function leaf(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): LayoutEntity {
  return { id, x, y, width, height };
}

/** A corridor world from hand-authored corridors/portals/attachments; no construction pass runs. */
export function manualCorridorWorld(
  entities: readonly LayoutEntity[],
  corridors: readonly Corridor[],
  portals: readonly PortalRef[],
  attachments: readonly TerminalAttachment[],
  bounds: PositionProps,
): CorridorWorld {
  return {
    bounds,
    entities,
    indexer: new CorridorIndexer(
      corridors,
      portals,
      attachments,
      new LayoutManager({ entities: [...entities], connections: [] }),
      bounds,
    ),
  };
}

/** Asserts a finite polyline of at least two points whose every segment is horizontal or vertical. */
export function expectOrthogonal(points: readonly Readonly<Point>[]) {
  expect(points.length).toBeGreaterThanOrEqual(2);
  expect(points.every((point) => point.every(Number.isFinite))).toBe(true);
  expect(
    points.slice(1).every(([x, y], index) => x === points[index][0] || y === points[index][1]),
  ).toBe(true);
}
