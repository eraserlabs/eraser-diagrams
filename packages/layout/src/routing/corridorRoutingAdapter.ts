import { legacyDirectionToDirection, OPPOSITE_DIRECTION } from '../directionUtils.js';
import { LayoutManager } from '../LayoutManager.js';
import { simplifyCollinearPoints } from './polylineUtils.js';
import type {
  Direction,
  LayoutConnection,
  LayoutConnectionChange,
  LayoutEntity,
  NewConnection,
  XYPoint,
} from '../types.js';
import { assignFaces, type FaceSelectionConnection, type FaceSelectionRequest } from './faces.js';
import {
  makeRoughFallbackConnectionChange,
  makeRoughFallbackPoints,
} from './fallbackConnection.js';
import { getRelativePort, getRelativePortCoord } from '../portUtils.js';
import type { Point } from './types.js';
import type { RelativePortPosition } from './types.js';
import type { RouteEndpoint, RouteSearchRequest } from './corridor/contract.js';
import { terminalFacePlane } from './corridor/geometry.js';
import type { RealizedLabelPlacement } from './corridor/labelPlacement.js';
import { CorridorSpacingError } from './corridor/spacing.js';
import type { LabelSpec } from './corridor/text.js';
import {
  CorridorAdoptionError,
  executeCorridorRouting,
  type CorridorRoutingResult,
} from './executeCorridorRouting.js';

type FaceSelectionConnectionInput = FaceSelectionConnection & {
  readonly relativeFromPort?: LayoutConnection['relativeFromPort'];
  readonly relativeToPort?: LayoutConnection['relativeToPort'];
  readonly fromArrowhead?: LayoutConnection['fromArrowhead'];
  readonly toArrowhead?: LayoutConnection['toArrowhead'];
};

export interface CorridorConnectionBatchRoutingOptions {
  /** Run the accepted production repair composition after initial realization. */
  readonly repair?: boolean;
  /** Total cooperative repair budget in milliseconds; defaults to 100. */
  readonly repairTimeBudgetMs?: number;
  /** Place measured labels and commit their final route geometry. */
  readonly labels?: boolean;
  /** Keep selected existing connections on their authored endpoint ports. */
  readonly preservePorts?: boolean;
  /** Adopt all unselected connections at their exact current geometry. */
  readonly pinUnaffectedRoutes?: boolean;
}

export interface CorridorConnectionRoutingResult {
  readonly connectionId: string;
  readonly status: 'valid' | 'fallback';
}

export type CorridorConnectionBatchRoutingResult = readonly CorridorConnectionRoutingResult[];

export interface CorridorRoutingRecoveryFailure {
  readonly routeIndex: number;
}

export interface ActiveRouteRequest {
  readonly routeIndex: number;
  readonly request: RouteSearchRequest;
}

export interface RecoveredCorridorExecution {
  readonly execution?: CorridorRoutingResult;
  readonly active: readonly ActiveRouteRequest[];
  readonly failures: readonly CorridorRoutingRecoveryFailure[];
}

export type AdoptedRoute = {
  readonly points: readonly (readonly [number, number])[];
  readonly pinTracks?: boolean;
};

export interface RecoverableCorridorRoutingOptions {
  readonly repair?: boolean;
  readonly repairTimeBudgetMs?: number;
  readonly labelSpecs: readonly LabelSpec[];
  readonly adoptedRoutes: ReadonlyMap<number, AdoptedRoute>;
}

export interface RouteCorridorConnectionBatchArgs {
  readonly layoutManager: LayoutManager;
  readonly connectionsToRoute: readonly NewConnection[];
  readonly options?: CorridorConnectionBatchRoutingOptions;
}

/**
 * Route selected connections through the production corridor pipeline while
 * adopting unselected incumbents at their exact geometry. Attributed search
 * and corridor-spacing failures are removed and the remaining batch is retried;
 * failed mutable connections receive direct geometry. Every non-empty call
 * returns at least two points per selected connection and reports whether each
 * mutable connection received corridor or fallback geometry.
 */
