import type { LayoutManager } from '../LayoutManager.js';
import type { LayoutEntity, NewConnection } from '../types.js';
import { isDirectConnection } from './directLine.js';
import { absolutePoint, storedEndpoint } from './points.js';
import type { ConnectionRoutingRequest, EndpointPins } from './routeConnections.js';
import type { EndpointSide } from './types.js';

/** The port a table-level attachment uses when the connection stores no port. */
export const HEADER_PORT_ID = 'header';

/**
 * Pin each side whose entity declares ports to its left or right wall: the named port's
 * mid-row, else the header's for a new attachment, else the stored height fraction. The wall is
 * the stored one, else the one facing the other end (its entity, or a free end's stored point),
 * and, when its port allows crossover, turns to face the other entity once the two clear
 * horizontally. Stored top/bottom attachments stay exact. A new unnamed end keeps the face it
 * was authored on: a left or right face is its wall, and a top or bottom one is left to the
 * router. A straight or arc line keeps no stored attachment, so each of its ends is placed as a
 * new one. Undefined when no side is pinned.
 */
export function resolvePortPins(
  layoutManager: LayoutManager,
  connection: NewConnection,
): EndpointPins | undefined {
  let pins: EndpointPins | undefined;
  for (const side of ['from', 'to'] as const) {
    const entity = layoutManager.getEntityById(connection[side]);
    if (!entity?.ports) {
      continue;
    }
    const portId = side === 'from' ? connection.fromPortId : connection.toPortId;
    const port = portId ? entity.ports.find(({ id }) => id === portId) : undefined;
    const relativePort = isDirectConnection(connection)
      ? undefined
      : side === 'from'
        ? connection.relativeFromPort
        : connection.relativeToPort;
    const authoredFace =
      !port && !relativePort
        ? side === 'from'
          ? connection.authoredFromFace
          : connection.authoredToFace
        : undefined;
    if (authoredFace === 'up' || authoredFace === 'down') {
      continue;
    }
    pins ??= {};

    // Table-level attachments may be authored on the top or bottom face.
    if (!port && relativePort && relativePort[0] !== 0 && relativePort[0] !== 1) {
      pins[side] = absolutePoint(entity, relativePort);
      continue;
    }

    const header = entity.ports.find(({ id }) => id === HEADER_PORT_ID);
    const otherSide = side === 'from' ? 'to' : 'from';
    const opposite = layoutManager.getEntityById(connection[otherSide]);
    const otherX = opposite
      ? opposite.x + opposite.width / 2
      : storedEndpoint(connection, otherSide)?.[0];
    let useRight = authoredFace
      ? authoredFace === 'right'
      : relativePort?.[0] === 1 ||
        (relativePort?.[0] !== 0 &&
          (otherX === undefined ||
            opposite?.id === entity.id ||
            otherX >= entity.x + entity.width / 2));
    if (
      !authoredFace &&
      (port ?? header)?.allowCrossover &&
      opposite &&
      opposite.id !== entity.id
    ) {
      const buffer = layoutManager.options.marginBetweenEntities;
      if (entity.x + entity.width + buffer < opposite.x) {
        useRight = true;
      } else if (opposite.x + opposite.width + buffer < entity.x) {
        useRight = false;
      }
    }

    const row = port ?? (!relativePort ? header : undefined);
    pins[side] = [
      entity.x + (useRight ? entity.width : 0),
      entity.y + (row ? row.y + row.height / 2 : entity.height * (relativePort?.[1] ?? 0.5)),
    ];
  }
  // A self-relationship pinned to one point on both ends has no loop to draw; unpinned, the
  // router draws it as any other self-loop.
  if (
    connection.from === connection.to &&
    pins?.from &&
    pins.to &&
    pins.from[0] === pins.to[0] &&
    pins.from[1] === pins.to[1]
  ) {
    return undefined;
  }
  return pins;
}

interface PortWall {
  entity: LayoutEntity;
  x: number;
  fixed: Set<number>;
  fresh: { pins: EndpointPins; side: EndpointSide; oppositeY: number; id: string }[];
}

