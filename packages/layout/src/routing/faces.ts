import { OPPOSITE_DIRECTION } from '../directionUtils.js';
import type { LayoutManager } from '../LayoutManager.js';
import { midpoint } from '../rangeUtils.js';
import type { Direction, LayoutEntity, PositionProps, XYPoint } from '../types.js';
import { facePlane, travelSpanOf } from './corridor/geometry.js';
import { spansOverlap } from './measure/geometry.js';

export interface FaceSelectionRequest {
  readonly connId: string;
  readonly from: string;
  readonly to: string;
  readonly faces?: {
    readonly from?: Direction;
    readonly to?: Direction;
  };
}

export interface FaceSelectionConnection {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly authoredFromFace?: Direction;
  readonly authoredToFace?: Direction;
}

export type FaceSelectionReason = 'authored' | 'strict-axis' | 'family' | 'sibling' | 'aspect';

/**
 * Face selection's full output: the RouteFaces decision plus selection reasons.
 * Downstream routing consumes only the chosen faces.
 */
export interface AssignedRouteFaces {
  readonly connId: string;
  readonly from: Direction;
  readonly to: Direction;
  reasons: { from: FaceSelectionReason; to: FaceSelectionReason };
}

/** Choose the face aimed most directly toward the opposite entity. */
export function detectExitFace(
  entity: PositionProps,
  opposite: PositionProps,
  isHorizontal: boolean,
  crossAxisThreshold = 1,
): Direction {
  const dx = opposite.x + opposite.width / 2 - (entity.x + entity.width / 2);
  const dy = opposite.y + opposite.height / 2 - (entity.y + entity.height / 2);

  if (isHorizontal) {
    if (Math.abs(dy) > Math.abs(dx) * crossAxisThreshold) {
      return dy >= 0 ? 'down' : 'up';
    }
    return dx >= 0 ? 'right' : 'left';
  }

  if (Math.abs(dx) > Math.abs(dy) * crossAxisThreshold) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'down' : 'up';
}

/** Choose the face through which an entity is entered from the source. */
export function detectEnterFace(
  entity: PositionProps,
  source: PositionProps,
  isHorizontal: boolean,
  crossAxisThreshold = 1,
): Direction {
  return OPPOSITE_DIRECTION[detectExitFace(source, entity, isHorizontal, crossAxisThreshold)];
}

interface FaceRuleResult {
  faces: { from: Direction; to: Direction };
  reason: FaceSelectionReason;
}

function entityCenter(entity: LayoutEntity): XYPoint {
  return {
    x: midpoint(travelSpanOf('x', entity)),
    y: midpoint(travelSpanOf('y', entity)),
  };
}

function verticalFaces(
  from: LayoutEntity,
  to: LayoutEntity,
): {
  from: Direction;
  to: Direction;
} {
  return midpoint(travelSpanOf('y', to)) >= midpoint(travelSpanOf('y', from))
    ? { from: 'down', to: 'up' }
    : { from: 'up', to: 'down' };
}

function horizontalFaces(
  from: LayoutEntity,
  to: LayoutEntity,
): {
  from: Direction;
  to: Direction;
} {
  return midpoint(travelSpanOf('x', to)) >= midpoint(travelSpanOf('x', from))
    ? { from: 'right', to: 'left' }
    : { from: 'left', to: 'right' };
}

function aspectFaces(
  from: LayoutEntity,
  to: LayoutEntity,
  verticalPrimary: boolean,
): { from: Direction; to: Direction } {
  return verticalPrimary ? verticalFaces(from, to) : horizontalFaces(from, to);
}

function dominantDirectionFace(dx: number, dy: number, verticalPrimary: boolean): Direction {
  if (Math.abs(dy) > Math.abs(dx)) {
    return dy >= 0 ? 'down' : 'up';
  }
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return verticalPrimary ? (dy >= 0 ? 'down' : 'up') : dx >= 0 ? 'right' : 'left';
}

/**
 * The spec's face-rule family is "multiple lines LEAVING ONE NODE travelling in a
 * direction together" — computed directly from the request set, NOT from
 * world.families, whose endpoint-similarity signatures split wide fans (members of
 * one fan can land in different similarity families and get mis-faced).
 */
function sourceFanMembers(
  request: FaceSelectionRequest,
  requestsBySource: Map<string, FaceSelectionRequest[]>,
): FaceSelectionRequest[] {
  const members = requestsBySource.get(request.from) ?? [];
  return members.length >= 2 ? members : [];
}

