import { getPortDirection, isHorizontal } from '../directionUtils.js';
import { LayoutManager } from '../LayoutManager.js';
import { simplifyCollinearPoints } from './polylineUtils.js';
import type {
  Direction,
  LayoutChange,
  LayoutConnection,
  LayoutConnectionChange,
  LayoutEntity,
  NewConnection,
  PositionProps,
  XYPoint,
} from '../types.js';
import { assignFaces, type RouteFaces } from './faces.js';
import { makeRoughFallbackConnectionChange } from './fallbackConnection.js';
import {
  absoluteConnectionPoints,
  authoredEndpointFace,
  connectionGeometryFromPoints,
  getAbsolutePortPoint,
  getRelativePort,
  isFinitePoint,
  roundPoint,
  storedEndpoint,
} from './points.js';
import type { EndpointSide, Point, RelativePortPosition, RoutedConnectionChange } from './types.js';
import { isPointEndpoint } from './corridor/contract.js';
import type { RouteEndpoint, RouteSearchRequest } from './corridor/contract.js';
import { endpointTrackCoordinate, outwardSign, terminalFacePlane } from './corridor/geometry.js';
import { MIN_TRACK_SEPARATION_PX } from './corridor/spacing.js';
import type { RealizedLabelPlacement } from './corridor/labelPlacement.js';
import {
  executeCorridorRouting,
  type CorridorRoutingRequest,
  type RepairPolicy,
} from './executeCorridorRouting.js';
import { finalizeShiftRoute, getShiftedConnection } from './shiftRouting.js';
import {
  bindingOf,
  centreSegment,
  directLabel,
  faceAnchoredSegment,
  type DirectLine,
  followBoxes,
  type Point as DirectPoint,
} from './directLine.js';
import { moveManualLabel } from './manualLabelAnchor.js';
import { hasMeasuredLabel } from './textPlacements.js';

/**
 * Repair for committed edits and renders. Gesture ticks and drops, previews, and
 * structural passes that route once per moved entity pass `false` instead.
 */
export const COMMIT_REPAIR: RepairPolicy = { timeBudgetMs: 100 };

/** Absolute endpoint overrides, retained exactly including fractional attachment positions. */
export interface EndpointPins {
  from?: Point;
  to?: Point;
}

export interface ConnectionRoutingRequest {
  readonly connection: NewConnection;
  /**
   * Exact endpoint overrides. Bound pins retain their face constraint; free pins
   * may approach from any direction. An empty object disables the pin resolver.
   */
  readonly endpointPins?: EndpointPins;
}

export interface RouteConnectionsArgs {
  readonly layoutManager: LayoutManager;
  readonly repair: RepairPolicy;
  /** Explicit requests take precedence over connections selected by entity updates. */
  readonly connectionsToRoute?: readonly (NewConnection | ConnectionRoutingRequest)[];
  /** Select connections incident to changed entities that existed before and after staging. */
  readonly updates?: ReadonlyMap<string, LayoutChange>;
  /** Try shifting valid existing geometry before searching; defaults to true. */
  readonly allowShift?: boolean;
  /** Combine coincident pinned ports on the same entity face into one spacing group. */
  readonly groupedPinnedPorts?: boolean;
  /** Resolve live attachments once per selected connection; explicit pins take precedence. */
  readonly resolveEndpointPins?: (connection: NewConnection) => EndpointPins | undefined;
}

export interface RoutingResult {
  /** Staged changes for routed connections, including complete newly added connections. */
  readonly updates: Map<string, LayoutConnectionChange>;
  /** Selected connections committed with direct fallback geometry instead of a solved route. */
  readonly fallbacks: ReadonlySet<string>;
}

/**
 * Route one explicit/affected batch. Valid shifts commit first and participate as
 * pinned incumbents in the remaining corridor batch. Omitting both selectors is
 * a no-op, never an implicit request to route the whole layout.
 */
