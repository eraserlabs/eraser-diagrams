import {
  LayoutManager,
  anchorFromStored,
  resolveManualLabel,
  routeCorridorConnectionBatch,
  straightConnectionEndpoints,
  type Direction,
  type LayoutConnection,
  type LayoutEntity,
  type OutlineDescriptor,
  type OutlineVertex,
} from '@eraserlabs/layout';
import type { ResolvedConnection, ResolvedEntity } from '@eraserlabs/protocol';
import type { Box, ConnectionGeometry, SceneLayout } from '@eraserlabs/render';
import { isFiniteNumber, isRecord } from '@eraserlabs/utils';
import type { ElementMeasure } from './measure.js';
import { ELBOW_CORNER_RADIUS, toPathData } from './roundedPath.js';

/**
 * The bridge onto `@eraserlabs/layout`'s corridor router. This package adapts to the router's
 * contracts, never the other way round: measured elements become `LayoutEntity`, connections become
 * `LayoutConnection`, and one `LayoutManager` per request carries the batch. The router commits its
 * geometry back onto that manager — nothing is returned but per-connection status.
 *
 * The dialect conventions the router keys off live here too (SPEC, "Elements"): `from`/`to` mark a
 * connection, `fromPort`/`toPort` hint its endpoint faces, `external-text` measures its label.
 */

/** Mirrors the router's own point tuple (`routing/types.ts`), which is mutable. */
type Point = [number, number];

/** Authored connection geometry is deliberately independent of the router's tuple vocabulary. */
interface AuthoredPoint {
  x: number;
  y: number;
}

const SCENE_PADDING = 16;

/**
 * The router budgets repair by wall clock, which would make identical input produce different
 * routes under load. An infinite budget is an accepted value there and takes every deadline branch
 * out of play, so repair always runs to completion and routing stays a pure function of its input.
 */
const REPAIR_TIME_BUDGET_MS = Number.POSITIVE_INFINITY;

const FACE_BY_PORT: Record<string, Direction> = {
  top: 'up',
  bottom: 'down',
  left: 'left',
  right: 'right',
};

interface ManualLabelSnapshot {
  oldRoute: Point[];
  oldCenter: Point;
  lineOffset: number;
  width: number;
  height: number;
}

/**
 * Measured `external-text` boxes per element, wrapper-relative. A connection's is its label; a
 * node's is text painted outside its body, like an icon caption — the router keeps routes clear of
 * both, but only if it is told they exist.
 */
export function externalTextOf(measures: ElementMeasure[]): Map<string, Box[]> {
  const boxes = new Map<string, Box[]>();

  for (const measure of measures) {
    const text = measure.roles['external-text'];

    if (text && text.length > 0) {
      boxes.set(measure.id, text);
    }
  }

  return boxes;
}

/**
 * Route the scene: resolved wrapper boxes in, drawable geometry out. Callers that do not have a
 * resolved box may omit it and fall back to the element's authored dimensions. The caller has
 * already split the scene by registry kind (`classify.ts`); this stage never re-checks it.
 */
export function routeScene(
  sceneEntities: ResolvedEntity[],
  sceneConnections: ResolvedConnection[],
  resolvedBoxes: Map<string, Box>,
  externalText: Map<string, Box[]>,
): SceneLayout {
  const entities = toEntities(sceneEntities, resolvedBoxes, externalText);
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const { pinned, routed, straight, manualLabels } = toConnections(
    sceneConnections,
    entitiesById,
    externalText,
  );
  const manager = new LayoutManager({ entities, connections: [...pinned, ...routed] });

  if (routed.length > 0) {
    routeCorridorConnectionBatch({
      layoutManager: manager,
      // Label sizes ride on these copies alone: the router plans labels for what it routes, and
      // adopted routes keep the geometry they arrived with.
      connectionsToRoute: routed.map((connection) => ({
        ...connection,
        ...labelSize(externalText.get(connection.id)?.[0]),
      })),
      options: {
        repair: true,
        labels: true,
        pinUnaffectedRoutes: true,
        repairTimeBudgetMs: REPAIR_TIME_BUDGET_MS,
      },
    });
    restoreManualLabels(manager, manualLabels);
  }

  // Straight connections join the manager only after the batch has routed: the router adopts every
  // incumbent's geometry into its orthogonal corridor world, and one diagonal segment would drop
  // the entire batch to fallback routing.
  for (const connection of straight) {
    manager.addConnection(connection);
  }

  return toSceneLayout(manager, entities, cornerRadii(sceneConnections));
}