export function routeCorridorConnectionBatch({
  layoutManager,
  connectionsToRoute,
  options = {},
}: RouteCorridorConnectionBatchArgs): CorridorConnectionBatchRoutingResult | undefined {
  if (connectionsToRoute.length === 0) {
    return undefined;
  }

  const entitiesById = layoutManager.getEntitiesMapping();
  const routable: NewConnection[] = [];
  const unsupported: NewConnection[] = [];
  for (const connection of connectionsToRoute) {
    if (
      connection.from &&
      connection.to &&
      connection.from in entitiesById &&
      connection.to in entitiesById
    ) {
      // A requested route is fresh input. Stored geometry may be malformed, but
      // it must never prevent the bound endpoints from receiving a new route.
      const { x: _x, y: _y, points: _points, ...withoutGeometry } = connection;
      routable.push(withoutGeometry);
    } else {
      unsupported.push(connection);
    }
  }

  const results = [
    ...(routable.length > 0
      ? routeBoundCorridorConnectionBatch({ layoutManager, connectionsToRoute: routable, options })
      : []),
    ...(unsupported.length > 0
      ? routeDirectFallbackBatch(layoutManager, unsupported, new Map())
      : []),
  ];
  const resultById = new Map(results.map((result) => [result.connectionId, result]));
  return connectionsToRoute.flatMap((connection) => {
    const result = resultById.get(connection.id);
    return result ? [result] : [];
  });
}

function routeBoundCorridorConnectionBatch({
  layoutManager,
  connectionsToRoute,
  options,
}: Required<RouteCorridorConnectionBatchArgs>): CorridorConnectionBatchRoutingResult {
  let fallbackConnections = connectionsToRoute;
  let fallbackRequests = new Map<string, RouteSearchRequest>();
  try {
    const entitiesById = layoutManager.getEntitiesMapping();
    const selectedById = new Map(
      connectionsToRoute.map((connection) => [connection.id, connection]),
    );
    const selectedIds = new Set(selectedById.keys());
    const existingById = new Map(
      layoutManager.getConnections().map((connection) => [connection.id, connection]),
    );
    const allConnections: NewConnection[] = layoutManager
      .getConnections()
      // Dangling incumbents cannot participate in corridor routing. Keep them
      // untouched instead of allowing one unrelated connector to force every
      // selected, fully-bound route into direct fallback geometry.
      .filter(
        (connection) =>
          selectedIds.has(connection.id) ||
          (!!connection.from &&
            !!connection.to &&
            connection.from in entitiesById &&
            connection.to in entitiesById),
      )
      .map((connection) =>
        selectedIds.has(connection.id)
          ? (selectedById.get(connection.id) ?? connection)
          : connection,
      );
    for (const connection of connectionsToRoute) {
      if (!existingById.has(connection.id)) {
        allConnections.push(connection);
      }
    }
    const mutableIds =
      options.pinUnaffectedRoutes === false
        ? new Set(allConnections.map((connection) => connection.id))
        : selectedIds;
    fallbackConnections = allConnections.filter((connection) => mutableIds.has(connection.id));
    if (
      allConnections.some(
        (connection) =>
          !connection.from ||
          !connection.to ||
          !(connection.from in entitiesById) ||
          !(connection.to in entitiesById),
      )
    ) {
      return routeDirectFallbackBatch(layoutManager, fallbackConnections, fallbackRequests);
    }

    const connections = faceSelectionConnections(allConnections, mutableIds, options);
    const requests = fixedFaceRequests(layoutManager, connections, entitiesById);
    fallbackRequests = new Map(
      allConnections.map((connection, routeIndex) => [connection.id, requests[routeIndex]]),
    );
    const adoptedRoutes = new Map<number, AdoptedRoute>();
    if (options.pinUnaffectedRoutes !== false) {
      for (let routeIndex = 0; routeIndex < allConnections.length; routeIndex += 1) {
        const connection = allConnections[routeIndex];
        if (mutableIds.has(connection.id) || !existingById.has(connection.id)) {
          continue;
        }
        const incumbent = existingById.get(connection.id);
        if (!incumbent) {
          return routeDirectFallbackBatch(layoutManager, fallbackConnections, fallbackRequests);
        }
        const points = absoluteConnectionPoints(incumbent);
        if (points.length < 2) {
          return routeDirectFallbackBatch(layoutManager, fallbackConnections, fallbackRequests);
        }
        adoptedRoutes.set(routeIndex, { points, pinTracks: true });
      }
    }
    const recovery = executeRecoverableCorridorRouting(layoutManager, requests, {
      repair: options.repair,
      repairTimeBudgetMs: options.repairTimeBudgetMs,
      labelSpecs: options.labels === false ? [] : measuredLabelSpecs(allConnections, mutableIds),
      adoptedRoutes,
    });
    if (!recovery.execution) {
      return routeDirectFallbackBatch(layoutManager, fallbackConnections, fallbackRequests);
    }
    const { labels, realization } = recovery.execution;
    const labelByRoute = new Map(
      labels?.placements.map((placement) => [placement.routeIndex, placement]) ?? [],
    );
    const localRouteIndexByOriginal = new Map(
      recovery.active.map(({ routeIndex }, localRouteIndex) => [routeIndex, localRouteIndex]),
    );
    const failureByRoute = new Map(
      recovery.failures.map((failure) => [failure.routeIndex, failure]),
    );
    const changes = new Map<string, LayoutConnectionChange>();
    const fallbackInputs = new Map<string, NewConnection>();

    for (let routeIndex = 0; routeIndex < allConnections.length; routeIndex += 1) {
      const connection = allConnections[routeIndex];
      if (!mutableIds.has(connection.id)) {
        continue;
      }
      if (failureByRoute.has(routeIndex)) {
        const existing = existingById.get(connection.id);
        const effective = existing ? { ...existing, ...connection } : connection;
        const fixedConnection = {
          ...effective,
          authoredFromFace: requests[routeIndex].from.face,
          authoredToFace: requests[routeIndex].to.face,
        };
        fallbackInputs.set(connection.id, fixedConnection);
        changes.set(
          connection.id,
          directFallbackChange(layoutManager, fixedConnection, requests[routeIndex]),
        );
        continue;
      }
      const localRouteIndex = localRouteIndexByOriginal.get(routeIndex);
      if (localRouteIndex === undefined) {
        throw new Error(`corridor recovery lost route ${routeIndex}`);
      }
      const geometry =
        labels?.routePoints[localRouteIndex] ?? realization.routes[localRouteIndex].points();
      const fromEntity = entitiesById[connection.from] as LayoutEntity;
      const toEntity = entitiesById[connection.to] as LayoutEntity;
      changes.set(
        connection.id,
        connectionChange(
          geometry,
          labelByRoute.get(localRouteIndex),
          requests[routeIndex],
          fromEntity,
          toEntity,
        ),
      );
    }

    for (const connection of allConnections) {
      if (!mutableIds.has(connection.id)) {
        continue;
      }
      const change = changes.get(connection.id);
      if (!change) {
        continue;
      }
      if (existingById.has(connection.id)) {
        layoutManager.updateConnection(connection.id, change);
      } else {
        const input = fallbackInputs.get(connection.id) ?? connection;
        layoutManager.addConnection({
          ...input,
          ...change,
          ...(fallbackInputs.has(connection.id) && !finiteTextPlacement(input.textPlacement)
            ? { textPlacement: undefined }
            : {}),
        } as LayoutConnection);
      }
    }

    const fallbackConnectionIds = new Set<string>();
    for (const { routeIndex } of recovery.failures) {
      const connectionId = allConnections[routeIndex]?.id;
      if (connectionId !== undefined && mutableIds.has(connectionId)) {
        fallbackConnectionIds.add(connectionId);
      }
    }
    return connectionRoutingResults(fallbackConnections, fallbackConnectionIds);
  } catch {
    return routeDirectFallbackBatch(layoutManager, fallbackConnections, fallbackRequests);
  }
}