export function routeConnections({
  layoutManager,
  connectionsToRoute = [],
  updates,
  allowShift = true,
  groupedPinnedPorts = false,
  resolveEndpointPins,
  repair,
}: RouteConnectionsArgs): RoutingResult {
  const selected = new Map<string, ConnectionRoutingRequest>();
  for (const input of connectionsToRoute) {
    const request = 'connection' in input ? input : { connection: input };
    selected.set(request.connection.id, request);
  }
  if (updates?.size) {
    const mapping = layoutManager.getConnectionMapping();
    for (const entityId of updates.keys()) {
      if (
        !layoutManager.getEntityById(entityId, false, true) ||
        !layoutManager.getEntityById(entityId, false, false)
      ) {
        continue;
      }
      for (const connectionId of mapping[entityId] ?? []) {
        if (selected.has(connectionId)) {
          continue;
        }
        const connection = layoutManager.getConnectionById(connectionId);
        if (connection) {
          selected.set(connectionId, { connection });
        }
      }
    }
  }

  const routingLayout = selected.size ? makeRoutingLayout(layoutManager) : layoutManager;
  const pending = new Map<string, ConnectionRoutingRequest>();
  for (const { connection: input, endpointPins } of selected.values()) {
    const existing = routingLayout.getConnectionById(input.id);
    const connection = existing ? { ...existing, ...input } : input;
    const pins = endpointPins ?? resolveEndpointPins?.(connection);
    if (isDirectConnection(connection)) {
      const change = routeDirectConnection(routingLayout, connection, pins);
      if (change && existing) {
        routingLayout.updateConnection(connection.id, change);
      } else if (change) {
        routingLayout.addConnection({ ...connection, ...change });
      }
      continue;
    }
    const shifted = allowShift ? getShiftedConnection(routingLayout, connection, pins) : undefined;
    if (shifted && existing) {
      finalizeShiftRoute(routingLayout, connection, shifted);
      continue;
    }
    pending.set(connection.id, { connection, endpointPins: pins });
  }

  const manualLabels = new Map<string, ManualLabelSnapshot>();
  for (const { connection } of pending.values()) {
    const snapshot = manualLabelSnapshot(
      routingLayout.getConnectionById(connection.id),
      connection,
    );
    if (snapshot) {
      manualLabels.set(connection.id, snapshot);
    }
  }
  const fallbacks = routeCorridorConnections(routingLayout, pending, repair, groupedPinnedPorts);
  restoreManualLabels(routingLayout, manualLabels);
  const connectionUpdates = new Map<string, LayoutConnectionChange>();
  for (const connectionId of selected.keys()) {
    const change = stagedConnectionChange(routingLayout, connectionId);
    if (change === undefined) {
      continue;
    }
    if (routingLayout !== layoutManager) {
      if (layoutManager.getConnectionById(connectionId)) {
        layoutManager.updateConnection(connectionId, change);
      } else {
        layoutManager.addConnection(routingLayout.getConnectionById(connectionId)!);
      }
    }
    connectionUpdates.set(connectionId, stagedConnectionChange(layoutManager, connectionId)!);
  }
  return { updates: connectionUpdates, fallbacks };
}

/** A connection's staged change: the whole connection when newly added, else its merged update. */
function stagedConnectionChange(
  layout: LayoutManager,
  connectionId: string,
): LayoutConnectionChange | undefined {
  return layout.stagedChanges?.addedConnections.has(connectionId)
    ? layout.getConnectionById(connectionId)
    : layout.stagedChanges?.updatedConnections.get(connectionId);
}

/**
 * Project the layout into what routing sees, for every routing phase including
 * shifts and labels. An entity marked `skipRoutingObstacle` keeps only its label
 * as an obstacle, and its children route as children of its nearest routed ancestor.
 */
function makeRoutingLayout(layoutManager: LayoutManager): LayoutManager {
  const initial = layoutManager.getEntities(false);
  const current = layoutManager.getEntities();
  if (!initial.some(skipsRouting) && !current.some(skipsRouting)) {
    return layoutManager;
  }

  function snapshot(entities: LayoutEntity[], includeStaged: boolean) {
    const skipped = new Map(entities.filter(skipsRouting).map((entity) => [entity.id, entity]));
    return new LayoutManager({
      entities: entities.flatMap((entity) => {
        const routed = skipped.has(entity.id) ? labelObstacle(entity) : entity;
        if (!routed) {
          return [];
        }
        let containerId = routed.containerId;
        while (containerId && skipped.has(containerId)) {
          containerId = skipped.get(containerId)!.containerId;
        }
        return [containerId === routed.containerId ? routed : { ...routed, containerId }];
      }),
      connections: layoutManager.getConnections(includeStaged),
      primaryDirection: layoutManager.primaryDirection,
      options: layoutManager.options,
      origin: layoutManager.origin,
    });
  }

  // A fork alone would replace the gesture baseline with the current positions.
  const routingLayout = snapshot(initial, false);
  if (layoutManager.stagedChanges) {
    routingLayout.restore(snapshot(current, true));
  }
  return routingLayout;
}