/**
 * Corner rounding is paint only, so it rides beside the route instead of through the router: the
 * polyline the router committed stays the geometry every other stage measures. `'elbow'` is the
 * one opt-in; an absent or unknown value keeps the square corners.
 */
function cornerRadii(connections: ResolvedConnection[]): Map<string, number> {
  const radii = new Map<string, number>();

  for (const element of connections) {
    if (element.props['cornerStyle'] === 'elbow') {
      radii.set(element.id, ELBOW_CORNER_RADIUS);
    }
  }

  return radii;
}

/**
 * Containment is a routing input, not just paint order: the router treats container interiors as
 * traversable and leaves as obstacles. Boxes snap to the integer grid here and nowhere else — the
 * router works on integers while DOM measurement is subpixel, and these snapped boxes are what
 * apply paints, so geometry can never land a fraction off the box it terminates on.
 */
function toEntities(
  sceneEntities: ResolvedEntity[],
  resolvedBoxes: Map<string, Box>,
  externalText: Map<string, Box[]>,
): LayoutEntity[] {
  const nestedIds = new Set(sceneEntities.map((element) => element.containerId));

  return sceneEntities.map((element): LayoutEntity => {
    const resolved = resolvedBoxes.get(element.id);
    const text = textPlacement(externalText.get(element.id));
    const outline = outlineOf(element);

    return {
      id: element.id,
      x: Math.round(element.x ?? 0),
      y: Math.round(element.y ?? 0),
      // A zero-size entity divides by zero in the router's relative-port arithmetic.
      width: Math.max(1, Math.ceil(resolved?.width ?? element.width ?? 0)),
      height: Math.max(1, Math.ceil(resolved?.height ?? element.height ?? 0)),
      ...(element.containerId !== undefined ? { containerId: element.containerId } : {}),
      ...(element.isContainer === true || nestedIds.has(element.id) ? { isContainer: true } : {}),
      ...(text ? { textPlacement: text } : {}),
      ...(outline ? { outline } : {}),
    };
  });
}

/**
 * Dialect convention: a node's `outline` prop is its true drawn boundary in the normalized 0–100
 * frame (see `OutlineDescriptor`), so terminal endpoints can attach to a hexagon's slope or an
 * ellipse's curve instead of the bounding box. Emitted by the library's normalizers; anything
 * malformed degrades to box attachment rather than failing the route.
 */
function outlineOf(element: ResolvedEntity): OutlineDescriptor | undefined {
  const record = element.props['outline'];

  if (!isRecord(record)) {
    return undefined;
  }

  if (record['kind'] === 'ellipse') {
    return { kind: 'ellipse' };
  }

  if (record['kind'] !== 'polygon') {
    return undefined;
  }

  const vertices = outlineVertices(record['vertices']);

  if (!vertices) {
    return undefined;
  }

  const cornerRadius = record['cornerRadius'];
  const cornerRadiusPercent = record['cornerRadiusPercent'];

  return {
    kind: 'polygon',
    vertices,
    ...(typeof cornerRadius === 'number' && Number.isFinite(cornerRadius) ? { cornerRadius } : {}),
    ...(typeof cornerRadiusPercent === 'number' && Number.isFinite(cornerRadiusPercent)
      ? { cornerRadiusPercent }
      : {}),
  };
}

function outlineVertices(value: unknown): OutlineVertex[] | undefined {
  if (!Array.isArray(value) || value.length < 3) {
    return undefined;
  }

  const vertices: OutlineVertex[] = [];

  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !isFiniteNumber(entry[0]) ||
      !isFiniteNumber(entry[1])
    ) {
      return undefined;
    }

    vertices.push([entry[0], entry[1]]);
  }

  return vertices;
}

/**
 * Text a node paints outside its body — an icon caption, a divider label — as the router's own
 * relative placement. Handed over whatever it measures: the router blocks it only when it lands
 * outside the body (`isExternalTextPlacement`), and a face port steps past it only on the side it
 * actually sits. Rounded outward so the blocked rect is never smaller than the paint.
 */
function textPlacement(boxes: Box[] | undefined): LayoutEntity['textPlacement'] {
  if (!boxes || boxes.length === 0) {
    return undefined;
  }

  const left = Math.floor(Math.min(...boxes.map((box) => box.x)));
  const top = Math.floor(Math.min(...boxes.map((box) => box.y)));
  const right = Math.ceil(Math.max(...boxes.map((box) => box.x + box.width)));
  const bottom = Math.ceil(Math.max(...boxes.map((box) => box.y + box.height)));

  return { relativeX: left, relativeY: top, width: right - left, height: bottom - top };
}

