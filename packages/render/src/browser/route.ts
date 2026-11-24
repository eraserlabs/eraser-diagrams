import {
  ARC_BEND_SNAP_THRESHOLD,
  LayoutConnectionTextPlacementSource,
  LayoutManager,
  defaultBendForChord,
  getArcPathD,
  getArcPolyline,
  isArcBend,
  routeConnections,
  type ConnectionRoutingRequest,
  type ConnectorStyle,
  type Direction,
  type EndpointPins,
  type LayoutConnection,
  type LayoutEntity,
  type OutlineDescriptor,
  type OutlineVertex,
  type RepairPolicy,
} from '@eraserlabs/layout';
import { isFiniteBox } from '@eraserlabs/layout/layoutGeometry';
import type { ResolvedConnection, ResolvedEntity } from '@eraserlabs/protocol';
import type { Box, ConnectionGeometry, SceneLayout } from '@eraserlabs/render';
import { isFiniteNumber, isRecord } from '@eraserlabs/utils';
import type { ElementMeasure, MeasuredPort } from './measure.js';
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

/** Measured boxes for a connection's optional start/end labels (`data-part="start-label" | "end-label"`). */
export interface EndpointLabelSizes {
  start?: Box;
  end?: Box;
}

/**
 * Measured `external-text` boxes per element, wrapper-relative. A connection's is its midpoint
 * label; a node's is text painted outside its body, like an icon caption — the router keeps
 * routes clear of both, but only if it is told they exist. Endpoint labels (`start-label` /
 * `end-label`) are excluded here and placed separately near path terminals.
 */
export function externalTextOf(measures: ElementMeasure[]): Map<string, Box[]> {
  const boxes = new Map<string, Box[]>();

  for (const measure of measures) {
    if (measure.parts['start-label'] || measure.parts['end-label']) {
      const midpoint = measure.parts['label'];

      if (midpoint && midpoint.length > 0) {
        boxes.set(measure.id, midpoint);
      }

      continue;
    }

    const text = measure.roles['external-text'];

    if (text && text.length > 0) {
      boxes.set(measure.id, text);
    }
  }

  return boxes;
}

/** Measured `start-label` / `end-label` boxes per connection, wrapper-relative. */
export function endpointLabelsOf(measures: ElementMeasure[]): Map<string, EndpointLabelSizes> {
  const map = new Map<string, EndpointLabelSizes>();

  for (const measure of measures) {
    const start = measure.parts['start-label']?.[0];
    const end = measure.parts['end-label']?.[0];

    if (start || end) {
      map.set(measure.id, { ...(start ? { start } : {}), ...(end ? { end } : {}) });
    }
  }

  return map;
}

/**
 * Measured `[data-port]` / `[data-port-prefix]` bands per entity, wrapper-relative. Entities that
 * declare ports pin connection ends to their left/right walls (e.g. DatabaseTable rows).
 */
export function portsOf(measures: ElementMeasure[]): Map<string, readonly MeasuredPort[]> {
  const ports = new Map<string, readonly MeasuredPort[]>();

  for (const measure of measures) {
    if (measure.ports.length > 0) {
      ports.set(measure.id, measure.ports);
    }
  }

  return ports;
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
  entityPorts: Map<string, readonly MeasuredPort[]> = new Map(),
  endpointLabels: Map<string, EndpointLabelSizes> = new Map(),
): SceneLayout {
  const entities = toEntities(sceneEntities, resolvedBoxes, externalText, entityPorts);
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const connections = toConnections(sceneConnections, entitiesById, externalText);
  const manager = new LayoutManager({ entities, connections });

  if (connections.length > 0) {
    routeConnections({
      layoutManager: manager,
      repair,
      connectionsToRoute: connections.map((connection) =>
        authoredPortRequest(connection, entitiesById),
      ),
    });
  }

  return toSceneLayout(
    manager,
    entities,
    cornerRadii(sceneConnections),
    sceneConnections,
    endpointLabels,
  );
}