function skipsRouting(entity: LayoutEntity): boolean {
  return entity.options?.skipRoutingObstacle === true;
}

/** The label box of an entity routing otherwise ignores; unlabeled entities vanish. */
function labelObstacle({
  id,
  containerId,
  x,
  y,
  textPlacement,
}: LayoutEntity): LayoutEntity | undefined {
  return textPlacement
    ? {
        id,
        containerId,
        x: x + textPlacement.relativeX,
        y: y + textPlacement.relativeY,
        width: textPlacement.width,
        height: textPlacement.height,
      }
    : undefined;
}

/**
 * Prepare each connection once, solve the supported batch, then commit either
 * solved geometry or a complete fallback change. Unselected incumbents participate
 * at their stored geometry; an unadoptable incumbent is simply left untouched.
 */
function routeCorridorConnections(
  layoutManager: LayoutManager,
  pending: ReadonlyMap<string, ConnectionRoutingRequest>,
  repair: RepairPolicy,
  groupedPinnedPorts: boolean,
): Set<string> {
  const fallbacks = new Set<string>();
  if (pending.size === 0) {
    return fallbacks;
  }

  const existing = layoutManager.getConnections();
  const existingIds = new Set(existing.map(({ id }) => id));
  // Keep scene order and include fixed incumbents alongside the routes being solved.
  const batch: ConnectionRoutingRequest[] = [
    ...existing.map((connection) => pending.get(connection.id) ?? { connection }),
    ...[...pending.values()].filter(({ connection }) => !existingIds.has(connection.id)),
  ];
  const entities = layoutManager.getEntities();
  const requests = buildRouteRequests(layoutManager, batch, pending, groupedPinnedPorts);
  const changes = new Map<number, RoutedConnectionChange>();

  // Any throw while solving or converting routes selects fallback for every pending route.
  // Failed model commits must not be silently retried or reported as a
  // successfully routed connection.
  try {
    const execution = executeCorridorRouting(
      layoutManager,
      requests.filter((request): request is CorridorRoutingRequest => request !== undefined),
      { repair },
    );
    if (execution.status === 'completed') {
      const labelByRoute = new Map(
        execution.labels?.placements.map((placement) => [placement.routeIndex, placement]) ?? [],
      );
      execution.activeRequestIndexes.forEach((requestIndex, localIndex) => {
        const input = batch[requestIndex];
        if (!pending.has(input.connection.id)) {
          return;
        }
        const points =
          execution.labels?.routePoints[localIndex] ??
          execution.realization.routes[localIndex].points();
        const change = connectionChange(
          points,
          labelByRoute.get(localIndex),
          requests[requestIndex]!,
          entities,
          input,
        );
        if (change) {
          changes.set(requestIndex, change);
        }
      });
    }
  } catch (error) {
    // Unexpected solver failures still get the same ordinary fallback geometry.
    // Fallback construction and committing deliberately sit outside this catch.
    if (process.env.NODE_ENV !== 'production') {
      console.error('Corridor routing failed; falling back for', [...pending.keys()], error);
    }
  }

  batch.forEach((input, requestIndex) => {
    const { connection } = input;
    if (!pending.has(connection.id)) {
      return;
    }
    const routed = changes.get(requestIndex);
    const change = routed ?? fallbackChange(layoutManager, input, requests[requestIndex]);
    if (existingIds.has(connection.id)) {
      commitExistingConnection(layoutManager, connection, change);
    } else {
      layoutManager.addConnection({ ...connection, ...change });
    }
    if (!routed) {
      fallbacks.add(connection.id);
    }
  });
  return fallbacks;
}