/** Resolve a batch together so unnamed elbow ends sharing a ported wall can fan out. */
export function resolveBatchPortPins(
  layout: LayoutManager,
  selected: ReadonlyMap<string, ConnectionRoutingRequest>,
): ConnectionRoutingRequest[] {
  const requests: ConnectionRoutingRequest[] = [];
  const walls = new Map<string, PortWall>();
  for (const request of selected.values()) {
    const previous = layout.getConnectionById(request.connection.id);
    const connection = previous ? { ...previous, ...request.connection } : request.connection;
    const pins = request.endpointPins ?? resolvePortPins(layout, connection);
    requests.push({ connection, endpointPins: pins });
    if (!pins) {
      continue;
    }
    for (const side of ['from', 'to'] as const) {
      const point = pins[side];
      if (!point || (side === 'from' ? connection.fromPortId : connection.toPortId)) {
        continue;
      }
      const entity = layout.getEntityById(connection[side]);
      if (
        !entity?.ports?.length ||
        (point[0] !== entity.x && point[0] !== entity.x + entity.width)
      ) {
        continue;
      }
      const key = entity.id + (point[0] === entity.x ? ':left' : ':right');
      let wall = walls.get(key);
      if (!wall) {
        wall = { entity, x: point[0], fixed: new Set(), fresh: [] };
        walls.set(key, wall);
      }
      const relative = side === 'from' ? connection.relativeFromPort : connection.relativeToPort;
      if (request.endpointPins || relative || isDirectConnection(connection)) {
        wall.fixed.add(point[1]);
        continue;
      }
      const otherSide = side === 'from' ? 'to' : 'from';
      const other = layout.getEntityById(connection[otherSide]);
      const oppositeY = other
        ? other.y + other.height / 2
        : (storedEndpoint(connection, otherSide)?.[1] ?? point[1]);
      wall.fresh.push({ pins, side, oppositeY, id: connection.id });
    }
  }
  for (const wall of walls.values()) {
    if (!wall.fresh.length) {
      continue;
    }
    for (const { connection } of layout.getConnectedEntities(wall.entity.id)) {
      if (selected.has(connection.id) || connection.points.length < 2) {
        continue;
      }
      for (const side of ['from', 'to'] as const) {
        const portId = side === 'from' ? connection.fromPortId : connection.toPortId;
        if (connection[side] === wall.entity.id && !portId) {
          const point = storedEndpoint(connection, side);
          if (point && Math.abs(point[0] - wall.x) <= 2) {
            wall.fixed.add(point[1]);
          }
        }
      }
    }
    spreadWallPins(wall);
  }
  return requests;
}

function spreadWallPins({ entity, x, fixed, fresh }: PortWall): void {
  const count = fixed.size + fresh.length;
  if (count < 2) {
    return; // a lone unnamed attachment stays on the header
  }
  const inset = Math.min(
    entity.height / 4,
    18,
    Math.max(8, Math.floor(entity.height / (count + 2))),
  );
  const span = Math.min(entity.height - 2 * inset, 32 * (count - 1));
  const start = entity.y + (fixed.size ? inset : (entity.height - span) / 2);
  const step = span / (count - 1);
  const tracks = Array.from({ length: count }, (_, i) => {
    const y = start + step * i;
    return step < 1 ? y : Math.round(y);
  });

  // Reserve the nearest slot for each saved attachment before assigning the rest.
  for (const y of [...fixed].sort((a, b) => a - b)) {
    const nearest = tracks.reduce(
      (best, track, i) => (Math.abs(track - y) < Math.abs(tracks[best]! - y) ? i : best),
      0,
    );
    tracks.splice(nearest, 1);
  }
  fresh.sort((a, b) => a.oppositeY - b.oppositeY || a.id.localeCompare(b.id));
  fresh.forEach(({ pins, side }, i) => {
    pins[side] = [x, tracks[i]!];
  });
}
