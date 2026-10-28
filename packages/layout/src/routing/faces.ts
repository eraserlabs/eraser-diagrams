import { OPPOSITE_DIRECTION } from '../directionUtils.js';
import type { LayoutManager } from '../LayoutManager.js';
import { midpoint } from '../rangeUtils.js';
import type {
  Axis,
  Direction,
  LayoutEntity,
  NewConnection,
  PositionProps,
  XYPoint,
} from '../types.js';
import { facePlane, travelSpanOf } from './corridor/geometry.js';
import { spansOverlap } from './measure/geometry.js';
import { authoredEndpointFace } from './points.js';

export type RouteFaces = { from: Direction; to: Direction };

function positionCenter(entity: PositionProps): XYPoint {
  return {
    x: midpoint(travelSpanOf('x', entity)),
    y: midpoint(travelSpanOf('y', entity)),
  };
}

/** Exit face from a centroid bearing. Ties go to `primaryAxis`; the cross axis wins only when strictly steeper than 45°. */
function bearingFace(dx: number, dy: number, primaryAxis: Axis): Direction {
  if (primaryAxis === 'x') {
    if (Math.abs(dy) > Math.abs(dx)) {
      return dy >= 0 ? 'down' : 'up';
    }
    return dx >= 0 ? 'right' : 'left';
  }
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'down' : 'up';
}

/** Faces for travel along `axis`, exiting `from` toward `to`. */
function facesAlong(axis: Axis, from: LayoutEntity, to: LayoutEntity): RouteFaces {
  const forward = midpoint(travelSpanOf(axis, to)) >= midpoint(travelSpanOf(axis, from));
  if (axis === 'x') {
    return forward ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  }
  return forward ? { from: 'down', to: 'up' } : { from: 'up', to: 'down' };
}

function familyFaceForRequest(
  request: NewConnection,
  requestsBySource: Map<string, NewConnection[]>,
  layoutManager: LayoutManager,
  aspectAxis: Axis,
): Direction | undefined {
  // A fan shares a source and travels coherently, even when its targets are spread apart.
  const members = requestsBySource.get(request.from) ?? [];
  if (members.length < 2) {
    return undefined;
  }
  const source = layoutManager.getEntityById(request.from);
  if (!source) {
    return undefined;
  }
  const sourceCenter = positionCenter(source);
  const deltas: Array<{ dx: number; dy: number }> = [];
  for (const member of members) {
    const target = layoutManager.getEntityById(member.to);
    if (!target) {
      continue;
    }
    const targetCenter = positionCenter(target);
    deltas.push({ dx: targetCenter.x - sourceCenter.x, dy: targetCenter.y - sourceCenter.y });
  }
  if (deltas.length < 2) {
    return undefined;
  }
  const dx = deltas.reduce((sum, d) => sum + d.dx, 0) / deltas.length;
  const dy = deltas.reduce((sum, d) => sum + d.dy, 0) / deltas.length;
  const face = bearingFace(dx, dy, aspectAxis);
  // "Travelling in a direction together": every member must agree in sign on
  // the fan's dominant axis, else the fan is not coherent and per-line rules win.
  const coherent = deltas.every((d) => {
    if (face === 'down') {
      return d.dy > 0;
    }
    if (face === 'up') {
      return d.dy < 0;
    }
    if (face === 'right') {
      return d.dx > 0;
    }
    return d.dx < 0;
  });
  return coherent ? face : undefined;
}

function siblingKey(
  sharedEntityId: string,
  sharedFace: Direction,
  oppositeEntity: LayoutEntity,
  oppositeFace: Direction,
): string {
  return `${sharedEntityId}:${sharedFace}:${facePlane(oppositeEntity, oppositeFace)}`;
}

/** Choose exit/enter faces for each connection whose endpoints both exist; authored faces/ports win per side. Connections are never modified. */
export function assignFaces(
  layoutManager: LayoutManager,
  connections: readonly NewConnection[],
): ReadonlyMap<string, RouteFaces> {
  const faces = new Map<string, RouteFaces>();
  const { minX, maxX, minY, maxY } = layoutManager.getDims();
  const aspectAxis: Axis = maxY - minY > maxX - minX ? 'y' : 'x';
  const requestsBySource = new Map<string, NewConnection[]>();
  for (const request of connections) {
    const list = requestsBySource.get(request.from);
    if (list) {
      list.push(request);
    } else {
      requestsBySource.set(request.from, [request]);
    }
  }

  const establishedSiblingKeys = new Set<string>();
  const undecided: NewConnection[] = [];
  for (const connection of connections) {
    const pinnedFrom = authoredEndpointFace(connection, 'from');
    const pinnedTo = authoredEndpointFace(connection, 'to');
    const from = layoutManager.getEntityById(connection.from);
    const to = layoutManager.getEntityById(connection.to);
    if (!from || !to) {
      continue;
    }

    const xOverlap = spansOverlap(travelSpanOf('x', from), travelSpanOf('x', to));
    const yOverlap = spansOverlap(travelSpanOf('y', from), travelSpanOf('y', to));
    const familyFace =
      !xOverlap && !yOverlap
        ? familyFaceForRequest(connection, requestsBySource, layoutManager, aspectAxis)
        : undefined;
    const inferred =
      xOverlap !== yOverlap
        ? facesAlong(xOverlap ? 'y' : 'x', from, to)
        : familyFace
          ? { from: familyFace, to: OPPOSITE_DIRECTION[familyFace] }
          : undefined;
    const preferred = inferred ?? facesAlong(aspectAxis, from, to);
    const chosen = { from: pinnedFrom ?? preferred.from, to: pinnedTo ?? preferred.to };
    faces.set(connection.id, chosen);
    if (pinnedFrom || inferred) {
      establishedSiblingKeys.add(siblingKey(connection.from, chosen.from, to, chosen.to));
    }
    if (pinnedTo || inferred) {
      establishedSiblingKeys.add(siblingKey(connection.to, chosen.to, from, chosen.from));
    }
    // Only the weak diagram-aspect guess may yield to established siblings.
    if (!pinnedFrom && !pinnedTo && !inferred) {
      undecided.push(connection);
    }
  }

  for (const connection of undecided) {
    const from = layoutManager.getEntityById(connection.from)!;
    const to = layoutManager.getEntityById(connection.to)!;
    if (
      connection.from === connection.to ||
      (from.containerId ?? null) === (to.containerId ?? null)
    ) {
      continue;
    }
    const fromCenter = positionCenter(from);
    const toCenter = positionCenter(to);
    const fromFace = bearingFace(toCenter.x - fromCenter.x, toCenter.y - fromCenter.y, aspectAxis);
    const toFace = OPPOSITE_DIRECTION[fromFace];
    if (
      establishedSiblingKeys.has(siblingKey(connection.from, fromFace, to, toFace)) ||
      establishedSiblingKeys.has(siblingKey(connection.to, toFace, from, fromFace))
    ) {
      faces.set(connection.id, { from: fromFace, to: toFace });
    }
  }
  return faces;
}