function commitExistingConnection(
  layoutManager: LayoutManager,
  connection: NewConnection,
  change: RoutedConnectionChange,
): void {
  const { textPlacement, ...input } = connection;
  // Without new label geometry, let the manager translate the incumbent label.
  layoutManager.updateConnection(connection.id, {
    ...input,
    ...(textPlacement === layoutManager.getConnectionById(connection.id)?.textPlacement
      ? {}
      : { textPlacement }),
    ...change,
  });
}

function fallbackChange(
  layoutManager: LayoutManager,
  { connection, endpointPins }: ConnectionRoutingRequest,
  request: RouteSearchRequest | undefined,
): RoutedConnectionChange {
  const entitiesById = layoutManager.getEntitiesMapping();
  const fromEntity = entitiesById[connection.from];
  const toEntity = entitiesById[connection.to];
  const fromPin = endpointPins?.from;
  const toPin = endpointPins?.to;
  const fromFace =
    fromPin && fromEntity
      ? getPortDirection(fromPin, fromEntity)
      : request && !isPointEndpoint(request.from)
        ? request.from.face
        : undefined;
  const toFace =
    toPin && toEntity
      ? getPortDirection(toPin, toEntity)
      : request && !isPointEndpoint(request.to)
        ? request.to.face
        : undefined;
  return makeRoughFallbackConnectionChange(layoutManager, connection, {
    fromFace,
    toFace,
    startPoint: fromPin ?? fallbackEndpointPoint(fromEntity, request?.from),
    endPoint: toPin ?? fallbackEndpointPoint(toEntity, request?.to),
  });
}

function fallbackEndpointPoint(
  entity: LayoutEntity | undefined,
  endpoint: RouteEndpoint | undefined,
): Point | undefined {
  if (!endpoint) {
    return undefined;
  }
  if (isPointEndpoint(endpoint)) {
    return [endpoint.x, endpoint.y];
  }
  if (!entity) {
    return undefined;
  }
  const plane = Math.round(terminalFacePlane(entity, endpoint.face));
  const track = Math.round(endpointTrackCoordinate(entity, endpoint));
  return isHorizontal(endpoint.face) ? [plane, track] : [track, plane];
}

/** The face of `entity` most directly facing `point`, normalized by half-extents. */
function faceTowardPoint(entity: LayoutEntity, point: Point): Direction {
  const dx = point[0] - (entity.x + entity.width / 2);
  const dy = point[1] - (entity.y + entity.height / 2);
  const nx = dx / Math.max(1, entity.width / 2);
  const ny = dy / Math.max(1, entity.height / 2);
  if (Math.abs(nx) >= Math.abs(ny)) {
    return nx >= 0 ? 'right' : 'left';
  }
  return ny >= 0 ? 'down' : 'up';
}

/** Solver endpoint for one side: a free point, an exact pin, or an entity face with its whole-pixel stored track. */
function resolveRouteEndpoint(
  { connection, endpointPins }: ConnectionRoutingRequest,
  faces: RouteFaces | undefined,
  side: EndpointSide,
  entitiesById: Record<string, LayoutEntity>,
  entityIndexById: ReadonlyMap<string, number>,
): RouteEndpoint | undefined {
  const entityId = connection[side];
  const entity = entitiesById[entityId];
  const pin = endpointPins?.[side];
  if ((entityId && !entity) || (pin && !isFinitePoint(pin))) {
    return undefined;
  }
  const hasArrowhead = side === 'from' ? connection.fromArrowhead : connection.toArrowhead;
  if (!entity) {
    const stored = storedEndpoint(connection, side);
    const point = pin ?? (stored && roundPoint(stored));
    return point ? { kind: 'point', x: point[0], y: point[1], hasArrowhead } : undefined;
  }
  const entityIndex = entityIndexById.get(entity.id)!;
  if (pin) {
    const face = getPortDirection(pin, entity);
    return { entityIndex, face, authoredTrack: isHorizontal(face) ? pin[1] : pin[0], hasArrowhead };
  }
  const relativePort = side === 'from' ? connection.relativeFromPort : connection.relativeToPort;
  let face = faces?.[side] ?? authoredEndpointFace(connection, side);
  if (!face) {
    const oppositeSide = side === 'from' ? 'to' : 'from';
    const opposite = entitiesById[connection[oppositeSide]];
    const storedOpposite = storedEndpoint(connection, oppositeSide);
    const oppositePoint = endpointPins?.[oppositeSide] ??
      (opposite
        ? ([opposite.x + opposite.width / 2, opposite.y + opposite.height / 2] as Point)
        : storedOpposite && roundPoint(storedOpposite)) ?? [0, 0];
    face = faceTowardPoint(entity, oppositePoint);
  }
  // Stored ports use the whole-pixel routing grid; explicit pins above stay exact.
  return {
    entityIndex,
    face,
    hasArrowhead,
    authoredTrack: relativePort
      ? getAbsolutePortPoint(entity, relativePort)[isHorizontal(face) ? 1 : 0]
      : undefined,
  };
}

