import {
  ARC_BEND_SNAP_THRESHOLD,
  LayoutConnectionTextPlacementSource,
  LayoutManager,
  defaultBendForChord,
  getArcPathD,
  getArcPolyline,
  isArcBend,
  routeConnections,
  type ConnectorStyle,
  type Direction,
  type LayoutConnection,
  type LayoutEntity,
  type OutlineDescriptor,
  type OutlineVertex,
  type RepairPolicy,
} from '@eraserlabs/layout';
import type { ResolvedConnection, ResolvedEntity } from '@eraserlabs/protocol';
import type { Box, ConnectionGeometry, SceneLayout } from '@eraserlabs/render';
import { isFiniteNumber, isRecord } from '@eraserlabs/utils';
import type { ElementMeasure } from './measure.js';
import { ELBOW_CORNER_RADIUS, toPathData } from './roundedPath.js';

/**
 * The bridge onto `@eraserlabs/layout`'s router. This package adapts to the layout's contracts,
 * never the other way round: measured elements become `LayoutEntity`, connections become
 * `LayoutConnection`, and one `LayoutManager` per request carries every connection into one
 * `routeConnections` call. Layout makes every routing decision (which authored path to keep, how
 * straight and arc lines attach, where labels go); this module only converts and draws.
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
 * The default repair budget. The router budgets repair by wall clock, which would make identical
 * input produce different routes under load. An infinite budget takes every deadline branch out of
 * play, so repair always runs to completion and routing stays a pure function of its input. A
 * caller that needs speed over repeatability passes its own budget.
 */
const REPAIR_TIME_BUDGET_MS = Number.POSITIVE_INFINITY;

const FACE_BY_PORT: Record<string, Direction> = {
  top: 'up',
  bottom: 'down',
  left: 'left',
  right: 'right',
};

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
  repair: RepairPolicy = { timeBudgetMs: REPAIR_TIME_BUDGET_MS },
): SceneLayout {
  const entities = toEntities(sceneEntities, resolvedBoxes, externalText);
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const connections = toConnections(sceneConnections, entitiesById, externalText);
  const manager = new LayoutManager({ entities, connections });

  if (connections.length > 0) {
    routeConnections({
      layoutManager: manager,
      repair,
      connectionsToRoute: connections,
    });
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
 * Every connection with both endpoints resolved, in layout terms: its style and arc bend, its
 * authored geometry (scene coordinates) when it has at least two points, and its label. A stored
 * label placement is passed as is, with `textLineOffset` when the label was placed by hand; a
 * measured label with no stored placement passes only its size, and layout places it. A connection
 * whose endpoint resolves to nothing is left out (resolve rejects those upstream).
 */
function toConnections(
  sceneConnections: ResolvedConnection[],
  entitiesById: Map<string, LayoutEntity>,
  externalText: Map<string, Box[]>,
): LayoutConnection[] {
  const connections: LayoutConnection[] = [];

  for (const element of sceneConnections) {
    const { from, to } = element.props;

    if (!entitiesById.has(from) || !entitiesById.has(to)) {
      continue;
    }

    // App vocabulary: authored points are element-origin-relative; layout works in scene
    // coordinates.
    const authored = element.props['points'];
    const points = isAuthoredPointList(authored)
      ? authored.map(({ x, y }): Point => [(element.x ?? 0) + x, (element.y ?? 0) + y])
      : [];
    const [originX, originY] = points[0] ?? [0, 0];
    // A measured `external-text` role is the template-independent contract that this connection
    // paints a label. Templates are free to source that paint from any prop shape or name.
    const measured = externalText.get(element.id)?.[0];
    const stored = externalText.has(element.id)
      ? storedLabelPlacement(element, measured)
      : undefined;
    const label = stored
      ? { textPlacement: stored, textPlacementSource: LayoutConnectionTextPlacementSource.STORED }
      : labelSize(measured);
    const lineOffset = manualLineOffset(element);
    const bend = element.props['bend'];

    connections.push({
      id: element.id,
      from,
      to,
      ...faceHints(element),
      connectorStyle: connectorStyleOf(element),
      ...(isFiniteNumber(bend) ? { bend } : {}),
      x: originX,
      y: originY,
      points: points.map(([px, py]): Point => [px - originX, py - originY]),
      ...label,
      ...(stored && lineOffset !== undefined ? { textLineOffset: lineOffset } : {}),
    });
  }

  return connections;
}

/** `straight` and `arc` are exact opt-ins; an absent or unknown value is an elbow line. */
function connectorStyleOf(element: ResolvedConnection): ConnectorStyle {
  const style = element.props['connectorStyle'];
  return style === 'straight' || style === 'arc' ? style : 'elbow';
}

/** An own, finite `labelPlacement.lineOffset` marks a label placed by hand, zero included. */
function manualLineOffset(element: ResolvedConnection): number | undefined {
  const stored = element.props['labelPlacement'];
  if (
    !isRecord(stored) ||
    !Object.prototype.hasOwnProperty.call(stored, 'lineOffset') ||
    !isFiniteNumber(stored['lineOffset'])
  ) {
    return undefined;
  }
  return stored['lineOffset'];
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

  // An unplaced label: its size only, at NaN, for layout to place.
  return {
    textPlacement: { x: Number.NaN, y: Number.NaN, width: box.width, height: box.height },
    textPlacementSource: LayoutConnectionTextPlacementSource.MEASURE,
  };
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

    const arc = arcOf(connection, points);
    const drawn = arc ? getArcPolyline(arc.start, arc.end, arc.bend) : points;
    polylines.push(drawn);
    // A label layout left unplaced (a kept path whose label had only a size) falls back to the
    // path midpoint, with no authoritative box.
    const placed = isPlaced(connection.textPlacement) ? connection.textPlacement : undefined;
    connections[connection.id] = {
      d: arc
        ? getArcPathD(arc.start, arc.end, arc.bend)
        : toPathData(points, radii.get(connection.id) ?? 0),
      points: drawn,
      label: placed
        ? { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 }
        : midpoint(points),
      ...(placed ? { labelBox: { ...placed } } : {}),
    };
  }

  return { boxes, connections, scene: sceneBox(boxes, connections, polylines) };
}

/**
 * An arc connection drawn as a curve: its two ends and its bend (its own, else the default bow for
 * the chord). Undefined for any other connection, and for an arc whose bend is under the snap
 * threshold, which draws as a straight segment.
 */
function arcOf(
  connection: LayoutConnection,
  points: Point[],
): { start: Point; end: Point; bend: number } | undefined {
  if (connection.connectorStyle !== 'arc') {
    return undefined;
  }
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const bend = isArcBend(connection.bend) ? connection.bend : defaultBendForChord(start, end);
  return Math.abs(bend) >= ARC_BEND_SNAP_THRESHOLD ? { start, end, bend } : undefined;
}

function isPlaced(
  box: LayoutConnection['textPlacement'],
): box is NonNullable<LayoutConnection['textPlacement']> {
  return box !== undefined && [box.x, box.y, box.width, box.height].every(Number.isFinite);
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
