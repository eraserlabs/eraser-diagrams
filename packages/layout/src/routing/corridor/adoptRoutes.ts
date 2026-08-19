/**
 * Convert a live orthogonal polyline into corridor visits. Diagonal or unhosted
 * geometry is rejected. Tracks are pinned by default so realization preserves the path.
 */

import { coordinateInSpan, intersectSpans } from '../../rangeUtils.js';
import type { Axis, AxisSpan } from '../../types.js';
import type {
  PortalRef,
  RouteEndpoint,
  RouteSearchRequest,
  TerminalAttachment,
} from './contract.js';
import {
  corridorCrossSpan,
  corridorTravelSpan,
  crossSpanOf,
  terminalFacePlane,
} from './geometry.js';
import { Route, type VisitBoundary, type CorridorVisit } from './route.js';
import type { CorridorWorld } from './world.js';

type XY = readonly [number, number];

/** Routed geometry may sit exactly on corridor boundaries. */
const TOLERANCE_PX = 0.75;
const AXIS_EPSILON = 1e-6;

/** One maximal orthogonal run of the polyline. */
interface OrthogonalSegment {
  /** Travel axis: 'x' for horizontal runs, 'y' for vertical runs. */
  readonly axis: Axis;
  /** Constant cross-axis coordinate the run occupies. */
  readonly track: number;
  travelStart: number;
  travelEnd: number;
}

/** Split a polyline into orthogonal segments; undefined on diagonals. */
function toOrthogonalSegments(points: readonly XY[]): OrthogonalSegment[] | undefined {
  if (points.length < 2) {
    return undefined;
  }
  const segments: OrthogonalSegment[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const [fromX, fromY] = points[index];
    const [toX, toY] = points[index + 1];
    const dx = toX - fromX;
    const dy = toY - fromY;
    if (Math.abs(dx) > AXIS_EPSILON && Math.abs(dy) > AXIS_EPSILON) {
      return undefined;
    }
    if (Math.abs(dx) <= AXIS_EPSILON && Math.abs(dy) <= AXIS_EPSILON) {
      continue;
    }
    const axis: Axis = Math.abs(dx) > AXIS_EPSILON ? 'x' : 'y';
    const track = axis === 'x' ? fromY : fromX;
    const travelEnd = axis === 'x' ? toX : toY;
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.axis === axis) {
      previous.travelEnd = travelEnd;
      continue;
    }
    segments.push({
      axis,
      track,
      travelStart: axis === 'x' ? fromX : fromY,
      travelEnd,
    });
  }
  return segments.length === 0 ? undefined : segments;
}

/** Attachment of `endpoint` whose corridor hosts the terminal segment. */
function terminalAttachmentFor(
  world: CorridorWorld,
  endpoint: RouteEndpoint,
  axis: Axis,
  coordinateAtFace: number,
  track: number,
): TerminalAttachment | undefined {
  for (const attachmentIndex of world.indexer.attachmentsForEndpoint(endpoint)) {
    const attachment = world.indexer.attachments[attachmentIndex];
    const corridor = world.indexer.corridors[attachment.corridorIndex];
    if (
      corridor.axis === axis &&
      coordinateInSpan(track, corridorCrossSpan(corridor), TOLERANCE_PX) &&
      coordinateInSpan(coordinateAtFace, corridorTravelSpan(corridor), TOLERANCE_PX) &&
      coordinateInSpan(track, attachment.faceSpan, TOLERANCE_PX)
    ) {
      return attachment;
    }
  }
  return undefined;
}

function rectContains(
  rect: { x: number; y: number; width: number; height: number },
  point: XY,
): boolean {
  return (
    point[0] >= rect.x - TOLERANCE_PX &&
    point[0] <= rect.x + rect.width + TOLERANCE_PX &&
    point[1] >= rect.y - TOLERANCE_PX &&
    point[1] <= rect.y + rect.height + TOLERANCE_PX
  );
}

