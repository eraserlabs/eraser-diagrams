import type { LayoutManager } from '../../LayoutManager.js';
import type { Axis, AxisSpan, Direction, LayoutEntity, PositionProps } from '../../types.js';
import { buildExternalTextEntities } from './externalTextGeometry.js';
import { buildCorridorBorderProfile, type CorridorBorderProfile } from './borderProfile.js';
import {
  AUTHORED_PORT_TOLERANCE_PX,
  isPointAttachment,
  isPointEndpoint,
  pointAttachmentKey,
} from './contract.js';
import type { Corridor, PortalRef, RouteEndpoint, TerminalAttachment } from './contract.js';
import { faceOrder } from './geometry.js';
import { CorridorSpans } from './corridorSpans.js';

const FACE_COUNT = 4;
const WALL_FACES: readonly Direction[] = ['left', 'right', 'up', 'down'];

/** One entity face whose plane actually intersects a corridor rectangle. */
export interface CorridorWallFace {
  readonly entityIndex: number;
  readonly entityId: string;
  readonly face: Direction;
  readonly normalAxis: Axis;
  readonly coordinate: number;
  readonly span: AxisSpan;
}

/** Immutable geometric queries shared by every route in one world. */
export class CorridorIndexer {
  readonly corridors: readonly Corridor[];
  readonly portals: readonly PortalRef[];
  readonly attachments: readonly TerminalAttachment[];
  readonly spans: CorridorSpans;

  private readonly portalsByCorridor: readonly (readonly PortalRef[] | undefined)[];
  private readonly attachmentsByFace: readonly (readonly number[] | undefined)[];
  private readonly attachmentsByPoint: ReadonlyMap<string, readonly number[]>;
  private readonly borderProfileCache: Array<CorridorBorderProfile | undefined>;
  private readonly wallFaceCache: Array<readonly CorridorWallFace[] | undefined>;
  private readonly layoutManager: LayoutManager;
  private readonly externalTextEntities: readonly LayoutEntity[];
  private readonly bounds: PositionProps;
  private readonly entityIndexById: ReadonlyMap<string, number>;

  constructor(
    corridors: readonly Corridor[],
    portals: readonly PortalRef[],
    attachments: readonly TerminalAttachment[],
    layoutManager: LayoutManager,
    bounds: PositionProps,
    externalTextEntities: readonly LayoutEntity[] = buildExternalTextEntities(
      layoutManager.getEntities(),
    ),
    spans = new CorridorSpans(corridors),
  ) {
    assertIndexed(corridors, 'corridor');
    assertIndexed(portals, 'portal');
    assertIndexed(attachments, 'attachment');

    const byCorridor: (PortalRef[] | undefined)[] = new Array(corridors.length);
    for (const portal of portals) {
      const firstIndex =
        portal.kind === 'turn' ? portal.xCorridorIndex : portal.negativeCorridorIndex;
      const secondIndex =
        portal.kind === 'turn' ? portal.yCorridorIndex : portal.positiveCorridorIndex;
      const first = corridors[firstIndex];
      const second = corridors[secondIndex];
      if (portal.kind === 'turn') {
        if (first?.axis !== 'x' || second?.axis !== 'y') {
          throw new Error(`portal ${portal.index}: invalid turn corridor pair`);
        }
        if (portal.rect.width <= 0 || portal.rect.height <= 0) {
          throw new Error(`portal ${portal.index}: empty turn overlap`);
        }
      } else if (
        first?.axis !== portal.axis ||
        second?.axis !== portal.axis ||
        portal.crossSpan[1] <= portal.crossSpan[0]
      ) {
        throw new Error(`portal ${portal.index}: invalid continuation corridor pair`);
      }
      pushToSlot(byCorridor, firstIndex, portal);
      pushToSlot(byCorridor, secondIndex, portal);
    }

    const entities = layoutManager.getEntities();
    const entityCount = entities.length;
    const byFace: (number[] | undefined)[] = new Array(entityCount * FACE_COUNT);
    const byPoint = new Map<string, number[]>();
    for (const attachment of attachments) {
      if (corridors[attachment.corridorIndex] === undefined) {
        throw new Error(`attachment ${attachment.index}: corridor missing`);
      }
      if (isPointAttachment(attachment)) {
        const key = pointAttachmentKey(attachment.x, attachment.y);
        const slot = byPoint.get(key);
        if (slot) {
          slot.push(attachment.index);
        } else {
          byPoint.set(key, [attachment.index]);
        }
        continue;
      }
      if (attachment.entityIndex < 0 || attachment.entityIndex >= entityCount) {
        throw new Error(`attachment ${attachment.index}: entity missing`);
      }
      const slot = faceSlot(attachment.entityIndex, attachment.face);
      pushToSlot(byFace, slot, attachment.index);
    }
    this.borderProfileCache = new Array(corridors.length);
    this.wallFaceCache = new Array(corridors.length);
    this.layoutManager = layoutManager;
    this.externalTextEntities = externalTextEntities;
    this.bounds = bounds;
    this.entityIndexById = new Map(entities.map((entity, index) => [entity.id, index]));
    this.corridors = corridors;
    this.spans = spans;
    this.portals = portals;
    this.attachments = attachments;
    this.portalsByCorridor = byCorridor;
    this.attachmentsByFace = byFace;
    this.attachmentsByPoint = byPoint;
  }

