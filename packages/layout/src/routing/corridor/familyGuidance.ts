import { coordinateInSpan, midpoint, spansOverlapPositive } from '../../rangeUtils.js';
import type { Axis, AxisSpan, PositionProps } from '../../types.js';
import type { EndpointSide } from '../types.js';
import { isPointAttachment, isPointEndpoint } from './contract.js';
import type { EntityRouteEndpoint, RouteSearchRequest } from './contract.js';
import {
  axisPoint,
  faceCrossSpan,
  faceNormalAxis,
  manhattan,
  terminalFacePlane,
  travelSpanOf,
} from './geometry.js';
import type { Route } from './route.js';
import { searchRoute, type RouteSearchResult } from './topology.js';
import type { CorridorWorld } from './world.js';

export interface FamilyGuidanceOptions {
  readonly penalty: number;
  readonly localRadius: number;
}

export interface FamilyGuidanceTrace {
  readonly requestIndex: number;
  readonly leaderRequestIndexes: readonly number[];
  readonly seedSurcharge: number;
  readonly candidateSurcharge: number;
  readonly accepted: boolean;
  readonly searched: boolean;
  readonly expansions: number;
}

interface SeedTurn {
  incomingAxis: Axis;
  rect: PositionProps;
}

interface Member {
  seed: RouteSearchResult;
  request: RouteSearchRequest;
  seedSlot: number;
  turns: SeedTurn[];
  excess: number;
  tieKey: string;
  side: EndpointSide;
  endpoint: EntityRouteEndpoint;
}

/** Search cost beyond direct attachment-center distance favors the least detoured seed. */
function baseExcess(world: CorridorWorld, seed: RouteSearchResult): number {
  if (!seed.cost) {
    return Infinity;
  }
  const visits = seed.route.visits;
  const endpoints = [visits[0].entry, visits[visits.length - 1].exit].map((boundary) => {
    if (boundary.kind !== 'terminal') {
      throw new Error('Family guidance requires terminal route boundaries.');
    }
    const attachment = world.indexer.attachments[boundary.attachmentIndex];
    return isPointAttachment(attachment)
      ? attachment
      : axisPoint(
          faceNormalAxis(attachment.face),
          terminalFacePlane(world.entities[attachment.entityIndex], attachment.face),
          midpoint(attachment.faceSpan),
        );
  });
  return seed.cost.total - manhattan(endpoints[0], endpoints[1]);
}

function seedTurns(world: CorridorWorld, route: Route): SeedTurn[] {
  return route.visits.flatMap((before, index) => {
    if (before.exit.kind !== 'portal' || before.exit.mode !== 'turn') {
      return [];
    }
    const after = route.visits[index + 1];
    const incomingAxis = world.indexer.corridors[before.corridorIndex].axis;
    const x = incomingAxis === 'y' ? before.feasibleTrack : after.feasibleTrack;
    const y = incomingAxis === 'x' ? before.feasibleTrack : after.feasibleTrack;
    return [{ incomingAxis, rect: { x: x[0], y: y[0], width: x[1] - x[0], height: y[1] - y[0] } }];
  });
}

function outgoingAxis(axis: Axis, side: EndpointSide): Axis {
  return side === 'from' ? axis : axis === 'x' ? 'y' : 'x';
}

/** Distance from the finite shared face, rather than its infinite plane. */
function isLocal(
  world: CorridorWorld,
  rect: PositionProps,
  endpoint: EntityRouteEndpoint,
  radius: number,
): boolean {
  const entity = world.entities[endpoint.entityIndex];
  const axis = faceNormalAxis(endpoint.face);
  const plane = terminalFacePlane(entity, endpoint.face);
  const normal = travelSpanOf(axis, rect);
  const cross = travelSpanOf(axis === 'x' ? 'y' : 'x', rect);
  const face = faceCrossSpan(entity, endpoint.face);
  const normalGap = Math.max(0, normal[0] - plane, plane - normal[1]);
  const crossGap = Math.max(0, cross[0] - face[1], face[0] - cross[1]);
  return normalGap * normalGap + crossGap * crossGap <= radius * radius;
}

function sameBand(a: AxisSpan, b: AxisSpan): boolean {
  // A pinned leader can guide any portal containing its track; two unpinned
  // ranges merely touching at an edge still do not offer a shared turn band.
  return a[0] === a[1]
    ? coordinateInSpan(a[0], b, 0)
    : b[0] === b[1]
      ? coordinateInSpan(b[0], a, 0)
      : spansOverlapPositive(a, b, 0);
}

function turnSurcharge(
  world: CorridorWorld,
  route: Route,
  penalties: ReadonlyMap<number, number>,
): number {
  return route.visits.reduce((sum, visit) => {
    if (visit.exit.kind !== 'portal' || visit.exit.mode !== 'turn') {
      return sum;
    }
    return (
      sum +
      (penalties.get(
        2 * visit.exit.portalIndex +
          Number(world.indexer.corridors[visit.corridorIndex].axis === 'y'),
      ) ?? 0)
    );
  }, 0);
}