/**
 * Resolve solver endpoints from the same connection/pins used by fallback and
 * emission. requestIndex is stable across the batch, including unsupported inputs.
 */
function buildRouteRequests(
  layoutManager: LayoutManager,
  batch: readonly ConnectionRoutingRequest[],
  pending: ReadonlyMap<string, ConnectionRoutingRequest>,
  groupedPinnedPorts: boolean,
): (CorridorRoutingRequest | undefined)[] {
  const portGroups = groupedPinnedPorts ? new Map<string, number>() : undefined;
  const groupEndpoint = (endpoint: RouteEndpoint): RouteEndpoint => {
    if (!portGroups || isPointEndpoint(endpoint) || endpoint.authoredTrack === undefined) {
      return endpoint;
    }
    const key = `${endpoint.entityIndex}:${endpoint.face}:${endpoint.authoredTrack}`;
    let portGroup = portGroups.get(key);
    if (portGroup === undefined) {
      portGroup = portGroups.size;
      portGroups.set(key, portGroup);
    }
    return { ...endpoint, portGroup };
  };
  const entitiesById = layoutManager.getEntitiesMapping();
  const entityIndexById = new Map(
    layoutManager.getEntities().map((entity, index) => [entity.id, index]),
  );
  const assignedFaces = assignFaces(
    layoutManager,
    batch
      .filter(
        ({ connection, endpointPins }) =>
          entitiesById[connection.from] &&
          entitiesById[connection.to] &&
          !endpointPins?.from &&
          !endpointPins?.to,
      )
      .map(({ connection }) => connection),
  );

  return batch.map((request, requestIndex) => {
    const { connection, endpointPins } = request;
    const mutable = pending.has(connection.id);
    const faces = assignedFaces.get(connection.id);
    let from = resolveRouteEndpoint(request, faces, 'from', entitiesById, entityIndexById);
    let to = resolveRouteEndpoint(request, faces, 'to', entitiesById, entityIndexById);
    if (!from || !to) {
      return undefined;
    }
    if (mutable && !endpointPins?.from && !endpointPins?.to) {
      [from, to] = spreadCoincidentSelfLoop(from, to, entitiesById[connection.from]);
    }
    const label = connection.textPlacement;
    // Incumbents are stored LayoutConnections.
    const adoptedPoints = !mutable
      ? absoluteConnectionPoints(connection as LayoutConnection).map(roundPoint)
      : undefined;
    return {
      requestIndex,
      from: groupEndpoint(from),
      to: groupEndpoint(to),
      adoptedPoints,
      ...(mutable && hasMeasuredLabel(label)
        ? { labelSize: { width: label.width, height: label.height } }
        : {}),
    };
  });
}

/** Attachments along one face for a self-loop whose ends would otherwise coincide. */
const SELF_LOOP_TRACK_FRACTIONS = [0.35, 0.65] as const;

/** Unknown tracks coincide only with each other; known ones closer than line spacing do. */
function tracksCoincide(from: number | undefined, to: number | undefined): boolean {
  if (from === undefined || to === undefined) {
    return from === to;
  }
  return Math.abs(from - to) < MIN_TRACK_SEPARATION_PX;
}