const PERIMETER_TOLERANCE_PX = 1;

/**
 * An authored route with no named `fromPortId`/`toPortId` keeps its authored terminal points on
 * port-declaring entities (e.g. a saved table-level attachment) instead of snapping to the header.
 * Connections without authored points, with named ports, or whose authored ends miss the entity's
 * perimeter fall through to `resolvePortPins`.
 */
function authoredPortRequest(
  connection: LayoutConnection,
  entitiesById: Map<string, LayoutEntity>,
): ConnectionRoutingRequest {
  if (connection.points.length < 2 || connection.fromPortId || connection.toPortId) {
    return { connection };
  }
  const from = entitiesById.get(connection.from);
  const to = entitiesById.get(connection.to);
  if (!from?.ports?.length && !to?.ports?.length) {
    return { connection };
  }
  const first = connection.points[0]!;
  const last = connection.points[connection.points.length - 1]!;
  const start: Point = [connection.x + first[0], connection.y + first[1]];
  const end: Point = [connection.x + last[0], connection.y + last[1]];
  const endpointPins: EndpointPins = {};

  if (from?.ports?.length) {
    if (!isOnPerimeter(from, start)) {
      return { connection };
    }
    endpointPins.from = start;
  }
  if (to?.ports?.length) {
    if (!isOnPerimeter(to, end)) {
      return { connection };
    }
    endpointPins.to = end;
  }

  return { connection, endpointPins };
}