/**
 * Split connections into three buckets. `straight` connections opt out of corridor routing
 * entirely (`connectorStyle: 'straight'`) and are held out of the manager until the batch has
 * routed. The rest split by whether the router can adopt their authored geometry. It adopts an unrouted
 * connection at its exact incumbent points but rejects geometry that is diagonal or cuts an entity
 * — and one rejection drops the entire batch to direct fallback, so anything it would refuse is
 * screened out here and routed fresh instead. A connection with an endpoint that resolves to
 * nothing collapses the batch the same way (resolve rejects those upstream; a library that permits
 * them still must not degrade every other route).
 */
function toConnections(
  sceneConnections: ResolvedConnection[],
  entitiesById: Map<string, LayoutEntity>,
  externalText: Map<string, Box[]>,
): {
  pinned: LayoutConnection[];
  routed: LayoutConnection[];
  straight: LayoutConnection[];
  manualLabels: Map<string, ManualLabelSnapshot>;
} {
  const pinned: LayoutConnection[] = [];
  const routed: LayoutConnection[] = [];
  const straight: LayoutConnection[] = [];
  const manualLabels = new Map<string, ManualLabelSnapshot>();

  for (const element of sceneConnections) {
    const { from, to } = element.props;

    if (!entitiesById.has(from) || !entitiesById.has(to)) {
      continue;
    }

    const base = { id: element.id, from, to, ...faceHints(element) };
    // App vocabulary: authored points are element-origin-relative; the router works in scene
    // coordinates.
    const authored = element.props['points'];
    const points = isAuthoredPointList(authored)
      ? authored.map(({ x, y }): Point => [(element.x ?? 0) + x, (element.y ?? 0) + y])
      : [];

    if (element.props['connectorStyle'] === 'straight') {
      straight.push(straightConnection(element, base, points, entitiesById, externalText));
      continue;
    }

    if (!isAdoptable(points, entitiesById, from, to)) {
      routed.push({ ...base, x: 0, y: 0, points: [] });
      const manualLabel = externalText.has(element.id)
        ? manualLabelSnapshot(element, points, externalText.get(element.id)?.[0])
        : undefined;
      if (manualLabel) {
        manualLabels.set(element.id, manualLabel);
      }
      continue;
    }

    const [originX, originY] = points[0]!;
    // A measured `external-text` role is the template-independent contract that this connection
    // paints a label. Templates are free to source that paint from any prop shape or name.
    const textPlacement = externalText.has(element.id)
      ? storedLabelPlacement(element, externalText.get(element.id)?.[0])
      : undefined;
    pinned.push({
      ...base,
      x: originX,
      y: originY,
      points: points.map(([px, py]): Point => [px - originX, py - originY]),
      ...(textPlacement ? { textPlacement } : {}),
    });
  }

  return { pinned, routed, straight, manualLabels };
}

/**
 * A straight connection is one direct segment, never a corridor route. Authored geometry is
 * adopted verbatim — orthogonality and entity cuts are elbow constraints, so any finite polyline
 * qualifies — and a connection without one attaches a fresh sight-line segment to both drawn
 * boundaries. Labels follow the pinned path's rule: a stored placement is authoritative, and
 * absence falls back to the path midpoint downstream.
 */
function straightConnection(
  element: ResolvedConnection,
  base: Pick<LayoutConnection, 'id' | 'from' | 'to' | 'authoredFromFace' | 'authoredToFace'>,
  points: Point[],
  entitiesById: Map<string, LayoutEntity>,
  externalText: Map<string, Box[]>,
): LayoutConnection {
  const absolute =
    points.length >= 2
      ? points
      : straightConnectionEndpoints(entitiesById.get(base.from)!, entitiesById.get(base.to)!, {
          ...(base.authoredFromFace ? { fromFace: base.authoredFromFace } : {}),
          ...(base.authoredToFace ? { toFace: base.authoredToFace } : {}),
        });
  const [originX, originY] = absolute[0]!;
  const textPlacement = externalText.has(element.id)
    ? storedLabelPlacement(element, externalText.get(element.id)?.[0])
    : undefined;

  return {
    ...base,
    x: originX,
    y: originY,
    points: absolute.map(([px, py]): Point => [px - originX, py - originY]),
    ...(textPlacement ? { textPlacement } : {}),
  };
}

/**
 * Capture enough pre-reroute state to reconstruct a manual label's whole-path anchor. An own,
 * finite `lineOffset` is the manual-placement sentinel — including zero. Auto labels intentionally
 * skip this path so stale authored x/y cannot replace the corridor router's fresh placement.
 */
