import { LayoutManager } from '../LayoutManager.js';
import { Direction, LayoutEntity, RelativePositionProps } from '../types.js';
import { assignFaces, type FaceSelectionConnection } from './faces.js';
import type { RouteSearchRequest } from './corridor/contract.js';

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

export interface SceneConnection {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface SceneRouteRequest extends RouteSearchRequest {
  readonly connId: string;
}

/**
 * Builds a corridor search request per connection from a hand-authored scene: current
 * face selection applied exactly once, then frozen into entity-index/face pairs.
 *
 * Keeps synthetic corridor specs independent of serialized diagram inputs.
 */
export function sceneRouteRequests(
  entities: readonly LayoutEntity[],
  connections: readonly SceneConnection[],
  primaryDirection: Direction = 'right',
): { layoutManager: LayoutManager<LayoutEntity>; requests: SceneRouteRequest[] } {
  const layoutManager = new LayoutManager<LayoutEntity>({
    entities: [...entities],
    connections: [],
    primaryDirection,
  });
  const entityIndexById = new Map(
    layoutManager.getEntities().map((entity, index) => [entity.id, index]),
  );
  const faceRequests = connections.map((connection) => ({
    connId: connection.id,
    from: connection.from,
    to: connection.to,
  }));
  const faceConnections: FaceSelectionConnection[] = connections.map((connection) => ({
    id: connection.id,
    from: connection.from,
    to: connection.to,
  }));
  const faces = assignFaces(layoutManager, faceRequests, faceConnections);

  return {
    layoutManager,
    requests: faceRequests.map((request, requestIndex) => {
      const fromEntityIndex = entityIndexById.get(request.from);
      const toEntityIndex = entityIndexById.get(request.to);
      if (fromEntityIndex === undefined || toEntityIndex === undefined) {
        throw new Error(`request ${request.connId}: endpoint entity missing`);
      }
      return {
        requestIndex,
        connId: request.connId,
        from: { entityIndex: fromEntityIndex, face: faces[requestIndex].from },
        to: { entityIndex: toEntityIndex, face: faces[requestIndex].to },
      };
    }),
  };
}