  corridorBorderProfile(corridorIndex: number): CorridorBorderProfile {
    const cached = this.borderProfileCache[corridorIndex];
    if (cached) {
      return cached;
    }
    const corridor = this.corridors[corridorIndex];
    if (!corridor) {
      throw new Error(`corridor ${corridorIndex}: missing border-profile source`);
    }

    const profile = buildCorridorBorderProfile(
      this.layoutManager,
      this.bounds,
      corridor,
      this.externalTextEntities,
      this.spans,
    );
    this.borderProfileCache[corridorIndex] = profile;
    return profile;
  }

  /**
   * Lazily cache entity faces whose plane intersects this corridor. Hot-path
   * quality scoring deliberately ignores merely-near faces outside the corridor.
   */
  wallFacesForCorridor(corridorIndex: number): readonly CorridorWallFace[] {
    const cached = this.wallFaceCache[corridorIndex];
    if (cached) {
      return cached;
    }
    const corridor = this.corridors[corridorIndex];
    if (!corridor) {
      throw new Error(`corridor ${corridorIndex}: missing wall-face source`);
    }
    const range = {
      minX: corridor.rect.x,
      minY: corridor.rect.y,
      maxX: corridor.rect.x + corridor.rect.width,
      maxY: corridor.rect.y + corridor.rect.height,
    };
    const candidates = this.layoutManager.findEntitiesInRange(range);
    for (const text of this.externalTextEntities) {
      if (touchesRange(text, range)) {
        candidates.push(text);
      }
    }
    const faces = corridorWallFaces(corridor, candidates, this.entityIndexById);
    this.wallFaceCache[corridorIndex] = faces;
    return faces;
  }

  portalsFrom(corridorIndex: number): readonly PortalRef[] {
    return this.portalsByCorridor[corridorIndex] ?? [];
  }

  otherCorridorIndex(portal: PortalRef, corridorIndex: number): number {
    const firstIndex =
      portal.kind === 'turn' ? portal.xCorridorIndex : portal.negativeCorridorIndex;
    const secondIndex =
      portal.kind === 'turn' ? portal.yCorridorIndex : portal.positiveCorridorIndex;
    if (firstIndex === corridorIndex) {
      return secondIndex;
    }
    if (secondIndex === corridorIndex) {
      return firstIndex;
    }
    throw new Error(`portal ${portal.index}: corridor ${corridorIndex} is not an endpoint`);
  }

  attachmentsForEndpoint(endpoint: RouteEndpoint): readonly number[] {
    if (isPointEndpoint(endpoint)) {
      return this.attachmentsByPoint.get(pointAttachmentKey(endpoint.x, endpoint.y)) ?? [];
    }
    const candidates = this.attachmentsByFace[faceSlot(endpoint.entityIndex, endpoint.face)] ?? [];
    const authoredTrack = endpoint.authoredTrack;
    if (authoredTrack === undefined) {
      return candidates;
    }
    return candidates.filter((attachmentIndex) => {
      const attachment = this.attachments[attachmentIndex];
      if (isPointAttachment(attachment)) {
        return false;
      }
      const [start, end] = attachment.faceSpan;
      return (
        authoredTrack >= start - AUTHORED_PORT_TOLERANCE_PX &&
        authoredTrack <= end + AUTHORED_PORT_TOLERANCE_PX
      );
    });
  }
}

function touchesRange(
  entity: PositionProps,
  range: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  },
): boolean {
  return (
    entity.x <= range.maxX &&
    entity.x + entity.width >= range.minX &&
    entity.y <= range.maxY &&
    entity.y + entity.height >= range.minY
  );
}

function corridorWallFaces(
  corridor: Corridor,
  entities: readonly LayoutEntity[],
  entityIndexById: ReadonlyMap<string, number>,
): CorridorWallFace[] {
  const result: CorridorWallFace[] = [];
  const { x, y, width, height } = corridor.rect;
  const right = x + width;
  const bottom = y + height;
  for (const entity of entities) {
    const entityIndex = entityIndexById.get(entity.id);
    if (entityIndex === undefined) {
      continue;
    }
    const entityRight = entity.x + entity.width;
    const entityBottom = entity.y + entity.height;
    for (let side = 0; side < WALL_FACES.length; side += 1) {
      const isX = side < 2;
      const coordinate = isX
        ? side === 0
          ? entity.x
          : entityRight
        : side === 2
          ? entity.y
          : entityBottom;
      const start = isX ? entity.y : entity.x;
      const end = isX ? entityBottom : entityRight;
      if (
        coordinate < (isX ? x : y) ||
        coordinate > (isX ? right : bottom) ||
        end < (isX ? y : x) ||
        start > (isX ? bottom : right)
      ) {
        continue;
      }
      result.push({
        entityIndex,
        entityId: entity.id,
        face: WALL_FACES[side],
        normalAxis: isX ? 'x' : 'y',
        coordinate,
        span: [start, end],
      });
    }
  }
  return result.sort(
    (left, right) =>
      left.entityId.localeCompare(right.entityId) ||
      left.normalAxis.localeCompare(right.normalAxis) ||
      left.coordinate - right.coordinate ||
      left.face.localeCompare(right.face),
  );
}

/** Sparse fill: slots without members stay `undefined` instead of allocating empties. */
function pushToSlot<T>(slots: (T[] | undefined)[], slot: number, value: T): void {
  const values = slots[slot];
  if (values) {
    values.push(value);
  } else {
    slots[slot] = [value];
  }
}

function assertIndexed(values: readonly { index: number }[], name: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].index !== index) {
      throw new Error(`${name} ${values[index].index} stored at position ${index}`);
    }
  }
}

function faceSlot(entityIndex: number, face: Direction): number {
  return entityIndex * FACE_COUNT + faceOrder(face);
}