export function executeRecoverableCorridorRouting(
  layoutManager: LayoutManager,
  requests: readonly RouteSearchRequest[],
  options: RecoverableCorridorRoutingOptions,
): RecoveredCorridorExecution {
  let active: ActiveRouteRequest[] = requests.map((request, routeIndex) => ({
    routeIndex,
    request,
  }));
  const failures: CorridorRoutingRecoveryFailure[] = [];

  while (active.length > 0) {
    const labelSpecs = active.flatMap(({ routeIndex }, localRouteIndex) =>
      options.labelSpecs.flatMap((spec): LabelSpec[] =>
        spec.routeIndex === routeIndex ? [{ ...spec, routeIndex: localRouteIndex }] : [],
      ),
    );
    const adoptedRoutes = new Map<number, AdoptedRoute>();
    active.forEach(({ routeIndex }, localRouteIndex) => {
      const adopted = options.adoptedRoutes.get(routeIndex);
      if (adopted) {
        adoptedRoutes.set(localRouteIndex, adopted);
      }
    });

    try {
      const execution = executeCorridorRouting(
        layoutManager,
        active.map(({ request }, requestIndex) => ({ ...request, requestIndex })),
        {
          repair: options.repair,
          repairOptions: { timeBudgetMs: options.repairTimeBudgetMs },
          labelSpecs,
          adoptedRoutes,
        },
      );
      if (!execution) {
        break;
      }
      if (execution.status === 'completed') {
        return { execution, active, failures };
      }
      const failedLocalIndexes = execution.searchResults.flatMap((result, localRouteIndex) =>
        result.fallback ? [localRouteIndex] : [],
      );
      if (failedLocalIndexes.length === 0) {
        break;
      }
      const failed = new Set(failedLocalIndexes);
      for (const localRouteIndex of failedLocalIndexes) {
        failures.push({ routeIndex: active[localRouteIndex].routeIndex });
      }
      active = active.filter((_, localRouteIndex) => !failed.has(localRouteIndex));
    } catch (error) {
      if (error instanceof CorridorAdoptionError) {
        const failedLocalIndexes = [...new Set(error.routeIndexes)];
        if (
          failedLocalIndexes.length === 0 ||
          failedLocalIndexes.some(
            (routeIndex) =>
              !Number.isInteger(routeIndex) ||
              routeIndex < 0 ||
              routeIndex >= active.length ||
              !options.adoptedRoutes.has(active[routeIndex].routeIndex),
          )
        ) {
          throw error;
        }
        const failed = new Set(failedLocalIndexes);
        active = active.filter((_, localRouteIndex) => !failed.has(localRouteIndex));
        continue;
      }
      if (!(error instanceof CorridorSpacingError)) {
        throw error;
      }
      const failedLocalIndexes = [...new Set(error.routeIndexes)];
      if (
        failedLocalIndexes.length === 0 ||
        failedLocalIndexes.some(
          (routeIndex) =>
            !Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex >= active.length,
        )
      ) {
        throw error;
      }
      const failed = new Set(failedLocalIndexes);
      for (const localRouteIndex of failedLocalIndexes) {
        failures.push({ routeIndex: active[localRouteIndex].routeIndex });
      }
      active = active.filter((_, localRouteIndex) => !failed.has(localRouteIndex));
    }
  }

  return { active, failures };
}