/** Continue portal leaving `corridorIndex` toward `target` at `track`. */
function nextContinuePortal(
  world: CorridorWorld,
  corridorIndex: number,
  axis: Axis,
  track: number,
  target: number,
  forward: boolean,
): PortalRef | undefined {
  let fallback: PortalRef | undefined;
  for (const portal of world.indexer.portalsFrom(corridorIndex)) {
    if (portal.kind !== 'continue' || portal.axis !== axis) {
      continue;
    }
    const onExitSide = forward
      ? portal.negativeCorridorIndex === corridorIndex
      : portal.positiveCorridorIndex === corridorIndex;
    if (!onExitSide || !coordinateInSpan(track, portal.crossSpan, TOLERANCE_PX)) {
      continue;
    }
    const other = world.indexer.otherCorridorIndex(portal, corridorIndex);
    if (
      coordinateInSpan(target, corridorTravelSpan(world.indexer.corridors[other]), TOLERANCE_PX)
    ) {
      return portal;
    }
    fallback = fallback ?? portal;
  }
  return fallback;
}

/** Turn portal at `corner` from `corridorIndex` into the next segment's host. */
function turnPortalAt(
  world: CorridorWorld,
  corridorIndex: number,
  corner: XY,
  nextTrack: number,
  nextTarget: number,
): { portal: PortalRef; otherCorridorIndex: number } | undefined {
  let fallback: { portal: PortalRef; otherCorridorIndex: number } | undefined;
  for (const portal of world.indexer.portalsFrom(corridorIndex)) {
    if (portal.kind !== 'turn' || !rectContains(portal.rect, corner)) {
      continue;
    }
    const other = world.indexer.otherCorridorIndex(portal, corridorIndex);
    const otherCorridor = world.indexer.corridors[other];
    if (!coordinateInSpan(nextTrack, corridorCrossSpan(otherCorridor), TOLERANCE_PX)) {
      continue;
    }
    if (coordinateInSpan(nextTarget, corridorTravelSpan(otherCorridor), TOLERANCE_PX)) {
      return { portal, otherCorridorIndex: other };
    }
    fallback = fallback ?? { portal, otherCorridorIndex: other };
  }
  return fallback;
}

interface WalkVisit {
  readonly corridorIndex: number;
  readonly entry: VisitBoundary;
  exit?: VisitBoundary;
  /** Cross-axis coordinate the adopted geometry occupies in this corridor. */
  readonly track: number;
}

/**
 * Adopt one polyline as a corridor topology in `world`, or `undefined` when
 * the geometry cannot be hosted (diagonal, cuts an entity, off-corridor).
 */
