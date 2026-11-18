import type { LayoutManager } from '../LayoutManager.js';
import type { NewConnection } from '../types.js';
import { isDirectConnection } from './directLine.js';
import { absolutePoint, storedEndpoint } from './points.js';
import type { EndpointPins } from './routeConnections.js';

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