function manualLabelSnapshot(
  element: ResolvedConnection,
  oldRoute: Point[],
  measured: Box | undefined,
): ManualLabelSnapshot | undefined {
  if (oldRoute.length < 2) {
    return undefined;
  }

  const stored = element.props['labelPlacement'];
  if (
    !isRecord(stored) ||
    !Object.prototype.hasOwnProperty.call(stored, 'lineOffset') ||
    !isFiniteNumber(stored['lineOffset'])
  ) {
    return undefined;
  }

  const placement = storedLabelPlacement(element, measured);
  if (!placement) {
    return undefined;
  }

  return {
    oldRoute,
    oldCenter: [placement.x + placement.width / 2, placement.y + placement.height / 2],
    lineOffset: stored['lineOffset'],
    width: placement.width,
    height: placement.height,
  };
}

/** Re-pin manually placed labels to their authored whole-path position after a fresh reroute. */
function restoreManualLabels(
  manager: LayoutManager,
  snapshots: ReadonlyMap<string, ManualLabelSnapshot>,
): void {
  for (const [connectionId, snapshot] of snapshots) {
    const connection = manager.getConnectionById(connectionId);
    if (!connection) {
      continue;
    }

    const newRoute = connection.points.map(([x, y]): Point => [connection.x + x, connection.y + y]);
    const anchor = anchorFromStored(snapshot.oldRoute, snapshot.oldCenter, snapshot.lineOffset);
    const resolved =
      anchor &&
      resolveManualLabel(newRoute, anchor, { width: snapshot.width, height: snapshot.height });
    if (!resolved) {
      continue;
    }

    manager.updateConnection(connectionId, {
      textPlacement: {
        x: resolved.center[0] - snapshot.width / 2,
        y: resolved.center[1] - snapshot.height / 2,
        width: snapshot.width,
        height: snapshot.height,
      },
    });
  }
}

/**
 * Persisted `labelPlacement` is a top-left point in the same element-relative frame as authored
 * connection points. Once that route is adopted, the point is authoritative regardless of
 * whether `lineOffset` is present: that field is the app's manual-placement sentinel and its
 * offset is already reflected in x/y. The caller only invokes this for a rendered `external-text`
 * role, rather than guessing from a stock-template prop name. Current DOM measurements win for the
 * box size so the mask matches the paint; persisted measurements remain a fallback when that role
 * has no usable dimensions. What the stored point actually pins is the label's centre — a measured
 * box of a different size is re-centred on it, so a label that wraps to two lines here straddles
 * the line instead of hanging its extra lines below the authored first one.
 */
function storedLabelPlacement(
  element: ResolvedConnection,
  measured: Box | undefined,
): LayoutConnection['textPlacement'] {
  const stored = element.props['labelPlacement'];

  if (!isRecord(stored) || !isFiniteNumber(stored['x']) || !isFiniteNumber(stored['y'])) {
    return undefined;
  }

  const storedWidth = positiveDimension(stored['width']);
  const storedHeight = positiveDimension(stored['height']);
  const width = positiveDimension(measured?.width) ?? storedWidth;
  const height = positiveDimension(measured?.height) ?? storedHeight;

  if (width === undefined || height === undefined) {
    return undefined;
  }

  return {
    x: (element.x ?? 0) + stored['x'] + ((storedWidth ?? width) - width) / 2,
    y: (element.y ?? 0) + stored['y'] + ((storedHeight ?? height) - height) / 2,
    width,
    height,
  };
}

function faceHints(element: ResolvedConnection): Partial<LayoutConnection> {
  const from = element.props['fromPort'];
  const to = element.props['toPort'];
  const fromFace = typeof from === 'string' ? FACE_BY_PORT[from] : undefined;
  const toFace = typeof to === 'string' ? FACE_BY_PORT[to] : undefined;

  return {
    ...(fromFace ? { authoredFromFace: fromFace } : {}),
    ...(toFace ? { authoredToFace: toFace } : {}),
  };
}

/** A measured label contributes its size; the router decides where the box lands. */
function labelSize(box: Box | undefined): Partial<LayoutConnection> {
  if (
    !box ||
    positiveDimension(box.width) === undefined ||
    positiveDimension(box.height) === undefined
  ) {
    return {};
  }

  return { textPlacement: { x: 0, y: 0, width: box.width, height: box.height } };
}

function positiveDimension(value: unknown): number | undefined {
  return isFiniteNumber(value) && value > 0 ? value : undefined;
}