/** A same-face self-loop needs two distinct attachments to form a loop. */
function spreadCoincidentSelfLoop(
  from: RouteEndpoint,
  to: RouteEndpoint,
  entity: LayoutEntity,
): [RouteEndpoint, RouteEndpoint] {
  if (
    isPointEndpoint(from) ||
    isPointEndpoint(to) ||
    from.entityIndex !== to.entityIndex ||
    from.face !== to.face ||
    !tracksCoincide(from.authoredTrack, to.authoredTrack)
  ) {
    return [from, to];
  }
  const [faceStart, faceSpan] = isHorizontal(from.face)
    ? [entity.y, entity.height]
    : [entity.x, entity.width];
  const [fromFraction, toFraction] = SELF_LOOP_TRACK_FRACTIONS;
  return [
    { ...from, authoredTrack: Math.round(faceStart + fromFraction * faceSpan) },
    { ...to, authoredTrack: Math.round(faceStart + toFraction * faceSpan) },
  ];
}

function connectionChange(
  points: readonly XYPoint[],
  label: RealizedLabelPlacement | undefined,
  request: RouteSearchRequest,
  entities: readonly LayoutEntity[],
  { connection, endpointPins }: ConnectionRoutingRequest,
): RoutedConnectionChange | undefined {
  const normalizedPoints = simplifyCollinearPoints(points.map(({ x, y }): Point => [x, y]));
  for (const side of ['from', 'to'] as const) {
    const point = endpointPins?.[side];
    const endpoint = request[side];
    if (
      point &&
      !isPointEndpoint(endpoint) &&
      !applyEndpointReanchor(normalizedPoints, side, point, endpoint.face)
    ) {
      return undefined;
    }
  }
  const first = normalizedPoints[0];
  const last = normalizedPoints.at(-1);
  if (!first || !last) {
    throw new Error(`Routing corridor emitted an incomplete route ${request.requestIndex}`);
  }
  return {
    ...connectionGeometryFromPoints(normalizedPoints),
    relativeFromPort: endpointRelativePort(
      request.from,
      entities,
      first,
      endpointPins?.from ? undefined : connection.relativeFromPort,
    ),
    relativeToPort: endpointRelativePort(
      request.to,
      entities,
      last,
      endpointPins?.to ? undefined : connection.relativeToPort,
    ),
    ...(label ? { textPlacement: { ...label.rect } } : {}),
  };
}

/**
 * Re-derive the emitted port, except that a stored port whose rounded track the
 * route honored stays exact, so the whole-pixel grid never drifts stored ports.
 */
function endpointRelativePort(
  endpoint: RouteEndpoint,
  entities: readonly LayoutEntity[],
  point: Point,
  storedPort: RelativePortPosition | undefined,
): RelativePortPosition | undefined {
  if (isPointEndpoint(endpoint)) {
    return undefined;
  }
  const entity = entities[endpoint.entityIndex];
  if (!entity) {
    return undefined;
  }
  const port = getRelativePort(entity, point, endpoint.face);
  const normal = isHorizontal(endpoint.face) ? 0 : 1;
  if (
    storedPort &&
    storedPort[normal] === port[normal] &&
    point[1 - normal] === getAbsolutePortPoint(entity, storedPort)[1 - normal]
  ) {
    return [...storedPort];
  }
  return port;
}

/** Move the terminal onto the pin only if the emitted approach survives the move. */
function applyEndpointReanchor(
  points: Point[],
  side: EndpointSide,
  point: Point,
  face: Direction,
): boolean {
  if (points.length < 2) {
    return false;
  }
  const terminalIndex = side === 'from' ? 0 : points.length - 1;
  const neighbor = points[side === 'from' ? 1 : points.length - 2];
  const axis = isHorizontal(face) ? 0 : 1;
  // Container faces may be reached from inside (child-to-ancestor edges); keep the corridor's side.
  const approach = Math.sign(neighbor[axis] - points[terminalIndex][axis]) || outwardSign(face);
  if (neighbor[1 - axis] !== point[1 - axis] || approach * (neighbor[axis] - point[axis]) <= 0) {
    return false;
  }
  points[terminalIndex] = [...point];
  return true;
}

