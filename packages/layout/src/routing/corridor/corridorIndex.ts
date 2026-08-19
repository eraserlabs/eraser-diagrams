import type { LayoutManager } from '../../LayoutManager.js';
import type { Axis, AxisSpan, Direction, LayoutEntity, PositionProps } from '../../types.js';
import { touchExternalTextRangeToEntityClippedToBodyFace } from '../textPlacements.js';
import { buildCorridorBorderProfile } from './borderProfile.js';
import { AUTHORED_PORT_TOLERANCE_PX } from './contract.js';
import type {
  Corridor,
  CorridorBorderProfile,
  PortalRef,
  ProfiledCorridor,
  RouteEndpoint,
  TerminalAttachment,
} from './contract.js';
import { faceOrder } from './geometry.js';

const FACE_COUNT = 4;

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
  readonly corridors: readonly ProfiledCorridor[];
  readonly portals: readonly PortalRef[];
  readonly attachments: readonly TerminalAttachment[];

  private readonly portalsByCorridor: readonly (readonly PortalRef[] | undefined)[];
  private readonly attachmentsByFace: readonly (readonly number[] | undefined)[];
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
    for (const attachment of attachments) {
      if (corridors[attachment.corridorIndex] === undefined) {
        throw new Error(`attachment ${attachment.index}: corridor missing`);
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
    this.externalTextEntities = makeExternalTextEntities(entities);
    this.bounds = bounds;
    this.entityIndexById = new Map(entities.map((entity, index) => [entity.id, index]));
    // One shared prototype hosts the lazy borderProfile accessor; decorating each
    // corridor is then a plain three-field copy instead of a per-object defineProperty.
    const indexer = this;
    const profiledPrototype = Object.defineProperty({}, 'borderProfile', {
      enumerable: false,
      get(this: Corridor): CorridorBorderProfile {
        return indexer.corridorBorderProfile(this.index);
      },
    });
    const profiled: ProfiledCorridor[] = new Array(corridors.length);
    for (let index = 0; index < corridors.length; index += 1) {
      profiled[index] = Object.assign(
        Object.create(profiledPrototype),
        corridors[index],
      ) as ProfiledCorridor;
    }
    this.corridors = profiled;
    this.portals = portals;
    this.attachments = attachments;
    this.portalsByCorridor = byCorridor;
    this.attachmentsByFace = byFace;
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
    const candidates = this.attachmentsByFace[faceSlot(endpoint.entityIndex, endpoint.face)] ?? [];
    const authoredTrack = endpoint.authoredTrack;
    if (authoredTrack === undefined) {
      return candidates;
    }
    return candidates.filter((attachmentIndex) => {
      const [start, end] = this.attachments[attachmentIndex].faceSpan;
      return (
        authoredTrack >= start - AUTHORED_PORT_TOLERANCE_PX &&
        authoredTrack <= end + AUTHORED_PORT_TOLERANCE_PX
      );
    });
  }
}

function makeExternalTextEntities(entities: readonly LayoutEntity[]): LayoutEntity[] {
  const result: LayoutEntity[] = [];
  for (const entity of entities) {
    const rect = touchExternalTextRangeToEntityClippedToBodyFace(entity);
    if (!rect) {
      continue;
    }
    result.push({ ...entity, ...rect, textPlacement: undefined });
  }
  return result;
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
  for (const entity of entities) {
    const entityIndex = entityIndexById.get(entity.id);
    if (entityIndex === undefined) {
      continue;
    }
    const candidates: ReadonlyArray<Omit<CorridorWallFace, 'entityIndex' | 'entityId'>> = [
      {
        face: 'left',
        normalAxis: 'x',
        coordinate: entity.x,
        span: [entity.y, entity.y + entity.height],
      },
      {
        face: 'right',
        normalAxis: 'x',
        coordinate: entity.x + entity.width,
        span: [entity.y, entity.y + entity.height],
      },
      {
        face: 'up',
        normalAxis: 'y',
        coordinate: entity.y,
        span: [entity.x, entity.x + entity.width],
      },
      {
        face: 'down',
        normalAxis: 'y',
        coordinate: entity.y + entity.height,
        span: [entity.x, entity.x + entity.width],
      },
    ];
    for (const face of candidates) {
      const normalStart = face.normalAxis === 'x' ? corridor.rect.x : corridor.rect.y;
      const normalEnd =
        normalStart + (face.normalAxis === 'x' ? corridor.rect.width : corridor.rect.height);
      const travelStart = face.normalAxis === 'x' ? corridor.rect.y : corridor.rect.x;
      const travelEnd =
        travelStart + (face.normalAxis === 'x' ? corridor.rect.height : corridor.rect.width);
      if (
        face.coordinate < normalStart ||
        face.coordinate > normalEnd ||
        face.span[1] < travelStart ||
        face.span[0] > travelEnd
      ) {
        continue;
      }
      result.push({ entityIndex, entityId: entity.id, ...face });
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