function isOnPerimeter(entity: LayoutEntity, [px, py]: Point): boolean {
  const withinX =
    px >= entity.x - PERIMETER_TOLERANCE_PX &&
    px <= entity.x + entity.width + PERIMETER_TOLERANCE_PX;
  const withinY =
    py >= entity.y - PERIMETER_TOLERANCE_PX &&
    py <= entity.y + entity.height + PERIMETER_TOLERANCE_PX;
  const onVerticalWall =
    withinY &&
    (Math.abs(px - entity.x) <= PERIMETER_TOLERANCE_PX ||
      Math.abs(px - (entity.x + entity.width)) <= PERIMETER_TOLERANCE_PX);
  const onHorizontalWall =
    withinX &&
    (Math.abs(py - entity.y) <= PERIMETER_TOLERANCE_PX ||
      Math.abs(py - (entity.y + entity.height)) <= PERIMETER_TOLERANCE_PX);
  return onVerticalWall || onHorizontalWall;
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
  entityPorts: Map<string, readonly MeasuredPort[]>,
): LayoutEntity[] {
  const nestedIds = new Set(sceneEntities.map((element) => element.containerId));

  return sceneEntities.map((element): LayoutEntity => {
    const resolved = resolvedBoxes.get(element.id);
    const text = textPlacement(externalText.get(element.id));
    const outline = outlineOf(element);
    const ports = entityPorts.get(element.id);

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
      ...(ports && ports.length > 0
        ? {
            ports: ports.map((port) => ({
              id: port.id,
              y: Math.round(port.y),
              height: Math.max(1, Math.round(port.height)),
              allowCrossover: true,
            })),
          }
        : {}),
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
    const fromField = decodePlainField(element.props['fromField']);
    const toField = decodePlainField(element.props['toField']);

    connections.push({
      id: element.id,
      from,
      to,
      ...faceHints(element),
      ...(fromField !== undefined ? { fromPortId: `field:${fromField}` } : {}),
      ...(toField !== undefined ? { toPortId: `field:${toField}` } : {}),
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

/** `fromField`/`toField` are `x-content: plain` (HTML-escaped at resolve); decode to match DOM `.textContent`. */
function decodePlainField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
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
  sceneConnections: ResolvedConnection[],
  endpointLabels: Map<string, EndpointLabelSizes>,
): SceneLayout {
  const boxes: Record<string, Box> = {};

  for (const { id, x, y, width, height } of entities) {
    boxes[id] = { x, y, width, height };
  }

  const elementById = new Map(sceneConnections.map((element) => [element.id, element]));
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
    const placed = isFiniteBox(connection.textPlacement) ? connection.textPlacement : undefined;
    const props: Record<string, unknown> = elementById.get(connection.id)?.props ?? {};
    const cornerRadius = radii.get(connection.id) ?? 0;
    const isDouble = props['lineStyle'] === 'double';
    const doubleRailsD = isDouble
      ? doubleRailsPath(arc ? drawn : points, arc ? 0 : cornerRadius, lineWidthPxOf(props))
      : undefined;
    const ends = endpointLabels.get(connection.id);
    const startLabelBox = ends?.start
      ? placeEndpointLabel(drawn, 'start', ends.start, hasVisibleMarker(props, 'start'), isDouble)
      : undefined;
    const endLabelBox = ends?.end
      ? placeEndpointLabel(drawn, 'end', ends.end, hasVisibleMarker(props, 'end'), isDouble)
      : undefined;

    connections[connection.id] = {
      d: arc ? getArcPathD(arc.start, arc.end, arc.bend) : toPathData(points, cornerRadius),
      ...(doubleRailsD ? { doubleRailsD } : {}),
      points: drawn,
      label: placed
        ? { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 }
        : midpoint(points),
      ...(placed ? { labelBox: { ...placed } } : {}),
      ...(startLabelBox ? { startLabelBox } : {}),
      ...(endLabelBox ? { endLabelBox } : {}),
    };
  }

  return { boxes, connections, scene: sceneBox(boxes, connections, polylines) };
}

function hasVisibleMarker(props: Record<string, unknown>, end: 'start' | 'end'): boolean {
  const marker = props[`${end}Marker`];

  if (typeof marker === 'string') {
    return marker !== '' && marker !== 'none';
  }

  const head = props[`${end}Arrowhead`];

  return typeof head === 'string' && head !== '';
}

function lineWidthPxOf(props: Record<string, unknown>): number {
  const value = props['lineWidthPx'];

  return isFiniteNumber(value) && value > 0 ? value : 1.3;
}

/**
 * Place a connection endpoint label (`startLabel` / `endLabel`) beside the path near its terminal,
 * past any arrowhead marker and shifted off the stroke along the upper (or rightward for vertical
 * segments) perpendicular normal so it never overlaps the node edge, arrowhead, or line.
 */
function placeEndpointLabel(
  points: readonly Point[],
  side: 'start' | 'end',
  box: Box,
  hasMarker: boolean,
  isDoubleLine: boolean,
): Box | undefined {
  if (
    points.length < 2 ||
    positiveDimension(box.width) === undefined ||
    positiveDimension(box.height) === undefined
  ) {
    return undefined;
  }

  const totalLen = polylineLength(points);
  const inset = hasMarker ? 20 : 10;
  const atEnd = sampleFromEndpoint(points, side, 0);
  const halfAlong = (Math.abs(atEnd.tx) * box.width + Math.abs(atEnd.ty) * box.height) / 2;
  const along = Math.min(inset + halfAlong, Math.max(inset * 0.5, totalLen * 0.42));
  const anchor = sampleFromEndpoint(points, side, along);

  // Perpendicular normal: prefer upward (ny < 0); for vertical segments (ny === 0), prefer right.
  let nx = -anchor.ty;
  let ny = anchor.tx;

  if (ny > 1e-6 || (Math.abs(ny) <= 1e-6 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }

  const gap = isDoubleLine ? 7 : 5;
  const perp = (Math.abs(nx) * box.width + Math.abs(ny) * box.height) / 2 + gap;
  const cx = anchor.x + nx * perp;
  const cy = anchor.y + ny * perp;

  return {
    x: cx - box.width / 2,
    y: cy - box.height / 2,
    width: box.width,
    height: box.height,
  };
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;

  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    total += Math.hypot(bx - ax, by - ay);
  }

  return total;
}

function sampleFromEndpoint(
  points: readonly Point[],
  side: 'start' | 'end',
  distance: number,
): { x: number; y: number; tx: number; ty: number } {
  const ordered = side === 'start' ? points : [...points].reverse();
  let remaining = distance;

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const [ax, ay] = ordered[i]!;
    const [bx, by] = ordered[i + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);

    if (len < 1e-6) {
      continue;
    }

    const tx = dx / len;
    const ty = dy / len;

    if (remaining <= len || i === ordered.length - 2) {
      const clamped = Math.min(remaining, len);

      return { x: ax + tx * clamped, y: ay + ty * clamped, tx, ty };
    }

    remaining -= len;
  }

  const [x, y] = ordered[0]!;

  return { x, y, tx: 1, ty: 0 };
}

/**
 * Two parallel rails offset ±halfGap perpendicular to the route (Chen total participation). Keeps
 * a transparent center gap over any background and matches elbow corner rounding.
 */
function doubleRailsPath(
  rawPoints: readonly Point[],
  cornerRadius: number,
  lineWidthPx: number,
): string | undefined {
  const pts = dedupePoints(rawPoints);

  if (pts.length < 2) {
    return undefined;
  }

  const offset = Math.max(2.2, lineWidthPx * 1.15);
  const left = offsetPolyline(pts, offset);
  const right = offsetPolyline(pts, -offset);

  return `${toPathData(left, cornerRadius)} ${toPathData(right, cornerRadius)}`;
}

function dedupePoints(points: readonly Point[]): Point[] {
  const out: Point[] = [];

  for (const pt of points) {
    const prev = out[out.length - 1];

    if (!prev || Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 1e-4) {
      out.push([pt[0], pt[1]]);
    }
  }

  return out;
}

function offsetPolyline(points: readonly Point[], signedOffset: number): Point[] {
  const segCount = points.length - 1;
  const tangents: Point[] = [];
  const normals: Point[] = [];

  for (let i = 0; i < segCount; i += 1) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[i + 1]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const tx = (bx - ax) / len;
    const ty = (by - ay) / len;
    tangents.push([tx, ty]);
    normals.push([-ty, tx]);
  }

  const out: Point[] = [];
  const [n0x, n0y] = normals[0]!;
  out.push([points[0]![0] + signedOffset * n0x, points[0]![1] + signedOffset * n0y]);

  const miterLimit = Math.abs(signedOffset) * 3;

  for (let i = 1; i < segCount; i += 1) {
    const [px, py] = points[i]!;
    const [t1x, t1y] = tangents[i - 1]!;
    const [t2x, t2y] = tangents[i]!;
    const [n1x, n1y] = normals[i - 1]!;
    const [n2x, n2y] = normals[i]!;
    const a1x = px + signedOffset * n1x;
    const a1y = py + signedOffset * n1y;
    const a2x = px + signedOffset * n2x;
    const a2y = py + signedOffset * n2y;
    const cross = t1x * t2y - t1y * t2x;

    if (Math.abs(cross) < 1e-4) {
      out.push([a2x, a2y]);
      continue;
    }

    const s = ((a2x - a1x) * t2y - (a2y - a1y) * t2x) / cross;

    if (Math.abs(s) > miterLimit) {
      out.push([a1x, a1y], [a2x, a2y]);
    } else {
      out.push([a1x + s * t1x, a1y + s * t1y]);
    }
  }

  const [nLastX, nLastY] = normals[segCount - 1]!;
  const [ex, ey] = points[segCount]!;
  out.push([ex + signedOffset * nLastX, ey + signedOffset * nLastY]);

  return out;
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

  for (const { labelBox, startLabelBox, endLabelBox } of Object.values(connections)) {
    for (const box of [labelBox, startLabelBox, endLabelBox]) {
      if (box) {
        corners.push([box.x, box.y], [box.x + box.width, box.y + box.height]);
      }
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