/**
 * Freeze ordinary seed routes, choose one bent leader per same-entity/face fan, then
 * surcharge nonconforming local turn choices. Followers never become new leaders.
 * Straight routes have no priced turn; adopted routes guide peers but never re-search.
 */
export function guideFamilyRoutes(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  seeds: readonly RouteSearchResult[],
  adoptedRouteIndexes: ReadonlySet<number>,
  options: FamilyGuidanceOptions,
): { searchResults: RouteSearchResult[]; traces: FamilyGuidanceTrace[] } {
  const searchResults = [...seeds];
  const traces: FamilyGuidanceTrace[] = [];
  if (options.penalty === 0) {
    return { searchResults, traces };
  }
  const buckets = new Map<string, Member[]>();
  for (const [seedSlot, seed] of seeds.entries()) {
    const request = requests[seedSlot];
    const connection = {
      request,
      seed,
      seedSlot,
      turns: seedTurns(world, seed.route),
      excess: baseExcess(world, seed),
      tieKey: [request.from, request.to]
        .map((endpoint) =>
          JSON.stringify(
            isPointEndpoint(endpoint)
              ? endpoint
              : { ...endpoint, entityIndex: world.entities[endpoint.entityIndex].id },
          ),
        )
        .sort()
        .join('|'),
    };
    for (const side of ['from', 'to'] as const) {
      const endpoint = request[side];
      if (isPointEndpoint(endpoint)) {
        continue;
      }
      const key = `${endpoint.entityIndex}:${endpoint.face}`;
      const members = buckets.get(key) ?? [];
      if (!members.some((member) => member.seedSlot === seedSlot)) {
        members.push({ ...connection, side, endpoint });
      }
      buckets.set(key, members);
    }
  }
  const followers = new Map<
    number,
    { member: Member; penalties: Map<number, number>; leaders: number[] }
  >();
  for (const members of buckets.values()) {
    if (members.length < 2) {
      continue;
    }
    const bent = members.filter((member) => !member.seed.fallback && member.turns.length > 0);
    const counts = new Map<number, number>();
    for (const member of bent) {
      counts.set(member.turns.length, (counts.get(member.turns.length) ?? 0) + 1);
    }
    const modal = [...counts].sort(([a, ac], [b, bc]) => bc - ac || a - b)[0]?.[0];
    if (modal === undefined) {
      continue;
    }
    const leader = bent
      .filter((member) => member.turns.length === modal)
      .sort(
        (a, b) =>
          Number(adoptedRouteIndexes.has(b.request.requestIndex)) -
            Number(adoptedRouteIndexes.has(a.request.requestIndex)) ||
          a.excess - b.excess ||
          a.tieKey.localeCompare(b.tieKey),
      )[0];
    const bands = leader.turns.filter((turn) =>
      isLocal(world, turn.rect, leader.endpoint, options.localRadius),
    );
    for (const member of members) {
      if (member === leader || bands.length === 0) {
        continue;
      }
      const follower = followers.get(member.seedSlot) ?? {
        member,
        penalties: new Map<number, number>(),
        leaders: [],
      };
      follower.leaders.push(leader.request.requestIndex);
      for (const portal of world.indexer.portals) {
        if (
          portal.kind !== 'turn' ||
          !isLocal(world, portal.rect, member.endpoint, options.localRadius)
        ) {
          continue;
        }
        for (const incomingAxis of ['x', 'y'] as const) {
          const references = bands.filter(
            (band) =>
              outgoingAxis(band.incomingAxis, leader.side) ===
              outgoingAxis(incomingAxis, member.side),
          );
          const normalBand = travelSpanOf(faceNormalAxis(member.endpoint.face), portal.rect);
          if (
            references.length > 0 &&
            !references.some((band) =>
              sameBand(travelSpanOf(faceNormalAxis(leader.endpoint.face), band.rect), normalBand),
            )
          ) {
            // Membership at both endpoints must not double-charge a turn.
            follower.penalties.set(
              2 * portal.index + Number(incomingAxis === 'y'),
              options.penalty,
            );
          }
        }
      }
      followers.set(member.seedSlot, follower);
    }
  }
  for (const { member, penalties, leaders } of followers.values()) {
    const { seed, seedSlot, request } = member;
    const seedSurcharge = turnSurcharge(world, seed.route, penalties);
    const searched =
      !adoptedRouteIndexes.has(request.requestIndex) &&
      !seed.fallback &&
      seed.cost !== undefined &&
      seedSurcharge > 0;
    const candidate = searched
      ? searchRoute(world, request, { turnPortalPenalties: penalties })
      : undefined;
    const accepted =
      candidate?.cost !== undefined &&
      !candidate.fallback &&
      candidate.cost.total < seed.cost!.total + seedSurcharge - 1e-6;
    if (accepted) {
      searchResults[seedSlot] = candidate!;
    }
    traces.push({
      requestIndex: request.requestIndex,
      leaderRequestIndexes: leaders,
      seedSurcharge,
      candidateSurcharge: candidate?.cost?.turnPortalPenalty ?? 0,
      accepted,
      searched,
      expansions: candidate?.metrics.expansions ?? 0,
    });
  }
  return { searchResults, traces };
}