function isAuthoredPointList(value: unknown): value is AuthoredPoint[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every(
      (point) => isRecord(point) && isFiniteNumber(point['x']) && isFiniteNumber(point['y']),
    )
  );
}

function isAdoptable(
  points: Point[],
  entitiesById: Map<string, LayoutEntity>,
  from: string,
  to: string,
): boolean {
  if (points.length < 2 || !isOrthogonal(points)) {
    return false;
  }

  for (const [id, entity] of entitiesById) {
    // Endpoints are where the route attaches, and container interiors are traversable by design —
    // neither counts as an obstacle.
    const routable = id === from || id === to || entity.isContainer === true;

    if (!routable && cutsEntity(points, entity)) {
      return false;
    }
  }

  return true;
}

function isOrthogonal(points: Point[]): boolean {
  return segments(points).every(([[ax, ay], [bx, by]]) => ax === bx || ay === by);
}

/** Interior crossings only — a segment running along an edge is not a cut. */
function cutsEntity(points: Point[], entity: LayoutEntity): boolean {
  return segments(points).some(
    ([[ax, ay], [bx, by]]) =>
      Math.min(ax, bx) < entity.x + entity.width &&
      Math.max(ax, bx) > entity.x &&
      Math.min(ay, by) < entity.y + entity.height &&
      Math.max(ay, by) > entity.y,
  );
}

function segments(points: Point[]): [Point, Point][] {
  return points.slice(1).map((point, index): [Point, Point] => [points[index]!, point]);
}

/**
 * Read the committed geometry back off the manager. A `textPlacement` is either the stored box on
 * an adopted path, the router's placement on an auto-generated path, or a manual anchor restored
 * after rerouting, so its presence makes the label box authoritative in every case.
 */
function toSceneLayout(
  manager: LayoutManager,
  entities: LayoutEntity[],
  radii: Map<string, number>,
): SceneLayout {
  const boxes: Record<string, Box> = {};

  for (const { id, x, y, width, height } of entities) {
    boxes[id] = { x, y, width, height };
  }

  const connections: Record<string, ConnectionGeometry> = {};
  const polylines: Point[][] = [];

  for (const connection of manager.getConnections()) {
    const points = connection.points.map(([px, py]): Point => [
      connection.x + px,
      connection.y + py,
    ]);

    if (points.length < 2) {
      continue;
    }

    polylines.push(points);
    const placed = connection.textPlacement;
    connections[connection.id] = {
      d: toPathData(points, radii.get(connection.id) ?? 0),
      points,
      label: placed
        ? { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 }
        : midpoint(points),
      ...(placed ? { labelBox: { ...placed } } : {}),
    };
  }

  return { boxes, connections, scene: sceneBox(boxes, connections, polylines) };
}

function midpoint(points: Point[]): { x: number; y: number } {
  const lengths = segments(points).map(([[ax, ay], [bx, by]]) => Math.hypot(bx - ax, by - ay));
  const total = lengths.reduce((sum, length) => sum + length, 0);

  if (total === 0) {
    return { x: points[0]![0], y: points[0]![1] };
  }

  let remaining = total / 2;

  for (const [index, length] of lengths.entries()) {
    if (remaining <= length) {
      const ratio = length === 0 ? 0 : remaining / length;
      const [ax, ay] = points[index]!;
      const [bx, by] = points[index + 1]!;

      return { x: ax + (bx - ax) * ratio, y: ay + (by - ay) * ratio };
    }

    remaining -= length;
  }

  const [x, y] = points[points.length - 1]!;

  return { x, y };
}

function sceneBox(
  boxes: Record<string, Box>,
  connections: Record<string, ConnectionGeometry>,
  polylines: Point[][],
): Box {
  const corners: Point[] = [];

  for (const box of Object.values(boxes)) {
    corners.push([box.x, box.y], [box.x + box.width, box.y + box.height]);
  }

  for (const { labelBox } of Object.values(connections)) {
    if (labelBox) {
      corners.push(
        [labelBox.x, labelBox.y],
        [labelBox.x + labelBox.width, labelBox.y + labelBox.height],
      );
    }
  }

  corners.push(...polylines.flat());

  if (corners.length === 0) {
    return { x: 0, y: 0, width: SCENE_PADDING * 2, height: SCENE_PADDING * 2 };
  }

  // Folded rather than spread into Math.min: a large scene carries more corners than an argument
  // list holds.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of corners) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    x: minX - SCENE_PADDING,
    y: minY - SCENE_PADDING,
    width: maxX - minX + SCENE_PADDING * 2,
    height: maxY - minY + SCENE_PADDING * 2,
  };
}