function routeDirectFallbackBatch(
  layoutManager: LayoutManager,
  connections: readonly NewConnection[],
  requestsByConnectionId: ReadonlyMap<string, RouteSearchRequest>,
): CorridorConnectionBatchRoutingResult {
  try {
    return routeDirectFallbackBatchInternal(layoutManager, connections, requestsByConnectionId);
  } catch {
    return emergencyDirectFallbackBatch(layoutManager, connections);
  }
}

function routeDirectFallbackBatchInternal(
  layoutManager: LayoutManager,
  connections: readonly NewConnection[],
  requestsByConnectionId: ReadonlyMap<string, RouteSearchRequest>,
): CorridorConnectionBatchRoutingResult {
  for (const input of connections) {
    const existing = layoutManager.getConnectionById(input.id);
    const connection = existing ? { ...existing, ...input } : input;
    const request = requestsByConnectionId.get(connection.id);
    const fixedConnection = request
      ? {
          ...connection,
          authoredFromFace: request.from.face,
          authoredToFace: request.to.face,
        }
      : connection;
    const change = directFallbackChange(layoutManager, fixedConnection, request);
    try {
      if (existing) {
        layoutManager.updateConnection(connection.id, change);
      } else {
        layoutManager.addConnection({
          ...fixedConnection,
          ...change,
          ...(finiteTextPlacement(fixedConnection.textPlacement)
            ? { textPlacement: fixedConnection.textPlacement }
            : { textPlacement: undefined }),
        } as LayoutConnection);
      }
    } catch {
      // A manager may reject a commit for an unrelated model-level reason.
    }
  }
  return connectionRoutingResults(connections, new Set(connections.map(({ id }) => id)));
}

function emergencyDirectFallbackBatch(
  layoutManager: LayoutManager,
  connections: readonly NewConnection[],
): CorridorConnectionBatchRoutingResult {
  for (const connection of connections) {
    const change = emergencyDirectFallbackChange(connection);
    try {
      const existing = layoutManager.getConnectionById(connection.id);
      if (existing) {
        layoutManager.updateConnection(connection.id, change);
      } else {
        layoutManager.addConnection({ ...connection, ...change } as LayoutConnection);
      }
    } catch {
      // A manager may reject a commit for an unrelated model-level reason.
    }
  }
  return connectionRoutingResults(connections, new Set(connections.map(({ id }) => id)));
}