/** A straight or arc connection: drawn as one direct segment, never routed through corridors. */
export function isDirectConnection(connection: Pick<NewConnection, 'connectorStyle'>): boolean {
  return connection.connectorStyle === 'straight' || connection.connectorStyle === 'arc';
}

/**
 * Route a straight or arc connection: its bound ends follow their entities from where they were
 * before the staged changes (a straight end by its focus binding, an arc end by its fixed anchor);
 * a connection with no path runs centre to centre. Explicit pins win. Its label goes at the apex,
 * the segment's middle, or a manual label's anchor.
 */
function routeDirectConnection(
  layoutManager: LayoutManager,
  connection: NewConnection,
  pins: EndpointPins | undefined,
): RoutedConnectionChange | undefined {
  const before = (id: string) => layoutManager.getEntityById(id, false, false);
  const after = (id: string) => layoutManager.getEntityById(id, false, true);
  const stored =
    connection.points && connection.points.length >= 2
      ? absoluteConnectionPoints({
          x: connection.x ?? 0,
          y: connection.y ?? 0,
          points: connection.points,
        })
      : [];
  const label = connection.textPlacement;
  const was: DirectLine = {
    style: connection.connectorStyle === 'arc' ? 'arc' : 'straight',
    from: connection.from,
    to: connection.to,
    points: stored,
    bend: connection.bend ?? null,
  };

  let ends: [DirectPoint, DirectPoint] | undefined;
  if (stored.length >= 2) {
    const beforeBox = (id: string) => before(id) ?? after(id);
    ends = followBoxes(was, bindingOf(was, beforeBox), after);
  } else {
    const fromBox = after(connection.from);
    const toBox = after(connection.to);
    if (fromBox && toBox) {
      ends =
        connection.authoredFromFace || connection.authoredToFace
          ? faceAnchoredSegment(
              fromBox,
              toBox,
              connection.authoredFromFace,
              connection.authoredToFace,
            )
          : centreSegment(fromBox, toBox);
    }
  }
  const start = pins?.from ?? ends?.[0];
  const end = pins?.to ?? ends?.[1];
  if (!start || !end) {
    return undefined;
  }
  const points: Point[] = [[...start], [...end]];
  const lineOffset = connection.textLineOffset;
  const manual =
    label && lineOffset !== undefined ? { on: was, box: label, lineOffset } : undefined;
  const placed = label ? directLabel({ ...was, points }, label, manual) : undefined;
  return {
    ...connectionGeometryFromPoints(points),
    relativeFromPort: undefined,
    relativeToPort: undefined,
    textPlacement: placed ?? label,
  };
}

interface ManualLabelSnapshot {
  readonly oldRoute: Point[];
  readonly box: PositionProps;
  readonly lineOffset: number;
}

/**
 * What a manually placed elbow label (one with `textLineOffset`) needs to keep its place along the
 * line through a fresh route: the old route and the label's centre on it.
 */
function manualLabelSnapshot(
  existing: LayoutConnection | undefined,
  connection: NewConnection,
): ManualLabelSnapshot | undefined {
  const lineOffset = connection.textLineOffset ?? existing?.textLineOffset;
  const label = connection.textPlacement ?? existing?.textPlacement;
  if (lineOffset === undefined || !label || !existing || existing.points.length < 2) {
    return undefined;
  }
  if (![label.x, label.y, label.width, label.height].every(Number.isFinite)) {
    return undefined;
  }
  return {
    oldRoute: absoluteConnectionPoints(existing),
    box: label,
    lineOffset,
  };
}

/** Put each manual label back at its place along its line's new route. */
function restoreManualLabels(
  layoutManager: LayoutManager,
  snapshots: ReadonlyMap<string, ManualLabelSnapshot>,
): void {
  for (const [connectionId, snapshot] of snapshots) {
    const connection = layoutManager.getConnectionById(connectionId);
    if (!connection || connection.points.length < 2) {
      continue;
    }
    const { oldRoute, box, lineOffset } = snapshot;
    const moved = moveManualLabel(oldRoute, box, lineOffset, absoluteConnectionPoints(connection), box);
    if (moved) {
      layoutManager.updateConnection(connectionId, { textPlacement: moved });
    }
  }
}