function familyFaceForRequest(
  request: FaceSelectionRequest,
  requestsBySource: Map<string, FaceSelectionRequest[]>,
  layoutManager: LayoutManager,
  verticalPrimary: boolean,
): Direction | undefined {
  const members = sourceFanMembers(request, requestsBySource);
  if (members.length === 0) {
    return undefined;
  }
  const source = layoutManager.getEntityById(request.from);
  if (!source) {
    return undefined;
  }
  const sourceCenter = entityCenter(source);
  const deltas: Array<{ dx: number; dy: number }> = [];
  for (const member of members) {
    const target = layoutManager.getEntityById(member.to);
    if (!target) {
      continue;
    }
    const targetCenter = entityCenter(target);
    deltas.push({ dx: targetCenter.x - sourceCenter.x, dy: targetCenter.y - sourceCenter.y });
  }
  if (deltas.length < 2) {
    return undefined;
  }
  const dx = deltas.reduce((sum, d) => sum + d.dx, 0) / deltas.length;
  const dy = deltas.reduce((sum, d) => sum + d.dy, 0) / deltas.length;
  const face = dominantDirectionFace(dx, dy, verticalPrimary);
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

function unpinnedRule(
  request: FaceSelectionRequest,
  requestsBySource: Map<string, FaceSelectionRequest[]>,
  layoutManager: LayoutManager,
  verticalPrimary: boolean,
): FaceRuleResult {
  const from = layoutManager.getEntityById(request.from);
  const to = layoutManager.getEntityById(request.to);
  if (!from || !to) {
    return {
      faces: { from: 'right', to: 'left' },
      reason: 'aspect',
    };
  }

  const xOverlap = spansOverlap(travelSpanOf('x', from), travelSpanOf('x', to));
  const yOverlap = spansOverlap(travelSpanOf('y', from), travelSpanOf('y', to));
  const strictAxisFaces =
    xOverlap && !yOverlap ? verticalFaces(from, to) : horizontalFaces(from, to);
  const aspect = aspectFaces(from, to, verticalPrimary);
  const familyFace =
    !xOverlap && !yOverlap
      ? familyFaceForRequest(request, requestsBySource, layoutManager, verticalPrimary)
      : undefined;
  const familyFaces = familyFace
    ? { from: familyFace, to: OPPOSITE_DIRECTION[familyFace] }
    : undefined;
  if (xOverlap !== yOverlap) {
    return { faces: strictAxisFaces, reason: 'strict-axis' };
  }
  if (familyFaces) {
    return { faces: familyFaces, reason: 'family' };
  }
  return { faces: aspect, reason: 'aspect' };
}

function applySiblingFaceConsensus(
  assignments: readonly AssignedRouteFaces[],
  requests: readonly FaceSelectionRequest[],
  layoutManager: LayoutManager,
  verticalPrimary: boolean,
): AssignedRouteFaces[] {
  const establishedSiblingKeys = new Set<string>();
  assignments.forEach((assignment, requestIndex) => {
    const request = requests[requestIndex];
    const from = layoutManager.getEntityById(request.from);
    const to = layoutManager.getEntityById(request.to);
    if (!from || !to) {
      return;
    }
    if (assignment.reasons.from !== 'aspect') {
      establishedSiblingKeys.add(siblingKey(request.from, assignment.from, to, assignment.to));
    }
    if (assignment.reasons.to !== 'aspect') {
      establishedSiblingKeys.add(siblingKey(request.to, assignment.to, from, assignment.from));
    }
  });

  return assignments.map((assignment, requestIndex) => {
    if (assignment.reasons.from !== 'aspect' || assignment.reasons.to !== 'aspect') {
      return assignment;
    }
    const request = requests[requestIndex];
    const from = layoutManager.getEntityById(request.from);
    const to = layoutManager.getEntityById(request.to);
    if (!from || !to || request.from === request.to) {
      return assignment;
    }
    if ((from.containerId ?? null) === (to.containerId ?? null)) {
      return assignment;
    }
    const fromCenter = entityCenter(from);
    const toCenter = entityCenter(to);
    const fromFace = dominantDirectionFace(
      toCenter.x - fromCenter.x,
      toCenter.y - fromCenter.y,
      verticalPrimary,
    );
    const toFace = OPPOSITE_DIRECTION[fromFace];
    const supportedAtEitherEnd =
      establishedSiblingKeys.has(siblingKey(request.from, fromFace, to, toFace)) ||
      establishedSiblingKeys.has(siblingKey(request.to, toFace, from, fromFace));
    if (!supportedAtEitherEnd) {
      return assignment;
    }
    if (assignment.from === fromFace && assignment.to === toFace) {
      return assignment;
    }
    return {
      ...assignment,
      from: fromFace,
      to: toFace,
      reasons: { from: 'sibling', to: 'sibling' },
    };
  });
}

function siblingKey(
  sharedEntityId: string,
  sharedFace: Direction,
  oppositeEntity: LayoutEntity,
  oppositeFace: Direction,
): string {
  return `${sharedEntityId}:${sharedFace}:${facePlane(oppositeEntity, oppositeFace)}`;
}

export function assignFaces(
  layoutManager: LayoutManager,
  requests: readonly FaceSelectionRequest[],
  connections: readonly FaceSelectionConnection[],
): AssignedRouteFaces[] {
  const { minX, maxX, minY, maxY } = layoutManager.getDims();
  const verticalPrimary = maxY - minY > maxX - minX;
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const assignments: AssignedRouteFaces[] = [];
  const requestsBySource = new Map<string, FaceSelectionRequest[]>();
  for (const request of requests) {
    const list = requestsBySource.get(request.from);
    if (list) {
      list.push(request);
    } else {
      requestsBySource.set(request.from, [request]);
    }
  }

  for (const request of requests) {
    const connection = connectionsById.get(request.connId);
    const pinned = { from: request.faces?.from, to: request.faces?.to };
    const authored = { from: connection?.authoredFromFace, to: connection?.authoredToFace };
    const rule = unpinnedRule(request, requestsBySource, layoutManager, verticalPrimary);
    const from = pinned.from ?? authored.from ?? rule.faces.from;
    const to = pinned.to ?? authored.to ?? rule.faces.to;
    const reasons: AssignedRouteFaces['reasons'] = {
      from: pinned.from || authored.from ? 'authored' : rule.reason,
      to: pinned.to || authored.to ? 'authored' : rule.reason,
    };
    const assignment: AssignedRouteFaces = {
      connId: request.connId,
      from,
      to,
      reasons,
    };
    assignments.push(assignment);
  }

  return applySiblingFaceConsensus(assignments, requests, layoutManager, verticalPrimary);
}