function connectionRoutingResults(
  connections: readonly NewConnection[],
  fallbackConnectionIds: ReadonlySet<string>,
): CorridorConnectionBatchRoutingResult {
  return connections.map(({ id }) => ({
    connectionId: id,
    status: fallbackConnectionIds.has(id) ? 'fallback' : 'valid',
  }));
}

function emergencyDirectFallbackChange(connection: NewConnection): LayoutConnectionChange {
  const start = storedAbsolutePoint(connection, connection.points?.[0]) ?? ([0, 0] as Point);
  const end =
    storedAbsolutePoint(connection, connection.points?.at(-1)) ??
    ([start[0] + 10, start[1]] as Point);
  const fromFace = legacyDirectionToDirection(connection.authoredFromFace) ?? 'right';
  const toFace =
    legacyDirectionToDirection(connection.authoredToFace) ?? OPPOSITE_DIRECTION[fromFace];
  return absolutePointsChange(makeRoughFallbackPoints(start, end, fromFace, toFace));
}

function directFallbackChange(
  layoutManager: LayoutManager,
  connection: NewConnection,
  request: RouteSearchRequest | undefined,
): LayoutConnectionChange {
  const entitiesById = layoutManager.getEntitiesMapping();
  const fromEntity = connection.from ? entitiesById[connection.from] : undefined;
  const toEntity = connection.to ? entitiesById[connection.to] : undefined;
  return makeRoughFallbackConnectionChange(layoutManager, connection, {
    fromFace: request?.from.face,
    toFace: request?.to.face,
    startPoint: fixedEndpointPoint(fromEntity, request?.from),
    endPoint: fixedEndpointPoint(toEntity, request?.to),
  });
}

function fixedEndpointPoint(
  entity: LayoutEntity | undefined,
  endpoint: RouteEndpoint | undefined,
): Point | undefined {
  if (!entity || !endpoint) {
    return undefined;
  }
  const plane = Math.round(terminalFacePlane(entity, endpoint.face));
  const track = Math.round(
    endpoint.authoredTrack ??
      (endpoint.face === 'left' || endpoint.face === 'right'
        ? entity.y + entity.height / 2
        : entity.x + entity.width / 2),
  );
  const point: Point =
    endpoint.face === 'left' || endpoint.face === 'right' ? [plane, track] : [track, plane];
  return finitePoint(point) ? point : undefined;
}

function storedAbsolutePoint(
  connection: NewConnection,
  relativePoint: Point | undefined,
): Point | undefined {
  if (!relativePoint || !Number.isFinite(connection.x) || !Number.isFinite(connection.y)) {
    return undefined;
  }
  const point: Point = [connection.x! + relativePoint[0], connection.y! + relativePoint[1]];
  return finitePoint(point) ? point : undefined;
}

function absolutePointsChange(absolutePoints: readonly Point[]): LayoutConnectionChange {
  const start = absolutePoints[0] ?? ([0, 0] as Point);
  return {
    x: start[0],
    y: start[1],
    points: absolutePoints.map(([x, y]): Point => [x - start[0], y - start[1]]),
  };
}

function finitePoint(point: readonly [number, number]): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function finiteTextPlacement(
  placement: NewConnection['textPlacement'],
): placement is NonNullable<NewConnection['textPlacement']> {
  return (
    placement !== undefined &&
    Number.isFinite(placement.x) &&
    Number.isFinite(placement.y) &&
    Number.isFinite(placement.width) &&
    Number.isFinite(placement.height)
  );
}

function faceSelectionConnections(
  allConnections: readonly NewConnection[],
  selectedIds: ReadonlySet<string>,
  options: CorridorConnectionBatchRoutingOptions,
): FaceSelectionConnectionInput[] {
  return allConnections.map((connection) => {
    const preservePorts = !selectedIds.has(connection.id) || options.preservePorts !== false;
    return {
      ...connection,
      authoredFromFace:
        legacyDirectionToDirection(connection.authoredFromFace) ??
        (preservePorts ? faceFromRelativePort(connection.relativeFromPort) : undefined),
      authoredToFace:
        legacyDirectionToDirection(connection.authoredToFace) ??
        (preservePorts ? faceFromRelativePort(connection.relativeToPort) : undefined),
      ...(preservePorts ? {} : { relativeFromPort: undefined, relativeToPort: undefined }),
    };
  });
}