export function adoptRoute(
  world: CorridorWorld,
  request: RouteSearchRequest,
  points: readonly XY[],
  options: { readonly pinTracks?: boolean } = {},
): Route | undefined {
  const segments = toOrthogonalSegments(points);
  if (segments === undefined) {
    return undefined;
  }
  // Only geometry outside the terminal entities participates in the corridor world.
  segments[0].travelStart = terminalFacePlane(
    world.entities[request.from.entityIndex],
    request.from.face,
  );
  segments[segments.length - 1].travelEnd = terminalFacePlane(
    world.entities[request.to.entityIndex],
    request.to.face,
  );

  const first = segments[0];
  const sourceAttachment = terminalAttachmentFor(
    world,
    request.from,
    first.axis,
    first.travelStart,
    first.track,
  );
  if (sourceAttachment === undefined) {
    return undefined;
  }

  const visits: WalkVisit[] = [
    {
      corridorIndex: sourceAttachment.corridorIndex,
      entry: { kind: 'terminal', attachmentIndex: sourceAttachment.index },
      track: first.track,
    },
  ];
  const current = (): WalkVisit => visits[visits.length - 1];

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (segmentIndex > 0) {
      // Perpendicular corner: previous segment's end is the turn point.
      const previous = segments[segmentIndex - 1];
      const corner: XY =
        previous.axis === 'x'
          ? [previous.travelEnd, previous.track]
          : [previous.track, previous.travelEnd];
      const turn = turnPortalAt(
        world,
        current().corridorIndex,
        corner,
        segment.track,
        segment.travelEnd,
      );
      if (turn === undefined) {
        return undefined;
      }
      current().exit = { kind: 'portal', portalIndex: turn.portal.index, mode: 'turn' };
      visits.push({
        corridorIndex: turn.otherCorridorIndex,
        entry: { kind: 'portal', portalIndex: turn.portal.index, mode: 'turn' },
        track: segment.track,
      });
    }
    // Cross same-axis corridor boundaries until the segment end is hosted.
    const forward = segment.travelEnd >= segment.travelStart;
    let guard = world.indexer.corridors.length + 1;
    while (
      !coordinateInSpan(
        segment.travelEnd,
        corridorTravelSpan(world.indexer.corridors[current().corridorIndex]),
        TOLERANCE_PX,
      )
    ) {
      guard -= 1;
      if (guard <= 0) {
        return undefined;
      }
      const portal = nextContinuePortal(
        world,
        current().corridorIndex,
        segment.axis,
        segment.track,
        segment.travelEnd,
        forward,
      );
      if (portal === undefined) {
        return undefined;
      }
      current().exit = { kind: 'portal', portalIndex: portal.index, mode: 'continue-straight' };
      visits.push({
        corridorIndex: world.indexer.otherCorridorIndex(portal, current().corridorIndex),
        entry: { kind: 'portal', portalIndex: portal.index, mode: 'continue-straight' },
        track: segment.track,
      });
    }
  }

  const last = segments[segments.length - 1];
  const targetAttachment = terminalAttachmentFor(
    world,
    request.to,
    last.axis,
    last.travelEnd,
    last.track,
  );
  if (
    targetAttachment === undefined ||
    targetAttachment.corridorIndex !== current().corridorIndex
  ) {
    return undefined;
  }
  current().exit = { kind: 'terminal', attachmentIndex: targetAttachment.index };

  const corridorVisits: CorridorVisit[] = [];
  for (const visit of visits) {
    const exit = visit.exit;
    if (exit === undefined) {
      return undefined;
    }
    let feasibleTrack = boundaryConstrainedSpan(world, visit.corridorIndex, visit.entry, exit);
    if (feasibleTrack === undefined) {
      return undefined;
    }
    if (options.pinTracks !== false) {
      // Clamp tolerance-level boundary drift before pinning the adopted track.
      const pinnedTrack = Math.min(Math.max(visit.track, feasibleTrack[0]), feasibleTrack[1]);
      feasibleTrack = [pinnedTrack, pinnedTrack];
    }
    corridorVisits.push({
      corridorIndex: visit.corridorIndex,
      entry: visit.entry,
      exit,
      feasibleTrack,
    });
  }
  return new Route(request.requestIndex, request.from, request.to, corridorVisits);
}

/** Corridor cross span narrowed by both boundary cross-constraints. */
function boundaryConstrainedSpan(
  world: CorridorWorld,
  corridorIndex: number,
  entry: VisitBoundary,
  exit: VisitBoundary,
): AxisSpan | undefined {
  let span = corridorCrossSpan(world.indexer.corridors[corridorIndex]);
  for (const boundary of [entry, exit]) {
    const constraint = boundaryCrossSpan(world, corridorIndex, boundary);
    const intersection = intersectSpans(span, constraint, TOLERANCE_PX);
    if (intersection === undefined) {
      return undefined;
    }
    span = intersection;
  }
  return span;
}

/** Cross-axis span a boundary allows on the given corridor's cross axis. */
function boundaryCrossSpan(
  world: CorridorWorld,
  corridorIndex: number,
  boundary: VisitBoundary,
): AxisSpan {
  const corridor = world.indexer.corridors[corridorIndex];
  if (boundary.kind === 'terminal') {
    return world.indexer.attachments[boundary.attachmentIndex].faceSpan;
  }
  const portal = world.indexer.portals[boundary.portalIndex];
  if (portal.kind === 'continue') {
    return portal.crossSpan;
  }
  // Turn portal: the rect's span on this corridor's cross axis.
  return crossSpanOf(corridor.axis, portal.rect);
}