function faceFromRelativePort(port: RelativePortPosition | undefined): Direction | undefined {
  if (!port) {
    return undefined;
  }
  const [x, y] = port;
  const distances: readonly [Direction, number][] = [
    ['up', y],
    ['down', 1 - y],
    ['left', x],
    ['right', 1 - x],
  ];
  return distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0];
}

function absoluteConnectionPoints(
  connection: LayoutConnection,
): readonly (readonly [number, number])[] {
  return connection.points.map(
    ([x, y]) => [Math.round(connection.x + x), Math.round(connection.y + y)] as const,
  );
}

function fixedFaceRequests(
  layoutManager: LayoutManager,
  connections: FaceSelectionConnectionInput[],
  entitiesById: Readonly<Record<string, LayoutEntity>>,
): RouteSearchRequest[] {
  const faceRequests: FaceSelectionRequest[] = connections.map((connection) => ({
    connId: connection.id,
    from: connection.from,
    to: connection.to,
  }));
  const faces = assignFaces(layoutManager, faceRequests, connections);
  const entityIndexById = new Map(
    layoutManager.getEntities().map((entity, entityIndex) => [entity.id, entityIndex]),
  );

  return connections.map((connection, requestIndex) => {
    const fromEntity = entitiesById[connection.from] as LayoutEntity;
    const toEntity = entitiesById[connection.to] as LayoutEntity;
    const fromEntityIndex = entityIndexById.get(connection.from) as number;
    const toEntityIndex = entityIndexById.get(connection.to) as number;
    return {
      requestIndex,
      from: routeEndpoint(
        fromEntityIndex,
        faces[requestIndex].from,
        fromEntity,
        connection.relativeFromPort,
        connection.fromArrowhead,
      ),
      to: routeEndpoint(
        toEntityIndex,
        faces[requestIndex].to,
        toEntity,
        connection.relativeToPort,
        connection.toArrowhead,
      ),
    };
  });
}

function routeEndpoint(
  entityIndex: number,
  face: Direction,
  entity: LayoutEntity,
  relativePort: LayoutConnection['relativeFromPort'],
  hasArrowhead: boolean | undefined,
): RouteEndpoint {
  // Routing works on a whole-pixel grid; authored ports snap at request intake.
  const authoredTrack = getRelativePortCoord(entity, relativePort, face);
  return {
    entityIndex,
    face,
    ...(hasArrowhead === undefined ? {} : { hasArrowhead }),
    ...(authoredTrack === undefined ? {} : { authoredTrack: Math.round(authoredTrack) }),
  };
}

function measuredLabelSpecs(
  connections: readonly NewConnection[],
  selectedIds: ReadonlySet<string>,
): LabelSpec[] {
  return connections.flatMap((connection, routeIndex): LabelSpec[] => {
    if (!selectedIds.has(connection.id)) {
      return [];
    }
    const placement = connection.textPlacement;
    if (
      !placement ||
      !Number.isFinite(placement.width) ||
      !Number.isFinite(placement.height) ||
      placement.width <= 0 ||
      placement.height <= 0
    ) {
      return [];
    }
    return [
      {
        routeIndex,
        size: { width: placement.width, height: placement.height },
      },
    ];
  });
}

function connectionChange(
  points: readonly XYPoint[],
  label: RealizedLabelPlacement | undefined,
  request: RouteSearchRequest,
  fromEntity: LayoutEntity,
  toEntity: LayoutEntity,
): LayoutConnectionChange {
  const normalizedPoints = simplifyCollinearPoints(points.map(({ x, y }): Point => [x, y]));
  const first = normalizedPoints[0];
  const last = normalizedPoints.at(-1);
  if (!first || !last) {
    throw new Error(`Routing corridor emitted an incomplete route ${request.requestIndex}`);
  }
  const fromPoint: Point = [first[0], first[1]];
  const toPoint: Point = [last[0], last[1]];
  return {
    x: first[0],
    y: first[1],
    points: normalizedPoints.map(([x, y]) => [x - first[0], y - first[1]] as Point),
    relativeFromPort: getRelativePort(fromEntity, fromPoint, request.from.face),
    relativeToPort: getRelativePort(toEntity, toPoint, request.to.face),
    ...(label ? { textPlacement: { ...label.rect } } : {}),
  };
}
